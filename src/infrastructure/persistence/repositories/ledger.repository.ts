import { EntityManager } from '@mikro-orm/postgresql';
import {
  LedgerReconciliationSnapshot,
  LedgerRepository,
} from '../../../application/ports/unit-of-work';
import { Money } from '../../../domain/money';
import { WalletLedgerEntry } from '../../../domain/wallet-ledger-entry';
import { WalletLedgerEntryEntity } from '../entities';
import { ledgerEntryMapper } from '../mappers';

/**
 * Lançamento e conta de contrapartida numa única instrução (roda dentro da
 * seção crítica do lock da wallet). A conta nasce no primeiro lançamento que
 * a usa: `DO NOTHING` torna a criação idempotente e segura entre instâncias
 * (a conta é imutável), e a FK do lançamento é verificada no fim da
 * instrução, já vendo a conta inserida pela CTE.
 */
const INSERT_LEDGER_ENTRY = `
  with counter_account as (
    insert into ledger_account (id,
                                type,
                                currency,
                                provider_id,
                                created_at)
    values (?, ?, ?, ?, ?)
    on conflict (id) do nothing
  )
  insert into wallet_ledger_entry (id,
                                   wallet_id,
                                   transaction_id,
                                   direction,
                                   counter_account_id,
                                   amount,
                                   balance_before,
                                   balance_after,
                                   wallet_version,
                                   created_at)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Servida pelo índice único `(wallet_id, wallet_version)`. */
const SELECT_LEDGER_PAGE = `
  select id,
         wallet_id,
         transaction_id,
         direction,
         counter_account_id,
         amount,
         balance_before,
         balance_after,
         wallet_version,
         created_at
    from wallet_ledger_entry
   where wallet_id = ?
     and (?::int is null
          or wallet_version < ?::int)
   order by wallet_version desc
   limit ?
`;

/**
 * Uma instrução só, para que o saldo armazenado e os totais do ledger venham
 * do mesmo snapshot, mesmo com a wallet sendo movimentada em paralelo.
 * Créditos e débitos vêm separados (ambos não negativos), e o saldo calculado
 * é feito com `Money`, sem aritmética de ponto flutuante.
 */
const SELECT_RECONCILIATION_SNAPSHOT = `
  select w.currency,
         w.balance::text as stored_balance,
         coalesce(sum(l.amount) filter (where l.direction = 'CREDIT'), 0)::numeric(20,2)::text as total_credits,
         coalesce(sum(l.amount) filter (where l.direction = 'DEBIT'), 0)::numeric(20,2)::text as total_debits,
         count(l.id)::int as entries
    from wallet w
    left join wallet_ledger_entry l on l.wallet_id = w.id
   where w.id = ?
   group by w.id,
            w.currency,
            w.balance
`;

/**
 * Append-only: não existe (nem pode existir, por trigger) update ou delete.
 * Cada lançamento é uma transferência de partidas dobradas (wallet ×
 * contrapartida), balanceada por construção.
 */
export class SqlLedgerRepository implements LedgerRepository {
  constructor(private readonly em: EntityManager) {}

  async append(entry: WalletLedgerEntry): Promise<void> {
    const r = ledgerEntryMapper.toRecord(entry);
    const account = entry.counterAccount;
    await this.em.execute(INSERT_LEDGER_ENTRY, [
      account.id,
      account.type,
      account.currency,
      account.providerId ?? null,
      r.createdAt,
      r.id,
      r.walletId,
      r.transactionId,
      r.direction,
      r.counterAccountId,
      r.amount,
      r.balanceBefore,
      r.balanceAfter,
      r.walletVersion,
      r.createdAt,
    ]);
  }

  async findPage(
    walletId: string,
    walletCurrency: string,
    beforeVersion: number | undefined,
    limit: number,
  ): Promise<WalletLedgerEntry[]> {
    const before = beforeVersion ?? null;
    const rows = await this.em.execute(SELECT_LEDGER_PAGE, [
      walletId,
      before,
      before,
      limit,
    ]);
    return rows.map((row) =>
      ledgerEntryMapper.toDomain(
        this.em.map(WalletLedgerEntryEntity, row),
        walletCurrency,
      ),
    );
  }

  async reconciliationSnapshot(
    walletId: string,
  ): Promise<LedgerReconciliationSnapshot | undefined> {
    const [row] = await this.em.execute<
      {
        currency: string;
        stored_balance: string;
        total_credits: string;
        total_debits: string;
        entries: number;
      }[]
    >(SELECT_RECONCILIATION_SNAPSHOT, [walletId]);
    if (!row) {
      return undefined;
    }
    const money = (amount: string) =>
      Money.from({ amount, currency: row.currency });
    return {
      storedBalance: money(row.stored_balance),
      totalCredits: money(row.total_credits),
      totalDebits: money(row.total_debits),
      entries: row.entries,
    };
  }
}

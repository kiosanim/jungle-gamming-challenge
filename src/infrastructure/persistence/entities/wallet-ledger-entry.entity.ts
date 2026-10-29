import {
  Check,
  Entity,
  Enum,
  ManyToOne,
  PrimaryKey,
  Property,
  Trigger,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { LedgerDirection } from '../../../domain/wallet-ledger-entry';
import { moneyColumn, timestampColumn } from './column-types';
import { LedgerAccountEntity } from './ledger-account.entity';
import { WagerTransactionEntity } from './wager-transaction.entity';
import { WalletEntity } from './wallet.entity';

/**
 * Registro persistido do `WalletLedgerEntry`. A moeda não é guardada, porque é
 * sempre a da wallet; assim, um lançamento em moeda divergente não tem como
 * existir.
 *
 * Cada linha também é a transferência de partidas dobradas: `amount` entra na
 * conta da wallet com `direction` e na `counter_account_id` com a direção
 * oposta, balanceada por construção.
 *
 * No schema, triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` (o ledger é
 * append-only), a contrapartida é obrigatória (`NOT NULL` + FK para
 * `ledger_account`), cada transação gera no máximo um lançamento por wallet e
 * checks garantem `balance_before ± amount = balance_after` e saldos não
 * negativos.
 */
@Entity({ tableName: 'wallet_ledger_entry' })
@Unique({
  name: 'wallet_ledger_entry_transaction_wallet_uq',
  properties: ['transactionId', 'walletId'],
})
/** Sequência sem lacunas por wallet; também serve o cursor de paginação. */
@Unique({
  name: 'wallet_ledger_entry_wallet_version_uq',
  properties: ['walletId', 'walletVersion'],
})
@Check({
  name: 'wallet_ledger_entry_wallet_version_ck',
  expression: 'wallet_version >= 1',
})
@Check({
  name: 'wallet_ledger_entry_amount_positive_ck',
  expression: 'amount > 0',
})
@Check({
  name: 'wallet_ledger_entry_balances_non_negative_ck',
  expression: 'balance_before >= 0 and balance_after >= 0',
})
@Check({
  name: 'wallet_ledger_entry_balanced_ck',
  expression:
    "(direction = 'CREDIT' and balance_after = balance_before + amount) or " +
    "(direction = 'DEBIT' and balance_after = balance_before - amount)",
})
@Trigger({
  name: 'append_only_trg',
  timing: 'before',
  events: ['update', 'delete'],
  forEach: 'row',
  body: `
    raise exception 'wallet_ledger_entry é append-only: % proibido', tg_op
      using errcode = 'restrict_violation';
  `,
})
// O bloqueio de TRUNCATE fica na migration inicial: a introspecção do
// MikroORM não enxerga triggers de TRUNCATE e o recriaria a cada diff.
export class WalletLedgerEntryEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @ManyToOne(() => WalletEntity, {
    mapToPk: true,
    fieldName: 'wallet_id',
    deleteRule: 'restrict',
  })
  walletId!: string;

  @ManyToOne(() => WagerTransactionEntity, {
    mapToPk: true,
    fieldName: 'transaction_id',
    deleteRule: 'restrict',
  })
  transactionId!: string;

  /** Direção na conta da wallet; a contrapartida recebe a oposta. */
  @Enum({ items: () => LedgerDirection })
  direction!: LedgerDirection;

  @ManyToOne(() => LedgerAccountEntity, {
    mapToPk: true,
    fieldName: 'counter_account_id',
    deleteRule: 'restrict',
  })
  counterAccountId!: string;

  @Property(moneyColumn())
  amount!: string;

  @Property(moneyColumn())
  balanceBefore!: string;

  @Property(moneyColumn())
  balanceAfter!: string;

  /** `version` da wallet produzida por este lançamento. */
  @Property({ type: 'integer' })
  walletVersion!: number;

  @Property(timestampColumn())
  createdAt!: Date;
}

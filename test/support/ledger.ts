import { expect } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { sql } from './database';

/**
 * Invariante final de todos os testes: `wallet.balance == saldo reconstruído
 * pelo ledger`, com cada lançamento tendo a contrapartida (partida dobrada) na
 * moeda da wallet. O cálculo é feito em `numeric`, no próprio PostgreSQL, sem
 * ponto flutuante.
 */
export async function expectLedgerConsistent(
  orm: MikroORM,
  walletId: string,
): Promise<void> {
  const [row] = await sql(
    orm,
    `select w.balance::text as stored,
            coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(20,2)::text as calculated
       from wallet w
       left join wallet_ledger_entry l on l.wallet_id = w.id
      where w.id = ?
      group by w.balance`,
    [walletId],
  );
  expect(row).toBeDefined();
  expect(row.calculated).toBe(row.stored);

  const [counter] = await sql(
    orm,
    `select count(*)::int as invalid
       from wallet_ledger_entry l
       join wallet w on w.id = l.wallet_id
       join ledger_account a on a.id = l.counter_account_id
      where l.wallet_id = ?
        and a.currency <> w.currency`,
    [walletId],
  );
  expect(counter.invalid).toBe(0);
}

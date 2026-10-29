import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { WalletAlreadyExistsError } from '../../src/application/errors';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import {
  TransactionalContext,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import { Money } from '../../src/domain/money';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../../src/infrastructure/system-clock';
import { UuidV7Generator } from '../../src/infrastructure/uuid-v7-generator';
import { initTestOrm, sql } from '../support/database';
import { expectLedgerConsistent } from '../support/ledger';

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  orm = await initTestOrm();
  uow = new MikroOrmUnitOfWork(orm);
});

afterAll(async () => {
  await orm?.close(true);
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const useCase = (unitOfWork: UnitOfWork = uow) =>
  new OpenWalletUseCase(unitOfWork, new UuidV7Generator(), new SystemClock());
const open = (playerId: string, amount: string, unitOfWork?: UnitOfWork) =>
  useCase(unitOfWork).execute({
    playerId,
    initialBalance: brl(amount),
    correlationId: 'corr-test',
  });

/** Conta as linhas gravadas para um player em cada tabela envolvida. */
async function persistedFor(playerId: string) {
  const [counts] = await sql(
    orm,
    `select
       (select count(*) from wallet where player_id = ?)::int as wallets,
       (select count(*) from wager_transaction where player_id = ?)::int as transactions,
       (select count(*) from wallet_ledger_entry l join wallet w on w.id = l.wallet_id
         where w.player_id = ?)::int as ledger,
       (select count(*) from outbox_message o join wallet w on w.id::text = o.aggregate_id
         where w.player_id = ?)::int as outbox`,
    [playerId, playerId, playerId, playerId],
  );
  return counts;
}

describe('OpenWalletUseCase (PostgreSQL real)', () => {
  it('saldo inicial positivo grava wallet, OPENING, CREDIT e evento na mesma transação', async () => {
    const playerId = `player-${randomUUID()}`;
    const wallet = await open(playerId, '1000.00');

    expect(wallet.version).toBe(1);
    expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
    expect(await persistedFor(playerId)).toEqual({
      wallets: 1,
      transactions: 1,
      ledger: 1,
      outbox: 1,
    });

    const [tx] = await sql(
      orm,
      `select kind, status, amount::text, provider_id, external_transaction_id
         from wager_transaction where wallet_id = ?`,
      [wallet.id],
    );
    expect(tx).toEqual({
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '1000.00',
      provider_id: 'internal',
      external_transaction_id: `opening:${wallet.id}`,
    });

    const [entry] = await sql(
      orm,
      `select direction, amount::text, balance_before::text, balance_after::text
         from wallet_ledger_entry where wallet_id = ?`,
      [wallet.id],
    );
    expect(entry).toEqual({
      direction: 'CREDIT',
      amount: '1000.00',
      balance_before: '0.00',
      balance_after: '1000.00',
    });

    const [event] = await sql(
      orm,
      `select event_type, payload from outbox_message where aggregate_id = ?`,
      [wallet.id],
    );
    expect(event.event_type).toBe('WalletBalanceChanged');
    expect(event.payload.correlationId).toBe('corr-test');
    expect(event.payload.data.balanceAfter).toEqual({
      amount: '1000.00',
      currency: 'BRL',
    });

    await expectLedgerConsistent(orm, wallet.id);
  });

  it('saldo inicial zero grava só a wallet', async () => {
    const playerId = `player-${randomUUID()}`;
    const wallet = await open(playerId, '0.00');

    expect(await persistedFor(playerId)).toEqual({
      wallets: 1,
      transactions: 0,
      ledger: 0,
      outbox: 0,
    });
    await expectLedgerConsistent(orm, wallet.id);
  });

  it('duplicata playerId + moeda → WalletAlreadyExistsError, sem efeitos colaterais', async () => {
    const playerId = `player-${randomUUID()}`;
    await open(playerId, '50.00');

    await expect(open(playerId, '70.00')).rejects.toBeInstanceOf(
      WalletAlreadyExistsError,
    );
    expect(await persistedFor(playerId)).toEqual({
      wallets: 1,
      transactions: 1,
      ledger: 1,
      outbox: 1,
    });
  });

  it('mesma player com outra moeda é permitida', async () => {
    const playerId = `player-${randomUUID()}`;
    await open(playerId, '10.00');
    await useCase().execute({
      playerId,
      initialBalance: Money.from({ amount: '10.00', currency: 'USD' }),
      correlationId: 'corr-test',
    });
    expect((await persistedFor(playerId)).wallets).toBe(2);
  });

  it('atomicidade: falha antes do commit desfaz wallet, transação, ledger e outbox', async () => {
    const playerId = `player-${randomUUID()}`;
    const failingBeforeCommit: UnitOfWork = {
      run: <T>(work: (ctx: TransactionalContext) => Promise<T>) =>
        uow.run(async (ctx) => {
          await work(ctx);
          throw new Error('crash simulado antes do commit');
        }),
    };

    await expect(open(playerId, '100.00', failingBeforeCommit)).rejects.toThrow(
      'crash simulado antes do commit',
    );
    expect(await persistedFor(playerId)).toEqual({
      wallets: 0,
      transactions: 0,
      ledger: 0,
      outbox: 0,
    });
  });

  it('concorrência: 20 aberturas simultâneas do mesmo player → exatamente uma wallet', async () => {
    const playerId = `player-${randomUUID()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => open(playerId, '100.00')),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(19);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(WalletAlreadyExistsError);
    }

    expect(await persistedFor(playerId)).toEqual({
      wallets: 1,
      transactions: 1,
      ledger: 1,
      outbox: 1,
    });
    const [{ id }] = await sql(
      orm,
      'select id from wallet where player_id = ?',
      [playerId],
    );
    await expectLedgerConsistent(orm, id);
  });
});

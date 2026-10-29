import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import {
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../src/application/errors';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import {
  SubmitWagerTransactionCommand,
  SubmitWagerTransactionUseCase,
} from '../../src/application/submit-wager-transaction.use-case';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../../src/infrastructure/system-clock';
import { UuidV7Generator } from '../../src/infrastructure/uuid-v7-generator';
import { initTestOrm, sql } from '../support/database';
import { expectLedgerConsistent } from '../support/ledger';

let orm: MikroORM;
let submit: SubmitWagerTransactionUseCase;
let openWallet: OpenWalletUseCase;

beforeAll(async () => {
  orm = await initTestOrm();
  const uow = new MikroOrmUnitOfWork(orm);
  submit = new SubmitWagerTransactionUseCase(
    uow,
    new UuidV7Generator(),
    new SystemClock(),
  );
  openWallet = new OpenWalletUseCase(
    uow,
    new UuidV7Generator(),
    new SystemClock(),
  );
});

afterAll(async () => {
  await orm?.close(true);
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

async function newWallet(amount: string, currency = 'BRL') {
  const playerId = `player-${randomUUID()}`;
  const wallet = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount, currency }),
    correlationId: 'corr-test',
  });
  return { walletId: wallet.id, playerId };
}

function command(
  wallet: { walletId: string; playerId: string },
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const externalTransactionId =
    overrides.externalTransactionId ?? `tx-${randomUUID()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: Kind.Bet,
    money: brl('25.00'),
    correlationId: 'corr-test',
    ...overrides,
  };
}

async function walletBalance(walletId: string): Promise<string> {
  const [row] = await sql(
    orm,
    'select balance::text as balance from wallet where id = ?',
    [walletId],
  );
  return row.balance;
}

async function ledgerFor(walletId: string) {
  return sql(
    orm,
    `select direction, amount::text, balance_before::text, balance_after::text, transaction_id
       from wallet_ledger_entry where wallet_id = ? order by created_at, id`,
    [walletId],
  );
}

async function outboxTypesFor(walletId: string): Promise<string[]> {
  const rows = await sql(
    orm,
    'select event_type from outbox_message where aggregate_id = ? order by occurred_at, event_type',
    [walletId],
  );
  return rows.map((r: { event_type: string }) => r.event_type);
}

/** Lançamento da transação como transferência: wallet × contrapartida. */
async function transferOf(transactionId: string) {
  const [row] = await sql(
    orm,
    `select direction as wallet_direction,
            counter_account_id,
            case direction when 'DEBIT' then 'CREDIT' else 'DEBIT' end as counter_direction,
            amount::text
       from wallet_ledger_entry
      where transaction_id = ?`,
    [transactionId],
  );
  return row;
}

/** Saldo de uma conta de sistema: soma dos lançamentos em que é contrapartida. */
async function counterAccountBalance(accountId: string): Promise<string> {
  const [row] = await sql(
    orm,
    `select coalesce(sum(case direction when 'DEBIT' then amount else -amount end), 0)::numeric(20,2)::text as balance
       from wallet_ledger_entry
      where counter_account_id = ?`,
    [accountId],
  );
  return row.balance;
}

describe('SubmitWagerTransactionUseCase (PostgreSQL real)', () => {
  describe('partidas dobradas (cada lançamento é uma transferência)', () => {
    it('abertura: crédito na wallet, débito na conta de aporte', async () => {
      const wallet = await newWallet('100.00');
      const [opening] = await sql(
        orm,
        "select id from wager_transaction where wallet_id = ? and kind = 'OPENING'",
        [wallet.walletId],
      );
      expect(await transferOf(opening.id)).toEqual({
        wallet_direction: 'CREDIT',
        counter_account_id: 'funding:BRL',
        counter_direction: 'DEBIT',
        amount: '100.00',
      });
    });

    it('BET, WIN, ROLLBACK e REFUND: contrapartida na conta do provedor', async () => {
      const wallet = await newWallet('100.00');
      const provider = 'provider:provider-a:BRL';
      const before = await counterAccountBalance(provider);

      const bet = await submit.execute(
        command(wallet, { money: brl('30.00') }),
      );
      expect(await transferOf(bet.transaction.id)).toMatchObject({
        wallet_direction: 'DEBIT',
        counter_account_id: provider,
        counter_direction: 'CREDIT',
      });

      const win = await submit.execute(
        command(wallet, {
          kind: Kind.Win,
          money: brl('50.00'),
          referenceExternalTransactionId: bet.transaction.externalTransactionId,
        }),
      );
      expect(await transferOf(win.transaction.id)).toMatchObject({
        wallet_direction: 'CREDIT',
        counter_account_id: provider,
        counter_direction: 'DEBIT',
      });

      // ROLLBACK do WIN: inverte o crédito
      const rollback = await submit.execute(
        command(wallet, {
          kind: Kind.Rollback,
          money: brl('50.00'),
          referenceExternalTransactionId: win.transaction.externalTransactionId,
        }),
      );
      expect(await transferOf(rollback.transaction.id)).toMatchObject({
        wallet_direction: 'DEBIT',
        counter_account_id: provider,
        counter_direction: 'CREDIT',
      });

      const refund = await submit.execute(
        command(wallet, {
          kind: Kind.Refund,
          money: brl('30.00'),
          referenceExternalTransactionId: bet.transaction.externalTransactionId,
        }),
      );
      expect(await transferOf(refund.transaction.id)).toMatchObject({
        wallet_direction: 'CREDIT',
        counter_account_id: provider,
        counter_direction: 'DEBIT',
      });

      // tudo revertido: wallet e provedor voltam ao ponto de partida
      expect(await walletBalance(wallet.walletId)).toBe('100.00');
      expect(await counterAccountBalance(provider)).toBe(before);
      await expectLedgerConsistent(orm, wallet.walletId);
    });

    it('LOSS e rejeições não geram lançamento', async () => {
      const wallet = await newWallet('10.00');
      const loss = await submit.execute(
        command(wallet, { kind: Kind.Loss, money: brl('0.00') }),
      );
      const rejected = await submit.execute(
        command(wallet, { money: brl('20.00') }),
      );
      expect(rejected.transaction.status).toBe(Status.Rejected);
      expect(await transferOf(loss.transaction.id)).toBeUndefined();
      expect(await transferOf(rejected.transaction.id)).toBeUndefined();
    });

    it('balancete: Σ wallets (materializado) + Σ contas de sistema = 0', async () => {
      const [row] = await sql(
        orm,
        `select (select coalesce(sum(balance), 0) from wallet)
              + (select coalesce(sum(case direction when 'DEBIT' then amount else -amount end), 0)
                   from wallet_ledger_entry) as wallets_vs_system`,
      );
      // Saldo das contas de sistema (convenção credora: crédito soma) =
      // Σ(débito − crédito) dos lançamentos, pois recebem a direção oposta à
      // da wallet. Somado ao saldo **materializado** das wallets, fecha em 0.
      expect(Number(row.wallets_vs_system)).toBe(0);
    });
  });

  describe('regras de negócio', () => {
    it('BET debita, gera 1 DEBIT e eventos Processed + BalanceChanged', async () => {
      const wallet = await newWallet('100.00');
      const { transaction, idempotentReplay } = await submit.execute(
        command(wallet, { money: brl('30.00') }),
      );

      expect(idempotentReplay).toBe(false);
      expect(transaction.status).toBe(Status.Processed);
      expect(transaction.balanceAfter?.equals(brl('70.00'))).toBe(true);
      expect(await walletBalance(wallet.walletId)).toBe('70.00');

      const ledger = await ledgerFor(wallet.walletId);
      expect(ledger.at(-1)).toMatchObject({
        direction: 'DEBIT',
        amount: '30.00',
        balance_before: '100.00',
        balance_after: '70.00',
        transaction_id: transaction.id,
      });
      expect(await outboxTypesFor(wallet.walletId)).toEqual([
        'WalletBalanceChanged', // abertura
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);
      await expectLedgerConsistent(orm, wallet.walletId);
    });

    it('WIN credita e gera 1 CREDIT', async () => {
      const wallet = await newWallet('10.00');
      const { transaction } = await submit.execute(
        command(wallet, { kind: Kind.Win, money: brl('90.00') }),
      );
      expect(transaction.status).toBe(Status.Processed);
      expect(await walletBalance(wallet.walletId)).toBe('100.00');
      expect((await ledgerFor(wallet.walletId)).at(-1)?.direction).toBe(
        'CREDIT',
      );
      await expectLedgerConsistent(orm, wallet.walletId);
    });

    it('LOSS é processada sem mover saldo, sem ledger e sem WalletBalanceChanged', async () => {
      const wallet = await newWallet('10.00');
      const { transaction } = await submit.execute(
        command(wallet, { kind: Kind.Loss, money: brl('0.00') }),
      );

      expect(transaction.status).toBe(Status.Processed);
      expect(transaction.balanceAfter?.equals(brl('10.00'))).toBe(true);
      expect(await ledgerFor(wallet.walletId)).toHaveLength(1); // só a abertura
      expect(await outboxTypesFor(wallet.walletId)).toEqual([
        'WalletBalanceChanged',
        'WagerTransactionProcessed',
      ]);

      const [{ version }] = await sql(
        orm,
        'select version from wallet where id = ?',
        [wallet.walletId],
      );
      expect(version).toBe(1);
    });

    it('BET sem saldo → REJECTED INSUFFICIENT_FUNDS, saldo intacto, sem ledger', async () => {
      const wallet = await newWallet('10.00');
      const { transaction } = await submit.execute(
        command(wallet, { money: brl('10.01') }),
      );

      expect(transaction.status).toBe(Status.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(transaction.balanceAfter?.equals(brl('10.00'))).toBe(true);
      expect(await walletBalance(wallet.walletId)).toBe('10.00');
      expect(await ledgerFor(wallet.walletId)).toHaveLength(1);
      expect(await outboxTypesFor(wallet.walletId)).toEqual([
        'WalletBalanceChanged',
        'WagerTransactionRejected',
      ]);
    });

    it('wallet de outro player → REJECTED WALLET_PLAYER_MISMATCH', async () => {
      const wallet = await newWallet('100.00');
      const { transaction } = await submit.execute(
        command({ ...wallet, playerId: 'intruso' }),
      );
      expect(transaction.status).toBe(Status.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.WalletPlayerMismatch);
      expect(await walletBalance(wallet.walletId)).toBe('100.00');
    });

    it('moeda diferente da wallet → REJECTED CURRENCY_MISMATCH', async () => {
      const wallet = await newWallet('100.00');
      const { transaction } = await submit.execute(
        command(wallet, {
          money: Money.from({ amount: '5.00', currency: 'USD' }),
        }),
      );
      expect(transaction.status).toBe(Status.Rejected);
      expect(transaction.failureCode).toBe(FailureCode.CurrencyMismatch);
      // saldo observado na moeda da wallet
      expect(transaction.balanceAfter?.equals(brl('100.00'))).toBe(true);
    });

    it('wallet inexistente → WalletNotFoundError, nada persistido', async () => {
      const cmd = command({ walletId: randomUUID(), playerId: 'p' });
      await expect(submit.execute(cmd)).rejects.toBeInstanceOf(
        WalletNotFoundError,
      );
      const rows = await sql(
        orm,
        'select 1 from wager_transaction where external_transaction_id = ?',
        [cmd.externalTransactionId],
      );
      expect(rows).toHaveLength(0);
    });
  });

  describe('idempotência', () => {
    it('replay devolve o resultado original, inclusive o saldo da época', async () => {
      const wallet = await newWallet('100.00');
      const bet = command(wallet, { money: brl('40.00') });
      const original = await submit.execute(bet);

      // o saldo muda depois do processamento original
      await submit.execute(command(wallet, { money: brl('10.00') }));
      expect(await walletBalance(wallet.walletId)).toBe('50.00');

      const replay = await submit.execute(bet);
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction.id).toBe(original.transaction.id);
      expect(replay.transaction.status).toBe(Status.Processed);
      expect(replay.transaction.balanceAfter?.equals(brl('60.00'))).toBe(true);

      expect(await ledgerFor(wallet.walletId)).toHaveLength(3);
      await expectLedgerConsistent(orm, wallet.walletId);
    });

    it('replay de rejeição devolve a rejeição original', async () => {
      const wallet = await newWallet('5.00');
      const bet = command(wallet, { money: brl('10.00') });
      const original = await submit.execute(bet);

      // mesmo que agora houvesse saldo, o replay não reprocessa
      await submit.execute(
        command(wallet, { kind: Kind.Win, money: brl('100.00') }),
      );
      const replay = await submit.execute(bet);

      expect(replay.idempotentReplay).toBe(true);
      expect(replay.transaction.id).toBe(original.transaction.id);
      expect(replay.transaction.status).toBe(Status.Rejected);
      expect(replay.transaction.failureCode).toBe(
        FailureCode.InsufficientFunds,
      );
      expect(replay.transaction.balanceAfter?.equals(brl('5.00'))).toBe(true);
    });

    it('mesma Idempotency-Key com payload diferente → IdempotencyConflictError', async () => {
      const wallet = await newWallet('100.00');
      const bet = command(wallet, { money: brl('10.00') });
      await submit.execute(bet);

      await expect(
        submit.execute({ ...bet, money: brl('10.01') }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(await walletBalance(wallet.walletId)).toBe('90.00');
    });

    it('mesmo externalTransactionId com outra Idempotency-Key → conflito', async () => {
      const wallet = await newWallet('100.00');
      const bet = command(wallet, { money: brl('10.00') });
      await submit.execute(bet);

      await expect(
        submit.execute({ ...bet, idempotencyKey: 'outra-chave' }),
      ).rejects.toBeInstanceOf(IdempotencyConflictError);
      expect(await walletBalance(wallet.walletId)).toBe('90.00');
    });

    it('campos de transporte diferentes não quebram o replay', async () => {
      const wallet = await newWallet('100.00');
      const bet = command(wallet);
      await submit.execute(bet);
      const replay = await submit.execute({
        ...bet,
        correlationId: 'outro-correlation-id',
        money: brl('25'), // mesmo valor, outra representação
      });
      expect(replay.idempotentReplay).toBe(true);
    });
  });

  describe('concorrência (paralelismo real no PostgreSQL)', () => {
    it('cenário obrigatório: saldo 100.00, duas apostas simultâneas de 80.00', async () => {
      // repetido para reduzir a chance de passar por sorte de escalonamento
      for (let round = 0; round < 10; round++) {
        const wallet = await newWallet('100.00');
        const results = await Promise.all([
          submit.execute(command(wallet, { money: brl('80.00') })),
          submit.execute(command(wallet, { money: brl('80.00') })),
        ]);

        const statuses = results.map((r) => r.transaction.status).sort();
        expect(statuses).toEqual([Status.Processed, Status.Rejected]);
        const rejected = results.find(
          (r) => r.transaction.status === Status.Rejected,
        )!;
        expect(rejected.transaction.failureCode).toBe(
          FailureCode.InsufficientFunds,
        );

        expect(await walletBalance(wallet.walletId)).toBe('20.00');
        const debits = (await ledgerFor(wallet.walletId)).filter(
          (e: { direction: string }) => e.direction === 'DEBIT',
        );
        expect(debits).toHaveLength(1);
        await expectLedgerConsistent(orm, wallet.walletId);
      }
    });

    it('a mesma aposta enviada 50 vezes em paralelo → um único débito', async () => {
      const wallet = await newWallet('100.00');
      const bet = command(wallet, { money: brl('10.00') });

      const results = await Promise.all(
        Array.from({ length: 50 }, () => submit.execute(bet)),
      );

      const ids = new Set(results.map((r) => r.transaction.id));
      expect(ids.size).toBe(1);
      expect(results.filter((r) => !r.idempotentReplay)).toHaveLength(1);
      expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);
      for (const r of results) {
        expect(r.transaction.balanceAfter?.equals(brl('90.00'))).toBe(true);
      }

      expect(await walletBalance(wallet.walletId)).toBe('90.00');
      expect(
        (await ledgerFor(wallet.walletId)).filter(
          (e: { direction: string }) => e.direction === 'DEBIT',
        ),
      ).toHaveLength(1);
      await expectLedgerConsistent(orm, wallet.walletId);
    });

    it('hot wallet: 40 apostas distintas de 5.00 com saldo para 20 → exatamente 20 débitos', async () => {
      const wallet = await newWallet('100.00');
      const results = await Promise.all(
        Array.from({ length: 40 }, () =>
          submit.execute(command(wallet, { money: brl('5.00') })),
        ),
      );

      const processed = results.filter(
        (r) => r.transaction.status === Status.Processed,
      );
      const rejected = results.filter(
        (r) => r.transaction.status === Status.Rejected,
      );
      expect(processed).toHaveLength(20);
      expect(rejected).toHaveLength(20);
      expect(await walletBalance(wallet.walletId)).toBe('0.00');

      // cada débito parte do saldo deixado pelo anterior: sem lost update
      const balancesAfter = processed
        .map((r) => r.transaction.balanceAfter!.toJSON().amount)
        .sort((a, b) => Number(b) - Number(a));
      expect(balancesAfter).toEqual(
        Array.from({ length: 20 }, (_, i) => `${95 - i * 5}.00`),
      );
      await expectLedgerConsistent(orm, wallet.walletId);
    });

    it('wallets distintas processadas em paralelo mantêm cada uma seu saldo', async () => {
      const wallets = await Promise.all(
        Array.from({ length: 10 }, () => newWallet('50.00')),
      );
      await Promise.all(
        wallets.flatMap((wallet) => [
          submit.execute(command(wallet, { money: brl('10.00') })),
          submit.execute(command(wallet, { money: brl('15.00') })),
          submit.execute(
            command(wallet, { kind: Kind.Win, money: brl('7.50') }),
          ),
        ]),
      );

      for (const wallet of wallets) {
        expect(await walletBalance(wallet.walletId)).toBe('32.50');
        await expectLedgerConsistent(orm, wallet.walletId);
      }
    });
  });
});

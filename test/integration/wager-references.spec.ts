import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import { ResolvePendingReferencesUseCase } from '../../src/application/resolve-pending-references.use-case';
import {
  SubmitWagerTransactionCommand,
  SubmitWagerTransactionUseCase,
} from '../../src/application/submit-wager-transaction.use-case';
import { FailureCode } from '../../src/domain/failure-code';
import { Money } from '../../src/domain/money';
import {
  PENDING_REFERENCE_MAX_DELAY_MS,
  PENDING_REFERENCE_TTL_MS,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { UuidV7Generator } from '../../src/infrastructure/uuid-v7-generator';
import { FakeClock } from '../support/clock';
import { initTestOrm, sql } from '../support/database';
import { expectLedgerConsistent } from '../support/ledger';

let orm: MikroORM;
let clock: FakeClock;
let submit: SubmitWagerTransactionUseCase;
let resolver: ResolvePendingReferencesUseCase;
let openWallet: OpenWalletUseCase;

beforeAll(async () => {
  orm = await initTestOrm();
  clock = new FakeClock();
  const uow = new MikroOrmUnitOfWork(orm);
  const ids = new UuidV7Generator();
  submit = new SubmitWagerTransactionUseCase(uow, ids, clock);
  resolver = new ResolvePendingReferencesUseCase(uow, ids, clock);
  openWallet = new OpenWalletUseCase(uow, ids, clock);
});

afterAll(async () => {
  await orm?.close(true);
});

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

interface WalletRef {
  walletId: string;
  playerId: string;
}

async function newWallet(amount: string): Promise<WalletRef> {
  const playerId = `player-${randomUUID()}`;
  const wallet = await openWallet.execute({
    playerId,
    initialBalance: brl(amount),
    correlationId: 'corr-test',
  });
  return { walletId: wallet.id, playerId };
}

function op(
  wallet: WalletRef,
  kind: Kind,
  amount: string,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
): SubmitWagerTransactionCommand {
  const externalTransactionId =
    overrides.externalTransactionId ?? `${kind.toLowerCase()}-${randomUUID()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    correlationId: 'corr-test',
    ...overrides,
  };
}

const run = async (command: SubmitWagerTransactionCommand) =>
  (await submit.execute(command)).transaction;

/** Envia e devolve o externalTransactionId para ser referenciado. */
async function processed(
  wallet: WalletRef,
  kind: Kind,
  amount: string,
  overrides: Partial<SubmitWagerTransactionCommand> = {},
) {
  const command = op(wallet, kind, amount, overrides);
  const transaction = await run(command);
  expect(transaction.status).toBe(Status.Processed);
  return { command, transaction };
}

async function balance(walletId: string): Promise<string> {
  const [row] = await sql(
    orm,
    'select balance::text as balance from wallet where id = ?',
    [walletId],
  );
  return row.balance;
}

async function ledgerCount(walletId: string): Promise<number> {
  const [row] = await sql(
    orm,
    'select count(*)::int as n from wallet_ledger_entry where wallet_id = ?',
    [walletId],
  );
  return row.n;
}

async function eventsFor(transactionId: string): Promise<string[]> {
  const rows = await sql(
    orm,
    `select event_type from outbox_message
      where payload->'data'->>'transactionId' = ?
      order by occurred_at, event_type`,
    [transactionId],
  );
  return rows.map((r) => r.event_type);
}

/** Avança o relógio até depois do teto do backoff e roda o worker. */
async function runWorker() {
  clock.advance(PENDING_REFERENCE_MAX_DELAY_MS + 1);
  return resolver.runOnce();
}

describe('referências: REFUND e ROLLBACK', () => {
  it('REFUND de BET processada credita o mesmo valor e registra a referência', async () => {
    const wallet = await newWallet('100.00');
    const bet = await processed(wallet, Kind.Bet, '30.00');

    const refund = await run(
      op(wallet, Kind.Refund, '30.00', {
        referenceExternalTransactionId: bet.command.externalTransactionId,
      }),
    );

    expect(refund.status).toBe(Status.Processed);
    expect(refund.referenceTransactionId).toBe(bet.transaction.id);
    expect(refund.balanceAfter?.equals(brl('100.00'))).toBe(true);
    expect(await balance(wallet.walletId)).toBe('100.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('a mesma BET não é estornada duas vezes (nem por REFUND, nem por ROLLBACK)', async () => {
    const wallet = await newWallet('100.00');
    const bet = await processed(wallet, Kind.Bet, '30.00');
    const reference = {
      referenceExternalTransactionId: bet.command.externalTransactionId,
    };
    await processed(wallet, Kind.Refund, '30.00', reference);

    const secondRefund = await run(op(wallet, Kind.Refund, '30.00', reference));
    const rollback = await run(op(wallet, Kind.Rollback, '30.00', reference));

    for (const tx of [secondRefund, rollback]) {
      expect(tx.status).toBe(Status.Rejected);
      expect(tx.failureCode).toBe(FailureCode.ReferenceAlreadyReversed);
    }
    expect(await balance(wallet.walletId)).toBe('100.00');
    expect(await ledgerCount(wallet.walletId)).toBe(3); // abertura, BET, REFUND
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('REFUND concorrentes da mesma BET → exatamente um é aplicado', async () => {
    const wallet = await newWallet('100.00');
    const bet = await processed(wallet, Kind.Bet, '30.00');
    const reference = {
      referenceExternalTransactionId: bet.command.externalTransactionId,
    };

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        run(op(wallet, Kind.Refund, '30.00', reference)),
      ),
    );
    expect(results.filter((t) => t.status === Status.Processed)).toHaveLength(
      1,
    );
    expect(
      results.filter(
        (t) => t.failureCode === FailureCode.ReferenceAlreadyReversed,
      ),
    ).toHaveLength(9);
    expect(await balance(wallet.walletId)).toBe('100.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it.each([
    [
      'REFUND de WIN',
      Kind.Refund,
      Kind.Win,
      {},
      FailureCode.ReferenceKindNotAllowed,
    ],
    [
      'REFUND com valor diferente',
      Kind.Refund,
      Kind.Bet,
      { money: brl('29.99') },
      FailureCode.ReversalAmountMismatch,
    ],
    [
      'REFUND de outra rodada',
      Kind.Refund,
      Kind.Bet,
      { roundId: 'outra-rodada' },
      FailureCode.ReferenceMismatch,
    ],
    [
      'ROLLBACK de LOSS',
      Kind.Rollback,
      Kind.Loss,
      {},
      FailureCode.ReferenceKindNotAllowed,
    ],
  ])('%s → %s', async (_, kind, referenceKind, overrides, expected) => {
    const wallet = await newWallet('100.00');
    const reference = await processed(wallet, referenceKind, '30.00');
    const tx = await run(
      op(wallet, kind, '30.00', {
        referenceExternalTransactionId: reference.command.externalTransactionId,
        ...overrides,
      }),
    );
    expect(tx.status).toBe(Status.Rejected);
    expect(tx.failureCode).toBe(expected);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('REFUND de BET rejeitada → REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await newWallet('10.00');
    const bet = op(wallet, Kind.Bet, '50.00');
    expect((await run(bet)).status).toBe(Status.Rejected);

    const refund = await run(
      op(wallet, Kind.Refund, '50.00', {
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(refund.failureCode).toBe(FailureCode.ReferenceNotProcessed);
    expect(await balance(wallet.walletId)).toBe('10.00');
  });

  it('ROLLBACK de WIN debita; ROLLBACK de REFUND debita', async () => {
    const wallet = await newWallet('100.00');
    const win = await processed(wallet, Kind.Win, '50.00');
    const rollbackWin = await run(
      op(wallet, Kind.Rollback, '50.00', {
        referenceExternalTransactionId: win.command.externalTransactionId,
      }),
    );
    expect(rollbackWin.status).toBe(Status.Processed);
    expect(await balance(wallet.walletId)).toBe('100.00');

    const bet = await processed(wallet, Kind.Bet, '20.00');
    const refund = await processed(wallet, Kind.Refund, '20.00', {
      referenceExternalTransactionId: bet.command.externalTransactionId,
    });
    const rollbackRefund = await run(
      op(wallet, Kind.Rollback, '20.00', {
        referenceExternalTransactionId: refund.command.externalTransactionId,
      }),
    );
    expect(rollbackRefund.status).toBe(Status.Processed);
    expect(await balance(wallet.walletId)).toBe('80.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('reversão que deixaria saldo negativo → REVERSAL_INSUFFICIENT_FUNDS (código distinto)', async () => {
    const wallet = await newWallet('0.00');
    const win = await processed(wallet, Kind.Win, '50.00');
    await processed(wallet, Kind.Bet, '40.00'); // o prêmio já foi consumido

    const rollback = await run(
      op(wallet, Kind.Rollback, '50.00', {
        referenceExternalTransactionId: win.command.externalTransactionId,
      }),
    );
    expect(rollback.status).toBe(Status.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalInsufficientFunds);
    expect(rollback.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(await balance(wallet.walletId)).toBe('10.00');
    expect(await eventsFor(rollback.id)).toEqual(['WagerTransactionRejected']);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('WIN pode referenciar a BET da rodada', async () => {
    const wallet = await newWallet('100.00');
    const bet = await processed(wallet, Kind.Bet, '10.00');
    const win = await run(
      op(wallet, Kind.Win, '35.00', {
        referenceExternalTransactionId: bet.command.externalTransactionId,
      }),
    );
    expect(win.status).toBe(Status.Processed);
    expect(win.referenceTransactionId).toBe(bet.transaction.id);
    expect(await balance(wallet.walletId)).toBe('125.00');
  });
});

describe('referências fora de ordem (PENDING_REFERENCE)', () => {
  it('REFUND antes da BET fica pendente e é aplicado pelo worker quando a BET chega', async () => {
    const wallet = await newWallet('100.00');
    const betCommand = op(wallet, Kind.Bet, '30.00');

    const refund = await run(
      op(wallet, Kind.Refund, '30.00', {
        referenceExternalTransactionId: betCommand.externalTransactionId,
      }),
    );
    expect(refund.status).toBe(Status.PendingReference);
    expect(refund.balanceAfter).toBeUndefined();
    expect(await eventsFor(refund.id)).toEqual([
      'WagerTransactionPendingReference',
    ]);
    expect(await ledgerCount(wallet.walletId)).toBe(1);

    // replay enquanto pendente devolve o estado atual
    const replay = await submit.execute(
      op(wallet, Kind.Refund, '30.00', {
        externalTransactionId: refund.externalTransactionId,
        referenceExternalTransactionId: betCommand.externalTransactionId,
      }),
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transaction.status).toBe(Status.PendingReference);

    await run(betCommand);
    expect(await balance(wallet.walletId)).toBe('70.00');

    const report = await runWorker();
    expect(report.processed).toBeGreaterThanOrEqual(1);

    const [row] = await sql(
      orm,
      'select status, reference_transaction_id is not null as resolved from wager_transaction where id = ?',
      [refund.id],
    );
    expect(row).toEqual({ status: 'PROCESSED', resolved: true });
    expect(await balance(wallet.walletId)).toBe('100.00');
    expect(await eventsFor(refund.id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('sem a referência, o worker reagenda com backoff', async () => {
    const wallet = await newWallet('100.00');
    const refund = await run(
      op(wallet, Kind.Refund, '10.00', {
        referenceExternalTransactionId: `nunca-chega-${randomUUID()}`,
      }),
    );

    await runWorker();
    const [first] = await sql(
      orm,
      'select status, reference_attempts, next_reference_check_at from wager_transaction where id = ?',
      [refund.id],
    );
    expect(first.status).toBe('PENDING_REFERENCE');
    expect(first.reference_attempts).toBe(1);

    await runWorker();
    const [second] = await sql(
      orm,
      'select reference_attempts from wager_transaction where id = ?',
      [refund.id],
    );
    expect(second.reference_attempts).toBe(2);
  });

  it('esgotado o TTL → REJECTED REFERENCE_NOT_FOUND com evento', async () => {
    const wallet = await newWallet('100.00');
    const refund = await run(
      op(wallet, Kind.Refund, '10.00', {
        referenceExternalTransactionId: `nunca-chega-${randomUUID()}`,
      }),
    );

    clock.advance(PENDING_REFERENCE_TTL_MS);
    await resolver.runOnce();

    const [row] = await sql(
      orm,
      'select status, failure_code, balance_after::text from wager_transaction where id = ?',
      [refund.id],
    );
    expect(row).toEqual({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
      balance_after: '100.00',
    });
    expect(await eventsFor(refund.id)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await balance(wallet.walletId)).toBe('100.00');
  });

  it('cadeia fora de ordem: ROLLBACK do REFUND antes do REFUND, antes da BET', async () => {
    const wallet = await newWallet('100.00');
    const betCommand = op(wallet, Kind.Bet, '30.00');
    const refundCommand = op(wallet, Kind.Refund, '30.00', {
      referenceExternalTransactionId: betCommand.externalTransactionId,
    });
    const rollbackCommand = op(wallet, Kind.Rollback, '30.00', {
      referenceExternalTransactionId: refundCommand.externalTransactionId,
    });

    expect((await run(rollbackCommand)).status).toBe(Status.PendingReference);
    expect((await run(refundCommand)).status).toBe(Status.PendingReference);
    await run(betCommand);

    await runWorker(); // resolve o REFUND (o ROLLBACK ainda vê o REFUND pendente)
    await runWorker(); // resolve o ROLLBACK

    const rows = await sql(
      orm,
      `select kind, status from wager_transaction
        where wallet_id = ? and kind in ('REFUND', 'ROLLBACK') order by kind`,
      [wallet.walletId],
    );
    expect(rows).toEqual([
      { kind: 'REFUND', status: 'PROCESSED' },
      { kind: 'ROLLBACK', status: 'PROCESSED' },
    ]);
    // BET -30, REFUND +30, ROLLBACK do REFUND -30
    expect(await balance(wallet.walletId)).toBe('70.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('dois workers concorrentes sobre os mesmos pendentes → cada um aplicado uma vez', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 5 }, () => newWallet('100.00')),
    );
    const bets = wallets.map((wallet) => op(wallet, Kind.Bet, '25.00'));
    for (const [i, wallet] of wallets.entries()) {
      await run(
        op(wallet, Kind.Refund, '25.00', {
          referenceExternalTransactionId: bets[i].externalTransactionId,
        }),
      );
    }
    for (const bet of bets) {
      await run(bet);
    }

    clock.advance(PENDING_REFERENCE_MAX_DELAY_MS + 1);
    const reports = await Promise.all([
      resolver.runOnce(),
      resolver.runOnce(),
      resolver.runOnce(),
    ]);
    const processedTotal = reports.reduce((n, r) => n + r.processed, 0);
    expect(processedTotal).toBe(5);

    for (const wallet of wallets) {
      expect(await balance(wallet.walletId)).toBe('100.00');
      expect(await ledgerCount(wallet.walletId)).toBe(3);
      await expectLedgerConsistent(orm, wallet.walletId);
    }
  });
});

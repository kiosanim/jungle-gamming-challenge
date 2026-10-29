import { describe, expect, it } from 'bun:test';
import { LedgerAccount } from './ledger-account';
import { FailureCode } from './failure-code';
import {
  EventContext,
  InvalidIntegrationEventError,
} from './integration-event';
import { Money } from './money';
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
} from './wager-transaction';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from './wagering-events';
import { Wallet } from './wallet';
import { LedgerDirection } from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

const T0 = new Date('2026-01-01T00:00:00.000Z');
const T1 = new Date('2026-01-01T00:01:00.000Z');

const ctx: EventContext = {
  eventId: 'event-1',
  correlationId: 'corr-1',
  causationId: 'msg-1',
  occurredAt: T1,
};

const openWallet = (amount = '100.00') =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(amount),
    opening: { transactionId: 'tx-opening', entryId: 'entry-opening' },
    at: T0,
  }).wallet;

const transaction = (kind = Kind.Bet, reference?: string) =>
  WagerTransaction.create({
    id: `tx-${kind.toLowerCase()}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${kind.toLowerCase()}`,
    idempotencyKey: `provider-a:ext-${kind.toLowerCase()}`,
    payloadHash: 'hash',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl('80.00'),
    referenceExternalTransactionId: reference,
    createdAt: T0,
  });

describe('IntegrationEvent (envelope)', () => {
  it('toJSON gera o envelope com eventType e version vindos do tipo', () => {
    const tx = transaction();
    tx.reject(FailureCode.InsufficientFunds);
    const envelope = WagerTransactionRejected.from(tx, ctx).toJSON();

    expect(envelope).toMatchObject({
      eventId: 'event-1',
      eventType: 'WagerTransactionRejected',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: 'msg-1',
      occurredAt: '2026-01-01T00:01:00.000Z',
      version: 1,
    });
  });

  it('omite causationId quando ausente', () => {
    const tx = transaction();
    tx.reject(FailureCode.InsufficientFunds);
    const { causationId: _, ...withoutCausation } = ctx;
    const envelope = WagerTransactionRejected.from(
      tx,
      withoutCausation,
    ).toJSON();
    expect('causationId' in envelope).toBe(false);
  });

  it('o envelope é JSON estável: ida e volta sem perda', () => {
    const wallet = openWallet();
    const tx = transaction();
    const entry = wallet.debit({
      entryId: 'entry-1',
      transactionId: tx.id,
      money: tx.money,
      counterAccount: LedgerAccount.provider('provider-a', 'BRL'),
      at: T1,
    });
    const envelope = WalletBalanceChanged.from(wallet, entry, ctx).toJSON();
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });

  it('data é congelado', () => {
    const tx = transaction();
    tx.reject(FailureCode.InsufficientFunds);
    expect(Object.isFrozen(WagerTransactionRejected.from(tx, ctx).data)).toBe(
      true,
    );
  });

  it.each(['eventId', 'correlationId'] as const)('exige %s', (field) => {
    const tx = transaction();
    tx.reject(FailureCode.InsufficientFunds);
    expect(() =>
      WagerTransactionRejected.from(tx, { ...ctx, [field]: '' }),
    ).toThrow(InvalidIntegrationEventError);
  });
});

describe('WagerTransactionProcessed', () => {
  it('carrega os dados da transação e o saldo observado', () => {
    const wallet = openWallet();
    const tx = transaction();
    wallet.debit({
      entryId: 'entry-1',
      transactionId: tx.id,
      money: tx.money,
      counterAccount: LedgerAccount.provider('provider-a', 'BRL'),
      at: T1,
    });
    tx.markProcessed(undefined, T1, wallet.balance);

    const event = WagerTransactionProcessed.from(tx, wallet, ctx);
    expect(event.eventType).toBe('WagerTransactionProcessed');
    expect(event.data).toEqual({
      transactionId: 'tx-bet',
      providerId: 'provider-a',
      externalTransactionId: 'ext-bet',
      walletId: 'wallet-1',
      playerId: 'player-1',
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      kind: Kind.Bet,
      money: { amount: '80.00', currency: 'BRL' },
      balance: { amount: '20.00', currency: 'BRL' },
      processedAt: '2026-01-01T00:01:00.000Z',
    });
  });

  it('é emitido também para LOSS (saldo inalterado)', () => {
    const wallet = openWallet();
    const tx = transaction(Kind.Loss);
    tx.markProcessed(undefined, T1, brl('100.00'));
    const event = WagerTransactionProcessed.from(tx, wallet, ctx);
    expect(event.data.kind).toBe(Kind.Loss);
    expect(event.data.balance).toEqual({ amount: '100.00', currency: 'BRL' });
  });

  it('inclui referenceTransactionId quando houver referência', () => {
    const tx = transaction(Kind.Refund, 'ext-bet');
    tx.markProcessed('tx-bet', T1, brl('100.00'));
    const event = WagerTransactionProcessed.from(tx, openWallet(), ctx);
    expect(event.data.referenceTransactionId).toBe('tx-bet');
  });

  it('exige transação PROCESSED', () => {
    expect(() =>
      WagerTransactionProcessed.from(transaction(), openWallet(), ctx),
    ).toThrow(InvalidIntegrationEventError);
  });

  it('exige que a transação seja da wallet informada', () => {
    const tx = transaction();
    tx.markProcessed(undefined, T1, brl('100.00'));
    const other = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-1',
      initialBalance: Money.zero('BRL'),
      at: T0,
    }).wallet;
    expect(() => WagerTransactionProcessed.from(tx, other, ctx)).toThrow(
      InvalidIntegrationEventError,
    );
  });
});

describe('WagerTransactionRejected', () => {
  it('carrega o failureCode', () => {
    const tx = transaction();
    tx.reject(FailureCode.InsufficientFunds);
    const event = WagerTransactionRejected.from(tx, ctx);
    expect(event.eventType).toBe('WagerTransactionRejected');
    expect(event.data.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(event.data.money).toEqual({ amount: '80.00', currency: 'BRL' });
  });

  it('exige transação REJECTED', () => {
    expect(() => WagerTransactionRejected.from(transaction(), ctx)).toThrow(
      InvalidIntegrationEventError,
    );
  });
});

describe('WagerTransactionPendingReference', () => {
  it('carrega a referência externa aguardada', () => {
    const tx = transaction(Kind.Rollback, 'ext-bet');
    tx.markPendingReference(T0);
    const event = WagerTransactionPendingReference.from(tx, ctx);
    expect(event.eventType).toBe('WagerTransactionPendingReference');
    expect(event.data.referenceExternalTransactionId).toBe('ext-bet');
  });

  it('exige transação PENDING_REFERENCE', () => {
    expect(() =>
      WagerTransactionPendingReference.from(
        transaction(Kind.Rollback, 'ext-bet'),
        ctx,
      ),
    ).toThrow(InvalidIntegrationEventError);
  });
});

describe('WalletBalanceChanged', () => {
  it('reflete o lançamento e a version da wallet', () => {
    const wallet = openWallet();
    const entry = wallet.debit({
      entryId: 'entry-1',
      transactionId: 'tx-bet',
      money: brl('80.00'),
      counterAccount: LedgerAccount.provider('provider-a', 'BRL'),
      at: T1,
    });

    const event = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(event.eventType).toBe('WalletBalanceChanged');
    expect(event.aggregateId).toBe('wallet-1');
    expect(event.data).toEqual({
      walletId: 'wallet-1',
      transactionId: 'tx-bet',
      direction: LedgerDirection.Debit,
      money: { amount: '80.00', currency: 'BRL' },
      balanceBefore: { amount: '100.00', currency: 'BRL' },
      balanceAfter: { amount: '20.00', currency: 'BRL' },
      walletVersion: 2,
    });
  });

  it('data carrega MoneyProps, nunca instâncias de Money', () => {
    const wallet = openWallet();
    const entry = wallet.credit({
      entryId: 'entry-1',
      transactionId: 'tx-win',
      money: brl('5.00'),
      counterAccount: LedgerAccount.provider('provider-a', 'BRL'),
      at: T1,
    });
    const { data } = WalletBalanceChanged.from(wallet, entry, ctx);
    for (const value of [data.money, data.balanceBefore, data.balanceAfter]) {
      expect(value).not.toBeInstanceOf(Money);
    }
  });

  it('rejeita lançamento de outra wallet', () => {
    const { wallet: other, openingEntry } = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-1',
      initialBalance: brl('10.00'),
      opening: { transactionId: 'tx-o2', entryId: 'entry-o2' },
      at: T0,
    });
    expect(other.id).toBe('wallet-2');
    expect(() =>
      WalletBalanceChanged.from(openWallet(), openingEntry!, ctx),
    ).toThrow(InvalidIntegrationEventError);
  });
});

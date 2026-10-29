import { describe, expect, it } from 'bun:test';
import { LedgerAccount } from '../../domain/ledger-account';
import { FailureCode } from '../../domain/failure-code';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../../domain/wager-transaction';
import { WagerTransactionRejected } from '../../domain/wagering-events';
import { Wallet } from '../../domain/wallet';
import {
  ledgerEntryMapper,
  outboxMessageMapper,
  wagerTransactionMapper,
  walletMapper,
} from './mappers';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-01T00:01:00Z');

describe('mappers domínio ↔ registro', () => {
  it('Wallet: valores monetários viram string decimal e voltam iguais', () => {
    const { wallet } = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: brl('1000.5'),
      opening: { transactionId: 't-1', entryId: 'e-1' },
      at: T0,
    });
    wallet.debit({
      entryId: 'e-2',
      transactionId: 't-2',
      money: brl('0.50'),
      counterAccount: LedgerAccount.provider('provider-a', 'BRL'),
      at: T1,
    });

    const record = walletMapper.toRecord(wallet);
    expect(record.balance).toBe('1000.00');
    expect(record.version).toBe(2);

    const restored = walletMapper.toDomain(record);
    expect(restored.balance.equals(wallet.balance)).toBe(true);
    expect(restored.version).toBe(2);
    expect(restored.updatedAt).toEqual(T1);
  });

  it('WagerTransaction: ida e volta preserva status, referência e failureCode', () => {
    const tx = WagerTransaction.create({
      id: 't-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-refund',
      idempotencyKey: 'provider-a:ext-refund',
      payloadHash: 'hash',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: 'ext-bet',
      createdAt: T0,
    });
    tx.markPendingReference(T0);
    tx.reject(FailureCode.ReferenceNotFound);

    const record = wagerTransactionMapper.toRecord(tx);
    expect(record.amount).toBe('25.00');
    expect(record.currency).toBe('BRL');

    const restored = wagerTransactionMapper.toDomain(record, 'BRL');
    expect(restored.status).toBe(tx.status);
    expect(restored.failureCode).toBe(FailureCode.ReferenceNotFound);
    expect(restored.referenceExternalTransactionId).toBe('ext-bet');
    expect(restored.money.equals(tx.money)).toBe(true);
  });

  it('WagerTransaction: colunas nulas do banco viram undefined', () => {
    const record = wagerTransactionMapper.toRecord(
      WagerTransaction.opening({
        id: 't-1',
        walletId: 'w-1',
        playerId: 'p-1',
        money: brl('10.00'),
        at: T0,
      }),
    );
    Object.assign(record, {
      referenceExternalTransactionId: null,
      referenceTransactionId: null,
      failureCode: null,
    });
    const restored = wagerTransactionMapper.toDomain(record, 'BRL');
    expect(restored.referenceExternalTransactionId).toBeUndefined();
    expect(restored.referenceTransactionId).toBeUndefined();
    expect(restored.failureCode).toBeUndefined();
  });

  it('WalletLedgerEntry: a moeda vem da wallet na reidratação', () => {
    const { openingEntry } = Wallet.open({
      id: 'w-1',
      playerId: 'p-1',
      initialBalance: brl('10.00'),
      opening: { transactionId: 't-1', entryId: 'e-1' },
      at: T0,
    });
    const record = ledgerEntryMapper.toRecord(openingEntry!);
    expect(record).not.toHaveProperty('currency');

    const restored = ledgerEntryMapper.toDomain(record, 'BRL');
    expect(restored.isBalanced()).toBe(true);
    expect(restored.balanceAfter.equals(brl('10.00'))).toBe(true);
  });

  it('OutboxMessage: ida e volta preserva payload e agendamento', () => {
    const tx = WagerTransaction.create({
      id: 't-1',
      providerId: 'provider-a',
      externalTransactionId: 'ext-1',
      idempotencyKey: 'provider-a:ext-1',
      payloadHash: 'hash',
      walletId: 'w-1',
      playerId: 'p-1',
      roundId: 'r-1',
      gameId: 'g-1',
      kind: WagerTransactionKind.Bet,
      money: brl('80.00'),
      createdAt: T0,
    });
    tx.reject(FailureCode.InsufficientFunds);
    const message = OutboxMessage.enqueue(
      WagerTransactionRejected.from(tx, {
        eventId: 'ev-1',
        correlationId: 'c-1',
        occurredAt: T0,
      }),
    );
    message.scheduleRetry(T1);

    const restored = outboxMessageMapper.toDomain(
      outboxMessageMapper.toRecord(message),
    );
    expect(restored.payload).toEqual(message.payload);
    expect(restored.attempts).toBe(1);
    expect(restored.nextAttemptAt).toEqual(message.nextAttemptAt);
    expect(restored.isPending()).toBe(true);
  });
});

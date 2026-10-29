import { describe, expect, it } from 'bun:test';
import { FailureCode } from './failure-code';
import { Money } from './money';
import {
  OUTBOX_RETRY_BASE_DELAY_MS,
  OUTBOX_RETRY_MAX_DELAY_MS,
  OutboxMessage,
  OutboxMessageAlreadyPublishedError,
} from './outbox-message';
import { WagerTransaction, WagerTransactionKind } from './wager-transaction';
import { WagerTransactionRejected } from './wagering-events';

const T0 = new Date('2026-01-01T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const event = () => {
  const tx = WagerTransaction.create({
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'ext-1',
    idempotencyKey: 'provider-a:ext-1',
    payloadHash: 'hash',
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '80.00', currency: 'BRL' }),
    createdAt: T0,
  });
  tx.reject(FailureCode.InsufficientFunds);
  return WagerTransactionRejected.from(tx, {
    eventId: 'event-1',
    correlationId: 'corr-1',
    occurredAt: T0,
  });
};

describe('OutboxMessage', () => {
  describe('enqueue', () => {
    it('usa o eventId como id e grava o envelope serializado', () => {
      const source = event();
      const message = OutboxMessage.enqueue(source);

      expect(message.id).toBe('event-1');
      expect(message.aggregateId).toBe('wallet-1');
      expect(message.eventType).toBe('WagerTransactionRejected');
      expect(message.occurredAt).toEqual(T0);
      expect(message.payload).toEqual(
        source.toJSON() as unknown as Record<string, unknown>,
      );
      expect(Object.isFrozen(message.payload)).toBe(true);
    });

    it('nasce pendente, sem tentativas e devida imediatamente', () => {
      const message = OutboxMessage.enqueue(event());
      expect(message.isPending()).toBe(true);
      expect(message.attempts).toBe(0);
      expect(message.nextAttemptAt).toBeUndefined();
      expect(message.isDue(T0)).toBe(true);
    });
  });

  describe('markPublished', () => {
    it('deixa de estar pendente e devida', () => {
      const message = OutboxMessage.enqueue(event());
      message.markPublished(at(10));
      expect(message.isPending()).toBe(false);
      expect(message.isDue(at(10))).toBe(false);
      expect(message.publishedAt).toEqual(at(10));
    });

    it('não pode ser publicada duas vezes', () => {
      const message = OutboxMessage.enqueue(event());
      message.markPublished(at(10));
      expect(() => message.markPublished(at(20))).toThrow(
        OutboxMessageAlreadyPublishedError,
      );
      expect(message.publishedAt).toEqual(at(10));
    });
  });

  describe('scheduleRetry', () => {
    it('incrementa attempts e agenda com backoff exponencial', () => {
      const message = OutboxMessage.enqueue(event());
      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        message.scheduleRetry(T0);
        delays.push(message.nextAttemptAt!.getTime() - T0.getTime());
      }
      expect(message.attempts).toBe(5);
      expect(delays).toEqual(
        [1, 2, 4, 8, 16].map((n) => n * OUTBOX_RETRY_BASE_DELAY_MS),
      );
    });

    it('o atraso é limitado pelo teto e a outbox nunca desiste', () => {
      const message = OutboxMessage.enqueue(event());
      for (let i = 0; i < 50; i++) message.scheduleRetry(T0);
      expect(message.attempts).toBe(50);
      expect(message.isPending()).toBe(true);
      expect(message.nextAttemptAt).toEqual(at(OUTBOX_RETRY_MAX_DELAY_MS));
    });

    it('não está devida antes de nextAttemptAt e volta a estar depois', () => {
      const message = OutboxMessage.enqueue(event());
      message.scheduleRetry(T0);
      expect(message.isDue(at(OUTBOX_RETRY_BASE_DELAY_MS - 1))).toBe(false);
      expect(message.isDue(at(OUTBOX_RETRY_BASE_DELAY_MS))).toBe(true);
    });

    it('não agenda retentativa de mensagem já publicada', () => {
      const message = OutboxMessage.enqueue(event());
      message.markPublished(at(10));
      expect(() => message.scheduleRetry(at(10))).toThrow(
        OutboxMessageAlreadyPublishedError,
      );
    });
  });

  describe('rehydrate', () => {
    it('reconstrói o estado persistido', () => {
      const message = OutboxMessage.rehydrate({
        id: 'event-1',
        aggregateId: 'wallet-1',
        eventType: 'WagerTransactionRejected',
        payload: { eventId: 'event-1' },
        occurredAt: T0,
        attempts: 3,
        nextAttemptAt: at(4_000),
      });
      expect(message.attempts).toBe(3);
      expect(message.isDue(at(3_999))).toBe(false);
      expect(message.isDue(at(4_000))).toBe(true);

      message.scheduleRetry(at(4_000));
      expect(message.attempts).toBe(4);
      expect(message.nextAttemptAt).toEqual(
        at(4_000 + 8 * OUTBOX_RETRY_BASE_DELAY_MS),
      );
    });
  });
});

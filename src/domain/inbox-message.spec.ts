import { describe, expect, it } from 'bun:test';
import {
  InboxMessage,
  InboxMessageAlreadyProcessedError,
} from './inbox-message';

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-01T00:00:05Z');

const receive = () =>
  InboxMessage.receive({
    messageId: 'msg-123',
    consumerName: 'wager-transactions',
    payloadHash: 'hash',
    receivedAt: T0,
  });

describe('InboxMessage', () => {
  it('nasce recebida e ainda não processada', () => {
    const message = receive();
    expect(message.messageId).toBe('msg-123');
    expect(message.consumerName).toBe('wager-transactions');
    expect(message.receivedAt).toEqual(T0);
    expect(message.isProcessed()).toBe(false);
    expect(message.processedAt).toBeUndefined();
  });

  it('markProcessed registra o instante do processamento', () => {
    const message = receive();
    message.markProcessed(T1);
    expect(message.isProcessed()).toBe(true);
    expect(message.processedAt).toEqual(T1);
  });

  it('não pode ser processada duas vezes', () => {
    const message = receive();
    message.markProcessed(T1);
    expect(() => message.markProcessed(T1)).toThrow(
      InboxMessageAlreadyProcessedError,
    );
    expect(message.processedAt).toEqual(T1);
  });

  it('rehydrate reconstrói mensagem já processada', () => {
    const message = InboxMessage.rehydrate({
      messageId: 'msg-123',
      consumerName: 'wager-transactions',
      payloadHash: 'hash',
      receivedAt: T0,
      processedAt: T1,
    });
    expect(message.isProcessed()).toBe(true);
    expect(() => message.markProcessed(T1)).toThrow(
      InboxMessageAlreadyProcessedError,
    );
  });
});

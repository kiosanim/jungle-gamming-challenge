import { describe, expect, it } from 'bun:test';
import { Money } from '../domain/money';
import {
  canonicalJson,
  computePayloadHash,
  WagerPayloadFields,
} from './payload-hash';

const fields = (
  overrides: Partial<WagerPayloadFields> = {},
): WagerPayloadFields => ({
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
  ...overrides,
});

describe('canonicalJson', () => {
  it('ordena chaves recursivamente e não usa espaços', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: [2, 1] } })).toBe(
      '{"a":{"c":[2,1],"d":"x"},"b":1}',
    );
  });

  it('omite campos undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('a ordem de declaração das chaves não altera o resultado', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
});

describe('computePayloadHash', () => {
  it('é SHA-256 em hex (64 caracteres)', () => {
    expect(computePayloadHash(fields())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('é determinístico', () => {
    expect(computePayloadHash(fields())).toBe(computePayloadHash(fields()));
  });

  it('independe da ordem das chaves de entrada', () => {
    const reordered = Object.fromEntries(
      Object.entries(fields()).reverse(),
    ) as unknown as WagerPayloadFields;
    expect(computePayloadHash(reordered)).toBe(computePayloadHash(fields()));
  });

  it('valores equivalentes normalizados pelo Money produzem o mesmo hash', () => {
    const a = Money.from({ amount: '25', currency: 'BRL' }).toJSON();
    const b = Money.from({ amount: '25.00', currency: 'BRL' }).toJSON();
    expect(computePayloadHash(fields({ money: a }))).toBe(
      computePayloadHash(fields({ money: b })),
    );
  });

  it.each([
    ['providerId', { providerId: 'provider-b' }],
    ['externalTransactionId', { externalTransactionId: 'transaction-124' }],
    ['playerId', { playerId: 'player-2' }],
    ['walletId', { walletId: '0192f291-27dd-7d3f-8071-5f8685deef38' }],
    ['roundId', { roundId: 'round-988' }],
    ['gameId', { gameId: 'outro-jogo' }],
    ['kind', { kind: 'WIN' }],
    ['amount', { money: { amount: '25.01', currency: 'BRL' } }],
    ['currency', { money: { amount: '25.00', currency: 'USD' } }],
    ['referenceExternalTransactionId', { referenceExternalTransactionId: 'x' }],
  ])('mudar %s muda o hash (payload divergente)', (_, overrides) => {
    expect(computePayloadHash(fields(overrides))).not.toBe(
      computePayloadHash(fields()),
    );
  });

  it('ignora campos de transporte que não são de negócio', () => {
    const withTransport = {
      ...fields(),
      idempotencyKey: 'outra-chave',
      correlationId: 'corr-1',
      messageId: 'msg-1',
    } as WagerPayloadFields;
    expect(computePayloadHash(withTransport)).toBe(
      computePayloadHash(fields()),
    );
  });
});

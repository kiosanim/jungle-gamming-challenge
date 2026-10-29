import { createHash } from 'node:crypto';
import { MoneyProps } from '../domain/money';

/** Campos de negócio que definem a identidade do payload de uma transação. */
export interface WagerPayloadFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

/**
 * JSON canônico: chaves ordenadas recursivamente, sem espaços, campos
 * `undefined` omitidos. Duas representações do mesmo payload produzem
 * exatamente a mesma string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(',')}}`;
}

/**
 * `payloadHash` = SHA-256 (hex) do JSON canônico dos campos de negócio.
 * Ficam de fora o header `Idempotency-Key` e metadados de transporte
 * (messageId, correlationId, occurredAt). `money` deve chegar normalizado
 * (`Money.toJSON()`), para que `"25"` e `"25.00"` tenham o mesmo hash.
 */
export function computePayloadHash(fields: WagerPayloadFields): string {
  const business: WagerPayloadFields = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: { amount: fields.money.amount, currency: fields.money.currency },
    referenceExternalTransactionId: fields.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(business)).digest('hex');
}

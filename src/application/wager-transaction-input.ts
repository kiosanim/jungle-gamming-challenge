import { InvalidMoneyError, Money, MoneyProps } from '../domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction';
import { InvalidPayloadError } from './errors';
import { isRecord, parseUuid } from './input-parsing';

const MAX_ID_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

/** Kinds aceitos de provedores; `OPENING` é interno. */
const SUBMITTABLE_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

export interface WagerTransactionInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

/**
 * Valida a chave de idempotência e os campos de negócio de uma transação. O
 * contrato é o mesmo para o corpo HTTP e para o `data` da mensagem SQS.
 */
export function parseWagerTransactionInput(
  idempotencyKey: string | undefined,
  body: unknown,
): WagerTransactionInput {
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.trim() === '' ||
    idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new InvalidPayloadError(
      `Idempotency-Key é obrigatória (até ${MAX_IDEMPOTENCY_KEY_LENGTH} caracteres)`,
    );
  }
  if (!isRecord(body)) {
    throw new InvalidPayloadError('payload deve ser um objeto JSON');
  }

  const kind = body.kind;
  if (typeof kind !== 'string' || !SUBMITTABLE_KINDS.has(kind)) {
    throw new InvalidPayloadError(
      `kind deve ser um de: ${[...SUBMITTABLE_KINDS].join(', ')}`,
    );
  }

  const reference = body.referenceExternalTransactionId;
  if (reference !== undefined && reference !== null) {
    requiredString(body, 'referenceExternalTransactionId');
  }

  return {
    idempotencyKey,
    providerId: requiredString(body, 'providerId'),
    externalTransactionId: requiredString(body, 'externalTransactionId'),
    playerId: requiredString(body, 'playerId'),
    walletId: parseUuid(requiredString(body, 'walletId'), 'walletId'),
    roundId: requiredString(body, 'roundId'),
    gameId: requiredString(body, 'gameId'),
    kind: kind as WagerTransactionKind,
    money: parseMoney(body.money),
    referenceExternalTransactionId:
      reference === undefined || reference === null
        ? undefined
        : (reference as string),
  };
}

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    value.length > MAX_ID_LENGTH
  ) {
    throw new InvalidPayloadError(
      `${field} deve ser string não vazia com até ${MAX_ID_LENGTH} caracteres`,
    );
  }
  return value;
}

function parseMoney(value: unknown): Money {
  if (!isRecord(value)) {
    throw new InvalidPayloadError('money deve ser { amount, currency }');
  }
  try {
    return Money.from(value as unknown as MoneyProps);
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new InvalidPayloadError(`money: ${error.message}`);
    }
    throw error;
  }
}

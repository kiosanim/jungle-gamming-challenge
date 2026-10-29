import {
  parseWagerTransactionInput,
  type WagerTransactionInput,
} from '../application/wager-transaction-input';
import { FailureCode } from '../domain/failure-code';
import { MoneyProps } from '../domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';

/** Resposta de `POST /wagering/transactions` (inclusive replays e rejeições). */
export interface SubmitWagerTransactionResponse {
  transactionId: string;
  status: WagerTransactionStatus;
  balance?: MoneyProps;
  failureCode?: FailureCode;
  idempotentReplay: boolean;
}

export interface WagerTransactionResponse {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

/** Valida header + corpo de `POST /wagering/transactions`. */
export function parseSubmitWagerTransactionRequest(
  idempotencyKey: string | undefined,
  body: unknown,
): WagerTransactionInput {
  return parseWagerTransactionInput(idempotencyKey, body);
}

export function toSubmitResponse(
  transaction: WagerTransaction,
  idempotentReplay: boolean,
): SubmitWagerTransactionResponse {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    ...(transaction.balanceAfter && {
      balance: transaction.balanceAfter.toJSON(),
    }),
    ...(transaction.failureCode && { failureCode: transaction.failureCode }),
    idempotentReplay,
  };
}

export function toTransactionResponse(
  transaction: WagerTransaction,
): WagerTransactionResponse {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    status: transaction.status,
    ...(transaction.failureCode && { failureCode: transaction.failureCode }),
    ...(transaction.referenceExternalTransactionId && {
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId,
    }),
    ...(transaction.referenceTransactionId && {
      referenceTransactionId: transaction.referenceTransactionId,
    }),
    ...(transaction.balanceAfter && {
      balance: transaction.balanceAfter.toJSON(),
    }),
    createdAt: transaction.createdAt.toISOString(),
    ...(transaction.processedAt && {
      processedAt: transaction.processedAt.toISOString(),
    }),
  };
}

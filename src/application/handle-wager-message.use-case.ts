import { CurrencyMismatchError, InvalidMoneyError } from '../domain/money';
import {
  InvalidWagerTransactionError,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import { InvalidWalletOperationError } from '../domain/wallet';
import {
  IdempotencyConflictError,
  InvalidPayloadError,
  WalletNotFoundError,
} from './errors';
import { isRecord } from './input-parsing';
import { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';
import { parseWagerTransactionInput } from './wager-transaction-input';

export const WAGER_TRANSACTIONS_CONSUMER = 'wager-transactions';
export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

/**
 * O que fazer com a mensagem:
 * - `ack`: o resultado é terminal (processada, rejeitada, pendente, duplicada
 *   ou erro de negócio), então ela sai da fila;
 * - `retry`: falha transitória, ela volta para a fila com backoff;
 * - `dead-letter`: ela nunca vai ser aceita e vai para a DLQ.
 */
/** Identificadores conhecidos da mensagem, para logs e métricas de quem consome. */
export interface MessageContext {
  messageId?: string;
  correlationId?: string;
  providerId?: string;
  walletId?: string;
  transactionId?: string;
  kind?: string;
  status?: string;
}

export type MessageDisposition = (
  | {
      action: 'ack';
      outcome:
        | 'processed'
        | 'rejected'
        | 'pending'
        | 'replay'
        | 'duplicate'
        | 'business-error';
      transactionId?: string;
      code?: string;
    }
  | { action: 'retry'; reason: string }
  | { action: 'dead-letter'; reason: string }
) & { context: MessageContext };

/** Mensagem malformada: reenviar a mesma mensagem dará sempre o mesmo erro. */
const PERMANENT_ERRORS = [
  InvalidPayloadError,
  InvalidMoneyError,
  CurrencyMismatchError,
  InvalidWagerTransactionError,
  InvalidWalletOperationError,
];

/** Erros de negócio sem transação persistida: terminais, não há o que repetir. */
const BUSINESS_ERRORS = [IdempotencyConflictError, WalletNotFoundError];

/**
 * Processa uma mensagem `WagerTransactionRequested` com o **mesmo** use case
 * da entrada HTTP, deduplicando pela inbox persistente
 * `(consumerName, messageId)` na mesma transação SQL.
 *
 * Qualquer outro erro (banco indisponível, lock timeout, deadlock, erro
 * inesperado) é tratado como transitório; o consumidor limita as tentativas
 * e, esgotadas, envia para a DLQ.
 */
export class HandleWagerMessageUseCase {
  constructor(private readonly submit: SubmitWagerTransactionUseCase) {}

  async handle(body: string): Promise<MessageDisposition> {
    const context: MessageContext = {};
    try {
      const message = this.parse(body);
      context.messageId = message.messageId;
      context.correlationId = message.correlationId ?? message.messageId;
      const input = parseWagerTransactionInput(
        message.data.idempotencyKey as string | undefined,
        message.data,
      );
      context.providerId = input.providerId;
      context.walletId = input.walletId;
      context.kind = input.kind;
      const result = await this.submit.execute({
        ...input,
        correlationId: message.correlationId ?? message.messageId,
        causationId: message.messageId,
        inbox: {
          consumerName: WAGER_TRANSACTIONS_CONSUMER,
          messageId: message.messageId,
        },
      });

      const { transaction } = result;
      context.transactionId = transaction.id;
      context.status = transaction.status;
      return {
        context,
        action: 'ack',
        outcome: result.duplicateMessage
          ? 'duplicate'
          : result.idempotentReplay
            ? 'replay'
            : outcomeOf(transaction.status),
        transactionId: transaction.id,
        code: transaction.failureCode,
      };
    } catch (error) {
      if (PERMANENT_ERRORS.some((type) => error instanceof type)) {
        return {
          context,
          action: 'dead-letter',
          reason: `${(error as Error).name}: ${(error as Error).message}`,
        };
      }
      if (BUSINESS_ERRORS.some((type) => error instanceof type)) {
        return {
          context,
          action: 'ack',
          outcome: 'business-error',
          code: (error as { code: string }).code,
        };
      }
      return {
        context,
        action: 'retry',
        reason: (error as Error)?.name ?? 'Error',
      };
    }
  }

  private parse(body: string): {
    messageId: string;
    correlationId?: string;
    data: Record<string, unknown>;
  } {
    let envelope: unknown;
    try {
      envelope = JSON.parse(body);
    } catch {
      throw new InvalidPayloadError('mensagem não é JSON válido');
    }
    if (!isRecord(envelope)) {
      throw new InvalidPayloadError('mensagem deve ser um objeto JSON');
    }
    if (envelope.type !== WAGER_TRANSACTION_REQUESTED) {
      throw new InvalidPayloadError(
        `type deve ser ${WAGER_TRANSACTION_REQUESTED}`,
      );
    }
    const { messageId, correlationId, data } = envelope;
    if (
      typeof messageId !== 'string' ||
      messageId.trim() === '' ||
      messageId.length > 256
    ) {
      throw new InvalidPayloadError('messageId é obrigatório');
    }
    if (!isRecord(data)) {
      throw new InvalidPayloadError('data deve ser um objeto');
    }
    return {
      messageId,
      correlationId:
        typeof correlationId === 'string' && correlationId !== ''
          ? correlationId
          : undefined,
      data,
    };
  }
}

function outcomeOf(
  status: WagerTransactionStatus,
): 'processed' | 'rejected' | 'pending' {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 'processed';
    case WagerTransactionStatus.Rejected:
      return 'rejected';
    default:
      return 'pending';
  }
}

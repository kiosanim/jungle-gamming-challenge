import { FailureCode } from './failure-code';
import {
  EventContext,
  IntegrationEvent,
  InvalidIntegrationEventError,
} from './integration-event';
import { MoneyProps } from './money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from './wager-transaction';
import { Wallet } from './wallet';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

/*
 * Todos os eventos usam `walletId` como `aggregateId`: a wallet é a unidade de
 * concorrência e de ordenação (ex.: MessageGroupId em fila FIFO).
 */

/** Campos da transação comuns aos eventos de wagering. */
export interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  referenceTransactionId?: string;
  /** Saldo da wallet observado após o processamento. */
  balance: MoneyProps;
  /** ISO-8601 */
  processedAt: string;
}

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  failureCode: FailureCode;
}

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  referenceExternalTransactionId: string;
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

function transactionData(
  transaction: WagerTransaction,
): WagerTransactionEventData {
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
  };
}

function assertStatus(
  transaction: WagerTransaction,
  expected: WagerTransactionStatus,
  eventType: string,
): void {
  if (transaction.status !== expected) {
    throw new InvalidIntegrationEventError(
      `${eventType} exige transação ${expected}, recebida ${transaction.status}`,
    );
  }
}

function eventProps<T>(aggregateId: string, data: T, ctx: EventContext) {
  return { ...ctx, aggregateId, data };
}

/** Qualquer transação aplicada, inclusive `LOSS`. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    assertStatus(
      transaction,
      WagerTransactionStatus.Processed,
      'WagerTransactionProcessed',
    );
    if (transaction.walletId !== wallet.id) {
      throw new InvalidIntegrationEventError(
        'transação e wallet não correspondem',
      );
    }
    const { referenceTransactionId, processedAt } = transaction;
    return new WagerTransactionProcessed(
      eventProps(
        wallet.id,
        {
          ...transactionData(transaction),
          ...(referenceTransactionId !== undefined && {
            referenceTransactionId,
          }),
          balance: transaction.balanceAfter!.toJSON(),
          processedAt: processedAt!.toISOString(),
        },
        ctx,
      ),
    );
  }
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    assertStatus(
      transaction,
      WagerTransactionStatus.Rejected,
      'WagerTransactionRejected',
    );
    return new WagerTransactionRejected(
      eventProps(
        transaction.walletId,
        {
          ...transactionData(transaction),
          failureCode: transaction.failureCode!,
        },
        ctx,
      ),
    );
  }
}

/** Transação aguardando a referência que ainda não chegou. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    assertStatus(
      transaction,
      WagerTransactionStatus.PendingReference,
      'WagerTransactionPendingReference',
    );
    return new WagerTransactionPendingReference(
      eventProps(
        transaction.walletId,
        {
          ...transactionData(transaction),
          referenceExternalTransactionId:
            transaction.referenceExternalTransactionId!,
        },
        ctx,
      ),
    );
  }
}

/** Só é emitido quando o saldo muda, a partir do lançamento no ledger. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new InvalidIntegrationEventError(
        'lançamento não pertence à wallet',
      );
    }
    return new WalletBalanceChanged(
      eventProps(
        wallet.id,
        {
          walletId: wallet.id,
          transactionId: entry.transactionId,
          direction: entry.direction,
          money: entry.money.toJSON(),
          balanceBefore: entry.balanceBefore.toJSON(),
          balanceAfter: entry.balanceAfter.toJSON(),
          walletVersion: wallet.version,
        },
        ctx,
      ),
    );
  }
}

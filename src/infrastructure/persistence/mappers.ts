import { LedgerAccount } from '../../domain/ledger-account';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import {
  OutboxMessageEntity,
  WagerTransactionEntity,
  WalletEntity,
  WalletLedgerEntryEntity,
} from './entities';

/*
 * Conversão domínio ↔ registro persistido. A ida usa o estado público do
 * agregado; a volta sempre passa por `rehydrate`, que não revalida transições.
 * Valores monetários trafegam como string decimal nos dois sentidos.
 */

const money = (amount: string, currency: string) =>
  Money.from({ amount, currency });

export const walletMapper = {
  toRecord(wallet: Wallet): WalletEntity {
    return Object.assign(new WalletEntity(), {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON().amount,
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
  },

  toDomain(record: WalletEntity): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: money(record.balance, record.currency),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  },
};

export const wagerTransactionMapper = {
  toRecord(transaction: WagerTransaction): WagerTransactionEntity {
    const { amount, currency } = transaction.money.toJSON();
    return Object.assign(new WagerTransactionEntity(), {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount,
      currency,
      referenceExternalTransactionId:
        transaction.referenceExternalTransactionId,
      referenceTransactionId: transaction.referenceTransactionId,
      status: transaction.status,
      failureCode: transaction.failureCode,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt,
      balanceAfter: transaction.balanceAfter?.toJSON().amount,
      referenceAttempts: transaction.referenceAttempts,
      nextReferenceCheckAt: transaction.nextReferenceCheckAt,
    });
  },

  /**
   * `balanceAfter` está na moeda da wallet, que pode diferir da moeda da
   * transação (rejeição por `CURRENCY_MISMATCH`).
   */
  toDomain(
    record: WagerTransactionEntity,
    walletCurrency: string,
  ): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind,
      money: money(record.amount, record.currency),
      referenceExternalTransactionId:
        record.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      status: record.status,
      failureCode: record.failureCode ?? undefined,
      createdAt: record.createdAt,
      processedAt: record.processedAt ?? undefined,
      balanceAfter:
        record.balanceAfter != null
          ? money(record.balanceAfter, walletCurrency)
          : undefined,
      referenceAttempts: record.referenceAttempts,
      nextReferenceCheckAt: record.nextReferenceCheckAt ?? undefined,
    });
  },
};

export const ledgerEntryMapper = {
  toRecord(entry: WalletLedgerEntry): WalletLedgerEntryEntity {
    return Object.assign(new WalletLedgerEntryEntity(), {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      counterAccountId: entry.counterAccount.id,
      amount: entry.money.toJSON().amount,
      balanceBefore: entry.balanceBefore.toJSON().amount,
      balanceAfter: entry.balanceAfter.toJSON().amount,
      walletVersion: entry.walletVersion,
      createdAt: entry.createdAt,
    });
  },

  /** A moeda não é persistida no ledger: é sempre a da wallet. */
  toDomain(
    record: WalletLedgerEntryEntity,
    walletCurrency: string,
  ): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: record.direction,
      money: money(record.amount, walletCurrency),
      counterAccount: LedgerAccount.fromId(record.counterAccountId),
      balanceBefore: money(record.balanceBefore, walletCurrency),
      balanceAfter: money(record.balanceAfter, walletCurrency),
      walletVersion: record.walletVersion,
      createdAt: record.createdAt,
    });
  },
};

export const outboxMessageMapper = {
  toRecord(message: OutboxMessage): OutboxMessageEntity {
    return Object.assign(new OutboxMessageEntity(), {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt,
      publishedAt: message.publishedAt,
      traceContext: message.traceContext ?? null,
    });
  },

  toDomain(record: OutboxMessageEntity): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: record.occurredAt,
      attempts: record.attempts,
      nextAttemptAt: record.nextAttemptAt ?? undefined,
      publishedAt: record.publishedAt ?? undefined,
      traceContext: record.traceContext ?? undefined,
    });
  },
};

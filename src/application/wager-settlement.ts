import { FailureCode } from '../domain/failure-code';
import { EventContext, IntegrationEvent } from '../domain/integration-event';
import { LedgerAccount } from '../domain/ledger-account';
import { OutboxMessage } from '../domain/outbox-message';
import {
  WagerTransaction,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/wagering-events';
import { InsufficientFundsError, Wallet } from '../domain/wallet';
import {
  LedgerDirection,
  WalletLedgerEntry,
} from '../domain/wallet-ledger-entry';
import { IdGenerator } from './ports/id-generator';
import { NOOP_TRACER, Tracer } from './ports/tracer';
import { TransactionalContext } from './ports/unit-of-work';

/** Resultado da decisão, ainda não persistido. */
export interface SettlementDecision {
  /** Version da wallet lida sob lock, para a atualização condicional. */
  expectedVersion: number;
  /**
   * Lançamento gerado quando o saldo muda. Ele também é a transferência de
   * partidas dobradas entre a wallet e a conta do provedor.
   */
  entry?: WalletLedgerEntry;
  /** A transação acabou de entrar em `PENDING_REFERENCE` (gera evento). */
  enteredPendingReference: boolean;
}

export interface EventMetadata {
  correlationId: string;
  causationId?: string;
}

/**
 * Regras de liquidação de uma `WagerTransaction` contra a wallet já
 * bloqueada (`SELECT … FOR UPDATE`). Compartilhada pela submissão (HTTP/SQS)
 * e pelo worker de `PENDING_REFERENCE`, para que a decisão seja a mesma não
 * importa por onde a transação chegou.
 *
 * Toda referência válida pertence à mesma wallet (regra de domínio), então o
 * lock da wallet também serializa o estado da referência e de suas reversões.
 */
export class WagerSettlement {
  constructor(
    private readonly ids: IdGenerator,
    private readonly tracer: Tracer = NOOP_TRACER,
  ) {}

  /**
   * Decide o destino da transação (`PROCESSED`, `REJECTED` ou
   * `PENDING_REFERENCE`) e aplica o efeito no agregado `Wallet` em memória.
   * Só faz leituras; nada é gravado aqui. No trace, é a camada de domínio:
   * o span registra a decisão tomada.
   */
  decide(
    ctx: TransactionalContext,
    wallet: Wallet,
    transaction: WagerTransaction,
    at: Date,
  ): Promise<SettlementDecision> {
    return this.tracer.inSpan(
      'WagerSettlement.decide',
      { 'wagering.layer': 'domain', 'wagering.kind': transaction.kind },
      async (span) => {
        const decision = await this.decideIn(ctx, wallet, transaction, at);
        span.setAttributes({
          'wagering.status': transaction.status,
          'wagering.balanceChanged': decision.entry !== undefined,
          ...(transaction.failureCode && {
            'wagering.failureCode': transaction.failureCode,
          }),
        });
        return decision;
      },
    );
  }

  private async decideIn(
    ctx: TransactionalContext,
    wallet: Wallet,
    transaction: WagerTransaction,
    at: Date,
  ): Promise<SettlementDecision> {
    const decision: SettlementDecision = {
      expectedVersion: wallet.version,
      enteredPendingReference: false,
    };

    if (wallet.playerId !== transaction.playerId) {
      transaction.reject(FailureCode.WalletPlayerMismatch, wallet.balance);
      return decision;
    }
    if (wallet.currency !== transaction.money.currency) {
      transaction.reject(FailureCode.CurrencyMismatch, wallet.balance);
      return decision;
    }

    let reference: WagerTransaction | undefined;
    if (transaction.referenceExternalTransactionId !== undefined) {
      reference = await ctx.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId,
      );

      // Ausente ou ainda não concluída: esperar (ou desistir, se o TTL acabou).
      if (!reference || !reference.isTerminal()) {
        this.waitForReference(transaction, wallet, at, reference, decision);
        return decision;
      }

      const code = transaction.checkReference(reference);
      if (code) {
        transaction.reject(code, wallet.balance);
        return decision;
      }
      if (
        transaction.requiresReference() &&
        (await ctx.transactions.hasProcessedReversal(reference.id))
      ) {
        transaction.reject(
          FailureCode.ReferenceAlreadyReversed,
          wallet.balance,
        );
        return decision;
      }
    }

    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, at, wallet.balance);
      return decision;
    }

    const movement = {
      entryId: this.ids.newId(),
      transactionId: transaction.id,
      money: transaction.money,
      counterAccount: LedgerAccount.provider(
        transaction.providerId,
        wallet.currency,
      ),
      at,
    };
    try {
      decision.entry =
        transaction.ledgerDirectionFor(reference) === LedgerDirection.Debit
          ? wallet.debit(movement)
          : wallet.credit(movement);
      transaction.markProcessed(reference?.id, at, wallet.balance);
    } catch (error) {
      if (!(error instanceof InsufficientFundsError)) {
        throw error;
      }
      // Uma BET sem saldo vira INSUFFICIENT_FUNDS; uma reversão, REVERSAL_INSUFFICIENT_FUNDS.
      transaction.reject(transaction.insufficientFundsCode(), wallet.balance);
    }
    return decision;
  }

  /**
   * Grava os efeitos de uma decisão já tomada: saldo (atualização
   * condicional), lançamento (com a contrapartida) e eventos na outbox. A transação em si deve ter
   * sido inserida/atualizada antes (o ledger referencia a transação).
   */
  persistEffects(
    ctx: TransactionalContext,
    wallet: Wallet,
    transaction: WagerTransaction,
    decision: SettlementDecision,
    metadata: EventMetadata,
    at: Date,
  ): Promise<void> {
    return this.tracer.inSpan(
      'WagerSettlement.persistEffects',
      { 'wagering.layer': 'application' },
      async (span) => {
        const events = await this.persistEffectsIn(
          ctx,
          wallet,
          transaction,
          decision,
          metadata,
          at,
        );
        span.setAttributes({
          'wagering.balanceChanged': decision.entry !== undefined,
          'wagering.outboxEvents': events,
        });
      },
    );
  }

  /** Grava e devolve quantos eventos foram para a outbox. */
  private async persistEffectsIn(
    ctx: TransactionalContext,
    wallet: Wallet,
    transaction: WagerTransaction,
    decision: SettlementDecision,
    metadata: EventMetadata,
    at: Date,
  ): Promise<number> {
    if (decision.entry) {
      await ctx.wallets.update(wallet, decision.expectedVersion);
      await ctx.ledger.append(decision.entry);
    }

    const context = (): EventContext => ({
      eventId: this.ids.newId(),
      correlationId: metadata.correlationId,
      causationId: metadata.causationId,
      occurredAt: at,
    });

    const events: IntegrationEvent<unknown>[] = [];
    switch (transaction.status) {
      case WagerTransactionStatus.Processed:
        events.push(
          WagerTransactionProcessed.from(transaction, wallet, context()),
        );
        if (decision.entry) {
          events.push(
            WalletBalanceChanged.from(wallet, decision.entry, context()),
          );
        }
        break;
      case WagerTransactionStatus.Rejected:
        events.push(WagerTransactionRejected.from(transaction, context()));
        break;
      case WagerTransactionStatus.PendingReference:
        if (decision.enteredPendingReference) {
          events.push(
            WagerTransactionPendingReference.from(transaction, context()),
          );
        }
        break;
    }

    for (const event of events) {
      await ctx.outbox.enqueue(OutboxMessage.enqueue(event));
    }
    return events.length;
  }

  private waitForReference(
    transaction: WagerTransaction,
    wallet: Wallet,
    at: Date,
    reference: WagerTransaction | undefined,
    decision: SettlementDecision,
  ): void {
    if (transaction.status === WagerTransactionStatus.Pending) {
      transaction.markPendingReference(at);
      decision.enteredPendingReference = true;
      return;
    }
    if (transaction.isReferenceWaitExpired(at)) {
      transaction.reject(
        reference
          ? FailureCode.ReferenceNotProcessed
          : FailureCode.ReferenceNotFound,
        wallet.balance,
      );
      return;
    }
    transaction.scheduleReferenceRetry(at);
  }
}

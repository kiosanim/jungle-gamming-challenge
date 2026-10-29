import { WagerTransactionStatus } from '../domain/wager-transaction';
import { DuplicateTransactionError } from './errors';
import { Clock } from './ports/clock';
import { IdGenerator } from './ports/id-generator';
import { NOOP_TRACER, Tracer } from './ports/tracer';
import { TransactionalContext, UnitOfWork } from './ports/unit-of-work';
import { WagerSettlement } from './wager-settlement';

export type PendingReferenceOutcome =
  'processed' | 'rejected' | 'rescheduled' | 'skipped';

export interface ResolvePendingReferencesReport {
  processed: number;
  rejected: number;
  rescheduled: number;
  skipped: number;
  /** Itens que falharam por erro inesperado; serão tentados no próximo ciclo. */
  failed: number;
  /** Transações decididas neste ciclo (métricas). */
  settled: { kind: string; status: string }[];
}

/**
 * Reprocessa as transações em `PENDING_REFERENCE` cuja verificação venceu.
 *
 * Cada item roda na sua própria transação SQL: trava a wallet com
 * `SELECT … FOR UPDATE` (o mesmo lock da submissão), relê a transação e a
 * liquida pelo `WagerSettlement`. Workers em instâncias diferentes podem
 * pegar o mesmo item. Nesse caso o segundo espera o lock, encontra a
 * transação já resolvida (ou reagendada para mais tarde) e simplesmente a
 * ignora, sem efeito duplicado.
 */
export class ResolvePendingReferencesUseCase {
  private readonly settlement: WagerSettlement;

  constructor(
    private readonly uow: UnitOfWork,
    ids: IdGenerator,
    private readonly clock: Clock,
    private readonly tracer: Tracer = NOOP_TRACER,
  ) {
    this.settlement = new WagerSettlement(ids, tracer);
  }

  async runOnce(limit = 100): Promise<ResolvePendingReferencesReport> {
    const report: ResolvePendingReferencesReport = {
      processed: 0,
      rejected: 0,
      rescheduled: 0,
      skipped: 0,
      failed: 0,
      settled: [],
    };

    const pending = await this.uow.run((ctx) =>
      ctx.transactions.findDuePendingReferences(this.clock.now(), limit),
    );

    for (const { id, traceContext } of pending) {
      try {
        // Um span por item, continuando o trace da requisição que criou a
        // transação; ciclos sem pendências não geram traces.
        const { outcome, kind } = await this.tracer.inSpan(
          'ResolvePendingReferencesUseCase.resolve',
          { 'wagering.layer': 'application', 'wagering.transactionId': id },
          async (span) => {
            const resolved = await this.resolve(id);
            span.setAttributes({ 'wagering.outcome': resolved.outcome });
            return resolved;
          },
          { continueFrom: traceContext },
        );
        report[outcome] += 1;
        if (outcome === 'processed' || outcome === 'rejected') {
          report.settled.push({
            kind: kind!,
            status: outcome === 'processed' ? 'PROCESSED' : 'REJECTED',
          });
        }
      } catch (error) {
        // Corrida de reversão resolvida por outra instância: próximo ciclo
        // relê o estado. Demais falhas também ficam para o próximo ciclo.
        if (!(error instanceof DuplicateTransactionError)) {
          report.failed += 1;
          continue;
        }
        report.skipped += 1;
      }
    }
    return report;
  }

  /** Resolve um único item (exposto para testes e para o worker). */
  resolve(
    transactionId: string,
  ): Promise<{ outcome: PendingReferenceOutcome; kind?: string }> {
    return this.uow.run((ctx) => this.resolveIn(ctx, transactionId));
  }

  private async resolveIn(
    ctx: TransactionalContext,
    transactionId: string,
  ): Promise<{ outcome: PendingReferenceOutcome; kind?: string }> {
    const candidate = await ctx.transactions.findById(transactionId);
    if (candidate?.status !== WagerTransactionStatus.PendingReference) {
      return { outcome: 'skipped' };
    }

    const wallet = await ctx.wallets.lockById(candidate.walletId);
    if (!wallet) {
      return { outcome: 'skipped' };
    }

    // Relida sob o lock da wallet: outro worker pode ter acabado de resolvê-la.
    const transaction = await ctx.transactions.findById(transactionId);
    const now = this.clock.now();
    if (
      transaction?.status !== WagerTransactionStatus.PendingReference ||
      (transaction.nextReferenceCheckAt &&
        transaction.nextReferenceCheckAt.getTime() > now.getTime())
    ) {
      return { outcome: 'skipped' };
    }

    const decision = await this.settlement.decide(
      ctx,
      wallet,
      transaction,
      now,
    );
    await ctx.transactions.update(transaction);
    await this.settlement.persistEffects(
      ctx,
      wallet,
      transaction,
      decision,
      { correlationId: transaction.id, causationId: transaction.id },
      now,
    );

    // `decide` muda o status; lido de novo sem o estreitamento de tipo acima.
    const outcome = transaction.status as WagerTransactionStatus;
    switch (outcome) {
      case WagerTransactionStatus.Processed:
        return { outcome: 'processed', kind: transaction.kind };
      case WagerTransactionStatus.Rejected:
        return { outcome: 'rejected', kind: transaction.kind };
      default:
        return { outcome: 'rescheduled', kind: transaction.kind };
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { METRICS, type Metrics } from '../../application/ports/metrics';
import { ResolvePendingReferencesUseCase } from '../../application/resolve-pending-references.use-case';
import { IntervalWorker } from './interval-worker';

const DEFAULT_INTERVAL_MS = 1_000;

/** Reprocessa transações em `PENDING_REFERENCE` com verificação vencida. */
@Injectable()
export class PendingReferenceWorker extends IntervalWorker {
  protected readonly workerName = 'pending-reference';

  constructor(
    @Inject(ResolvePendingReferencesUseCase)
    private readonly useCase: ResolvePendingReferencesUseCase,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {
    super();
  }

  protected intervalMs(): number {
    return Number(
      process.env.PENDING_REFERENCE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
    );
  }

  protected async runCycle(): Promise<void> {
    const { settled, ...report } = await this.useCase.runOnce();
    for (const { kind, status } of settled) {
      this.metrics.transactionSettled({ channel: 'worker', kind, status });
    }
    if (report.processed + report.rejected + report.failed > 0) {
      this.logger.log({ worker: this.workerName, ...report });
    }
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { METRICS, type Metrics } from '../../application/ports/metrics';
import {
  OUTBOX_BATCH_SIZE,
  PublishOutboxUseCase,
} from '../../application/publish-outbox.use-case';
import { IntervalWorker } from './interval-worker';

const DEFAULT_INTERVAL_MS = 200;
/**
 * Laços de publicação concorrentes por instância. Seguro pelo mesmo motivo
 * que publishers em instâncias diferentes: `SKIP LOCKED` dá a cada laço um
 * lote disjunto. Paraleliza a ida e volta ao SQS, que domina o custo do lote.
 */
const DEFAULT_CONCURRENCY = 4;
/** Lotes por ciclo quando há backlog (drena sem esperar o próximo intervalo). */
const MAX_BATCHES_PER_CYCLE = 50;

/** Publica a outbox continuamente; vários em paralelo (laços e instâncias) são seguros. */
@Injectable()
export class OutboxPublisherWorker extends IntervalWorker {
  protected readonly workerName = 'outbox-publisher';

  constructor(
    @Inject(PublishOutboxUseCase)
    private readonly useCase: PublishOutboxUseCase,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {
    super();
  }

  protected intervalMs(): number {
    return Number(
      process.env.OUTBOX_PUBLISH_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
    );
  }

  protected async runCycle(): Promise<void> {
    const concurrency = Number(
      process.env.OUTBOX_PUBLISHER_CONCURRENCY ?? DEFAULT_CONCURRENCY,
    );
    await Promise.all(Array.from({ length: concurrency }, () => this.drain()));
  }

  private async drain(): Promise<void> {
    for (let batch = 0; batch < MAX_BATCHES_PER_CYCLE; batch++) {
      const report = await this.useCase.runOnce();
      if (report.published > 0) {
        this.metrics.outboxPublished(
          report.published,
          report.maxLagMs !== undefined ? report.maxLagMs / 1000 : undefined,
        );
      }
      if (report.failed > 0) {
        this.metrics.messageRetried('outbox', report.failed);
        this.logger.warn({ worker: this.workerName, ...report });
      }
      // Lote incompleto (ou falha do broker): nada mais devido agora.
      if (
        report.claimed === 0 ||
        report.failed > 0 ||
        report.claimed < OUTBOX_BATCH_SIZE
      ) {
        return;
      }
    }
  }
}

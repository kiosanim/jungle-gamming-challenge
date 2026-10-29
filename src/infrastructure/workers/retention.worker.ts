import { Inject, Injectable } from '@nestjs/common';
import { PurgeExpiredMessagesUseCase } from '../../application/purge-expired-messages.use-case';
import { IntervalWorker } from './interval-worker';

const DEFAULT_INTERVAL_MS = 60_000;

/** Aplica a retenção da outbox e da inbox periodicamente. */
@Injectable()
export class RetentionWorker extends IntervalWorker {
  protected readonly workerName = 'retention';

  constructor(
    @Inject(PurgeExpiredMessagesUseCase)
    private readonly useCase: PurgeExpiredMessagesUseCase,
  ) {
    super();
  }

  protected intervalMs(): number {
    return Number(process.env.RETENTION_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  }

  protected async runCycle(): Promise<void> {
    const report = await this.useCase.runOnce();
    if (report.outbox > 0 || report.inbox > 0) {
      this.logger.log({ worker: this.workerName, ...report });
    }
  }
}

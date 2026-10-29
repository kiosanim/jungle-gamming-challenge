import { Module } from '@nestjs/common';
import { OutboxPublisherWorker } from '../infrastructure/workers/outbox-publisher.worker';
import { PendingReferenceWorker } from '../infrastructure/workers/pending-reference.worker';
import { RetentionWorker } from '../infrastructure/workers/retention.worker';
import { CoreModule } from './core.module';
import { OpsModule } from './ops.module';

/** Papel workers: publisher da outbox, referências pendentes e retenção. */
@Module({
  imports: [CoreModule, OpsModule],
  providers: [PendingReferenceWorker, OutboxPublisherWorker, RetentionWorker],
})
export class WorkersModule {}

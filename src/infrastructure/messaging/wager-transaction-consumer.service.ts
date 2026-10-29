import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { HandleWagerMessageUseCase } from '../../application/handle-wager-message.use-case';
import { METRICS, type Metrics } from '../../application/ports/metrics';
import { queueNames } from './sqs';
import {
  DEFAULT_CONSUMER_OPTIONS,
  SqsWagerTransactionConsumer,
} from './sqs-wager-transaction-consumer';

/**
 * Sobe `SQS_CONSUMER_CONCURRENCY` consumidores da fila de transações. Numa
 * fila FIFO, consumidores paralelos recebem grupos diferentes, porque o SQS
 * trava o grupo enquanto alguma mensagem dele está em processamento.
 *
 * Para no `beforeApplicationShutdown`, antes de o pool do PostgreSQL e o
 * cliente SQS serem fechados.
 */
@Injectable()
export class WagerTransactionConsumerService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private consumers: SqsWagerTransactionConsumer[] = [];

  constructor(
    @Inject(SQSClient) private readonly sqs: SQSClient,
    @Inject(HandleWagerMessageUseCase)
    private readonly handler: HandleWagerMessageUseCase,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.WORKERS_ENABLED === 'false') {
      return;
    }
    const names = queueNames();
    const concurrency = Number(process.env.SQS_CONSUMER_CONCURRENCY ?? 1);
    const maxAttempts = Number(
      process.env.SQS_CONSUMER_MAX_ATTEMPTS ??
        DEFAULT_CONSUMER_OPTIONS.maxAttempts,
    );
    // Também é o tempo para uma mensagem voltar à fila se a instância morrer
    // com ela em processamento (crash sem ack).
    const visibilityTimeoutSeconds = Number(
      process.env.SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS ??
        DEFAULT_CONSUMER_OPTIONS.visibilityTimeoutSeconds,
    );
    this.consumers = Array.from(
      { length: concurrency },
      () =>
        new SqsWagerTransactionConsumer(
          this.sqs,
          this.handler,
          {
            ...DEFAULT_CONSUMER_OPTIONS,
            maxAttempts,
            visibilityTimeoutSeconds,
            queueName: names.wagerTransactions,
            dlqName: names.wagerTransactionsDlq,
          },
          this.metrics,
        ),
    );
    for (const consumer of this.consumers) {
      consumer.start();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await Promise.all(this.consumers.map((consumer) => consumer.stop()));
  }
}

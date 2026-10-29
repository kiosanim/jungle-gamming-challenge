import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';
import { Metrics } from '../../application/ports/metrics';

/**
 * Estado da fila de trabalho, lido no momento da coleta (scrape). O lag da
 * outbox é a idade do evento pendente mais antigo, então ele continua
 * crescendo mesmo se nenhum publisher estiver vivo, que é justamente quando
 * importa. Nunca fica negativo, já que o `occurred_at` vem do relógio da
 * aplicação e o `now()`, do banco.
 */
const BACKLOG_SNAPSHOT = `
  select greatest(coalesce(extract(epoch from now() - min(occurred_at)), 0), 0)::float8 as outbox_lag_seconds,
         count(*)::int as outbox_pending,
         (select count(*)::int
            from wager_transaction
           where status = 'PENDING_REFERENCE') as pending_reference
    from outbox_message
   where published_at is null
`;

/** Implementação Prometheus da porta `Metrics`, com registry próprio por instância. */
@Injectable()
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wagering_transactions_total',
    help: 'Transações decididas, por canal, kind e status (replays não contam).',
    labelNames: ['channel', 'kind', 'status'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'wagering_duplicates_total',
    help: 'Duplicatas detectadas (replay idempotente ou mensagem repetida na inbox).',
    labelNames: ['type'],
    registers: [this.registry],
  });
  private readonly conflicts = new Counter({
    name: 'wagering_concurrency_conflicts_total',
    help: 'Disputas de concorrência (corrida de inserção, lock timeout, deadlock…).',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly duration = new Histogram({
    name: 'wagering_processing_duration_seconds',
    help: 'Latência de processamento de uma transação.',
    labelNames: ['channel'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'wagering_message_retries_total',
    help: 'Retentativas (mensagens SQS devolvidas com backoff, eventos da outbox).',
    labelNames: ['source'],
    registers: [this.registry],
  });
  private readonly deadLetters = new Counter({
    name: 'wagering_dead_letters_total',
    help: 'Mensagens enviadas para a DLQ.',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly published = new Counter({
    name: 'wagering_outbox_published_total',
    help: 'Eventos publicados pela outbox.',
    registers: [this.registry],
  });
  private readonly publishLag = new Histogram({
    name: 'wagering_outbox_publish_lag_seconds',
    help: 'Atraso entre a ocorrência do evento e sua publicação.',
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
    registers: [this.registry],
  });
  private readonly reconciliations = new Counter({
    name: 'wagering_reconciliations_total',
    help: 'Reconciliações executadas, por resultado (consistent/divergent).',
    labelNames: ['result'],
    registers: [this.registry],
  });

  private readonly retention = new Counter({
    name: 'wagering_retention_deleted_total',
    help: 'Registros apagados pela retenção (outbox publicada, inbox antiga).',
    labelNames: ['table'],
    registers: [this.registry],
  });

  constructor(@Inject(MikroORM) orm: MikroORM) {
    collectDefaultMetrics({ register: this.registry });

    let snapshot: Promise<Record<string, number>> | undefined;
    // Uma consulta por scrape, compartilhada pelos três gauges.
    const backlog = async (key: string) => {
      snapshot ??= orm.em
        .fork()
        .execute(BACKLOG_SNAPSHOT)
        .then(([row]) => row as Record<string, number>)
        .finally(() => setTimeout(() => (snapshot = undefined), 0));
      return (await snapshot)[key];
    };
    new Gauge({
      name: 'wagering_outbox_lag_seconds',
      help: 'Idade do evento pendente mais antigo da outbox.',
      registers: [this.registry],
      async collect() {
        this.set(await backlog('outbox_lag_seconds'));
      },
    });
    new Gauge({
      name: 'wagering_outbox_pending',
      help: 'Eventos aguardando publicação.',
      registers: [this.registry],
      async collect() {
        this.set(await backlog('outbox_pending'));
      },
    });
    new Gauge({
      name: 'wagering_pending_reference_transactions',
      help: 'Transações aguardando referência (PENDING_REFERENCE).',
      registers: [this.registry],
      async collect() {
        this.set(await backlog('pending_reference'));
      },
    });
  }

  transactionSettled(labels: {
    channel: string;
    kind: string;
    status: string;
  }): void {
    this.transactions.inc(labels);
  }

  duplicateDetected(type: string): void {
    this.duplicates.inc({ type });
  }

  concurrencyConflict(reason: string): void {
    this.conflicts.inc({ reason });
  }

  processingDuration(channel: string, seconds: number): void {
    this.duration.observe({ channel }, seconds);
  }

  messageRetried(source: string, count = 1): void {
    this.retries.inc({ source }, count);
  }

  messageDeadLettered(reason: string): void {
    this.deadLetters.inc({ reason });
  }

  outboxPublished(count: number, maxLagSeconds?: number): void {
    this.published.inc(count);
    if (maxLagSeconds !== undefined) {
      this.publishLag.observe(maxLagSeconds);
    }
  }

  retentionPurged(table: 'outbox' | 'inbox', count: number): void {
    this.retention.inc({ table }, count);
  }

  reconciliationChecked(consistent: boolean): void {
    this.reconciliations.inc({
      result: consistent ? 'consistent' : 'divergent',
    });
  }
}

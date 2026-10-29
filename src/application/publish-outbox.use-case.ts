import { OutboxMessage } from '../domain/outbox-message';
import { Clock } from './ports/clock';
import { EventPublisher, PublishResult } from './ports/event-publisher';
import { NOOP_TRACER, Tracer } from './ports/tracer';
import { TransactionalContext, UnitOfWork } from './ports/unit-of-work';

/** Limite do `SendMessageBatch` do SQS. */
export const OUTBOX_BATCH_SIZE = 10;

export interface PublishOutboxReport {
  claimed: number;
  published: number;
  failed: number;
  /** Maior atraso (ms) entre a ocorrência e a publicação neste lote. */
  maxLagMs?: number;
  /** Nome do erro, se o broker falhou por inteiro. */
  error?: string;
}

/**
 * Publica um lote da outbox.
 *
 * Tudo acontece numa única transação SQL: reserva o lote (`FOR UPDATE SKIP
 * LOCKED`), publica no broker e, antes do commit, marca as mensagens como
 * publicadas ou agenda uma nova tentativa com backoff.
 *
 * Como só linhas já confirmadas aparecem na reserva, nada é publicado antes
 * do commit da operação financeira. Também não se perde evento, porque uma
 * linha só deixa de ser pendente no mesmo commit que registra a publicação.
 * Publishers concorrentes recebem lotes disjuntos e não publicam o mesmo
 * evento ao mesmo tempo. Se o processo cair depois de publicar e antes do
 * commit, as linhas voltam a ficar pendentes e saem de novo com o mesmo
 * `eventId`; a entrega é at-least-once, e o consumidor deduplica pelo
 * `eventId`.
 *
 * O preço é manter a transação aberta durante a chamada ao broker. O lote é
 * pequeno e só as linhas reservadas ficam travadas.
 */
export class PublishOutboxUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly tracer: Tracer = NOOP_TRACER,
  ) {}

  runOnce(batchSize = OUTBOX_BATCH_SIZE): Promise<PublishOutboxReport> {
    return this.uow.run(async (ctx) => {
      const claimedAt = this.clock.now();
      const messages = await ctx.outbox.claimDue(claimedAt, batchSize);
      if (messages.length === 0) {
        return { claimed: 0, published: 0, failed: 0 };
      }
      // O span só começa quando há lote; ciclos vazios não geram traces.
      return this.tracer.inSpan(
        'PublishOutboxUseCase.publish',
        {
          'wagering.layer': 'application',
          'wagering.claimed': messages.length,
        },
        async (span) => {
          const report = await this.publishClaimed(ctx, messages);
          span.setAttributes({
            'wagering.published': report.published,
            'wagering.failed': report.failed,
          });
          return report;
        },
      );
    });
  }

  /** Publica o lote já reservado e grava o resultado de cada mensagem. */
  private async publishClaimed(
    ctx: TransactionalContext,
    messages: OutboxMessage[],
  ): Promise<PublishOutboxReport> {
    let result: PublishResult;
    let error: string | undefined;
    try {
      result = await this.publisher.publish(messages);
    } catch (cause) {
      error = (cause as Error).name;
      result = { published: [], failed: messages.map((m) => m.id) };
    }

    const published = new Set(result.published);
    const publishedAt = this.clock.now();
    let maxLagMs: number | undefined;
    for (const message of messages) {
      if (published.has(message.id)) {
        message.markPublished(publishedAt);
        const lag = publishedAt.getTime() - message.occurredAt.getTime();
        maxLagMs = Math.max(maxLagMs ?? 0, lag);
      } else {
        message.scheduleRetry(publishedAt);
      }
      await ctx.outbox.update(message);
    }

    return {
      claimed: messages.length,
      published: published.size,
      failed: messages.length - published.size,
      ...(maxLagMs !== undefined && { maxLagMs }),
      ...(error && { error }),
    };
  }
}

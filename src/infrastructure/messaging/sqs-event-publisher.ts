import {
  GetQueueUrlCommand,
  SendMessageBatchCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { context, ROOT_CONTEXT, type Span, trace } from '@opentelemetry/api';
import {
  EventPublisher,
  PublishResult,
} from '../../application/ports/event-publisher';
import { OutboxMessage } from '../../domain/outbox-message';
import {
  contextFromTraceparent,
  linkFromTraceparent,
  SpanKind,
  SpanStatusCode,
  tracer,
  withSpan,
} from '../observability/tracing';

/**
 * Publica eventos numa fila SQS FIFO, com um span de produtor por lote e um
 * link para o trace de origem de cada evento.
 *
 * Cada evento também ganha um span próprio dentro do trace da requisição que
 * o originou (com `transactionId` e `eventType`) e uma linha de log. Assim,
 * buscando pelo `traceId` ou pelo `transactionId`, chega-se da API até a
 * publicação feita pelo worker.
 *
 * O `MessageGroupId` é o `aggregateId` (o walletId), o que mantém a ordem por
 * wallet dentro de um lote e deixa wallets diferentes em paralelo. O
 * `MessageDeduplicationId` é o `eventId`, e o broker descarta republicações
 * dentro da janela de 5 minutos; isso é só uma otimização, porque a garantia
 * de verdade é o consumidor deduplicar pelo `eventId`. O corpo é o envelope
 * JSON gravado na outbox, e o atributo `traceparent` leva o trace de quem
 * gerou o evento, para o consumidor continuar o trace original.
 */
export class SqsEventPublisher implements EventPublisher {
  private readonly logger = new Logger('OutboxPublisher');
  private queueUrl?: Promise<string>;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    if (messages.length === 0) {
      return { published: [], failed: [] };
    }

    const links = messages
      .map((message) => linkFromTraceparent(message.traceContext))
      .filter((link) => link !== undefined);
    return withSpan(
      `${this.queueName} publish`,
      {
        kind: SpanKind.PRODUCER,
        links,
        attributes: {
          'wagering.layer': 'messaging',
          'messaging.system': 'aws_sqs',
          'messaging.operation.type': 'send',
          'messaging.destination.name': this.queueName,
          'messaging.batch.message_count': messages.length,
        },
      },
      async (batchSpan) => {
        const eventSpans = messages.map((message) =>
          this.startEventSpan(message, batchSpan),
        );
        try {
          const result = await this.send(messages);
          const published = new Set(result.published);
          messages.forEach((message, index) =>
            this.finishEventSpan(
              message,
              eventSpans[index],
              published.has(message.id),
            ),
          );
          return result;
        } catch (error) {
          for (const span of eventSpans) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.end();
          }
          throw error;
        }
      },
    );
  }

  private async send(
    messages: readonly OutboxMessage[],
  ): Promise<PublishResult> {
    const response = await this.sqs.send(
      new SendMessageBatchCommand({
        QueueUrl: await this.resolveQueueUrl(),
        Entries: messages.map((message, index) => ({
          Id: String(index),
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
          MessageAttributes: {
            eventType: { DataType: 'String', StringValue: message.eventType },
            eventId: { DataType: 'String', StringValue: message.id },
            ...(message.traceContext && {
              traceparent: {
                DataType: 'String',
                StringValue: message.traceContext,
              },
            }),
          },
        })),
      }),
    );

    const idOf = (entryId?: string) => messages[Number(entryId)].id;
    return {
      published: (response.Successful ?? []).map((e) => idOf(e.Id)),
      failed: (response.Failed ?? []).map((e) => idOf(e.Id)),
    };
  }

  /**
   * Span do evento, filho do trace que o originou (ou raiz, se o evento foi
   * gravado sem trace), com um link para o span do lote.
   */
  private startEventSpan(message: OutboxMessage, batchSpan: Span): Span {
    const transactionId = transactionIdOf(message);
    return tracer().startSpan(
      `publish ${message.eventType}`,
      {
        kind: SpanKind.PRODUCER,
        links: [{ context: batchSpan.spanContext() }],
        attributes: {
          'wagering.layer': 'messaging',
          'wagering.eventType': message.eventType,
          'wagering.eventId': message.id,
          'wagering.walletId': message.aggregateId,
          ...(transactionId && { 'wagering.transactionId': transactionId }),
          'messaging.destination.name': this.queueName,
        },
      },
      message.traceContext
        ? contextFromTraceparent(message.traceContext)
        : ROOT_CONTEXT,
    );
  }

  /**
   * Fecha o span do evento e registra a linha de log dentro dele, para que o
   * log saia com o `traceId` da requisição de origem.
   */
  private finishEventSpan(
    message: OutboxMessage,
    span: Span,
    published: boolean,
  ): void {
    span.setAttribute('wagering.published', published);
    if (!published) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'recusado pelo broker',
      });
    }
    context.with(trace.setSpan(context.active(), span), () => {
      this.logger.log({
        event: published ? 'outbox_event_published' : 'outbox_event_refused',
        eventType: message.eventType,
        eventId: message.id,
        walletId: message.aggregateId,
        transactionId: transactionIdOf(message),
      });
    });
    span.end();
  }

  private resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= this.sqs
      .send(new GetQueueUrlCommand({ QueueName: this.queueName }))
      .then(({ QueueUrl }) => QueueUrl!)
      .catch((error: unknown) => {
        // Não guarda a falha: a próxima publicação tenta resolver de novo.
        this.queueUrl = undefined;
        throw error;
      });
    return this.queueUrl;
  }
}

/** `transactionId` do evento, quando o envelope traz um. */
function transactionIdOf(message: OutboxMessage): string | undefined {
  const data = message.payload.data as Record<string, unknown> | undefined;
  return typeof data?.transactionId === 'string'
    ? data.transactionId
    : undefined;
}

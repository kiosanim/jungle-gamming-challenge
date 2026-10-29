import {
  ChangeMessageVisibilityBatchCommand,
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import type { Span } from '@opentelemetry/api';
import {
  HandleWagerMessageUseCase,
  MessageDisposition,
} from '../../application/handle-wager-message.use-case';
import { Metrics, NOOP_METRICS } from '../../application/ports/metrics';
import { RequestContext } from '../observability/request-context';
import {
  contextFromTraceparent,
  SpanKind,
  SpanStatusCode,
  withSpan,
} from '../observability/tracing';
import { MAX_RECEIVE_COUNT } from './queues';

export interface WagerConsumerOptions {
  queueName: string;
  dlqName: string;
  /** Entregas antes de desistir e enviar para a DLQ. */
  maxAttempts: number;
  /** Backoff do retry: base × 2^(entrega − 1) segundos, até o teto. */
  baseBackoffSeconds: number;
  maxBackoffSeconds: number;
  visibilityTimeoutSeconds: number;
  waitTimeSeconds: number;
  batchSize: number;
}

export const DEFAULT_CONSUMER_OPTIONS: Omit<
  WagerConsumerOptions,
  'queueName' | 'dlqName'
> = {
  maxAttempts: MAX_RECEIVE_COUNT,
  baseBackoffSeconds: 2,
  maxBackoffSeconds: 300,
  visibilityTimeoutSeconds: 30,
  waitTimeSeconds: 10,
  batchSize: 10,
};

/** Falhas transitórias que representam disputa de concorrência (métrica). */
const CONCURRENCY_CONFLICTS = new Set([
  'DeadlockException',
  'LockWaitTimeoutException',
  'ConcurrentModificationError',
  'DuplicateTransactionError',
]);

/** Pausa após falha do próprio SQS (ex.: broker fora do ar) antes de tentar de novo. */
const RECEIVE_ERROR_PAUSE_MS = 1_000;

/**
 * Consumidor da fila `wager-transactions.fifo`.
 *
 * A mensagem só é removida (ack) depois que o handler, que roda a transação
 * SQL com a inbox, retorna. Uma falha transitória estende a visibilidade da
 * mensagem, com backoff exponencial pela contagem de entregas. Mensagem
 * malformada vai direto para a DLQ; uma falha transitória que não se resolve
 * vai depois de `maxAttempts` entregas, e a `RedrivePolicy` da fila fica como
 * rede de segurança.
 *
 * A ordem FIFO é respeitada: se uma mensagem de um grupo volta para a fila,
 * as seguintes do mesmo grupo naquele lote voltam junto. No SIGTERM (`stop`),
 * o consumidor interrompe o long polling, termina a mensagem em andamento e
 * devolve a visibilidade das que ainda não começaram.
 */
export class SqsWagerTransactionConsumer {
  private readonly logger = new Logger(SqsWagerTransactionConsumer.name);
  private readonly abort = new AbortController();
  private stopping = false;
  private loop?: Promise<void>;
  private urls?: Promise<{ queue: string; dlq: string }>;

  constructor(
    private readonly sqs: SQSClient,
    private readonly handler: HandleWagerMessageUseCase,
    private readonly options: WagerConsumerOptions,
    private readonly metrics: Metrics = NOOP_METRICS,
  ) {}

  start(): void {
    this.loop ??= this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort.abort();
    await this.loop;
  }

  /** Recebe e processa um lote. Exposto para testes. */
  async pollOnce(): Promise<number> {
    const { queue } = await this.resolveUrls();
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue,
        MaxNumberOfMessages: this.options.batchSize,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        VisibilityTimeout: this.options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: [
          'ApproximateReceiveCount',
          'MessageGroupId',
        ],
        MessageAttributeNames: ['All'],
      }),
      { abortSignal: this.abort.signal },
    );

    const blockedGroups = new Set<string>();
    for (const [index, message] of Messages.entries()) {
      if (this.stopping) {
        await this.release(Messages.slice(index));
        break;
      }
      const group = message.Attributes?.MessageGroupId;
      if (group && blockedGroups.has(group)) {
        await this.release([message]);
        continue;
      }
      const returned = await this.process(message);
      if (returned && group) {
        blockedGroups.add(group);
      }
    }
    return Messages.length;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopping) {
          break;
        }
        this.logger.error(
          { consumer: 'wager-transactions', error: (error as Error).name },
          (error as Error).stack,
        );
        await Bun.sleep(RECEIVE_ERROR_PAUSE_MS);
      }
    }
  }

  /**
   * Processa uma mensagem (com contexto de log próprio e span de
   * consumidor); `true` se voltou para a fila. O span continua o trace do
   * produtor quando a mensagem traz o atributo `traceparent`.
   */
  private process(message: Message): Promise<boolean> {
    return RequestContext.run({ messageId: message.MessageId }, () =>
      withSpan(
        `${this.options.queueName} process`,
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            'wagering.layer': 'messaging',
            'messaging.system': 'aws_sqs',
            'messaging.operation.type': 'process',
            'messaging.destination.name': this.options.queueName,
            'messaging.message.id': message.MessageId ?? '',
            'messaging.aws_sqs.receive_count': Number(
              message.Attributes?.ApproximateReceiveCount ?? 1,
            ),
          },
        },
        (span) => this.processInContext(message, span),
        contextFromTraceparent(
          message.MessageAttributes?.traceparent?.StringValue,
        ),
      ),
    );
  }

  private async processInContext(
    message: Message,
    span: Span,
  ): Promise<boolean> {
    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? 1,
    );
    const startedAt = performance.now();
    const disposition = await this.handler.handle(message.Body ?? '');
    RequestContext.set({
      messageId: disposition.context.messageId,
      correlationId: disposition.context.correlationId,
      providerId: disposition.context.providerId,
      walletId: disposition.context.walletId,
      transactionId: disposition.context.transactionId,
    });
    for (const [key, value] of Object.entries(RequestContext.get())) {
      if (value !== undefined) {
        span.setAttribute(`wagering.${key}`, value);
      }
    }
    span.setAttribute('wagering.disposition', disposition.action);
    if (disposition.action !== 'ack') {
      // Só o nome do erro: a mensagem pode carregar dados do payload.
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: disposition.reason.split(':', 1)[0],
      });
    }
    this.metrics.processingDuration(
      'sqs',
      (performance.now() - startedAt) / 1000,
    );
    this.log(message, receiveCount, disposition);

    switch (disposition.action) {
      case 'ack':
        this.recordAck(disposition);
        await this.delete(message);
        return false;
      case 'dead-letter':
        this.metrics.messageDeadLettered('permanent');
        await this.deadLetter(message, disposition.reason, receiveCount);
        return false;
      case 'retry':
        this.metrics.messageRetried('sqs');
        if (CONCURRENCY_CONFLICTS.has(disposition.reason)) {
          this.metrics.concurrencyConflict(disposition.reason);
        }
        if (receiveCount >= this.options.maxAttempts) {
          this.metrics.messageDeadLettered('exhausted');
          await this.deadLetter(
            message,
            `tentativas esgotadas (${receiveCount}): ${disposition.reason}`,
            receiveCount,
          );
          return false;
        }
        await this.retryLater(message, receiveCount);
        return true;
    }
  }

  private recordAck(
    disposition: Extract<MessageDisposition, { action: 'ack' }>,
  ): void {
    const { kind, status } = disposition.context;
    switch (disposition.outcome) {
      case 'duplicate':
        this.metrics.duplicateDetected('inbox_duplicate');
        break;
      case 'replay':
        this.metrics.duplicateDetected('idempotent_replay');
        break;
      case 'business-error':
        break;
      default:
        this.metrics.transactionSettled({
          channel: 'sqs',
          kind: kind ?? 'unknown',
          status: status ?? 'unknown',
        });
    }
  }

  private async delete(message: Message): Promise<void> {
    const { queue } = await this.resolveUrls();
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queue,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async retryLater(
    message: Message,
    receiveCount: number,
  ): Promise<void> {
    const { queue } = await this.resolveUrls();
    const delay = Math.min(
      this.options.baseBackoffSeconds * 2 ** (receiveCount - 1),
      this.options.maxBackoffSeconds,
    );
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queue,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: delay,
      }),
    );
  }

  /**
   * Copia para a DLQ (com o motivo) e só depois remove da fila de entrada. Se
   * o processo cair entre os dois passos, sobra no máximo uma cópia extra na
   * DLQ, mas a mensagem nunca se perde.
   */
  private async deadLetter(
    message: Message,
    reason: string,
    receiveCount: number,
  ): Promise<void> {
    const { dlq } = await this.resolveUrls();
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: dlq,
        MessageBody: message.Body ?? '',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'dead-letter',
        MessageDeduplicationId: message.MessageId,
        MessageAttributes: {
          failureReason: {
            DataType: 'String',
            StringValue: reason.slice(0, 1024),
          },
          sourceMessageId: {
            DataType: 'String',
            StringValue: message.MessageId ?? 'desconhecido',
          },
          receiveCount: {
            DataType: 'Number',
            StringValue: String(receiveCount),
          },
        },
      }),
    );
    await this.delete(message);
  }

  /** Devolve mensagens não processadas à fila imediatamente. */
  private async release(messages: Message[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const { queue } = await this.resolveUrls();
    await this.sqs.send(
      new ChangeMessageVisibilityBatchCommand({
        QueueUrl: queue,
        Entries: messages.map((m, i) => ({
          Id: String(i),
          ReceiptHandle: m.ReceiptHandle,
          VisibilityTimeout: 0,
        })),
      }),
    );
  }

  private log(
    message: Message,
    receiveCount: number,
    disposition: MessageDisposition,
  ): void {
    const { context, ...decision } = disposition;
    const entry = {
      event: 'sqs_message',
      consumer: 'wager-transactions',
      sqsMessageId: message.MessageId,
      receiveCount,
      kind: context.kind,
      status: context.status,
      ...decision,
    };
    if (disposition.action === 'ack') {
      this.logger.log(entry);
    } else {
      this.logger.warn(entry);
    }
  }

  private resolveUrls(): Promise<{ queue: string; dlq: string }> {
    const url = (name: string) =>
      this.sqs
        .send(new GetQueueUrlCommand({ QueueName: name }))
        .then(({ QueueUrl }) => QueueUrl!);
    this.urls ??= Promise.all([
      url(this.options.queueName),
      url(this.options.dlqName),
    ])
      .then(([queue, dlq]) => ({ queue, dlq }))
      .catch((error: unknown) => {
        this.urls = undefined;
        throw error;
      });
    return this.urls;
  }
}

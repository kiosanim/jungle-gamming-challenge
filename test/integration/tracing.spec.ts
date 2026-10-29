import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { SpanKind } from '@opentelemetry/api';
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { HandleWagerMessageUseCase } from '../../src/application/handle-wager-message.use-case';
import { PublishOutboxUseCase } from '../../src/application/publish-outbox.use-case';
import { ResolvePendingReferencesUseCase } from '../../src/application/resolve-pending-references.use-case';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import {
  DEFAULT_CONSUMER_OPTIONS,
  SqsWagerTransactionConsumer,
} from '../../src/infrastructure/messaging/sqs-wager-transaction-consumer';
import {
  OpenTelemetryTracer,
  shutdownTracing,
  startTracing,
} from '../../src/infrastructure/observability/tracing';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../../src/infrastructure/system-clock';
import { UuidV7Generator } from '../../src/infrastructure/uuid-v7-generator';
import { FakeClock } from '../support/clock';
import { waitFor } from '../support/app-instance';
import { initTestOrm, sql } from '../support/database';
import {
  createSqsClient,
  createTestQueue,
  deleteTestQueues,
  drainQueue,
} from '../support/sqs';

/**
 * OpenTelemetry ligado com um exporter em memória (no lugar do OTLP), sobre
 * PostgreSQL e SQS reais. O trace atravessa o HTTP, o banco, a outbox, o SQS
 * e o consumidor.
 */

const exporter = new InMemorySpanExporter();
let orm: MikroORM;
let app: INestApplication;
let sqs: SQSClient;

beforeAll(async () => {
  startTracing({
    serviceName: 'wagering-test',
    force: true,
    spanProcessor: new SimpleSpanProcessor(exporter),
  });
  orm = await initTestOrm();
  sqs = createSqsClient();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MikroORM)
    .useValue(orm)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
});

afterAll(async () => {
  await app?.close(); // também desliga o tracing (TracingShutdown)
  await shutdownTracing();
  if (sqs) {
    await deleteTestQueues(sqs);
  }
  sqs?.destroy();
});

beforeEach(() => exporter.reset());

const newTraceId = () => randomUUID().replace(/-/g, '');
const newSpanId = () => randomUUID().replace(/-/g, '').slice(0, 16);
const traceparent = (traceId: string, spanId = newSpanId()) =>
  `00-${traceId}-${spanId}-01`;

const byName = (traceId: string, name: string): ReadableSpan => {
  const span = spansOf(traceId).find((s) => s.name === name);
  if (!span) {
    throw new Error(`span ${name} não encontrado no trace ${traceId}`);
  }
  return span;
};

const spansOf = (traceId: string): ReadableSpan[] =>
  exporter
    .getFinishedSpans()
    .filter((span) => span.spanContext().traceId === traceId);

async function waitForSpan(
  traceId: string,
  predicate: (span: ReadableSpan) => boolean,
): Promise<ReadableSpan> {
  await waitFor(async () => spansOf(traceId).some(predicate), 5_000, 20);
  return spansOf(traceId).find(predicate)!;
}

function submitTraced(
  traceId: string,
  wallet: { walletId: string; playerId: string },
  fields: Record<string, unknown> & { externalTransactionId: string },
) {
  return request(app.getHttpServer())
    .post('/wagering/transactions')
    .set('traceparent', traceparent(traceId))
    .set('Idempotency-Key', `provider-a:${fields.externalTransactionId}`)
    .send({
      providerId: 'provider-a',
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-1',
      gameId: 'fortune-chimp',
      ...fields,
    });
}

async function openWalletTraced(traceId: string, parentSpanId?: string) {
  const playerId = `player-${randomUUID()}`;
  const response = await request(app.getHttpServer())
    .post('/wallets')
    .set('traceparent', traceparent(traceId, parentSpanId))
    .send({
      playerId,
      initialBalance: { amount: '100.00', currency: 'BRL' },
    })
    .expect(201);
  return { response, walletId: response.body.id as string, playerId };
}

describe('OpenTelemetry', () => {
  it('requisição HTTP continua o traceparent e gera spans de banco filhos', async () => {
    const traceId = newTraceId();
    const parentSpanId = newSpanId();
    const { response, playerId } = await openWalletTraced(
      traceId,
      parentSpanId,
    );
    expect(response.headers['x-trace-id']).toBe(traceId);

    const server = await waitForSpan(
      traceId,
      (s) => s.kind === SpanKind.SERVER,
    );
    expect(server.name).toBe('POST /wallets');
    expect(server.parentSpanContext?.spanId).toBe(parentSpanId);
    expect(server.attributes['http.route']).toBe('/wallets');
    expect(server.attributes['http.response.status_code']).toBe(201);
    expect(server.attributes['wagering.correlationId']).toBeString();

    const names = spansOf(traceId).map((s) => s.name);
    expect(names).toContain('db.transaction');
    expect(names).toContain('insert wallet');
    expect(names).toContain('insert wallet_ledger_entry');
    expect(names).toContain('insert outbox_message');

    // SQL sem valores: só placeholders
    for (const span of spansOf(traceId).filter((s) =>
      s.name.startsWith('insert'),
    )) {
      const text = String(span.attributes['db.query.text']);
      expect(text).toContain('?');
      expect(text).not.toContain(playerId);
    }
  });

  it('o evento da outbox guarda o trace da requisição e o publisher o propaga ao SQS', async () => {
    const traceId = newTraceId();
    const { walletId } = await openWalletTraced(traceId);
    const [row] = await sql(
      orm,
      'select trace_context from outbox_message where aggregate_id = ?',
      [walletId],
    );
    expect(row.trace_context).toStartWith(`00-${traceId}-`);

    const queue = await createTestQueue(sqs, 'tracing-events');
    const publish = new PublishOutboxUseCase(
      new MikroOrmUnitOfWork(orm),
      new SqsEventPublisher(sqs, queue.name),
      new SystemClock(),
      new OpenTelemetryTracer(),
    );
    while ((await publish.runOnce()).claimed > 0) {
      // drena a outbox deste arquivo de teste
    }

    const producer = exporter
      .getFinishedSpans()
      .find(
        (s) =>
          s.kind === SpanKind.PRODUCER &&
          s.links.some((link) => link.context.traceId === traceId),
      );
    expect(producer?.name).toBe(`${queue.name} publish`);
    // o span de produtor fica dentro do span da camada de aplicação
    const batch = exporter
      .getFinishedSpans()
      .find(
        (s) => s.spanContext().spanId === producer?.parentSpanContext?.spanId,
      );
    expect(batch?.name).toBe('PublishOutboxUseCase.publish');
    expect(batch?.attributes['wagering.layer']).toBe('application');

    const message = (await drainQueue(sqs, queue.url)).find(
      (m) => m.Attributes?.MessageGroupId === walletId,
    );
    expect(message?.MessageAttributes?.traceparent?.StringValue).toStartWith(
      `00-${traceId}-`,
    );
  });

  it('o consumidor SQS continua o trace recebido no atributo traceparent', async () => {
    const opened = await openWalletTraced(newTraceId());
    const queue = await createTestQueue(sqs, 'tracing-in');
    const dlq = await createTestQueue(sqs, 'tracing-dlq');
    // O use case vem do módulo, como em produção, já com o span da camada.
    const consumer = new SqsWagerTransactionConsumer(
      sqs,
      app.get(HandleWagerMessageUseCase),
      {
        ...DEFAULT_CONSUMER_OPTIONS,
        queueName: queue.name,
        dlqName: dlq.name,
        waitTimeSeconds: 1,
      },
    );

    const traceId = newTraceId();
    const externalTransactionId = `tx-${randomUUID()}`;
    const { QueueUrl } = await sqs.send(
      new GetQueueUrlCommand({ QueueName: queue.name }),
    );
    await sqs.send(
      new SendMessageCommand({
        QueueUrl,
        MessageGroupId: opened.walletId,
        MessageDeduplicationId: randomUUID(),
        MessageAttributes: {
          traceparent: {
            DataType: 'String',
            StringValue: traceparent(traceId),
          },
        },
        MessageBody: JSON.stringify({
          messageId: `msg-${randomUUID()}`,
          type: 'WagerTransactionRequested',
          occurredAt: new Date().toISOString(),
          data: {
            providerId: 'provider-a',
            externalTransactionId,
            idempotencyKey: `provider-a:${externalTransactionId}`,
            playerId: opened.playerId,
            walletId: opened.walletId,
            roundId: 'round-1',
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
          },
        }),
      }),
    );
    expect(await consumer.pollOnce()).toBe(1);

    const span = await waitForSpan(
      traceId,
      (s) => s.kind === SpanKind.CONSUMER,
    );
    expect(span.name).toBe(`${queue.name} process`);
    expect(span.attributes['wagering.disposition']).toBe('ack');
    expect(span.attributes['wagering.walletId']).toBe(opened.walletId);
    expect(spansOf(traceId).map((s) => s.name)).toContain(
      'insert wager_transaction',
    );

    // camadas: mensagem → use case da mensagem → submissão → domínio
    const handle = byName(traceId, 'HandleWagerMessageUseCase.handle');
    expect(handle.parentSpanContext?.spanId).toBe(span.spanContext().spanId);
    expect(handle.attributes['wagering.disposition']).toBe('ack');
    const submit = byName(traceId, 'SubmitWagerTransactionUseCase.execute');
    expect(submit.parentSpanContext?.spanId).toBe(handle.spanContext().spanId);
    expect(byName(traceId, 'WagerSettlement.decide').attributes).toMatchObject({
      'wagering.layer': 'domain',
      'wagering.status': 'PROCESSED',
    });
  });

  it('uma aposta via HTTP mostra cada camada: HTTP, use case, transação, domínio e persistência', async () => {
    const opened = await openWalletTraced(newTraceId());
    const traceId = newTraceId();
    const externalTransactionId = `tx-${randomUUID()}`;
    await request(app.getHttpServer())
      .post('/wagering/transactions')
      .set('traceparent', traceparent(traceId))
      .set('Idempotency-Key', `provider-a:${externalTransactionId}`)
      .send({
        providerId: 'provider-a',
        externalTransactionId,
        playerId: opened.playerId,
        walletId: opened.walletId,
        roundId: 'round-1',
        gameId: 'fortune-chimp',
        kind: 'BET',
        money: { amount: '500.00', currency: 'BRL' },
      })
      .expect(422);

    const server = await waitForSpan(
      traceId,
      (s) => s.kind === SpanKind.SERVER,
    );
    const useCase = byName(traceId, 'SubmitWagerTransactionUseCase.execute');
    const transaction = byName(traceId, 'db.transaction');
    const decide = byName(traceId, 'WagerSettlement.decide');
    const persist = byName(traceId, 'WagerSettlement.persistEffects');

    // a hierarquia segue as camadas
    expect(useCase.parentSpanContext?.spanId).toBe(server.spanContext().spanId);
    expect(transaction.parentSpanContext?.spanId).toBe(
      useCase.spanContext().spanId,
    );
    expect(decide.parentSpanContext?.spanId).toBe(
      transaction.spanContext().spanId,
    );
    expect(persist.parentSpanContext?.spanId).toBe(
      transaction.spanContext().spanId,
    );

    // cada span diz a sua camada e o que aconteceu nela
    expect(server.attributes['wagering.layer']).toBe('http');
    expect(useCase.attributes).toMatchObject({
      'wagering.layer': 'application',
      'wagering.kind': 'BET',
      'wagering.status': 'REJECTED',
      'wagering.idempotentReplay': false,
    });
    expect(transaction.attributes['wagering.layer']).toBe('persistence');
    expect(decide.attributes).toMatchObject({
      'wagering.layer': 'domain',
      'wagering.status': 'REJECTED',
      'wagering.failureCode': 'INSUFFICIENT_FUNDS',
      'wagering.balanceChanged': false,
    });
    expect(persist.attributes).toMatchObject({
      'wagering.balanceChanged': false,
      'wagering.outboxEvents': 1,
    });
  });

  it('do traceId da API até o worker: a publicação de cada evento entra no mesmo trace, com o transactionId', async () => {
    const opened = await openWalletTraced(newTraceId());
    const traceId = newTraceId();
    const externalTransactionId = `tx-${randomUUID()}`;
    const { body } = await submitTraced(traceId, opened, {
      externalTransactionId,
      kind: 'BET',
      money: { amount: '10.00', currency: 'BRL' },
    }).expect(201);

    const queue = await createTestQueue(sqs, 'tracing-flow');
    const publish = new PublishOutboxUseCase(
      new MikroOrmUnitOfWork(orm),
      new SqsEventPublisher(sqs, queue.name),
      new SystemClock(),
      new OpenTelemetryTracer(),
    );
    while ((await publish.runOnce()).claimed > 0) {
      // drena a outbox
    }

    for (const eventType of [
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]) {
      const span = byName(traceId, `publish ${eventType}`);
      expect(span.kind).toBe(SpanKind.PRODUCER);
      expect(span.attributes).toMatchObject({
        'wagering.layer': 'messaging',
        'wagering.transactionId': body.transactionId,
        'wagering.walletId': opened.walletId,
        'wagering.published': true,
      });
      // e um link para o span do lote, que está em outro trace
      expect(span.links).toHaveLength(1);
    }

    // a mesma busca pelo transactionId acha a API e o worker
    const byTransaction = exporter
      .getFinishedSpans()
      .filter(
        (s) => s.attributes['wagering.transactionId'] === body.transactionId,
      )
      .map((s) => s.name);
    expect(byTransaction).toContain('POST /wagering/transactions');
    expect(byTransaction).toContain('publish WalletBalanceChanged');
  });

  it('a resolução de PENDING_REFERENCE pelo worker continua o trace da requisição original', async () => {
    const opened = await openWalletTraced(newTraceId());
    const refundTrace = newTraceId();
    const betId = `tx-${randomUUID()}`;
    const { body: refund } = await submitTraced(refundTrace, opened, {
      externalTransactionId: `tx-${randomUUID()}`,
      kind: 'REFUND',
      money: { amount: '5.00', currency: 'BRL' },
      referenceExternalTransactionId: betId,
    }).expect(202);

    const [row] = await sql(
      orm,
      'select trace_context from wager_transaction where id = ?',
      [refund.transactionId],
    );
    expect(row.trace_context).toStartWith(`00-${refundTrace}-`);

    // a BET chega depois, por outra requisição
    await submitTraced(newTraceId(), opened, {
      externalTransactionId: betId,
      kind: 'BET',
      money: { amount: '5.00', currency: 'BRL' },
    }).expect(201);

    const resolver = new ResolvePendingReferencesUseCase(
      new MikroOrmUnitOfWork(orm),
      new UuidV7Generator(),
      new FakeClock(new Date(Date.now() + 5_000)),
      new OpenTelemetryTracer(),
    );
    await resolver.runOnce();

    const resolve = byName(
      refundTrace,
      'ResolvePendingReferencesUseCase.resolve',
    );
    expect(resolve.attributes).toMatchObject({
      'wagering.layer': 'application',
      'wagering.transactionId': refund.transactionId,
      'wagering.outcome': 'processed',
    });
    // o mesmo trace mostra as duas decisões: a da requisição, que deixou a
    // transação pendente, e a do worker, que a processou
    const decisions = spansOf(refundTrace)
      .filter((s) => s.name === 'WagerSettlement.decide')
      .sort(
        (a, b) =>
          a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1],
      )
      .map((s) => s.attributes['wagering.status']);
    expect(decisions).toEqual(['PENDING_REFERENCE', 'PROCESSED']);
  });

  it('health e métricas não são rastreados', async () => {
    const traceId = newTraceId();
    for (const path of ['/health/live', '/health/ready', '/metrics']) {
      const response = await request(app.getHttpServer())
        .get(path)
        .set('traceparent', traceparent(traceId));
      expect(response.headers['x-trace-id']).toBeUndefined();
    }
    expect(spansOf(traceId)).toEqual([]);
  });

  it('um ciclo de publicação sem mensagens não gera spans', async () => {
    const publish = new PublishOutboxUseCase(
      new MikroOrmUnitOfWork(orm),
      new SqsEventPublisher(sqs, 'fila-que-nao-sera-usada.fifo'),
      new SystemClock(),
      new OpenTelemetryTracer(),
    );
    while ((await publish.runOnce()).claimed > 0) {
      // esvazia o que outros testes deixaram
    }
    exporter.reset();
    expect((await publish.runOnce()).claimed).toBe(0);
    expect(exporter.getFinishedSpans()).toEqual([]);
  });

  it('sem trace ativo, o banco não gera spans', async () => {
    await new MikroOrmUnitOfWork(orm).run((ctx) =>
      ctx.outbox.claimDue(new Date(0), 1),
    );
    expect(exporter.getFinishedSpans()).toEqual([]);
  });
});

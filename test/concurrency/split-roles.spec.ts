import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { ensureQueues } from '../../src/infrastructure/messaging/queues';
import { AppInstance, type AppRole, waitFor } from '../support/app-instance';
import { initTestOrm, sql, testDatabaseName } from '../support/database';
import { expectLedgerConsistent } from '../support/ledger';
import { createSqsClient, deleteQueuesByName } from '../support/sqs';

/**
 * Papéis em processos separados, como nas imagens do Compose (`api`,
 * `consumer`, `workers`). Os papéis sobem um de cada vez para provar que
 * cada um faz só a sua parte: sem consumidor a fila não anda, sem workers a
 * outbox e as referências pendentes não andam.
 */

const suffix = randomUUID().slice(0, 8);
const QUEUES = {
  wagerTransactions: `sr-wager-${suffix}.fifo`,
  wagerTransactionsDlq: `sr-wager-dlq-${suffix}.fifo`,
  outbox: `sr-events-${suffix}.fifo`,
};

let orm: MikroORM;
let sqs: SQSClient;
let queueUrl: string;
const instances: AppInstance[] = [];
let nextPort = 3141;

async function startRole(role: AppRole): Promise<AppInstance> {
  const instance = new AppInstance(
    nextPort++,
    {
      DATABASE_NAME: testDatabaseName(),
      WAGER_TRANSACTIONS_QUEUE_NAME: QUEUES.wagerTransactions,
      WAGER_TRANSACTIONS_DLQ_NAME: QUEUES.wagerTransactionsDlq,
      OUTBOX_QUEUE_NAME: QUEUES.outbox,
      PENDING_REFERENCE_INTERVAL_MS: '200',
      OUTBOX_PUBLISH_INTERVAL_MS: '100',
      LOG_LEVEL: 'error',
    },
    role,
  );
  instances.push(instance);
  await instance.start();
  return instance;
}

beforeAll(async () => {
  orm = await initTestOrm();
  sqs = createSqsClient();
  await ensureQueues(sqs, QUEUES);
  queueUrl = (
    await sqs.send(
      new GetQueueUrlCommand({ QueueName: QUEUES.wagerTransactions }),
    )
  ).QueueUrl!;
}, 30_000);

afterAll(async () => {
  await Promise.all(instances.map((i) => i.stop()));
  if (sqs) {
    await deleteQueuesByName(sqs, Object.values(QUEUES));
  }
  sqs?.destroy();
  await orm?.close(true);
}, 30_000);

const brl = (amount: string) => ({ amount, currency: 'BRL' });

async function count(query: string, params: unknown[] = []): Promise<number> {
  const [row] = await sql(orm, query, params);
  return Number(row.n);
}

const balanceOf = async (walletId: string) =>
  (
    await sql(orm, 'select balance::text as b from wallet where id = ?', [
      walletId,
    ])
  )[0].b as string;

function operation(
  wallet: { walletId: string; playerId: string },
  kind: string,
  amount: string,
  extra: Record<string, unknown> = {},
) {
  const externalTransactionId = `tx-${randomUUID()}`;
  return {
    providerId: 'provider-a',
    externalTransactionId,
    idempotencyKey: `provider-a:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    ...extra,
  };
}

async function submitSqs(op: ReturnType<typeof operation>): Promise<string> {
  const messageId = `msg-${randomUUID()}`;
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageGroupId: op.walletId,
      MessageDeduplicationId: randomUUID(),
      MessageBody: JSON.stringify({
        messageId,
        type: 'WagerTransactionRequested',
        occurredAt: new Date().toISOString(),
        data: op,
      }),
    }),
  );
  return messageId;
}

const inboxProcessed = (messageId: string) =>
  count(
    "select count(*) n from inbox_message where consumer_name = 'wager-transactions' and message_id = ? and processed_at is not null",
    [messageId],
  );

const pendingOutbox = (walletId: string) =>
  count(
    'select count(*) n from outbox_message where aggregate_id = ? and published_at is null',
    [walletId],
  );

describe('papéis em processos separados (api, consumer, workers)', () => {
  it('cada papel faz só a sua parte; juntos processam tudo', async () => {
    const api = await startRole('api');

    const playerId = `player-${randomUUID()}`;
    const opened = await fetch(`${api.url}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: brl('100.00') }),
    });
    expect(opened.status).toBe(201);
    const wallet = {
      walletId: ((await opened.json()) as { id: string }).id,
      playerId,
    };

    // só a API no ar: a mensagem fica na fila
    const sqsBet = operation(wallet, 'BET', '10.00');
    const messageId = await submitSqs(sqsBet);
    await Bun.sleep(1_500);
    expect(await inboxProcessed(messageId)).toBe(0);

    // o consumidor processa a fila, mas não expõe as rotas de negócio
    const consumer = await startRole('consumer');
    await waitFor(async () => (await inboxProcessed(messageId)) === 1, 15_000);
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
    const notOnConsumer = await fetch(`${consumer.url}/wallets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, initialBalance: brl('1.00') }),
    });
    expect(notOnConsumer.status).toBe(404);

    // REFUND antes da BET: fica pendente e a outbox acumula sem os workers
    const lateBet = operation(wallet, 'BET', '5.00');
    const refundId = await submitSqs(
      operation(wallet, 'REFUND', '5.00', {
        referenceExternalTransactionId: lateBet.externalTransactionId,
      }),
    );
    await waitFor(async () => (await inboxProcessed(refundId)) === 1, 15_000);
    const placed = await fetch(`${api.url}/wagering/transactions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': lateBet.idempotencyKey,
      },
      body: JSON.stringify(lateBet),
    });
    expect(placed.status).toBe(201);
    await Bun.sleep(1_000);
    expect(
      await count(
        "select count(*) n from wager_transaction where wallet_id = ? and status = 'PENDING_REFERENCE'",
        [wallet.walletId],
      ),
    ).toBe(1);
    expect(await pendingOutbox(wallet.walletId)).toBeGreaterThan(0);

    // workers: resolvem a referência pendente e drenam a outbox
    const workers = await startRole('workers');
    await waitFor(
      async () =>
        (await count(
          "select count(*) n from wager_transaction where wallet_id = ? and status = 'PENDING_REFERENCE'",
          [wallet.walletId],
        )) === 0,
      15_000,
    );
    await waitFor(
      async () => (await pendingOutbox(wallet.walletId)) === 0,
      15_000,
    );
    // 100 − 10 − 5 + 5
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
    await expectLedgerConsistent(orm, wallet.walletId);

    // todos os papéis expõem health e métricas
    for (const instance of [api, consumer, workers]) {
      expect((await fetch(`${instance.url}/health/ready`)).status).toBe(200);
      expect((await fetch(`${instance.url}/metrics`)).status).toBe(200);
    }
    expect(
      (await fetch(`${workers.url}/wallets/${wallet.walletId}`)).status,
    ).toBe(404);
  }, 90_000);

  it('todos os papéis encerram graciosamente no SIGTERM', async () => {
    const codes = await Promise.all(instances.splice(0).map((i) => i.stop()));
    expect(codes.every((code) => code === 0 || code === 143)).toBe(true);
  }, 30_000);
});

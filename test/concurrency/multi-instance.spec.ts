import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  GetQueueUrlCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { ensureQueues } from '../../src/infrastructure/messaging/queues';
import { AppInstance, waitFor } from '../support/app-instance';
import { initTestOrm, sql, testDatabaseName } from '../support/database';
import { expectLedgerConsistent } from '../support/ledger';
import { createSqsClient, deleteQueuesByName } from '../support/sqs';

/**
 * Três ou mais processos reais da aplicação disputando as mesmas wallets por
 * HTTP e SQS, com consumidores, publishers da outbox e workers concorrentes.
 * No meio da carga, uma instância morre de forma abrupta (SIGKILL) e outra
 * sobe no lugar.
 */

const suffix = randomUUID().slice(0, 8);
const QUEUES = {
  wagerTransactions: `mi-wager-${suffix}.fifo`,
  wagerTransactionsDlq: `mi-wager-dlq-${suffix}.fifo`,
  outbox: `mi-events-${suffix}.fifo`,
};

let orm: MikroORM;
let sqs: SQSClient;
let queueUrl: string;
let instances: AppInstance[];
let nextPort = 3101;

const instanceEnv = () => ({
  DATABASE_NAME: testDatabaseName(),
  WAGER_TRANSACTIONS_QUEUE_NAME: QUEUES.wagerTransactions,
  WAGER_TRANSACTIONS_DLQ_NAME: QUEUES.wagerTransactionsDlq,
  OUTBOX_QUEUE_NAME: QUEUES.outbox,
  SQS_CONSUMER_CONCURRENCY: '2',
  // mensagens em processamento na instância morta voltam em 5s
  SQS_CONSUMER_VISIBILITY_TIMEOUT_SECONDS: '5',
  PENDING_REFERENCE_INTERVAL_MS: '200',
  OUTBOX_PUBLISH_INTERVAL_MS: '100',
  LOG_LEVEL: 'error',
});

async function startInstance(): Promise<AppInstance> {
  const instance = new AppInstance(nextPort++, instanceEnv());
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
  instances = await Promise.all([1, 2, 3].map(() => startInstance()));
}, 60_000);

afterAll(async () => {
  await Promise.all((instances ?? []).map((i) => i.stop()));
  if (sqs) {
    await deleteQueuesByName(sqs, Object.values(QUEUES));
  }
  sqs?.destroy();
  await orm?.close(true);
}, 30_000);

const brl = (amount: string) => ({ amount, currency: 'BRL' });
/** Distribui as requisições entre as instâncias vivas. */
let rr = 0;
const anyInstance = () => instances[rr++ % instances.length];

/**
 * Faz o que um provedor faria: se a instância cair (conexão recusada ou
 * abortada) ou responder 503, reenvia a mesma requisição, com a mesma
 * Idempotency-Key, para outra instância. A idempotência garante que o
 * reenvio não duplica o efeito.
 */
async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${anyInstance().url}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      if (response.status !== 503 || attempt >= 10) {
        return { status: response.status, body: await response.json() };
      }
    } catch (error) {
      if (attempt >= 10) {
        throw error;
      }
    }
    await Bun.sleep(100);
  }
}

async function newWallet(amount: string) {
  const playerId = `player-${randomUUID()}`;
  const { status, body } = await post('/wallets', {
    playerId,
    initialBalance: brl(amount),
  });
  expect(status).toBe(201);
  return { walletId: body.id as string, playerId };
}

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

const submitHttp = (op: ReturnType<typeof operation>) =>
  post('/wagering/transactions', op, { 'Idempotency-Key': op.idempotencyKey });

async function submitSqs(
  op: ReturnType<typeof operation>,
  messageId = `msg-${randomUUID()}`,
) {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageGroupId: op.walletId,
      MessageDeduplicationId: randomUUID(), // reentregas não escondidas pelo FIFO
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

describe('3 instâncias concorrentes (processos reais)', () => {
  it('cenário 100/80/80 com as apostas em instâncias diferentes', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 10 }, () => newWallet('100.00')),
    );
    const results = await Promise.all(
      wallets.map((wallet) =>
        Promise.all([
          submitHttp(operation(wallet, 'BET', '80.00')),
          submitHttp(operation(wallet, 'BET', '80.00')),
        ]),
      ),
    );

    for (const [i, pair] of results.entries()) {
      expect(pair.map((r) => r.status).sort()).toEqual([201, 422]);
      expect(await balanceOf(wallets[i].walletId)).toBe('20.00');
      expect(
        await count(
          "select count(*) n from wallet_ledger_entry where wallet_id = ? and direction = 'DEBIT'",
          [wallets[i].walletId],
        ),
      ).toBe(1);
      await expectLedgerConsistent(orm, wallets[i].walletId);
    }
  }, 30_000);

  it('a mesma aposta 50× em paralelo, espalhada pelas 3 instâncias → um débito', async () => {
    const wallet = await newWallet('100.00');
    const op = operation(wallet, 'BET', '10.00');
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => submitHttp(op)),
    );

    expect(new Set(responses.map((r) => r.body.transactionId)).size).toBe(1);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 200)).toHaveLength(49);
    expect(await balanceOf(wallet.walletId)).toBe('90.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  }, 30_000);

  it('HTTP + SQS + reentregas + referências fora de ordem, com SIGKILL e reinício no meio', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 6 }, () => newWallet('1000.00')),
    );
    const sentMessageIds = new Set<string>();
    let expectedBets = 0;
    let expectedRefunds = 0;

    const load = wallets.map(async (wallet) => {
      for (let i = 0; i < 10; i++) {
        // BET via HTTP
        await submitHttp(operation(wallet, 'BET', '2.00'));
        expectedBets++;

        // BET via SQS, entregue duas vezes (mesmo messageId)
        const sqsBet = operation(wallet, 'BET', '3.00');
        const messageId = await submitSqs(sqsBet);
        await submitSqs(sqsBet, messageId);
        sentMessageIds.add(messageId);
        expectedBets++;

        // REFUND antes da BET (fora de ordem), via SQS
        const lateBet = operation(wallet, 'BET', '5.00');
        sentMessageIds.add(
          await submitSqs(
            operation(wallet, 'REFUND', '5.00', {
              referenceExternalTransactionId: lateBet.externalTransactionId,
            }),
          ),
        );
        expectedRefunds++;
        await submitHttp(lateBet);
        expectedBets++;
      }
    });

    // no meio da carga, uma instância morre sem aviso e outra sobe no lugar
    await Bun.sleep(300);
    const victim = instances.shift()!;
    await victim.crash();
    instances.push(await startInstance());
    await Promise.all(load);

    // consistência final: toda mensagem processada exatamente uma vez
    await waitFor(
      async () =>
        (await count(
          "select count(*) n from inbox_message where consumer_name = 'wager-transactions' and processed_at is not null",
        )) >= sentMessageIds.size,
      30_000,
      200,
    );
    await waitFor(
      async () =>
        (await count(
          "select count(*) n from wager_transaction where status = 'PENDING_REFERENCE'",
        )) === 0,
      30_000,
      200,
    );

    const walletIds = wallets.map((w) => w.walletId);
    const inList = walletIds.map(() => '?').join(',');
    expect(
      await count(
        `select count(*) n from wager_transaction where kind = 'BET' and status = 'PROCESSED' and wallet_id in (${inList})`,
        walletIds,
      ),
    ).toBe(expectedBets);
    expect(
      await count(
        `select count(*) n from wager_transaction where kind = 'REFUND' and status = 'PROCESSED' and wallet_id in (${inList})`,
        walletIds,
      ),
    ).toBe(expectedRefunds);
    expect(
      await count(
        "select count(*) n from inbox_message where consumer_name = 'wager-transactions'",
      ),
    ).toBe(sentMessageIds.size);

    for (const wallet of wallets) {
      // 1000 − 10×(2 + 3 + 5) + 10×5 = 950
      expect(await balanceOf(wallet.walletId)).toBe('950.00');
      await expectLedgerConsistent(orm, wallet.walletId);
    }

    // a outbox é drenada pelos publishers concorrentes, nada fica para trás
    await waitFor(
      async () =>
        (await count(
          'select count(*) n from outbox_message where published_at is null',
        )) === 0,
      30_000,
      200,
    );
  }, 90_000);

  it('todas as instâncias encerram graciosamente no SIGTERM', async () => {
    const codes = await Promise.all(instances.map((i) => i.stop()));
    expect(codes.every((code) => code === 0 || code === 143)).toBe(true);
    instances = [];
  }, 30_000);
});

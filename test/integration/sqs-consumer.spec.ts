import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import {
  HandleWagerMessageUseCase,
  MessageDisposition,
} from '../../src/application/handle-wager-message.use-case';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import {
  TransactionalContext,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import { SubmitWagerTransactionUseCase } from '../../src/application/submit-wager-transaction.use-case';
import { Money } from '../../src/domain/money';
import {
  DEFAULT_CONSUMER_OPTIONS,
  SqsWagerTransactionConsumer,
  WagerConsumerOptions,
} from '../../src/infrastructure/messaging/sqs-wager-transaction-consumer';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../../src/infrastructure/system-clock';
import { UuidV7Generator } from '../../src/infrastructure/uuid-v7-generator';
import { initTestOrm, sql } from '../support/database';
import { expectLedgerConsistent } from '../support/ledger';
import {
  createSqsClient,
  createTestQueue,
  deleteTestQueues,
  drainQueue,
} from '../support/sqs';

/** Observa as decisões do handler real (não o substitui). */
class RecordingHandler extends HandleWagerMessageUseCase {
  readonly dispositions: MessageDisposition[] = [];

  override async handle(body: string): Promise<MessageDisposition> {
    const disposition = await super.handle(body);
    this.dispositions.push(disposition);
    return disposition;
  }
}

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let sqs: SQSClient;
let openWallet: OpenWalletUseCase;

beforeAll(async () => {
  orm = await initTestOrm();
  uow = new MikroOrmUnitOfWork(orm);
  sqs = createSqsClient();
  openWallet = new OpenWalletUseCase(
    uow,
    new UuidV7Generator(),
    new SystemClock(),
  );
});

afterAll(async () => {
  if (sqs) {
    await deleteTestQueues(sqs);
  }
  sqs?.destroy();
  await orm?.close(true);
});

const handlerFor = (unitOfWork: UnitOfWork = uow) =>
  new RecordingHandler(
    new SubmitWagerTransactionUseCase(
      unitOfWork,
      new UuidV7Generator(),
      new SystemClock(),
    ),
  );

/** Filas exclusivas do teste + consumidor com backoff curto. */
async function setup(
  handler: HandleWagerMessageUseCase,
  overrides: Partial<WagerConsumerOptions> = {},
) {
  const queue = await createTestQueue(sqs, 'wager-in');
  const dlq = await createTestQueue(sqs, 'wager-dlq');
  const consumer = new SqsWagerTransactionConsumer(sqs, handler, {
    ...DEFAULT_CONSUMER_OPTIONS,
    queueName: queue.name,
    dlqName: dlq.name,
    baseBackoffSeconds: 1,
    waitTimeSeconds: 1,
    ...overrides,
  });
  return { queue, dlq, consumer };
}

async function newWallet(amount: string) {
  const playerId = `player-${randomUUID()}`;
  const wallet = await openWallet.execute({
    playerId,
    initialBalance: Money.from({ amount, currency: 'BRL' }),
    correlationId: 'corr-test',
  });
  return { walletId: wallet.id, playerId };
}

function wagerMessage(
  wallet: { walletId: string; playerId: string },
  overrides: { messageId?: string; data?: Record<string, unknown> } = {},
) {
  const externalTransactionId = `tx-${randomUUID()}`;
  return {
    messageId: overrides.messageId ?? `msg-${randomUUID()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      ...overrides.data,
    },
  };
}

/**
 * Envia como um produtor faria. `MessageDeduplicationId` aleatório para que
 * o FIFO não esconda as reentregas que os testes querem provocar.
 */
async function send(
  queueUrl: string,
  body: unknown,
  groupId = 'wallet-group',
): Promise<void> {
  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

async function transactionsOf(walletId: string) {
  return sql(
    orm,
    `select kind, status, failure_code from wager_transaction
      where wallet_id = ? and kind <> 'OPENING'`,
    [walletId],
  );
}

async function balance(walletId: string): Promise<string> {
  const [row] = await sql(
    orm,
    'select balance::text as balance from wallet where id = ?',
    [walletId],
  );
  return row.balance;
}

describe('consumidor SQS de wager-transactions.fifo (PostgreSQL + SQS reais)', () => {
  it('processa a mensagem com o mesmo use case do HTTP, grava a inbox e faz ack', async () => {
    const handler = handlerFor();
    const { queue, consumer } = await setup(handler);
    const wallet = await newWallet('100.00');
    const message = wagerMessage(wallet);
    await send(queue.url, message);

    expect(await consumer.pollOnce()).toBe(1);

    expect(handler.dispositions).toHaveLength(1);
    expect(handler.dispositions[0]).toMatchObject({
      action: 'ack',
      outcome: 'processed',
      transactionId: expect.any(String),
      context: {
        messageId: message.messageId,
        walletId: wallet.walletId,
        providerId: 'provider-a',
        kind: 'BET',
        status: 'PROCESSED',
      },
    });
    expect(await balance(wallet.walletId)).toBe('75.00');
    const [inbox] = await sql(
      orm,
      'select consumer_name, processed_at from inbox_message where message_id = ?',
      [message.messageId],
    );
    expect(inbox.consumer_name).toBe('wager-transactions');
    expect(inbox.processed_at).not.toBeNull();

    const [event] = await sql(
      orm,
      `select payload->>'causationId' as causation from outbox_message
        where event_type = 'WagerTransactionProcessed' and aggregate_id = ?`,
      [wallet.walletId],
    );
    expect(event.causation).toBe(message.messageId);
    expect(await drainQueue(sqs, queue.url)).toHaveLength(0); // ack feito
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('redelivery da mesma mensagem → detectada pela inbox, um único débito', async () => {
    const handler = handlerFor();
    const { queue, consumer } = await setup(handler);
    const wallet = await newWallet('100.00');
    const message = wagerMessage(wallet);
    await send(queue.url, message);
    await send(queue.url, message);

    while ((await consumer.pollOnce()) > 0) {
      // drena
    }

    expect(
      handler.dispositions.map((d) => (d as { outcome: string }).outcome),
    ).toEqual(['processed', 'duplicate']);
    expect(await transactionsOf(wallet.walletId)).toHaveLength(1);
    expect(await balance(wallet.walletId)).toBe('75.00');
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('outra mensagem com a mesma Idempotency-Key → replay, sem novo débito', async () => {
    const handler = handlerFor();
    const { queue, consumer } = await setup(handler);
    const wallet = await newWallet('100.00');
    const first = wagerMessage(wallet);
    await send(queue.url, first);
    await send(queue.url, { ...first, messageId: `msg-${randomUUID()}` });

    while ((await consumer.pollOnce()) > 0) {
      // drena
    }

    expect(
      handler.dispositions.map((d) => (d as { outcome: string }).outcome),
    ).toEqual(['processed', 'replay']);
    expect(await balance(wallet.walletId)).toBe('75.00');
  });

  it('rejeição de negócio → ack (terminal), transação REJECTED', async () => {
    const handler = handlerFor();
    const { queue, dlq, consumer } = await setup(handler);
    const wallet = await newWallet('10.00');
    await send(
      queue.url,
      wagerMessage(wallet, {
        data: { money: { amount: '50.00', currency: 'BRL' } },
      }),
    );

    await consumer.pollOnce();

    expect(handler.dispositions[0]).toMatchObject({
      action: 'ack',
      outcome: 'rejected',
      code: 'INSUFFICIENT_FUNDS',
    });
    expect(await drainQueue(sqs, queue.url)).toHaveLength(0);
    expect(await drainQueue(sqs, dlq.url)).toHaveLength(0);
  });

  it('wallet inexistente → ack como erro de negócio (não vai para a DLQ)', async () => {
    const handler = handlerFor();
    const { queue, dlq, consumer } = await setup(handler);
    await send(
      queue.url,
      wagerMessage({ walletId: randomUUID(), playerId: 'p' }),
    );

    await consumer.pollOnce();

    expect(handler.dispositions[0]).toMatchObject({
      action: 'ack',
      outcome: 'business-error',
      code: 'WALLET_NOT_FOUND',
    });
    expect(await drainQueue(sqs, dlq.url)).toHaveLength(0);
  });

  it.each([
    ['JSON inválido', '{nao-e-json'],
    ['type desconhecido', { messageId: 'm', type: 'Outro', data: {} }],
    ['sem messageId', { type: 'WagerTransactionRequested', data: {} }],
    [
      'kind OPENING',
      {
        messageId: 'm',
        type: 'WagerTransactionRequested',
        data: { kind: 'OPENING' },
      },
    ],
  ])(
    'mensagem permanente (%s) → DLQ com o motivo, removida da fila',
    async (_, body) => {
      const handler = handlerFor();
      const { queue, dlq, consumer } = await setup(handler);
      await send(queue.url, body);

      await consumer.pollOnce();

      expect(handler.dispositions[0].action).toBe('dead-letter');
      expect(await drainQueue(sqs, queue.url)).toHaveLength(0);
      const [deadLetter] = await drainQueue(sqs, dlq.url);
      expect(deadLetter.Body).toBe(
        typeof body === 'string' ? body : JSON.stringify(body),
      );
      expect(
        deadLetter.MessageAttributes?.failureReason?.StringValue,
      ).toContain('InvalidPayloadError');
    },
  );

  it('falha transitória → retry com backoff e sucesso na reentrega', async () => {
    let failuresLeft = 1;
    const flaky: UnitOfWork = {
      run: <T>(work: (ctx: TransactionalContext) => Promise<T>) => {
        if (failuresLeft-- > 0) {
          return Promise.reject(new Error('PostgreSQL indisponível'));
        }
        return uow.run(work);
      },
    };
    const handler = handlerFor(flaky);
    const { queue, consumer } = await setup(handler);
    const wallet = await newWallet('100.00');
    await send(queue.url, wagerMessage(wallet));

    await consumer.pollOnce();
    expect(handler.dispositions[0].action).toBe('retry');
    expect(await consumer.pollOnce()).toBe(0); // invisível durante o backoff

    await Bun.sleep(1_200);
    await consumer.pollOnce();
    expect(handler.dispositions[1]).toMatchObject({
      action: 'ack',
      outcome: 'processed',
    });
    expect(await balance(wallet.walletId)).toBe('75.00');
  });

  it('falha transitória persistente → DLQ após o limite de tentativas', async () => {
    const down: UnitOfWork = {
      run: () => Promise.reject(new Error('PostgreSQL indisponível')),
    };
    const handler = handlerFor(down);
    const { queue, dlq, consumer } = await setup(handler, { maxAttempts: 2 });
    const wallet = await newWallet('100.00');
    await send(queue.url, wagerMessage(wallet));

    await consumer.pollOnce(); // 1ª entrega: retry
    await Bun.sleep(1_200);
    await consumer.pollOnce(); // 2ª entrega: tentativas esgotadas, vai para a DLQ

    expect(handler.dispositions.map((d) => d.action)).toEqual([
      'retry',
      'retry',
    ]);
    expect(await drainQueue(sqs, queue.url)).toHaveLength(0);
    const [deadLetter] = await drainQueue(sqs, dlq.url);
    expect(deadLetter.MessageAttributes?.failureReason?.StringValue).toContain(
      'tentativas esgotadas (2)',
    );
    expect(await transactionsOf(wallet.walletId)).toHaveLength(0);
  });

  it('worker morto depois do commit e antes do ack → reentrega não duplica o efeito', async () => {
    const handler = handlerFor();
    const { queue, consumer } = await setup(handler);
    const wallet = await newWallet('100.00');
    await send(queue.url, wagerMessage(wallet));

    // Um worker recebe, processa (commit) e morre antes do DeleteMessage.
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queue.url,
        VisibilityTimeout: 1,
        WaitTimeSeconds: 1,
      }),
    );
    expect(Messages).toHaveLength(1);
    await handler.handle(Messages[0].Body!);
    expect(await balance(wallet.walletId)).toBe('75.00');

    // A visibilidade expira e outra instância recebe a mesma mensagem.
    await Bun.sleep(1_200);
    expect(await consumer.pollOnce()).toBe(1);

    expect(handler.dispositions.at(-1)).toMatchObject({
      action: 'ack',
      outcome: 'duplicate',
    });
    expect(await transactionsOf(wallet.walletId)).toHaveLength(1);
    expect(await balance(wallet.walletId)).toBe('75.00');
    expect(await drainQueue(sqs, queue.url)).toHaveLength(0);
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('SIGTERM: conclui a mensagem em andamento e devolve a visibilidade das demais', async () => {
    let signalStarted!: () => void;
    const started = new Promise<void>((r) => (signalStarted = r));
    class SlowHandler extends RecordingHandler {
      override async handle(body: string): Promise<MessageDisposition> {
        signalStarted();
        await Bun.sleep(300);
        return super.handle(body);
      }
    }
    const handler = new SlowHandler(
      new SubmitWagerTransactionUseCase(
        uow,
        new UuidV7Generator(),
        new SystemClock(),
      ),
    );
    const { queue, consumer } = await setup(handler, {
      visibilityTimeoutSeconds: 60,
    });
    const wallets = await Promise.all([1, 2, 3].map(() => newWallet('100.00')));
    for (const wallet of wallets) {
      await send(queue.url, wagerMessage(wallet), wallet.walletId);
    }

    consumer.start();
    await started;
    await consumer.stop();

    // exatamente uma mensagem foi concluída (e confirmada) antes de parar
    expect(handler.dispositions).toHaveLength(1);
    expect(handler.dispositions[0]).toMatchObject({ action: 'ack' });
    const processed = await sql(
      orm,
      `select count(*)::int as n from wager_transaction
        where kind = 'BET' and wallet_id in (?, ?, ?)`,
      wallets.map((w) => w.walletId),
    );
    expect(processed[0].n).toBe(1);

    // as demais voltaram imediatamente para a fila (sem esperar 60s)
    expect(await drainQueue(sqs, queue.url)).toHaveLength(2);
  });
});

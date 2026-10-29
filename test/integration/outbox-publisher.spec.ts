import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { OpenWalletUseCase } from '../../src/application/open-wallet.use-case';
import {
  EventPublisher,
  PublishResult,
} from '../../src/application/ports/event-publisher';
import {
  TransactionalContext,
  UnitOfWork,
} from '../../src/application/ports/unit-of-work';
import { PublishOutboxUseCase } from '../../src/application/publish-outbox.use-case';
import { Money } from '../../src/domain/money';
import { OUTBOX_RETRY_BASE_DELAY_MS } from '../../src/domain/outbox-message';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { SystemClock } from '../../src/infrastructure/system-clock';
import { UuidV7Generator } from '../../src/infrastructure/uuid-v7-generator';
import { FakeClock } from '../support/clock';
import { initTestOrm, sql } from '../support/database';
import {
  createSqsClient,
  createTestQueue,
  deleteTestQueues,
  drainQueue,
} from '../support/sqs';

/**
 * Registra o que o publisher SQS real aceitou. Não substitui o broker; só
 * observa as publicações para contar duplicatas.
 */
class RecordingPublisher implements EventPublisher {
  readonly sent: string[] = [];

  constructor(private readonly inner: EventPublisher) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    const result = await this.inner.publish(messages);
    this.sent.push(...result.published);
    return result;
  }
}

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;
let sqs: SQSClient;
let queue: { name: string; url: string };
let openWallet: OpenWalletUseCase;

beforeAll(async () => {
  orm = await initTestOrm();
  uow = new MikroOrmUnitOfWork(orm);
  sqs = createSqsClient();
  queue = await createTestQueue(sqs, 'outbox-test');
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

beforeEach(async () => {
  // Isola os testes: nada pendente de testes anteriores, fila vazia.
  await sql(
    orm,
    'update outbox_message set published_at = now() where published_at is null',
  );
  await drainQueue(sqs, queue.url);
});

const recording = (queueName = queue.name) =>
  new RecordingPublisher(new SqsEventPublisher(sqs, queueName));

const useCase = (
  publisher: EventPublisher,
  clock = new FakeClock(),
  unitOfWork: UnitOfWork = uow,
) => new PublishOutboxUseCase(unitOfWork, publisher, clock);

/** Cada abertura com saldo gera um `WalletBalanceChanged` na outbox. */
async function createEvents(count: number): Promise<string[]> {
  const wallets = await Promise.all(
    Array.from({ length: count }, () =>
      openWallet.execute({
        playerId: `player-${randomUUID()}`,
        initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
        correlationId: 'corr-outbox',
      }),
    ),
  );
  const ids = wallets.map((w) => w.id);
  const rows = await sql(
    orm,
    `select id from outbox_message where aggregate_id in (${ids.map(() => '?').join(',')})`,
    ids,
  );
  return rows.map((r) => r.id);
}

async function outboxState(ids: string[]) {
  return sql(
    orm,
    `select id, attempts, next_attempt_at, published_at
       from outbox_message where id in (${ids.map(() => '?').join(',')})`,
    ids,
  );
}

describe('PublishOutboxUseCase (PostgreSQL + SQS reais)', () => {
  it('publica os eventos pendentes no SQS e os marca como publicados', async () => {
    const ids = await createEvents(3);
    const report = await useCase(recording()).runOnce();

    expect(report).toMatchObject({ claimed: 3, published: 3, failed: 0 });
    expect(report.maxLagMs).toBeNumber();

    const messages = await drainQueue(sqs, queue.url);
    expect(
      messages.map((m) => m.MessageAttributes?.eventId?.StringValue).sort(),
    ).toEqual([...ids].sort());
    for (const message of messages) {
      const envelope = JSON.parse(message.Body!);
      expect(envelope.eventType).toBe('WalletBalanceChanged');
      expect(envelope.correlationId).toBe('corr-outbox');
      expect(message.Attributes?.MessageGroupId).toBe(envelope.aggregateId);
      expect(message.MessageAttributes?.eventType?.StringValue).toBe(
        'WalletBalanceChanged',
      );
    }

    for (const row of await outboxState(ids)) {
      expect(row.published_at).not.toBeNull();
      expect(row.attempts).toBe(0);
    }
  });

  it('nunca publica antes do commit da transação que gravou o evento', async () => {
    let releaseCommit!: () => void;
    const commitGate = new Promise<void>((r) => (releaseCommit = r));
    const holdBeforeCommit: UnitOfWork = {
      run: <T>(work: (ctx: TransactionalContext) => Promise<T>) =>
        uow.run(async (ctx) => {
          const result = await work(ctx);
          await commitGate;
          return result;
        }),
    };
    const opening = new OpenWalletUseCase(
      holdBeforeCommit,
      new UuidV7Generator(),
      new SystemClock(),
    ).execute({
      playerId: `player-${randomUUID()}`,
      initialBalance: Money.from({ amount: '10.00', currency: 'BRL' }),
      correlationId: 'corr-outbox',
    });

    // a transação já inseriu o evento, mas ainda não confirmou
    await Bun.sleep(100);
    const publisher = recording();
    expect((await useCase(publisher).runOnce()).claimed).toBe(0);
    expect(publisher.sent).toHaveLength(0);

    releaseCommit();
    await opening;
    expect((await useCase(publisher).runOnce()).published).toBe(1);
  });

  it('falha do broker agenda retentativa com backoff e não perde o evento', async () => {
    const ids = await createEvents(2);
    const clock = new FakeClock();
    const broken = useCase(
      new SqsEventPublisher(sqs, `fila-inexistente-${randomUUID()}.fifo`),
      clock,
    );

    const failed = await broken.runOnce();
    expect(failed).toMatchObject({ claimed: 2, published: 0, failed: 2 });
    expect(failed.error).toBe('QueueDoesNotExist');
    for (const row of await outboxState(ids)) {
      expect(row.published_at).toBeNull();
      expect(row.attempts).toBe(1);
      expect(row.next_attempt_at).not.toBeNull();
    }

    // antes do backoff vencer, nada é devido
    const healthy = recording();
    expect((await useCase(healthy, clock).runOnce()).claimed).toBe(0);

    clock.advance(OUTBOX_RETRY_BASE_DELAY_MS);
    expect((await useCase(healthy, clock).runOnce()).published).toBe(2);
    expect(healthy.sent.sort()).toEqual([...ids].sort());
  });

  it('crash depois de publicar e antes do commit → republica com o mesmo eventId', async () => {
    const [id] = await createEvents(1);
    const publisher = recording();
    const crashBeforeCommit: UnitOfWork = {
      run: <T>(work: (ctx: TransactionalContext) => Promise<T>) =>
        uow.run(async (ctx) => {
          await work(ctx);
          throw new Error('processo morreu antes do commit');
        }),
    };

    await expect(
      useCase(publisher, new FakeClock(), crashBeforeCommit).runOnce(),
    ).rejects.toThrow('processo morreu antes do commit');
    expect(publisher.sent).toEqual([id]);
    const [pending] = await outboxState([id]);
    expect(pending.published_at).toBeNull();

    // outra instância assume
    expect((await useCase(publisher).runOnce()).published).toBe(1);
    expect(publisher.sent).toEqual([id, id]); // duplicata segura: mesmo eventId
    const [published] = await outboxState([id]);
    expect(published.published_at).not.toBeNull();

    // o broker FIFO ainda deduplica pelo MessageDeduplicationId (= eventId)
    const messages = await drainQueue(sqs, queue.url);
    expect(
      messages.map((m) => m.MessageAttributes?.eventId?.StringValue),
    ).toEqual([id]);
  });

  it('publishers concorrentes na mesma outbox publicam cada evento exatamente uma vez', async () => {
    const ids = await createEvents(60);
    const publisher = recording();

    const drain = async () => {
      const instance = useCase(publisher);
      while ((await instance.runOnce()).claimed > 0) {
        // continua até não haver mais lotes devidos
      }
    };
    await Promise.all(Array.from({ length: 5 }, drain));

    expect(publisher.sent).toHaveLength(60);
    expect(new Set(publisher.sent)).toEqual(new Set(ids));
    for (const row of await outboxState(ids)) {
      expect(row.published_at).not.toBeNull();
    }
  });
});

/** Atrasa cada publicação: força a intercalação entre publishers concorrentes. */
class JitterPublisher implements EventPublisher {
  constructor(private readonly inner: EventPublisher) {}

  async publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    await Bun.sleep(Math.random() * 15);
    return this.inner.publish(messages);
  }
}

/** Recusa (lança) enquanto o lote contiver alguma das mensagens bloqueadas. */
class RefusingPublisher implements EventPublisher {
  constructor(
    private readonly inner: EventPublisher,
    readonly refused: Set<string>,
  ) {}

  publish(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    if (messages.some((m) => this.refused.has(m.id))) {
      return Promise.reject(new Error('broker indisponível'));
    }
    return this.inner.publish(messages);
  }
}

/**
 * Grava um evento direto na outbox. `occurredAt` decrescente de propósito
 * nos testes: a ordem por wallet segue a ordem de inserção (`seq`), não o
 * relógio.
 */
async function insertOutbox(aggregateId: string, occurredAt: Date) {
  const id = randomUUID();
  await sql(
    orm,
    `insert into outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts)
     values (?, ?, 'TestEvent', ?::jsonb, ?, 0)`,
    [id, aggregateId, JSON.stringify({ eventId: id }), occurredAt],
  );
  return id;
}

async function publishUntilEmpty(publishers: PublishOutboxUseCase[]) {
  for (let round = 0; round < 200; round++) {
    const reports = await Promise.all(publishers.map((p) => p.runOnce()));
    if (reports.every((r) => r.claimed === 0)) {
      return;
    }
  }
  throw new Error('outbox não esvaziou');
}

describe('ordem dos eventos por wallet', () => {
  it('publishers concorrentes publicam os eventos de cada wallet na ordem de inserção', async () => {
    const wallets = [randomUUID(), randomUUID(), randomUUID()];
    const expected = new Map<string, string[]>(wallets.map((w) => [w, []]));
    let clock = Date.now();
    for (let i = 0; i < 25; i++) {
      for (const wallet of wallets) {
        clock -= 1_000; // relógio andando para trás
        expected.get(wallet)!.push(await insertOutbox(wallet, new Date(clock)));
      }
    }

    const sent = recording();
    await publishUntilEmpty(
      Array.from({ length: 5 }, () => useCase(new JitterPublisher(sent))),
    );

    const received = await drainQueue(sqs, queue.url);
    const byWallet = new Map<string, string[]>();
    for (const message of received) {
      const group = message.Attributes?.MessageGroupId;
      const eventId = message.MessageAttributes?.eventId?.StringValue;
      if (group && eventId && expected.has(group)) {
        byWallet.set(group, [...(byWallet.get(group) ?? []), eventId]);
      }
    }
    for (const wallet of wallets) {
      expect(byWallet.get(wallet)).toEqual(expected.get(wallet));
    }
    // cada evento publicado exatamente uma vez
    expect(new Set(sent.sent).size).toBe(sent.sent.length);
  }, 60_000);

  it('cabeça em backoff segura só os eventos seguintes da própria wallet', async () => {
    const walletA = randomUUID();
    const walletB = randomUUID();
    const clock = new FakeClock();
    const a1 = await insertOutbox(walletA, clock.now());
    const refusing = new RefusingPublisher(recording(), new Set([a1]));

    // a1 falha e entra em backoff
    expect(await useCase(refusing, clock).runOnce()).toMatchObject({
      claimed: 1,
      failed: 1,
    });

    const a2 = await insertOutbox(walletA, clock.now());
    const b1 = await insertOutbox(walletB, clock.now());
    refusing.refused.clear();

    // a2 não pode passar na frente de a1; a wallet B segue normalmente
    expect(await useCase(refusing, clock).runOnce()).toMatchObject({
      claimed: 1,
      published: 1,
    });
    let state = new Map(
      (await outboxState([a1, a2, b1])).map((r) => [r.id, r.published_at]),
    );
    expect(state.get(b1)).not.toBeNull();
    expect(state.get(a1)).toBeNull();
    expect(state.get(a2)).toBeNull();

    // vencido o backoff, a1 e a2 saem juntas, nessa ordem
    clock.advance(OUTBOX_RETRY_BASE_DELAY_MS);
    expect(await useCase(refusing, clock).runOnce()).toMatchObject({
      claimed: 2,
      published: 2,
    });
    state = new Map(
      (await outboxState([a1, a2])).map((r) => [r.id, r.published_at]),
    );
    expect(state.get(a1)).not.toBeNull();
    expect(state.get(a2)).not.toBeNull();

    const received = await drainQueue(sqs, queue.url);
    expect(
      received
        .filter((m) => m.Attributes?.MessageGroupId === walletA)
        .map((m) => m.MessageAttributes?.eventId?.StringValue),
    ).toEqual([a1, a2]);
  });
});

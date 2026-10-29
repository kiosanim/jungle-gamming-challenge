import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import { Metrics, NOOP_METRICS } from '../../src/application/ports/metrics';
import {
  DEFAULT_RETENTION_POLICY,
  PurgeExpiredMessagesUseCase,
  RetentionPolicy,
} from '../../src/application/purge-expired-messages.use-case';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work';
import { FakeClock } from '../support/clock';
import { initTestOrm, sql } from '../support/database';

const DAY_MS = 24 * 3_600_000;

let orm: MikroORM;
let uow: MikroOrmUnitOfWork;

beforeAll(async () => {
  orm = await initTestOrm();
  uow = new MikroOrmUnitOfWork(orm);
});

afterAll(async () => {
  await orm?.close(true);
});

const daysAgo = (clock: FakeClock, days: number) =>
  new Date(clock.now().getTime() - days * DAY_MS);

async function insertOutbox(occurredAt: Date, publishedAt: Date | null) {
  const id = randomUUID();
  await sql(
    orm,
    `insert into outbox_message (id, aggregate_id, event_type, payload, occurred_at, attempts, published_at)
     values (?, ?, 'TestEvent', '{}'::jsonb, ?, 0, ?)`,
    [id, randomUUID(), occurredAt, publishedAt],
  );
  return id;
}

async function insertInbox(receivedAt: Date) {
  const messageId = `msg-${randomUUID()}`;
  await sql(
    orm,
    `insert into inbox_message (consumer_name, message_id, payload_hash, received_at, processed_at)
     values ('wager-transactions', ?, 'hash', ?, ?)`,
    [messageId, receivedAt, receivedAt],
  );
  return messageId;
}

async function existing(table: 'outbox' | 'inbox', ids: string[]) {
  const rows =
    table === 'outbox'
      ? await sql(
          orm,
          `select id from outbox_message where id in (${ids.map(() => '?').join(',')})`,
          ids,
        )
      : await sql(
          orm,
          `select message_id as id from inbox_message where message_id in (${ids.map(() => '?').join(',')})`,
          ids,
        );
  return new Set(rows.map((r: { id: string }) => r.id));
}

const useCase = (
  clock: FakeClock,
  policy: Partial<RetentionPolicy> = {},
  metrics: Metrics = NOOP_METRICS,
) =>
  new PurgeExpiredMessagesUseCase(
    uow,
    clock,
    { ...DEFAULT_RETENTION_POLICY, ...policy },
    metrics,
  );

describe('PurgeExpiredMessagesUseCase (PostgreSQL real)', () => {
  it('apaga só a outbox publicada além da retenção; pendentes nunca', async () => {
    const clock = new FakeClock();
    const oldPublished = await insertOutbox(
      daysAgo(clock, 10),
      daysAgo(clock, 8),
    );
    const recentPublished = await insertOutbox(
      daysAgo(clock, 2),
      daysAgo(clock, 1),
    );
    const oldPending = await insertOutbox(daysAgo(clock, 30), null);

    const purged: [string, number][] = [];
    const report = await useCase(
      clock,
      {},
      {
        ...NOOP_METRICS,
        retentionPurged: (table, count) => purged.push([table, count]),
      },
    ).runOnce();

    expect(report.outbox).toBe(1);
    expect(purged).toContainEqual(['outbox', 1]);
    const left = await existing('outbox', [
      oldPublished,
      recentPublished,
      oldPending,
    ]);
    expect(left.has(oldPublished)).toBe(false);
    expect(left.has(recentPublished)).toBe(true);
    expect(left.has(oldPending)).toBe(true);
  });

  it('apaga a inbox mais antiga que a retenção (padrão: 14 dias)', async () => {
    const clock = new FakeClock();
    const old = await insertInbox(daysAgo(clock, 15));
    const recent = await insertInbox(daysAgo(clock, 13));

    const report = await useCase(clock).runOnce();

    expect(report.inbox).toBeGreaterThanOrEqual(1);
    const left = await existing('inbox', [old, recent]);
    expect(left.has(old)).toBe(false);
    expect(left.has(recent)).toBe(true);
  });

  it('trabalha em lotes e respeita o teto de lotes por execução', async () => {
    const clock = new FakeClock();
    const ids = await Promise.all(
      Array.from({ length: 7 }, () =>
        insertOutbox(daysAgo(clock, 20), daysAgo(clock, 20)),
      ),
    );

    // 3 lotes de 2 apagam 6 e param; o que sobra fica para a próxima execução
    const first = await useCase(clock, {
      batchSize: 2,
      maxBatches: 3,
    }).runOnce();
    expect(first.outbox).toBe(6);
    expect((await existing('outbox', ids)).size).toBe(1);

    const second = await useCase(clock, {
      batchSize: 2,
      maxBatches: 3,
    }).runOnce();
    expect(second.outbox).toBe(1);
    expect((await existing('outbox', ids)).size).toBe(0);
  });

  it('execuções concorrentes apagam lotes disjuntos, sem erro', async () => {
    const clock = new FakeClock();
    const ids = await Promise.all(
      Array.from({ length: 40 }, () =>
        insertOutbox(daysAgo(clock, 20), daysAgo(clock, 20)),
      ),
    );

    const reports = await Promise.all(
      Array.from({ length: 4 }, () =>
        useCase(clock, { batchSize: 5, maxBatches: 100 }).runOnce(),
      ),
    );

    expect(reports.reduce((sum, r) => sum + r.outbox, 0)).toBe(40);
    expect((await existing('outbox', ids)).size).toBe(0);
  });
});

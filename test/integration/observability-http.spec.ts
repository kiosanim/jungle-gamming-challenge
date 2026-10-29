import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { initTestOrm, sql } from '../support/database';

let orm: MikroORM;
let app: INestApplication;

beforeAll(async () => {
  orm = await initTestOrm();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MikroORM)
    .useValue(orm)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

const http = () => request(app.getHttpServer());
const brl = (amount: string) => ({ amount, currency: 'BRL' });

/** Valor de uma série no formato de exposição Prometheus. */
function metricValue(text: string, series: string): number | undefined {
  const line = text
    .split('\n')
    .find((l) => l.startsWith(`${series} `) || l === series);
  return line ? Number(line.split(' ').pop()) : undefined;
}

async function scrape(): Promise<string> {
  const response = await http().get('/metrics').expect(200);
  expect(response.headers['content-type']).toContain('text/plain');
  return response.text;
}

async function newWallet(amount: string) {
  const playerId = `player-${randomUUID()}`;
  const { body } = await http()
    .post('/wallets')
    .send({ playerId, initialBalance: brl(amount) })
    .expect(201);
  return { walletId: body.id as string, playerId };
}

function betBody(
  wallet: { walletId: string; playerId: string },
  amount: string,
) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'r1',
    gameId: 'g1',
    kind: 'BET',
    money: brl(amount),
  };
}

const submit = (body: ReturnType<typeof betBody>) =>
  http()
    .post('/wagering/transactions')
    .set('Idempotency-Key', `provider-a:${body.externalTransactionId}`)
    .send(body);

describe('correlationId', () => {
  it('ecoa o X-Correlation-Id recebido', async () => {
    const response = await http()
      .get('/health/live')
      .set('X-Correlation-Id', 'corr-do-cliente')
      .expect(200);
    expect(response.headers['x-correlation-id']).toBe('corr-do-cliente');
  });

  it('gera um quando o cliente não envia, e propaga aos eventos da outbox', async () => {
    const response = await http()
      .post('/wallets')
      .send({
        playerId: `player-${randomUUID()}`,
        initialBalance: brl('10.00'),
      })
      .expect(201);
    const correlationId = response.headers['x-correlation-id'];
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);

    const [event] = await sql(
      orm,
      `select payload->>'correlationId' as correlation from outbox_message where aggregate_id = ?`,
      [response.body.id],
    );
    expect(event.correlation).toBe(correlationId);
  });
});

describe('GET /metrics', () => {
  it('contabiliza transações por status, duplicatas e latência', async () => {
    const before = await scrape();
    const series = (status: string) =>
      `wagering_transactions_total{channel="http",kind="BET",status="${status}"}`;
    const processedBefore = metricValue(before, series('PROCESSED')) ?? 0;
    const rejectedBefore = metricValue(before, series('REJECTED')) ?? 0;
    const replaysBefore =
      metricValue(
        before,
        'wagering_duplicates_total{type="idempotent_replay"}',
      ) ?? 0;

    const wallet = await newWallet('10.00');
    const accepted = betBody(wallet, '4.00');
    await submit(accepted).expect(201);
    await submit(betBody(wallet, '50.00')).expect(422);
    await submit(accepted).expect(200); // replay

    const after = await scrape();
    expect(metricValue(after, series('PROCESSED'))).toBe(processedBefore + 1);
    expect(metricValue(after, series('REJECTED'))).toBe(rejectedBefore + 1);
    expect(
      metricValue(after, 'wagering_duplicates_total{type="idempotent_replay"}'),
    ).toBe(replaysBefore + 1);
    expect(after).toContain(
      'wagering_processing_duration_seconds_bucket{le="0.005",channel="http"}',
    );
  });

  it('expõe outbox lag, pendências e reconciliações divergentes', async () => {
    const wallet = await newWallet('10.00');
    await sql(orm, "update wallet set balance = '11.00' where id = ?", [
      wallet.walletId,
    ]);
    await http().post(`/wallets/${wallet.walletId}/reconciliation`).expect(200);
    // envelhece um evento pendente: o lag deve refletir a idade do mais antigo
    await sql(
      orm,
      "update outbox_message set occurred_at = now() - interval '10 seconds' where aggregate_id = ?",
      [wallet.walletId],
    );

    const text = await scrape();
    // publisher desligado nos testes: há eventos pendentes e o lag é > 0
    expect(metricValue(text, 'wagering_outbox_pending')).toBeGreaterThan(0);
    expect(
      metricValue(text, 'wagering_outbox_lag_seconds'),
    ).toBeGreaterThanOrEqual(10);
    expect(metricValue(text, 'wagering_pending_reference_transactions')).toBe(
      0,
    );
    expect(
      metricValue(text, 'wagering_reconciliations_total{result="divergent"}'),
    ).toBeGreaterThanOrEqual(1);
  });
});

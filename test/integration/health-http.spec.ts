import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { ensureQueues } from '../../src/infrastructure/messaging/queues';
import { initTestOrm } from '../support/database';
import { createSqsClient } from '../support/sqs';

let orm: MikroORM;

beforeAll(async () => {
  orm = await initTestOrm();
  const sqs = createSqsClient();
  await ensureQueues(sqs);
  sqs.destroy();
});

afterAll(async () => {
  await orm?.close(true);
});

async function appWith(sqs?: SQSClient): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MikroORM)
    .useValue(orm);
  if (sqs) {
    builder = builder.overrideProvider(SQSClient).useValue(sqs);
  }
  const app = (await builder.compile()).createNestApplication({
    logger: false,
  });
  await app.init();
  return app;
}

describe('health checks', () => {
  it('GET /health/live → 200 sem consultar dependências', async () => {
    const app = await appWith();
    const { body } = await request(app.getHttpServer())
      .get('/health/live')
      .expect(200);
    expect(body).toEqual({ status: 'ok' });
    await app.close();
  });

  it('GET /health/ready → 200 com PostgreSQL e SQS alcançáveis', async () => {
    const app = await appWith();
    const { body } = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200);
    expect(body).toEqual({
      status: 'ok',
      checks: { postgres: { status: 'up' }, sqs: { status: 'up' } },
    });
    await app.close();
  });

  it('GET /health/ready → 503 quando o SQS está inacessível', async () => {
    const unreachable = new SQSClient({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxAttempts: 1,
    });
    const app = await appWith(unreachable);
    const { body } = await request(app.getHttpServer())
      .get('/health/ready')
      .expect(503);
    expect(body.status).toBe('unavailable');
    expect(body.checks.postgres.status).toBe('up');
    expect(body.checks.sqs.status).toBe('down');
    await app.close();
  });
});

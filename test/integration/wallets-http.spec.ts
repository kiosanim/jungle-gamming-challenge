import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { initTestOrm } from '../support/database';
import { expectLedgerConsistent } from '../support/ledger';

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
const newPlayer = () => `player-${randomUUID()}`;

describe('POST /wallets', () => {
  it('201 com o contrato da wallet criada', async () => {
    const playerId = newPlayer();
    const response = await http()
      .post('/wallets')
      .send({ playerId, initialBalance: brl('1000.00') })
      .expect(201);

    expect(response.body).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      playerId,
      balance: brl('1000.00'),
      version: 1,
    });
    await expectLedgerConsistent(orm, response.body.id);
  });

  it('normaliza o valor para 2 casas', async () => {
    const response = await http()
      .post('/wallets')
      .send({ playerId: newPlayer(), initialBalance: brl('25.5') })
      .expect(201);
    expect(response.body.balance).toEqual(brl('25.50'));
  });

  it('409 WALLET_ALREADY_EXISTS para playerId + moeda duplicados', async () => {
    const playerId = newPlayer();
    await http()
      .post('/wallets')
      .send({ playerId, initialBalance: brl('1.00') })
      .expect(201);

    const response = await http()
      .post('/wallets')
      .send({ playerId, initialBalance: brl('2.00') })
      .expect(409);
    expect(response.body.error.code).toBe('WALLET_ALREADY_EXISTS');
  });

  it.each([
    ['corpo vazio', undefined],
    ['sem playerId', { initialBalance: brl('1.00') }],
    ['playerId vazio', { playerId: ' ', initialBalance: brl('1.00') }],
    ['playerId numérico', { playerId: 42, initialBalance: brl('1.00') }],
    ['sem initialBalance', { playerId: 'p' }],
    [
      'amount numérico',
      { playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } },
    ],
    ['amount negativo', { playerId: 'p', initialBalance: brl('-1.00') }],
    ['amount com 3 casas', { playerId: 'p', initialBalance: brl('1.001') }],
    ['notação científica', { playerId: 'p', initialBalance: brl('1e3') }],
    [
      'moeda inválida',
      { playerId: 'p', initialBalance: { amount: '1.00', currency: 'real' } },
    ],
  ])('400 INVALID_PAYLOAD: %s', async (_, body) => {
    const response = await http().post('/wallets').send(body).expect(400);
    expect(response.body.error.code).toBe('INVALID_PAYLOAD');
  });

  it('concorrência: 10 requisições simultâneas do mesmo player → um 201 e nove 409', async () => {
    const playerId = newPlayer();
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        http()
          .post('/wallets')
          .send({ playerId, initialBalance: brl('100.00') }),
      ),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, ...Array(9).fill(409)]);

    const created = responses.find((r) => r.status === 201)!;
    await expectLedgerConsistent(orm, created.body.id);
  });
});

describe('GET /wallets/:walletId', () => {
  it('200 com o estado atual', async () => {
    const playerId = newPlayer();
    const created = await http()
      .post('/wallets')
      .send({ playerId, initialBalance: brl('42.00') })
      .expect(201);

    const response = await http()
      .get(`/wallets/${created.body.id}`)
      .expect(200);
    expect(response.body).toEqual(created.body);
  });

  it('404 WALLET_NOT_FOUND para wallet inexistente', async () => {
    const response = await http().get(`/wallets/${randomUUID()}`).expect(404);
    expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  it('400 INVALID_PAYLOAD para id que não é UUID', async () => {
    const response = await http().get('/wallets/nao-e-uuid').expect(400);
    expect(response.body.error.code).toBe('INVALID_PAYLOAD');
  });
});

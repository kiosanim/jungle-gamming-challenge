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

async function newWallet(amount: string) {
  const playerId = `player-${randomUUID()}`;
  const response = await http()
    .post('/wallets')
    .send({ playerId, initialBalance: brl(amount) })
    .expect(201);
  return { walletId: response.body.id as string, playerId };
}

function bet(
  wallet: { walletId: string; playerId: string },
  overrides: Record<string, unknown> = {},
) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `tx-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: brl('25.00'),
    ...overrides,
  };
}

const submit = (body: Record<string, unknown>, key?: string) =>
  http()
    .post('/wagering/transactions')
    .set(
      'Idempotency-Key',
      key ?? `${body.providerId}:${body.externalTransactionId}`,
    )
    .send(body);

describe('POST /wagering/transactions', () => {
  it('201 com o contrato do desafio', async () => {
    const wallet = await newWallet('1000.00');
    const response = await submit(bet(wallet)).expect(201);

    expect(response.body).toEqual({
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      status: 'PROCESSED',
      balance: brl('975.00'),
      idempotentReplay: false,
    });
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('200 com idempotentReplay: true para requisição idêntica', async () => {
    const wallet = await newWallet('1000.00');
    const body = bet(wallet);
    const first = await submit(body).expect(201);
    const second = await submit(body).expect(200);

    expect(second.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it('422 com failureCode para rejeição de negócio (e replay idem)', async () => {
    const wallet = await newWallet('10.00');
    const body = bet(wallet, { money: brl('10.01') });
    const first = await submit(body).expect(422);

    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: brl('10.00'),
      idempotentReplay: false,
    });
    const replay = await submit(body).expect(422);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it('409 IDEMPOTENCY_CONFLICT para mesma key com payload diferente', async () => {
    const wallet = await newWallet('100.00');
    const body = bet(wallet);
    await submit(body).expect(201);

    const response = await submit({ ...body, money: brl('30.00') }).expect(409);
    expect(response.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('404 WALLET_NOT_FOUND para wallet inexistente', async () => {
    const response = await submit(
      bet({ walletId: randomUUID(), playerId: 'p' }),
    ).expect(404);
    expect(response.body.error.code).toBe('WALLET_NOT_FOUND');
  });

  it('400 sem header Idempotency-Key', async () => {
    const wallet = await newWallet('100.00');
    const response = await http()
      .post('/wagering/transactions')
      .send(bet(wallet))
      .expect(400);
    expect(response.body.error.code).toBe('INVALID_PAYLOAD');
  });

  it.each([
    ['kind OPENING (interno)', { kind: 'OPENING' }],
    ['kind desconhecido', { kind: 'JACKPOT' }],
    ['money numérico', { money: { amount: 25, currency: 'BRL' } }],
    ['money com 3 casas', { money: brl('25.001') }],
    ['money negativo', { money: brl('-1.00') }],
    ['BET de valor zero', { money: brl('0.00') }],
    ['walletId não UUID', { walletId: 'abc' }],
    ['providerId ausente', { providerId: undefined }],
    ['roundId vazio', { roundId: '' }],
    ['REFUND sem referência', { kind: 'REFUND' }],
  ])('400 INVALID_PAYLOAD: %s', async (_, overrides) => {
    const wallet = await newWallet('100.00');
    const body = bet(wallet, overrides);
    const response = await submit(body, `key-${randomUUID()}`).expect(400);
    expect(response.body.error.code).toBe('INVALID_PAYLOAD');
  });

  it('cenário obrigatório via HTTP: 100.00 e duas apostas simultâneas de 80.00', async () => {
    const wallet = await newWallet('100.00');
    const responses = await Promise.all([
      submit(bet(wallet, { money: brl('80.00') })),
      submit(bet(wallet, { money: brl('80.00') })),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 422]);

    const walletNow = await http()
      .get(`/wallets/${wallet.walletId}`)
      .expect(200);
    expect(walletNow.body.balance).toEqual(brl('20.00'));
    await expectLedgerConsistent(orm, wallet.walletId);
  });
});

describe('POST /wagering/transactions com referência', () => {
  it('REFUND de BET processada → 201 com o saldo restaurado', async () => {
    const wallet = await newWallet('100.00');
    const betBody = bet(wallet, { money: brl('40.00') });
    await submit(betBody).expect(201);

    const response = await submit(
      bet(wallet, {
        kind: 'REFUND',
        money: brl('40.00'),
        referenceExternalTransactionId: betBody.externalTransactionId,
      }),
    ).expect(201);
    expect(response.body).toMatchObject({
      status: 'PROCESSED',
      balance: brl('100.00'),
    });
    await expectLedgerConsistent(orm, wallet.walletId);
  });

  it('REFUND antes da BET → 202 PENDING_REFERENCE (e replay idem)', async () => {
    const wallet = await newWallet('100.00');
    const body = bet(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: `ainda-nao-chegou-${randomUUID()}`,
    });

    const first = await submit(body).expect(202);
    expect(first.body).toEqual({
      transactionId: expect.any(String),
      status: 'PENDING_REFERENCE',
      idempotentReplay: false,
    });
    const replay = await submit(body).expect(202);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
  });

  it('segundo REFUND da mesma BET → 422 REFERENCE_ALREADY_REVERSED', async () => {
    const wallet = await newWallet('100.00');
    const betBody = bet(wallet);
    await submit(betBody).expect(201);
    const refund = (ext: string) =>
      bet(wallet, {
        kind: 'REFUND',
        externalTransactionId: ext,
        referenceExternalTransactionId: betBody.externalTransactionId,
      });

    await submit(refund(`r1-${randomUUID()}`)).expect(201);
    const response = await submit(refund(`r2-${randomUUID()}`)).expect(422);
    expect(response.body.failureCode).toBe('REFERENCE_ALREADY_REVERSED');
  });
});

describe('GET de transações', () => {
  it('GET /wagering/transactions/:transactionId', async () => {
    const wallet = await newWallet('100.00');
    const body = bet(wallet);
    const created = await submit(body).expect(201);

    const response = await http()
      .get(`/wagering/transactions/${created.body.transactionId}`)
      .expect(200);
    expect(response.body).toMatchObject({
      transactionId: created.body.transactionId,
      providerId: 'provider-a',
      externalTransactionId: body.externalTransactionId,
      walletId: wallet.walletId,
      kind: 'BET',
      money: brl('25.00'),
      status: 'PROCESSED',
      balance: brl('75.00'),
    });
    expect(response.body.processedAt).toBeString();
  });

  it('GET /providers/:providerId/wagering/transactions/:externalTransactionId', async () => {
    const wallet = await newWallet('100.00');
    const body = bet(wallet);
    const created = await submit(body).expect(201);

    const response = await http()
      .get(
        `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
      )
      .expect(200);
    expect(response.body.transactionId).toBe(created.body.transactionId);
  });

  it('404 TRANSACTION_NOT_FOUND', async () => {
    await http().get(`/wagering/transactions/${randomUUID()}`).expect(404);
    const response = await http()
      .get('/providers/provider-a/wagering/transactions/nao-existe')
      .expect(404);
    expect(response.body.error.code).toBe('TRANSACTION_NOT_FOUND');
  });
});

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

async function walletWithBets(initial: string, bets: number) {
  const playerId = `player-${randomUUID()}`;
  const { body } = await http()
    .post('/wallets')
    .send({ playerId, initialBalance: brl(initial) })
    .expect(201);
  for (let i = 0; i < bets; i++) {
    await placeBet(body.id, playerId);
  }
  return { walletId: body.id as string, playerId };
}

async function placeBet(walletId: string, playerId: string, amount = '1.00') {
  const externalTransactionId = `tx-${randomUUID()}`;
  await http()
    .post('/wagering/transactions')
    .set('Idempotency-Key', `provider-a:${externalTransactionId}`)
    .send({
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'r1',
      gameId: 'g1',
      kind: 'BET',
      money: brl(amount),
    })
    .expect(201);
}

describe('GET /wallets/:walletId/ledger', () => {
  it('pagina do mais recente ao mais antigo com cursor opaco até o fim', async () => {
    const { walletId } = await walletWithBets('100.00', 7); // 8 lançamentos

    const versions: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: Record<string, string | number> = { limit: 3 };
      if (cursor) {
        query.cursor = cursor;
      }
      const response = await http()
        .get(`/wallets/${walletId}/ledger`)
        .query(query)
        .expect(200);
      const page = response.body as {
        items: { walletVersion: number }[];
        nextCursor: string | null;
      };
      versions.push(...page.items.map((e) => e.walletVersion));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);

    expect(pages).toBe(3);
    expect(versions).toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });

  it('formato do item', async () => {
    const { walletId } = await walletWithBets('100.00', 1);
    const { body } = await http()
      .get(`/wallets/${walletId}/ledger`)
      .expect(200);

    expect(body.nextCursor).toBeNull();
    expect(body.items[0]).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: 'DEBIT',
      money: brl('1.00'),
      counterAccount: 'provider:provider-a:BRL',
      balanceBefore: brl('100.00'),
      balanceAfter: brl('99.00'),
      walletVersion: 2,
      createdAt: expect.any(String),
    });
  });

  it('cursor estável: lançamentos novos não deslocam as páginas seguintes', async () => {
    const { walletId, playerId } = await walletWithBets('100.00', 5); // v1..v6
    const first = await http()
      .get(`/wallets/${walletId}/ledger`)
      .query({ limit: 3 })
      .expect(200);

    await placeBet(walletId, playerId); // v7 entre as leituras
    await placeBet(walletId, playerId); // v8

    const second = await http()
      .get(`/wallets/${walletId}/ledger`)
      .query({ limit: 3, cursor: first.body.nextCursor })
      .expect(200);
    expect(
      second.body.items.map((e: { walletVersion: number }) => e.walletVersion),
    ).toEqual([3, 2, 1]);
  });

  it.each([
    ['cursor inválido', { cursor: 'nao-e-um-cursor' }],
    ['limit zero', { limit: '0' }],
    ['limit acima do máximo', { limit: '201' }],
    ['limit não numérico', { limit: 'abc' }],
  ])('400 INVALID_PAYLOAD: %s', async (_, query) => {
    const { walletId } = await walletWithBets('10.00', 0);
    const { body } = await http()
      .get(`/wallets/${walletId}/ledger`)
      .query(query)
      .expect(400);
    expect(body.error.code).toBe('INVALID_PAYLOAD');
  });

  it('404 para wallet inexistente', async () => {
    await http().get(`/wallets/${randomUUID()}/ledger`).expect(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  it('saldo armazenado igual ao do ledger → consistente', async () => {
    const { walletId } = await walletWithBets('100.00', 3);
    const { body } = await http()
      .post(`/wallets/${walletId}/reconciliation`)
      .expect(200);

    expect(body).toEqual({
      walletId,
      storedBalance: brl('97.00'),
      calculatedBalance: brl('97.00'),
      difference: brl('0.00'),
      consistent: true,
      checkedEntries: 4,
    });
  });

  it('wallet sem lançamentos (saldo inicial zero) é consistente', async () => {
    const { walletId } = await walletWithBets('0.00', 0);
    const { body } = await http()
      .post(`/wallets/${walletId}/reconciliation`)
      .expect(200);
    expect(body).toMatchObject({ consistent: true, checkedEntries: 0 });
  });

  it('divergência é sinalizada e NÃO corrigida', async () => {
    const { walletId } = await walletWithBets('100.00', 2);
    // corrupção simulada do saldo materializado, fora da aplicação
    await sql(orm, "update wallet set balance = '150.00' where id = ?", [
      walletId,
    ]);

    const { body } = await http()
      .post(`/wallets/${walletId}/reconciliation`)
      .expect(200);
    expect(body).toMatchObject({
      storedBalance: brl('150.00'),
      calculatedBalance: brl('98.00'),
      difference: brl('52.00'),
      consistent: false,
    });

    const [row] = await sql(
      orm,
      'select balance::text as balance from wallet where id = ?',
      [walletId],
    );
    expect(row.balance).toBe('150.00');
  });

  it('404 para wallet inexistente', async () => {
    await http().post(`/wallets/${randomUUID()}/reconciliation`).expect(404);
  });
});

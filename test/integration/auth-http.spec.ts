import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { generateKeyPair } from 'jose';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AUTH_CONFIG } from '../../src/infrastructure/auth/auth-config';
import { initTestOrm } from '../support/database';
import { LocalIdentityProvider } from '../support/local-idp';

/**
 * Autenticação e autorização com tokens JWT validados pelo JWKS. Aqui o JWKS
 * vem de um IdP local, para cobrir os tokens inválidos de forma
 * determinística. O fluxo com o Keycloak de verdade está em
 * `keycloak-auth.spec.ts`.
 */

let orm: MikroORM;
let idp: LocalIdentityProvider;
let app: INestApplication;

beforeAll(async () => {
  orm = await initTestOrm();
  idp = await LocalIdentityProvider.start();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MikroORM)
    .useValue(orm)
    .overrideProvider(AUTH_CONFIG)
    .useValue({
      enabled: true,
      issuer: idp.issuer,
      audience: idp.audience,
      jwksUrl: idp.jwksUrl,
      providerClaim: 'provider_id',
    })
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.init();
});

afterAll(async () => {
  await app?.close();
  idp?.stop();
});

const http = () => request(app.getHttpServer());
const brl = (amount: string) => ({ amount, currency: 'BRL' });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function newWallet() {
  const playerId = `player-${randomUUID()}`;
  const { body } = await http()
    .post('/wallets')
    .set(bearer(await idp.operatorToken()))
    .send({ playerId, initialBalance: brl('100.00') })
    .expect(201);
  return { walletId: body.id as string, playerId };
}

function bet(
  wallet: { walletId: string; playerId: string },
  providerId = 'provider-a',
) {
  const externalTransactionId = `tx-${randomUUID()}`;
  return {
    providerId,
    externalTransactionId,
    playerId: wallet.playerId,
    walletId: wallet.walletId,
    roundId: 'r1',
    gameId: 'g1',
    kind: 'BET',
    money: brl('10.00'),
  };
}

const submit = (body: ReturnType<typeof bet>, token?: string) => {
  const req = http()
    .post('/wagering/transactions')
    .set('Idempotency-Key', `${body.providerId}:${body.externalTransactionId}`);
  return (token ? req.set(bearer(token)) : req).send(body);
};

describe('autenticação (401)', () => {
  it('sem token → 401 UNAUTHENTICATED com WWW-Authenticate', async () => {
    const wallet = await newWallet();
    const response = await submit(bet(wallet)).expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
    expect(response.headers['www-authenticate']).toContain('Bearer');
  });

  it('esquema diferente de Bearer → 401', async () => {
    const response = await http()
      .get(`/wallets/${randomUUID()}`)
      .set('Authorization', 'Basic dXNlcjpzZW5oYQ==')
      .expect(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['token malformado', async () => 'nao.e.um.jwt'],
    [
      'expirado',
      async () => idp.providerToken('provider-a', { expiresInSeconds: -60 }),
    ],
    [
      'assinado por outra chave',
      async () =>
        idp.providerToken('provider-a', {
          signingKey: (await generateKeyPair('RS256')).privateKey,
        }),
    ],
    [
      'emissor errado',
      async () =>
        idp.providerToken('provider-a', { issuer: 'http://outro-idp' }),
    ],
    [
      'audience errada',
      async () => idp.providerToken('provider-a', { audience: 'outra-api' }),
    ],
  ])('%s → 401 INVALID_TOKEN', async (_, makeToken) => {
    const wallet = await newWallet();
    const response = await submit(bet(wallet), await makeToken()).expect(401);
    expect(response.body.error.code).toBe('INVALID_TOKEN');
  });
});

describe('autorização (403)', () => {
  it('provedor operando pelo próprio providerId → 201', async () => {
    const wallet = await newWallet();
    await submit(
      bet(wallet, 'provider-a'),
      await idp.providerToken('provider-a'),
    ).expect(201);
  });

  it('provedor operando em nome de outro → 403 PROVIDER_MISMATCH, nada gravado', async () => {
    const wallet = await newWallet();
    const response = await submit(
      bet(wallet, 'provider-b'),
      await idp.providerToken('provider-a'),
    ).expect(403);
    expect(response.body.error.code).toBe('PROVIDER_MISMATCH');

    const { body } = await http()
      .get(`/wallets/${wallet.walletId}`)
      .set(bearer(await idp.operatorToken()))
      .expect(200);
    expect(body.balance).toEqual(brl('100.00'));
  });

  it('provedor nas rotas de backoffice (wallets) → 403 FORBIDDEN', async () => {
    const response = await http()
      .post('/wallets')
      .set(bearer(await idp.providerToken('provider-a')))
      .send({ playerId: 'p', initialBalance: brl('1.00') })
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('backoffice nas rotas de provedor → 403 FORBIDDEN', async () => {
    const wallet = await newWallet();
    const response = await submit(
      bet(wallet),
      await idp.operatorToken(),
    ).expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('token sem papel algum → 403', async () => {
    const response = await http()
      .get(`/wallets/${randomUUID()}`)
      .set(bearer(await idp.token({})))
      .expect(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });

  it('consulta por provider de outro → 403; por id de outro → 404 (não revela)', async () => {
    const wallet = await newWallet();
    const body = bet(wallet, 'provider-a');
    const created = await submit(
      body,
      await idp.providerToken('provider-a'),
    ).expect(201);
    const intruder = bearer(await idp.providerToken('provider-b'));

    await http()
      .get(
        `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`,
      )
      .set(intruder)
      .expect(403);
    const byId = await http()
      .get(`/wagering/transactions/${created.body.transactionId}`)
      .set(intruder)
      .expect(404);
    expect(byId.body.error.code).toBe('TRANSACTION_NOT_FOUND');

    // o dono enxerga normalmente
    await http()
      .get(`/wagering/transactions/${created.body.transactionId}`)
      .set(bearer(await idp.providerToken('provider-a')))
      .expect(200);
  });
});

describe('rotas públicas', () => {
  it.each(['/health/live', '/health/ready', '/metrics'])(
    '%s não exige token',
    async (path) => {
      await http().get(path).expect(200);
    },
  );
});

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AUTH_CONFIG } from '../../src/infrastructure/auth/auth-config';
import { initTestOrm } from '../support/database';

/**
 * Fluxo completo com o Keycloak real (`docker compose up -d keycloak`):
 * tokens obtidos por client credentials no realm `wagering`
 * (keycloak/realm-wagering.json) e validados pelo JWKS do Keycloak.
 * Pulado se o Keycloak não estiver acessível.
 */

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost:8080';
const REALM_URL = `${KEYCLOAK_URL}/realms/wagering`;

const DISCOVERY_URL = `${REALM_URL}/.well-known/openid-configuration`;

/**
 * Checagem síncrona, porque o `describe.skipIf` é avaliado no carregamento
 * do arquivo e o projeto é CommonJS, sem top-level await.
 */
const keycloakAvailable = Bun.spawnSync([
  'bun',
  '-e',
  `const r = await fetch(${JSON.stringify(DISCOVERY_URL)}).catch(() => null); process.exit(r?.ok ? 0 : 1)`,
]).success;

let discovery: Record<string, string>;

/** Credenciais de desenvolvimento do realm importado. */
const CLIENTS = {
  'provider-a': 'provider-a-dev-secret',
  'provider-b': 'provider-b-dev-secret',
  backoffice: 'backoffice-dev-secret',
} as const;

async function clientCredentialsToken(
  clientId: keyof typeof CLIENTS,
): Promise<string> {
  const response = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: CLIENTS[clientId],
    }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

describe.skipIf(!keycloakAvailable)(
  'Keycloak real (client credentials)',
  () => {
    let orm: MikroORM;
    let app: INestApplication;
    const tokens: Record<keyof typeof CLIENTS, string> = {
      'provider-a': '',
      'provider-b': '',
      backoffice: '',
    };

    beforeAll(async () => {
      discovery = (await (await fetch(DISCOVERY_URL)).json()) as Record<
        string,
        string
      >;
      orm = await initTestOrm();
      for (const clientId of Object.keys(CLIENTS) as (keyof typeof CLIENTS)[]) {
        tokens[clientId] = await clientCredentialsToken(clientId);
      }
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(MikroORM)
        .useValue(orm)
        .overrideProvider(AUTH_CONFIG)
        .useValue({
          enabled: true,
          issuer: discovery.issuer,
          audience: 'wagering-api',
          jwksUrl: discovery.jwks_uri,
          providerClaim: 'provider_id',
        })
        .compile();
      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
    });

    afterAll(async () => {
      await app?.close();
    });

    const http = () => request(app.getHttpServer());
    const as = (clientId: keyof typeof CLIENTS) => ({
      Authorization: `Bearer ${tokens[clientId]}`,
    });
    const brl = (amount: string) => ({ amount, currency: 'BRL' });

    async function newWallet() {
      const playerId = `player-${randomUUID()}`;
      const { body } = await http()
        .post('/wallets')
        .set(as('backoffice'))
        .send({ playerId, initialBalance: brl('100.00') })
        .expect(201);
      return { walletId: body.id as string, playerId };
    }

    function bet(
      wallet: { walletId: string; playerId: string },
      providerId: string,
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
        money: brl('25.00'),
      };
    }

    it('backoffice abre wallet e consulta o extrato', async () => {
      const wallet = await newWallet();
      const { body } = await http()
        .get(`/wallets/${wallet.walletId}/ledger`)
        .set(as('backoffice'))
        .expect(200);
      expect(body.items).toHaveLength(1);
    });

    it('provider-a aposta pelo próprio providerId → 201', async () => {
      const wallet = await newWallet();
      const body = bet(wallet, 'provider-a');
      const { body: result } = await http()
        .post('/wagering/transactions')
        .set(as('provider-a'))
        .set('Idempotency-Key', `provider-a:${body.externalTransactionId}`)
        .send(body)
        .expect(201);
      expect(result.balance).toEqual(brl('75.00'));
    });

    it('provider-b tentando operar como provider-a → 403 PROVIDER_MISMATCH', async () => {
      const wallet = await newWallet();
      const body = bet(wallet, 'provider-a');
      const { body: error } = await http()
        .post('/wagering/transactions')
        .set(as('provider-b'))
        .set('Idempotency-Key', `provider-a:${body.externalTransactionId}`)
        .send(body)
        .expect(403);
      expect(error.error.code).toBe('PROVIDER_MISMATCH');
    });

    it('provedor nas rotas de backoffice → 403 FORBIDDEN', async () => {
      await http()
        .post('/wallets')
        .set(as('provider-a'))
        .send({ playerId: 'p', initialBalance: brl('1.00') })
        .expect(403);
    });

    it('token do Keycloak adulterado → 401 INVALID_TOKEN', async () => {
      const [header, payload, signature] = tokens['provider-a'].split('.');
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
      const forged = Buffer.from(
        JSON.stringify({ ...claims, provider_id: 'provider-b' }),
      ).toString('base64url');

      const { body } = await http()
        .get(`/providers/provider-b/wagering/transactions/qualquer`)
        .set('Authorization', `Bearer ${header}.${forged}.${signature}`)
        .expect(401);
      expect(body.error.code).toBe('INVALID_TOKEN');
    });
  },
);

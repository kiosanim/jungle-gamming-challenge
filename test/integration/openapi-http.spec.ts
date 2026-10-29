import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MikroORM } from '@mikro-orm/postgresql';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { setupOpenApi } from '../../src/http/openapi/setup';
import { AUTH_CONFIG } from '../../src/infrastructure/auth/auth-config';
import { initTestOrm } from '../support/database';

/**
 * Documentação Swagger servida pela própria aplicação. A autenticação fica
 * ligada aqui de propósito, para mostrar que `/docs` continua aberta enquanto
 * as rotas de negócio pedem token.
 */

let orm: MikroORM;
let app: INestApplication;
let spec: any;

beforeAll(async () => {
  orm = await initTestOrm();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MikroORM)
    .useValue(orm)
    .overrideProvider(AUTH_CONFIG)
    .useValue({
      enabled: true,
      issuer: 'http://idp.test/realms/wagering',
      audience: 'wagering-api',
      jwksUrl: 'http://127.0.0.1:1/certs',
      providerClaim: 'provider_id',
    })
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  setupOpenApi(app);
  await app.init();
  spec = (await request(app.getHttpServer()).get('/docs-json').expect(200))
    .body;
});

afterAll(async () => {
  await app?.close();
});

const ROUTES: [string, string][] = [
  ['post', '/wallets'],
  ['get', '/wallets/{walletId}'],
  ['get', '/wallets/{walletId}/ledger'],
  ['post', '/wallets/{walletId}/reconciliation'],
  ['post', '/wagering/transactions'],
  ['get', '/wagering/transactions/{transactionId}'],
  [
    'get',
    '/providers/{providerId}/wagering/transactions/{externalTransactionId}',
  ],
  ['get', '/health/live'],
  ['get', '/health/ready'],
  ['get', '/metrics'],
];

const PUBLIC = new Set(['/health/live', '/health/ready', '/metrics']);

describe('Swagger (OpenAPI)', () => {
  it('serve o documento em /docs-json e a interface em /docs, sem token', async () => {
    expect(spec.openapi).toStartWith('3.');
    expect(spec.info.title).toBe('Distributed Wagering Processor');

    const page = await request(app.getHttpServer()).get('/docs').expect(200);
    expect(page.text).toContain('swagger-ui');

    // as rotas de negócio continuam exigindo token
    await request(app.getHttpServer())
      .get('/wallets/01a17f88-6cc0-70aa-8d32-320fcca6ce14')
      .expect(401);
  });

  it('documenta todas as rotas da API, e só elas', () => {
    const documented = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.keys(item as object).map((method) => `${method} ${path}`),
    );
    expect(documented.sort()).toEqual(
      ROUTES.map(([method, path]) => `${method} ${path}`).sort(),
    );
  });

  it('rotas de negócio pedem Bearer; health e métricas são abertas', () => {
    for (const [method, path] of ROUTES) {
      const operation = spec.paths[path][method];
      if (PUBLIC.has(path)) {
        expect(operation.security).toBeUndefined();
      } else {
        expect(operation.security).toEqual([{ keycloak: [] }]);
        expect(Object.keys(operation.responses)).toContain('401');
      }
      expect(operation.summary).toBeString();
    }
    expect(spec.components.securitySchemes.keycloak).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it('POST /wagering/transactions documenta os status de sucesso, os erros e a Idempotency-Key', () => {
    const operation = spec.paths['/wagering/transactions'].post;
    expect(Object.keys(operation.responses).sort()).toEqual(
      [
        '200',
        '201',
        '202',
        '400',
        '401',
        '403',
        '404',
        '409',
        '422',
        '503',
      ].sort(),
    );
    const headers = operation.parameters.filter(
      (p: { in: string }) => p.in === 'header',
    );
    const byName = (name: string) =>
      headers.filter((p: { name: string }) => p.name.toLowerCase() === name);
    // cada cabeçalho aparece uma vez, com a obrigatoriedade certa
    expect(byName('idempotency-key')).toHaveLength(1);
    expect(byName('idempotency-key')[0].required).toBe(true);
    expect(byName('x-correlation-id')).toHaveLength(1);
    expect(byName('x-correlation-id')[0].required).toBe(false);
    expect(operation.requestBody.content['application/json'].schema.$ref).toBe(
      '#/components/schemas/SubmitWagerTransactionRequest',
    );
  });

  it('todo $ref aponta para um schema existente', () => {
    const refs = new Set<string>();
    const collect = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach(collect);
      } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string') {
            refs.add(value);
          } else {
            collect(value);
          }
        }
      }
    };
    collect(spec);
    expect(refs.size).toBeGreaterThan(5);
    for (const ref of refs) {
      const name = ref.replace('#/components/schemas/', '');
      expect(spec.components.schemas[name]).toBeDefined();
    }
  });

  it('nenhuma rota documenta o mesmo parâmetro duas vezes', () => {
    for (const [method, path] of ROUTES) {
      const params = spec.paths[path][method].parameters ?? [];
      const keys = params.map(
        (p: { in: string; name: string }) => `${p.in}:${p.name.toLowerCase()}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('Money é string decimal, nunca número', () => {
    expect(spec.components.schemas.Money.properties.amount.type).toBe('string');
  });
});

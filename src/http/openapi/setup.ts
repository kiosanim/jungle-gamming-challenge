import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { SCHEMAS } from './schemas';

/** Nome do esquema de segurança usado pelos controllers em `@ApiBearerAuth`. */
export const BEARER_AUTH = 'keycloak';

export const OPENAPI_PATH = 'docs';

const DESCRIPTION = `
Serviço que processa as operações de aposta (\`BET\`, \`WIN\`, \`LOSS\`, \`REFUND\` e \`ROLLBACK\`) enviadas pelos provedores de jogos e mantém o saldo das wallets com um ledger auditável.

**Autenticação.** Todas as rotas, menos health e métricas, pedem um access token do Keycloak no header \`Authorization: Bearer <token>\`. Os provedores usam o papel \`provider\` e só enxergam as próprias transações; o backoffice usa o papel \`operator\` para abrir wallets, ver o extrato e reconciliar. Em desenvolvimento, os tokens saem por *client credentials* no realm \`wagering\` (o passo a passo está no README).

**Idempotência.** O \`POST /wagering/transactions\` exige o header \`Idempotency-Key\`. Repetir a mesma chave com o mesmo corpo devolve o resultado original, com \`idempotentReplay: true\`. Com outro corpo, a resposta é \`409\`.

**Valores.** Dinheiro trafega sempre como string decimal com até 2 casas, nunca como número: \`{ "amount": "25.00", "currency": "BRL" }\`.

**Correlação.** Toda resposta devolve o \`X-Correlation-Id\` recebido (ou um gerado na hora), e as rotas rastreadas devolvem também o \`x-trace-id\` do OpenTelemetry.
`.trim();

/** Monta o documento OpenAPI a partir dos decorators dos controllers. */
export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Distributed Wagering Processor')
    .setDescription(DESCRIPTION)
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Access token emitido pelo Keycloak (realm `wagering`) por client credentials.',
      },
      BEARER_AUTH,
    )
    .addTag(
      'Wallets',
      'Abertura, consulta, extrato e reconciliação de wallets (backoffice).',
    )
    .addTag(
      'Wagering',
      'Submissão e consulta de operações de aposta pelos provedores.',
    )
    .addTag('Operação', 'Health checks e métricas, abertos e sem autenticação.')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, ...SCHEMAS },
  };
  return document;
}

/**
 * Publica a interface do Swagger em `/docs` e o JSON em `/docs-json`. As
 * rotas são registradas direto no Express, então não passam pelo guard de
 * autenticação: a documentação fica aberta, como health e métricas.
 */
export function setupOpenApi(app: INestApplication): void {
  SwaggerModule.setup(OPENAPI_PATH, app, createOpenApiDocument(app), {
    jsonDocumentUrl: `${OPENAPI_PATH}-json`,
    customSiteTitle: 'Wagering API',
    swaggerOptions: { persistAuthorization: true },
  });
}

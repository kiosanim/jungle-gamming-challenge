import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { setupOpenApi } from './http/openapi/setup';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { startTracing } from './infrastructure/observability/tracing';

/**
 * Sobe um papel da aplicação. Todos escutam HTTP: a API para as rotas de
 * negócio, consumidor e workers apenas para `/health/*` e `/metrics`.
 */
export async function bootstrap(
  module: Type<unknown>,
  serviceName: string,
  options: { openApi?: boolean } = {},
): Promise<void> {
  // Antes da aplicação: o provider global precisa existir quando os spans
  // começarem (`OTEL_SERVICE_NAME`, se definido, tem precedência).
  startTracing({ serviceName });
  const app = await NestFactory.create(module, { bufferLogs: true });
  app.useLogger(new JsonLogger());
  // SIGTERM/SIGINT: para consumidores e workers, depois fecha PostgreSQL e SQS.
  app.enableShutdownHooks();
  // Swagger em /docs, só nos processos que servem as rotas de negócio.
  if (options.openApi) {
    setupOpenApi(app);
  }
  await app.listen(process.env.PORT ?? 3000);
}

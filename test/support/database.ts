import { MikroORM } from '@mikro-orm/postgresql';
import { createMikroOrmConfig } from '../../src/mikro-orm.config';

// Workers em background ficam desligados nos testes: eles chamam os use
// cases diretamente, com relógio controlado.
process.env.WORKERS_ENABLED = 'false';
// Autenticação desligada por padrão nos testes; os testes de autenticação a
// ligam explicitamente (AUTH_CONFIG) com um IdP real ou um JWKS local.
process.env.AUTH_ENABLED = 'false';
// Tracing desligado; o teste de tracing liga um provider em memória.
process.env.OTEL_ENABLED = 'false';

/** Banco dedicado aos testes, para não interferir no banco de desenvolvimento. */
export const testDatabaseName = (): string =>
  process.env.TEST_DATABASE_NAME ?? `${process.env.DATABASE_NAME}_test`;

/**
 * Sobe um ORM apontando para o banco de testes, criando-o se necessário e
 * recriando o schema do zero via migrations (down até o início + up).
 */
export async function initTestOrm(): Promise<MikroORM> {
  const orm = await MikroORM.init(
    createMikroOrmConfig({ dbName: testDatabaseName() }),
  );
  await orm.schema.ensureDatabase({ create: true });
  await orm.migrator.down({ to: 0 });
  await orm.migrator.up();
  return orm;
}

/** Executa SQL bruto com parâmetros posicionais `?`. */
export function sql<T = any>(
  orm: MikroORM,
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  return orm.em.getConnection().execute<T[]>(query, params);
}

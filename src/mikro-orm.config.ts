import 'reflect-metadata';
import { ReflectMetadataProvider } from '@mikro-orm/decorators/legacy';
import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { ENTITIES } from './infrastructure/persistence/entities';

/**
 * Construída sob demanda para que variáveis de ambiente carregadas depois do
 * import (ConfigModule, testes) sejam respeitadas.
 */
export const createMikroOrmConfig = (
  overrides: { dbName?: string; debug?: boolean } = {},
) =>
  defineConfig({
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5432),
    user: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    dbName: overrides.dbName ?? process.env.DATABASE_NAME,
    entities: ENTITIES,
    metadataProvider: ReflectMetadataProvider,
    extensions: [Migrator],
    migrations: {
      path: './src/migrations',
      pathTs: './src/migrations',
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
    debug: overrides.debug ?? false,
  });

export default createMikroOrmConfig();

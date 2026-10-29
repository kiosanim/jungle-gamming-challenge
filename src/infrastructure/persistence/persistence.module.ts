import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { UNIT_OF_WORK } from '../../application/ports/unit-of-work';
import { createMikroOrmConfig } from '../../mikro-orm.config';
import { MikroOrmUnitOfWork } from './mikro-orm-unit-of-work';

@Global()
@Module({
  providers: [
    {
      provide: MikroORM,
      useFactory: () => MikroORM.init(createMikroOrmConfig()),
    },
    {
      provide: UNIT_OF_WORK,
      useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm),
      inject: [MikroORM],
    },
  ],
  exports: [MikroORM, UNIT_OF_WORK],
})
export class PersistenceModule implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

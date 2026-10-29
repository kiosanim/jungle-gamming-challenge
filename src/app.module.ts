import { Module } from '@nestjs/common';
import { ApiModule } from './modules/api.module';
import { ConsumerModule } from './modules/consumer.module';
import { WorkersModule } from './modules/workers.module';

/**
 * Os três papéis num só processo: usado em desenvolvimento (`bun start`) e
 * nos testes. Em produção (Compose) cada papel roda na sua imagem, com o
 * módulo correspondente (`src/main-*.ts`).
 */
@Module({
  imports: [ApiModule, ConsumerModule, WorkersModule],
})
export class AppModule {}

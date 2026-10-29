import { Module } from '@nestjs/common';
import { WagerTransactionConsumerService } from '../infrastructure/messaging/wager-transaction-consumer.service';
import { CoreModule } from './core.module';
import { OpsModule } from './ops.module';

/** Papel consumidor: processa a fila FIFO de transações (sem rotas de negócio). */
@Module({
  imports: [CoreModule, OpsModule],
  providers: [WagerTransactionConsumerService],
})
export class ConsumerModule {}

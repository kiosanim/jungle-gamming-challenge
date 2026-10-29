import { bootstrap } from './bootstrap';
import { ConsumerModule } from './modules/consumer.module';

// Imagem `consumer`: consumidor da fila SQS de transações.
void bootstrap(ConsumerModule, 'wagering-consumer');

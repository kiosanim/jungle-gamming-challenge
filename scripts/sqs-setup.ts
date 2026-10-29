/**
 * Cria as filas FIFO do serviço no LocalStack/MiniStack (ou na AWS, conforme
 * o ambiente). Idempotente.
 *
 *   bun scripts/sqs-setup.ts
 */
import { ensureQueues } from '../src/infrastructure/messaging/queues';
import {
  createSqsClient,
  queueNames,
} from '../src/infrastructure/messaging/sqs';

async function main(): Promise<void> {
  const sqs = createSqsClient();
  try {
    await ensureQueues(sqs);
    console.log('Filas prontas:', Object.values(queueNames()).join(', '));
  } finally {
    sqs.destroy();
  }
}

void main();

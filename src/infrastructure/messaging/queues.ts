import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { queueNames } from './sqs';

/**
 * Entregas da fila de entrada antes de a mensagem ir para a DLQ. O consumidor
 * aplica o mesmo limite (e backoff via visibility timeout) para erros
 * transitórios.
 */
export const MAX_RECEIVE_COUNT = 5;

/**
 * Cria (idempotentemente) as filas FIFO do serviço. `CreateQueue` com os
 * mesmos atributos é no-op quando a fila já existe.
 */
export async function ensureQueues(
  sqs: SQSClient,
  names = queueNames(),
): Promise<void> {
  const dlq = await createFifoQueue(sqs, names.wagerTransactionsDlq);
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlq,
      AttributeNames: ['QueueArn'],
    }),
  );
  await createFifoQueue(sqs, names.wagerTransactions, {
    RedrivePolicy: JSON.stringify({
      deadLetterTargetArn: Attributes?.QueueArn,
      maxReceiveCount: String(MAX_RECEIVE_COUNT),
    }),
  });
  await createFifoQueue(sqs, names.outbox);
}

export async function createFifoQueue(
  sqs: SQSClient,
  name: string,
  attributes: Record<string, string> = {},
): Promise<string> {
  const { QueueUrl } = await sqs.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: { FifoQueue: 'true', ...attributes },
    }),
  );
  return QueueUrl!;
}

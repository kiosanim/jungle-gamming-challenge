import {
  DeleteMessageBatchCommand,
  DeleteQueueCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import { createFifoQueue } from '../../src/infrastructure/messaging/queues';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs';

export { createSqsClient };

/** Filas criadas por `createTestQueue`, apagadas por `deleteTestQueues`. */
const createdQueueUrls = new Set<string>();

/**
 * Fila FIFO exclusiva do teste, para não misturar mensagens entre testes.
 * Registrada para remoção: chame `deleteTestQueues` no `afterAll`.
 */
export async function createTestQueue(
  sqs: SQSClient,
  prefix: string,
): Promise<{ name: string; url: string }> {
  const name = `${prefix}-${randomUUID().slice(0, 8)}.fifo`;
  const url = await createFifoQueue(sqs, name);
  createdQueueUrls.add(url);
  return { name, url };
}

/**
 * Apaga as filas criadas por `createTestQueue` neste processo. O LocalStack
 * mantém filas e mensagens em memória; sem limpeza, cada execução da suíte
 * deixaria dezenas de filas para trás.
 */
export async function deleteTestQueues(sqs: SQSClient): Promise<void> {
  const urls = [...createdQueueUrls];
  createdQueueUrls.clear();
  await Promise.all(urls.map((url) => deleteQueue(sqs, url)));
}

/** Apaga filas pelo nome (ex.: criadas com `ensureQueues`). Ignora as inexistentes. */
export async function deleteQueuesByName(
  sqs: SQSClient,
  names: string[],
): Promise<void> {
  await Promise.all(
    names.map(async (QueueName) => {
      try {
        const { QueueUrl } = await sqs.send(
          new GetQueueUrlCommand({ QueueName }),
        );
        await deleteQueue(sqs, QueueUrl!);
      } catch {
        // fila já removida: nada a limpar
      }
    }),
  );
}

async function deleteQueue(sqs: SQSClient, url: string): Promise<void> {
  try {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  } catch {
    // fila já removida ou broker indisponível: limpeza é melhor esforço
  }
}

/** Recebe (e remove) todas as mensagens disponíveis na fila. */
export async function drainQueue(
  sqs: SQSClient,
  queueUrl: string,
): Promise<Message[]> {
  const received: Message[] = [];
  for (let emptyPolls = 0; emptyPolls < 2;) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['MessageGroupId'],
      }),
    );
    if (Messages.length === 0) {
      emptyPolls++;
      continue;
    }
    received.push(...Messages);
    await sqs.send(
      new DeleteMessageBatchCommand({
        QueueUrl: queueUrl,
        Entries: Messages.map((m, i) => ({
          Id: String(i),
          ReceiptHandle: m.ReceiptHandle!,
        })),
      }),
    );
  }
  return received;
}

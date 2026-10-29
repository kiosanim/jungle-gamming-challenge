import { SQSClient } from '@aws-sdk/client-sqs';

/*
 * Configuração do SQS com variáveis próprias do serviço (`SQS_*`), para não
 * herdar por acidente um `AWS_ENDPOINT_URL` ou credenciais globais da máquina.
 *
 * Com emulador (LocalStack/MiniStack), use `SQS_ENDPOINT_URL` (o padrão é
 * `http://localhost:4566`) e as credenciais estáticas de teste. Para a AWS
 * real, deixe `SQS_ENDPOINT_URL=` vazio: endpoint e credenciais vêm da cadeia
 * padrão do SDK (IAM role, perfil ou variáveis `AWS_*`).
 */

export const queueNames = () => ({
  /** Entrada de transações vindas dos provedores. */
  wagerTransactions:
    process.env.WAGER_TRANSACTIONS_QUEUE_NAME ?? 'wager-transactions.fifo',
  wagerTransactionsDlq:
    process.env.WAGER_TRANSACTIONS_DLQ_NAME ?? 'wager-transactions-dlq.fifo',
  /** Destino dos eventos de integração publicados pela outbox. */
  outbox: process.env.OUTBOX_QUEUE_NAME ?? 'wagering-events.fifo',
});

export function createSqsClient(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT_URL ?? 'http://localhost:4566';
  const region =
    process.env.SQS_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

  if (!endpoint) {
    return new SQSClient({ region });
  }
  return new SQSClient({
    region,
    endpoint,
    credentials: {
      accessKeyId: process.env.SQS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.SQS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

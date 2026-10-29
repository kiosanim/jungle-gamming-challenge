/**
 * Métricas de negócio e operação emitidas pela aplicação. A implementação
 * (Prometheus) fica na infraestrutura; testes usam `NOOP_METRICS`.
 */
export interface Metrics {
  /** Transação decidida (não conta replays). */
  transactionSettled(labels: {
    channel: 'http' | 'sqs' | 'worker';
    kind: string;
    status: string;
  }): void;
  duplicateDetected(type: 'idempotent_replay' | 'inbox_duplicate'): void;
  /** Disputa de concorrência: corrida de inserção, lock timeout, deadlock… */
  concurrencyConflict(reason: string): void;
  processingDuration(channel: 'http' | 'sqs', seconds: number): void;
  messageRetried(source: 'sqs' | 'outbox', count?: number): void;
  messageDeadLettered(reason: 'permanent' | 'exhausted'): void;
  outboxPublished(count: number, maxLagSeconds?: number): void;
  reconciliationChecked(consistent: boolean): void;
  /** Registros apagados pela rotina de retenção. */
  retentionPurged(table: 'outbox' | 'inbox', count: number): void;
}

export const METRICS = Symbol('Metrics');

export const NOOP_METRICS: Metrics = {
  transactionSettled: () => undefined,
  duplicateDetected: () => undefined,
  concurrencyConflict: () => undefined,
  processingDuration: () => undefined,
  messageRetried: () => undefined,
  messageDeadLettered: () => undefined,
  outboxPublished: () => undefined,
  reconciliationChecked: () => undefined,
  retentionPurged: () => undefined,
};

import { Clock } from './ports/clock';
import { Metrics, NOOP_METRICS } from './ports/metrics';
import { UnitOfWork } from './ports/unit-of-work';

const HOUR_MS = 3_600_000;

export interface RetentionPolicy {
  /** Idade mínima de uma mensagem **publicada** da outbox para ser apagada. */
  outboxRetentionMs: number;
  /**
   * Idade mínima de um registro da inbox para ser apagado. Deve cobrir a
   * janela em que o broker ainda pode reentregar a mensagem (retenção máxima
   * do SQS: 14 dias). Mesmo depois dela, uma reentrega não duplica efeito: a
   * submissão cai na idempotência de `wager_transaction` (replay).
   */
  inboxRetentionMs: number;
  /** Registros por transação de exclusão. */
  batchSize: number;
  /** Teto de lotes por tabela em cada execução. */
  maxBatches: number;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  outboxRetentionMs: 7 * 24 * HOUR_MS,
  inboxRetentionMs: 14 * 24 * HOUR_MS,
  batchSize: 1_000,
  maxBatches: 20,
};

export interface PurgeReport {
  outbox: number;
  inbox: number;
}

/**
 * Retenção da outbox e da inbox. Apaga, por idade, as mensagens da outbox que
 * já foram publicadas (as pendentes nunca) e os registros antigos da inbox.
 * Trabalha em lotes pequenos, cada um na sua transação, para não segurar
 * locks nem criar uma transação enorme. Pode rodar em várias instâncias ao
 * mesmo tempo graças ao `SKIP LOCKED`.
 */
export class PurgeExpiredMessagesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
    private readonly metrics: Metrics = NOOP_METRICS,
  ) {}

  async runOnce(): Promise<PurgeReport> {
    const now = this.clock.now().getTime();
    const outbox = await this.purge((limit) =>
      this.uow.run((ctx) =>
        ctx.outbox.deletePublishedBefore(
          new Date(now - this.policy.outboxRetentionMs),
          limit,
        ),
      ),
    );
    const inbox = await this.purge((limit) =>
      this.uow.run((ctx) =>
        ctx.inbox.deleteReceivedBefore(
          new Date(now - this.policy.inboxRetentionMs),
          limit,
        ),
      ),
    );
    if (outbox > 0) {
      this.metrics.retentionPurged('outbox', outbox);
    }
    if (inbox > 0) {
      this.metrics.retentionPurged('inbox', inbox);
    }
    return { outbox, inbox };
  }

  private async purge(
    deleteBatch: (limit: number) => Promise<number>,
  ): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < this.policy.maxBatches; batch++) {
      const deleted = await deleteBatch(this.policy.batchSize);
      total += deleted;
      if (deleted < this.policy.batchSize) {
        break;
      }
    }
    return total;
  }
}

/** Política a partir do ambiente (`OUTBOX_RETENTION_HOURS`, `INBOX_RETENTION_HOURS`). */
export function retentionPolicyFromEnv(): RetentionPolicy {
  const hours = (value: string | undefined, fallbackMs: number) =>
    value ? Number(value) * HOUR_MS : fallbackMs;
  return {
    ...DEFAULT_RETENTION_POLICY,
    outboxRetentionMs: hours(
      process.env.OUTBOX_RETENTION_HOURS,
      DEFAULT_RETENTION_POLICY.outboxRetentionMs,
    ),
    inboxRetentionMs: hours(
      process.env.INBOX_RETENTION_HOURS,
      DEFAULT_RETENTION_POLICY.inboxRetentionMs,
    ),
  };
}

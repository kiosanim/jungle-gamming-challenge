import { DomainError } from './domain-error';
import { IntegrationEvent } from './integration-event';

/** Operação sobre mensagem de outbox já publicada. */
export class OutboxMessageAlreadyPublishedError extends DomainError {
  override readonly name = 'OutboxMessageAlreadyPublishedError';

  constructor(readonly outboxMessageId: string) {
    super(`Mensagem de outbox ${outboxMessageId} já publicada`);
  }
}

/** Atraso da primeira retentativa. */
export const OUTBOX_RETRY_BASE_DELAY_MS = 1_000;
/** Teto do backoff: a outbox nunca desiste, apenas espaça as tentativas. */
export const OUTBOX_RETRY_MAX_DELAY_MS = 5 * 60_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
  /**
   * Contexto de rastreamento (W3C `traceparent`) de quem gerou o evento.
   * Metadado opaco de transporte: preenchido pela persistência e propagado
   * pelo publisher, não faz parte do envelope do evento.
   */
  traceContext?: string;
}

/**
 * Evento de integração aguardando publicação. Gravado na mesma transação SQL
 * do efeito financeiro e publicado depois do commit por um worker.
 *
 * O `id` é o próprio `eventId`: uma republicação após crash leva o mesmo id,
 * permitindo deduplicação no consumidor (entrega at-least-once).
 */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
    public readonly traceContext?: string,
  ) {}

  /** Pendente e devido imediatamente. */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      Object.freeze({ ...event.toJSON() }),
      event.occurredAt,
      0,
    );
  }

  /** Reconstrói a partir da persistência, sem revalidar transições. */
  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
      state.traceContext,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  /** Pendente e sem retentativa agendada para depois de `now`. */
  isDue(now: Date): boolean {
    return (
      this.isPending() &&
      (this._nextAttemptAt === undefined ||
        this._nextAttemptAt.getTime() <= now.getTime())
    );
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = at;
  }

  /**
   * Incrementa `attempts` e agenda a próxima tentativa com backoff
   * exponencial: base × 2^(attempts − 1), limitado ao teto. Sem jitter aqui
   * para manter o domínio determinístico; o worker pode adicioná-lo.
   */
  scheduleRetry(now: Date): void {
    this.assertPending();
    this._attempts += 1;
    const delay = Math.min(
      OUTBOX_RETRY_BASE_DELAY_MS * 2 ** (this._attempts - 1),
      OUTBOX_RETRY_MAX_DELAY_MS,
    );
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new OutboxMessageAlreadyPublishedError(this.id);
    }
  }
}

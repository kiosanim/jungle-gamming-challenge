import { DomainError } from './domain-error';

/** Evento construído a partir de agregados em estado incompatível. */
export class InvalidIntegrationEventError extends DomainError {
  override readonly name = 'InvalidIntegrationEventError';
}

/**
 * Metadados de rastreio de um evento. Ids e instante vêm de fora para manter
 * o domínio determinístico.
 */
export interface EventContext {
  eventId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventProps<T> extends EventContext {
  aggregateId: string;
  data: T;
}

/** Envelope serializado gravado no payload da outbox e publicado no broker. */
export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  /** ISO-8601 */
  occurredAt: string;
  version: number;
  data: T;
}

/**
 * Base dos eventos de integração. `eventType` e `version` são definidos no
 * tipo de cada subclasse, nunca em string solta no call site. `data` deve
 * conter apenas valores JSON (ex.: `MoneyProps`, nunca `Money`).
 *
 * `eventId` é a chave de deduplicação para consumidores: republicações do
 * mesmo evento carregam o mesmo id.
 */
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    if (!props.eventId || !props.aggregateId || !props.correlationId) {
      throw new InvalidIntegrationEventError(
        'eventId, aggregateId e correlationId são obrigatórios',
      );
    }
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze({ ...props.data });
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined && { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data as T,
    };
  }
}

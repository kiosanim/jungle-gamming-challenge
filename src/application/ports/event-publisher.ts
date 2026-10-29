import { OutboxMessage } from '../../domain/outbox-message';

export interface PublishResult {
  /** Ids das mensagens aceitas pelo broker. */
  published: string[];
  /** Ids das mensagens recusadas; serão retentadas com backoff. */
  failed: string[];
}

/**
 * Publica eventos de integração no broker. Pode falhar parcialmente; uma
 * exceção significa que nenhuma mensagem pode ser considerada publicada.
 */
export interface EventPublisher {
  publish(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}

export const EVENT_PUBLISHER = Symbol('EventPublisher');

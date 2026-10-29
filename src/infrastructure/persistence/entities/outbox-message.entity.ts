import {
  Check,
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { timestampColumn } from './column-types';

/**
 * Registro persistido do `OutboxMessage`.
 *
 * Há dois índices parciais sobre as mensagens não publicadas. O de `seq`
 * segue a ordem da reserva, para não ordenar o backlog inteiro a cada lote; com
 * ele, o custo da reserva não cresce com o tamanho da fila. O de
 * `(aggregate_id, seq)` responde "existe evento mais antigo desta wallet
 * pendente?", que é o que garante a ordem por wallet entre publishers
 * concorrentes. Sobre as já publicadas, o índice em `published_at` atende a
 * rotina de retenção.
 */
@Entity({ tableName: 'outbox_message' })
@Index({
  name: 'outbox_message_pending_idx',
  properties: ['seq'],
  where: 'published_at is null',
})
@Index({
  name: 'outbox_message_aggregate_pending_idx',
  properties: ['aggregateId', 'seq'],
  where: 'published_at is null',
})
@Index({
  name: 'outbox_message_published_idx',
  properties: ['publishedAt'],
  where: 'published_at is not null',
})
@Check({
  name: 'outbox_message_attempts_non_negative_ck',
  expression: 'attempts >= 0',
})
export class OutboxMessageEntity {
  /** Igual ao `eventId` do evento. */
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  /**
   * Ordem de inserção (sequência do banco). Todo evento de uma wallet é
   * gravado com o lock da wallet, então, por wallet, `seq` segue a ordem dos
   * commits. O `occurred_at` não serve para isso, porque vem do relógio de
   * cada instância e é lido antes do lock.
   */
  @Property({ type: 'bigint', autoincrement: true })
  seq!: string;

  @Property({ type: 'string', length: 128 })
  aggregateId!: string;

  @Property({ type: 'string', length: 128 })
  eventType!: string;

  @Property({ type: 'json' })
  payload!: Record<string, unknown>;

  @Property(timestampColumn())
  occurredAt!: Date;

  @Property({ type: 'integer' })
  attempts!: number;

  @Property(timestampColumn({ nullable: true }))
  nextAttemptAt?: Date;

  @Property(timestampColumn({ nullable: true }))
  publishedAt?: Date;

  /** `traceparent` W3C de quem gerou o evento (OpenTelemetry), se havia trace. */
  @Property({ type: 'string', length: 128, nullable: true })
  traceContext?: string | null;
}

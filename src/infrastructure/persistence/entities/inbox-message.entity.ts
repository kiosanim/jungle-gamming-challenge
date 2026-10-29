import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';
import { timestampColumn } from './column-types';

/**
 * Registro persistido do `InboxMessage`. A chave primária composta
 * `(consumer_name, message_id)` é a deduplicação persistente do consumidor.
 * `received_at` indexado para a rotina de retenção.
 */
@Entity({ tableName: 'inbox_message' })
@Index({ name: 'inbox_message_received_idx', properties: ['receivedAt'] })
export class InboxMessageEntity {
  @PrimaryKey({ type: 'string', length: 128 })
  consumerName!: string;

  @PrimaryKey({ type: 'string', length: 256 })
  messageId!: string;

  @Property({ type: 'string', length: 128 })
  payloadHash!: string;

  @Property(timestampColumn())
  receivedAt!: Date;

  @Property(timestampColumn({ nullable: true }))
  processedAt?: Date;
}

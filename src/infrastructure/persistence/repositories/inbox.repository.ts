import { EntityManager } from '@mikro-orm/postgresql';
import { InboxRepository } from '../../../application/ports/unit-of-work';
import { InboxMessage } from '../../../domain/inbox-message';

/** A chave primária `(consumer_name, message_id)` é a deduplicação. */
const INSERT_INBOX_MESSAGE = `
  insert into inbox_message (consumer_name,
                             message_id,
                             payload_hash,
                             received_at,
                             processed_at)
  values (?, ?, ?, ?, ?)
      on conflict (consumer_name, message_id) do nothing
`;

const MARK_INBOX_MESSAGE_PROCESSED = `
  update inbox_message
     set processed_at = ?
   where consumer_name = ?
     and message_id = ?
`;

/**
 * Lote de retenção pelo índice de `received_at`. `SKIP LOCKED`: workers de
 * retenção concorrentes apagam lotes disjuntos, sem espera.
 */
const DELETE_INBOX_RECEIVED_BEFORE = `
  delete from inbox_message
   where (consumer_name, message_id) in (select consumer_name,
                                                message_id
                                           from inbox_message
                                          where received_at < ?
                                          order by received_at
                                          limit ?
                                            for update skip locked)
`;

export class SqlInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async tryReceive(message: InboxMessage): Promise<boolean> {
    const { affectedRows } = await this.em.execute<{ affectedRows: number }>(
      INSERT_INBOX_MESSAGE,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        message.receivedAt,
        message.processedAt ?? null,
      ],
      'run',
    );
    return affectedRows === 1;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await this.em.execute(
      MARK_INBOX_MESSAGE_PROCESSED,
      [message.processedAt ?? null, message.consumerName, message.messageId],
      'run',
    );
  }

  async deleteReceivedBefore(cutoff: Date, limit: number): Promise<number> {
    const { affectedRows } = await this.em.execute<{ affectedRows: number }>(
      DELETE_INBOX_RECEIVED_BEFORE,
      [cutoff, limit],
      'run',
    );
    return affectedRows;
  }
}

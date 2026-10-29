import { EntityManager } from '@mikro-orm/postgresql';
import { OutboxRepository } from '../../../application/ports/unit-of-work';
import { OutboxMessage } from '../../../domain/outbox-message';
import { currentTraceparent } from '../../observability/tracing';
import { OutboxMessageEntity } from '../entities';
import { outboxMessageMapper } from '../mappers';

const INSERT_OUTBOX_MESSAGE = `
  insert into outbox_message (id,
                              aggregate_id,
                              event_type,
                              payload,
                              occurred_at,
                              attempts,
                              next_attempt_at,
                              published_at,
                              trace_context)
  values (?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?)
`;

/**
 * Cabeças: mensagens devidas para as quais não existe nenhuma mensagem mais
 * antiga (menor `seq`) do mesmo agregado ainda pendente, ou seja, no máximo
 * uma por wallet. Com `SKIP LOCKED`, linhas já reservadas por outro publisher
 * são puladas sem espera, e cada publisher recebe um lote disjunto. Enquanto
 * a cabeça de uma wallet estiver pendente (reservada ou em backoff), nenhuma
 * mensagem seguinte daquela wallet fica disponível para outro publisher.
 */
const CLAIM_HEAD_MESSAGES = `
  select o.id,
         o.seq,
         o.aggregate_id,
         o.event_type,
         o.payload,
         o.occurred_at,
         o.attempts,
         o.next_attempt_at,
         o.published_at,
         o.trace_context
    from outbox_message o
   where o.published_at is null
     and (o.next_attempt_at is null
          or o.next_attempt_at <= ?)
     and not exists (select 1
                       from outbox_message older
                      where older.aggregate_id = o.aggregate_id
                        and older.published_at is null
                        and older.seq < o.seq)
   order by o.seq
   limit ?
     for update skip locked
`;

/**
 * Seguintes: as próximas mensagens pendentes dos agregados cujas cabeças
 * foram reservadas, em ordem, formando um prefixo contíguo por wallet.
 * Ninguém mais pode tê-las reservado, já que a cabeça, mais antiga, está
 * pendente e é nossa; por isso o lock dispensa o `SKIP LOCKED`. O backoff de
 * uma seguinte é ignorado, porque ela sai depois da cabeça, e é isso que
 * importa para a ordem.
 */
const claimFollowerMessages = (aggregates: number) => `
  select id,
         seq,
         aggregate_id,
         event_type,
         payload,
         occurred_at,
         attempts,
         next_attempt_at,
         published_at,
         trace_context
    from outbox_message
   where aggregate_id in (${Array(aggregates).fill('?').join(', ')})
     and published_at is null
     and seq > ?
   order by seq
   limit ?
     for update
`;

const UPDATE_OUTBOX_MESSAGE = `
  update outbox_message
     set attempts = ?,
         next_attempt_at = ?,
         published_at = ?
   where id = ?
`;

/**
 * Lote de retenção, pelo índice parcial das mensagens publicadas. Com
 * `SKIP LOCKED`, workers de retenção concorrentes apagam lotes disjuntos sem
 * esperar uns pelos outros.
 */
const DELETE_OUTBOX_PUBLISHED_BEFORE = `
  delete from outbox_message
   where id in (select id
                  from outbox_message
                 where published_at is not null
                   and published_at < ?
                 order by published_at
                 limit ?
                   for update skip locked)
`;

interface OutboxRow {
  id: string;
  /** `bigint` chega do driver como string. */
  seq: string;
  aggregate_id: string;
}

export class SqlOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(message: OutboxMessage): Promise<void> {
    const r = outboxMessageMapper.toRecord(message);
    await this.em.execute(INSERT_OUTBOX_MESSAGE, [
      r.id,
      r.aggregateId,
      r.eventType,
      JSON.stringify(r.payload),
      r.occurredAt,
      r.attempts,
      r.nextAttemptAt ?? null,
      r.publishedAt ?? null,
      // O trace de quem gerou o evento (requisição, mensagem, worker).
      r.traceContext ?? currentTraceparent() ?? null,
    ]);
  }

  async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
    const heads = await this.em.execute<OutboxRow[]>(CLAIM_HEAD_MESSAGES, [
      now,
      limit,
    ]);
    let rows = heads;
    if (heads.length > 0 && heads.length < limit) {
      const aggregates = heads.map((row) => row.aggregate_id);
      const headIds = new Set(heads.map((row) => row.id));
      const minHeadSeq = heads.reduce(
        (min, row) => (BigInt(row.seq) < min ? BigInt(row.seq) : min),
        BigInt(heads[0].seq),
      );
      const followers = await this.em.execute<OutboxRow[]>(
        claimFollowerMessages(aggregates.length),
        [...aggregates, minHeadSeq.toString(), limit - heads.length],
      );
      rows = [...heads, ...followers.filter((row) => !headIds.has(row.id))];
    }
    // Ordem global por `seq`: dentro do lote, cada wallet sai na ordem dos
    // commits (o SQS FIFO preserva a ordem das entradas de um mesmo grupo).
    rows.sort((a, b) => (BigInt(a.seq) < BigInt(b.seq) ? -1 : 1));
    return rows.map((row) =>
      outboxMessageMapper.toDomain(this.em.map(OutboxMessageEntity, row)),
    );
  }

  async update(message: OutboxMessage): Promise<void> {
    const r = outboxMessageMapper.toRecord(message);
    await this.em.execute(
      UPDATE_OUTBOX_MESSAGE,
      [r.attempts, r.nextAttemptAt ?? null, r.publishedAt ?? null, r.id],
      'run',
    );
  }

  async deletePublishedBefore(cutoff: Date, limit: number): Promise<number> {
    const { affectedRows } = await this.em.execute<{ affectedRows: number }>(
      DELETE_OUTBOX_PUBLISHED_BEFORE,
      [cutoff, limit],
      'run',
    );
    return affectedRows;
  }
}

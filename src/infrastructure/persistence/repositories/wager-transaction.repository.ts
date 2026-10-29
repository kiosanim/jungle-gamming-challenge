import {
  EntityManager,
  UniqueConstraintViolationException,
} from '@mikro-orm/postgresql';
import { DuplicateTransactionError } from '../../../application/errors';
import {
  DuePendingReference,
  WagerTransactionRepository,
} from '../../../application/ports/unit-of-work';
import { WagerTransaction } from '../../../domain/wager-transaction';
import { currentTraceparent } from '../../observability/tracing';
import { WagerTransactionEntity } from '../entities';
import { wagerTransactionMapper } from '../mappers';

const INSERT_TRANSACTION = `
  insert into wager_transaction (id,
                                 provider_id,
                                 external_transaction_id,
                                 idempotency_key,
                                 payload_hash,
                                 wallet_id,
                                 player_id,
                                 round_id,
                                 game_id,
                                 kind,
                                 amount,
                                 currency,
                                 reference_external_transaction_id,
                                 reference_transaction_id,
                                 status,
                                 failure_code,
                                 created_at,
                                 processed_at,
                                 balance_after,
                                 reference_attempts,
                                 next_reference_check_at,
                                 trace_context)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Só colunas de estado: os campos de negócio são imutáveis (trigger). */
const UPDATE_TRANSACTION_STATE = `
  update wager_transaction
     set status = ?,
         reference_transaction_id = ?,
         failure_code = ?,
         processed_at = ?,
         balance_after = ?,
         reference_attempts = ?,
         next_reference_check_at = ?
   where id = ?
`;

const SELECT_PROCESSED_REVERSAL = `
  select 1
    from wager_transaction
   where reference_transaction_id = ?
     and kind in ('REFUND', 'ROLLBACK')
     and status = 'PROCESSED'
   limit 1
`;

/** Servido pelo índice parcial `wager_transaction_pending_reference_idx`. */
const SELECT_DUE_PENDING_REFERENCES = `
  select id,
         trace_context
    from wager_transaction
   where status = 'PENDING_REFERENCE'
     and next_reference_check_at <= ?
   order by next_reference_check_at
   limit ?
`;

/** A moeda da wallet acompanha a linha para reidratar `balance_after`. */
const SELECT_TRANSACTION = `
  select t.id,
         t.provider_id,
         t.external_transaction_id,
         t.idempotency_key,
         t.payload_hash,
         t.wallet_id,
         t.player_id,
         t.round_id,
         t.game_id,
         t.kind,
         t.amount,
         t.currency,
         t.reference_external_transaction_id,
         t.reference_transaction_id,
         t.status,
         t.failure_code,
         t.created_at,
         t.processed_at,
         t.balance_after,
         t.reference_attempts,
         t.next_reference_check_at,
         w.currency as wallet_currency
    from wager_transaction t
    join wallet w on w.id = t.wallet_id
`;

const SELECT_BY_ID = `${SELECT_TRANSACTION} where t.id = ?`;

const SELECT_BY_IDEMPOTENCY_KEY_OR_EXTERNAL_ID = `${SELECT_TRANSACTION}
   where t.provider_id = ?
     and (t.idempotency_key = ?
          or t.external_transaction_id = ?)`;

const SELECT_BY_EXTERNAL_ID = `${SELECT_TRANSACTION}
   where t.provider_id = ?
     and t.external_transaction_id = ?`;

/**
 * Constraints que indicam que outra instância gravou a mesma transação (ou
 * a mesma reversão) primeiro. Repetir a operação a transforma em replay
 * (ou em `REFERENCE_ALREADY_REVERSED`).
 */
const DUPLICATE_CONSTRAINTS = new Set([
  'wager_transaction_provider_idempotency_key_uq',
  'wager_transaction_provider_external_uq',
  'wager_transaction_single_reversal_uq',
]);

export class SqlWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async insert(transaction: WagerTransaction): Promise<void> {
    const r = wagerTransactionMapper.toRecord(transaction);
    try {
      await this.em.execute(INSERT_TRANSACTION, [
        r.id,
        r.providerId,
        r.externalTransactionId,
        r.idempotencyKey,
        r.payloadHash,
        r.walletId,
        r.playerId,
        r.roundId,
        r.gameId,
        r.kind,
        r.amount,
        r.currency,
        r.referenceExternalTransactionId ?? null,
        r.referenceTransactionId ?? null,
        r.status,
        r.failureCode ?? null,
        r.createdAt,
        r.processedAt ?? null,
        r.balanceAfter ?? null,
        r.referenceAttempts,
        r.nextReferenceCheckAt ?? null,
        // O trace de quem criou a transação (requisição ou mensagem).
        currentTraceparent() ?? null,
      ]);
    } catch (error) {
      this.translateDuplicate(error, transaction);
      throw error;
    }
  }

  async update(transaction: WagerTransaction): Promise<void> {
    const r = wagerTransactionMapper.toRecord(transaction);
    try {
      await this.em.execute(
        UPDATE_TRANSACTION_STATE,
        [
          r.status,
          r.referenceTransactionId ?? null,
          r.failureCode ?? null,
          r.processedAt ?? null,
          r.balanceAfter ?? null,
          r.referenceAttempts,
          r.nextReferenceCheckAt ?? null,
          r.id,
        ],
        'run',
      );
    } catch (error) {
      this.translateDuplicate(error, transaction);
      throw error;
    }
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const rows = await this.em.execute(SELECT_PROCESSED_REVERSAL, [
      referenceTransactionId,
    ]);
    return rows.length > 0;
  }

  async findDuePendingReferences(
    now: Date,
    limit: number,
  ): Promise<DuePendingReference[]> {
    const rows = await this.em.execute<
      { id: string; trace_context: string | null }[]
    >(SELECT_DUE_PENDING_REFERENCES, [now, limit]);
    return rows.map((row) => ({
      id: row.id,
      ...(row.trace_context && { traceContext: row.trace_context }),
    }));
  }

  private translateDuplicate(
    error: unknown,
    transaction: WagerTransaction,
  ): void {
    const constraint = (error as { constraint?: string }).constraint;
    if (
      error instanceof UniqueConstraintViolationException &&
      constraint !== undefined &&
      DUPLICATE_CONSTRAINTS.has(constraint)
    ) {
      throw new DuplicateTransactionError(
        `Transação ${transaction.providerId}/${transaction.externalTransactionId} gravada concorrentemente`,
      );
    }
  }

  findById(id: string): Promise<WagerTransaction | undefined> {
    return this.selectOne(SELECT_BY_ID, [id]);
  }

  async findByIdempotencyKeyOrExternalId(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]> {
    const rows = await this.em.execute(
      SELECT_BY_IDEMPOTENCY_KEY_OR_EXTERNAL_ID,
      [providerId, idempotencyKey, externalTransactionId],
    );
    return rows.map((row) => this.toDomain(row));
  }

  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    return this.selectOne(SELECT_BY_EXTERNAL_ID, [
      providerId,
      externalTransactionId,
    ]);
  }

  private async selectOne(
    query: string,
    params: unknown[],
  ): Promise<WagerTransaction | undefined> {
    const [row] = await this.em.execute(query, params);
    return row ? this.toDomain(row) : undefined;
  }

  private toDomain(row: Record<string, unknown>): WagerTransaction {
    const { wallet_currency: walletCurrency, ...columns } = row;
    return wagerTransactionMapper.toDomain(
      this.em.map(WagerTransactionEntity, columns),
      walletCurrency as string,
    );
  }
}

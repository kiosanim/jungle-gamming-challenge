import {
  Check,
  Entity,
  Enum,
  Index,
  ManyToOne,
  PrimaryKey,
  Property,
  Trigger,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { FailureCode } from '../../../domain/failure-code';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../../domain/wager-transaction';
import { currencyColumn, moneyColumn, timestampColumn } from './column-types';
import { WalletEntity } from './wallet.entity';

/**
 * Registro persistido da `WagerTransaction`.
 *
 * O schema garante a idempotência com `(provider_id, external_transaction_id)`
 * e `(provider_id, idempotency_key)` únicos, e permite no máximo um
 * `REFUND`/`ROLLBACK` por transação referenciada. Checks mantêm kind,
 * referência, status, `failure_code` e `processed_at` coerentes entre si. Um
 * trigger cuida da imutabilidade: campos de negócio nunca mudam, estados
 * terminais não transicionam e nenhuma linha é excluída.
 */
@Entity({ tableName: 'wager_transaction' })
@Unique({
  name: 'wager_transaction_provider_external_uq',
  properties: ['providerId', 'externalTransactionId'],
})
@Unique({
  name: 'wager_transaction_provider_idempotency_key_uq',
  properties: ['providerId', 'idempotencyKey'],
})
@Unique({
  name: 'wager_transaction_single_reversal_uq',
  properties: ['referenceTransactionId'],
  where: "kind in ('REFUND', 'ROLLBACK')",
})
@Index({
  name: 'wager_transaction_pending_reference_idx',
  properties: ['nextReferenceCheckAt'],
  where: "status = 'PENDING_REFERENCE'",
})
@Check({
  name: 'wager_transaction_reference_schedule_ck',
  expression:
    "reference_attempts >= 0 and (status <> 'PENDING_REFERENCE' or next_reference_check_at is not null)",
})
@Check({
  name: 'wager_transaction_amount_ck',
  expression: "amount > 0 or (kind = 'LOSS' and amount = 0)",
})
@Check({
  name: 'wager_transaction_currency_format_ck',
  expression: "currency ~ '^[A-Z]{3}$'",
})
@Check({
  name: 'wager_transaction_reference_required_ck',
  expression:
    "kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null",
})
@Check({
  name: 'wager_transaction_reference_forbidden_ck',
  expression:
    "kind not in ('BET', 'OPENING') or reference_external_transaction_id is null",
})
@Check({
  name: 'wager_transaction_processed_at_ck',
  expression: "(status = 'PROCESSED') = (processed_at is not null)",
})
@Check({
  name: 'wager_transaction_failure_code_ck',
  expression: "(status in ('REJECTED', 'FAILED')) = (failure_code is not null)",
})
@Check({
  name: 'wager_transaction_resolved_reference_ck',
  expression:
    'reference_transaction_id is null or ' +
    "(status = 'PROCESSED' and reference_external_transaction_id is not null and reference_transaction_id <> id)",
})
@Check({
  name: 'wager_transaction_processed_reference_ck',
  expression:
    "status <> 'PROCESSED' or reference_external_transaction_id is null or reference_transaction_id is not null",
})
@Check({
  name: 'wager_transaction_balance_after_ck',
  expression:
    "(balance_after is null or balance_after >= 0) and (status <> 'PROCESSED' or balance_after is not null)",
})
@Trigger({
  name: 'immutable_trg',
  timing: 'before',
  events: ['update', 'delete'],
  forEach: 'row',
  body: `
    if tg_op = 'DELETE' then
      raise exception 'wager_transaction é imutável: delete proibido (id=%)', old.id
        using errcode = 'restrict_violation';
    end if;
    if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
      raise exception 'wager_transaction % em estado terminal %', old.id, old.status
        using errcode = 'restrict_violation';
    end if;
    if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key,
        new.payload_hash, new.wallet_id, new.player_id, new.round_id, new.game_id,
        new.kind, new.amount, new.currency, new.reference_external_transaction_id,
        new.created_at)
       is distinct from
       (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key,
        old.payload_hash, old.wallet_id, old.player_id, old.round_id, old.game_id,
        old.kind, old.amount, old.currency, old.reference_external_transaction_id,
        old.created_at) then
      raise exception 'wager_transaction %: campos de negócio são imutáveis', old.id
        using errcode = 'restrict_violation';
    end if;
    return new;
  `,
})
export class WagerTransactionEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 128 })
  providerId!: string;

  @Property({ type: 'string', length: 128 })
  externalTransactionId!: string;

  @Property({ type: 'string', length: 256 })
  idempotencyKey!: string;

  @Property({ type: 'string', length: 128 })
  payloadHash!: string;

  @ManyToOne(() => WalletEntity, {
    mapToPk: true,
    fieldName: 'wallet_id',
    deleteRule: 'restrict',
  })
  walletId!: string;

  @Property({ type: 'string', length: 128 })
  playerId!: string;

  @Property({ type: 'string', length: 128 })
  roundId!: string;

  @Property({ type: 'string', length: 128 })
  gameId!: string;

  @Enum({ items: () => WagerTransactionKind })
  kind!: WagerTransactionKind;

  @Property(moneyColumn())
  amount!: string;

  @Property(currencyColumn())
  currency!: string;

  /** id no provedor, e não o id interno */
  @Property({ type: 'string', length: 128, nullable: true })
  referenceExternalTransactionId?: string;

  @ManyToOne(() => WagerTransactionEntity, {
    mapToPk: true,
    fieldName: 'reference_transaction_id',
    nullable: true,
    deleteRule: 'restrict',
  })
  referenceTransactionId?: string;

  @Enum({ items: () => WagerTransactionStatus })
  status!: WagerTransactionStatus;

  @Enum({ items: () => FailureCode, nullable: true })
  failureCode?: FailureCode;

  @Property(timestampColumn())
  createdAt!: Date;

  @Property(timestampColumn({ nullable: true }))
  processedAt?: Date;

  /**
   * Saldo da wallet observado na decisão (moeda da wallet). Devolvido nos
   * replays idempotentes.
   */
  @Property({ ...moneyColumn(), nullable: true })
  balanceAfter?: string;

  /** Verificações de referência já feitas (backoff do `PENDING_REFERENCE`). */
  @Property({ type: 'integer', default: 0 })
  referenceAttempts!: number;

  @Property(timestampColumn({ nullable: true }))
  nextReferenceCheckAt?: Date;

  /**
   * `traceparent` W3C da requisição ou mensagem que criou a transação. Quando
   * ela fica em `PENDING_REFERENCE`, o worker que a resolve continua esse
   * mesmo trace.
   */
  @Property({ type: 'string', length: 128, nullable: true })
  traceContext?: string | null;
}

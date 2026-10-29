import { DomainError } from './domain-error';
import {
  FAILURE_CODE_CATEGORY,
  FailureCategory,
  FailureCode,
} from './failure-code';
import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  /** Interno: crédito de abertura da wallet. Nunca aceito via API ou fila. */
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  /** Aceita, ainda não aplicada. */
  Pending = 'PENDING',
  /** Aguardando a transação referenciada. */
  PendingReference = 'PENDING_REFERENCE',
  /** Aplicada (terminal). */
  Processed = 'PROCESSED',
  /** Violação de regra de negócio (terminal). */
  Rejected = 'REJECTED',
  /** Erro permanente de infraestrutura (terminal, auditável). */
  Failed = 'FAILED',
}

/** Payload estruturalmente inválido para criar uma transação. */
export class InvalidWagerTransactionError extends DomainError {
  override readonly name = 'InvalidWagerTransactionError';
}

/** Transição de status não permitida. É erro de programação, não um caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  override readonly name = 'InvalidTransactionStateError';

  constructor(
    readonly transactionId: string,
    readonly from: WagerTransactionStatus,
    readonly attempted: string,
  ) {
    super(
      `Transição inválida na transação ${transactionId}: ${attempted} a partir de ${from}`,
    );
  }
}

/** Provider usado pelas transações internas (`OPENING`). */
export const INTERNAL_PROVIDER_ID = 'internal';

/*
 * Espera por referência fora de ordem (`PENDING_REFERENCE`).
 *
 * Reentregas fora de ordem, pela fila ou por HTTP, costumam se resolver em
 * segundos. Se já se passaram minutos, a referência provavelmente nunca vem.
 * Por isso o backoff é exponencial, começa em 1s e fica limitado a 60s entre
 * verificações, e há um TTL de 15 minutos a partir da criação. Quando o TTL
 * acaba, a transação é rejeitada com `REFERENCE_NOT_FOUND` (ou
 * `REFERENCE_NOT_PROCESSED`, se a referência existe mas nunca foi concluída).
 */
export const PENDING_REFERENCE_BASE_DELAY_MS = 1_000;
export const PENDING_REFERENCE_MAX_DELAY_MS = 60_000;
export const PENDING_REFERENCE_TTL_MS = 15 * 60_000;

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
}

export interface OpeningTransactionProps {
  id: string;
  walletId: string;
  playerId: string;
  money: Money;
  at: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  balanceAfter?: Money;
  referenceAttempts?: number;
  nextReferenceCheckAt?: Date;
}

const TERMINAL_STATUSES: ReadonlySet<WagerTransactionStatus> = new Set([
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
]);

/** Kinds que cada operação pode referenciar. */
const ALLOWED_REFERENCE_KINDS: Partial<
  Record<WagerTransactionKind, ReadonlySet<WagerTransactionKind>>
> = {
  [WagerTransactionKind.Win]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Loss]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Refund]: new Set([WagerTransactionKind.Bet]),
  [WagerTransactionKind.Rollback]: new Set([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ]),
};

/**
 * Operação de aposta recebida de um provedor.
 *
 * Transições válidas:
 * - `PENDING` → `PROCESSED` | `PENDING_REFERENCE` | `REJECTED` | `FAILED`
 * - `PENDING_REFERENCE` → `PROCESSED` | `REJECTED` | `FAILED`
 * - `PROCESSED`, `REJECTED`, `FAILED`: terminais.
 */
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor, e não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _balanceAfter?: Money,
    private _referenceAttempts = 0,
    private _nextReferenceCheckAt?: Date,
  ) {}

  /**
   * Nasce em `PENDING`. Regras:
   * - `OPENING` não é criado por aqui (para isso existe `opening`);
   * - `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`;
   * - `BET` não aceita referência, e `WIN`/`LOSS` podem referenciar a `BET`;
   * - os kinds que movem saldo exigem valor positivo, e `LOSS` aceita zero.
   */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    WagerTransaction.assertValidCreation(props);
    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
    );
  }

  /**
   * Transação interna de crédito de abertura, já `PROCESSED`. A chave
   * `(internal, opening:{walletId})` garante no banco uma única abertura por
   * wallet. O `payloadHash` é fixo porque a abertura nunca passa pela
   * comparação de idempotência dos provedores.
   */
  static opening(props: OpeningTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(
        `crédito de abertura deve ser positivo: ${props.money.toString()}`,
      );
    }
    const externalTransactionId = `opening:${props.walletId}`;
    const transaction = new WagerTransaction(
      props.id,
      INTERNAL_PROVIDER_ID,
      externalTransactionId,
      `${INTERNAL_PROVIDER_ID}:${externalTransactionId}`,
      INTERNAL_PROVIDER_ID,
      props.walletId,
      props.playerId,
      externalTransactionId,
      INTERNAL_PROVIDER_ID,
      WagerTransactionKind.Opening,
      props.money,
      undefined,
      props.at,
      WagerTransactionStatus.Pending,
    );
    transaction.markProcessed(undefined, props.at, props.money);
    return transaction;
  }

  /** Reconstrói a partir da persistência, sem revalidar transições. */
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.balanceAfter,
      state.referenceAttempts ?? 0,
      state.nextReferenceCheckAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /**
   * Saldo da wallet no momento em que a transação foi decidida. É o que um
   * replay idempotente devolve: o saldo daquele momento, e não o atual.
   */
  get balanceAfter(): Money | undefined {
    return this._balanceAfter;
  }

  /** Verificações de referência já feitas além da primeira (backoff). */
  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  /** Quando o worker deve procurar a referência de novo (só em `PENDING_REFERENCE`). */
  get nextReferenceCheckAt(): Date | undefined {
    return this._nextReferenceCheckAt;
  }

  // ---- transições

  /**
   * Aplicada. Exige o id interno da referência quando há referência externa
   * e o saldo resultante da wallet.
   */
  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    balanceAfter: Money,
  ): void {
    this.assertNotTerminal('markProcessed');
    this.assertValidBalance(balanceAfter, 'markProcessed');
    const hasExternalReference =
      this.referenceExternalTransactionId !== undefined;
    if (hasExternalReference !== (referenceTransactionId !== undefined)) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        hasExternalReference
          ? 'markProcessed sem a referência resolvida'
          : 'markProcessed com referência em transação sem referência',
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._balanceAfter = balanceAfter;
    this._nextReferenceCheckAt = undefined;
  }

  /**
   * A referência ainda não chegou (ou não foi concluída). Só vale a partir de
   * `PENDING`, e já agenda a primeira verificação do worker.
   */
  markPendingReference(at: Date): void {
    this.assertNotTerminal('markPendingReference');
    if (
      this._status !== WagerTransactionStatus.Pending ||
      this.referenceExternalTransactionId === undefined
    ) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        'markPendingReference',
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._referenceAttempts = 0;
    this._nextReferenceCheckAt = new Date(
      at.getTime() + PENDING_REFERENCE_BASE_DELAY_MS,
    );
  }

  /**
   * A referência continua ausente: incrementa as tentativas e agenda a
   * próxima verificação com backoff exponencial (base × 2^tentativas, até o teto).
   */
  scheduleReferenceRetry(now: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        'scheduleReferenceRetry',
      );
    }
    this._referenceAttempts += 1;
    const delay = Math.min(
      PENDING_REFERENCE_BASE_DELAY_MS * 2 ** this._referenceAttempts,
      PENDING_REFERENCE_MAX_DELAY_MS,
    );
    this._nextReferenceCheckAt = new Date(now.getTime() + delay);
  }

  /** O TTL de espera pela referência se esgotou. */
  isReferenceWaitExpired(now: Date): boolean {
    return now.getTime() - this.createdAt.getTime() >= PENDING_REFERENCE_TTL_MS;
  }

  /**
   * Violação de regra de negócio. Aceita apenas códigos de rejeição.
   * `balanceAfter` é o saldo (inalterado) observado na decisão, quando houver.
   */
  reject(code: FailureCode, balanceAfter?: Money): void {
    this.assertNotTerminal('reject');
    this.assertCategory(code, FailureCategory.Rejection, 'reject');
    if (balanceAfter) {
      this.assertValidBalance(balanceAfter, 'reject');
    }
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._balanceAfter = balanceAfter;
    this._nextReferenceCheckAt = undefined;
  }

  /** Erro permanente de infraestrutura. Aceita apenas códigos de falha. */
  fail(code: FailureCode): void {
    this.assertNotTerminal('fail');
    this.assertCategory(code, FailureCategory.Failure, 'fail');
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._nextReferenceCheckAt = undefined;
  }

  // ---- consultas de domínio

  isTerminal(): boolean {
    return TERMINAL_STATUSES.has(this._status);
  }

  /** `LOSS` apenas registra o resultado; os demais kinds movem saldo. */
  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /**
   * Direção do lançamento: `BET` debita; `OPENING`, `WIN` e `REFUND` creditam;
   * `ROLLBACK` aplica o inverso da referência. `LOSS` não gera lançamento.
   */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference || this.checkReference(reference) !== undefined) {
          throw new InvalidWagerTransactionError(
            'ROLLBACK exige uma referência válida para definir a direção',
          );
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS não gera lançamento');
    }
  }

  /**
   * Valida a transação referenciada (já resolvida por
   * `(providerId, referenceExternalTransactionId)`). Retorna o código de
   * rejeição ou `undefined` se a referência é aceitável. A unicidade da
   * reversão depende de estado externo e é verificada pelo use case/banco.
   */
  checkReference(reference: WagerTransaction): FailureCode | undefined {
    const allowedKinds = ALLOWED_REFERENCE_KINDS[this.kind];
    if (
      reference.id === this.id ||
      reference.externalTransactionId !== this.referenceExternalTransactionId
    ) {
      throw new InvalidWagerTransactionError(
        'a referência informada não corresponde a referenceExternalTransactionId',
      );
    }
    if (!allowedKinds?.has(reference.kind)) {
      return FailureCode.ReferenceKindNotAllowed;
    }
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    ) {
      return FailureCode.ReferenceMismatch;
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }
    if (this.requiresReference() && !reference.money.equals(this.money)) {
      return FailureCode.ReversalAmountMismatch;
    }
    return undefined;
  }

  /**
   * Código para saldo insuficiente: aposta sem saldo e reversão que deixaria
   * o saldo negativo são situações operacionalmente distintas.
   */
  insufficientFundsCode(): FailureCode {
    return this.requiresReference()
      ? FailureCode.ReversalInsufficientFunds
      : FailureCode.InsufficientFunds;
  }

  private assertValidBalance(balance: Money, attempted: string): void {
    if (balance.isNegative()) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        `${attempted} com saldo negativo ${balance.toString()}`,
      );
    }
  }

  private assertNotTerminal(attempted: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this.id, this._status, attempted);
    }
  }

  private assertCategory(
    code: FailureCode,
    expected: FailureCategory,
    attempted: string,
  ): void {
    if (FAILURE_CODE_CATEGORY[code] !== expected) {
      throw new InvalidTransactionStateError(
        this.id,
        this._status,
        `${attempted} com código ${code} de categoria ${FAILURE_CODE_CATEGORY[code]}`,
      );
    }
  }

  private static assertValidCreation(props: CreateWagerTransactionProps): void {
    const required = [
      'id',
      'providerId',
      'externalTransactionId',
      'idempotencyKey',
      'payloadHash',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
    ] as const;
    for (const field of required) {
      if (!props[field]) {
        throw new InvalidWagerTransactionError(`${field} é obrigatório`);
      }
    }

    const { kind, money, referenceExternalTransactionId } = props;

    if (!Object.values(WagerTransactionKind).includes(kind)) {
      throw new InvalidWagerTransactionError(
        `kind desconhecido: ${String(kind)}`,
      );
    }
    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'OPENING é interno e não pode ser submetido',
      );
    }

    const needsReference =
      kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback;
    if (needsReference && !referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(
        `${kind} exige referenceExternalTransactionId`,
      );
    }
    if (
      kind === WagerTransactionKind.Bet &&
      referenceExternalTransactionId !== undefined
    ) {
      throw new InvalidWagerTransactionError('BET não aceita referência');
    }
    if (referenceExternalTransactionId === props.externalTransactionId) {
      throw new InvalidWagerTransactionError(
        'a transação não pode referenciar a si mesma',
      );
    }
    if (referenceExternalTransactionId === '') {
      throw new InvalidWagerTransactionError(
        'referenceExternalTransactionId não pode ser vazio',
      );
    }

    if (money.isNegative()) {
      throw new InvalidWagerTransactionError('valor não pode ser negativo');
    }
    if (kind !== WagerTransactionKind.Loss && money.isZero()) {
      throw new InvalidWagerTransactionError(`${kind} exige valor positivo`);
    }
  }
}

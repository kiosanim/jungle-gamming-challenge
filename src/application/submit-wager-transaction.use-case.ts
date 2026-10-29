import { InboxMessage } from '../domain/inbox-message';
import { Money } from '../domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
} from '../domain/wager-transaction';
import {
  DuplicateTransactionError,
  IdempotencyConflictError,
  WalletNotFoundError,
} from './errors';
import { computePayloadHash } from './payload-hash';
import { Clock } from './ports/clock';
import { IdGenerator } from './ports/id-generator';
import { Metrics, NOOP_METRICS } from './ports/metrics';
import { NOOP_TRACER, Tracer } from './ports/tracer';
import { TransactionalContext, UnitOfWork } from './ports/unit-of-work';
import { WagerSettlement } from './wager-settlement';

export interface SubmitWagerTransactionCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  correlationId: string;
  /** Mensagem que originou a operação (ex.: messageId do SQS). */
  causationId?: string;
  /**
   * Presente quando a operação vem de uma fila: a mensagem é registrada na
   * inbox na mesma transação SQL do efeito financeiro.
   */
  inbox?: { consumerName: string; messageId: string };
}

export interface SubmitWagerTransactionResult {
  transaction: WagerTransaction;
  /** `true` quando a resposta é a do processamento original. */
  idempotentReplay: boolean;
  /** `true` quando a mesma mensagem (inbox) já tinha sido processada. */
  duplicateMessage?: boolean;
}

/** Tentativas da operação inteira quando outra instância vence a corrida de inserção. */
const MAX_ATTEMPTS = 2;

/**
 * Processa uma operação de aposta. É a mesma porta de entrada para HTTP e SQS.
 *
 * Tudo acontece numa única transação SQL:
 * 1. Idempotência: a mesma `(provider, idempotencyKey)` com o mesmo
 *    `payloadHash` devolve o resultado original; com outro payload, lança
 *    `IdempotencyConflictError`.
 * 2. `SELECT … FOR UPDATE` na wallet, que serializa as operações da mesma
 *    wallet entre instâncias enquanto wallets diferentes seguem em paralelo.
 * 3. Nova verificação de idempotência depois do lock, porque uma requisição
 *    idêntica pode ter sido confirmada enquanto esta esperava.
 * 4. Liquidação pelo `WagerSettlement` (regras de negócio, resolução da
 *    referência ou `PENDING_REFERENCE`), gravação da transação, atualização
 *    condicional do saldo, lançamento no ledger e eventos na outbox.
 *
 * A garantia final é a unicidade no banco. Se outra instância inserir a mesma
 * transação entre esses passos, a inserção falha, tudo é desfeito e a
 * operação é repetida, virando replay.
 */
export class SubmitWagerTransactionUseCase {
  private readonly settlement: WagerSettlement;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics = NOOP_METRICS,
    tracer: Tracer = NOOP_TRACER,
  ) {
    this.settlement = new WagerSettlement(ids, tracer);
  }

  async execute(
    command: SubmitWagerTransactionCommand,
  ): Promise<SubmitWagerTransactionResult> {
    const payloadHash = computePayloadHash({
      ...command,
      money: command.money.toJSON(),
    });

    for (let attempt = 1; ; attempt++) {
      try {
        return await this.uow.run((ctx) =>
          this.process(ctx, command, payloadHash),
        );
      } catch (error) {
        if (
          error instanceof DuplicateTransactionError &&
          attempt < MAX_ATTEMPTS
        ) {
          this.metrics.concurrencyConflict('DuplicateTransactionError');
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Com inbox: registra a mensagem antes de tudo (deduplicação persistente
   * por `(consumerName, messageId)`) e a marca como processada no fim, tudo
   * na mesma transação SQL. Se a transação for desfeita, a mensagem volta a
   * ser inédita e a reentrega a processa.
   */
  private async process(
    ctx: TransactionalContext,
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionResult> {
    if (!command.inbox) {
      return this.processOperation(ctx, command, payloadHash);
    }

    const message = InboxMessage.receive({
      ...command.inbox,
      payloadHash,
      receivedAt: this.clock.now(),
    });
    if (!(await ctx.inbox.tryReceive(message))) {
      const previous = await this.findPrevious(ctx, command, payloadHash);
      if (!previous) {
        throw new Error(
          `Inbox ${command.inbox.messageId} sem transação correspondente`,
        );
      }
      return { ...previous, duplicateMessage: true };
    }

    const result = await this.processOperation(ctx, command, payloadHash);
    message.markProcessed(this.clock.now());
    await ctx.inbox.markProcessed(message);
    return result;
  }

  private async processOperation(
    ctx: TransactionalContext,
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionResult> {
    const before = await this.findPrevious(ctx, command, payloadHash);
    if (before) {
      return before;
    }

    const wallet = await ctx.wallets.lockById(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(command.walletId);
    }

    const afterLock = await this.findPrevious(ctx, command, payloadHash);
    if (afterLock) {
      return afterLock;
    }

    const at = this.clock.now();
    const transaction = WagerTransaction.create({
      id: this.ids.newId(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money: command.money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: at,
    });

    const decision = await this.settlement.decide(ctx, wallet, transaction, at);
    await ctx.transactions.insert(transaction);
    await this.settlement.persistEffects(
      ctx,
      wallet,
      transaction,
      decision,
      {
        correlationId: command.correlationId,
        causationId: command.causationId,
      },
      at,
    );

    return { transaction, idempotentReplay: false };
  }

  /**
   * Replay ou conflito, se a operação já foi registrada, seja pela chave de
   * idempotência, seja pelo `externalTransactionId` do provedor.
   */
  private async findPrevious(
    ctx: TransactionalContext,
    command: SubmitWagerTransactionCommand,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionResult | undefined> {
    // Uma única consulta (um snapshot): duas consultas separadas abririam uma
    // janela em que um commit concorrente entre elas vira falso conflito.
    const previous = await ctx.transactions.findByIdempotencyKeyOrExternalId(
      command.providerId,
      command.idempotencyKey,
      command.externalTransactionId,
    );

    const byKey = previous.find(
      (t) => t.idempotencyKey === command.idempotencyKey,
    );
    if (byKey) {
      if (!byKey.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError(
          `Idempotency-Key ${command.idempotencyKey} já usada com outro payload`,
        );
      }
      return { transaction: byKey, idempotentReplay: true };
    }

    if (previous.length > 0) {
      throw new IdempotencyConflictError(
        `externalTransactionId ${command.externalTransactionId} já registrado com outra Idempotency-Key`,
      );
    }
    return undefined;
  }
}

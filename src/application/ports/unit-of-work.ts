import { InboxMessage } from '../../domain/inbox-message';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';

export interface WalletRepository {
  /** Lança `WalletAlreadyExistsError` se já houver wallet para `playerId + currency`. */
  insert(wallet: Wallet): Promise<void>;
  findById(id: string): Promise<Wallet | undefined>;
  /**
   * Lê a wallet com lock exclusivo de linha (`SELECT … FOR UPDATE`) até o fim
   * da transação. É o ponto de serialização por `walletId`: operações sobre a
   * mesma wallet esperam umas pelas outras, wallets diferentes não.
   */
  lockById(id: string): Promise<Wallet | undefined>;
  /**
   * Persiste saldo/version condicionado a `expectedVersion` (defesa em
   * profundidade além do lock). Lança `ConcurrentModificationError` se a
   * linha mudou.
   */
  update(wallet: Wallet, expectedVersion: number): Promise<void>;
}

/** Pendência a resolver, com o contexto de trace de quem a criou. */
export interface DuePendingReference {
  id: string;
  /**
   * `traceparent` da requisição ou mensagem original. É um metadado opaco
   * para a aplicação: só serve para o worker continuar o mesmo trace.
   */
  traceContext?: string;
}

export interface WagerTransactionRepository {
  /**
   * Lança `DuplicateTransactionError` se `(provider, idempotencyKey)` ou
   * `(provider, externalTransactionId)` já existirem (corrida entre instâncias).
   */
  insert(transaction: WagerTransaction): Promise<void>;
  /**
   * Persiste a transição de estado (status, referência resolvida, falha,
   * saldo e agendamento). Campos de negócio são imutáveis (trigger no banco).
   */
  update(transaction: WagerTransaction): Promise<void>;
  findById(id: string): Promise<WagerTransaction | undefined>;
  /** Já existe `REFUND`/`ROLLBACK` `PROCESSED` revertendo esta transação? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Transações em `PENDING_REFERENCE` com verificação vencida, mais antigas primeiro. */
  findDuePendingReferences(
    now: Date,
    limit: number,
  ): Promise<DuePendingReference[]>;
  /**
   * Transações do provider com a chave de idempotência **ou** o
   * `externalTransactionId` informados (no máximo duas). A leitura é feita
   * numa consulta só, e portanto num único snapshot, para não abrir uma
   * janela entre duas buscas.
   */
  findByIdempotencyKeyOrExternalId(
    providerId: string,
    idempotencyKey: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction[]>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
}

export interface LedgerRepository {
  /**
   * O ledger é append-only: só existe inserção. Cria a conta de
   * contrapartida na primeira vez que ela aparece.
   */
  append(entry: WalletLedgerEntry): Promise<void>;
  /**
   * Página do ledger, mais recentes primeiro, com `walletVersion` menor que
   * `beforeVersion`. É paginação por keyset, que continua estável quando
   * entram lançamentos novos no meio.
   */
  findPage(
    walletId: string,
    walletCurrency: string,
    beforeVersion: number | undefined,
    limit: number,
  ): Promise<WalletLedgerEntry[]>;
  /**
   * Saldo armazenado e totais do ledger lidos em **uma** consulta (mesmo
   * snapshot). `undefined` se a wallet não existe.
   */
  reconciliationSnapshot(
    walletId: string,
  ): Promise<LedgerReconciliationSnapshot | undefined>;
}

export interface LedgerReconciliationSnapshot {
  storedBalance: Money;
  totalCredits: Money;
  totalDebits: Money;
  entries: number;
}

export interface InboxRepository {
  /**
   * Registra a mensagem recebida (`ON CONFLICT DO NOTHING`). `false` = já
   * registrada por outra entrega. Uma entrega concorrente da mesma mensagem
   * espera no índice único até a primeira confirmar ou desfazer.
   */
  tryReceive(message: InboxMessage): Promise<boolean>;
  markProcessed(message: InboxMessage): Promise<void>;
  /**
   * Retenção: apaga até `limit` registros recebidos antes de `cutoff`, os
   * mais antigos primeiro. Devolve quantos apagou.
   */
  deleteReceivedBefore(cutoff: Date, limit: number): Promise<number>;
}

export interface OutboxRepository {
  enqueue(message: OutboxMessage): Promise<void>;
  /**
   * Reserva até `limit` mensagens pendentes e devidas, mais antigas primeiro,
   * com `FOR UPDATE SKIP LOCKED`: publishers concorrentes recebem lotes
   * disjuntos, e a reserva dura até o fim da transação.
   */
  claimDue(now: Date, limit: number): Promise<OutboxMessage[]>;
  /** Persiste tentativas, próximo agendamento e publicação. */
  update(message: OutboxMessage): Promise<void>;
  /**
   * Retenção: apaga até `limit` mensagens **já publicadas** antes de
   * `cutoff`, as mais antigas primeiro. Pendentes nunca são apagadas.
   * Devolve quantas apagou.
   */
  deletePublishedBefore(cutoff: Date, limit: number): Promise<number>;
}

/** Repositórios ligados a uma única transação SQL. */
export interface TransactionalContext {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  ledger: LedgerRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

/**
 * Executa `work` dentro de uma transação SQL: tudo o que for gravado pelos
 * repositórios do contexto é confirmado junto, ou nada é.
 */
export interface UnitOfWork {
  run<T>(work: (ctx: TransactionalContext) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol('UnitOfWork');

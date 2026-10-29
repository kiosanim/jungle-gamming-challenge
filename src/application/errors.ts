/**
 * Erros da camada de aplicação: situações esperadas que não são violação de
 * invariante do domínio (conflitos, recursos inexistentes). `code` é estável
 * e legível por máquina.
 */
export abstract class ApplicationError extends Error {
  abstract override readonly name: string;
  abstract readonly code: string;
}

/**
 * Entrada fora do contrato (corpo HTTP, mensagem SQS). Não adianta reenviar
 * igual: HTTP 400; na fila, vai para a DLQ.
 */
export class InvalidPayloadError extends ApplicationError {
  override readonly name = 'InvalidPayloadError';
  readonly code = 'INVALID_PAYLOAD';
}

export class WalletAlreadyExistsError extends ApplicationError {
  override readonly name = 'WalletAlreadyExistsError';
  readonly code = 'WALLET_ALREADY_EXISTS';

  constructor(
    readonly playerId: string,
    readonly currency: string,
  ) {
    super(`Já existe wallet ${currency} para o player ${playerId}`);
  }
}

export class WalletNotFoundError extends ApplicationError {
  override readonly name = 'WalletNotFoundError';
  readonly code = 'WALLET_NOT_FOUND';

  constructor(readonly walletId: string) {
    super(`Wallet ${walletId} não encontrada`);
  }
}

export class WagerTransactionNotFoundError extends ApplicationError {
  override readonly name = 'WagerTransactionNotFoundError';
  readonly code = 'TRANSACTION_NOT_FOUND';

  constructor(reference: string) {
    super(`Transação ${reference} não encontrada`);
  }
}

/**
 * A mesma chave de idempotência (ou o mesmo `externalTransactionId`) já foi
 * usada com outro payload. É conflito, não replay.
 */
export class IdempotencyConflictError extends ApplicationError {
  override readonly name = 'IdempotencyConflictError';
  readonly code = 'IDEMPOTENCY_CONFLICT';
}

/**
 * Outra instância gravou a mesma transação entre a verificação e a inserção.
 * Sinal interno: o use case repete a operação, que então vira replay.
 */
export class DuplicateTransactionError extends ApplicationError {
  override readonly name = 'DuplicateTransactionError';
  readonly code = 'DUPLICATE_TRANSACTION';
}

/**
 * A wallet mudou mesmo com o lock, o que não deveria acontecer. Tratamos como
 * falha transitória, porque a operação inteira foi desfeita e pode ser
 * reenviada.
 */
export class ConcurrentModificationError extends ApplicationError {
  override readonly name = 'ConcurrentModificationError';
  readonly code = 'CONCURRENT_MODIFICATION';
}

/**
 * Taxonomia estável dos motivos de rejeição e de falha. Os valores são
 * contrato público (API, eventos e banco), então nunca são renomeados, só
 * acrescentados.
 *
 * Cada código diz ao provedor o que fazer:
 * - **corrigir**: o payload ou o contexto está errado, e reenviar igual dá o
 *   mesmo resultado;
 * - **desistir**: a operação nunca vai ser aceita;
 * - **nova operação**: depois que o estado mudar, reenviar com outro
 *   `externalTransactionId`. A transação rejeitada é terminal, e o replay da
 *   mesma chave devolve a rejeição original.
 */
export enum FailureCode {
  /** `BET` maior que o saldo disponível. Ação: nova operação após crédito. */
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  /**
   * Reversão (`REFUND`/`ROLLBACK`) que deixaria o saldo negativo, como o
   * rollback de um `WIN` que já foi gasto. É separado de `INSUFFICIENT_FUNDS`
   * porque exige tratamento operacional (conciliação manual). O provedor deve
   * desistir e escalar.
   */
  ReversalInsufficientFunds = 'REVERSAL_INSUFFICIENT_FUNDS',
  /** Moeda da operação diferente da moeda da wallet. Ação: corrigir. */
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  /** Wallet inexistente. Ação: corrigir. */
  WalletNotFound = 'WALLET_NOT_FOUND',
  /** A wallet não pertence ao `playerId` informado. Ação: corrigir. */
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  /** Referência não apareceu dentro do limite de `PENDING_REFERENCE`. Ação: desistir. */
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  /** Referência de outro provider, player, wallet, moeda ou rodada. Ação: corrigir. */
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  /** Kind da referência não pode ser alvo desta operação (ex.: `REFUND` de `WIN`). Ação: corrigir. */
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  /** Referência existe mas não está `PROCESSED` (ex.: aposta rejeitada). Ação: desistir. */
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  /** Referência já foi revertida. Ação: desistir. */
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  /** Valor da reversão diferente do valor da referência. Ação: corrigir. */
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',
  /** Erro permanente de infraestrutura (status `FAILED`). Ação: escalar. */
  ProcessingFailed = 'PROCESSING_FAILED',
}

export enum FailureCategory {
  /** Violação de regra de negócio; a transação fica `REJECTED`. */
  Rejection = 'REJECTION',
  /** Erro permanente de infraestrutura; a transação fica `FAILED`. */
  Failure = 'FAILURE',
}

export const FAILURE_CODE_CATEGORY: Readonly<
  Record<FailureCode, FailureCategory>
> = Object.freeze({
  [FailureCode.InsufficientFunds]: FailureCategory.Rejection,
  [FailureCode.ReversalInsufficientFunds]: FailureCategory.Rejection,
  [FailureCode.CurrencyMismatch]: FailureCategory.Rejection,
  [FailureCode.WalletNotFound]: FailureCategory.Rejection,
  [FailureCode.WalletPlayerMismatch]: FailureCategory.Rejection,
  [FailureCode.ReferenceNotFound]: FailureCategory.Rejection,
  [FailureCode.ReferenceMismatch]: FailureCategory.Rejection,
  [FailureCode.ReferenceKindNotAllowed]: FailureCategory.Rejection,
  [FailureCode.ReferenceNotProcessed]: FailureCategory.Rejection,
  [FailureCode.ReferenceAlreadyReversed]: FailureCategory.Rejection,
  [FailureCode.ReversalAmountMismatch]: FailureCategory.Rejection,
  [FailureCode.ProcessingFailed]: FailureCategory.Failure,
});

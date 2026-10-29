/** Requisição sem credencial válida (401). */
export class UnauthenticatedError extends Error {
  override readonly name = 'UnauthenticatedError';
  readonly code = 'UNAUTHENTICATED';
}

/** Credencial válida, mas sem o papel que a rota exige (403). */
export class ForbiddenError extends Error {
  override readonly name = 'ForbiddenError';
  readonly code = 'FORBIDDEN';
}

/** O provedor do token não é o provedor da operação (403). */
export class ProviderMismatchError extends Error {
  override readonly name = 'ProviderMismatchError';
  readonly code = 'PROVIDER_MISMATCH';
}

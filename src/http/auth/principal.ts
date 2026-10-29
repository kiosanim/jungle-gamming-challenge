import type { Request } from 'express';
import type { Principal } from '../../infrastructure/auth/jwt-verifier';
import { ProviderMismatchError } from './auth.errors';

/** Requisição já autenticada pelo `ProviderAuthGuard`. */
export interface AuthenticatedRequest extends Request {
  principal?: Principal;
}

/**
 * Garante que o provedor do token é o provedor da operação. Sem principal
 * (autenticação desligada), não há o que verificar.
 */
export function assertProviderAccess(
  principal: Principal | undefined,
  providerId: string,
): void {
  if (principal && principal.providerId !== providerId) {
    throw new ProviderMismatchError(
      `o token não autoriza operar pelo provider ${providerId}`,
    );
  }
}

/** O principal pode ver recursos deste provedor? */
export function canAccessProvider(
  principal: Principal | undefined,
  providerId: string,
): boolean {
  return !principal || principal.providerId === providerId;
}

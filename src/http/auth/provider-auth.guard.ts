import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AUTH_CONFIG,
  type AuthConfig,
} from '../../infrastructure/auth/auth-config';
import { JwtVerifier } from '../../infrastructure/auth/jwt-verifier';
import { RequestContext } from '../../infrastructure/observability/request-context';
import { ForbiddenError, UnauthenticatedError } from './auth.errors';
import type { AuthenticatedRequest } from './principal';
import { IS_PUBLIC } from './public.decorator';
import { REQUIRED_ROLES, type Role } from './roles.decorator';

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Autentica os clientes da API usando um IdP externo (Keycloak).
 *
 * 1. Rotas `@Public()` (health e métricas) passam direto.
 * 2. As demais exigem `Authorization: Bearer <access token>`, validado pelo
 *    JWKS do IdP (assinatura, emissor, audience e expiração). Token inválido
 *    dá 401.
 * 3. Exige um dos papéis declarados com `@RequireRole`, senão responde 403.
 * 4. Anexa o `Principal` à requisição. Conferir se o provedor do token é o
 *    provedor da operação fica a cargo dos controllers, que conhecem o
 *    `providerId` do payload ou da rota.
 *
 * Com `AUTH_ENABLED=false`, todas as requisições são aceitas, sem principal.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(JwtVerifier) private readonly verifier: JwtVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (
      !this.config.enabled ||
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1];
    if (!token) {
      throw new UnauthenticatedError('Authorization: Bearer <token> ausente');
    }

    // O HttpErrorFilter transforma InvalidTokenError em 401 e IdP indisponível em 503.
    const principal = await this.verifier.verify(token);

    const required =
      this.reflector.getAllAndOverride<Role[]>(REQUIRED_ROLES, targets) ?? [];
    if (
      required.length > 0 &&
      !required.some((role) => principal.roles.includes(role))
    ) {
      throw new ForbiddenError(`papel exigido: ${required.join(' ou ')}`);
    }

    request.principal = principal;
    RequestContext.set({ providerId: principal.providerId });
    return true;
  }
}

import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { AuthConfig } from './auth-config';

/** Identidade autenticada extraída do access token. */
export interface Principal {
  subject: string;
  /** Cliente OAuth2 que obteve o token (`azp`). */
  clientId?: string;
  /** Provedor de jogos representado pelo cliente, quando houver. */
  providerId?: string;
  roles: string[];
}

/** Token ausente, malformado, expirado, com assinatura/emissor/audience inválidos. */
export class InvalidTokenError extends Error {
  override readonly name = 'InvalidTokenError';
}

/** Chaves do IdP indisponíveis (rede/timeout): falha transitória. */
export class IdentityProviderUnavailableError extends Error {
  override readonly name = 'IdentityProviderUnavailableError';
}

/**
 * Valida access tokens JWT pelo JWKS do IdP: assinatura (RS256), `iss`, `aud`
 * e `exp`/`nbf`. As chaves ficam em cache e são renovadas quando aparece um
 * `kid` desconhecido (rotação de chaves). Assim, mesmo com o IdP fora do ar,
 * tokens assinados com chaves já conhecidas continuam sendo validados.
 */
export class JwtVerifier {
  /** Só existe com a autenticação habilitada (sem emissor não há JWKS). */
  private readonly jwks?: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly config: AuthConfig) {
    if (config.enabled) {
      this.jwks = createRemoteJWKSet(new URL(config.jwksUrl), {
        timeoutDuration: 2_000,
        cooldownDuration: 30_000,
      });
    }
  }

  async verify(token: string): Promise<Principal> {
    if (!this.jwks) {
      throw new InvalidTokenError('autenticação não configurada');
    }
    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.audience,
        algorithms: ['RS256'],
        clockTolerance: 5,
      });
      const realmAccess = payload.realm_access as
        { roles?: unknown } | undefined;
      const provider = payload[this.config.providerClaim];
      return {
        subject: payload.sub ?? '',
        clientId: typeof payload.azp === 'string' ? payload.azp : undefined,
        providerId: typeof provider === 'string' ? provider : undefined,
        roles: Array.isArray(realmAccess?.roles)
          ? realmAccess.roles.filter((r): r is string => typeof r === 'string')
          : [],
      };
    } catch (error) {
      if (
        error instanceof errors.JWKSTimeout ||
        (error instanceof TypeError && /fetch|connect/i.test(error.message)) ||
        (error as { code?: string }).code === 'ConnectionRefused'
      ) {
        throw new IdentityProviderUnavailableError(
          'chaves do Identity Provider indisponíveis',
        );
      }
      throw new InvalidTokenError(
        error instanceof errors.JOSEError ? error.code : 'token inválido',
      );
    }
  }
}

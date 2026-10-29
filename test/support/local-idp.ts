import type { Server } from 'bun';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

/**
 * IdP mínimo para testes: chaves RS256 próprias e um endpoint JWKS local.
 * Permite emitir tokens inválidos de propósito (expirados, assinados por
 * outra chave, emissor/audience errados), o que o Keycloak não faz.
 */
export class LocalIdentityProvider {
  readonly issuer = 'http://local-idp.test/realms/wagering';
  readonly audience = 'wagering-api';

  private constructor(
    private readonly privateKey: CryptoKey,
    private readonly server: Server<unknown>,
  ) {}

  static async start(): Promise<LocalIdentityProvider> {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: 'test-key',
      alg: 'RS256',
      use: 'sig',
    };
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ keys: [jwk] }),
    });
    return new LocalIdentityProvider(privateKey, server);
  }

  get jwksUrl(): string {
    return `http://127.0.0.1:${this.server.port}/certs`;
  }

  /** Token de um provedor (papel `provider` + claim `provider_id`). */
  providerToken(providerId: string, overrides: TokenOverrides = {}) {
    return this.token(
      { provider_id: providerId, realm_access: { roles: ['provider'] } },
      { subject: `service-account-${providerId}`, ...overrides },
    );
  }

  /** Token do backoffice (papel `operator`). */
  operatorToken(overrides: TokenOverrides = {}) {
    return this.token(
      { realm_access: { roles: ['operator'] } },
      { subject: 'service-account-backoffice', ...overrides },
    );
  }

  async token(
    claims: Record<string, unknown>,
    overrides: TokenOverrides & { subject?: string } = {},
  ): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(overrides.issuer ?? this.issuer)
      .setAudience(overrides.audience ?? this.audience)
      .setSubject(overrides.subject ?? 'test')
      .setIssuedAt(now)
      .setExpirationTime(now + (overrides.expiresInSeconds ?? 300))
      .sign(overrides.signingKey ?? this.privateKey);
  }

  stop(): void {
    this.server.stop(true);
  }
}

export interface TokenOverrides {
  issuer?: string;
  audience?: string;
  expiresInSeconds?: number;
  signingKey?: CryptoKey;
}

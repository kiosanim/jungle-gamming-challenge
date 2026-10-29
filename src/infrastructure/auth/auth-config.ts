/**
 * Configuração da autenticação (OAuth2/OIDC com um IdP externo, o Keycloak).
 *
 * - `AUTH_ENABLED` (padrão `true`): `false` desliga a verificação (testes e
 *   execuções internas que não passam pelo IdP);
 * - `AUTH_ISSUER`: emissor esperado no `iss` (obrigatório se habilitada);
 * - `AUTH_AUDIENCE` (padrão `wagering-api`): audience esperada no `aud`;
 * - `AUTH_JWKS_URL`: onde buscar as chaves públicas (padrão: endpoint de
 *   certificados do Keycloak sob o emissor). Separado do emissor porque, em
 *   rede Docker, o IdP é alcançado por outro host (`keycloak:8080`);
 * - `AUTH_PROVIDER_CLAIM` (padrão `provider_id`): claim com o provedor.
 */
export interface AuthConfig {
  enabled: boolean;
  issuer: string;
  audience: string;
  jwksUrl: string;
  providerClaim: string;
}

export const AUTH_CONFIG = Symbol('AuthConfig');

export function authConfigFromEnv(env = process.env): AuthConfig {
  const enabled = env.AUTH_ENABLED !== 'false';
  const issuer = env.AUTH_ISSUER ?? '';
  if (enabled && !issuer) {
    throw new Error(
      'AUTH_ISSUER é obrigatório com a autenticação habilitada (ou AUTH_ENABLED=false)',
    );
  }
  return {
    enabled,
    issuer,
    audience: env.AUTH_AUDIENCE ?? 'wagering-api',
    jwksUrl: env.AUTH_JWKS_URL ?? `${issuer}/protocol/openid-connect/certs`,
    providerClaim: env.AUTH_PROVIDER_CLAIM ?? 'provider_id',
  };
}

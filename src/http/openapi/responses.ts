import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';
import { ref } from './schemas';

/*
 * Respostas de erro documentadas em cada rota. O formato é sempre o mesmo
 * (`{ "error": { "code", "message" } }`); o que muda de uma rota para outra é
 * quais status ela pode devolver, então cada controller escolhe os seus.
 */

const ERRORS = {
  400: {
    description:
      'O contrato foi violado (campo ausente, valor inválido, UUID malformado). Reenviar igual dá o mesmo erro.',
    code: 'INVALID_PAYLOAD',
    message:
      'money: amount inválido: "1e3" (esperado decimal não negativo com até 2 casas)',
  },
  401: {
    description:
      'Faltou o token ou ele é inválido, expirado ou foi adulterado. A resposta traz o header `WWW-Authenticate`.',
    code: 'UNAUTHENTICATED',
    message: 'Authorization: Bearer <token> ausente',
  },
  403: {
    description:
      'O token é válido, mas não tem o papel exigido pela rota (`FORBIDDEN`) ou representa outro provedor (`PROVIDER_MISMATCH`).',
    code: 'FORBIDDEN',
    message: 'papel exigido: provider',
  },
  404: {
    description: 'O recurso não existe.',
    code: 'WALLET_NOT_FOUND',
    message: 'Wallet 01a17f00-0000-7000-8000-000000000000 não encontrada',
  },
  409: {
    description: 'Conflito com algo que já existe.',
    code: 'IDEMPOTENCY_CONFLICT',
    message:
      'Idempotency-Key provider-a:transaction-123 já usada com outro payload',
  },
  503: {
    description:
      'Falha transitória (banco, lock disputado demais ou chaves do IdP fora do ar). É seguro reenviar; a resposta traz `Retry-After`.',
    code: 'SERVICE_UNAVAILABLE',
    message: 'Falha transitória de infraestrutura',
  },
} as const;

export type DocumentedError = keyof typeof ERRORS;

/**
 * Documenta as respostas de erro de uma rota. `overrides` troca a descrição
 * padrão quando ela precisa ser mais específica.
 */
export function ApiErrors(
  statuses: DocumentedError[],
  overrides: Partial<Record<DocumentedError, string>> = {},
) {
  return applyDecorators(
    ...statuses.map((status) =>
      ApiResponse({
        status,
        description: overrides[status] ?? ERRORS[status].description,
        content: {
          'application/json': {
            schema: ref('Error'),
            example: {
              error: {
                code: ERRORS[status].code,
                message: ERRORS[status].message,
              },
            },
          },
        },
      }),
    ),
  );
}

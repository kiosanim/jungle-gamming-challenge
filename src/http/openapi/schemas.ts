import type { ReferenceObject, SchemaObject } from '@nestjs/swagger';
import { FailureCode } from '../../domain/failure-code';
import { LedgerAccountType } from '../../domain/ledger-account';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { LedgerDirection } from '../../domain/wallet-ledger-entry';

/*
 * Schemas OpenAPI escritos à mão. Os DTOs da API são interfaces com validação
 * manual, e não classes decoradas, então o Swagger não tem como inferi-los.
 * Mantenha estes schemas em sincronia com os contratos de `wallets.dto.ts`,
 * `wagering.dto.ts` e `wager-transaction-input.ts`.
 */

/** Referência a um schema registrado em `components.schemas`. */
export const ref = (name: keyof typeof SCHEMAS): ReferenceObject => ({
  $ref: `#/components/schemas/${name}`,
});

const uuid = (description: string): SchemaObject => ({
  type: 'string',
  format: 'uuid',
  description,
});

const kinds = Object.values(WagerTransactionKind).filter(
  (kind) => kind !== WagerTransactionKind.Opening,
);

export const SCHEMAS = {
  Money: {
    type: 'object',
    description:
      'Valor monetário. O `amount` é sempre uma string decimal com até 2 casas (nunca número), e a resposta sempre traz 2 casas. Notação científica, sinal, zeros à esquerda e casas a mais são rejeitados, sem arredondamento.',
    required: ['amount', 'currency'],
    properties: {
      amount: {
        type: 'string',
        pattern: '^(0|[1-9][0-9]*)(\\.[0-9]{1,2})?$',
        example: '25.00',
      },
      currency: {
        type: 'string',
        pattern: '^[A-Z]{3}$',
        description: 'Código ISO-4217.',
        example: 'BRL',
      },
    },
  },

  Error: {
    type: 'object',
    description: 'Corpo de todos os erros da API.',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: {
            type: 'string',
            description:
              'Código estável, pensado para ser lido por máquina. A lista completa está no ARCHITECTURE.md, em "Mapeamento de status HTTP".',
            example: 'INVALID_PAYLOAD',
          },
          message: {
            type: 'string',
            description: 'Explicação para quem está depurando.',
            example: 'Idempotency-Key é obrigatória (até 256 caracteres)',
          },
        },
      },
    },
  },

  OpenWalletRequest: {
    type: 'object',
    required: ['playerId', 'initialBalance'],
    properties: {
      playerId: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        example: 'player-1001',
      },
      initialBalance: {
        allOf: [{ $ref: '#/components/schemas/Money' }],
        description:
          'Saldo de abertura. Se for maior que zero, gera a transação interna `OPENING` e um lançamento de crédito, com a conta de aporte como contrapartida.',
      },
    },
  },

  Wallet: {
    type: 'object',
    required: ['id', 'playerId', 'balance', 'version'],
    properties: {
      id: uuid('Id da wallet (UUIDv7).'),
      playerId: { type: 'string', example: 'player-1001' },
      balance: { $ref: '#/components/schemas/Money' },
      version: {
        type: 'integer',
        minimum: 1,
        description:
          'Começa em 1 e só aumenta quando o saldo muda. É a mesma sequência do `walletVersion` do extrato.',
        example: 1,
      },
    },
  },

  LedgerEntry: {
    type: 'object',
    description:
      'Um lançamento do extrato. Ele também é a transferência de partidas dobradas: o valor entra na wallet com `direction` e na `counterAccount` com a direção oposta.',
    required: [
      'id',
      'transactionId',
      'direction',
      'money',
      'counterAccount',
      'balanceBefore',
      'balanceAfter',
      'walletVersion',
      'createdAt',
    ],
    properties: {
      id: uuid('Id do lançamento.'),
      transactionId: uuid('Transação que gerou o lançamento.'),
      direction: {
        type: 'string',
        enum: Object.values(LedgerDirection),
        description: 'Direção na conta da wallet: débito diminui o saldo.',
      },
      money: { $ref: '#/components/schemas/Money' },
      counterAccount: {
        type: 'string',
        description: `Conta de contrapartida: \`provider:{providerId}:{moeda}\` nas operações de jogo ou \`funding:{moeda}\` na abertura (tipos: ${Object.values(LedgerAccountType).join(', ')}).`,
        example: 'provider:provider-a:BRL',
      },
      balanceBefore: { $ref: '#/components/schemas/Money' },
      balanceAfter: { $ref: '#/components/schemas/Money' },
      walletVersion: {
        type: 'integer',
        minimum: 1,
        description:
          'Versão da wallet produzida por este lançamento (a abertura é a 1). Não tem lacunas.',
      },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },

  LedgerPage: {
    type: 'object',
    required: ['items', 'nextCursor'],
    properties: {
      items: {
        type: 'array',
        description: 'Lançamentos do mais recente para o mais antigo.',
        items: { $ref: '#/components/schemas/LedgerEntry' },
      },
      nextCursor: {
        type: 'string',
        nullable: true,
        description:
          'Cursor opaco da próxima página, ou `null` na última. Lançamentos novos não deslocam as páginas seguintes.',
        example: 'eyJ2IjozfQ',
      },
    },
  },

  Reconciliation: {
    type: 'object',
    required: [
      'walletId',
      'storedBalance',
      'calculatedBalance',
      'difference',
      'consistent',
      'checkedEntries',
    ],
    properties: {
      walletId: uuid('Wallet reconciliada.'),
      storedBalance: {
        allOf: [{ $ref: '#/components/schemas/Money' }],
        description: 'Saldo materializado na wallet.',
      },
      calculatedBalance: {
        allOf: [{ $ref: '#/components/schemas/Money' }],
        description: 'Saldo reconstruído somando o ledger.',
      },
      difference: {
        allOf: [{ $ref: '#/components/schemas/Money' }],
        description: '`storedBalance` menos `calculatedBalance`.',
      },
      consistent: {
        type: 'boolean',
        description:
          'Se for `false`, a divergência é registrada em log e em métrica, mas nunca corrigida automaticamente.',
      },
      checkedEntries: {
        type: 'integer',
        description: 'Quantos lançamentos foram somados.',
      },
    },
  },

  SubmitWagerTransactionRequest: {
    type: 'object',
    required: [
      'providerId',
      'externalTransactionId',
      'playerId',
      'walletId',
      'roundId',
      'gameId',
      'kind',
      'money',
    ],
    properties: {
      providerId: {
        type: 'string',
        description: 'Precisa ser o mesmo provedor do token.',
        example: 'provider-a',
      },
      externalTransactionId: {
        type: 'string',
        description: 'Id da operação no provedor. É único por provedor.',
        example: 'transaction-123',
      },
      playerId: { type: 'string', example: 'player-1001' },
      walletId: uuid('Wallet do jogador.'),
      roundId: { type: 'string', example: 'round-987' },
      gameId: { type: 'string', example: 'fortune-chimp' },
      kind: {
        type: 'string',
        enum: kinds,
        description:
          '`OPENING` é interno e não é aceito aqui. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`.',
      },
      money: {
        allOf: [{ $ref: '#/components/schemas/Money' }],
        description:
          'Positivo em todos os kinds, exceto em `LOSS`, que aceita `0.00`. Nas reversões, deve ser igual ao valor da referência.',
      },
      referenceExternalTransactionId: {
        type: 'string',
        description:
          'Operação referenciada, do mesmo provedor, player, wallet, moeda e rodada. Se ainda não chegou, a transação fica em `PENDING_REFERENCE`.',
        example: 'transaction-120',
      },
    },
  },

  SubmitWagerTransactionResponse: {
    type: 'object',
    required: ['transactionId', 'status', 'idempotentReplay'],
    properties: {
      transactionId: uuid('Id interno da transação.'),
      status: {
        type: 'string',
        enum: Object.values(WagerTransactionStatus),
      },
      balance: {
        allOf: [{ $ref: '#/components/schemas/Money' }],
        description:
          'Saldo da wallet no momento da decisão. Num replay, é o saldo daquele momento, e não o atual. Não vem em `PENDING_REFERENCE`.',
      },
      failureCode: {
        type: 'string',
        enum: Object.values(FailureCode),
        description: 'Só aparece em rejeições.',
      },
      idempotentReplay: {
        type: 'boolean',
        description:
          '`true` quando a resposta é a repetição de uma operação já registrada.',
      },
    },
  },

  WagerTransaction: {
    type: 'object',
    required: [
      'transactionId',
      'providerId',
      'externalTransactionId',
      'walletId',
      'playerId',
      'roundId',
      'gameId',
      'kind',
      'money',
      'status',
      'createdAt',
    ],
    properties: {
      transactionId: uuid('Id interno da transação.'),
      providerId: { type: 'string', example: 'provider-a' },
      externalTransactionId: { type: 'string', example: 'transaction-123' },
      walletId: uuid('Wallet da operação.'),
      playerId: { type: 'string', example: 'player-1001' },
      roundId: { type: 'string', example: 'round-987' },
      gameId: { type: 'string', example: 'fortune-chimp' },
      kind: {
        type: 'string',
        enum: Object.values(WagerTransactionKind),
      },
      money: { $ref: '#/components/schemas/Money' },
      status: {
        type: 'string',
        enum: Object.values(WagerTransactionStatus),
      },
      failureCode: { type: 'string', enum: Object.values(FailureCode) },
      referenceExternalTransactionId: { type: 'string' },
      referenceTransactionId: uuid('Id interno da referência, já resolvida.'),
      balance: {
        allOf: [{ $ref: '#/components/schemas/Money' }],
        description: 'Saldo da wallet no momento da decisão.',
      },
      createdAt: { type: 'string', format: 'date-time' },
      processedAt: { type: 'string', format: 'date-time' },
    },
  },

  Liveness: {
    type: 'object',
    required: ['status'],
    properties: { status: { type: 'string', enum: ['ok'] } },
  },

  Readiness: {
    type: 'object',
    required: ['status', 'checks'],
    properties: {
      status: { type: 'string', enum: ['ok', 'unavailable'] },
      checks: {
        type: 'object',
        properties: {
          postgres: { $ref: '#/components/schemas/DependencyStatus' },
          sqs: { $ref: '#/components/schemas/DependencyStatus' },
        },
      },
    },
  },

  DependencyStatus: {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['up', 'down'] },
      error: {
        type: 'string',
        description: 'Nome do erro, quando a dependência não respondeu.',
      },
    },
  },
} satisfies Record<string, SchemaObject>;

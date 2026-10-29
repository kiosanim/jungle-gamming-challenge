import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { WagerTransactionNotFoundError } from '../application/errors';
import { GetWagerTransactionUseCase } from '../application/get-wager-transaction.use-case';
import {
  ID_GENERATOR,
  type IdGenerator,
} from '../application/ports/id-generator';
import { METRICS, type Metrics } from '../application/ports/metrics';
import { SubmitWagerTransactionUseCase } from '../application/submit-wager-transaction.use-case';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { RequestContext } from '../infrastructure/observability/request-context';
import {
  type AuthenticatedRequest,
  assertProviderAccess,
  canAccessProvider,
} from './auth/principal';
import { RequireRole } from './auth/roles.decorator';
import { ApiErrors } from './openapi/responses';
import { ref } from './openapi/schemas';
import { BEARER_AUTH } from './openapi/setup';
import { parseUuid } from './parsing';
import {
  parseSubmitWagerTransactionRequest,
  SubmitWagerTransactionResponse,
  toSubmitResponse,
  toTransactionResponse,
  WagerTransactionResponse,
} from './wagering.dto';

/**
 * Status de `POST /wagering/transactions`:
 * - 201: processada agora;
 * - 200: replay idempotente de uma transação processada;
 * - 422: rejeitada por regra de negócio, nova ou em replay (o corpo traz o
 *   `failureCode`);
 * - 202: aceita, com processamento pendente (`PENDING_REFERENCE`).
 * Os erros (400, 404, 409, 503) seguem o `HttpErrorFilter`.
 */
function submitStatus(response: SubmitWagerTransactionResponse): number {
  switch (response.status) {
    case WagerTransactionStatus.Processed:
      return response.idempotentReplay ? HttpStatus.OK : HttpStatus.CREATED;
    case WagerTransactionStatus.Rejected:
      return HttpStatus.UNPROCESSABLE_ENTITY;
    case WagerTransactionStatus.Pending:
    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;
    case WagerTransactionStatus.Failed:
      return HttpStatus.INTERNAL_SERVER_ERROR;
  }
}

/**
 * Rotas dos provedores. Exigem o papel `provider`, e o provedor do token
 * precisa ser o provedor da operação, então um provedor nunca vê nem altera
 * transações de outro.
 */
@ApiTags('Wagering')
@ApiBearerAuth(BEARER_AUTH)
@ApiErrors([401, 403], {
  403: 'O token não tem o papel `provider` (`FORBIDDEN`) ou representa outro provedor (`PROVIDER_MISMATCH`).',
})
@RequireRole('provider')
@Controller()
export class WageringController {
  private readonly logger = new Logger(WageringController.name);

  constructor(
    @Inject(SubmitWagerTransactionUseCase)
    private readonly submitTransaction: SubmitWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase)
    private readonly getTransaction: GetWagerTransactionUseCase,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  @Post('wagering/transactions')
  @ApiOperation({
    summary: 'Submete uma operação de aposta',
    description: [
      'Aplica uma operação (`BET`, `WIN`, `LOSS`, `REFUND` ou `ROLLBACK`) à wallet do jogador. É o mesmo processamento usado para as mensagens da fila SQS.',
      '',
      'O status de sucesso diz o que aconteceu. `201` quer dizer que a operação foi processada agora. `200` é a repetição de uma operação que já tinha sido processada (`idempotentReplay: true`). `202` significa que ela foi aceita, mas a operação referenciada ainda não chegou; ela fica em `PENDING_REFERENCE` e é resolvida em segundo plano. `422` é uma rejeição por regra de negócio, como saldo insuficiente; a transação fica registrada, e o corpo traz o `failureCode`.',
      '',
      'Pode reenviar à vontade com a mesma `Idempotency-Key`: o efeito nunca se repete.',
    ].join('\n'),
  })
  @ApiHeader({
    name: 'idempotency-key',
    required: true,
    description:
      'Chave de idempotência, com até 256 caracteres. Recomendamos `{providerId}:{externalTransactionId}`.',
    example: 'provider-a:transaction-123',
  })
  @ApiHeader({
    name: 'x-correlation-id',
    required: false,
    description:
      'Identificador para seguir a requisição nos logs e nos eventos gerados. Se não vier, a API gera um.',
  })
  @ApiBody({
    schema: ref('SubmitWagerTransactionRequest'),
    examples: {
      aposta: {
        summary: 'BET',
        value: {
          providerId: 'provider-a',
          externalTransactionId: 'transaction-123',
          playerId: 'player-1001',
          walletId: '01a17f88-6cc0-70aa-8d32-320fcca6ce14',
          roundId: 'round-987',
          gameId: 'fortune-chimp',
          kind: 'BET',
          money: { amount: '25.00', currency: 'BRL' },
        },
      },
      ganho: {
        summary: 'WIN referenciando a BET',
        value: {
          providerId: 'provider-a',
          externalTransactionId: 'transaction-124',
          playerId: 'player-1001',
          walletId: '01a17f88-6cc0-70aa-8d32-320fcca6ce14',
          roundId: 'round-987',
          gameId: 'fortune-chimp',
          kind: 'WIN',
          money: { amount: '40.00', currency: 'BRL' },
          referenceExternalTransactionId: 'transaction-123',
        },
      },
      estorno: {
        summary: 'REFUND da BET',
        value: {
          providerId: 'provider-a',
          externalTransactionId: 'transaction-125',
          playerId: 'player-1001',
          walletId: '01a17f88-6cc0-70aa-8d32-320fcca6ce14',
          roundId: 'round-987',
          gameId: 'fortune-chimp',
          kind: 'REFUND',
          money: { amount: '25.00', currency: 'BRL' },
          referenceExternalTransactionId: 'transaction-123',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Processada agora.',
    schema: ref('SubmitWagerTransactionResponse'),
    example: {
      transactionId: '01a17f88-a573-74d1-aa2f-03b6ae3afaa7',
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: false,
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'Repetição de uma operação já processada. Devolve o resultado original, com o saldo daquele momento.',
    schema: ref('SubmitWagerTransactionResponse'),
    example: {
      transactionId: '01a17f88-a573-74d1-aa2f-03b6ae3afaa7',
      status: 'PROCESSED',
      balance: { amount: '75.00', currency: 'BRL' },
      idempotentReplay: true,
    },
  })
  @ApiResponse({
    status: 202,
    description:
      'Aceita, esperando a operação referenciada. O worker resolve quando ela chegar (ou rejeita depois de 15 minutos).',
    schema: ref('SubmitWagerTransactionResponse'),
    example: {
      transactionId: '01a17f88-a5ed-75fc-8ca6-1f88e06f9871',
      status: 'PENDING_REFERENCE',
      idempotentReplay: false,
    },
  })
  @ApiResponse({
    status: 422,
    description:
      'Rejeitada por regra de negócio. A transação fica registrada como `REJECTED`, sem mexer no saldo, e um replay devolve a mesma rejeição.',
    schema: ref('SubmitWagerTransactionResponse'),
    example: {
      transactionId: '01a17f88-a5a8-706d-832e-715161ccbb8d',
      status: 'REJECTED',
      balance: { amount: '75.00', currency: 'BRL' },
      failureCode: 'INSUFFICIENT_FUNDS',
      idempotentReplay: false,
    },
  })
  @ApiErrors([400, 404, 409, 503], {
    400: 'Corpo ou `Idempotency-Key` inválidos (por exemplo, valor com notação científica ou cabeçalho ausente).',
    404: 'A wallet não existe (`WALLET_NOT_FOUND`).',
    409: 'A `Idempotency-Key` ou o `externalTransactionId` já foram usados com outro conteúdo (`IDEMPOTENCY_CONFLICT`).',
  })
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SubmitWagerTransactionResponse> {
    const request = parseSubmitWagerTransactionRequest(idempotencyKey, body);
    assertProviderAccess(req.principal, request.providerId);
    RequestContext.set({
      providerId: request.providerId,
      walletId: request.walletId,
    });

    const startedAt = performance.now();
    const { transaction, idempotentReplay } =
      await this.submitTransaction.execute({
        ...request,
        correlationId: correlationId || this.ids.newId(),
      });
    this.metrics.processingDuration(
      'http',
      (performance.now() - startedAt) / 1000,
    );

    RequestContext.set({ transactionId: transaction.id });
    if (idempotentReplay) {
      this.metrics.duplicateDetected('idempotent_replay');
    } else {
      this.metrics.transactionSettled({
        channel: 'http',
        kind: transaction.kind,
        status: transaction.status,
      });
    }
    this.logger.log({
      event: 'wager_transaction',
      kind: transaction.kind,
      status: transaction.status,
      failureCode: transaction.failureCode,
      idempotentReplay,
    });

    const response = toSubmitResponse(transaction, idempotentReplay);
    res.status(submitStatus(response));
    return response;
  }

  @Get('wagering/transactions/:transactionId')
  @ApiOperation({
    summary: 'Consulta uma transação pelo id interno',
    description:
      'Só devolve transações do próprio provedor. Se a transação for de outro provedor, a resposta é 404, sem revelar que ela existe.',
  })
  @ApiParam({
    name: 'transactionId',
    format: 'uuid',
    description: 'Id interno devolvido na submissão.',
  })
  @ApiResponse({
    status: 200,
    description: 'Transação encontrada.',
    schema: ref('WagerTransaction'),
  })
  @ApiErrors([400, 404, 503], {
    404: 'A transação não existe ou pertence a outro provedor (`TRANSACTION_NOT_FOUND`).',
  })
  async findById(
    @Param('transactionId') transactionId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<WagerTransactionResponse> {
    const transaction = await this.getTransaction.byId(
      parseUuid(transactionId, 'transactionId'),
    );
    // Transação de outro provedor: 404, sem revelar que ela existe.
    if (!canAccessProvider(req.principal, transaction.providerId)) {
      throw new WagerTransactionNotFoundError(transactionId);
    }
    return toTransactionResponse(transaction);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @ApiOperation({
    summary: 'Consulta uma transação pelo id do provedor',
    description:
      'Busca pela combinação de provedor e `externalTransactionId`. O `providerId` da rota precisa ser o mesmo do token.',
  })
  @ApiParam({ name: 'providerId', example: 'provider-a' })
  @ApiParam({ name: 'externalTransactionId', example: 'transaction-123' })
  @ApiResponse({
    status: 200,
    description: 'Transação encontrada.',
    schema: ref('WagerTransaction'),
  })
  @ApiErrors([404, 503], {
    404: 'O provedor não tem transação com esse id (`TRANSACTION_NOT_FOUND`).',
  })
  async findByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<WagerTransactionResponse> {
    assertProviderAccess(req.principal, providerId);
    const transaction = await this.getTransaction.byExternalId(
      providerId,
      externalTransactionId,
    );
    return toTransactionResponse(transaction);
  }
}

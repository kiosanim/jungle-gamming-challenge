import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { GetWalletLedgerUseCase } from '../application/get-wallet-ledger.use-case';
import { GetWalletUseCase } from '../application/get-wallet.use-case';
import { ReconcileWalletUseCase } from '../application/reconcile-wallet.use-case';
import { OpenWalletUseCase } from '../application/open-wallet.use-case';
import {
  ID_GENERATOR,
  type IdGenerator,
} from '../application/ports/id-generator';
import { RequireRole } from './auth/roles.decorator';
import { ApiErrors } from './openapi/responses';
import { ref } from './openapi/schemas';
import { BEARER_AUTH } from './openapi/setup';
import {
  LedgerPageResponse,
  parseLimit,
  parseOpenWalletRequest,
  parseWalletId,
  ReconciliationResponse,
  toLedgerPageResponse,
  toReconciliationResponse,
  toWalletResponse,
  WalletResponse,
} from './wallets.dto';

const walletIdParam = ApiParam({
  name: 'walletId',
  format: 'uuid',
  description: 'Id da wallet.',
  example: '01a17f88-6cc0-70aa-8d32-320fcca6ce14',
});

const correlationHeader = ApiHeader({
  name: 'x-correlation-id',
  required: false,
  description:
    'Identificador para seguir a requisição nos logs e nos eventos gerados. Se não vier, a API gera um e o devolve na resposta.',
});

/** Rotas de backoffice: exigem o papel `operator`. */
@ApiTags('Wallets')
@ApiBearerAuth(BEARER_AUTH)
@ApiErrors([401, 403], {
  403: 'O token não tem o papel `operator`, que todas as rotas de wallet exigem.',
})
@RequireRole('operator')
@Controller('wallets')
export class WalletsController {
  private readonly logger = new Logger(WalletsController.name);

  constructor(
    @Inject(OpenWalletUseCase) private readonly openWallet: OpenWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWallet: GetWalletUseCase,
    @Inject(GetWalletLedgerUseCase)
    private readonly getLedger: GetWalletLedgerUseCase,
    @Inject(ReconcileWalletUseCase)
    private readonly reconcileWallet: ReconcileWalletUseCase,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Abre uma wallet',
    description:
      'Cria a wallet de um jogador numa moeda. Cada jogador tem no máximo uma wallet por moeda. Um saldo inicial maior que zero gera, na mesma transação, a operação interna `OPENING`, o lançamento de crédito no extrato e o evento `WalletBalanceChanged`.',
  })
  @correlationHeader
  @ApiBody({
    schema: ref('OpenWalletRequest'),
    examples: {
      comSaldo: {
        summary: 'Com saldo inicial',
        value: {
          playerId: 'player-1001',
          initialBalance: { amount: '100.00', currency: 'BRL' },
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Wallet criada.',
    schema: ref('Wallet'),
    example: {
      id: '01a17f88-6cc0-70aa-8d32-320fcca6ce14',
      playerId: 'player-1001',
      balance: { amount: '100.00', currency: 'BRL' },
      version: 1,
    },
  })
  @ApiErrors([400, 409, 503], {
    409: 'Já existe uma wallet para esse jogador nessa moeda (`WALLET_ALREADY_EXISTS`).',
  })
  async open(
    @Body() body: unknown,
    @Headers('x-correlation-id') correlationId?: string,
  ): Promise<WalletResponse> {
    const request = parseOpenWalletRequest(body);
    const wallet = await this.openWallet.execute({
      ...request,
      correlationId: correlationId || this.ids.newId(),
    });
    return toWalletResponse(wallet);
  }

  @Get(':walletId')
  @ApiOperation({
    summary: 'Consulta uma wallet',
    description: 'Devolve o saldo atual e a versão da wallet.',
  })
  @walletIdParam
  @ApiResponse({
    status: 200,
    description: 'Wallet encontrada.',
    schema: ref('Wallet'),
  })
  @ApiErrors([400, 404, 503])
  async findOne(@Param('walletId') walletId: string): Promise<WalletResponse> {
    const wallet = await this.getWallet.execute(parseWalletId(walletId));
    return toWalletResponse(wallet);
  }

  @Get(':walletId/ledger')
  @ApiOperation({
    summary: 'Extrato da wallet',
    description:
      'Lista os lançamentos do mais recente para o mais antigo, paginados por cursor. Cada lançamento traz a conta de contrapartida da partida dobrada. Para seguir para a próxima página, mande de volta o `nextCursor` recebido.',
  })
  @walletIdParam
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Cursor opaco devolvido na página anterior.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Tamanho da página, de 1 a 200. O padrão é 50.',
    schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  })
  @ApiResponse({
    status: 200,
    description: 'Uma página do extrato.',
    schema: ref('LedgerPage'),
  })
  @ApiErrors([400, 404, 503], {
    400: 'UUID, cursor ou `limit` inválidos.',
  })
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<LedgerPageResponse> {
    const page = await this.getLedger.execute(
      parseWalletId(walletId),
      cursor || undefined,
      parseLimit(limit),
    );
    return toLedgerPageResponse(page);
  }

  /**
   * Compara o saldo armazenado com o ledger. Uma divergência é sinalizada na
   * resposta, contada em métrica e registrada em log, mas nunca corrigida.
   */
  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reconcilia o saldo com o ledger',
    description:
      'Compara o saldo guardado na wallet com a soma do extrato, lidos no mesmo instante. Uma divergência aparece como `consistent: false`, é registrada em log e na métrica `wagering_reconciliations_total`, mas nunca é corrigida automaticamente.',
  })
  @walletIdParam
  @ApiResponse({
    status: 200,
    description:
      'Resultado da reconciliação. A resposta é 200 mesmo quando há divergência.',
    schema: ref('Reconciliation'),
    example: {
      walletId: '01a17f88-6cc0-70aa-8d32-320fcca6ce14',
      storedBalance: { amount: '140.00', currency: 'BRL' },
      calculatedBalance: { amount: '140.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 4,
    },
  })
  @ApiErrors([400, 404, 503])
  async reconcile(
    @Param('walletId') walletId: string,
  ): Promise<ReconciliationResponse> {
    const report = await this.reconcileWallet.execute(parseWalletId(walletId));
    const response = toReconciliationResponse(report);
    if (!report.consistent) {
      this.logger.warn({
        event: 'reconciliation_divergence',
        walletId: report.walletId,
        difference: response.difference,
        checkedEntries: report.checkedEntries,
      });
    }
    return response;
  }
}

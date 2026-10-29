import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  HealthService,
  ReadinessReport,
} from '../infrastructure/health/health.service';
import { Public } from './auth/public.decorator';
import { ref } from './openapi/schemas';

/** Health checks, sem autenticação. */
@ApiTags('Operação')
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Liveness: o processo responde. Não consulta dependências. */
  @Get('live')
  @ApiOperation({
    summary: 'Liveness',
    description:
      'Só confirma que o processo está respondendo. Não consulta nenhuma dependência.',
  })
  @ApiResponse({
    status: 200,
    description: 'Processo vivo.',
    schema: ref('Liveness'),
  })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e SQS alcançáveis; 503 caso contrário. */
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness',
    description:
      'Verifica se o PostgreSQL e o SQS respondem, com timeout de 2s para cada um. Uma réplica que responde 503 deve sair do balanceamento.',
  })
  @ApiResponse({
    status: 200,
    description: 'PostgreSQL e SQS acessíveis.',
    schema: ref('Readiness'),
    example: {
      status: 'ok',
      checks: { postgres: { status: 'up' }, sqs: { status: 'up' } },
    },
  })
  @ApiResponse({
    status: 503,
    description: 'Alguma dependência não respondeu.',
    schema: ref('Readiness'),
    example: {
      status: 'unavailable',
      checks: {
        postgres: { status: 'up' },
        sqs: { status: 'down', error: 'Error' },
      },
    },
  })
  async ready(
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReadinessReport> {
    const report = await this.health.readiness();
    res.status(
      report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    );
    return report;
  }
}

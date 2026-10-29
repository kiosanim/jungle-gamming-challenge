import { Controller, Get, Header, Inject } from '@nestjs/common';
import {
  ApiOperation,
  ApiProduces,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PrometheusMetrics } from '../infrastructure/observability/prometheus-metrics';
import { Public } from './auth/public.decorator';

/** Métricas no formato do Prometheus (scrape). É uso interno, sem autenticação de provedor. */
@ApiTags('Operação')
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(PrometheusMetrics) private readonly metrics: PrometheusMetrics,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Métricas do Prometheus',
    description:
      'Métricas no formato texto do Prometheus: transações por status, duplicatas, conflitos de concorrência, retentativas, DLQ, lag da outbox, latência e reconciliações, além das métricas do processo.',
  })
  @ApiProduces('text/plain')
  @ApiResponse({
    status: 200,
    description: 'Métricas da instância.',
    content: {
      'text/plain': {
        schema: { type: 'string' },
        example:
          'wagering_transactions_total{channel="http",kind="BET",status="PROCESSED"} 1\nwagering_outbox_lag_seconds 0',
      },
    },
  })
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}

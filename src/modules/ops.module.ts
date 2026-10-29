import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { HealthController } from '../http/health.controller';
import { HttpErrorFilter } from '../http/http-error.filter';
import { MetricsController } from '../http/metrics.controller';
import { CorrelationMiddleware } from '../infrastructure/observability/correlation.middleware';
import { TracingShutdown } from '../infrastructure/observability/tracing-shutdown';
import { TracingMiddleware } from '../infrastructure/observability/tracing.middleware';
import { CoreModule } from './core.module';

/**
 * Rotas operacionais presentes em todos os papéis: `/health/*` (probes do
 * orquestrador) e `/metrics` (Prometheus), com o filtro de erros, o
 * correlation id e o span HTTP (OpenTelemetry). Consumidor e workers também
 * sobem HTTP só para isso.
 */
@Module({
  imports: [CoreModule],
  controllers: [HealthController, MetricsController],
  providers: [
    { provide: APP_FILTER, useClass: HttpErrorFilter },
    TracingShutdown,
  ],
})
export class OpsModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Correlação primeiro: o span HTTP lê o contexto de log ao terminar.
    consumer.apply(CorrelationMiddleware, TracingMiddleware).forRoutes('*');
  }
}

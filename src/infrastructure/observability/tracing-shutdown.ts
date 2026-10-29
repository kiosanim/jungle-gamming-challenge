import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { shutdownTracing } from './tracing';

/**
 * Exporta os spans pendentes no encerramento. Roda depois que workers e
 * consumidores param (`beforeApplicationShutdown`), para incluir os spans do
 * trabalho que terminou durante o shutdown.
 */
@Injectable()
export class TracingShutdown implements OnApplicationShutdown {
  onApplicationShutdown(): Promise<void> {
    return shutdownTracing();
  }
}

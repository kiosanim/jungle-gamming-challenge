import {
  BeforeApplicationShutdown,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';

/**
 * Base dos workers em background. Executa `runCycle` em intervalo fixo, sem
 * deixar ciclos se sobreporem, e no shutdown espera o ciclo em andamento
 * terminar. Isso acontece no `beforeApplicationShutdown`, antes de o pool do
 * PostgreSQL ser fechado. `WORKERS_ENABLED=false` desliga os workers, o que
 * os testes usam para chamar os use cases diretamente.
 */
export abstract class IntervalWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  protected abstract readonly workerName: string;
  protected readonly logger = new Logger(this.constructor.name);
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  protected abstract intervalMs(): number;
  protected abstract runCycle(): Promise<void>;

  onApplicationBootstrap(): void {
    if (process.env.WORKERS_ENABLED === 'false') {
      return;
    }
    this.timer = setInterval(() => this.tick(), this.intervalMs());
  }

  async beforeApplicationShutdown(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  private tick(): void {
    if (this.running) {
      return;
    }
    this.running = this.runCycle()
      .catch((error: Error) =>
        this.logger.error(
          { worker: this.workerName, error: error.name },
          error.stack,
        ),
      )
      .finally(() => {
        this.running = undefined;
      });
  }
}

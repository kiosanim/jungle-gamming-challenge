import type { Subprocess } from 'bun';

/** Ponto de entrada de cada papel; `all` sobe os três num só processo. */
export const ENTRYPOINTS = {
  all: 'src/main.ts',
  api: 'src/main-api.ts',
  consumer: 'src/main-consumer.ts',
  workers: 'src/main-workers.ts',
} as const;

export type AppRole = keyof typeof ENTRYPOINTS;

/**
 * Uma instância real da aplicação, num processo separado. No padrão (`all`),
 * sobe com HTTP, consumidor SQS e workers ligados; com outro papel, só aquele
 * papel, como nas imagens do Compose.
 */
export class AppInstance {
  private process?: Subprocess;

  constructor(
    readonly port: number,
    private readonly env: Record<string, string>,
    readonly role: AppRole = 'all',
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.process = Bun.spawn(['bun', ENTRYPOINTS[this.role]], {
      env: {
        ...process.env,
        PORT: String(this.port),
        WORKERS_ENABLED: 'true',
        AUTH_ENABLED: 'false',
        ...this.env,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await waitFor(async () => {
      const response = await fetch(`${this.url}/health/ready`).catch(
        () => undefined,
      );
      return response?.status === 200;
    }, 20_000);
  }

  /** Encerramento gracioso (SIGTERM); devolve o código de saída. */
  async stop(): Promise<number | null> {
    this.process?.kill('SIGTERM');
    return (await this.process?.exited) ?? null;
  }

  /** Morte abrupta (SIGKILL): sem shutdown hooks, sem ack, sem commit pendente. */
  async crash(): Promise<void> {
    this.process?.kill('SIGKILL');
    await this.process?.exited;
  }
}

export async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) {
      return;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error(`condição não satisfeita em ${timeoutMs}ms`);
}

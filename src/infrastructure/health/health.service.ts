import { Inject, Injectable } from '@nestjs/common';
import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import { queueNames } from '../messaging/sqs';

/** Uma dependência lenta conta como indisponível: readiness deve responder rápido. */
const CHECK_TIMEOUT_MS = 2_000;

export interface DependencyStatus {
  status: 'up' | 'down';
  error?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: { postgres: DependencyStatus; sqs: DependencyStatus };
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SQSClient) private readonly sqs: SQSClient,
  ) {}

  async readiness(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.check(() => this.orm.em.fork().execute('select 1')),
      this.check(() =>
        this.sqs.send(
          new GetQueueUrlCommand({ QueueName: queueNames().wagerTransactions }),
        ),
      ),
    ]);
    return {
      status:
        postgres.status === 'up' && sqs.status === 'up' ? 'ok' : 'unavailable',
      checks: { postgres, sqs },
    };
  }

  private async check(
    probe: () => Promise<unknown>,
  ): Promise<DependencyStatus> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timeout de ${CHECK_TIMEOUT_MS}ms`)),
        CHECK_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([probe(), timeout]);
      return { status: 'up' };
    } catch (error) {
      return { status: 'down', error: (error as Error).name || 'Error' };
    } finally {
      clearTimeout(timer);
    }
  }
}

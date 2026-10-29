import { Module } from '@nestjs/common';
import {
  HandleWagerMessageUseCase,
  type MessageDisposition,
} from '../application/handle-wager-message.use-case';
import { GetWagerTransactionUseCase } from '../application/get-wager-transaction.use-case';
import { GetWalletLedgerUseCase } from '../application/get-wallet-ledger.use-case';
import { GetWalletUseCase } from '../application/get-wallet.use-case';
import {
  ReconcileWalletUseCase,
  type ReconciliationReport,
} from '../application/reconcile-wallet.use-case';
import { OpenWalletUseCase } from '../application/open-wallet.use-case';
import { CLOCK, type Clock } from '../application/ports/clock';
import { METRICS, type Metrics } from '../application/ports/metrics';
import {
  EVENT_PUBLISHER,
  type EventPublisher,
} from '../application/ports/event-publisher';
import {
  ID_GENERATOR,
  type IdGenerator,
} from '../application/ports/id-generator';
import {
  UNIT_OF_WORK,
  type UnitOfWork,
} from '../application/ports/unit-of-work';
import { PublishOutboxUseCase } from '../application/publish-outbox.use-case';
import {
  PurgeExpiredMessagesUseCase,
  retentionPolicyFromEnv,
} from '../application/purge-expired-messages.use-case';
import { ResolvePendingReferencesUseCase } from '../application/resolve-pending-references.use-case';
import { TRACER, type Tracer } from '../application/ports/tracer';
import {
  SubmitWagerTransactionUseCase,
  type SubmitWagerTransactionResult,
} from '../application/submit-wager-transaction.use-case';
import { HealthService } from '../infrastructure/health/health.service';
import { MessagingModule } from '../infrastructure/messaging/messaging.module';
import { PrometheusMetrics } from '../infrastructure/observability/prometheus-metrics';
import { traceUseCase } from '../infrastructure/observability/traced-use-case';
import { OpenTelemetryTracer } from '../infrastructure/observability/tracing';
import { PersistenceModule } from '../infrastructure/persistence/persistence.module';
import { SystemClock } from '../infrastructure/system-clock';
import { UuidV7Generator } from '../infrastructure/uuid-v7-generator';

/*
 * Núcleo compartilhado pelos três papéis (API, consumidor SQS e workers), com
 * PostgreSQL, SQS, relógio, ids, métricas e os use cases. Os use cases não
 * dependem do Nest; eles são instanciados por factories que injetam as portas.
 * É aqui também que cada use case ganha o seu span no trace (`traceUseCase`),
 * sem que o código dele precise saber de tracing.
 */
@Module({
  imports: [PersistenceModule, MessagingModule],
  providers: [
    HealthService,
    PrometheusMetrics,
    { provide: METRICS, useExisting: PrometheusMetrics },
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: TRACER, useClass: OpenTelemetryTracer },
    {
      provide: OpenWalletUseCase,
      useFactory: (uow: UnitOfWork, ids: IdGenerator, clock: Clock) =>
        traceUseCase(new OpenWalletUseCase(uow, ids, clock), {
          methods: ['execute'],
        }),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (uow: UnitOfWork) =>
        traceUseCase(new GetWalletUseCase(uow), { methods: ['execute'] }),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: GetWalletLedgerUseCase,
      useFactory: (uow: UnitOfWork) =>
        traceUseCase(new GetWalletLedgerUseCase(uow), { methods: ['execute'] }),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (uow: UnitOfWork, metrics: Metrics) =>
        traceUseCase(new ReconcileWalletUseCase(uow, metrics), {
          methods: ['execute'],
          describe: (_method, report) => ({
            'wagering.consistent': (report as ReconciliationReport).consistent,
          }),
        }),
      inject: [UNIT_OF_WORK, METRICS],
    },
    {
      provide: SubmitWagerTransactionUseCase,
      useFactory: (
        uow: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        metrics: Metrics,
        tracer: Tracer,
      ) =>
        traceUseCase(
          new SubmitWagerTransactionUseCase(uow, ids, clock, metrics, tracer),
          {
            methods: ['execute'],
            describe: (_method, result) => {
              const { transaction, idempotentReplay, duplicateMessage } =
                result as SubmitWagerTransactionResult;
              return {
                'wagering.kind': transaction.kind,
                'wagering.status': transaction.status,
                'wagering.idempotentReplay': idempotentReplay,
                'wagering.duplicateMessage': duplicateMessage ?? false,
              };
            },
          },
        ),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, METRICS, TRACER],
    },
    {
      provide: GetWagerTransactionUseCase,
      useFactory: (uow: UnitOfWork) =>
        traceUseCase(new GetWagerTransactionUseCase(uow), {
          methods: ['byId', 'byExternalId'],
        }),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: HandleWagerMessageUseCase,
      useFactory: (submit: SubmitWagerTransactionUseCase) =>
        traceUseCase(new HandleWagerMessageUseCase(submit), {
          methods: ['handle'],
          describe: (_method, disposition) => ({
            'wagering.disposition': (disposition as MessageDisposition).action,
          }),
        }),
      inject: [SubmitWagerTransactionUseCase],
    },
    {
      provide: ResolvePendingReferencesUseCase,
      useFactory: (
        uow: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        tracer: Tracer,
      ) => new ResolvePendingReferencesUseCase(uow, ids, clock, tracer),
      inject: [UNIT_OF_WORK, ID_GENERATOR, CLOCK, TRACER],
    },
    {
      provide: PublishOutboxUseCase,
      useFactory: (
        uow: UnitOfWork,
        publisher: EventPublisher,
        clock: Clock,
        tracer: Tracer,
      ) => new PublishOutboxUseCase(uow, publisher, clock, tracer),
      inject: [UNIT_OF_WORK, EVENT_PUBLISHER, CLOCK, TRACER],
    },
    {
      provide: PurgeExpiredMessagesUseCase,
      useFactory: (uow: UnitOfWork, clock: Clock, metrics: Metrics) =>
        new PurgeExpiredMessagesUseCase(
          uow,
          clock,
          retentionPolicyFromEnv(),
          metrics,
        ),
      inject: [UNIT_OF_WORK, CLOCK, METRICS],
    },
  ],
  exports: [
    HealthService,
    PrometheusMetrics,
    METRICS,
    CLOCK,
    ID_GENERATOR,
    OpenWalletUseCase,
    GetWalletUseCase,
    GetWalletLedgerUseCase,
    ReconcileWalletUseCase,
    SubmitWagerTransactionUseCase,
    GetWagerTransactionUseCase,
    HandleWagerMessageUseCase,
    ResolvePendingReferencesUseCase,
    PublishOutboxUseCase,
    PurgeExpiredMessagesUseCase,
  ],
})
export class CoreModule {}

import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { EVENT_PUBLISHER } from '../../application/ports/event-publisher';
import { createSqsClient, queueNames } from './sqs';
import { SqsEventPublisher } from './sqs-event-publisher';

@Global()
@Module({
  providers: [
    { provide: SQSClient, useFactory: createSqsClient },
    {
      provide: EVENT_PUBLISHER,
      useFactory: (sqs: SQSClient) =>
        new SqsEventPublisher(sqs, queueNames().outbox),
      inject: [SQSClient],
    },
  ],
  exports: [SQSClient, EVENT_PUBLISHER],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(@Inject(SQSClient) private readonly sqs: SQSClient) {}

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}

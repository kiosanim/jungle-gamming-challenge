import { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionNotFoundError } from './errors';
import { UnitOfWork } from './ports/unit-of-work';

export class GetWagerTransactionUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<WagerTransaction> {
    const transaction = await this.uow.run((ctx) =>
      ctx.transactions.findById(transactionId),
    );
    if (!transaction) {
      throw new WagerTransactionNotFoundError(transactionId);
    }
    return transaction;
  }

  async byExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction> {
    const transaction = await this.uow.run((ctx) =>
      ctx.transactions.findByExternalId(providerId, externalTransactionId),
    );
    if (!transaction) {
      throw new WagerTransactionNotFoundError(
        `${providerId}/${externalTransactionId}`,
      );
    }
    return transaction;
  }
}

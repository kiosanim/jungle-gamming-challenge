import { Wallet } from '../domain/wallet';
import { WalletNotFoundError } from './errors';
import { UnitOfWork } from './ports/unit-of-work';

export class GetWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<Wallet> {
    const wallet = await this.uow.run((ctx) => ctx.wallets.findById(walletId));
    if (!wallet) {
      throw new WalletNotFoundError(walletId);
    }
    return wallet;
  }
}

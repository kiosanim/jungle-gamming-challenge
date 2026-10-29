import { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { WagerTransaction } from '../domain/wager-transaction';
import { WalletBalanceChanged } from '../domain/wagering-events';
import { Wallet } from '../domain/wallet';
import { Clock } from './ports/clock';
import { IdGenerator } from './ports/id-generator';
import { UnitOfWork } from './ports/unit-of-work';

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
  correlationId: string;
}

/**
 * Abre uma wallet. Se o saldo inicial for positivo, a mesma transação SQL
 * também grava a transação interna `OPENING`, o lançamento `CREDIT` (com a
 * conta de aporte como contrapartida) e o evento `WalletBalanceChanged` na
 * outbox. Uma segunda wallet para o mesmo `playerId + currency` resulta em
 * `WalletAlreadyExistsError`, garantido pela constraint única do banco.
 */
export class OpenWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(command: OpenWalletCommand): Promise<Wallet> {
    const at = this.clock.now();
    const walletId = this.ids.newId();
    const opening = command.initialBalance.isPositive()
      ? { transactionId: this.ids.newId(), entryId: this.ids.newId() }
      : undefined;

    const { wallet, openingEntry } = Wallet.open({
      id: walletId,
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      opening,
      at,
    });

    return this.uow.run(async (ctx) => {
      await ctx.wallets.insert(wallet);

      if (opening && openingEntry) {
        await ctx.transactions.insert(
          WagerTransaction.opening({
            id: opening.transactionId,
            walletId,
            playerId: command.playerId,
            money: command.initialBalance,
            at,
          }),
        );
        await ctx.ledger.append(openingEntry);
        await ctx.outbox.enqueue(
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, openingEntry, {
              eventId: this.ids.newId(),
              correlationId: command.correlationId,
              occurredAt: at,
            }),
          ),
        );
      }

      return wallet;
    });
  }
}

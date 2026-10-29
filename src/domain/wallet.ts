import { DomainError } from './domain-error';
import { CurrencyMismatchError, Money } from './money';
import { LedgerAccount } from './ledger-account';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

/** Débito maior que o saldo disponível. */
export class InsufficientFundsError extends DomainError {
  override readonly name = 'InsufficientFundsError';

  constructor(
    readonly balance: Money,
    readonly requested: Money,
  ) {
    super(
      `Saldo insuficiente: saldo ${balance.toString()}, solicitado ${requested.toString()}`,
    );
  }
}

/** Operação estruturalmente inválida sobre a wallet (valor não positivo, dados obrigatórios ausentes). */
export class InvalidWalletOperationError extends DomainError {
  override readonly name = 'InvalidWalletOperationError';
}

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  /**
   * Identificadores do crédito de abertura. Obrigatório quando
   * `initialBalance` é positivo: o saldo inicial também precisa de lançamento.
   */
  opening?: { transactionId: string; entryId: string };
  at: Date;
}

export interface OpenedWallet {
  wallet: Wallet;
  /** Lançamento `CREDIT` do saldo inicial; ausente quando o saldo inicial é zero. */
  openingEntry?: WalletLedgerEntry;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Movimentação de saldo vinculada a uma transação financeira. */
export interface WalletMovement {
  /** id do lançamento de ledger a ser gerado */
  entryId: string;
  transactionId: string;
  money: Money;
  /** Outro lado da partida dobrada (conta do provedor, nas operações de jogo). */
  counterAccount: LedgerAccount;
  at: Date;
}

/**
 * Aggregate root da carteira. Toda alteração de saldo produz exatamente um
 * lançamento de ledger, devolvido ao chamador para ser persistido na mesma
 * transação SQL. `version` inicia em 1 e só incrementa quando o saldo muda,
 * servindo de base para optimistic locking.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial, em `version` 1. Saldo inicial
   * positivo gera o lançamento `CREDIT` de abertura (transação `OPENING`).
   */
  static open(props: OpenWalletProps): OpenedWallet {
    const { id, playerId, initialBalance, opening, at } = props;

    if (!id || !playerId) {
      throw new InvalidWalletOperationError('id e playerId são obrigatórios');
    }
    if (initialBalance.isNegative()) {
      throw new InvalidWalletOperationError(
        `saldo inicial não pode ser negativo: ${initialBalance.toString()}`,
      );
    }

    const wallet = new Wallet(
      id,
      playerId,
      initialBalance.currency,
      initialBalance,
      1,
      at,
      at,
    );

    if (initialBalance.isZero()) {
      return { wallet };
    }
    if (!opening) {
      throw new InvalidWalletOperationError(
        'saldo inicial positivo exige transação de abertura',
      );
    }

    const openingEntry = WalletLedgerEntry.create({
      id: opening.entryId,
      walletId: id,
      transactionId: opening.transactionId,
      direction: LedgerDirection.Credit,
      money: initialBalance,
      // Abertura: o saldo inicial vem da conta de aporte.
      counterAccount: LedgerAccount.funding(initialBalance.currency),
      balanceBefore: Money.zero(initialBalance.currency),
      balanceAfter: initialBalance,
      walletVersion: 1,
      createdAt: at,
    });
    return { wallet, openingEntry };
  }

  /** Reconstrói a partir da persistência, sem revalidar transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Debita o valor. Lança `InsufficientFundsError` se o saldo ficaria negativo. */
  debit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovable(movement.money);
    if (this._balance.isLessThan(movement.money)) {
      throw new InsufficientFundsError(this._balance, movement.money);
    }
    return this.apply(LedgerDirection.Debit, movement);
  }

  credit(movement: WalletMovement): WalletLedgerEntry {
    this.assertMovable(movement.money);
    return this.apply(LedgerDirection.Credit, movement);
  }

  /** Gera o lançamento (que valida a aritmética) e só então altera o estado. */
  private apply(
    direction: LedgerDirection,
    { entryId, transactionId, money, counterAccount, at }: WalletMovement,
  ): WalletLedgerEntry {
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? this._balance.add(money)
        : this._balance.subtract(money);

    const entry = WalletLedgerEntry.create({
      id: entryId,
      walletId: this.id,
      transactionId,
      direction,
      money,
      counterAccount,
      balanceBefore: this._balance,
      balanceAfter,
      walletVersion: this._version + 1,
      createdAt: at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidWalletOperationError(
        `valor da movimentação deve ser positivo: ${money.toString()}`,
      );
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}

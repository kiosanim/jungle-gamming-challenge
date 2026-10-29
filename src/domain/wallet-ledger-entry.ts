import { DomainError } from './domain-error';
import { LedgerAccount } from './ledger-account';
import { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

/** Lançamento cuja aritmética ou cujos valores violam as regras do ledger. */
export class InvalidLedgerEntryError extends DomainError {
  override readonly name = 'InvalidLedgerEntryError';
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  /** Direção na conta da wallet; a contrapartida recebe a oposta. */
  direction: LedgerDirection;
  money: Money;
  /**
   * Outro lado da partida dobrada: conta do provedor (operações de jogo) ou
   * de aporte (abertura). Mesma moeda da wallet.
   */
  counterAccount: LedgerAccount;
  balanceBefore: Money;
  balanceAfter: Money;
  /**
   * `version` da wallet produzida por este lançamento (abertura = 1). Forma
   * uma sequência sem lacunas por wallet: ordem total do ledger e cursor
   * estável de paginação.
   */
  walletVersion: number;
  createdAt: Date;
}

/** Estado persistido; mesmo formato das props de criação. */
export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento do ledger da wallet. É imutável por construção: não tem campos
 * mutáveis nem métodos de transição, e a instância é congelada.
 *
 * Cada lançamento também é uma transferência de partidas dobradas: `money`
 * entra na conta da wallet com `direction` e na `counterAccount` com a
 * direção oposta. Débitos e créditos se igualam por construção, porque não
 * há como gravar uma perna sem a outra.
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly counterAccount: LedgerAccount,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly walletVersion: number,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /**
   * Cria um novo lançamento validando que o valor é positivo, que os saldos
   * não são negativos e que `balanceBefore ± money === balanceAfter`.
   */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError(
        `valor do lançamento deve ser positivo: ${props.money.toString()}`,
      );
    }
    if (!Number.isInteger(props.walletVersion) || props.walletVersion < 1) {
      throw new InvalidLedgerEntryError(
        `walletVersion deve ser inteiro ≥ 1: ${props.walletVersion}`,
      );
    }
    if (props.counterAccount.currency !== props.money.currency) {
      throw new InvalidLedgerEntryError(
        `contrapartida ${props.counterAccount.id} em moeda diferente do lançamento (${props.money.currency})`,
      );
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError(
        'saldos do lançamento não podem ser negativos',
      );
    }

    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `lançamento desbalanceado: ${props.balanceBefore.toString()} ${props.direction} ` +
          `${props.money.toString()} ≠ ${props.balanceAfter.toString()}`,
      );
    }
    return entry;
  }

  /** Reconstrói a partir da persistência, sem revalidar. */
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.counterAccount,
      state.balanceBefore,
      state.balanceAfter,
      state.walletVersion,
      state.createdAt,
    );
  }

  /** Direção da perna na conta de contrapartida (oposta à da wallet). */
  get counterDirection(): LedgerDirection {
    return this.direction === LedgerDirection.Debit
      ? LedgerDirection.Credit
      : LedgerDirection.Debit;
  }

  /** balanceBefore ± money === balanceAfter. Lança se as moedas divergirem. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}

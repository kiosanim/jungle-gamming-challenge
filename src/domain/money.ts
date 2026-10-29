import { DomainError } from './domain-error';

/** Contrato serializado de um valor monetário: `{ "amount": "25.00", "currency": "BRL" }`. */
export interface MoneyProps {
  amount: string;
  currency: string;
}

/** Entrada monetária malformada (formato, escala, sinal ou moeda inválidos). */
export class InvalidMoneyError extends DomainError {
  override readonly name = 'InvalidMoneyError';
}

/** Operação entre valores de moedas diferentes. */
export class CurrencyMismatchError extends DomainError {
  override readonly name = 'CurrencyMismatchError';

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`Moeda divergente: esperado ${expected}, recebido ${actual}`);
  }
}

/** Escala fixa: todo valor tem exatamente 2 casas decimais. */
const SCALE = 2;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

/**
 * Decimal não negativo, sem sinal, sem zeros à esquerda, sem notação
 * científica e com no máximo 2 casas. Aceita "25", "25.5" e "25.50", que
 * sempre saem com 2 casas na serialização. Nunca arredonda: casas a mais são
 * rejeitadas.
 */
const AMOUNT_PATTERN = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/;

/** Código ISO-4217 alfabético (três letras maiúsculas). */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

/**
 * Value object monetário imutável.
 *
 * O valor é mantido internamente como inteiro em unidades mínimas (centavos)
 * usando `bigint`, o que garante aritmética exata sem `number`/ponto flutuante.
 * Toda operação retorna uma nova instância.
 */
export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /**
   * Constrói a partir do contrato de entrada. Rejeita valores negativos,
   * `NaN`, `Infinity`, notação científica, string vazia e mais de 2 casas.
   */
  static from(props: MoneyProps): Money {
    const currency = Money.parseCurrency(props?.currency);
    const amount: unknown = props?.amount;

    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('amount deve ser uma string decimal');
    }

    const match = AMOUNT_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(
        `amount inválido: "${amount}" (esperado decimal não negativo com até ${SCALE} casas)`,
      );
    }

    const [, integerPart, fractionPart = ''] = match;
    const minorUnits =
      BigInt(integerPart) * SCALE_FACTOR +
      BigInt(fractionPart.padEnd(SCALE, '0'));

    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  /** Igualdade por valor; moedas diferentes simplesmente não são iguais. */
  equals(other: Money): boolean {
    return (
      this.currency === other.currency && this.minorUnits === other.minorUnits
    );
  }

  toJSON(): MoneyProps {
    return { amount: this.formatAmount(), currency: this.currency };
  }

  /** Representação legível, ex.: `"25.00 BRL"`. */
  toString(): string {
    return `${this.formatAmount()} ${this.currency}`;
  }

  private formatAmount(): string {
    const negative = this.minorUnits < 0n;
    const absolute = negative ? -this.minorUnits : this.minorUnits;
    const integerPart = absolute / SCALE_FACTOR;
    const fractionPart = (absolute % SCALE_FACTOR)
      .toString()
      .padStart(SCALE, '0');
    return `${negative ? '-' : ''}${integerPart}.${fractionPart}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(
        `currency inválida: "${String(currency)}" (esperado código ISO-4217)`,
      );
    }
    return currency;
  }
}

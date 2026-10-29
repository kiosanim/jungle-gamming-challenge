import { DomainError } from './domain-error';

/** Identificador de conta contábil fora do formato do plano de contas. */
export class InvalidLedgerAccountError extends DomainError {
  override readonly name = 'InvalidLedgerAccountError';
}

export enum LedgerAccountType {
  /** Contrapartida das operações de jogo de um provedor, por moeda. */
  Provider = 'PROVIDER',
  /** Contrapartida dos créditos de abertura (aporte), por moeda. */
  Funding = 'FUNDING',
}

const PROVIDER_PREFIX = 'provider:';
const FUNDING_PREFIX = 'funding:';

/**
 * Conta de contrapartida do ledger de partidas dobradas. O outro lado de cada
 * lançamento é a conta da própria wallet (o `wallet_id` do lançamento).
 *
 * O `id` é determinístico (`provider:{providerId}:{moeda}` ou
 * `funding:{moeda}`), então dá para referenciar a conta sem consultar o banco
 * e reconstruí-la a partir do id. Não guardamos saldo: o saldo de uma conta
 * de sistema é a soma dos lançamentos em que ela é contrapartida. Uma linha
 * de saldo por provedor seria atualizada por todas as wallets daquele
 * provedor, o que na prática viraria um lock global.
 */
export class LedgerAccount {
  private constructor(
    public readonly id: string,
    public readonly type: LedgerAccountType,
    public readonly currency: string,
    public readonly providerId?: string,
  ) {
    Object.freeze(this);
  }

  static provider(providerId: string, currency: string): LedgerAccount {
    if (!providerId) {
      throw new InvalidLedgerAccountError('providerId é obrigatório');
    }
    return new LedgerAccount(
      `${PROVIDER_PREFIX}${providerId}:${currency}`,
      LedgerAccountType.Provider,
      currency,
      providerId,
    );
  }

  static funding(currency: string): LedgerAccount {
    return new LedgerAccount(
      `${FUNDING_PREFIX}${currency}`,
      LedgerAccountType.Funding,
      currency,
    );
  }

  /** Reconstrói a conta a partir do id persistido. */
  static fromId(id: string): LedgerAccount {
    if (id.startsWith(FUNDING_PREFIX)) {
      return LedgerAccount.funding(id.slice(FUNDING_PREFIX.length));
    }
    if (id.startsWith(PROVIDER_PREFIX)) {
      // a moeda é o último segmento; o providerId pode conter ':'
      const rest = id.slice(PROVIDER_PREFIX.length);
      const separator = rest.lastIndexOf(':');
      if (separator > 0) {
        return LedgerAccount.provider(
          rest.slice(0, separator),
          rest.slice(separator + 1),
        );
      }
    }
    throw new InvalidLedgerAccountError(`conta contábil inválida: ${id}`);
  }
}

import { describe, expect, it } from 'bun:test';
import { LedgerAccount } from './ledger-account';
import { CurrencyMismatchError, Money } from './money';
import {
  CreateLedgerEntryProps,
  InvalidLedgerEntryError,
  LedgerDirection,
  WalletLedgerEntry,
} from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const props = (
  overrides: Partial<CreateLedgerEntryProps> = {},
): CreateLedgerEntryProps => ({
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'tx-1',
  direction: LedgerDirection.Debit,
  money: brl('80.00'),
  counterAccount: LedgerAccount.provider('provider-a', 'BRL'),
  balanceBefore: brl('100.00'),
  balanceAfter: brl('20.00'),
  walletVersion: 2,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

describe('WalletLedgerEntry', () => {
  describe('create', () => {
    it('aceita débito balanceado (100.00 - 80.00 = 20.00)', () => {
      const entry = WalletLedgerEntry.create(props());
      expect(entry.isBalanced()).toBe(true);
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.balanceAfter.equals(brl('20.00'))).toBe(true);
    });

    it('aceita crédito balanceado (20.00 + 5.00 = 25.00)', () => {
      const entry = WalletLedgerEntry.create(
        props({
          direction: LedgerDirection.Credit,
          money: brl('5.00'),
          balanceBefore: brl('20.00'),
          balanceAfter: brl('25.00'),
        }),
      );
      expect(entry.isBalanced()).toBe(true);
    });

    it('aceita débito que zera o saldo', () => {
      const entry = WalletLedgerEntry.create(
        props({ balanceBefore: brl('80.00'), balanceAfter: brl('0.00') }),
      );
      expect(entry.balanceAfter.isZero()).toBe(true);
    });

    it('rejeita lançamento desbalanceado', () => {
      expect(() =>
        WalletLedgerEntry.create(props({ balanceAfter: brl('20.01') })),
      ).toThrow(InvalidLedgerEntryError);
    });

    it('rejeita direção trocada (crédito com aritmética de débito)', () => {
      expect(() =>
        WalletLedgerEntry.create(props({ direction: LedgerDirection.Credit })),
      ).toThrow(InvalidLedgerEntryError);
    });

    it('rejeita valor zero', () => {
      expect(() =>
        WalletLedgerEntry.create(
          props({
            money: brl('0.00'),
            balanceBefore: brl('10.00'),
            balanceAfter: brl('10.00'),
          }),
        ),
      ).toThrow(InvalidLedgerEntryError);
    });

    it('rejeita valor negativo', () => {
      expect(() =>
        WalletLedgerEntry.create(
          props({
            direction: LedgerDirection.Credit,
            money: brl('80.00').negate(),
          }),
        ),
      ).toThrow(InvalidLedgerEntryError);
    });

    it('rejeita saldo resultante negativo', () => {
      expect(() =>
        WalletLedgerEntry.create(
          props({
            balanceBefore: brl('50.00'),
            balanceAfter: brl('30.00').negate(),
          }),
        ),
      ).toThrow(InvalidLedgerEntryError);
    });

    it('rejeita moedas divergentes entre valor e saldos', () => {
      expect(() =>
        WalletLedgerEntry.create(
          props({
            money: usd('80.00'),
            counterAccount: LedgerAccount.provider('provider-a', 'USD'),
          }),
        ),
      ).toThrow(CurrencyMismatchError);
    });

    it('rejeita contrapartida em moeda diferente do lançamento', () => {
      expect(() =>
        WalletLedgerEntry.create(
          props({
            counterAccount: LedgerAccount.provider('provider-a', 'USD'),
          }),
        ),
      ).toThrow(InvalidLedgerEntryError);
    });

    it('rejeita balanceAfter em moeda diferente', () => {
      expect(() =>
        WalletLedgerEntry.create(props({ balanceAfter: usd('20.00') })),
      ).toThrow(InvalidLedgerEntryError);
    });
  });

  describe('partida dobrada', () => {
    it('débito na wallet → crédito na contrapartida, mesmo valor', () => {
      const entry = WalletLedgerEntry.create(props());
      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.counterDirection).toBe(LedgerDirection.Credit);
      expect(entry.counterAccount.id).toBe('provider:provider-a:BRL');
    });

    it('crédito na wallet → débito na contrapartida', () => {
      const entry = WalletLedgerEntry.create(
        props({
          direction: LedgerDirection.Credit,
          balanceAfter: brl('180.00'),
        }),
      );
      expect(entry.counterDirection).toBe(LedgerDirection.Debit);
    });
  });

  it.each([0, -1, 1.5])(
    'rejeita walletVersion inválida (%s)',
    (walletVersion) => {
      expect(() => WalletLedgerEntry.create(props({ walletVersion }))).toThrow(
        InvalidLedgerEntryError,
      );
    },
  );

  describe('imutabilidade', () => {
    it('a instância é congelada e não aceita alteração de campos', () => {
      const entry = WalletLedgerEntry.create(props());
      expect(Object.isFrozen(entry)).toBe(true);
      expect(() => {
        (entry as unknown as { balanceAfter: Money }).balanceAfter =
          brl('999.00');
      }).toThrow(TypeError);
      expect(entry.balanceAfter.equals(brl('20.00'))).toBe(true);
    });
  });

  describe('rehydrate', () => {
    it('reconstrói o estado persistido sem revalidar', () => {
      const state = props({ balanceAfter: brl('99.99') });
      const entry = WalletLedgerEntry.rehydrate(state);
      expect(entry.id).toBe('entry-1');
      expect(entry.isBalanced()).toBe(false);
    });
  });
});

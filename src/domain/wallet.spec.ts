import { describe, expect, it } from 'bun:test';
import { LedgerAccount } from './ledger-account';
import { CurrencyMismatchError, Money } from './money';
import {
  InsufficientFundsError,
  InvalidWalletOperationError,
  Wallet,
  WalletMovement,
} from './wallet';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

const T0 = new Date('2026-01-01T00:00:00Z');
const T1 = new Date('2026-01-01T00:01:00Z');

let sequence = 0;
const movement = (money: Money, at = T1): WalletMovement => {
  sequence += 1;
  return {
    entryId: `entry-${sequence}`,
    transactionId: `tx-${sequence}`,
    money,
    counterAccount: LedgerAccount.provider('provider-a', money.currency),
    at,
  };
};

const openWith = (amount: string): Wallet =>
  Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(amount),
    opening: { transactionId: 'tx-opening', entryId: 'entry-opening' },
    at: T0,
  }).wallet;

/** Saldo reconstruído a partir do ledger, que é a invariante final do desafio. */
const replayLedger = (currency: string, entries: WalletLedgerEntry[]): Money =>
  entries.reduce(
    (balance, entry) =>
      entry.direction === LedgerDirection.Credit
        ? balance.add(entry.money)
        : balance.subtract(entry.money),
    Money.zero(currency),
  );

describe('Wallet', () => {
  describe('open', () => {
    it('abre com saldo inicial, version 1 e lançamento CREDIT de abertura', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('1000.00'),
        opening: { transactionId: 'tx-opening', entryId: 'entry-opening' },
        at: T0,
      });

      expect(wallet.balance.equals(brl('1000.00'))).toBe(true);
      expect(wallet.currency).toBe('BRL');
      expect(wallet.version).toBe(1);
      expect(wallet.createdAt).toEqual(T0);
      expect(wallet.updatedAt).toEqual(T0);

      expect(openingEntry).toBeDefined();
      expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
      expect(openingEntry!.transactionId).toBe('tx-opening');
      expect(openingEntry!.walletId).toBe('wallet-1');
      expect(openingEntry!.balanceBefore.isZero()).toBe(true);
      expect(openingEntry!.balanceAfter.equals(brl('1000.00'))).toBe(true);
    });

    it('com saldo inicial zero não gera lançamento', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.zero('BRL'),
        at: T0,
      });
      expect(wallet.balance.isZero()).toBe(true);
      expect(wallet.version).toBe(1);
      expect(openingEntry).toBeUndefined();
    });

    it('saldo inicial positivo sem transação de abertura é rejeitado', () => {
      expect(() =>
        Wallet.open({
          id: 'wallet-1',
          playerId: 'player-1',
          initialBalance: brl('10.00'),
          at: T0,
        }),
      ).toThrow(InvalidWalletOperationError);
    });

    it('rejeita saldo inicial negativo', () => {
      expect(() =>
        Wallet.open({
          id: 'wallet-1',
          playerId: 'player-1',
          initialBalance: brl('10.00').negate(),
          at: T0,
        }),
      ).toThrow(InvalidWalletOperationError);
    });

    it('rejeita id ou playerId vazios', () => {
      const base = { initialBalance: Money.zero('BRL'), at: T0 };
      expect(() => Wallet.open({ ...base, id: '', playerId: 'p' })).toThrow(
        InvalidWalletOperationError,
      );
      expect(() => Wallet.open({ ...base, id: 'w', playerId: '' })).toThrow(
        InvalidWalletOperationError,
      );
    });

    it('a moeda da wallet é a moeda do saldo inicial', () => {
      const { wallet } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.zero('USD'),
        at: T0,
      });
      expect(wallet.currency).toBe('USD');
    });
  });

  describe('debit', () => {
    it('debita, gera lançamento DEBIT e incrementa a version', () => {
      const wallet = openWith('100.00');
      const entry = wallet.debit(movement(brl('80.00')));

      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(wallet.updatedAt).toEqual(T1);

      expect(entry.direction).toBe(LedgerDirection.Debit);
      expect(entry.money.equals(brl('80.00'))).toBe(true);
      expect(entry.balanceBefore.equals(brl('100.00'))).toBe(true);
      expect(entry.balanceAfter.equals(brl('20.00'))).toBe(true);
      expect(entry.walletId).toBe('wallet-1');
    });

    it('permite debitar exatamente o saldo disponível', () => {
      const wallet = openWith('80.00');
      wallet.debit(movement(brl('80.00')));
      expect(wallet.balance.isZero()).toBe(true);
    });

    it('cenário 100/80/80: o segundo débito é rejeitado por saldo insuficiente', () => {
      const wallet = openWith('100.00');
      wallet.debit(movement(brl('80.00')));

      expect(() => wallet.debit(movement(brl('80.00')))).toThrow(
        InsufficientFundsError,
      );
      expect(wallet.balance.equals(brl('20.00'))).toBe(true);
      expect(wallet.version).toBe(2);
    });

    it('saldo insuficiente não altera saldo, version nem updatedAt', () => {
      const wallet = openWith('10.00');
      expect(() => wallet.debit(movement(brl('10.01')))).toThrow(
        InsufficientFundsError,
      );
      expect(wallet.balance.equals(brl('10.00'))).toBe(true);
      expect(wallet.version).toBe(1);
      expect(wallet.updatedAt).toEqual(T0);
    });

    it('o erro de saldo insuficiente informa saldo e valor solicitado', () => {
      const wallet = openWith('10.00');
      try {
        wallet.debit(movement(brl('25.00')));
        throw new Error('deveria ter lançado');
      } catch (error) {
        expect(error).toBeInstanceOf(InsufficientFundsError);
        const { balance, requested } = error as InsufficientFundsError;
        expect(balance.equals(brl('10.00'))).toBe(true);
        expect(requested.equals(brl('25.00'))).toBe(true);
      }
    });
  });

  describe('credit', () => {
    it('credita, gera lançamento CREDIT e incrementa a version', () => {
      const wallet = openWith('20.00');
      const entry = wallet.credit(movement(brl('5.50')));

      expect(wallet.balance.equals(brl('25.50'))).toBe(true);
      expect(wallet.version).toBe(2);
      expect(entry.direction).toBe(LedgerDirection.Credit);
      expect(entry.balanceBefore.equals(brl('20.00'))).toBe(true);
      expect(entry.balanceAfter.equals(brl('25.50'))).toBe(true);
    });

    it('credita wallet aberta com saldo zero', () => {
      const { wallet } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: Money.zero('BRL'),
        at: T0,
      });
      wallet.credit(movement(brl('1.00')));
      expect(wallet.balance.equals(brl('1.00'))).toBe(true);
      expect(wallet.version).toBe(2);
    });
  });

  describe('validação de movimentações', () => {
    it.each([
      ['debit', (w: Wallet, m: WalletMovement) => w.debit(m)],
      ['credit', (w: Wallet, m: WalletMovement) => w.credit(m)],
    ])(
      '%s em moeda diferente lança CurrencyMismatchError sem alterar estado',
      (_, op) => {
        const wallet = openWith('100.00');
        expect(() => op(wallet, movement(usd('1.00')))).toThrow(
          CurrencyMismatchError,
        );
        expect(wallet.balance.equals(brl('100.00'))).toBe(true);
        expect(wallet.version).toBe(1);
      },
    );

    it.each([
      ['debit', (w: Wallet, m: WalletMovement) => w.debit(m)],
      ['credit', (w: Wallet, m: WalletMovement) => w.credit(m)],
    ])(
      '%s de valor zero é rejeitado (version só muda quando o saldo muda)',
      (_, op) => {
        const wallet = openWith('100.00');
        expect(() => op(wallet, movement(Money.zero('BRL')))).toThrow(
          InvalidWalletOperationError,
        );
        expect(wallet.version).toBe(1);
      },
    );

    it.each([
      ['debit', (w: Wallet, m: WalletMovement) => w.debit(m)],
      ['credit', (w: Wallet, m: WalletMovement) => w.credit(m)],
    ])('%s de valor negativo é rejeitado', (_, op) => {
      const wallet = openWith('100.00');
      expect(() => op(wallet, movement(brl('10.00').negate()))).toThrow(
        InvalidWalletOperationError,
      );
      expect(wallet.balance.equals(brl('100.00'))).toBe(true);
    });
  });

  describe('consistência saldo × ledger', () => {
    it('o saldo é sempre igual ao reconstruído a partir dos lançamentos', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('100.00'),
        opening: { transactionId: 'tx-opening', entryId: 'entry-opening' },
        at: T0,
      });
      const ledger: WalletLedgerEntry[] = [openingEntry!];

      ledger.push(wallet.debit(movement(brl('25.00'))));
      ledger.push(wallet.credit(movement(brl('50.00'))));
      ledger.push(wallet.debit(movement(brl('0.01'))));
      expect(() => wallet.debit(movement(brl('1000.00')))).toThrow(
        InsufficientFundsError,
      );
      ledger.push(wallet.credit(movement(brl('25.00'))));

      expect(replayLedger('BRL', ledger).equals(wallet.balance)).toBe(true);
      expect(wallet.balance.equals(brl('149.99'))).toBe(true);
      // version = 1 (abertura) + 4 movimentações aplicadas
      expect(wallet.version).toBe(5);
    });

    it('cada lançamento carrega a version da wallet que produziu (sequência sem lacunas)', () => {
      const { wallet, openingEntry } = Wallet.open({
        id: 'wallet-1',
        playerId: 'player-1',
        initialBalance: brl('100.00'),
        opening: { transactionId: 'tx-opening', entryId: 'entry-opening' },
        at: T0,
      });
      const first = wallet.debit(movement(brl('10.00')));
      const second = wallet.credit(movement(brl('5.00')));

      expect(
        [openingEntry!, first, second].map((e) => e.walletVersion),
      ).toEqual([1, 2, 3]);
      expect(second.walletVersion).toBe(wallet.version);
    });

    it('os lançamentos encadeiam: balanceAfter de um é balanceBefore do próximo', () => {
      const wallet = openWith('100.00');
      const first = wallet.debit(movement(brl('30.00')));
      const second = wallet.credit(movement(brl('10.00')));
      expect(second.balanceBefore.equals(first.balanceAfter)).toBe(true);
    });
  });

  describe('rehydrate', () => {
    it('reconstrói o estado persistido sem revalidar', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: brl('42.00'),
        version: 7,
        createdAt: T0,
        updatedAt: T1,
      });

      expect(wallet.balance.equals(brl('42.00'))).toBe(true);
      expect(wallet.version).toBe(7);
      expect(wallet.createdAt).toEqual(T0);
      expect(wallet.updatedAt).toEqual(T1);
    });

    it('continua aplicando as invariantes após a reidratação', () => {
      const wallet = Wallet.rehydrate({
        id: 'wallet-1',
        playerId: 'player-1',
        currency: 'BRL',
        balance: brl('42.00'),
        version: 7,
        createdAt: T0,
        updatedAt: T0,
      });

      expect(() => wallet.debit(movement(brl('42.01')))).toThrow(
        InsufficientFundsError,
      );
      wallet.debit(movement(brl('42.00')));
      expect(wallet.version).toBe(8);
    });
  });
});

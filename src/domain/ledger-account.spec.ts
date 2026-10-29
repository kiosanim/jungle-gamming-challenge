import { describe, expect, it } from 'bun:test';
import {
  InvalidLedgerAccountError,
  LedgerAccount,
  LedgerAccountType,
} from './ledger-account';

describe('LedgerAccount', () => {
  it('conta de provedor: id determinístico por provedor e moeda', () => {
    const account = LedgerAccount.provider('provider-a', 'BRL');
    expect(account.id).toBe('provider:provider-a:BRL');
    expect(account.type).toBe(LedgerAccountType.Provider);
    expect(account.providerId).toBe('provider-a');
    expect(account.currency).toBe('BRL');
    expect(Object.isFrozen(account)).toBe(true);
  });

  it('conta de aporte: uma por moeda', () => {
    const account = LedgerAccount.funding('BRL');
    expect(account.id).toBe('funding:BRL');
    expect(account.type).toBe(LedgerAccountType.Funding);
    expect(account.providerId).toBeUndefined();
  });

  it.each([
    ['provider:provider-a:BRL'],
    ['provider:prov:com:dois-pontos:USD'],
    ['funding:BRL'],
  ])('fromId reconstrói a mesma conta (%s)', (id) => {
    expect(LedgerAccount.fromId(id).id).toBe(id);
  });

  it('fromId separa a moeda mesmo com ":" no providerId', () => {
    const account = LedgerAccount.fromId('provider:prov:a:USD');
    expect(account.providerId).toBe('prov:a');
    expect(account.currency).toBe('USD');
  });

  it.each([['wallet:abc'], ['provider:sem-moeda'], ['']])(
    'fromId rejeita id fora do plano de contas (%s)',
    (id) => {
      expect(() => LedgerAccount.fromId(id)).toThrow(InvalidLedgerAccountError);
    },
  );

  it('provedor vazio é inválido', () => {
    expect(() => LedgerAccount.provider('', 'BRL')).toThrow(
      InvalidLedgerAccountError,
    );
  });
});

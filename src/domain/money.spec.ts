import { describe, expect, it } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money } from './money';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const usd = (amount: string) => Money.from({ amount, currency: 'USD' });

describe('Money', () => {
  describe('from', () => {
    it('aceita decimal com 2 casas e preserva o valor', () => {
      expect(brl('25.00').toJSON()).toEqual({
        amount: '25.00',
        currency: 'BRL',
      });
    });

    it.each([
      ['0', '0.00'],
      ['25', '25.00'],
      ['25.5', '25.50'],
      ['0.01', '0.01'],
      ['1000.10', '1000.10'],
    ])('normaliza "%s" para escala fixa de 2 casas ("%s")', (input, output) => {
      expect(brl(input).toJSON().amount).toBe(output);
    });

    it('representa valores muito grandes sem perda de precisão', () => {
      const amount = '92233720368547758070.99';
      expect(brl(amount).toJSON().amount).toBe(amount);
    });

    it.each([
      ['string vazia', ''],
      ['espaços', ' '],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['-Infinity', '-Infinity'],
      ['notação científica', '1e3'],
      ['notação científica com expoente negativo', '2.5E-1'],
      ['mais de 2 casas decimais', '25.001'],
      ['valor negativo', '-25.00'],
      ['sinal positivo explícito', '+25.00'],
      ['zeros à esquerda', '025.00'],
      ['ponto sem casas decimais', '25.'],
      ['ponto sem parte inteira', '.50'],
      ['vírgula como separador', '25,00'],
      ['espaços ao redor', ' 25.00 '],
      ['separador de milhar', '1,000.00'],
      ['hexadecimal', '0x10'],
    ])('rejeita %s ("%s")', (_, amount) => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });

    it('rejeita amount que não seja string', () => {
      expect(() =>
        Money.from({ amount: 25 as unknown as string, currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    });

    it.each(['', 'brl', 'BR', 'BRLX', 'R$', '123'])(
      'rejeita moeda fora do formato ISO-4217 ("%s")',
      (currency) => {
        expect(() => Money.from({ amount: '1.00', currency })).toThrow(
          InvalidMoneyError,
        );
      },
    );
  });

  describe('arredondamento', () => {
    it('nunca arredonda implicitamente: excesso de casas é rejeitado', () => {
      expect(() => brl('0.005')).toThrow(InvalidMoneyError);
      expect(() => brl('19.999')).toThrow(InvalidMoneyError);
    });

    it('soma é exata, sem erro de ponto flutuante (0.10 + 0.20 = 0.30)', () => {
      expect(brl('0.10').add(brl('0.20')).equals(brl('0.30'))).toBe(true);
    });

    it('subtração é exata (1.00 - 0.90 = 0.10)', () => {
      expect(brl('1.00').subtract(brl('0.90')).toJSON().amount).toBe('0.10');
    });

    it('acumula muitas parcelas pequenas sem desvio', () => {
      let total = Money.zero('BRL');
      for (let i = 0; i < 1000; i++) total = total.add(brl('0.01'));
      expect(total.toJSON().amount).toBe('10.00');
    });
  });

  describe('zero', () => {
    it('cria valor zero na moeda informada', () => {
      const zero = Money.zero('BRL');
      expect(zero.isZero()).toBe(true);
      expect(zero.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
    });

    it('rejeita moeda inválida', () => {
      expect(() => Money.zero('xx')).toThrow(InvalidMoneyError);
    });
  });

  describe('operações aritméticas', () => {
    it('add retorna a soma', () => {
      expect(brl('100.00').add(brl('25.50')).toJSON().amount).toBe('125.50');
    });

    it('subtract pode resultar em valor negativo', () => {
      const result = brl('20.00').subtract(brl('80.00'));
      expect(result.isNegative()).toBe(true);
      expect(result.toJSON().amount).toBe('-60.00');
    });

    it('negate inverte o sinal', () => {
      expect(brl('25.00').negate().toJSON().amount).toBe('-25.00');
      expect(brl('25.00').negate().negate().equals(brl('25.00'))).toBe(true);
    });

    it('negate de zero continua zero', () => {
      const zero = Money.zero('BRL').negate();
      expect(zero.isZero()).toBe(true);
      expect(zero.toJSON().amount).toBe('0.00');
    });

    it('formata valores negativos menores que 1 com o sinal correto', () => {
      expect(brl('0.05').negate().toJSON().amount).toBe('-0.05');
    });
  });

  describe('imutabilidade', () => {
    it('operações retornam nova instância sem alterar os operandos', () => {
      const a = brl('10.00');
      const b = brl('5.00');

      const sum = a.add(b);
      const diff = a.subtract(b);
      const negated = a.negate();

      expect(sum).not.toBe(a);
      expect(diff).not.toBe(a);
      expect(negated).not.toBe(a);
      expect(a.toJSON().amount).toBe('10.00');
      expect(b.toJSON().amount).toBe('5.00');
    });

    it('instância é congelada', () => {
      expect(Object.isFrozen(brl('1.00'))).toBe(true);
    });
  });

  describe('consultas', () => {
    it('isZero / isPositive / isNegative', () => {
      expect(brl('0.00').isZero()).toBe(true);
      expect(brl('0.00').isPositive()).toBe(false);
      expect(brl('0.00').isNegative()).toBe(false);

      expect(brl('0.01').isPositive()).toBe(true);
      expect(brl('0.01').negate().isNegative()).toBe(true);
    });

    it('isLessThan compara valores da mesma moeda', () => {
      expect(brl('79.99').isLessThan(brl('80.00'))).toBe(true);
      expect(brl('80.00').isLessThan(brl('80.00'))).toBe(false);
      expect(brl('80.01').isLessThan(brl('80.00'))).toBe(false);
    });

    it('equals compara valor e moeda, ignorando a forma da entrada', () => {
      expect(brl('25').equals(brl('25.00'))).toBe(true);
      expect(brl('25.00').equals(brl('25.01'))).toBe(false);
      expect(brl('25.00').equals(usd('25.00'))).toBe(false);
    });
  });

  describe('conflito de moeda', () => {
    it.each([
      ['add', (a: Money, b: Money) => a.add(b)],
      ['subtract', (a: Money, b: Money) => a.subtract(b)],
      ['isLessThan', (a: Money, b: Money) => a.isLessThan(b)],
    ])('%s entre moedas diferentes lança CurrencyMismatchError', (_, op) => {
      expect(() => op(brl('10.00'), usd('10.00'))).toThrow(
        CurrencyMismatchError,
      );
    });

    it('o erro informa as moedas envolvidas', () => {
      try {
        brl('1.00').add(usd('1.00'));
        throw new Error('deveria ter lançado');
      } catch (error) {
        expect(error).toBeInstanceOf(CurrencyMismatchError);
        expect((error as CurrencyMismatchError).expected).toBe('BRL');
        expect((error as CurrencyMismatchError).actual).toBe('USD');
      }
    });
  });

  describe('serialização', () => {
    it('toJSON produz o contrato { amount, currency }', () => {
      expect(JSON.stringify({ money: brl('25.00') })).toBe(
        '{"money":{"amount":"25.00","currency":"BRL"}}',
      );
    });

    it('toJSON → from é ida e volta sem perda', () => {
      const original = brl('1234.56');
      expect(Money.from(original.toJSON()).equals(original)).toBe(true);
    });

    it('toString é legível para logs', () => {
      expect(brl('25.00').toString()).toBe('25.00 BRL');
      expect(brl('25.00').negate().toString()).toBe('-25.00 BRL');
    });
  });
});

import type { PropertyOptions } from '@mikro-orm/core';

/*
 * Fábricas (e não constantes) porque o MikroORM muta o objeto de opções
 * recebido pelo decorator; compartilhar a mesma instância entre propriedades
 * corrompe o mapeamento de colunas.
 */

/** Valor monetário exato: `numeric(20,2)`, hidratado como string decimal. */
export const moneyColumn = (): PropertyOptions<object> => ({
  type: 'decimal',
  precision: 20,
  scale: 2,
});

/** Código ISO-4217. */
export const currencyColumn = (): PropertyOptions<object> => ({
  type: 'string',
  columnType: 'char(3)',
});

export const timestampColumn = (
  options: { nullable?: boolean } = {},
): PropertyOptions<object> => ({
  type: 'datetime',
  columnType: 'timestamptz(3)',
  ...options,
});

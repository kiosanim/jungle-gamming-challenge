import {
  Check,
  Entity,
  Enum,
  PrimaryKey,
  Property,
  Trigger,
} from '@mikro-orm/decorators/legacy';
import { LedgerAccountType } from '../../../domain/ledger-account';
import { currencyColumn, timestampColumn } from './column-types';

/**
 * Contas de contrapartida do ledger de partidas dobradas; o outro lado de
 * cada lançamento é a conta da wallet. O id é determinístico
 * (`provider:{providerId}:{moeda}` ou `funding:{moeda}`), e a conta é criada
 * no primeiro lançamento que a usa (`ON CONFLICT DO NOTHING`).
 *
 * O schema garante que toda conta de provedor tenha o provedor e que conta de
 * aporte nunca tenha, e um trigger bloqueia `UPDATE` e `DELETE`, deixando as
 * contas imutáveis.
 *
 * Não há saldo materializado: o saldo é a soma dos lançamentos em que a conta
 * é contrapartida.
 */
@Entity({ tableName: 'ledger_account' })
@Check({
  name: 'ledger_account_provider_ck',
  expression: "(type = 'PROVIDER') = (provider_id is not null)",
})
@Check({
  name: 'ledger_account_currency_format_ck',
  expression: "currency ~ '^[A-Z]{3}$'",
})
@Trigger({
  name: 'immutable_trg',
  timing: 'before',
  events: ['update', 'delete'],
  forEach: 'row',
  body: `
    raise exception 'ledger_account é imutável: % proibido', tg_op
      using errcode = 'restrict_violation';
  `,
})
export class LedgerAccountEntity {
  @PrimaryKey({ type: 'string', length: 200 })
  id!: string;

  @Enum({ items: () => LedgerAccountType })
  type!: LedgerAccountType;

  @Property(currencyColumn())
  currency!: string;

  @Property({ type: 'string', length: 128, nullable: true })
  providerId?: string | null;

  @Property(timestampColumn())
  createdAt!: Date;
}

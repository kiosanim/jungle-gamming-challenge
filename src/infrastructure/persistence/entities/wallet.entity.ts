import {
  Check,
  Entity,
  PrimaryKey,
  Property,
  Unique,
} from '@mikro-orm/decorators/legacy';
import { currencyColumn, moneyColumn, timestampColumn } from './column-types';

/**
 * Registro persistido da `Wallet`. O saldo é `numeric(20,2)`, mapeado como
 * string decimal e nunca como `number`.
 */
@Entity({ tableName: 'wallet' })
@Unique({
  name: 'wallet_player_currency_uq',
  properties: ['playerId', 'currency'],
})
@Check({ name: 'wallet_balance_non_negative_ck', expression: 'balance >= 0' })
@Check({
  name: 'wallet_currency_format_ck',
  expression: "currency ~ '^[A-Z]{3}$'",
})
@Check({ name: 'wallet_version_positive_ck', expression: 'version >= 1' })
export class WalletEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'string', length: 128 })
  playerId!: string;

  @Property(currencyColumn())
  currency!: string;

  @Property(moneyColumn())
  balance!: string;

  @Property({ type: 'integer' })
  version!: number;

  @Property(timestampColumn())
  createdAt!: Date;

  @Property(timestampColumn())
  updatedAt!: Date;
}

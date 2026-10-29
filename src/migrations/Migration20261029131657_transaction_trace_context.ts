import { Migration } from '@mikro-orm/migrations';

export class Migration20261029131657_transaction_trace_context extends Migration {
  override name = 'Migration20261029131657_transaction_trace_context';

  override up(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transaction" add "trace_context" varchar(128) null;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transaction" drop column "trace_context";`);
  }
}

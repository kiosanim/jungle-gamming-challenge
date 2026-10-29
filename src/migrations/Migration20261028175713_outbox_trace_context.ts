import { Migration } from '@mikro-orm/migrations';

export class Migration20261028175713_outbox_trace_context extends Migration {
  override name = 'Migration20261028175713_outbox_trace_context';

  override up(): void | Promise<void> {
    this.addSql(
      `alter table "outbox_message" add "trace_context" varchar(128) null;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "outbox_message" drop column "trace_context";`);
  }
}

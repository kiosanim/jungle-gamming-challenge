import { Migration } from '@mikro-orm/migrations';

export class Migration20261028174851_outbox_order_and_retention extends Migration {
  override name = 'Migration20261028174851_outbox_order_and_retention';

  override up(): void | Promise<void> {
    this.addSql(
      `create index "inbox_message_received_idx" on "inbox_message" ("received_at");`,
    );

    this.addSql(`drop index "outbox_message_pending_idx";`);
    this.addSql(`alter table "outbox_message" add "seq" bigserial;`);
    // Backfill (escrito à mão): linhas existentes recebem a sequência na
    // ordem em que eram reservadas antes (occurred_at, id), e a sequência
    // continua depois da maior.
    this.addSql(
      `update "outbox_message" o set "seq" = s.n from (select "id", row_number() over (order by "occurred_at", "id") as n from "outbox_message") s where s."id" = o."id";`,
    );
    this.addSql(
      `select setval(pg_get_serial_sequence('outbox_message', 'seq'), coalesce((select max("seq") from "outbox_message"), 0) + 1, false);`,
    );
    this.addSql(
      `create index "outbox_message_published_idx" on "outbox_message" ("published_at") where published_at is not null;`,
    );
    this.addSql(
      `create index "outbox_message_aggregate_pending_idx" on "outbox_message" ("aggregate_id", "seq") where published_at is null;`,
    );
    this.addSql(
      `create index "outbox_message_pending_idx" on "outbox_message" ("seq") where published_at is null;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(`drop index "inbox_message_received_idx";`);

    this.addSql(`drop index "outbox_message_published_idx";`);
    this.addSql(`drop index "outbox_message_aggregate_pending_idx";`);
    this.addSql(`drop index "outbox_message_pending_idx";`);
    this.addSql(`alter table "outbox_message" drop column "seq";`);
    this.addSql(
      `create index "outbox_message_pending_idx" on "outbox_message" ("occurred_at", "id") where published_at IS NULL;`,
    );
  }
}

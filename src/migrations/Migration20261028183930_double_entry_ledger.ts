import { Migration } from '@mikro-orm/migrations';

export class Migration20261028183930_double_entry_ledger extends Migration {
  override name = 'Migration20261028183930_double_entry_ledger';

  override up(): void | Promise<void> {
    this.addSql(
      `create table "ledger_account" ("id" varchar(200) not null, "type" text not null, "currency" char(3) not null, "provider_id" varchar(128) null, "created_at" timestamptz(3) not null, primary key ("id"));`,
    );

    // Escrito à mão: a coluna entra anulável, recebe o backfill e só então
    // vira NOT NULL (o diff a criaria NOT NULL direto, o que falha em bancos
    // com lançamentos).
    this.addSql(
      `alter table "wallet_ledger_entry" add "counter_account_id" varchar(200) null;`,
    );

    this.addSql(
      `alter table "ledger_account" add constraint "ledger_account_currency_format_ck" check (currency ~ '^[A-Z]{3}\$');`,
    );
    this.addSql(
      `alter table "ledger_account" add constraint "ledger_account_provider_ck" check ((type = 'PROVIDER') = (provider_id is not null));`,
    );
    this.addSql(
      `alter table "ledger_account" add constraint "ledger_account_type_check" check ("type" in ('PROVIDER', 'FUNDING'));`,
    );
    this
      .addSql(`create or replace function "ledger_account_immutable_trg_fn"() returns trigger as \$\$ begin raise exception 'ledger_account é imutável: % proibido', tg_op
      using errcode = 'restrict_violation'; end; \$\$ language plpgsql;`);
    this.addSql(
      `create trigger "immutable_trg" BEFORE UPDATE OR DELETE on "ledger_account" for each ROW execute function "ledger_account_immutable_trg_fn"();`,
    );

    // Backfill (escrito à mão): contrapartida dos lançamentos que já existem,
    // com o aporte na abertura e a conta do provedor nas demais operações. O
    // trigger append-only fica desligado só durante este UPDATE, dentro da
    // transação da migration.
    this
      .addSql(`insert into "ledger_account" ("id", "type", "currency", "provider_id", "created_at")
      select case when t."kind" = 'OPENING' then 'funding:' || w."currency"
                  else 'provider:' || t."provider_id" || ':' || w."currency" end,
             case when t."kind" = 'OPENING' then 'FUNDING' else 'PROVIDER' end,
             w."currency",
             case when t."kind" = 'OPENING' then null else t."provider_id" end,
             min(l."created_at")
        from "wallet_ledger_entry" l
        join "wallet" w on w."id" = l."wallet_id"
        join "wager_transaction" t on t."id" = l."transaction_id"
       group by 1, 2, 3, 4;`);
    this.addSql(
      `alter table "wallet_ledger_entry" disable trigger "append_only_trg";`,
    );
    this.addSql(`update "wallet_ledger_entry" l
         set "counter_account_id" = case when t."kind" = 'OPENING' then 'funding:' || w."currency"
                                         else 'provider:' || t."provider_id" || ':' || w."currency" end
        from "wallet" w, "wager_transaction" t
       where w."id" = l."wallet_id"
         and t."id" = l."transaction_id";`);
    this.addSql(
      `alter table "wallet_ledger_entry" enable trigger "append_only_trg";`,
    );
    this.addSql(
      `alter table "wallet_ledger_entry" alter column "counter_account_id" set not null;`,
    );
    this.addSql(
      `alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_counter_account_id_foreign" foreign key ("counter_account_id") references "ledger_account" ("id") on delete restrict;`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `alter table "wallet_ledger_entry" drop constraint "wallet_ledger_entry_counter_account_id_foreign";`,
    );

    this.addSql(`drop trigger if exists "immutable_trg" on "ledger_account";`);
    this.addSql(`drop function if exists "ledger_account_immutable_trg_fn"();`);
    this.addSql(`drop table if exists "ledger_account" cascade;`);

    this.addSql(
      `alter table "wallet_ledger_entry" drop column "counter_account_id";`,
    );
  }
}

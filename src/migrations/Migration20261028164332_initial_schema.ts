import { Migration } from '@mikro-orm/migrations';

export class Migration20261028164332_initial_schema extends Migration {
  override name = 'Migration20261028164332_initial_schema';

  override up(): void | Promise<void> {
    this.addSql(
      `create table "inbox_message" ("consumer_name" varchar(128) not null, "message_id" varchar(256) not null, "payload_hash" varchar(128) not null, "received_at" timestamptz(3) not null, "processed_at" timestamptz(3) null, primary key ("consumer_name", "message_id"));`,
    );

    this.addSql(
      `create table "outbox_message" ("id" uuid not null, "aggregate_id" varchar(128) not null, "event_type" varchar(128) not null, "payload" jsonb not null, "occurred_at" timestamptz(3) not null, "attempts" int not null, "next_attempt_at" timestamptz(3) null, "published_at" timestamptz(3) null, primary key ("id"));`,
    );
    this.addSql(
      `create index "outbox_message_pending_idx" on "outbox_message" ("occurred_at", "id") where published_at is null;`,
    );

    this.addSql(
      `create table "wallet" ("id" uuid not null, "player_id" varchar(128) not null, "currency" char(3) not null, "balance" numeric(20,2) not null, "version" int not null, "created_at" timestamptz(3) not null, "updated_at" timestamptz(3) not null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "wallet" add constraint "wallet_player_currency_uq" unique ("player_id", "currency");`,
    );

    this.addSql(
      `create table "wager_transaction" ("id" uuid not null, "provider_id" varchar(128) not null, "external_transaction_id" varchar(128) not null, "idempotency_key" varchar(256) not null, "payload_hash" varchar(128) not null, "wallet_id" uuid not null, "player_id" varchar(128) not null, "round_id" varchar(128) not null, "game_id" varchar(128) not null, "kind" text not null, "amount" numeric(20,2) not null, "currency" char(3) not null, "reference_external_transaction_id" varchar(128) null, "reference_transaction_id" uuid null, "status" text not null, "failure_code" text null, "created_at" timestamptz(3) not null, "processed_at" timestamptz(3) null, "balance_after" numeric(20,2) null, "reference_attempts" int not null default 0, "next_reference_check_at" timestamptz(3) null, primary key ("id"));`,
    );
    this.addSql(
      `create index "wager_transaction_pending_reference_idx" on "wager_transaction" ("next_reference_check_at") where status = 'PENDING_REFERENCE';`,
    );
    this.addSql(
      `create unique index "wager_transaction_single_reversal_uq" on "wager_transaction" ("reference_transaction_id") where kind in ('REFUND', 'ROLLBACK');`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_provider_idempotency_key_uq" unique ("provider_id", "idempotency_key");`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_provider_external_uq" unique ("provider_id", "external_transaction_id");`,
    );

    this.addSql(
      `create table "wallet_ledger_entry" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" text not null, "amount" numeric(20,2) not null, "balance_before" numeric(20,2) not null, "balance_after" numeric(20,2) not null, "wallet_version" int not null, "created_at" timestamptz(3) not null, primary key ("id"));`,
    );
    this.addSql(
      `alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_wallet_version_uq" unique ("wallet_id", "wallet_version");`,
    );
    this.addSql(
      `alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_transaction_wallet_uq" unique ("transaction_id", "wallet_id");`,
    );

    this.addSql(
      `alter table "outbox_message" add constraint "outbox_message_attempts_non_negative_ck" check (attempts >= 0);`,
    );

    this.addSql(
      `alter table "wallet" add constraint "wallet_version_positive_ck" check (version >= 1);`,
    );
    this.addSql(
      `alter table "wallet" add constraint "wallet_currency_format_ck" check (currency ~ '^[A-Z]{3}\$');`,
    );
    this.addSql(
      `alter table "wallet" add constraint "wallet_balance_non_negative_ck" check (balance >= 0);`,
    );

    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_wallet_id_foreign" foreign key ("wallet_id") references "wallet" ("id") on delete restrict;`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_reference_transaction_id_foreign" foreign key ("reference_transaction_id") references "wager_transaction" ("id") on delete restrict;`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_balance_after_ck" check ((balance_after is null or balance_after >= 0) and (status <> 'PROCESSED' or balance_after is not null));`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_processed_reference_ck" check (status <> 'PROCESSED' or reference_external_transaction_id is null or reference_transaction_id is not null);`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_resolved_reference_ck" check (reference_transaction_id is null or (status = 'PROCESSED' and reference_external_transaction_id is not null and reference_transaction_id <> id));`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_failure_code_ck" check ((status in ('REJECTED', 'FAILED')) = (failure_code is not null));`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_processed_at_ck" check ((status = 'PROCESSED') = (processed_at is not null));`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_reference_forbidden_ck" check (kind not in ('BET', 'OPENING') or reference_external_transaction_id is null);`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_reference_required_ck" check (kind not in ('REFUND', 'ROLLBACK') or reference_external_transaction_id is not null);`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_currency_format_ck" check (currency ~ '^[A-Z]{3}\$');`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_amount_ck" check (amount > 0 or (kind = 'LOSS' and amount = 0));`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_reference_schedule_ck" check (reference_attempts >= 0 and (status <> 'PENDING_REFERENCE' or next_reference_check_at is not null));`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`,
    );
    this.addSql(
      `alter table "wager_transaction" add constraint "wager_transaction_failure_code_check" check ("failure_code" in ('INSUFFICIENT_FUNDS', 'REVERSAL_INSUFFICIENT_FUNDS', 'CURRENCY_MISMATCH', 'WALLET_NOT_FOUND', 'WALLET_PLAYER_MISMATCH', 'REFERENCE_NOT_FOUND', 'REFERENCE_MISMATCH', 'REFERENCE_KIND_NOT_ALLOWED', 'REFERENCE_NOT_PROCESSED', 'REFERENCE_ALREADY_REVERSED', 'REVERSAL_AMOUNT_MISMATCH', 'PROCESSING_FAILED'));`,
    );
    this
      .addSql(`create or replace function "wager_transaction_immutable_trg_fn"() returns trigger as \$\$ begin if tg_op = 'DELETE' then
      raise exception 'wager_transaction é imutável: delete proibido (id=%)', old.id
        using errcode = 'restrict_violation';     end if;     if old.status in ('PROCESSED', 'REJECTED', 'FAILED') then
      raise exception 'wager_transaction % em estado terminal %', old.id, old.status
        using errcode = 'restrict_violation';     end if;     if (new.id, new.provider_id, new.external_transaction_id, new.idempotency_key,
        new.payload_hash, new.wallet_id, new.player_id, new.round_id, new.game_id,
        new.kind, new.amount, new.currency, new.reference_external_transaction_id,
        new.created_at)
       is distinct from
       (old.id, old.provider_id, old.external_transaction_id, old.idempotency_key,
        old.payload_hash, old.wallet_id, old.player_id, old.round_id, old.game_id,
        old.kind, old.amount, old.currency, old.reference_external_transaction_id,
        old.created_at) then
      raise exception 'wager_transaction %: campos de negócio são imutáveis', old.id
        using errcode = 'restrict_violation';     end if;     return new; end; \$\$ language plpgsql;`);
    this.addSql(
      `create trigger "immutable_trg" BEFORE UPDATE OR DELETE on "wager_transaction" for each ROW execute function "wager_transaction_immutable_trg_fn"();`,
    );

    this.addSql(
      `alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_wallet_id_foreign" foreign key ("wallet_id") references "wallet" ("id") on delete restrict;`,
    );
    this.addSql(
      `alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_transaction_id_foreign" foreign key ("transaction_id") references "wager_transaction" ("id") on delete restrict;`,
    );
    this.addSql(
      `alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_balanced_ck" check ((direction = 'CREDIT' and balance_after = balance_before + amount) or (direction = 'DEBIT' and balance_after = balance_before - amount));`,
    );
    this.addSql(
      `alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_balances_non_negative_ck" check (balance_before >= 0 and balance_after >= 0);`,
    );
    this.addSql(
      `alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_amount_positive_ck" check (amount > 0);`,
    );
    this.addSql(
      `alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_wallet_version_ck" check (wallet_version >= 1);`,
    );
    this.addSql(
      `alter table "wallet_ledger_entry" add constraint "wallet_ledger_entry_direction_check" check ("direction" in ('DEBIT', 'CREDIT'));`,
    );
    this
      .addSql(`create or replace function "wallet_ledger_entry_append_only_trg_fn"() returns trigger as \$\$ begin raise exception 'wallet_ledger_entry é append-only: % proibido', tg_op
      using errcode = 'restrict_violation'; end; \$\$ language plpgsql;`);
    this.addSql(
      `create trigger "append_only_trg" BEFORE UPDATE OR DELETE on "wallet_ledger_entry" for each ROW execute function "wallet_ledger_entry_append_only_trg_fn"();`,
    );

    // Escrito à mão: a introspecção do MikroORM não enxerga triggers de
    // TRUNCATE, então ele não pode ser declarado na entity (seria recriado a cada diff).
    this
      .addSql(`create or replace function "wallet_ledger_entry_no_truncate_trg_fn"() returns trigger as \$\$ begin raise exception 'wallet_ledger_entry é append-only: % proibido', tg_op
      using errcode = 'restrict_violation'; end; \$\$ language plpgsql;`);
    this.addSql(
      `create trigger "no_truncate_trg" before truncate on "wallet_ledger_entry" for each statement execute function "wallet_ledger_entry_no_truncate_trg_fn"();`,
    );
  }

  override down(): void | Promise<void> {
    this.addSql(
      `alter table "wager_transaction" drop constraint "wager_transaction_wallet_id_foreign";`,
    );
    this.addSql(
      `alter table "wallet_ledger_entry" drop constraint "wallet_ledger_entry_wallet_id_foreign";`,
    );
    this.addSql(
      `alter table "wager_transaction" drop constraint "wager_transaction_reference_transaction_id_foreign";`,
    );
    this.addSql(
      `alter table "wallet_ledger_entry" drop constraint "wallet_ledger_entry_transaction_id_foreign";`,
    );

    this.addSql(`drop table if exists "inbox_message" cascade;`);
    this.addSql(`drop table if exists "outbox_message" cascade;`);
    this.addSql(`drop table if exists "wallet" cascade;`);
    this.addSql(
      `drop trigger if exists "immutable_trg" on "wager_transaction";`,
    );
    this.addSql(
      `drop function if exists "wager_transaction_immutable_trg_fn"();`,
    );
    this.addSql(`drop table if exists "wager_transaction" cascade;`);
    this.addSql(
      `drop trigger if exists "no_truncate_trg" on "wallet_ledger_entry";`,
    );
    this.addSql(
      `drop function if exists "wallet_ledger_entry_no_truncate_trg_fn"();`,
    );
    this.addSql(
      `drop trigger if exists "append_only_trg" on "wallet_ledger_entry";`,
    );
    this.addSql(
      `drop function if exists "wallet_ledger_entry_append_only_trg_fn"();`,
    );
    this.addSql(`drop table if exists "wallet_ledger_entry" cascade;`);
  }
}

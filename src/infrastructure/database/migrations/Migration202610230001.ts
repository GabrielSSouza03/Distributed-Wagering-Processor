import { Migration } from "@mikro-orm/migrations";

export class InitialSchema202610230001 extends Migration {
  override up(): void {
    this.addSql(`
      do $$
      begin
        if not exists (select 1 from pg_roles where rolname = 'wagering_app') then
          create role wagering_app login password 'wagering_app';
        end if;
      end $$;

      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency varchar(3) not null,
        balance numeric(19,2) not null,
        version integer not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallets_player_currency_unique unique (player_id, currency),
        constraint wallets_currency_format check (currency ~ '^[A-Z]{3}$'),
        constraint wallets_non_negative_balance check (balance >= 0),
        constraint wallets_positive_version check (version >= 1)
      );

      create table wager_transactions (
        id uuid primary key,
        provider_id varchar(128) not null,
        external_transaction_id varchar(128) not null,
        idempotency_key varchar(255) not null,
        payload_hash char(64) not null,
        wallet_id uuid not null references wallets(id),
        player_id uuid not null,
        round_id varchar(128) not null,
        game_id varchar(128) not null,
        kind varchar(16) not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(19,2) not null check (amount >= 0),
        currency varchar(3) not null,
        reference_external_transaction_id varchar(128),
        reference_transaction_id uuid references wager_transactions(id),
        status varchar(32) not null check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code varchar(64),
        resulting_balance numeric(19,2),
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        created_at timestamptz not null,
        processed_at timestamptz,
        constraint wager_provider_idempotency_unique unique (provider_id, idempotency_key),
        constraint wager_provider_external_unique unique (provider_id, external_transaction_id),
        constraint wager_reference_required check (
          (kind in ('REFUND','ROLLBACK') and reference_external_transaction_id is not null)
          or (kind not in ('REFUND','ROLLBACK'))
        )
      );
      create index wager_wallet_created_idx on wager_transactions(wallet_id, created_at);
      create index wager_pending_reference_idx on wager_transactions(next_attempt_at)
        where status = 'PENDING_REFERENCE';
      create unique index wager_one_reversal_idx
        on wager_transactions(reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED';

      create table wallet_ledger_entries (
        seq bigint generated always as identity primary key,
        id uuid not null unique,
        wallet_id uuid not null references wallets(id),
        transaction_id uuid not null references wager_transactions(id),
        direction varchar(8) not null check (direction in ('DEBIT','CREDIT')),
        amount numeric(19,2) not null check (amount > 0),
        currency varchar(3) not null,
        balance_before numeric(19,2) not null check (balance_before >= 0),
        balance_after numeric(19,2) not null check (balance_after >= 0),
        created_at timestamptz not null,
        constraint ledger_transaction_wallet_unique unique (transaction_id, wallet_id),
        constraint ledger_balanced check (
          (direction = 'DEBIT' and balance_before - amount = balance_after)
          or (direction = 'CREDIT' and balance_before + amount = balance_after)
        )
      );
      create index ledger_wallet_seq_idx on wallet_ledger_entries(wallet_id, seq);

      create table inbox_messages (
        id uuid primary key,
        message_id varchar(255) not null,
        consumer_name varchar(128) not null,
        payload_hash char(64) not null,
        received_at timestamptz not null,
        processed_at timestamptz,
        constraint inbox_consumer_message_unique unique (consumer_name, message_id)
      );

      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type varchar(128) not null,
        payload jsonb not null,
        traceparent varchar(255),
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz,
        claimed_until timestamptz
      );
      create index outbox_pending_idx on outbox_messages(next_attempt_at, occurred_at)
        where published_at is null;

      create function prevent_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'wallet ledger is append-only' using errcode = '55000';
      end $$;
      create trigger wallet_ledger_immutable
        before update or delete on wallet_ledger_entries
        for each row execute function prevent_ledger_mutation();
      create trigger wallet_ledger_no_truncate
        before truncate on wallet_ledger_entries
        for each statement execute function prevent_ledger_mutation();

      create function prevent_terminal_transaction_mutation() returns trigger language plpgsql as $$
      begin
        if old.status in ('PROCESSED','REJECTED','FAILED') and new is distinct from old then
          raise exception 'terminal wager transaction is immutable' using errcode = '55000';
        end if;
        return new;
      end $$;
      create trigger wager_terminal_immutable
        before update on wager_transactions
        for each row execute function prevent_terminal_transaction_mutation();

      grant select, insert, update on wallets, wager_transactions, inbox_messages, outbox_messages to wagering_app;
      grant select, insert on wallet_ledger_entries to wagering_app;
      grant usage, select on sequence wallet_ledger_entries_seq_seq to wagering_app;
    `);
  }

  override down(): void {
    this.addSql(`
      drop table if exists outbox_messages;
      drop table if exists inbox_messages;
      drop table if exists wallet_ledger_entries;
      drop table if exists wager_transactions;
      drop table if exists wallets;
      drop function if exists prevent_terminal_transaction_mutation();
      drop function if exists prevent_ledger_mutation();
    `);
  }
}

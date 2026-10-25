import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config.js";
import { assertLedgerMatchesBalance } from "../support/invariants.js";

let orm: MikroORM;
const immutableWalletId = crypto.randomUUID();
const immutableTransactionId = crypto.randomUUID();
const immutableLedgerId = crypto.randomUUID();

beforeAll(async () => {
  orm = await MikroORM.init({
    ...config,
    clientUrl:
      process.env.MIGRATION_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/wagering",
  });
  const connection = orm.em.fork().getConnection();
  await connection.execute(
    `insert into wallets(id, player_id, currency, balance, version, created_at, updated_at)
     values (?, ?, 'BRL', 1.00, 1, now(), now())`,
    [immutableWalletId, crypto.randomUUID()],
  );
  await connection.execute(
    `insert into wager_transactions(
      id, provider_id, external_transaction_id, idempotency_key, payload_hash,
      wallet_id, player_id, round_id, game_id, kind, amount, currency,
      status, resulting_balance, created_at, processed_at)
     select ?, 'schema-test', ?, ?, repeat('a', 64), id, player_id,
       'opening', 'internal', 'OPENING', 1.00, 'BRL', 'PROCESSED', 1.00, now(), now()
     from wallets where id = ?`,
    [immutableTransactionId, immutableTransactionId, immutableTransactionId, immutableWalletId],
  );
  await connection.execute(
    `insert into wallet_ledger_entries(
      id, wallet_id, transaction_id, direction, amount, currency,
      balance_before, balance_after, created_at)
     values (?, ?, ?, 'CREDIT', 1.00, 'BRL', 0.00, 1.00, now())`,
    [immutableLedgerId, immutableWalletId, immutableTransactionId],
  );
});

afterAll(async () => {
  await assertLedgerMatchesBalance(orm, [immutableWalletId]);
  await orm.close(true);
});

async function rejectedQuery(query: Promise<unknown>): Promise<unknown> {
  try {
    await query;
  } catch (error) {
    return error;
  }
  throw new Error("expected the query to reject");
}

describe("database invariant enforcement", () => {
  test("database rejects a negative wallet without application code", async () => {
    const error = await rejectedQuery(
      orm.em
        .fork()
        .getConnection()
        .execute(
          `insert into wallets(id, player_id, currency, balance, version, created_at, updated_at)
         values (?, ?, 'BRL', -0.01, 1, now(), now())`,
          [crypto.randomUUID(), crypto.randomUUID()],
        ),
    );
    expect(error).toMatchObject({ code: "23514" });
  });

  test("database rejects duplicate player/currency", async () => {
    const playerId = crypto.randomUUID();
    await orm.em
      .fork()
      .getConnection()
      .execute(
        `insert into wallets(id, player_id, currency, balance, version, created_at, updated_at)
       values (?, ?, 'BRL', 0, 1, now(), now())`,
        [crypto.randomUUID(), playerId],
      );
    const error = await rejectedQuery(
      orm.em
        .fork()
        .getConnection()
        .execute(
          `insert into wallets(id, player_id, currency, balance, version, created_at, updated_at)
         values (?, ?, 'BRL', 0, 1, now(), now())`,
          [crypto.randomUUID(), playerId],
        ),
    );
    expect(error).toMatchObject({ code: "23505" });
  });

  test("ledger rows cannot be updated or deleted", async () => {
    const updateError = await rejectedQuery(
      orm.em
        .fork()
        .getConnection()
        .execute("update wallet_ledger_entries set amount = amount where id = ?", [
          immutableLedgerId,
        ]),
    );
    expect(updateError).toMatchObject({ code: "55000" });
    const deleteError = await rejectedQuery(
      orm.em
        .fork()
        .getConnection()
        .execute("delete from wallet_ledger_entries where id = ?", [immutableLedgerId]),
    );
    expect(deleteError).toBeDefined();
  });

  test("terminal transactions cannot be changed", async () => {
    const error = await rejectedQuery(
      orm.em
        .fork()
        .getConnection()
        .execute("update wager_transactions set status = 'FAILED' where id = ?", [
          immutableTransactionId,
        ]),
    );
    expect(error).toMatchObject({ code: "55000" });
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { AppProcess } from "../support/app-process.js";
import { openAdminOrm, query, scalar } from "../support/db.js";
import { createWallet, waitFor } from "../support/http.js";
import { assertLedgerMatchesBalance } from "../support/invariants.js";
import {
  createIsolatedQueues,
  type IsolatedQueues,
  queueEnvironment,
  sendJson,
  wagerMessage,
  waitForDeadLetter,
} from "../support/queues.js";

let orm: MikroORM;
let queues: IsolatedQueues;
let consumer: AppProcess;
const touchedWallets: string[] = [];

beforeAll(async () => {
  orm = await openAdminOrm();
  queues = await createIsolatedQueues("atomic");
  // No outbox role: published_at stays null, so row versions (xmin) reflect only the financial write.
  consumer = await new AppProcess({
    port: 3341,
    roles: "api,consumer",
    env: { ...queueEnvironment(queues), WAGER_MAX_RECEIVES: "2" },
  }).start();
}, 60_000);

afterAll(async () => {
  await consumer.stop();
  await assertLedgerMatchesBalance(orm, touchedWallets);
  await orm.close(true);
});

describe("wallet, ledger, transaction, inbox and outbox commit atomically", () => {
  test("a processed SQS message writes every row in one SQL transaction", async () => {
    const wallet = await createWallet(consumer.baseUrl, "50.00");
    touchedWallets.push(wallet.id);
    const externalTransactionId = `atomic-${crypto.randomUUID()}`;
    const message = wagerMessage({
      providerId: "atomic-provider",
      externalTransactionId,
      idempotencyKey: `atomic-provider:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-atomic",
      gameId: "game",
      kind: "BET",
      money: { amount: "20.00", currency: "BRL" },
    });
    await sendJson(queues.inputUrl, message, wallet.id, message.messageId);

    const transactionId = await waitFor(async () => {
      const [row] = await query<{ id: string }>(
        orm,
        "select id from wager_transactions where provider_id = 'atomic-provider' and external_transaction_id = ?",
        [externalTransactionId],
      );
      return row?.id;
    }, "the transaction row");

    const versions = await query<{ source: string; xmin: string }>(
      orm,
      `select 'wallet' source, xmin::text from wallets where id = ?
       union all select 'transaction', xmin::text from wager_transactions where id = ?
       union all select 'ledger', xmin::text from wallet_ledger_entries where transaction_id = ?
       union all select 'inbox', xmin::text from inbox_messages where message_id = ?
       union all select 'outbox:' || event_type, xmin::text from outbox_messages
         where aggregate_id = ? or payload->'data'->>'transactionId' = ?::text`,
      [wallet.id, transactionId, transactionId, message.messageId, transactionId, transactionId],
    );
    expect(versions.map((row) => row.source).sort()).toEqual([
      "inbox",
      "ledger",
      "outbox:WagerTransactionProcessed",
      "outbox:WalletBalanceChanged",
      "transaction",
      "wallet",
    ]);
    expect(new Set(versions.map((row) => row.xmin)).size).toBe(1);
  }, 30_000);

  test("a message that fails mid-transaction leaves no inbox, transaction or outbox row", async () => {
    const missingWallet = crypto.randomUUID();
    const externalTransactionId = `atomic-fail-${crypto.randomUUID()}`;
    const message = wagerMessage({
      providerId: "atomic-provider",
      externalTransactionId,
      idempotencyKey: `atomic-provider:${externalTransactionId}`,
      playerId: crypto.randomUUID(),
      walletId: missingWallet,
      roundId: "round-atomic",
      gameId: "game",
      kind: "BET",
      money: { amount: "20.00", currency: "BRL" },
    });
    await sendJson(queues.inputUrl, message, missingWallet, message.messageId);

    const letter = await waitForDeadLetter(queues.dlqUrl, message.messageId);
    expect(letter.failureCode).toBe("RETRIES_EXHAUSTED");

    expect(
      await scalar(orm, "select count(*)::text value from inbox_messages where message_id = ?", [
        message.messageId,
      ]),
    ).toBe("0");
    expect(
      await scalar(
        orm,
        "select count(*)::text value from wager_transactions where provider_id = 'atomic-provider' and external_transaction_id = ?",
        [externalTransactionId],
      ),
    ).toBe("0");
    expect(
      await scalar(
        orm,
        "select count(*)::text value from outbox_messages where payload->>'correlationId' = ?",
        [message.messageId],
      ),
    ).toBe("0");
  }, 30_000);
});

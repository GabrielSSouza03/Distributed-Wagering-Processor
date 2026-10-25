import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { AppProcess } from "../support/app-process.js";
import { openAdminOrm, query } from "../support/db.js";
import { createWallet, waitFor } from "../support/http.js";
import { assertLedgerMatchesBalance } from "../support/invariants.js";
import {
  createIsolatedQueues,
  drain,
  type IsolatedQueues,
  queueDepth,
  queueEnvironment,
  sendJson,
  wagerMessage,
  waitForDeadLetter,
} from "../support/queues.js";

const MAX_RECEIVES = 3;
let orm: MikroORM;
let queues: IsolatedQueues;
let consumer: AppProcess;
const touchedWallets: string[] = [];

beforeAll(async () => {
  orm = await openAdminOrm();
  queues = await createIsolatedQueues("dlq");
  consumer = await new AppProcess({
    port: 3351,
    roles: "api,consumer",
    env: { ...queueEnvironment(queues), WAGER_MAX_RECEIVES: String(MAX_RECEIVES) },
  }).start();
}, 60_000);

afterAll(async () => {
  await consumer.stop();
  await assertLedgerMatchesBalance(orm, touchedWallets);
  await orm.close(true);
});

function betData(walletId: string, playerId: string, amount: string): Record<string, unknown> {
  const externalTransactionId = `dlq-${crypto.randomUUID()}`;
  return {
    providerId: "dlq-provider",
    externalTransactionId,
    idempotencyKey: `dlq-provider:${externalTransactionId}`,
    playerId,
    walletId,
    roundId: "round-dlq",
    gameId: "game",
    kind: "BET",
    money: { amount, currency: "BRL" },
  };
}

describe("consumer error classification", () => {
  test("malformed JSON is permanent and goes straight to the DLQ", async () => {
    const marker = `not-json-${crypto.randomUUID()}`;
    await sendJson(queues.inputUrl, `{ ${marker}`, "malformed");

    const letter = await waitForDeadLetter(queues.dlqUrl, marker);
    expect(letter.failureCode).toBe("INVALID_MESSAGE");
    await waitFor(
      async () => ((await queueDepth(queues.inputUrl)) === 0 ? true : undefined),
      "the input queue to be empty",
    );
  }, 30_000);

  test("a contract violation (zero-amount BET) is permanent and goes to the DLQ", async () => {
    const message = wagerMessage(betData(crypto.randomUUID(), crypto.randomUUID(), "0.00"));
    await sendJson(queues.inputUrl, message, "contract");

    const letter = await waitForDeadLetter(queues.dlqUrl, message.messageId);
    expect(letter.failureCode).toBe("INVALID_MESSAGE");
    expect(letter.detail).toContain("money");
  }, 30_000);

  test("a repeated transient failure is retried with backoff, then dead-lettered at the limit", async () => {
    const missingWallet = crypto.randomUUID();
    const message = wagerMessage(betData(missingWallet, crypto.randomUUID(), "1.00"));
    const started = Date.now();
    await sendJson(queues.inputUrl, message, missingWallet);

    const letter = await waitForDeadLetter(queues.dlqUrl, message.messageId, 45_000);
    expect(letter.failureCode).toBe("RETRIES_EXHAUSTED");
    expect(JSON.parse(letter.originalBody)).toEqual(message);
    // Receives 1 and 2 back off 2 s and 4 s before the third receive hits the limit.
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_500);
  }, 60_000);

  test("a business rejection is terminal: acknowledged, persisted, never dead-lettered", async () => {
    const wallet = await createWallet(consumer.baseUrl, "10.00");
    touchedWallets.push(wallet.id);
    const data = betData(wallet.id, wallet.playerId, "500.00");
    const message = wagerMessage(data);
    await sendJson(queues.inputUrl, message, wallet.id);

    const [rejected] = await waitFor(async () => {
      const rows = await query<{ status: string; failure_code: string }>(
        orm,
        "select status, failure_code from wager_transactions where provider_id = 'dlq-provider' and external_transaction_id = ?",
        [String(data.externalTransactionId)],
      );
      return rows.length > 0 ? rows : undefined;
    }, "the rejected transaction");
    expect(rejected).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });

    await waitFor(
      async () => ((await queueDepth(queues.inputUrl)) === 0 ? true : undefined),
      "the rejection to be acknowledged",
    );
    const dead = await drain(queues.dlqUrl, 2);
    expect(dead.some((letter) => (letter.Body ?? "").includes(message.messageId))).toBe(false);
  }, 30_000);
});

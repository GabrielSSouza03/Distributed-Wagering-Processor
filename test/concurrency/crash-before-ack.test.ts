import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { AppProcess } from "../support/app-process.js";
import { openAdminOrm, query, scalar } from "../support/db.js";
import { createWallet, waitFor } from "../support/http.js";
import { assertLedgerMatchesBalance } from "../support/invariants.js";
import {
  createIsolatedQueues,
  type IsolatedQueues,
  queueDepth,
  queueEnvironment,
  sendJson,
  wagerMessage,
} from "../support/queues.js";

let orm: MikroORM;
let queues: IsolatedQueues;
const running: AppProcess[] = [];
const touchedWallets: string[] = [];

beforeAll(async () => {
  orm = await openAdminOrm();
  queues = await createIsolatedQueues("crash");
});

afterAll(async () => {
  await Promise.all(running.map(async (app) => app.stop()));
  await assertLedgerMatchesBalance(orm, touchedWallets);
  await orm.close(true);
});

describe("consumer killed after commit and before ack", () => {
  test("redelivery to another instance does not duplicate the debit", async () => {
    const crashing = await new AppProcess({
      port: 3311,
      roles: "api,consumer",
      env: { ...queueEnvironment(queues), FAIL_AFTER_COMMIT_BEFORE_ACK: "true" },
    }).start();
    running.push(crashing);

    const wallet = await createWallet(crashing.baseUrl, "40.00");
    touchedWallets.push(wallet.id);
    const externalTransactionId = `crash-${crypto.randomUUID()}`;
    const message = wagerMessage({
      providerId: "crash-provider",
      externalTransactionId,
      idempotencyKey: `crash-provider:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-crash",
      gameId: "game",
      kind: "BET",
      money: { amount: "15.00", currency: "BRL" },
    });
    await sendJson(queues.inputUrl, message, wallet.id, message.messageId);

    await waitFor(async () => {
      const response = await fetch(
        `${crashing.baseUrl}/providers/crash-provider/wagering/transactions/${externalTransactionId}`,
      );
      if (response.status !== 200) return undefined;
      const body = (await response.json()) as { status: string };
      return body.status === "PROCESSED" ? body : undefined;
    }, "the committed debit");

    await crashing.kill();
    running.splice(running.indexOf(crashing), 1);

    expect(await queueDepth(queues.inputUrl)).toBe(1);

    const survivor = await new AppProcess({
      port: 3312,
      roles: "consumer",
      env: queueEnvironment(queues),
    }).start();
    running.push(survivor);

    await waitFor(
      async () => ((await queueDepth(queues.inputUrl)) === 0 ? true : undefined),
      "the redelivered message to be acknowledged",
      45_000,
      250,
    );

    expect(
      await scalar(orm, "select balance::text value from wallets where id = ?", [wallet.id]),
    ).toBe("25.00");
    expect(
      await scalar(
        orm,
        "select count(*)::text value from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
        [wallet.id],
      ),
    ).toBe("1");
    const inbox = await query<{ processed: boolean }>(
      orm,
      "select processed_at is not null processed from inbox_messages where message_id = ?",
      [message.messageId],
    );
    expect(inbox).toEqual([{ processed: true }]);
    expect(
      await scalar(
        orm,
        "select count(*)::text value from wager_transactions where provider_id = 'crash-provider' and external_transaction_id = ?",
        [externalTransactionId],
      ),
    ).toBe("1");
  }, 90_000);
});

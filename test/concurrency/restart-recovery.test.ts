import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { AppProcess } from "../support/app-process.js";
import { openAdminOrm, query, scalar } from "../support/db.js";
import { createWallet, waitFor, type WalletRef } from "../support/http.js";
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
  queues = await createIsolatedQueues("restart");
});

afterAll(async () => {
  await Promise.all(running.map(async (app) => app.stop()));
  await assertLedgerMatchesBalance(orm, touchedWallets);
  await orm.close(true);
});

describe("service killed with SIGKILL and restarted", () => {
  test("drains the queue and the outbox with a consistent final state", async () => {
    const providerId = `restart-${crypto.randomUUID().slice(0, 8)}`;
    const first = await new AppProcess({
      port: 3331,
      roles: "api,consumer,outbox,scheduler",
      env: queueEnvironment(queues),
    }).start();
    running.push(first);

    const wallets: WalletRef[] = await Promise.all(
      [0, 1, 2].map(async () => createWallet(first.baseUrl, "100.00")),
    );
    touchedWallets.push(...wallets.map((wallet) => wallet.id));

    for (let index = 0; index < 30; index += 1) {
      const wallet = wallets[index % wallets.length];
      if (!wallet) throw new Error("missing wallet");
      const externalTransactionId = `${providerId}-${String(index)}`;
      const message = wagerMessage({
        providerId,
        externalTransactionId,
        idempotencyKey: `${providerId}:${externalTransactionId}`,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: `round-${String(index)}`,
        gameId: "game",
        kind: "BET",
        money: { amount: "1.00", currency: "BRL" },
      });
      await sendJson(queues.inputUrl, message, wallet.id, message.messageId);
    }

    const countOurs = async () =>
      Number.parseInt(
        await scalar(
          orm,
          "select count(*)::text value from wager_transactions where provider_id = ?",
          [providerId],
        ),
        10,
      );
    await waitFor(async () => ((await countOurs()) > 0 ? true : undefined), "processing to start");
    await first.kill();
    running.splice(running.indexOf(first), 1);

    const restarted = await new AppProcess({
      port: 3332,
      roles: "api,consumer,outbox,scheduler",
      env: queueEnvironment(queues),
    }).start();
    running.push(restarted);

    await waitFor(
      async () =>
        (await countOurs()) === 30 && (await queueDepth(queues.inputUrl)) === 0 ? true : undefined,
      "all 30 messages to be processed and acknowledged",
      60_000,
      250,
    );

    const walletIds = wallets.map((wallet) => wallet.id);
    const placeholders = walletIds.map(() => "?").join(",");
    await waitFor(
      async () => {
        const [row] = await query<{ pending: string }>(
          orm,
          `select count(*)::text pending from outbox_messages
            where published_at is null
              and (aggregate_id in (${placeholders})
                   or aggregate_id in (select id from wager_transactions where provider_id = ?))`,
          [...walletIds, providerId],
        );
        return row?.pending === "0" ? true : undefined;
      },
      "the outbox to be fully published",
      30_000,
      250,
    );

    const statuses = await query<{ status: string; count: string }>(
      orm,
      "select status, count(*)::text count from wager_transactions where provider_id = ? group by status",
      [providerId],
    );
    expect(statuses).toEqual([{ status: "PROCESSED", count: "30" }]);
    for (const wallet of wallets) {
      expect(
        await scalar(orm, "select balance::text value from wallets where id = ?", [wallet.id]),
      ).toBe("90.00");
      expect(
        await scalar(
          orm,
          "select count(*)::text value from wallet_ledger_entries where wallet_id = ? and direction = 'DEBIT'",
          [wallet.id],
        ),
      ).toBe("10");
    }
  }, 120_000);
});

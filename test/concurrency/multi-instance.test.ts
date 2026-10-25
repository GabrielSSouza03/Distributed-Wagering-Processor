import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { type AppProcess, startApps } from "../support/app-process.js";
import { openAdminOrm, scalar } from "../support/db.js";
import { createWallet, postWager, wager, type WalletRef } from "../support/http.js";
import { assertLedgerMatchesBalance } from "../support/invariants.js";

let apps: AppProcess[] = [];
let orm: MikroORM;
const touchedWallets: string[] = [];

beforeAll(async () => {
  orm = await openAdminOrm();
  apps = await startApps([
    { port: 3301, roles: "api" },
    { port: 3302, roles: "api" },
    { port: 3303, roles: "api" },
  ]);
}, 60_000);

afterAll(async () => {
  await Promise.all(apps.map(async (app) => app.stop()));
  await assertLedgerMatchesBalance(orm, touchedWallets);
  await orm.close(true);
});

describe("three application processes on one hot wallet", () => {
  test("60 requests (30 bets, each delivered twice) debit exactly the available balance", async () => {
    const wallet: WalletRef = await createWallet(apps[0]?.baseUrl ?? "", "100.00");
    touchedWallets.push(wallet.id);
    const bets = Array.from({ length: 30 }, () => wager(wallet, { kind: "BET" }));
    const deliveries = bets.flatMap((body) => [body, body]);

    const responses = await Promise.all(
      deliveries.map(async (body, index) => {
        const app = apps[index % apps.length];
        if (!app) throw new Error("missing app");
        return { body, response: await postWager(app.baseUrl, body) };
      }),
    );

    for (const { response } of responses) {
      expect([200, 422]).toContain(response.status);
    }

    const byExternal = new Map<string, { status: string; transactionId: string }[]>();
    for (const { body, response } of responses) {
      const list = byExternal.get(body.externalTransactionId) ?? [];
      list.push({ status: response.body.status, transactionId: response.body.transactionId });
      byExternal.set(body.externalTransactionId, list);
    }
    for (const outcomes of byExternal.values()) {
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]?.transactionId).toBe(outcomes[1]?.transactionId);
      expect(outcomes[0]?.status).toBe(outcomes[1]?.status);
    }

    const finalOutcomes = [...byExternal.values()].map((outcomes) => outcomes[0]?.status);
    expect(finalOutcomes.filter((status) => status === "PROCESSED")).toHaveLength(10);
    expect(finalOutcomes.filter((status) => status === "REJECTED")).toHaveLength(20);
    expect(responses.filter(({ response }) => !response.body.idempotentReplay)).toHaveLength(30);

    const rejectedCodes = new Set(
      responses
        .filter(({ response }) => response.body.status === "REJECTED")
        .map(({ response }) => response.body.failureCode),
    );
    expect([...rejectedCodes]).toEqual(["INSUFFICIENT_FUNDS"]);

    expect(
      await scalar(orm, "select balance::text value from wallets where id = ?", [wallet.id]),
    ).toBe("0.00");
    expect(
      await scalar(
        orm,
        "select count(*)::text value from wallet_ledger_entries where wallet_id = ?",
        [wallet.id],
      ),
    ).toBe("11");
  }, 30_000);
});

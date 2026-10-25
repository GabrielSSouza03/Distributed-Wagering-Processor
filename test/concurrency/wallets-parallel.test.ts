import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { holdWalletLock, openAdminOrm } from "../support/db.js";
import { createWallet, postWager, wager } from "../support/http.js";
import { assertLedgerMatchesBalance } from "../support/invariants.js";
import { startInProcessApi } from "../support/nest-app.js";

const port = 3201;
const baseUrl = `http://127.0.0.1:${String(port)}`;
let app: INestApplication;
let orm: MikroORM;
const touchedWallets: string[] = [];

beforeAll(async () => {
  app = await startInProcessApi(port);
  orm = await openAdminOrm();
});

afterAll(async () => {
  await app.close();
  await assertLedgerMatchesBalance(orm, touchedWallets);
  await orm.close(true);
});

describe("independent wallet concurrency", () => {
  test("a locked wallet does not block a different wallet", async () => {
    const blocked = await createWallet(baseUrl, "50.00");
    const free = await createWallet(baseUrl, "50.00");
    touchedWallets.push(blocked.id, free.id);

    const lock = await holdWalletLock(orm, blocked.id);
    let blockedSettled = false;
    const blockedRequest = postWager(baseUrl, wager(blocked, { kind: "BET" })).finally(() => {
      blockedSettled = true;
    });
    try {
      const freeResponse = await postWager(baseUrl, wager(free, { kind: "BET" }));
      expect(freeResponse.status).toBe(200);
      expect(freeResponse.body.balance.amount).toBe("40.00");
      await Bun.sleep(300);
      expect(blockedSettled).toBe(false);
    } finally {
      await lock.release();
    }

    const blockedResponse = await blockedRequest;
    expect(blockedResponse.status).toBe(200);
    expect(blockedResponse.body.balance.amount).toBe("40.00");
  }, 15_000);

  test("distinct wallets debited in parallel each end consistent", async () => {
    const wallets = await Promise.all(
      Array.from({ length: 8 }, async () => createWallet(baseUrl, "50.00")),
    );
    touchedWallets.push(...wallets.map((wallet) => wallet.id));

    const responses = await Promise.all(
      wallets.flatMap((wallet) =>
        Array.from({ length: 5 }, async () => postWager(baseUrl, wager(wallet, { kind: "BET" }))),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await assertLedgerMatchesBalance(
      orm,
      wallets.map((wallet) => wallet.id),
    );
    const balances = await Promise.all(
      wallets.map(async (wallet) => {
        const response = await fetch(`${baseUrl}/wallets/${wallet.id}`);
        return ((await response.json()) as { balance: { amount: string } }).balance.amount;
      }),
    );
    expect(new Set(balances)).toEqual(new Set(["0.00"]));
  }, 15_000);
});

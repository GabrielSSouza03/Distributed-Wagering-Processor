import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { ReprocessPendingReference } from "../../src/modules/wagering/application/reprocess-pending-reference.js";
import { openAdminOrm, query, scalar } from "../support/db.js";
import { createWallet, postWager, wager, type WalletRef } from "../support/http.js";
import { assertLedgerMatchesBalance } from "../support/invariants.js";
import { startInProcessApi } from "../support/nest-app.js";

const port = 3203;
const baseUrl = `http://127.0.0.1:${String(port)}`;
let app: INestApplication;
let orm: MikroORM;
let reprocess: ReprocessPendingReference;
const touchedWallets: string[] = [];

beforeAll(async () => {
  app = await startInProcessApi(port);
  reprocess = app.get(ReprocessPendingReference);
  orm = await openAdminOrm();
});

afterAll(async () => {
  await app.close();
  await assertLedgerMatchesBalance(orm, touchedWallets);
  await orm.close(true);
});

async function wallet(amount: string): Promise<WalletRef> {
  const created = await createWallet(baseUrl, amount);
  touchedWallets.push(created.id);
  return created;
}

async function transaction(id: string): Promise<{ status: string; failureCode: string | null }> {
  const response = await fetch(`${baseUrl}/wagering/transactions/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as { status: string; failureCode: string | null };
}

async function balance(walletId: string): Promise<string> {
  return scalar(orm, "select balance::text value from wallets where id = ?", [walletId]);
}

describe("references delivered out of order", () => {
  test("REFUND before its BET is applied once the BET arrives", async () => {
    const target = await wallet("100.00");
    const bet = wager(target, { kind: "BET" });
    const refund = await postWager(
      baseUrl,
      wager(target, { kind: "REFUND", referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe("PENDING_REFERENCE");

    expect((await postWager(baseUrl, bet)).body.balance.amount).toBe("90.00");
    await reprocess.execute(refund.body.transactionId);

    expect((await transaction(refund.body.transactionId)).status).toBe("PROCESSED");
    expect(await balance(target.id)).toBe("100.00");
  });

  test("two pending REFUNDs of one BET: one applies, the other is rejected without looping", async () => {
    const target = await wallet("100.00");
    const bet = wager(target, { kind: "BET" });
    const refunds = await Promise.all(
      [0, 1].map(async () =>
        postWager(
          baseUrl,
          wager(target, {
            kind: "REFUND",
            referenceExternalTransactionId: bet.externalTransactionId,
          }),
        ),
      ),
    );
    expect(refunds.map((refund) => refund.status)).toEqual([202, 202]);
    await postWager(baseUrl, bet);

    await Promise.allSettled(
      refunds.map(async (refund) => reprocess.execute(refund.body.transactionId)),
    );
    // A unique-index loser is retried by the scheduler; a second pass must settle it.
    await Promise.all(refunds.map(async (refund) => reprocess.execute(refund.body.transactionId)));

    const outcomes = await Promise.all(
      refunds.map(async (refund) => transaction(refund.body.transactionId)),
    );
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect(outcomes.find((outcome) => outcome.status === "REJECTED")?.failureCode).toBe(
      "REFERENCE_ALREADY_REVERSED",
    );
    expect(await balance(target.id)).toBe("100.00");
    expect(
      await scalar(
        orm,
        "select count(*)::text value from wager_transactions where id in (?, ?) and status = 'PENDING_REFERENCE'",
        refunds.map((refund) => refund.body.transactionId),
      ),
    ).toBe("0");
  });

  test("WIN referencing a BET is processed both in order and out of order", async () => {
    const target = await wallet("100.00");
    const bet = wager(target, { kind: "BET" });
    const lateWin = await postWager(
      baseUrl,
      wager(target, {
        kind: "WIN",
        money: { amount: "40.00", currency: "BRL" },
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(lateWin.status).toBe(202);
    await postWager(baseUrl, bet);
    await reprocess.execute(lateWin.body.transactionId);
    expect((await transaction(lateWin.body.transactionId)).status).toBe("PROCESSED");
    expect(await balance(target.id)).toBe("130.00");

    const inOrder = await postWager(
      baseUrl,
      wager(target, { kind: "WIN", referenceExternalTransactionId: bet.externalTransactionId }),
    );
    expect(inOrder.status).toBe(200);
    expect(inOrder.body).toMatchObject({ status: "PROCESSED", balance: { amount: "140.00" } });
  });

  test("a missing reference is deferred with backoff, then rejected with REFERENCE_NOT_FOUND", async () => {
    const target = await wallet("100.00");
    const refund = await postWager(
      baseUrl,
      wager(target, { kind: "REFUND", referenceExternalTransactionId: "never-arrives" }),
    );
    const id = refund.body.transactionId;

    await reprocess.execute(id);
    const [deferred] = await query<{ attempts: number; future: boolean }>(
      orm,
      "select attempts, next_attempt_at > now() future from wager_transactions where id = ?",
      [id],
    );
    expect(deferred).toEqual({ attempts: 1, future: true });
    expect((await transaction(id)).status).toBe("PENDING_REFERENCE");

    await query(
      orm,
      "update wager_transactions set attempts = 7, next_attempt_at = now() - interval '1 second' where id = ?",
      [id],
    );
    await reprocess.execute(id);

    expect(await transaction(id)).toMatchObject({
      status: "REJECTED",
      failureCode: "REFERENCE_NOT_FOUND",
    });
    expect(
      await scalar(
        orm,
        "select count(*)::text value from outbox_messages where aggregate_id = ? and event_type = 'WagerTransactionRejected'",
        [id],
      ),
    ).toBe("1");
    expect(await balance(target.id)).toBe("100.00");
  });

  test("ROLLBACK of a WIN that would go negative is REVERSAL_INSUFFICIENT_FUNDS", async () => {
    const target = await wallet("10.00");
    const bet = wager(target, { kind: "BET" });
    await postWager(baseUrl, bet);
    const win = wager(target, {
      kind: "WIN",
      money: { amount: "50.00", currency: "BRL" },
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await postWager(baseUrl, win)).body.balance.amount).toBe("50.00");
    expect(
      (
        await postWager(
          baseUrl,
          wager(target, { kind: "BET", money: { amount: "50.00", currency: "BRL" } }),
        )
      ).body.balance.amount,
    ).toBe("0.00");

    const rollback = await postWager(
      baseUrl,
      wager(target, {
        kind: "ROLLBACK",
        money: { amount: "50.00", currency: "BRL" },
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    expect(rollback.status).toBe(422);
    expect(rollback.body).toMatchObject({
      status: "REJECTED",
      failureCode: "REVERSAL_INSUFFICIENT_FUNDS",
    });
    expect(await balance(target.id)).toBe("0.00");
  });

  test("a reversal with a different amount is AMOUNT_MISMATCH", async () => {
    const target = await wallet("100.00");
    const bet = wager(target, { kind: "BET" });
    await postWager(baseUrl, bet);
    const refund = await postWager(
      baseUrl,
      wager(target, {
        kind: "REFUND",
        money: { amount: "9.99", currency: "BRL" },
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );
    expect(refund.status).toBe(422);
    expect(refund.body.failureCode).toBe("AMOUNT_MISMATCH");
    expect(await balance(target.id)).toBe("90.00");
  });

  test("a zero-amount BET is an invalid payload, not a server error", async () => {
    const target = await wallet("100.00");
    const response = await fetch(`${baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(
        wager(target, { kind: "BET", money: { amount: "0.00", currency: "BRL" } }),
      ),
    });
    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 400,
      body: { code: "INVALID_REQUEST" },
    });
  });
});

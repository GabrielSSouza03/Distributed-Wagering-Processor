import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { assertLedgerMatchesBalance } from "../support/invariants.js";
import { startInProcessApi } from "../support/nest-app.js";

const port = 3199;
const baseUrl = `http://127.0.0.1:${String(port)}`;
let app: INestApplication;
let orm: MikroORM;
const touchedWallets: string[] = [];

beforeAll(async () => {
  app = await startInProcessApi(port);
  orm = app.get(MikroORM);
});

afterAll(async () => {
  await assertLedgerMatchesBalance(orm, touchedWallets);
  await app.close();
});

describe("financial integration with real PostgreSQL", () => {
  test("50 concurrent deliveries of one wager debit exactly once", async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWallet(playerId, "100.00");
    const body = wagerBody(wallet.id, playerId, "BET", "25.00");
    const key = `${body.providerId}:${body.externalTransactionId}`;

    const responses = await Promise.all(
      Array.from({ length: 50 }, async () =>
        fetch(`${baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key },
          body: JSON.stringify(body),
        }),
      ),
    );
    const payloads = await Promise.all(
      responses.map(async (response) => response.json() as Promise<{ idempotentReplay: boolean }>),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(payloads.filter((payload) => !payload.idempotentReplay)).toHaveLength(1);
    const [row] = await orm.em
      .fork()
      .getConnection()
      .execute<
        { balance: string }[]
      >("select balance::text from wallets where id = ?", [wallet.id]);
    expect(row?.balance).toBe("75.00");
    const [count] = await orm.em
      .fork()
      .getConnection()
      .execute<
        { count: string }[]
      >("select count(*)::text from wallet_ledger_entries where wallet_id = ?", [wallet.id]);
    expect(count?.count).toBe("2");
  }, 30_000);

  test("two 80.00 bets competing for 100.00 produce one debit", async () => {
    const playerId = crypto.randomUUID();
    const wallet = await createWallet(playerId, "100.00");
    const first = wagerBody(wallet.id, playerId, "BET", "80.00");
    const second = wagerBody(wallet.id, playerId, "BET", "80.00");

    const responses = await Promise.all(
      [first, second].map(async (body) =>
        fetch(`${baseUrl}/wagering/transactions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": `${body.providerId}:${body.externalTransactionId}`,
          },
          body: JSON.stringify(body),
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    const reconciliation = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
      method: "POST",
    }).then(
      async (response) =>
        response.json() as Promise<{ consistent: boolean; storedBalance: { amount: string } }>,
    );
    expect(reconciliation).toMatchObject({
      consistent: true,
      storedBalance: { amount: "20.00" },
    });
  });
});

describe("OpenAPI document", () => {
  test("exposes the Zod-derived contract at /docs-json and the UI at /docs", async () => {
    const response = await fetch(`${baseUrl}/docs-json`);
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      paths: Record<
        string,
        Record<
          string,
          {
            requestBody?: {
              content: Record<
                string,
                { schema: { required?: string[]; additionalProperties?: boolean } }
              >;
            };
          }
        >
      >;
    };
    expect(Object.keys(document.paths)).toContain("/wagering/transactions");
    expect(Object.keys(document.paths)).toContain("/wallets/{walletId}/ledger");
    const wagerBody =
      document.paths["/wagering/transactions"]?.post?.requestBody?.content["application/json"]
        ?.schema;
    expect(wagerBody?.additionalProperties).toBe(false);
    expect(wagerBody?.required).toContain("externalTransactionId");
    expect(wagerBody?.required).toContain("money");

    const ui = await fetch(`${baseUrl}/docs`);
    expect(ui.status).toBe(200);
  });
});

async function createWallet(
  playerId: string,
  amount: string,
): Promise<{ id: string; playerId: string }> {
  const response = await fetch(`${baseUrl}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      playerId,
      initialBalance: { amount, currency: "BRL" },
    }),
  });
  expect(response.status).toBe(201);
  const wallet = (await response.json()) as { id: string; playerId: string };
  touchedWallets.push(wallet.id);
  return wallet;
}

function wagerBody(
  walletId: string,
  playerId: string,
  kind: "BET",
  amount: string,
): Record<string, unknown> & { providerId: string; externalTransactionId: string } {
  return {
    providerId: "integration-provider",
    externalTransactionId: crypto.randomUUID(),
    playerId,
    walletId,
    roundId: crypto.randomUUID(),
    gameId: "integration-game",
    kind,
    money: { amount, currency: "BRL" },
  };
}

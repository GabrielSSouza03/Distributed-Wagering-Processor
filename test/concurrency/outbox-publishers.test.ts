import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { AppProcess, startApps } from "../support/app-process.js";
import { openAdminOrm, query } from "../support/db.js";
import { waitFor } from "../support/http.js";
import { assertLedgerMatchesBalance } from "../support/invariants.js";
import {
  createIsolatedQueues,
  drain,
  type IsolatedQueues,
  queueEnvironment,
} from "../support/queues.js";

let orm: MikroORM;
let queues: IsolatedQueues;
const running: AppProcess[] = [];
const touchedWallets: string[] = [];

beforeAll(async () => {
  orm = await openAdminOrm();
  queues = await createIsolatedQueues("outbox");
});

afterAll(async () => {
  await Promise.all(running.map(async (app) => app.stop()));
  await assertLedgerMatchesBalance(orm, touchedWallets);
  await orm.close(true);
});

describe("two outbox publishers over the same table", () => {
  test("every committed event is published, and duplicates keep the same eventId", async () => {
    const correlationId = `outbox-${crypto.randomUUID()}`;
    const api = await new AppProcess({ port: 3321, roles: "api" }).start();
    running.push(api);

    await Promise.all(
      Array.from({ length: 40 }, async () => {
        const response = await fetch(`${api.baseUrl}/wallets`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-correlation-id": correlationId },
          body: JSON.stringify({
            playerId: crypto.randomUUID(),
            initialBalance: { amount: "5.00", currency: "BRL" },
          }),
        });
        expect(response.status).toBe(201);
        touchedWallets.push(((await response.json()) as { id: string }).id);
      }),
    );

    const ours = async () =>
      query<{ id: string; published: boolean }>(
        orm,
        `select id, published_at is not null published
           from outbox_messages where payload->>'correlationId' = ?`,
        [correlationId],
      );
    const committed = await ours();
    expect(committed).toHaveLength(80);
    if (committed.some((row) => row.published)) {
      throw new Error(
        "Outbox rows were published before this test started its publishers: another process with " +
          "the `outbox` role is using this database (e.g. `docker compose --profile app`). Stop it and rerun.",
      );
    }

    const publishers = await startApps([
      { port: 3322, roles: "outbox", env: queueEnvironment(queues) },
      { port: 3323, roles: "outbox", env: queueEnvironment(queues) },
    ]);
    running.push(...publishers);

    await waitFor(
      async () => ((await ours()).every((row) => row.published) ? true : undefined),
      "all outbox rows to be published",
      30_000,
      250,
    );

    const delivered = (await drain(queues.eventsUrl))
      .map(
        (message) => JSON.parse(message.Body ?? "{}") as { eventId: string; correlationId: string },
      )
      .filter((event) => event.correlationId === correlationId);
    const deliveredIds = new Set(delivered.map((event) => event.eventId));
    expect([...deliveredIds].sort()).toEqual(committed.map((row) => row.id).sort());
    expect(delivered.length).toBeGreaterThanOrEqual(committed.length);
  }, 90_000);
});

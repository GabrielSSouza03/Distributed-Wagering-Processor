import { expect } from "bun:test";
import type { MikroORM } from "@mikro-orm/postgresql";
import { query } from "./db.js";

interface WalletCheck {
  id: string;
  stored: string;
  calculated: string;
}

/**
 * Final invariant of every integration and concurrency test:
 * `wallet.balance == balance rebuilt from the ledger`, and no balance is negative.
 * Without ids it checks every wallet in the database.
 */
export async function assertLedgerMatchesBalance(
  orm: MikroORM,
  walletIds?: readonly string[],
): Promise<void> {
  if (walletIds?.length === 0) return;
  const filter = walletIds ? `where w.id in (${walletIds.map(() => "?").join(",")})` : "";
  const rows = await query<WalletCheck>(
    orm,
    `select w.id,
            w.balance::text stored,
            coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19,2)::text calculated
       from wallets w
       left join wallet_ledger_entries l on l.wallet_id = w.id
       ${filter}
      group by w.id`,
    walletIds ? [...walletIds] : [],
  );
  if (walletIds) expect(rows).toHaveLength(new Set(walletIds).size);
  const divergent = rows.filter((row) => row.stored !== row.calculated);
  const negative = rows.filter((row) => row.stored.startsWith("-"));
  expect(divergent).toEqual([]);
  expect(negative).toEqual([]);
}

import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config.js";

export const APP_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://wagering_app:wagering_app@localhost:5432/wagering";

export const ADMIN_DATABASE_URL =
  process.env.MIGRATION_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/wagering";

export async function openAdminOrm(): Promise<MikroORM> {
  return MikroORM.init({ ...config, clientUrl: ADMIN_DATABASE_URL, pool: { min: 1, max: 5 } });
}

export async function query<T extends object>(
  orm: MikroORM,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return orm.em.fork().getConnection().execute<T[]>(sql, params);
}

export async function scalar(orm: MikroORM, sql: string, params: unknown[] = []): Promise<string> {
  const [row] = await query<{ value: unknown }>(orm, sql, params);
  return String(row?.value);
}

/**
 * Holds `SELECT ... FOR UPDATE` on a wallet row until `release` is called, so another
 * process can be observed blocking on (or bypassing) that specific wallet.
 */
export async function holdWalletLock(
  orm: MikroORM,
  walletId: string,
): Promise<{ release: () => Promise<void> }> {
  let releaseLock!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  let acquired!: () => void;
  const lockAcquired = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const transaction = orm.em.fork().transactional(async (em) => {
    await em
      .getConnection()
      .execute(
        "select id from wallets where id = ? for update",
        [walletId],
        "all",
        em.getTransactionContext(),
      );
    acquired();
    await released;
    throw new HeldLockReleased();
  });
  const settled = transaction.catch((error: unknown) => {
    if (!(error instanceof HeldLockReleased)) throw error;
  });
  await lockAcquired;
  return {
    release: async () => {
      releaseLock();
      await settled;
    },
  };
}

class HeldLockReleased extends Error {}

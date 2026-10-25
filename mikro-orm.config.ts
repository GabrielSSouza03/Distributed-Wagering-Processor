import { Migrator } from "@mikro-orm/migrations";
import { defineConfig } from "@mikro-orm/postgresql";
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from "./src/infrastructure/database/records.js";
import { InitialSchema202610230001 } from "./src/infrastructure/database/migrations/Migration202610230001.js";

export default defineConfig({
  clientUrl:
    process.env.DATABASE_URL ??
    "postgresql://wagering_app:wagering_app@localhost:5432/wagering?options=-c%20lock_timeout%3D2s",
  entities: [
    WalletRecord,
    WagerTransactionRecord,
    WalletLedgerEntryRecord,
    InboxMessageRecord,
    OutboxMessageRecord,
  ],
  extensions: [Migrator],
  migrations: {
    migrationsList: [
      {
        name: "Migration202610230001",
        class: InitialSchema202610230001,
      },
    ],
    transactional: true,
    allOrNothing: true,
  },
  allowGlobalContext: false,
  pool: { min: 2, max: 40 },
  debug: process.env.DB_DEBUG === "true",
});

import { z } from "zod";
import { moneySchema, zodToOpenApi } from "../../../shared/http/openapi.js";
import { LedgerDirection } from "../domain/wallet-ledger-entry.js";

const signedMoneySchema = z.object({
  amount: z.string().regex(/^-?(0|[1-9]\d*)\.\d{2}$/),
  currency: moneySchema.shape.currency,
});

export const walletSchema = zodToOpenApi(
  z.object({
    id: z.uuid(),
    playerId: z.uuid(),
    balance: moneySchema,
    version: z.number().int(),
  }),
  "output",
);

export const ledgerPageSchema = zodToOpenApi(
  z.object({
    items: z.array(
      z.object({
        id: z.uuid(),
        transactionId: z.uuid(),
        direction: z.enum(LedgerDirection),
        money: moneySchema,
        balanceBefore: moneySchema,
        balanceAfter: moneySchema,
        createdAt: z.iso.datetime(),
      }),
    ),
    nextCursor: z
      .string()
      .optional()
      .meta({ description: "Opaque cursor for the next page; absent on the last page" }),
  }),
  "output",
);

export const reconciliationSchema = zodToOpenApi(
  z.object({
    walletId: z.uuid(),
    storedBalance: moneySchema,
    calculatedBalance: moneySchema,
    difference: signedMoneySchema,
    consistent: z.boolean(),
    checkedEntries: z.number().int(),
  }),
  "output",
);

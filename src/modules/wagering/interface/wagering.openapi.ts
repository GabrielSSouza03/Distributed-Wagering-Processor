import { z } from "zod";
import { moneySchema, zodToOpenApi } from "../../../shared/http/openapi.js";
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction.js";

export const processWagerResultSchema = zodToOpenApi(
  z.object({
    transactionId: z.uuid(),
    status: z.enum(WagerTransactionStatus),
    balance: moneySchema,
    failureCode: z.enum(FailureCode).optional(),
    idempotentReplay: z
      .boolean()
      .meta({ description: "True when this response replays an already processed delivery" }),
  }),
  "output",
);

export const wagerTransactionSchema = zodToOpenApi(
  z.object({
    transactionId: z.uuid(),
    providerId: z.string(),
    externalTransactionId: z.string(),
    walletId: z.uuid(),
    kind: z.enum(WagerTransactionKind),
    money: moneySchema,
    status: z.enum(WagerTransactionStatus),
    failureCode: z.enum(FailureCode).nullish(),
    balance: moneySchema.optional(),
    createdAt: z.iso.datetime(),
    processedAt: z.iso.datetime().nullish(),
  }),
  "output",
);

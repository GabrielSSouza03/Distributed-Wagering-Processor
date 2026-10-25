import type { SchemaObject } from "@nestjs/swagger";
import { z } from "zod";

export const moneySchema = z.strictObject({
  amount: z
    .string()
    .regex(/^(0|[1-9]\d*)\.\d{2}$/)
    .meta({ description: "Decimal string with exactly two fraction digits", example: "10.00" }),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .meta({ description: "ISO-4217 currency code", example: "BRL" }),
});

export const problemDetailsSchema = zodToOpenApi(
  z
    .object({
      type: z.string(),
      title: z.string(),
      status: z.number().int(),
      detail: z.string(),
      instance: z.string(),
      code: z.string(),
    })
    .meta({ description: "RFC 9457 problem details" }),
  "output",
);

export function zodToOpenApi(schema: z.ZodType, io: "input" | "output" = "input"): SchemaObject {
  return z.toJSONSchema(schema, { target: "openapi-3.0", io }) as SchemaObject;
}

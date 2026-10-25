import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import { MikroORM } from "@mikro-orm/postgresql";
import { z } from "zod";
import { WagerTransactionRecord } from "../../../infrastructure/database/records.js";
import { duplicatesTotal, transactionsTotal } from "../../../infrastructure/metrics.js";
import {
  ProcessWagerTransaction,
  type ProcessWagerResult,
} from "../application/process-wager-transaction.js";
import {
  hasPositiveAmountUnlessLoss,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction.js";

const wagerSchema = z
  .strictObject({
    providerId: z.string().trim().min(1).max(128),
    externalTransactionId: z.string().trim().min(1).max(128),
    playerId: z.uuid(),
    walletId: z.uuid(),
    roundId: z.string().trim().min(1).max(128),
    gameId: z.string().trim().min(1).max(128),
    kind: z.enum([
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Loss,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]),
    money: z.strictObject({
      amount: z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/),
      currency: z.string().regex(/^[A-Z]{3}$/),
    }),
    referenceExternalTransactionId: z.string().trim().min(1).max(128).optional(),
  })
  .refine(hasPositiveAmountUnlessLoss, {
    path: ["money", "amount"],
    message: "Amount must be greater than zero for balance-affecting operations",
  });

interface RequestWithId {
  id: string;
}

@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly orm: MikroORM,
  ) {}

  @Post("wagering/transactions")
  @HttpCode(HttpStatus.OK)
  async create(
    @Body() body: unknown,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("traceparent") traceparent: string | undefined,
    @Req() request: RequestWithId,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ProcessWagerResult> {
    if (!idempotencyKey || idempotencyKey.length > 255) {
      throw new z.ZodError([
        {
          code: "custom",
          path: ["headers", "idempotency-key"],
          message: "Idempotency-Key is required and must have at most 255 characters",
        },
      ]);
    }
    const input = wagerSchema.parse(body);
    const result = await this.processWager.execute({
      providerId: input.providerId,
      externalTransactionId: input.externalTransactionId,
      playerId: input.playerId,
      walletId: input.walletId,
      roundId: input.roundId,
      gameId: input.gameId,
      kind: input.kind,
      money: input.money,
      ...(input.referenceExternalTransactionId
        ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
        : {}),
      idempotencyKey,
      correlationId: request.id,
      ...(traceparent ? { traceparent } : {}),
    });
    if (result.status === WagerTransactionStatus.PendingReference) {
      response.status(HttpStatus.ACCEPTED);
    } else if (result.status === WagerTransactionStatus.Rejected) {
      response.status(HttpStatus.UNPROCESSABLE_ENTITY);
    }
    transactionsTotal.add(1, { status: result.status, kind: input.kind });
    if (result.idempotentReplay) duplicatesTotal.add(1, { kind: input.kind });
    return result;
  }

  @Get("wagering/transactions/:transactionId")
  async getById(@Param("transactionId") transactionId: string): Promise<Record<string, unknown>> {
    return this.findOne({ id: z.uuid().parse(transactionId) });
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByExternal(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ): Promise<Record<string, unknown>> {
    return this.findOne({ providerId, externalTransactionId });
  }

  private async findOne(
    where: { id: string } | { providerId: string; externalTransactionId: string },
  ): Promise<Record<string, unknown>> {
    const transaction = await this.orm.em.fork().findOne(WagerTransactionRecord, where);
    if (!transaction) throw new NotFoundException("Wager transaction not found");
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      kind: transaction.kind,
      money: { amount: transaction.amount, currency: transaction.currency },
      status: transaction.status,
      failureCode: transaction.failureCode,
      balance: transaction.resultingBalance
        ? { amount: transaction.resultingBalance, currency: transaction.currency }
        : undefined,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt,
    };
  }
}

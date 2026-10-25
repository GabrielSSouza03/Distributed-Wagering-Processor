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
import { ApiBody, ApiHeader, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
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
import { moneySchema, problemDetailsSchema, zodToOpenApi } from "../../../shared/http/openapi.js";
import { processWagerResultSchema, wagerTransactionSchema } from "./wagering.openapi.js";

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
    money: moneySchema.extend({
      amount: moneySchema.shape.amount.meta({
        description: "Decimal string with two fraction digits; must be > 0.00 unless kind is LOSS",
        example: "10.00",
      }),
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

@ApiTags("wagering")
@Controller()
export class WageringController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly orm: MikroORM,
  ) {}

  @Post("wagering/transactions")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Process a provider wager transaction (idempotent)" })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description: "At most 255 characters; replays return the original result",
  })
  @ApiHeader({ name: "traceparent", required: false, description: "W3C trace context" })
  @ApiBody({ schema: zodToOpenApi(wagerSchema) })
  @ApiResponse({
    status: HttpStatus.OK,
    description: "Processed, or idempotent replay of a previous delivery",
    schema: processWagerResultSchema,
  })
  @ApiResponse({
    status: HttpStatus.ACCEPTED,
    description: "Waiting for the referenced transaction to arrive (PENDING_REFERENCE)",
    schema: processWagerResultSchema,
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: "Rejected by a business rule (e.g. insufficient funds)",
    schema: processWagerResultSchema,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: "Invalid payload or headers",
    schema: problemDetailsSchema,
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: "Wallet not found",
    schema: problemDetailsSchema,
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: "Same idempotency key reused with a different payload",
    schema: problemDetailsSchema,
  })
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
  @ApiOperation({ summary: "Get a wager transaction by its internal id" })
  @ApiParam({ name: "transactionId", format: "uuid" })
  @ApiResponse({ status: HttpStatus.OK, schema: wagerTransactionSchema })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, schema: problemDetailsSchema })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, schema: problemDetailsSchema })
  async getById(@Param("transactionId") transactionId: string): Promise<Record<string, unknown>> {
    return this.findOne({ id: z.uuid().parse(transactionId) });
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  @ApiOperation({ summary: "Get a wager transaction by provider and external id" })
  @ApiParam({ name: "providerId" })
  @ApiParam({ name: "externalTransactionId" })
  @ApiResponse({ status: HttpStatus.OK, schema: wagerTransactionSchema })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, schema: problemDetailsSchema })
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

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { MikroORM } from "@mikro-orm/postgresql";
import { z } from "zod";
import { WalletLedgerEntryRecord, WalletRecord } from "../../../infrastructure/database/records.js";
import { moneySchema, problemDetailsSchema, zodToOpenApi } from "../../../shared/http/openapi.js";
import { CreateWallet, type CreateWalletResult } from "../application/create-wallet.js";
import { ledgerPageSchema, reconciliationSchema, walletSchema } from "./wallet.openapi.js";

const createWalletSchema = z.strictObject({
  playerId: z.uuid(),
  initialBalance: moneySchema,
});

interface RequestWithId {
  id: string;
  headers: Record<string, string | string[] | undefined>;
}

@ApiTags("wallets")
@Controller("wallets")
export class WalletController {
  constructor(
    private readonly createWallet: CreateWallet,
    private readonly orm: MikroORM,
  ) {}

  @Post()
  @ApiOperation({ summary: "Create a wallet with an opening balance" })
  @ApiHeader({ name: "traceparent", required: false, description: "W3C trace context" })
  @ApiBody({ schema: zodToOpenApi(createWalletSchema) })
  @ApiResponse({ status: HttpStatus.CREATED, schema: walletSchema })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, schema: problemDetailsSchema })
  async create(
    @Body() body: unknown,
    @Req() request: RequestWithId,
    @Headers("traceparent") traceparent?: string,
  ): Promise<CreateWalletResult> {
    const input = createWalletSchema.parse(body);
    return this.createWallet.execute({
      ...input,
      correlationId: request.id,
      ...(traceparent ? { traceparent } : {}),
    });
  }

  @Get(":walletId")
  @ApiOperation({ summary: "Get a wallet and its current balance" })
  @ApiParam({ name: "walletId", format: "uuid" })
  @ApiResponse({ status: HttpStatus.OK, schema: walletSchema })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, schema: problemDetailsSchema })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, schema: problemDetailsSchema })
  async get(@Param("walletId") walletId: string): Promise<Record<string, unknown>> {
    const record = await this.orm.em.fork().findOne(WalletRecord, { id: z.uuid().parse(walletId) });
    if (!record) throw new NotFoundException("Wallet not found");
    return {
      id: record.id,
      playerId: record.playerId,
      balance: { amount: record.balance, currency: record.currency },
      version: record.version,
    };
  }

  @Get(":walletId/ledger")
  @ApiOperation({ summary: "List ledger entries in sequence order (cursor pagination)" })
  @ApiParam({ name: "walletId", format: "uuid" })
  @ApiQuery({ name: "cursor", required: false, description: "nextCursor from the previous page" })
  @ApiQuery({
    name: "limit",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
  })
  @ApiResponse({ status: HttpStatus.OK, schema: ledgerPageSchema })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, schema: problemDetailsSchema })
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") rawLimit?: string,
  ): Promise<Record<string, unknown>> {
    const id = z.uuid().parse(walletId);
    const limit = z.coerce.number().int().min(1).max(100).default(50).parse(rawLimit);
    const afterSeq = cursor ? decodeCursor(cursor) : "0";
    const rows = await this.orm.em
      .fork()
      .createQueryBuilder(WalletLedgerEntryRecord, "entry")
      .select("*")
      .where({ walletId: id })
      .andWhere({ seq: { $gt: afterSeq } })
      .orderBy({ seq: "asc" })
      .limit(limit + 1)
      .execute("all");
    const page = rows.slice(0, limit);
    return {
      items: page.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: { amount: entry.amount, currency: entry.currency },
        balanceBefore: { amount: entry.balanceBefore, currency: entry.currency },
        balanceAfter: { amount: entry.balanceAfter, currency: entry.currency },
        createdAt: entry.createdAt,
      })),
      nextCursor:
        rows.length > limit && page.length > 0 ? encodeCursor(String(page.at(-1)?.seq)) : undefined,
    };
  }

  @Post(":walletId/reconciliation")
  @ApiOperation({ summary: "Compare the stored balance with the sum of ledger entries" })
  @ApiParam({ name: "walletId", format: "uuid" })
  @ApiResponse({ status: HttpStatus.CREATED, schema: reconciliationSchema })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, schema: problemDetailsSchema })
  @ApiResponse({ status: HttpStatus.NOT_FOUND, schema: problemDetailsSchema })
  async reconcile(@Param("walletId") walletId: string): Promise<Record<string, unknown>> {
    const id = z.uuid().parse(walletId);
    const [result] = await this.orm.em
      .fork()
      .getConnection()
      .execute<
        {
          stored_balance: string;
          calculated_balance: string;
          currency: string;
          checked_entries: string;
        }[]
      >(
        `select w.balance::text stored_balance,
        coalesce(sum(case when l.direction = 'CREDIT' then l.amount else -l.amount end), 0)::text calculated_balance,
        w.currency, count(l.seq)::text checked_entries
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
       where w.id = ? group by w.id`,
        [id],
      );
    if (!result) throw new NotFoundException("Wallet not found");
    const difference = (
      BigInt(toCents(result.stored_balance)) - BigInt(toCents(result.calculated_balance))
    ).toString();
    return {
      walletId: id,
      storedBalance: { amount: normalizeAmount(result.stored_balance), currency: result.currency },
      calculatedBalance: {
        amount: normalizeAmount(result.calculated_balance),
        currency: result.currency,
      },
      difference: { amount: centsToAmount(difference), currency: result.currency },
      consistent: difference === "0",
      checkedEntries: Number.parseInt(result.checked_entries, 10),
    };
  }
}

function encodeCursor(seq: string): string {
  return Buffer.from(JSON.stringify({ seq }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): string {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { seq?: unknown };
  return z.string().regex(/^\d+$/).parse(parsed.seq);
}

function normalizeAmount(value: string): string {
  const [units = "0", fraction = ""] = value.split(".");
  return `${units}.${fraction.padEnd(2, "0").slice(0, 2)}`;
}

function toCents(value: string): string {
  return normalizeAmount(value).replace(".", "");
}

function centsToAmount(value: string): string {
  const cents = BigInt(value);
  const sign = cents < 0n ? "-" : "";
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${String(absolute / 100n)}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

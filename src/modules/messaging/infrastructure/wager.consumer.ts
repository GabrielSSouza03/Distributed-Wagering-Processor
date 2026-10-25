import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { z } from "zod";
import type { Message } from "@aws-sdk/client-sqs";
import { dlqTotal } from "../../../infrastructure/metrics.js";
import { SqsService } from "../../../infrastructure/sqs/sqs.service.js";
import { canonicalSha256 } from "../../../shared/domain/canonical-hash.js";
import { ProcessWagerTransaction } from "../../wagering/application/process-wager-transaction.js";
import {
  hasPositiveAmountUnlessLoss,
  WagerTransactionKind,
} from "../../wagering/domain/wager-transaction.js";

const envelopeSchema = z.strictObject({
  messageId: z.string().min(1).max(255),
  type: z.literal("WagerTransactionRequested"),
  occurredAt: z.iso.datetime(),
  data: z
    .strictObject({
      providerId: z.string().min(1).max(128),
      externalTransactionId: z.string().min(1).max(128),
      idempotencyKey: z.string().min(1).max(255),
      playerId: z.uuid(),
      walletId: z.uuid(),
      roundId: z.string().min(1).max(128),
      gameId: z.string().min(1).max(128),
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
      referenceExternalTransactionId: z.string().min(1).max(128).optional(),
    })
    .refine(hasPositiveAmountUnlessLoss, {
      path: ["money", "amount"],
      message: "Amount must be greater than zero for balance-affecting operations",
    }),
});

@Injectable()
export class WagerConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WagerConsumer.name);
  private readonly abort = new AbortController();
  private queueUrl?: string;
  private dlqUrl?: string;

  constructor(
    private readonly sqs: SqsService,
    private readonly processWager: ProcessWagerTransaction,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!roles().has("consumer")) return;
    this.queueUrl =
      process.env.WAGER_QUEUE_URL ?? (await this.sqs.ensureQueue("wager-transactions.fifo"));
    this.dlqUrl =
      process.env.WAGER_DLQ_URL ?? (await this.sqs.ensureQueue("wager-transactions-dlq.fifo"));
    void this.poll();
  }

  onApplicationShutdown(): void {
    this.abort.abort();
  }

  private isAborted(): boolean {
    return this.abort.signal.aborted;
  }

  private async poll(): Promise<void> {
    while (!this.isAborted() && this.queueUrl) {
      try {
        const messages = await this.sqs.receive(this.queueUrl, this.abort.signal);
        await Promise.all(messages.map(async (message) => this.handle(message)));
      } catch (error) {
        if (this.isAborted()) continue;
        this.logger.error({ error }, "SQS receive failed");
        await Bun.sleep(1_000);
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    if (!this.queueUrl || !message.ReceiptHandle) return;
    try {
      const raw = JSON.parse(message.Body ?? "") as unknown;
      const envelope = envelopeSchema.parse(raw);
      const data = envelope.data;
      await this.processWager.execute({
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        idempotencyKey: data.idempotencyKey,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind,
        money: data.money,
        ...(data.referenceExternalTransactionId
          ? { referenceExternalTransactionId: data.referenceExternalTransactionId }
          : {}),
        correlationId: envelope.messageId,
        causationId: envelope.messageId,
        ...(message.MessageAttributes?.traceparent?.StringValue
          ? { traceparent: message.MessageAttributes.traceparent.StringValue }
          : {}),
        inbox: {
          messageId: envelope.messageId,
          consumerName: "wager-transactions-v1",
          payloadHash: canonicalSha256(raw),
          receivedAt: new Date(),
        },
      });
      if (process.env.FAIL_AFTER_COMMIT_BEFORE_ACK === "true") {
        throw new Error("Injected crash after commit and before SQS acknowledgement");
      }
      await this.sqs.acknowledge(this.queueUrl, message.ReceiptHandle);
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        await this.deadLetter(message, "INVALID_MESSAGE", error.message);
        return;
      }
      const attempt = Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? "1", 10);
      if (attempt >= maxReceives()) {
        const detail = error instanceof Error ? error.message : String(error);
        await this.deadLetter(message, "RETRIES_EXHAUSTED", detail);
        return;
      }
      const delay = Math.min(300, 2 ** Math.min(attempt, 8));
      this.logger.warn({ error, attempt, delay }, "Transient message processing failure");
      await this.sqs.changeVisibility(this.queueUrl, message.ReceiptHandle, delay);
    }
  }

  private async deadLetter(message: Message, failureCode: string, detail: string): Promise<void> {
    if (!this.queueUrl || !this.dlqUrl || !message.ReceiptHandle) return;
    const id = crypto.randomUUID();
    await this.sqs.send(
      this.dlqUrl,
      JSON.stringify({ originalBody: message.Body, failureCode, detail }),
      "dead-letters",
      id,
    );
    await this.sqs.acknowledge(this.queueUrl, message.ReceiptHandle);
    dlqTotal.add(1, { reason: failureCode });
    this.logger.warn({ dlqMessageId: id, failureCode }, "Message moved to DLQ");
  }
}

function maxReceives(): number {
  return Number.parseInt(process.env.WAGER_MAX_RECEIVES ?? "5", 10);
}

function roles(): Set<string> {
  return new Set((process.env.APP_ROLES ?? "api").split(",").map((role) => role.trim()));
}

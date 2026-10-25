import { describe, expect, test } from "bun:test";
import { AlreadyProcessedError, AlreadyPublishedError } from "../../../shared/domain/errors.js";
import { Money } from "../../../shared/domain/money.js";
import {
  FailureCode,
  WagerTransaction,
  WagerTransactionKind,
} from "../../wagering/domain/wager-transaction.js";
import {
  WalletBalanceChanged,
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from "../../wagering/domain/integration-events.js";
import { Wallet } from "../../wallet/domain/wallet.js";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry.js";
import { InboxMessage } from "./inbox-message.js";
import { OutboxMessage } from "./outbox-message.js";

const at = new Date("2026-01-01T00:00:00.000Z");
const context = {
  eventId: "event-1",
  correlationId: "correlation-1",
  causationId: "request-1",
  occurredAt: at,
};

function wager(kind = WagerTransactionKind.Bet) {
  return WagerTransaction.create({
    id: "transaction-1",
    providerId: "provider-a",
    externalTransactionId: "external-1",
    idempotencyKey: "provider-a:external-1",
    payloadHash: "hash",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: Money.from({ amount: "10.00", currency: "BRL" }),
    ...(kind === WagerTransactionKind.Refund ? { referenceExternalTransactionId: "bet-1" } : {}),
    createdAt: at,
  });
}

describe("InboxMessage", () => {
  test("tracks processing once and protects its date", () => {
    const inbox = InboxMessage.receive({
      messageId: "message-1",
      consumerName: "wager-consumer",
      payloadHash: "hash",
      receivedAt: at,
    });
    const processedAt = new Date("2026-01-01T00:01:00.000Z");
    inbox.markProcessed(processedAt);
    processedAt.setUTCFullYear(2030);

    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt?.toISOString()).toBe("2026-01-01T00:01:00.000Z");
    expect(() => {
      inbox.markProcessed(new Date());
    }).toThrow(AlreadyProcessedError);
  });

  test("rehydrates persisted processing state", () => {
    const inbox = InboxMessage.rehydrate({
      messageId: "message-1",
      consumerName: "consumer",
      payloadHash: "hash",
      receivedAt: at,
      processedAt: new Date("2026-01-02T00:00:00.000Z"),
    });
    expect(inbox.isProcessed()).toBe(true);
  });
});

describe("integration events and OutboxMessage", () => {
  test("serializes a typed event envelope and enqueues it", () => {
    const transaction = wager();
    transaction.markProcessed(undefined, at);
    const event = WagerTransactionProcessed.from(transaction, context);
    const envelope = event.toJSON();
    const outbox = OutboxMessage.enqueue(event);

    expect(envelope).toEqual({
      eventId: "event-1",
      eventType: "WagerTransactionProcessed",
      aggregateId: "transaction-1",
      correlationId: "correlation-1",
      causationId: "request-1",
      occurredAt: "2026-01-01T00:00:00.000Z",
      version: 1,
      data: {
        transactionId: "transaction-1",
        providerId: "provider-a",
        externalTransactionId: "external-1",
        walletId: "wallet-1",
        status: "PROCESSED",
      },
    });
    expect(outbox.id).toBe("event-1");
    expect(outbox.eventType).toBe("WagerTransactionProcessed");
    expect(outbox.isDue(at)).toBe(true);
  });

  test("creates rejected and pending-reference event types", () => {
    const rejected = wager();
    rejected.reject(FailureCode.InsufficientFunds);
    expect(WagerTransactionRejected.from(rejected, context).toJSON().data.failureCode).toBe(
      FailureCode.InsufficientFunds,
    );

    const pending = wager(WagerTransactionKind.Refund);
    pending.markPendingReference();
    expect(
      WagerTransactionPendingReference.from(pending, context).toJSON().data
        .referenceExternalTransactionId,
    ).toBe("bet-1");
  });

  test("serializes balance changes with decimal strings", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: Money.from({ amount: "20.00", currency: "BRL" }),
      createdAt: at,
    });
    const entry = wallet.debit({
      entryId: "entry-1",
      transactionId: "transaction-1",
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      at,
    });

    expect(WalletBalanceChanged.from(wallet, entry, context).toJSON().data).toEqual({
      walletId: "wallet-1",
      transactionId: "transaction-1",
      direction: LedgerDirection.Debit,
      money: { amount: "10.00", currency: "BRL" },
      balanceBefore: { amount: "20.00", currency: "BRL" },
      balanceAfter: { amount: "10.00", currency: "BRL" },
      walletVersion: 2,
    });
  });

  test("uses capped exponential retry and stops when published", () => {
    const transaction = wager();
    transaction.markProcessed(undefined, at);
    const outbox = OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, context));

    outbox.scheduleRetry(at);
    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt?.toISOString()).toBe("2026-01-01T00:00:01.000Z");
    expect(outbox.isDue(new Date("2026-01-01T00:00:00.999Z"))).toBe(false);
    expect(outbox.isDue(new Date("2026-01-01T00:00:01.000Z"))).toBe(true);

    for (let index = 0; index < 20; index += 1) outbox.scheduleRetry(at);
    expect(outbox.nextAttemptAt?.getTime()).toBe(at.getTime() + 3_600_000);

    outbox.markPublished(new Date("2026-01-01T01:00:00.000Z"));
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date("2030-01-01T00:00:00.000Z"))).toBe(false);
    expect(() => {
      outbox.scheduleRetry(at);
    }).toThrow(AlreadyPublishedError);
    expect(() => {
      outbox.markPublished(at);
    }).toThrow(AlreadyPublishedError);
  });
});

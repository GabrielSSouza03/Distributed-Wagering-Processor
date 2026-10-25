import { LockMode, type EntityManager } from "@mikro-orm/core";
import { Injectable } from "@nestjs/common";
import type { IntegrationEvent } from "../../../shared/domain/integration-event.js";
import { Money } from "../../../shared/domain/money.js";
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from "../../../infrastructure/database/records.js";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry.js";
import { Wallet } from "../../wallet/domain/wallet.js";
import type {
  FinancialStore,
  FinancialTransaction,
  InboxInput,
  StoredTransaction,
} from "../application/financial-store.port.js";
import {
  type FailureCode,
  WagerTransaction,
  type WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction.js";
import { MikroORM } from "@mikro-orm/postgresql";

@Injectable()
export class MikroFinancialStore implements FinancialStore {
  constructor(private readonly orm: MikroORM) {}

  async transaction<T>(work: (transaction: FinancialTransaction) => Promise<T>): Promise<T> {
    return this.orm.em
      .fork()
      .transactional(async (inner) => work(new MikroFinancialTransaction(inner)));
  }

  async listDuePendingReferences(limit: number): Promise<string[]> {
    const rows = await this.orm.em.fork().find(
      WagerTransactionRecord,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: new Date() } }],
      },
      { fields: ["id"], limit, orderBy: { createdAt: "asc" } },
    );
    return rows.map((row) => row.id);
  }
}

class MikroFinancialTransaction implements FinancialTransaction {
  constructor(private readonly em: EntityManager) {}

  async flush(): Promise<void> {
    await this.em.flush();
  }

  async findWalletForUpdate(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record ? mapWallet(record) : undefined;
  }

  async findByIdempotency(
    providerId: string,
    idempotencyKey: string,
  ): Promise<StoredTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, {
      providerId,
      idempotencyKey,
    });
    return record
      ? {
          transaction: mapTransaction(record),
          ...(record.resultingBalance ? { resultingBalance: record.resultingBalance } : {}),
        }
      : undefined;
  }

  async findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, {
      providerId,
      externalTransactionId,
    });
    return record ? mapTransaction(record) : undefined;
  }

  async findProcessedReversal(
    referenceTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: ["REFUND", "ROLLBACK"] },
    });
    return record ? mapTransaction(record) : undefined;
  }

  async findTransactionByIdForUpdate(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(
      WagerTransactionRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return record ? mapTransaction(record) : undefined;
  }

  async deferPendingReference(
    id: string,
    now: Date,
    maxAttempts: number,
  ): Promise<"deferred" | "expired"> {
    const record = await this.em.findOneOrFail(WagerTransactionRecord, { id });
    record.attempts += 1;
    if (record.attempts >= maxAttempts) return "expired";
    const delaySeconds = Math.min(300, 2 ** Math.min(record.attempts, 8));
    record.nextAttemptAt = new Date(now.getTime() + delaySeconds * 1_000);
    return "deferred";
  }

  insertWallet(wallet: Wallet): Promise<void> {
    this.em.persist(
      this.em.create(WalletRecord, {
        id: wallet.id,
        playerId: wallet.playerId,
        currency: wallet.currency,
        balance: wallet.balance.toJSON().amount,
        version: wallet.version,
        createdAt: wallet.createdAt,
        updatedAt: wallet.updatedAt,
      }),
    );
    return Promise.resolve();
  }

  async saveWallet(wallet: Wallet): Promise<void> {
    const record = await this.em.findOneOrFail(WalletRecord, { id: wallet.id });
    record.balance = wallet.balance.toJSON().amount;
    record.version = wallet.version;
    record.updatedAt = wallet.updatedAt;
  }

  insertTransaction(transaction: WagerTransaction, resultingBalance?: string): Promise<void> {
    const record = new WagerTransactionRecord();
    Object.assign(record, transactionData(transaction, resultingBalance));
    this.em.persist(record);
    return Promise.resolve();
  }

  async updateTransaction(transaction: WagerTransaction, resultingBalance?: string): Promise<void> {
    const record = await this.em.findOneOrFail(WagerTransactionRecord, { id: transaction.id });
    record.status = transaction.status;
    if (transaction.referenceTransactionId) {
      record.referenceTransactionId = transaction.referenceTransactionId;
    }
    if (transaction.failureCode) record.failureCode = transaction.failureCode;
    if (transaction.processedAt) record.processedAt = transaction.processedAt;
    if (resultingBalance) record.resultingBalance = resultingBalance;
  }

  insertLedger(entry: WalletLedgerEntry): Promise<void> {
    const record = new WalletLedgerEntryRecord();
    record.id = entry.id;
    record.walletId = entry.walletId;
    record.transactionId = entry.transactionId;
    record.direction = entry.direction;
    record.amount = entry.money.toJSON().amount;
    record.currency = entry.money.currency;
    record.balanceBefore = entry.balanceBefore.toJSON().amount;
    record.balanceAfter = entry.balanceAfter.toJSON().amount;
    record.createdAt = entry.createdAt;
    this.em.persist(record);
    return Promise.resolve();
  }

  enqueue(events: readonly IntegrationEvent<unknown>[], traceparent?: string): Promise<void> {
    for (const event of events) {
      const payload = JSON.parse(JSON.stringify(event.toJSON())) as Record<string, unknown>;
      const record = new OutboxMessageRecord();
      record.id = event.eventId;
      record.aggregateId = event.aggregateId;
      record.eventType = event.eventType;
      record.payload = payload;
      record.occurredAt = event.occurredAt;
      if (traceparent) record.traceparent = traceparent;
      this.em.persist(record);
    }
    return Promise.resolve();
  }

  async recordInbox(message: InboxInput): Promise<"inserted" | "duplicate"> {
    const existing = await this.em.findOne(InboxMessageRecord, {
      consumerName: message.consumerName,
      messageId: message.messageId,
    });
    if (existing) return "duplicate";
    this.em.persist(
      this.em.create(InboxMessageRecord, {
        id: crypto.randomUUID(),
        ...message,
      }),
    );
    await this.em.flush();
    return "inserted";
  }

  async markInboxProcessed(consumerName: string, messageId: string, at: Date): Promise<void> {
    const record = await this.em.findOneOrFail(InboxMessageRecord, { consumerName, messageId });
    record.processedAt = at;
  }
}

function mapWallet(record: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: record.id,
    playerId: record.playerId,
    currency: record.currency,
    balance: Money.from({ amount: record.balance, currency: record.currency }),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function mapTransaction(record: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: record.id,
    providerId: record.providerId,
    externalTransactionId: record.externalTransactionId,
    idempotencyKey: record.idempotencyKey,
    payloadHash: record.payloadHash,
    walletId: record.walletId,
    playerId: record.playerId,
    roundId: record.roundId,
    gameId: record.gameId,
    kind: record.kind as WagerTransactionKind,
    money: Money.from({ amount: record.amount, currency: record.currency }),
    ...(record.referenceExternalTransactionId
      ? { referenceExternalTransactionId: record.referenceExternalTransactionId }
      : {}),
    createdAt: record.createdAt,
    status: record.status as WagerTransactionStatus,
    ...(record.referenceTransactionId
      ? { referenceTransactionId: record.referenceTransactionId }
      : {}),
    ...(record.failureCode ? { failureCode: record.failureCode as FailureCode } : {}),
    ...(record.processedAt ? { processedAt: record.processedAt } : {}),
  });
}

function transactionData(
  transaction: WagerTransaction,
  resultingBalance?: string,
): Omit<WagerTransactionRecord, "attempts"> & { attempts?: number } {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.toJSON().amount,
    currency: transaction.money.currency,
    ...(transaction.referenceExternalTransactionId
      ? { referenceExternalTransactionId: transaction.referenceExternalTransactionId }
      : {}),
    ...(transaction.referenceTransactionId
      ? { referenceTransactionId: transaction.referenceTransactionId }
      : {}),
    status: transaction.status,
    ...(transaction.failureCode ? { failureCode: transaction.failureCode } : {}),
    ...(resultingBalance ? { resultingBalance } : {}),
    createdAt: transaction.createdAt,
    ...(transaction.processedAt ? { processedAt: transaction.processedAt } : {}),
  };
}

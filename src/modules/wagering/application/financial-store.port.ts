import type { IntegrationEvent } from "../../../shared/domain/integration-event.js";
import type { WalletLedgerEntry } from "../../wallet/domain/wallet-ledger-entry.js";
import type { Wallet } from "../../wallet/domain/wallet.js";
import type { WagerTransaction } from "../domain/wager-transaction.js";

export const FINANCIAL_STORE = Symbol("FINANCIAL_STORE");

export interface FinancialTransaction {
  flush(): Promise<void>;
  findWalletForUpdate(walletId: string): Promise<Wallet | undefined>;
  findByIdempotency(
    providerId: string,
    idempotencyKey: string,
  ): Promise<StoredTransaction | undefined>;
  findByExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;
  findProcessedReversal(referenceTransactionId: string): Promise<WagerTransaction | undefined>;
  findTransactionByIdForUpdate(id: string): Promise<WagerTransaction | undefined>;
  deferPendingReference(
    id: string,
    now: Date,
    maxAttempts: number,
  ): Promise<"deferred" | "expired">;
  insertWallet(wallet: Wallet): Promise<void>;
  saveWallet(wallet: Wallet): Promise<void>;
  insertTransaction(transaction: WagerTransaction, resultingBalance?: string): Promise<void>;
  updateTransaction(transaction: WagerTransaction, resultingBalance?: string): Promise<void>;
  insertLedger(entry: WalletLedgerEntry): Promise<void>;
  enqueue(events: readonly IntegrationEvent<unknown>[], traceparent?: string): Promise<void>;
  recordInbox(message: InboxInput): Promise<"inserted" | "duplicate">;
  markInboxProcessed(consumerName: string, messageId: string, at: Date): Promise<void>;
}

export interface FinancialStore {
  transaction<T>(work: (transaction: FinancialTransaction) => Promise<T>): Promise<T>;
  listDuePendingReferences(limit: number): Promise<string[]>;
}

export interface StoredTransaction {
  transaction: WagerTransaction;
  resultingBalance?: string;
}

export interface InboxInput {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

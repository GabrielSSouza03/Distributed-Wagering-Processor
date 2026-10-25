import type { Clock, IdGenerator } from "../../../shared/application/system.port.js";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry.js";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/integration-events.js";
import { FailureCode, WagerTransactionStatus } from "../domain/wager-transaction.js";
import type { FinancialStore } from "./financial-store.port.js";
import { failureCodeFor } from "./process-wager-transaction.js";

export class ReprocessPendingReference {
  constructor(
    private readonly store: FinancialStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async runBatch(limit = 25): Promise<number> {
    const ids = await this.store.listDuePendingReferences(limit);
    await Promise.all(ids.map(async (id) => this.execute(id)));
    return ids.length;
  }

  async execute(transactionId: string): Promise<void> {
    await this.store.transaction(async (tx) => {
      const transaction = await tx.findTransactionByIdForUpdate(transactionId);
      if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference) return;
      const wallet = await tx.findWalletForUpdate(transaction.walletId);
      if (!wallet) throw new Error("Pending transaction refers to a missing wallet");
      const now = this.clock.now();
      const context = {
        eventId: this.ids.next(),
        correlationId: transaction.id,
        causationId: transaction.id,
        occurredAt: now,
      };
      const reference = await tx.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId ?? "",
      );
      if (!reference) {
        const outcome = await tx.deferPendingReference(transaction.id, now, 8);
        if (outcome === "expired") {
          transaction.reject(FailureCode.ReferenceNotFound);
          await tx.updateTransaction(transaction, wallet.balance.toJSON().amount);
          await tx.enqueue([WagerTransactionRejected.from(transaction, context)]);
        }
        return;
      }

      if (transaction.requiresReference() && (await tx.findProcessedReversal(reference.id))) {
        transaction.reject(FailureCode.ReferenceAlreadyReversed);
        await tx.updateTransaction(transaction, wallet.balance.toJSON().amount);
        await tx.enqueue([WagerTransactionRejected.from(transaction, context)]);
        return;
      }

      try {
        transaction.validateReference(reference);
        const direction = transaction.ledgerDirectionFor(reference);
        const movement = {
          entryId: this.ids.next(),
          transactionId: transaction.id,
          money: transaction.money,
          at: now,
        };
        const entry =
          direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
        transaction.markProcessed(reference.id, now);
        await tx.saveWallet(wallet);
        await tx.insertLedger(entry);
        await tx.updateTransaction(transaction, wallet.balance.toJSON().amount);
        await tx.enqueue([
          WagerTransactionProcessed.from(transaction, context),
          WalletBalanceChanged.from(wallet, entry, { ...context, eventId: this.ids.next() }),
        ]);
      } catch (error) {
        transaction.reject(failureCodeFor(error, transaction));
        await tx.updateTransaction(transaction, wallet.balance.toJSON().amount);
        await tx.enqueue([WagerTransactionRejected.from(transaction, context)]);
      }
    });
  }
}

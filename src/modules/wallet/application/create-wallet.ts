import type { Clock, IdGenerator } from "../../../shared/application/system.port.js";
import { Money, type MoneyProps } from "../../../shared/domain/money.js";
import type { FinancialStore } from "../../wagering/application/financial-store.port.js";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "../../wagering/domain/integration-events.js";
import { WagerTransaction, WagerTransactionKind } from "../../wagering/domain/wager-transaction.js";
import { LedgerDirection, WalletLedgerEntry } from "../domain/wallet-ledger-entry.js";
import { Wallet } from "../domain/wallet.js";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
  traceparent?: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

export class CreateWallet {
  constructor(
    private readonly store: FinancialStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    const now = this.clock.now();
    const initialBalance = Money.from(command.initialBalance);
    const wallet = Wallet.open({
      id: this.ids.next(),
      playerId: command.playerId,
      initialBalance,
      createdAt: now,
    });

    await this.store.transaction(async (tx) => {
      await tx.insertWallet(wallet);
      await tx.flush();
      if (initialBalance.isZero()) return;

      const opening = WagerTransaction.create({
        id: this.ids.next(),
        providerId: "internal",
        externalTransactionId: `opening:${wallet.id}`,
        idempotencyKey: `opening:${wallet.id}`,
        payloadHash: `internal-opening-${wallet.id}`.padEnd(64, "0").slice(0, 64),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: "opening",
        gameId: "internal",
        kind: WagerTransactionKind.Opening,
        money: initialBalance,
        createdAt: now,
      });
      opening.markProcessed(undefined, now);
      const entry = WalletLedgerEntry.create({
        id: this.ids.next(),
        walletId: wallet.id,
        transactionId: opening.id,
        direction: LedgerDirection.Credit,
        money: initialBalance,
        balanceBefore: Money.zero(wallet.currency),
        balanceAfter: initialBalance,
        createdAt: now,
      });
      await tx.insertTransaction(opening, wallet.balance.toJSON().amount);
      await tx.flush();
      await tx.insertLedger(entry);
      const context = {
        eventId: this.ids.next(),
        correlationId: command.correlationId,
        occurredAt: now,
      };
      await tx.enqueue(
        [
          WagerTransactionProcessed.from(opening, context),
          WalletBalanceChanged.from(wallet, entry, {
            ...context,
            eventId: this.ids.next(),
          }),
        ],
        command.traceparent,
      );
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}

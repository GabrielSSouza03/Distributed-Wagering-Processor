import { InvalidLedgerEntryError } from "../../../shared/domain/errors.js";
import type { Money } from "../../../shared/domain/money.js";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export type CreateLedgerEntryProps = LedgerEntryState;

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    private readonly _createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError("Ledger money must be positive");
    }
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError("Ledger balances do not match its direction and money");
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      new Date(state.createdAt),
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  isBalanced(): boolean {
    try {
      const expected =
        this.direction === LedgerDirection.Credit
          ? this.balanceBefore.add(this.money)
          : this.balanceBefore.subtract(this.money);
      return expected.equals(this.balanceAfter);
    } catch {
      return false;
    }
  }
}

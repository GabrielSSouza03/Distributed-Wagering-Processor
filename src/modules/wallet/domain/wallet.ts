import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidMoneyError,
} from "../../../shared/domain/errors.js";
import type { Money } from "../../../shared/domain/money.js";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry.js";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementProps {
  entryId: string;
  transactionId: string;
  money: Money;
  at?: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    createdAt?: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidMoneyError("Initial balance cannot be negative");
    }
    const at = props.createdAt ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(at),
      new Date(at),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertMovement(props.money);
    if (this._balance.isLessThan(props.money)) {
      throw new InsufficientFundsError("Wallet has insufficient funds");
    }
    return this.apply(props, LedgerDirection.Debit);
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    this.assertMovement(props.money);
    return this.apply(props, LedgerDirection.Credit);
  }

  private apply(props: WalletMovementProps, direction: LedgerDirection): WalletLedgerEntry {
    const before = this._balance;
    const after =
      direction === LedgerDirection.Credit ? before.add(props.money) : before.subtract(props.money);
    const at = props.at ?? new Date();
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: before,
      balanceAfter: after,
      createdAt: at,
    });
    this._balance = after;
    this._version += 1;
    this._updatedAt = new Date(at);
    return entry;
  }

  private assertMovement(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
    if (!money.isPositive()) {
      throw new InvalidMoneyError("Wallet movements must be positive");
    }
  }
}

import { describe, expect, test } from "bun:test";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidMoneyError,
} from "../../../shared/domain/errors.js";
import { Money } from "../../../shared/domain/money.js";
import { Wallet } from "./wallet.js";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry.js";

const money = (amount: string, currency = "BRL") => Money.from({ amount, currency });

describe("Wallet", () => {
  test("opens at version one and keeps dates insulated from mutation", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("100.00"),
      createdAt: at,
    });
    at.setUTCFullYear(2030);

    expect(wallet.balance.toJSON().amount).toBe("100.00");
    expect(wallet.version).toBe(1);
    expect(wallet.createdAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  test("debits atomically with a balanced ledger entry", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("100.00"),
    });
    const entry = wallet.debit({
      entryId: "entry-1",
      transactionId: "bet-1",
      money: money("80.00"),
      at: new Date("2026-01-02T00:00:00.000Z"),
    });

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(entry.balanceAfter.toJSON().amount).toBe("20.00");
    expect(entry.isBalanced()).toBe(true);
    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });

  test("credits and increments version only for successful movements", () => {
    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("0.00"),
    });
    const entry = wallet.credit({
      entryId: "entry-1",
      transactionId: "win-1",
      money: money("25.00"),
    });

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toJSON().amount).toBe("25.00");
    expect(wallet.version).toBe(2);
    expect(() =>
      wallet.debit({
        entryId: "entry-2",
        transactionId: "bet-2",
        money: money("30.00"),
      }),
    ).toThrow(InsufficientFundsError);
    expect(wallet.version).toBe(2);
    expect(wallet.balance.toJSON().amount).toBe("25.00");
  });

  test("rejects negative opening, zero movements and currency conflicts", () => {
    expect(() =>
      Wallet.open({
        id: "wallet-1",
        playerId: "player-1",
        initialBalance: money("1.00").negate(),
      }),
    ).toThrow(InvalidMoneyError);

    const wallet = Wallet.open({
      id: "wallet-1",
      playerId: "player-1",
      initialBalance: money("1.00"),
    });
    expect(() => wallet.credit({ entryId: "e", transactionId: "t", money: money("0.00") })).toThrow(
      InvalidMoneyError,
    );
    expect(() =>
      wallet.credit({ entryId: "e", transactionId: "t", money: money("1.00", "USD") }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe("WalletLedgerEntry", () => {
  test("rejects arithmetic mismatch, zero amount and mixed currencies", () => {
    const base = {
      id: "entry-1",
      walletId: "wallet-1",
      transactionId: "transaction-1",
      direction: LedgerDirection.Credit,
      money: money("10.00"),
      balanceBefore: money("20.00"),
      createdAt: new Date(),
    };
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: money("29.99") })).toThrow(
      InvalidLedgerEntryError,
    );
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        money: money("0.00"),
        balanceAfter: money("20.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
    expect(() =>
      WalletLedgerEntry.create({ ...base, balanceAfter: money("30.00", "USD") }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rehydration reconstructs persisted state without transition validation", () => {
    const entry = WalletLedgerEntry.rehydrate({
      id: "legacy",
      walletId: "wallet",
      transactionId: "transaction",
      direction: LedgerDirection.Debit,
      money: money("10.00"),
      balanceBefore: money("5.00"),
      balanceAfter: money("5.00"),
      createdAt: new Date(),
    });
    expect(entry.isBalanced()).toBe(false);
  });
});

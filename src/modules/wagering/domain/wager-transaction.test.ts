import { describe, expect, test } from "bun:test";
import {
  AmountMismatchError,
  CurrencyMismatchError,
  InvalidTransactionReferenceError,
  InvalidTransactionStateError,
} from "../../../shared/domain/errors.js";
import { Money } from "../../../shared/domain/money.js";
import { LedgerDirection } from "../../wallet/domain/wallet-ledger-entry.js";
import {
  FailureCode,
  hasPositiveAmountUnlessLoss,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  type CreateWagerTransactionProps,
} from "./wager-transaction.js";

const base: CreateWagerTransactionProps = {
  id: "transaction-1",
  providerId: "provider-a",
  externalTransactionId: "external-1",
  idempotencyKey: "provider-a:external-1",
  payloadHash: "abc123",
  walletId: "wallet-1",
  playerId: "player-1",
  roundId: "round-1",
  gameId: "game-1",
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: "25.00", currency: "BRL" }),
};

const transaction = (overrides: Partial<CreateWagerTransactionProps> = {}) =>
  WagerTransaction.create({ ...base, ...overrides });

const processed = (overrides: Partial<CreateWagerTransactionProps> = {}) => {
  const value = transaction(overrides);
  value.markProcessed(
    value.requiresReference() ? "resolved-reference" : undefined,
    new Date("2026-01-01T00:00:00.000Z"),
  );
  return value;
};

describe("WagerTransaction creation and queries", () => {
  test.each([WagerTransactionKind.Refund, WagerTransactionKind.Rollback])(
    "%s requires an external reference",
    (kind) => {
      expect(() => transaction({ kind })).toThrow(InvalidTransactionReferenceError);
    },
  );

  test.each([WagerTransactionKind.Opening, WagerTransactionKind.Bet, WagerTransactionKind.Loss])(
    "%s rejects a reversal reference",
    (kind) => {
      expect(() => transaction({ kind, referenceExternalTransactionId: "ref-1" })).toThrow(
        InvalidTransactionReferenceError,
      );
    },
  );

  test("starts pending and detects idempotent payloads", () => {
    const wager = transaction();
    expect(wager.status).toBe(WagerTransactionStatus.Pending);
    expect(wager.matchesPayload("abc123")).toBe(true);
    expect(wager.matchesPayload("different")).toBe(false);
    expect(wager.affectsBalance()).toBe(true);
    expect(transaction({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(false);
  });

  test("WIN may optionally reference a BET", () => {
    expect(
      transaction({
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: "bet-1",
      }).referenceExternalTransactionId,
    ).toBe("bet-1");
  });

  test.each([
    [WagerTransactionKind.Opening, LedgerDirection.Credit],
    [WagerTransactionKind.Bet, LedgerDirection.Debit],
    [WagerTransactionKind.Win, LedgerDirection.Credit],
    [WagerTransactionKind.Refund, LedgerDirection.Credit],
  ])("%s has %s direction", (kind, expected) => {
    const wager = transaction({
      kind,
      ...(kind === WagerTransactionKind.Refund ? { referenceExternalTransactionId: "bet-1" } : {}),
    });
    expect(wager.ledgerDirectionFor()).toBe(expected);
  });

  test("only LOSS may carry a zero amount in the contract", () => {
    const zero = { amount: "0.00" };
    expect(hasPositiveAmountUnlessLoss({ kind: WagerTransactionKind.Loss, money: zero })).toBe(
      true,
    );
    for (const kind of [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
      WagerTransactionKind.Rollback,
    ]) {
      expect(hasPositiveAmountUnlessLoss({ kind, money: zero })).toBe(false);
      expect(hasPositiveAmountUnlessLoss({ kind, money: { amount: "0.01" } })).toBe(true);
    }
  });

  test("LOSS has no ledger direction", () => {
    expect(() => transaction({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toThrow(
      InvalidTransactionReferenceError,
    );
  });
});

describe("WagerTransaction state machine", () => {
  test("moves a reversal through pending-reference to processed", () => {
    const wager = transaction({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "bet-1",
    });
    wager.markPendingReference();
    expect(wager.status).toBe(WagerTransactionStatus.PendingReference);
    wager.markProcessed("internal-bet-1", new Date("2026-01-02T00:00:00.000Z"));

    expect(wager.status).toBe(WagerTransactionStatus.Processed);
    expect(wager.referenceTransactionId).toBe("internal-bet-1");
    expect(wager.processedAt?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(wager.isTerminal()).toBe(true);
  });

  test.each(["processed", "rejected", "failed"] as const)(
    "%s is terminal and cannot transition",
    (terminal) => {
      const wager = transaction();
      if (terminal === "processed") wager.markProcessed(undefined, new Date());
      if (terminal === "rejected") wager.reject(FailureCode.InsufficientFunds);
      if (terminal === "failed") wager.fail(FailureCode.PermanentInfrastructureFailure);

      expect(() => {
        wager.reject(FailureCode.InvalidReference);
      }).toThrow(InvalidTransactionStateError);
      expect(() => {
        wager.markProcessed(undefined, new Date());
      }).toThrow(InvalidTransactionStateError);
    },
  );

  test("records stable failure codes", () => {
    const wager = transaction();
    wager.reject(FailureCode.InsufficientFunds);
    expect(wager.status).toBe(WagerTransactionStatus.Rejected);
    expect(wager.failureCode).toBe(FailureCode.InsufficientFunds);
  });
});

describe("reversal reference rules", () => {
  const reversal = (
    kind: WagerTransactionKind.Refund | WagerTransactionKind.Rollback,
    overrides: Partial<CreateWagerTransactionProps> = {},
  ) =>
    transaction({
      id: "reversal",
      externalTransactionId: "reversal-external",
      idempotencyKey: "reversal-key",
      kind,
      referenceExternalTransactionId: "external-1",
      ...overrides,
    });

  test("REFUND accepts only a matching processed BET", () => {
    const refund = reversal(WagerTransactionKind.Refund);
    expect(() => {
      refund.validateReference(processed());
    }).not.toThrow();
    expect(() => {
      refund.validateReference(processed({ kind: WagerTransactionKind.Win }));
    }).toThrow(InvalidTransactionReferenceError);
  });

  test("rejects mismatched provider, wallet, player and round", () => {
    const refund = reversal(WagerTransactionKind.Refund);
    const mismatches: Partial<CreateWagerTransactionProps>[] = [
      { providerId: "provider-b" },
      { walletId: "wallet-2" },
      { playerId: "player-2" },
      { roundId: "round-2" },
    ];
    for (const mismatch of mismatches) {
      expect(() => {
        refund.validateReference(processed(mismatch));
      }).toThrow(InvalidTransactionReferenceError);
    }
  });

  test("distinguishes amount and currency mismatches", () => {
    const refund = reversal(WagerTransactionKind.Refund);
    expect(() => {
      refund.validateReference(
        processed({ money: Money.from({ amount: "24.99", currency: "BRL" }) }),
      );
    }).toThrow(AmountMismatchError);
    expect(() => {
      refund.validateReference(
        processed({ money: Money.from({ amount: "25.00", currency: "USD" }) }),
      );
    }).toThrow(CurrencyMismatchError);
  });

  test("WIN may reference a processed BET of its round with any payout", () => {
    const win = transaction({
      id: "win",
      externalTransactionId: "win-external",
      idempotencyKey: "win-key",
      kind: WagerTransactionKind.Win,
      money: Money.from({ amount: "80.00", currency: "BRL" }),
      referenceExternalTransactionId: "external-1",
    });
    expect(() => {
      win.validateReference(processed());
    }).not.toThrow();
    expect(win.ledgerDirectionFor(processed())).toBe(LedgerDirection.Credit);
    expect(() => {
      win.validateReference(processed({ kind: WagerTransactionKind.Win }));
    }).toThrow(InvalidTransactionReferenceError);
    expect(() => {
      win.validateReference(processed({ roundId: "round-2" }));
    }).toThrow(InvalidTransactionReferenceError);
    expect(() => {
      win.validateReference(transaction());
    }).toThrow(InvalidTransactionReferenceError);
  });

  test("ROLLBACK reverses BET creditward and WIN/REFUND debitward", () => {
    const rollback = reversal(WagerTransactionKind.Rollback);
    expect(rollback.ledgerDirectionFor(processed())).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(processed({ kind: WagerTransactionKind.Win }))).toBe(
      LedgerDirection.Debit,
    );
    expect(
      rollback.ledgerDirectionFor(
        processed({
          kind: WagerTransactionKind.Refund,
          referenceExternalTransactionId: "earlier-bet",
        }),
      ),
    ).toBe(LedgerDirection.Debit);
  });

  test("requires a processed reference", () => {
    expect(() => {
      reversal(WagerTransactionKind.Rollback).validateReference(transaction());
    }).toThrow(InvalidTransactionReferenceError);
  });
});

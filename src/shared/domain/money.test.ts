import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors.js";
import { canonicalJson, canonicalSha256 } from "./canonical-hash.js";
import { Money } from "./money.js";

describe("Money", () => {
  test.each(["", "1", "1.0", "1.000", "-1.00", "+1.00", "01.00", ".50", "1e2", "NaN", "Infinity"])(
    "rejects invalid amount %p",
    (amount) => {
      expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
    },
  );

  test.each(["brl", "BR", "REAL", "12A"])("rejects invalid currency %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });

  test("uses exact bigint-cent arithmetic and fixed serialization", () => {
    const result = Money.from({ amount: "9007199254740993.01", currency: "BRL" })
      .add(Money.from({ amount: "0.09", currency: "BRL" }))
      .subtract(Money.from({ amount: "0.01", currency: "BRL" }));

    expect(result.toJSON()).toEqual({
      amount: "9007199254740993.09",
      currency: "BRL",
    });
    expect(result.toString()).toBe("9007199254740993.09 BRL");
  });

  test("is immutable and supports internal negative arithmetic", () => {
    const original = Money.from({ amount: "1.00", currency: "BRL" });
    const result = original.subtract(Money.from({ amount: "2.25", currency: "BRL" }));

    expect(original.toJSON().amount).toBe("1.00");
    expect(result.toJSON().amount).toBe("-1.25");
    expect(result.isNegative()).toBe(true);
    expect(result.negate().toJSON().amount).toBe("1.25");
  });

  test("compares values and rejects cross-currency operations", () => {
    const brl = Money.from({ amount: "1.00", currency: "BRL" });
    const usd = Money.from({ amount: "1.00", currency: "USD" });

    expect(brl.equals(usd)).toBe(false);
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl.isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
});

describe("canonical SHA-256", () => {
  test("sorts object keys recursively and preserves array order", () => {
    const left = { z: [{ b: 2, a: 1 }], a: "value" };
    const right = { a: "value", z: [{ a: 1, b: 2 }] };

    expect(canonicalJson(left)).toBe('{"a":"value","z":[{"a":1,"b":2}]}');
    expect(canonicalSha256(left)).toBe(canonicalSha256(right));
    expect(canonicalSha256(left)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("omits undefined object properties and rejects unsupported values", () => {
    expect(canonicalJson({ a: 1, transportMetadata: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson({ amount: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ amount: 1n })).toThrow(TypeError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(TypeError);
  });
});

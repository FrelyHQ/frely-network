import { expect, test } from "bun:test";
import { parseAtomicAmount, parsePositiveAtomicAmount, selectQuote } from "./policy.ts";
import { examplePolicy, paymentRequiredHeader } from "./test-support.ts";

test("rejects missing, zero, padded, decimal, scientific, and overflowing amounts", () => {
  for (const value of ["", "01", "1.0", "1e2", "9223372036854775808", "-1"]) {
    expect(() => parseAtomicAmount(value)).toThrow();
  }
  expect(() => parsePositiveAtomicAmount("0")).toThrow("PAYMENT_REJECTED");
  expect(parseAtomicAmount("0")).toBe(0n);
  expect(parseAtomicAmount("1")).toBe(1n);
  expect(parseAtomicAmount("9223372036854775807")).toBe(9223372036854775807n);
});

test("selects exactly one fully matching v2 exact quote", () => {
  const policy = examplePolicy();
  const quote = selectQuote(
    paymentRequiredHeader({ amount: "1" }),
    policy,
    "1",
  );
  expect(quote.amount).toBe("1");
  expect(quote.payTo).toBe(policy.payTo);
});

test("rejects zero, two, or mismatched quotes before any signing", () => {
  const policy = examplePolicy();
  expect(() => selectQuote(paymentRequiredHeader({ accepts: [] }), policy, "1")).toThrow(
    "PAYMENT_REJECTED",
  );
  expect(() =>
    selectQuote(
      paymentRequiredHeader({
        accepts: [
          { amount: "1" },
          { amount: "1", payTo: policy.payTo },
        ],
      }),
      policy,
      "1",
    ),
  ).toThrow("PAYMENT_REJECTED");
  expect(() =>
    selectQuote(paymentRequiredHeader({ payTo: "0.0.9" }), policy, "1"),
  ).toThrow("PAYMENT_REJECTED");
  expect(() =>
    selectQuote(paymentRequiredHeader({ network: "hedera:mainnet" }), policy, "1"),
  ).toThrow("PAYMENT_REJECTED");
  expect(() =>
    selectQuote(paymentRequiredHeader({ asset: "0.0.9" }), policy, "1"),
  ).toThrow("PAYMENT_REJECTED");
  expect(() =>
    selectQuote(paymentRequiredHeader({ feePayer: "0.0.9" }), policy, "1"),
  ).toThrow("PAYMENT_REJECTED");
  expect(() =>
    selectQuote(paymentRequiredHeader({ resource: "http://127.0.0.1:9/v1/responses" }), policy, "1"),
  ).toThrow("PAYMENT_REJECTED");
  expect(() =>
    selectQuote(paymentRequiredHeader({ maxTimeoutSeconds: 5 }), policy, "1"),
  ).toThrow("PAYMENT_REJECTED");
});

test("never accepts a quote above the request budget", () => {
  const policy = examplePolicy({ amountAtomic: "2", maxAmountAtomic: "2" });
  expect(() =>
    selectQuote(paymentRequiredHeader({ amount: "2" }), policy, "1"),
  ).toThrow("PAYMENT_LIMIT_EXCEEDED");
});

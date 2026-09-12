import { decodePaymentHeader, type PaymentRequirement } from "@frely-network/hedera-x402";
import type { PayerPolicy } from "./types.ts";

const MAX_ATOMIC = 9223372036854775807n;

export function parseAtomicAmount(
  value: string,
  code = "INVALID_REQUEST",
): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(code);
  }
  const amount = BigInt(value);
  if (amount > MAX_ATOMIC) throw new Error(code);
  return amount;
}

export function parsePositiveAtomicAmount(
  value: string,
  code = "PAYMENT_REJECTED",
): bigint {
  const amount = parseAtomicAmount(value, code);
  if (amount <= 0n) throw new Error(code);
  return amount;
}

function canonicalResource(requirement: PaymentRequirement, fallback?: string): string | undefined {
  if (typeof requirement.resource === "string") return requirement.resource;
  const extra = requirement.extra;
  if (extra && typeof extra === "object" && typeof extra.resource === "string") {
    return extra.resource;
  }
  return fallback;
}

function feePayerOf(requirement: PaymentRequirement): string | undefined {
  const extra = requirement.extra;
  if (extra && typeof extra === "object" && typeof extra.feePayer === "string") {
    return extra.feePayer;
  }
  return undefined;
}

function amountOf(requirement: PaymentRequirement): string | undefined {
  if (typeof requirement.amount === "string") return requirement.amount;
  if (typeof requirement.maxAmountRequired === "string") return requirement.maxAmountRequired;
  return undefined;
}

export function selectQuote(
  paymentRequiredHeader: string,
  policy: PayerPolicy,
  requestBudgetAtomic: string,
): PaymentRequirement {
  parsePositiveAtomicAmount(policy.amountAtomic);
  const policyBudget = parseAtomicAmount(policy.maxAmountAtomic, "PAYMENT_LIMIT_EXCEEDED");
  const requestBudget = parseAtomicAmount(requestBudgetAtomic, "PAYMENT_LIMIT_EXCEEDED");
  if (policyBudget < parsePositiveAtomicAmount(policy.amountAtomic) || requestBudget < 0n) {
    throw new Error("PAYMENT_LIMIT_EXCEEDED");
  }

  let decoded: ReturnType<typeof decodePaymentHeader>;
  try {
    decoded = decodePaymentHeader(paymentRequiredHeader);
  } catch {
    throw new Error("PAYMENT_REJECTED");
  }
  if (!("accepts" in decoded) || decoded.x402Version !== 2 || !Array.isArray(decoded.accepts)) {
    throw new Error("PAYMENT_REJECTED");
  }

  const matches = decoded.accepts.filter((candidate) => {
    const amount = amountOf(candidate);
    return (
      candidate.scheme === "exact" &&
      candidate.network === policy.network &&
      candidate.asset === policy.asset &&
      candidate.payTo === policy.payTo &&
      feePayerOf(candidate) === policy.feePayer &&
      canonicalResource(candidate, decoded.resource?.url) === policy.resourceUrl &&
      candidate.maxTimeoutSeconds === policy.maxTimeoutSeconds &&
      amount === policy.amountAtomic
    );
  });

  if (matches.length !== 1) throw new Error("PAYMENT_REJECTED");
  const quote = matches[0]!;
  const quoteAmount = parsePositiveAtomicAmount(amountOf(quote) ?? "", "PAYMENT_REJECTED");
  if (quoteAmount > requestBudget || quoteAmount > policyBudget) {
    throw new Error("PAYMENT_LIMIT_EXCEEDED");
  }
  return quote;
}

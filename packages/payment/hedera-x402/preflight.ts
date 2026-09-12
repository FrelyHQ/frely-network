import { decodePaymentRequiredHeader } from "@x402/core/http";
import { PaymentRequiredSchema } from "@x402/core/schemas";
import type {
  LocalPreflight,
  PaymentRequired,
  PaymentRequirements,
  Policy,
  Selection,
} from "./types.ts";
import { fileKeyPath } from "./key-file.ts";

const MAX_ATOMIC = 9_223_372_036_854_775_807n;
const MAX_HEADER_BYTES = 64 * 1024;
const ENTITY_ID = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SIGNER_REF = /^env:[A-Z_][A-Z0-9_]*$/;

type RecordValue = Record<string, unknown>;

function blocked(
  reason: string,
  requestId: string | null = null,
): LocalPreflight {
  return {
    requestId,
    decision: "blocked",
    paymentStatus: "not_paid",
    serviceStatus: "not_started",
    reason,
    retryAction: "none",
    evidence: null,
    output: null,
  };
}

function record(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function secureUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === ""
    );
  } catch {
    return false;
  }
}

export function atomic(value: unknown, reason: string): bigint {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^(0|[1-9][0-9]*)$/.test(value)
  ) {
    throw new Error(reason);
  }
  return BigInt(value);
}

export function validPolicy(value: unknown): value is Policy {
  if (!record(value)) return false;
  if (
    value.enabled !== true ||
    value.network !== "hedera:testnet" ||
    typeof value.asset !== "string" ||
    !ENTITY_ID.test(value.asset) ||
    !Number.isSafeInteger(value.assetDecimals) ||
    (typeof value.assetDecimals === "number" && value.assetDecimals < 0) ||
    (value.asset === "0.0.0" && value.assetDecimals !== 8) ||
    typeof value.amountAtomic !== "string" ||
    value.amountAtomic.length > 128 ||
    !/^[1-9][0-9]*$/.test(value.amountAtomic) ||
    typeof value.payerAccountId !== "string" ||
    !ENTITY_ID.test(value.payerAccountId) ||
    typeof value.payTo !== "string" ||
    !ENTITY_ID.test(value.payTo) ||
    !Array.isArray(value.feePayers) ||
    value.feePayers.length === 0 ||
    !value.feePayers.every(
      (item) => typeof item === "string" && ENTITY_ID.test(item),
    ) ||
    !secureUrl(value.facilitatorUrl) ||
    value.resourceUrl !== "http://127.0.0.1:13600/v1/responses" ||
    !secureUrl(value.mirrorNodeUrl) ||
    typeof value.journalPath !== "string" ||
    value.journalPath.length === 0 ||
    typeof value.signerRef !== "string" ||
    (!SIGNER_REF.test(value.signerRef) &&
      !(value.keyType === "ecdsa" && fileKeyPath(value.signerRef) !== null)) ||
    (value.keyType !== "ecdsa" && value.keyType !== "ed25519") ||
    typeof value.credentialRef !== "string" ||
    value.credentialRef.length === 0
  ) {
    return false;
  }
  return true;
}

function decodeHeader(value: unknown): unknown {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_HEADER_BYTES ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    throw new Error("CAPTURE_INVALID");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.toString("base64") !== value ||
    bytes.byteLength > MAX_HEADER_BYTES
  ) {
    throw new Error("CAPTURE_INVALID");
  }
  const decodedText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  JSON.parse(decodedText);
  return decodePaymentRequiredHeader(value);
}

export function validateCaptured402(value: unknown): PaymentRequired | null {
  if (!record(value) || value.status !== 402) return null;
  let parsed: unknown;
  try {
    parsed = decodeHeader(value.paymentRequiredHeader);
  } catch {
    return null;
  }
  const validated = PaymentRequiredSchema.safeParse(parsed);
  return validated.success && validated.data.x402Version === 2
    ? (validated.data as PaymentRequired)
    : null;
}

function quoteReason(
  quote: PaymentRequirements,
  resourceUrl: string,
  policy: Policy,
  budgetAmount: bigint,
): string | null {
  if (quote.scheme !== "exact" || quote.network !== "hedera:testnet") {
    return "PROFILE_UNSUPPORTED";
  }
  if (quote.asset !== policy.asset || resourceUrl !== policy.resourceUrl) {
    return "POLICY_MISMATCH";
  }
  if (
    quote.payTo !== policy.payTo ||
    !Number.isInteger(quote.maxTimeoutSeconds) ||
    quote.maxTimeoutSeconds <= 0 ||
    quote.maxTimeoutSeconds > 120 ||
    !record(quote.extra) ||
    typeof quote.extra.feePayer !== "string" ||
    !policy.feePayers.includes(quote.extra.feePayer)
  ) {
    return "POLICY_MISMATCH";
  }
  if (quote.amount !== policy.amountAtomic) return "POLICY_MISMATCH";
  let amount: bigint;
  try {
    amount = atomic(quote.amount, "AMOUNT_INVALID");
  } catch {
    return "AMOUNT_INVALID";
  }
  if (amount === 0n || amount > MAX_ATOMIC) return "AMOUNT_INVALID";
  if (amount > budgetAmount) return "BUDGET_EXCEEDED";
  return null;
}

export function preflight(input: unknown): LocalPreflight {
  if (!record(input)) return blocked("INPUT_INVALID");
  const requestId =
    record(input.payment) &&
    typeof input.payment.requestId === "string" &&
    REQUEST_ID.test(input.payment.requestId)
      ? input.payment.requestId
      : null;
  if (!validPolicy(input.policy))
    return blocked("CONFIG_INCOMPLETE", requestId);
  const policy = input.policy;

  if (!record(input.payment)) return blocked("BUDGET_INVALID");
  if (
    typeof input.payment.requestId !== "string" ||
    !REQUEST_ID.test(input.payment.requestId)
  ) {
    return blocked("INPUT_INVALID");
  }
  if (Object.hasOwn(input.payment, "acceptIndex")) {
    return blocked("INPUT_UNSUPPORTED", requestId);
  }
  if (!record(input.payment.budget))
    return blocked("BUDGET_INVALID", requestId);
  const budget = input.payment.budget;
  if (budget.network !== policy.network || budget.asset !== policy.asset) {
    return blocked("BUDGET_SCOPE_MISMATCH", requestId);
  }
  let budgetAmount: bigint;
  try {
    budgetAmount = atomic(budget.maxAmountAtomic, "BUDGET_INVALID");
  } catch {
    return blocked("BUDGET_INVALID", requestId);
  }

  const required = validateCaptured402(input.http);
  if (required === null) return blocked("CAPTURE_INVALID", requestId);

  const reasons: string[] = [];
  const selections: Selection[] = [];
  required.accepts.forEach((requirements, acceptIndex) => {
    // Schema validation is complete above; the fixed Hedera profile also narrows
    // the SDK's generic string network to its `${namespace}:${reference}` type.
    const typedRequirements = requirements as PaymentRequirements;
    const reason = quoteReason(
      typedRequirements,
      required.resource.url,
      policy,
      budgetAmount,
    );
    if (reason === null) {
      selections.push({
        required: required as PaymentRequired,
        requirements: typedRequirements,
        acceptIndex,
      });
    } else {
      reasons.push(reason);
    }
  });

  if (selections.length > 1) return blocked("QUOTE_AMBIGUOUS", requestId);
  if (selections.length === 0) {
    return blocked("NO_ACCEPTABLE_QUOTE", requestId);
  }
  return {
    requestId: input.payment.requestId,
    decision: "prepared",
    paymentStatus: "not_paid",
    serviceStatus: "not_started",
    reason: "DRY_RUN_ONLY",
    retryAction: "none",
    evidence: null,
    output: null,
    selection: selections[0]!,
  };
}

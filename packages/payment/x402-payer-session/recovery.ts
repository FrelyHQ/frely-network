import type { PaymentRequirement } from "@frely-network/hedera-x402";
import { PayerJournal } from "./journal.ts";
import type { PayerPolicy, PayerSessionPorts, PayerSessionResult } from "./types.ts";

const PRE_DISPATCH: ReadonlySet<string> = new Set(["new", "challenged", "signed"]);

export async function recoverPayerRequest(input: {
  requestId: string;
  journalPath: string;
  policy: PayerPolicy;
  verifyOriginal: PayerSessionPorts["verifyOriginal"];
}): Promise<PayerSessionResult> {
  const journal = new PayerJournal(input.journalPath);
  try {
    const record = journal.read(input.requestId);
    if (!record) {
      return {
        requestId: input.requestId,
        paymentStatus: "not_paid",
        serviceStatus: "not_started",
        retryAction: "none",
      };
    }
    if (PRE_DISPATCH.has(record.phase)) {
      return {
        requestId: input.requestId,
        paymentStatus: "not_paid",
        serviceStatus: "not_started",
        retryAction: "none",
      };
    }
    if (!record.transactionId || !record.payloadDigest) {
      return {
        requestId: input.requestId,
        paymentStatus: "unknown",
        serviceStatus: "unknown",
        retryAction: "query_original",
      };
    }
    const requirement = storedRequirement(record.quoteJson);
    if (!requirement) {
      return {
        requestId: input.requestId,
        paymentStatus: "unknown",
        serviceStatus: "unknown",
        retryAction: "query_original",
        transactionId: record.transactionId,
      };
    }
    let status: "settled" | "pending" | "failed";
    try {
      status = await input.verifyOriginal({
        transactionId: record.transactionId,
        payloadDigest: record.payloadDigest,
        requirement,
      });
    } catch {
      status = "pending";
    }
    if (status === "settled") {
      return {
        requestId: input.requestId,
        paymentStatus: "settled",
        serviceStatus: record.serviceStatus,
        retryAction: "none",
        transactionId: record.transactionId,
      };
    }
    return {
      requestId: input.requestId,
      paymentStatus: "unknown",
      serviceStatus: "unknown",
      retryAction: "query_original",
      transactionId: record.transactionId,
    };
  } finally {
    journal.close();
  }
}

function storedRequirement(value: string | null): PaymentRequirement | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const requirement = parsed as Record<string, unknown>;
    const extra = requirement.extra;
    const feePayer = extra && typeof extra === "object" && !Array.isArray(extra)
      ? (extra as Record<string, unknown>).feePayer
      : undefined;
    const amount = requirement.amount ?? requirement.maxAmountRequired;
    if (
      requirement.scheme !== "exact" ||
      requirement.network !== "hedera:testnet" ||
      typeof amount !== "string" ||
      !/^[1-9][0-9]*$/u.test(amount) ||
      typeof requirement.asset !== "string" ||
      typeof requirement.payTo !== "string" ||
      typeof requirement.maxTimeoutSeconds !== "number" ||
      !Number.isSafeInteger(requirement.maxTimeoutSeconds) ||
      typeof feePayer !== "string"
    ) return undefined;
    return parsed as PaymentRequirement;
  } catch {
    return undefined;
  }
}

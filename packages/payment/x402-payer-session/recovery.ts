import { PayerJournal } from "./journal.ts";
import { reconstructRequirement } from "./session.ts";
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
    let status: "settled" | "pending" | "failed";
    try {
      status = await input.verifyOriginal({
        transactionId: record.transactionId,
        payloadDigest: record.payloadDigest,
        requirement: reconstructRequirement(input.policy),
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

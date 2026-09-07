import { bounded, evidenceMatches, recordOutcome } from "./session.ts";
import type { Journal, JournalRecord, PaymentEvidence, PaymentOutcome, RecoveryPolicy, PaymentRequirements, Verification } from "./types.ts";

/** One read-only attempt. Recovery owns the 3 x 10s bound and 2s spacing. */
export type RecoveryVerifier = (
  evidence: PaymentEvidence,
  responseTransaction: string | undefined,
  context: { policy: RecoveryPolicy; quote: PaymentRequirements | null },
) => Promise<Verification>;

export async function recoverPayment({ requestId, journal, verify, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }: {
  requestId: string;
  journal: Journal;
  verify: RecoveryVerifier;
  wait?: (ms: number) => Promise<void>;
}): Promise<PaymentOutcome> {
  let token: string | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let leaseLost = false;
  let lastKnown: JournalRecord | null = null;
  const base: PaymentOutcome = { requestId, decision: "blocked", paymentStatus: "unknown", serviceStatus: "unknown", reason: "JOURNAL_UNAVAILABLE", retryAction: "query_original", evidence: null, output: null };
  try {
    lastKnown = journal.read(requestId);
    if (!lastKnown) return { ...base, paymentStatus: "not_paid", serviceStatus: "not_started", reason: "REQUEST_NOT_FOUND", retryAction: "none" };
    token = journal.claimRun();
    heartbeat = setInterval(() => { try { journal.heartbeat(token!); } catch { leaseLost = true; } }, 5_000);
    const record = journal.read(requestId)!;
    lastKnown = record;
    const save = (outcome: PaymentOutcome, phase: "finished" | "closed-before-payment" = "finished") => {
      if (leaseLost) throw new Error("JOURNAL_UNAVAILABLE");
      lastKnown = journal.update(requestId, { phase, outcome, evidence: outcome.evidence }, token!);
      return recordOutcome(lastKnown);
    };
    if (record.phase === "closed-before-payment") return recordOutcome(record);
    if (!record.dispatched) {
      // Capture is authoritative even when the process died before Deliver.
      if (record.phase === "captured" || record.phaseBeforeFinish === "captured")
        return save({ ...recordOutcome(record), decision: "completed", paymentStatus: "not_paid", reason: record.outputExpiresAt !== null && record.output === null ? "OUTPUT_UNAVAILABLE" : "FREE_RESPONSE", retryAction: "none" });
      return save({ ...recordOutcome(record), decision: "blocked", paymentStatus: "not_paid", reason: "REQUEST_CLOSED_BEFORE_PAYMENT", retryAction: "none" }, "closed-before-payment");
    }
    if (record.outcome?.paymentStatus === "settled") return recordOutcome(record);
    let verified: PaymentEvidence | null = null;
    if (record.evidence?.transactionId && record.evidence.signedDigest) {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (leaseLost) throw new Error("JOURNAL_UNAVAILABLE");
        journal.heartbeat(token);
        try {
          const result = await bounded(verify(structuredClone(record.evidence), record.responseTransaction ?? undefined, structuredClone({ policy: record.policy, quote: record.quote })), 10_000, "VERIFICATION_TIMEOUT");
          if (result.verified && !record.responseConflict && evidenceMatches(record.evidence, result.evidence)) { verified = result.evidence; break; }
        } catch { /* Failure never proves that the original transaction was unpaid. */ }
        if (record.responseConflict) break; // Persistent contradiction needs human resolution.
        if (attempt < 2) await wait(2_000);
      }
    }
    // Re-read to apply cache expiry after a slow verifier, without extending it.
    const current = journal.read(requestId)!;
    lastKnown = current;
    return save({ ...recordOutcome(current), decision: verified ? "completed" : "paused", paymentStatus: verified ? "settled" : "unknown", reason: verified ? current.output === null ? "OUTPUT_UNAVAILABLE" : current.serviceStatus === "succeeded" ? "PAYMENT_COMPLETED" : "SERVICE_FAILED_AFTER_PAYMENT" : record.responseConflict ? "SETTLEMENT_CONFLICT" : "SETTLEMENT_UNVERIFIED", retryAction: verified ? "none" : "query_original", evidence: verified ?? record.evidence });
  } catch (error) {
    return { ...(lastKnown ? recordOutcome(lastKnown) : base), decision: "paused", reason: error instanceof Error && error.message === "REQUEST_IN_PROGRESS" ? "REQUEST_IN_PROGRESS" : "JOURNAL_UNAVAILABLE" };
  } finally {
    clearInterval(heartbeat);
    if (token) { try { journal.releaseRun(token); } catch {} }
  }
}

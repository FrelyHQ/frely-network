import { createHash } from "node:crypto";
import {
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { preflight, validateCaptured402 } from "./preflight.ts";
import { recoveryPolicy } from "./journal.ts";
import type {
  JournalRecord,
  PaymentEvidence,
  PaymentOutcome,
  Policy,
  Ports,
  PreparedRequest,
} from "./types.ts";
const TTL = 24 * 60 * 60 * 1000;
export const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export function requestFingerprint(
  request: PreparedRequest,
  policy: Policy,
): string {
  return digest(
    JSON.stringify({
      method: request.method,
      url: request.url,
      bodyHash: digest(request.body),
      providerId: request.providerId,
      payer: policy.payerAccountId,
      budget: {
        network: request.payment.budget.network,
        asset: request.payment.budget.asset,
        maxAmountAtomic: request.payment.budget.maxAmountAtomic,
      },
      policy: recoveryPolicy(policy),
      credentialRef: policy.credentialRef,
    }),
  );
}
export function recordOutcome(record: JournalRecord): PaymentOutcome {
  if (record.outcome?.paymentStatus === "settled" && record.responseConflict)
    return { ...record.outcome, output: record.output, decision: "paused", reason: "SETTLEMENT_CONFLICT", retryAction: "none" };
  if (record.outcome)
    return {
      ...record.outcome,
      output: record.output,
      ...(record.outputExpiresAt !== null && record.output === null
        ? { reason: "OUTPUT_UNAVAILABLE" }
        : {}),
    };
  return {
    requestId: record.requestId,
    decision: "paused",
    paymentStatus: record.dispatched ? "unknown" : "not_paid",
    serviceStatus: record.serviceStatus,
    reason: "RECOVERY_REQUIRED",
    retryAction: record.dispatched ? "query_original" : "none",
    evidence: record.evidence,
    output: record.output,
  };
}
export function createPaymentSession(config: Policy, ports: Ports) {
  return {
    async execute(input: PreparedRequest): Promise<PaymentOutcome> {
      const request = structuredClone(input);
      const policy = structuredClone(config);
      const base: PaymentOutcome = {
        requestId: request.payment?.requestId ?? null,
        decision: "blocked",
        paymentStatus: "not_paid",
        serviceStatus: "not_started",
        reason: "INPUT_INVALID",
        retryAction: "none",
        evidence: null,
        output: null,
      };
      let token: string | null = null;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let leaseLost = false;
      let lastKnown: JournalRecord | null = null;
      let receiveDeadline = 0;
      const save = (
        requestId: string,
        change: Parameters<Ports["journal"]["update"]>[1],
      ) => {
        if (leaseLost) throw new Error("JOURNAL_UNAVAILABLE");
        const record = ports.journal.update(requestId, change, token ?? undefined);
        lastKnown = record;
        return record;
      };
      const id = request.payment?.requestId;
      try {
        if (
          !id ||
          request.method !== "POST" ||
          typeof request.body !== "string" ||
          !request.providerId
        )
          return base;
        const existing = ports.journal.read(id);
        lastKnown = existing;
        if (Object.hasOwn(request.payment, "acceptIndex")) {
          return {
            ...(existing ? recordOutcome(existing) : base),
            decision: "blocked",
            reason: "INPUT_UNSUPPORTED",
          };
        }
        if (existing) {
          if (requestFingerprint(request, policy) !== existing.fingerprint)
            return {
              ...recordOutcome(existing),
              decision: "blocked",
              reason: "REQUEST_ID_CONFLICT",
            };
          return ports.journal.isRunActive()
            ? {
                ...recordOutcome(existing),
                decision: "paused",
                reason: "REQUEST_IN_PROGRESS",
              }
            : recordOutcome(existing);
        }
        const admission = preflight({
          policy,
          payment: request.payment,
          http: null,
        });
        if (admission.reason !== "CAPTURE_INVALID")
          return { ...base, reason: admission.reason };
        if (request.url !== policy.resourceUrl)
          return { ...base, reason: "POLICY_MISMATCH" };
        const headers = new Headers(request.headers);
        if (
          [...headers.keys()].some((key) =>
            /^(payment-required|payment-signature|payment-response|x-payment.*)$/i.test(
              key,
            ),
          )
        )
          return { ...base, reason: "INPUT_UNSUPPORTED" };
        if (ports.journal.isRunActive())
          return { ...base, decision: "paused", reason: "REQUEST_IN_PROGRESS" };
        token = ports.journal.claimRun();
        heartbeat = setInterval(() => {
          try { ports.journal.heartbeat(token!); } catch { leaseLost = true; }
        }, 5_000);
        const admittedRecord = ports.journal.admit(
          id,
          requestFingerprint(request, policy),
          recoveryPolicy(policy),
        );
        lastKnown = admittedRecord.record;
        if (!admittedRecord.fresh)
          return recordOutcome(ports.journal.read(id)!);

        const finish = (outcome: PaymentOutcome) => {
          save(id, {
            phase: "finished",
            outcome,
            evidence: outcome.evidence,
          });
          return outcome;
        };
        const send = (paidHeaders: Headers) => {
          receiveDeadline = performance.now() + 30_000;
          return ports.fetcher(
            new Request(request.url, {
              method: request.method,
              body: request.body,
              headers: paidHeaders,
              redirect: "error",
              signal: AbortSignal.timeout(30_000),
            }),
          );
        };
        save(id, {
          phase: "quote-intent",
          serviceStatus: "unknown",
        });
        let quoteResponse: Response;
        try {
          quoteResponse = await send(headers);
        } catch {
          return finish({
            ...base,
            decision: "paused",
            serviceStatus: "unknown",
            reason: "SERVICE_RESPONSE_UNAVAILABLE",
          });
        }
        if (
          (quoteResponse.status >= 300 && quoteResponse.status < 400) ||
          quoteResponse.redirected
        )
          return finish({
            ...base,
            reason: "REDIRECT_REJECTED",
            serviceStatus: "unknown",
          });
        if (quoteResponse.status !== 402) {
          await capture(quoteResponse, null);
          return finish({
            ...base,
            decision: "completed",
            serviceStatus: ports.journal.read(id)!.serviceStatus,
            reason: "FREE_RESPONSE",
            output: ports.journal.read(id)!.output,
          });
        }
        const http = {
          status: 402,
          paymentRequiredHeader: quoteResponse.headers.get("PAYMENT-REQUIRED"),
        };
        const required = validateCaptured402(http);
        if (!required)
          return finish({
            ...base,
            reason: "CAPTURE_INVALID",
            serviceStatus: "unknown",
          });
        save(id, {
          phase: "quoted",
          required,
          serviceStatus: "not_started",
        });
        const checked = preflight({ policy, payment: request.payment, http });
        if (checked.decision !== "prepared")
          return finish({ ...base, reason: checked.reason });
        save(id, { quote: checked.selection.requirements });
        try {
          await ports.checkNetwork(structuredClone(checked.selection));
        } catch (error) {
          return finish({
            ...base,
            decision: "paused",
            reason: error instanceof Error && error.message === "WALLET_NOT_READY"
              ? "WALLET_NOT_READY"
              : "NETWORK_CHECK_FAILED",
          });
        }
        save(id, { phase: "authorized" });
        let signed;
        try {
          const signingTimeout = policy.signerRef.startsWith("file:") ? 25_000 : 10_000;
          signed = await bounded(ports.sign(structuredClone(checked.selection)), signingTimeout, "SIGNING_TIMEOUT");
        } catch (error) {
          const permitted = new Set(["SIGNER_UNAVAILABLE", "SIGNER_MISMATCH", "NETWORK_CHECK_FAILED"]);
          const reason = policy.signerRef.startsWith("file:") && error instanceof Error && permitted.has(error.message)
            ? error.message : "SIGNING_FAILED";
          return finish({ ...base, reason });
        }
        if (!signed.transactionId || !signed.signedDigest)
          return finish({ ...base, reason: "SIGNING_INVALID" });
        const evidence: PaymentEvidence = {
          source: ports.source,
          network: policy.network,
          asset: policy.asset,
          amountAtomic: checked.selection.requirements.amount,
          payer: policy.payerAccountId,
          payTo: policy.payTo,
          transactionId: signed.transactionId,
          signedDigest: signed.signedDigest,
        };
        save(id, { phase: "signed", evidence });
        const paidHeaders = new Headers(headers);
        paidHeaders.set(
          "PAYMENT-SIGNATURE",
          encodePaymentSignatureHeader(signed.payload),
        );
        if (leaseLost) throw new Error("JOURNAL_UNAVAILABLE");
        lastKnown = ports.journal.beforeDispatch(id, token!);
        let paidResponse: Response | null = null;
        try {
          paidResponse = await send(paidHeaders);
        } catch {
          /* Query original even when transport fails. */
        }
        await capture(paidResponse, evidence);
        const captured = ports.journal.read(id)!;
        let verified: PaymentEvidence | null = null;
        try {
          const result = await ports.verify(
            structuredClone(evidence),
            captured.responseTransaction ?? undefined,
          );
          if (
            result.verified &&
            !captured.responseConflict &&
            evidenceMatches(evidence, result.evidence)
          )
            verified = result.evidence;
        } catch {
          /* Captured service state and output remain durable. */
        }
        const result: PaymentOutcome = {
          ...base,
          decision: verified ? "completed" : "paused",
          paymentStatus: verified ? "settled" : "unknown",
          serviceStatus: captured.serviceStatus,
          reason: verified
            ? captured.serviceStatus === "succeeded"
              ? "PAYMENT_COMPLETED"
              : captured.serviceStatus === "failed"
                ? "SERVICE_FAILED_AFTER_PAYMENT"
                : "OUTPUT_UNAVAILABLE"
            : "SETTLEMENT_UNVERIFIED",
          retryAction: verified ? "none" : "query_original",
          evidence: verified ?? evidence,
          output: captured.output,
        };
        return finish(result);

        async function capture(
          response: Response | null,
          evidence: PaymentEvidence | null,
        ) {
          let output: unknown | null = null;
          let serviceStatus: PaymentOutcome["serviceStatus"] = "unknown";
          let responseTransaction: string | null = null;
          let responseBindingConflict = false;
          if (response) {
            const hint = response.headers.get("PAYMENT-RESPONSE");
            if (hint)
              try {
                if (hint.length > 64 * 1024) throw Error("RESPONSE_HINT_INVALID");
                const decoded: unknown = decodePaymentResponseHeader(hint);
                if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
                  const value = decoded as Record<string, unknown>;
                  // Preserve any parseable transaction contradiction, even when
                  // the rest of the hint fails the response schema. A successful
                  // schema parse still never supplies settlement evidence.
                  const transaction = typeof value.transaction === "string" && value.transaction.length > 0 ? value.transaction : null;
                  const valid = typeof value.success === "boolean" && typeof value.network === "string" && transaction !== null && (value.payer === undefined || typeof value.payer === "string");
                  if (transaction && (valid || transaction !== evidence?.transactionId)) responseTransaction = transaction;
                  responseBindingConflict = transaction !== null && typeof value.network === "string" && value.network !== policy.network;
                }
              } catch {
                /* Unparseable hints are not evidence. */
              }
            let received: Uint8Array<ArrayBuffer> | null = null;
            try {
              received = await receiveBody(response, receiveDeadline);
            } catch {
              // No complete service response was observed, regardless of HTTP headers.
              serviceStatus = "unknown";
            }
            if (received !== null) {
              if (response.redirected || !response.ok) serviceStatus = "failed";
              else
                try {
                  // The parser receives only a complete, bounded in-memory body.
                  const buffered = new Response(
                    [204, 205, 304].includes(response.status) ? null : received,
                    {
                      status: response.status,
                      statusText: response.statusText,
                      headers: response.headers,
                    },
                  );
                  output = await ports.parseService(buffered);
                  serviceStatus =
                    output === null || output === undefined
                      ? "failed"
                      : "succeeded";
                } catch {
                  serviceStatus = "failed";
                }
            }
          }
          const serialized = output == null ? null : JSON.stringify(output);
          save(id!, {
            phase: "captured",
            serviceStatus,
            output: output ?? null,
            outputDigest: serialized == null ? null : digest(serialized),
            outputExpiresAt: serialized == null ? null : ports.now() + TTL,
            responseTransaction,
            responseConflict: responseBindingConflict || !!(
              evidence &&
              responseTransaction &&
              responseTransaction !== evidence.transactionId
            ),
          });
        }
      } catch (error) {
        let record: JournalRecord | null = lastKnown;
        try {
          if (id) record = ports.journal.read(id) ?? lastKnown;
        } catch {}
        return {
          ...(record
            ? recordOutcome(record)
            : {
                ...base,
                paymentStatus: "unknown",
                serviceStatus: "unknown",
                retryAction: "query_original",
              }),
          decision: "paused",
          reason:
            error instanceof Error && ["REQUEST_ID_CONFLICT", "REQUEST_IN_PROGRESS", "RECOVERY_REQUIRED"].includes(error.message)
              ? error.message
              : "JOURNAL_UNAVAILABLE",
        };
      } finally {
        clearInterval(heartbeat);
        if (token) { try { ports.journal.releaseRun(token); } catch {} }
      }
    },
  };
}
export function evidenceMatches(
  original: PaymentEvidence,
  verified: PaymentEvidence,
): boolean {
  return [
    "source",
    "network",
    "asset",
    "amountAtomic",
    "payer",
    "payTo",
    "transactionId",
    "signedDigest",
  ].every(
    (key) =>
      original[key as keyof PaymentEvidence] ===
      verified[key as keyof PaymentEvidence],
  );
}

// Resource bound for synthetic and future live Capture; receipt/signature headers are never buffered here.
const MAX_SERVICE_RESPONSE_BYTES = 1024 * 1024;
async function receiveBody(
  response: Response,
  deadline: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("SERVICE_RECEIVE_TIMEOUT")),
      Math.max(0, deadline - performance.now()),
    );
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (performance.now() >= deadline) throw new Error("SERVICE_RECEIVE_TIMEOUT");
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SERVICE_RESPONSE_BYTES)
        throw new Error("SERVICE_RESPONSE_TOO_LARGE");
      chunks.push(value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export async function bounded<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms); })]); }
  finally { clearTimeout(timer); }
}

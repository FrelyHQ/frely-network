import { createHash } from "node:crypto";
import type { PaymentRequirement } from "@frely-network/hedera-x402";
import { PayerJournal, policySnapshot } from "./journal.ts";
import { parseAtomicAmount, selectQuote } from "./policy.ts";
import type {
  PayerExecuteInput,
  PayerPolicy,
  PayerSessionPorts,
  PayerSessionResult,
} from "./types.ts";

const MAX_OUTPUT_BYTES = 64 * 1024;

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function requestFingerprint(
  input: PayerExecuteInput,
  policy: PayerPolicy,
  bodySha256: string,
): string {
  return sha256(
    JSON.stringify({
      method: input.method,
      resourceUrl: input.resourceUrl,
      bodySha256,
      providerId: input.providerId,
      payer: policy.payerAccountId,
      network: policy.network,
      asset: policy.asset,
      amountAtomic: policy.amountAtomic,
      maxAmountAtomic: input.maxAmountAtomic,
      payTo: policy.payTo,
      feePayer: policy.feePayer,
      maxTimeoutSeconds: policy.maxTimeoutSeconds,
      facilitatorUrl: policy.facilitatorUrl,
      profile: policySnapshot(policy),
    }),
  );
}

function cachedResult(requestId: string, record: {
  paymentStatus: PayerSessionResult["paymentStatus"];
  serviceStatus: PayerSessionResult["serviceStatus"];
  transactionId: string | null;
  outputJson: string | null;
  phase: string;
}): PayerSessionResult {
  const retryAction = record.paymentStatus === "unknown" || record.phase === "paid_dispatch_started"
    ? "query_original"
    : "none";
  let output: unknown;
  if (record.outputJson) {
    try {
      output = JSON.parse(record.outputJson);
    } catch {
      output = undefined;
    }
  }
  return {
    requestId,
    paymentStatus: record.paymentStatus === "settled" ? "settled" : record.paymentStatus,
    serviceStatus: record.serviceStatus,
    retryAction,
    ...(record.transactionId ? { transactionId: record.transactionId } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

function requirementFromPolicy(policy: PayerPolicy): PaymentRequirement {
  return {
    scheme: "exact",
    network: policy.network,
    amount: policy.amountAtomic,
    asset: policy.asset,
    payTo: policy.payTo,
    maxTimeoutSeconds: policy.maxTimeoutSeconds,
    extra: { feePayer: policy.feePayer },
    resource: policy.resourceUrl,
  };
}

function settlementTrusted(response: Response, transactionId: string, network: string): boolean {
  const encoded = response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
  if (!encoded) return false;
  try {
    const evidence = asObject(
      JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob(encoded.replace(/-/gu, "+").replace(/_/gu, "/")), (character) =>
            character.charCodeAt(0),
          ),
        ),
      ),
    );
    if (!evidence || evidence.success !== true) return false;
    const rawNetwork = typeof evidence.network === "string" ? evidence.network : "";
    const transaction = [evidence.transaction, evidence.transactionId, evidence.txHash].find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    return (rawNetwork === network || rawNetwork === "hedera-testnet") && transaction === transactionId;
  } catch {
    return false;
  }
}

async function readOutput(response: Response): Promise<{ output?: unknown; digest: string }> {
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  const digest = sha256(bytes);
  if (bytes.byteLength > MAX_OUTPUT_BYTES) return { digest };
  try {
    return { output: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), digest };
  } catch {
    return { digest };
  }
}

export class PayerSession {
  constructor(
    private readonly policy: PayerPolicy,
    private readonly ports: PayerSessionPorts,
  ) {}

  async execute(input: PayerExecuteInput): Promise<PayerSessionResult> {
    if (input.method !== "POST" || input.resourceUrl !== this.policy.resourceUrl) {
      throw new Error("INVALID_REQUEST");
    }
    parseAtomicAmount(input.maxAmountAtomic, "PAYMENT_LIMIT_EXCEEDED");
    const bodySha256 = sha256(input.body);
    const fingerprint = requestFingerprint(input, this.policy, bodySha256);
    const journal = new PayerJournal(this.policy.journalPath);
    try {
      const admitted = journal.admit(input.requestId, fingerprint, this.policy);
      if (!admitted.fresh) {
        if (admitted.record.phase === "service_succeeded") {
          return cachedResult(input.requestId, admitted.record);
        }
        if (
          admitted.record.phase === "paid_dispatch_started" ||
          admitted.record.phase === "unknown" ||
          admitted.record.phase === "settled" ||
          admitted.record.phase === "service_failed" ||
          admitted.record.phase === "signed"
        ) {
          if (admitted.record.phase === "signed") throw new Error("REQUEST_IN_PROGRESS");
          return cachedResult(input.requestId, {
            ...admitted.record,
            paymentStatus: admitted.record.paymentStatus === "settled" ? "settled" : "unknown",
            serviceStatus: admitted.record.serviceStatus === "succeeded" ? "succeeded" : admitted.record.serviceStatus,
          });
        }
      }

      const unpaid = await this.ports.fetch(
        new Request(input.resourceUrl, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-frely-request-id": input.requestId,
          },
          body: Uint8Array.from(input.body),
        }),
      );
      if (unpaid.status !== 402) throw new Error("PAYMENT_REQUIRED");
      const header = unpaid.headers.get("PAYMENT-REQUIRED") ?? unpaid.headers.get("X-PAYMENT-REQUIRED");
      if (!header) throw new Error("PAYMENT_REQUIRED");
      journal.update(input.requestId, fingerprint, { phase: "challenged" });
      const quote = selectQuote(header, this.policy, input.maxAmountAtomic);
      const latest = journal.read(input.requestId);
      if (!latest || latest.fingerprint !== fingerprint) throw new Error("REQUEST_ID_CONFLICT");

      const signed = await this.ports.sign({
        requirement: quote,
        resourceUrl: input.resourceUrl,
        bodySha256,
      });
      journal.update(input.requestId, fingerprint, { phase: "signed" });
      journal.beforePaidDispatch(input.requestId, fingerprint, signed);

      let paid: Response;
      try {
        paid = await this.ports.fetch(
          new Request(input.resourceUrl, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "x-frely-request-id": input.requestId,
              "PAYMENT-SIGNATURE": signed.paymentHeader,
            },
            body: Uint8Array.from(input.body),
          }),
        );
      } catch {
        journal.update(input.requestId, fingerprint, {
          phase: "unknown",
          paymentStatus: "unknown",
          serviceStatus: "unknown",
        });
        return {
          requestId: input.requestId,
          paymentStatus: "unknown",
          serviceStatus: "unknown",
          retryAction: "query_original",
          transactionId: signed.transactionId,
        };
      }

      const observed = await readOutput(paid);
      const settled = settlementTrusted(paid, signed.transactionId, this.policy.network);
      if (!settled) {
        journal.update(input.requestId, fingerprint, {
          phase: "unknown",
          paymentStatus: "unknown",
          serviceStatus: "unknown",
          responseDigest: observed.digest,
        });
        return {
          requestId: input.requestId,
          paymentStatus: "unknown",
          serviceStatus: "unknown",
          retryAction: "query_original",
          transactionId: signed.transactionId,
        };
      }

      const serviceFailed = paid.status >= 500;
      const outputJson = observed.output !== undefined ? JSON.stringify(observed.output) : null;
      journal.update(input.requestId, fingerprint, {
        phase: serviceFailed ? "service_failed" : "service_succeeded",
        paymentStatus: "settled",
        serviceStatus: serviceFailed ? "failed" : "succeeded",
        responseDigest: observed.digest,
        outputJson,
      });
      return {
        requestId: input.requestId,
        paymentStatus: "settled",
        serviceStatus: serviceFailed ? "failed" : "succeeded",
        retryAction: "none",
        transactionId: signed.transactionId,
        ...(serviceFailed || observed.output === undefined ? {} : { output: observed.output }),
      };
    } finally {
      journal.close();
    }
  }
}

export function reconstructRequirement(policy: PayerPolicy): PaymentRequirement {
  return requirementFromPolicy(policy);
}

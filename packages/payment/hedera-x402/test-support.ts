import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePaymentResponseHeader } from "@x402/core/http";
import valid from "../../../scripts/payment-spike/fixtures/synthetic/valid.json";
import rawPolicy from "../../../scripts/payment-spike/fixtures/synthetic/policy.json";
import { openJournal } from "./journal.ts";
import { createPaymentSession } from "./session.ts";
import type { Policy, Ports, PreparedRequest } from "./types.ts";
export function createHarness(
  options: {
    dbPath?: string;
    keepDb?: boolean;
    fault?:
      | "none"
      | "dispatch_timeout"
      | "service_failure"
      | "wrong_receipt"
      | "verify_failure";
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "frely-v2-"));
  let time = Date.now();
  const policy = {
    ...structuredClone(rawPolicy),
    journalPath: options.dbPath ?? join(dir, "journal.sqlite"),
  } as Policy;
  const journal = openJournal(policy.journalPath, () => time);
  const request: PreparedRequest = {
    method: "POST",
    url: policy.resourceUrl,
    body: JSON.stringify({ input: "test" }),
    headers: { Authorization: "test-secret" },
    providerId: "synthetic-provider",
    payment: structuredClone(valid.request.payment),
  };
  const counts = { http: 0, sign: 0, verify: 0 };
  const ports: Ports = {
    journal,
    source: "synthetic",
    now: () => time,
    fetcher: async () => {
      counts.http++;
      if (counts.http === 1)
        return new Response(null, {
          status: 402,
          headers: { "PAYMENT-REQUIRED": valid.capture.paymentRequiredHeader },
        });
      if (options.fault === "dispatch_timeout") throw new Error("timeout");
      return new Response(JSON.stringify({ output_text: "synthetic output" }), {
        status: options.fault === "service_failure" ? 500 : 200,
        headers: {
          "PAYMENT-RESPONSE": encodePaymentResponseHeader({
            success: true,
            transaction:
              options.fault === "wrong_receipt"
                ? "wrong-transaction"
                : "synthetic-tx",
            network: "hedera:testnet",
          }),
        },
      });
    },
    sign: async (selection) => {
      counts.sign++;
      return {
        transactionId: "synthetic-tx",
        signedDigest: "synthetic-digest",
        payload: {
          x402Version: 2,
          resource: selection.required.resource,
          accepted: selection.requirements,
          payload: { testOnly: true },
        },
      };
    },
    checkNetwork: async () => {},
    verify: async (evidence) => {
      counts.verify++;
      if (options.fault === "verify_failure") throw new Error("unavailable");
      return {
        verified: true,
        evidence: {
          ...evidence,
          verificationUrl: policy.mirrorNodeUrl,
          verifiedAt: new Date(time).toISOString(),
        },
      };
    },
    parseService: async (response) => {
      const body = (await response.json()) as { output_text?: unknown };
      if (typeof body.output_text !== "string") throw new Error("invalid");
      return body;
    },
  };
  return {
    session: createPaymentSession(policy, ports),
    request,
    counts,
    ports,
    journal,
    policy,
    advance: (ms: number) => {
      time += ms;
    },
    close: () => {
      journal.close();
      if (!options.keepDb) rmSync(dir, { recursive: true, force: true });
    },
  };
}

import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import {
  createNetworkX402Gate,
  readNetworkX402Config,
  type NetworkX402Gate,
} from "./index.ts";

const RESOURCE_URL = "http://127.0.0.1:13600/v1/responses";
const FACILITATOR_URL = "https://api.testnet.blocky402.com";
const AMOUNT_ATOMIC = "100000000";
const PAY_TO = "0.0.10403579";
const FEE_PAYER = "0.0.7162784";
const REQUEST_ID = "req-vision-1";

const validEnv = {
  FRELY_X402_RESOURCE_URL: RESOURCE_URL,
  FRELY_X402_AMOUNT_ATOMIC: AMOUNT_ATOMIC,
  FRELY_X402_PAY_TO: PAY_TO,
  FRELY_X402_FEE_PAYER: FEE_PAYER,
  FRELY_X402_FACILITATOR_URL: FACILITATOR_URL,
};

type HarnessOptions = {
  omitBodySha256?: boolean;
  requestId?: string;
  verify?: () => Promise<VerifyResponse> | VerifyResponse;
  settle?: () => Promise<SettleResponse> | SettleResponse;
};

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function acceptedQuote(): PaymentRequirements {
  return {
    scheme: "exact",
    network: "hedera:testnet",
    asset: "0.0.0",
    amount: AMOUNT_ATOMIC,
    payTo: PAY_TO,
    maxTimeoutSeconds: 120,
    extra: { feePayer: FEE_PAYER, paymentFlow: "upfront" },
  };
}

function encodeSignature(body: string, options?: { omitBodySha256?: boolean }): string {
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: {
      url: RESOURCE_URL,
      description: "Frely Network gpt-5.6-luna",
      mimeType: "application/json",
    },
    accepted: acceptedQuote(),
    payload: { transaction: "test-only" },
    ...(options?.omitBodySha256 ? {} : { extensions: { bodySha256: sha256Hex(body) } }),
  });
}

function paymentRequest(requestId: string, body: string, paymentSignature?: string): Request {
  return new Request(RESOURCE_URL, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-frely-request-id": requestId,
      ...(paymentSignature ? { "PAYMENT-SIGNATURE": paymentSignature } : {}),
    },
  });
}

async function createNetworkX402Harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const requestId = options.requestId ?? REQUEST_ID;
  const body = JSON.stringify({ model: "gpt-5.6-luna", stream: false });
  const facilitator: FacilitatorClient = {
    getSupported: async () => ({
      kinds: [{
        x402Version: 2,
        scheme: "exact",
        network: "hedera:testnet",
        extra: { feePayer: FEE_PAYER },
      }],
      extensions: [],
      signers: {},
    }),
    verify: async () => {
      events.push("verify");
      return options.verify ? options.verify() : { isValid: true, payer: "0.0.10386782" };
    },
    settle: async () => {
      events.push("settle");
      return options.settle
        ? options.settle()
        : {
          success: true,
          payer: "0.0.10386782",
          network: "hedera:testnet",
          transaction: "0.0.7162784@1700000000.000000001",
        };
    },
  };
  const gate: NetworkX402Gate = await createNetworkX402Gate({
    resourceUrl: RESOURCE_URL,
    amountAtomic: AMOUNT_ATOMIC,
    payTo: PAY_TO,
    feePayer: FEE_PAYER,
    facilitatorUrl: FACILITATOR_URL,
    facilitator,
  });
  const signature = encodeSignature(body, { omitBodySha256: options.omitBodySha256 });
  return {
    gate,
    body,
    unsignedRequest: paymentRequest(requestId, body),
    signedRequest: paymentRequest(requestId, body, signature),
    events: () => events.slice(),
  };
}

test("returns 402 from Network without calling the upstream", async () => {
  const h = await createNetworkX402Harness();
  const admission = await h.gate.admit(h.unsignedRequest, h.body);
  expect(admission.kind).toBe("response");
  if (admission.kind === "response") expect(admission.response.status).toBe(402);
  expect(h.events()).toEqual([]);
});

test("rejects an unbound payment before Blocky or Relay", async () => {
  const h = await createNetworkX402Harness({ omitBodySha256: true });
  const admission = await h.gate.admit(h.signedRequest, h.body);
  expect(admission.kind).toBe("response");
  expect(h.events()).toEqual([]);
});

test("grants Relay dispatch only after Blocky settlement", async () => {
  const h = await createNetworkX402Harness();
  const admission = await h.gate.admit(h.signedRequest, h.body);
  expect(admission.kind).toBe("settled");
  expect(h.events()).toEqual(["verify", "settle"]);
  if (admission.kind === "settled") {
    const response = await admission.finish(Response.json({ output_text: "FRELY X402 OK" }));
    expect(response.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(await response.json()).toEqual({ output_text: "FRELY X402 OK" });
  }
});

test("accepts only the frozen loopback resource and Blocky facilitator", () => {
  expect(readNetworkX402Config(validEnv)).toEqual({
    resourceUrl: RESOURCE_URL,
    amountAtomic: AMOUNT_ATOMIC,
    payTo: PAY_TO,
    feePayer: FEE_PAYER,
    facilitatorUrl: FACILITATOR_URL,
  });
});

test("rejects localhost, other ports, credentials, search, hash, illegal accounts, and non-1-HBAR amounts", () => {
  const rejected = [
    { FRELY_X402_RESOURCE_URL: "http://localhost:13600/v1/responses" },
    { FRELY_X402_RESOURCE_URL: "http://127.0.0.1:13601/v1/responses" },
    { FRELY_X402_RESOURCE_URL: "http://user:pass@127.0.0.1:13600/v1/responses" },
    { FRELY_X402_RESOURCE_URL: "http://127.0.0.1:13600/v1/responses?paid=1" },
    { FRELY_X402_RESOURCE_URL: "http://127.0.0.1:13600/v1/responses#x402" },
    { FRELY_X402_FACILITATOR_URL: "https://facilitator.example" },
    { FRELY_X402_PAY_TO: "0.0.abc" },
    { FRELY_X402_FEE_PAYER: "0.0" },
    { FRELY_X402_AMOUNT_ATOMIC: "99999999" },
    { FRELY_X402_AMOUNT_ATOMIC: "100000000.0" },
  ];
  for (const change of rejected) {
    expect(() => readNetworkX402Config({ ...validEnv, ...change })).toThrow("X402_NOT_CONFIGURED");
  }
});

test("rejects uppercase or mismatched bodySha256 before Blocky", async () => {
  const h = await createNetworkX402Harness();
  const uppercase = encodePaymentSignatureHeader({
    x402Version: 2,
    resource: { url: RESOURCE_URL, description: "Frely Network gpt-5.6-luna", mimeType: "application/json" },
    accepted: acceptedQuote(),
    payload: { transaction: "test-only" },
    extensions: { bodySha256: sha256Hex(h.body).toUpperCase() },
  });
  const mismatched = encodePaymentSignatureHeader({
    x402Version: 2,
    resource: { url: RESOURCE_URL, description: "Frely Network gpt-5.6-luna", mimeType: "application/json" },
    accepted: acceptedQuote(),
    payload: { transaction: "test-only" },
    extensions: { bodySha256: sha256Hex("other-body") },
  });
  for (const header of [uppercase, mismatched]) {
    const admission = await h.gate.admit(paymentRequest(REQUEST_ID, h.body, header), h.body);
    expect(admission.kind).toBe("response");
  }
  expect(h.events()).toEqual([]);
});

test("keeps an unknown placeholder after settle is submitted", async () => {
  const h = await createNetworkX402Harness({
    settle: () => ({
      success: false,
      errorReason: "settlement_pending",
      network: "hedera:testnet",
      transaction: "0.0.7162784@1700000000.000000001",
    }),
  });
  const first = await h.gate.admit(h.signedRequest, h.body);
  expect(first.kind).toBe("response");
  expect(h.events()).toEqual(["verify", "settle"]);
  const retry = await h.gate.admit(h.signedRequest, h.body);
  expect(retry.kind).toBe("response");
  if (retry.kind === "response") expect(retry.response.status).toBe(409);
  expect(h.events()).toEqual(["verify", "settle"]);
});

test("allows verify rejection to retry the same requestId", async () => {
  let rejectVerify = true;
  const h = await createNetworkX402Harness({
    verify: () => rejectVerify
      ? { isValid: false, invalidReason: "invalid_signature" }
      : { isValid: true, payer: "0.0.10386782" },
  });
  const first = await h.gate.admit(h.signedRequest, h.body);
  expect(first.kind).toBe("response");
  expect(h.events().filter((event) => event === "settle")).toEqual([]);
  rejectVerify = false;
  const retry = await h.gate.admit(h.signedRequest, h.body);
  expect(retry.kind).toBe("settled");
  expect(h.events()).toEqual(["verify", "verify", "settle"]);
});

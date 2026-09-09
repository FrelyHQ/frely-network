import { describe, expect, test } from "bun:test";
import { X402Gateway } from "./index.ts";

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const requirement = {
  scheme: "exact",
  network: "hedera:testnet",
  amount: "1",
  asset: "0.0.0",
  payTo: "0.0.1001",
  maxTimeoutSeconds: 60,
};

const payment = {
  x402Version: 2,
  resource: { url: "https://provider.example/v1/responses" },
  accepted: requirement,
  payload: { transaction: "signed" },
};

describe("payee-side x402 gateway", () => {
  test("fails closed without payment and settles a verified request without owning a ledger", async () => {
    let handled = false;
    let verified = false;
    let settled = false;
    const gateway = new X402Gateway({
      network: "hedera:testnet",
      verifier: { verify: async () => { verified = true; return { isValid: true, payer: "0.0.77" }; } },
      settler: { settle: async () => { settled = true; return { success: true, network: "hedera:testnet", transaction: "0.0.900" }; } },
    });
    const requirements = { x402Version: 2 as const, accepts: [requirement] };

    const unpaid = await gateway.handle(new Request("https://provider.example/v1/responses"), requirements, async () => {
      handled = true;
      return Response.json({ ok: true });
    });
    expect(unpaid.status).toBe(402);
    expect(handled).toBe(false);

    const paid = await gateway.handle(new Request("https://provider.example/v1/responses", {
      headers: { "PAYMENT-SIGNATURE": encode(payment) },
    }), requirements, async () => {
      handled = true;
      return Response.json({ ok: true });
    });
    expect(paid.status).toBe(200);
    expect(verified).toBe(true);
    expect(settled).toBe(true);
    expect(handled).toBe(true);
    expect(paid.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
  });

  test("does not call the capability handler for an invalid payment", async () => {
    let handled = false;
    const gateway = new X402Gateway({
      network: "hedera:testnet",
      verifier: { verify: async () => ({ isValid: false }) },
      settler: { settle: async () => ({ success: true, network: "hedera:testnet" }) },
    });
    const response = await gateway.handle(new Request("https://provider.example", {
      headers: { "PAYMENT-SIGNATURE": encode(payment) },
    }), { x402Version: 2, accepts: [requirement] }, async () => {
      handled = true;
      return Response.json({ ok: true });
    });

    expect(response.status).toBe(402);
    expect(handled).toBe(false);
  });
});
import { createFixtureHederaX402AdmissionVerifier } from "../../payment/hedera-x402/index.ts";
import { createX402PaymentAdmissionHandler } from "./index.ts";

const RESOURCE = "https://api.frely.cloud/a2a/tasks";
const HASH = "a".repeat(64);

function request(path: string, body: unknown, authorization = "Bearer relay-secret"): Request {
  return new Request(`https://network.example${path}`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function verifier() {
  return createFixtureHederaX402AdmissionVerifier({ expectedProof: "opaque-wallet-proof", now: () => "2026-09-09T03:00:00.000Z" });
}

describe("Network x402 admission HTTP boundary", () => {
  test("requires Relay authentication and exposes no payment verifier when unconfigured", async () => {
    const handler = createX402PaymentAdmissionHandler({ verifier: verifier() });
    const response = await handler(request("/a2a/payment/requirements", { resource: RESOURCE, method: "POST", requestHash: HASH }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "PAYMENT_ADMISSION_NOT_CONFIGURED" });

    const authenticated = createX402PaymentAdmissionHandler({ verifier: verifier(), apiKey: "relay-secret" });
    const unauthorized = await authenticated(request("/a2a/payment/requirements", { resource: RESOURCE, method: "POST", requestHash: HASH }, "Bearer wrong"));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ code: "UNAUTHORIZED" });
  });

  test("verifies an opaque proof and returns only admission facts", async () => {
    const handler = createX402PaymentAdmissionHandler({ verifier: verifier(), apiKey: "relay-secret" });
    const challengeResponse = await handler(request("/a2a/payment/requirements", { resource: RESOURCE, method: "POST", requestHash: HASH }));
    expect(challengeResponse.status).toBe(200);
    const challengePayload = await challengeResponse.json() as { payment: { paymentRequired: string } };
    expect(challengePayload.payment.paymentRequired).toContain("fixture:x402");

    const invalid = await handler(request("/a2a/payment/verify", {
      resource: RESOURCE,
      method: "POST",
      requestId: "req_a2a_1",
      requestHash: HASH,
      idempotencyKeyHash: "b".repeat(64),
      proof: "opaque-wallet-proof-invalid",
    }));
    expect(invalid.status).toBe(402);
    const invalidPayload = await invalid.json() as Record<string, unknown>;
    expect(invalidPayload).toMatchObject({ code: "payment_invalid" });
    expect(JSON.stringify(invalidPayload)).not.toContain("opaque-wallet-proof-invalid");

    const validProof = "opaque-wallet-proof";
    const valid = await handler(request("/a2a/payment/verify", {
      resource: RESOURCE,
      method: "POST",
      requestId: "req_a2a_1",
      requestHash: HASH,
      idempotencyKeyHash: "b".repeat(64),
      proof: validProof,
    }));
    expect(valid.status).toBe(200);
    const validPayload = await valid.json() as Record<string, unknown>;
    expect(validPayload).toHaveProperty("admission.paymentReference");
    expect(JSON.stringify(validPayload)).not.toContain(validProof);
  });

  test("rejects commercial fields at the admission boundary", async () => {
    const handler = createX402PaymentAdmissionHandler({ verifier: verifier(), apiKey: "relay-secret" });
    const response = await handler(request("/a2a/payment/requirements", { resource: RESOURCE, method: "POST", requestHash: HASH, planId: "plan-should-not-cross" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "PAYMENT_REQUEST_INVALID", message: "Payment admission request is invalid" });
  });
});

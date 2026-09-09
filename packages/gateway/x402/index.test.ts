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

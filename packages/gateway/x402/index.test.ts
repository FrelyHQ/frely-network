import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { FileX402ReplayStore, X402Gateway } from "./index.ts";

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const resource = "https://network.frely.cloud/x402/frely/responses";
const requirement = {
  scheme: "exact",
  network: "hedera:testnet",
  amount: "1",
  asset: "0.0.0",
  payTo: "0.0.1001",
  maxTimeoutSeconds: 60,
};
const requirements = { x402Version: 2 as const, resource: { url: resource }, accepts: [requirement] };
const payment = {
  x402Version: 2,
  resource: { url: resource },
  accepted: requirement,
  payload: { transaction: "signed" },
};

describe("payee-side x402 gateway", () => {
  test("fails closed without payment and settles a verified request", async () => {
    let handled = false;
    let verified = false;
    let settled = false;
    const gateway = new X402Gateway({
      network: "hedera:testnet",
      verifier: { verify: async () => { verified = true; return { isValid: true, payer: "0.0.77" }; } },
      settler: { settle: async () => { settled = true; return { success: true, network: "hedera:testnet", transaction: "0.0.900" }; } },
    });

    const unpaid = await gateway.handle(new Request(resource), requirements, async () => {
      handled = true;
      return Response.json({ ok: true });
    });
    expect(unpaid.status).toBe(402);
    expect(handled).toBe(false);

    const paid = await gateway.handle(new Request(resource, {
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
    const response = await gateway.handle(new Request(resource, {
      headers: { "PAYMENT-SIGNATURE": encode(payment) },
    }), requirements, async () => {
      handled = true;
      return Response.json({ ok: true });
    });

    expect(response.status).toBe(402);
    expect(handled).toBe(false);
  });

  test("binds the payment proof to the public resource", async () => {
    let handled = false;
    const gateway = new X402Gateway({
      network: "hedera:testnet",
      verifier: { verify: async () => ({ isValid: true }) },
      settler: { settle: async () => ({ success: true, network: "hedera:testnet" }) },
    });
    const response = await gateway.handle(new Request("https://network.frely.cloud/x402/other", {
      headers: { "PAYMENT-SIGNATURE": encode(payment) },
    }), requirements, async () => {
      handled = true;
      return Response.json({ ok: true });
    });
    expect(response.status).toBe(402);
    expect(handled).toBe(false);
  });

  test("claims a proof before execution and rejects replay", async () => {
    let handled = 0;
    let settled = 0;
    const claimed = new Set<string>();
    const gateway = new X402Gateway({
      network: "hedera:testnet",
      verifier: { verify: async () => ({ isValid: true }) },
      settler: { settle: async () => { settled += 1; return { success: true, network: "hedera:testnet", transaction: "0.0.900" }; } },
      replayStore: {
        claim: async (digest) => {
          if (claimed.has(digest)) return false;
          claimed.add(digest);
          return true;
        },
      },
      now: () => Date.parse("2026-09-11T00:00:00.000Z"),
    });
    const request = () => new Request(resource, { headers: { "PAYMENT-SIGNATURE": encode(payment) } });
    const handler = async () => {
      handled += 1;
      return Response.json({ ok: true });
    };

    expect((await gateway.handle(request(), requirements, handler)).status).toBe(200);
    const replay = await gateway.handle(request(), requirements, handler);
    expect(replay.status).toBe(402);
    expect((await replay.json() as { error?: string }).error).toBe("PAYMENT_REPLAYED");
    expect(handled).toBe(1);
    expect(settled).toBe(1);
  });
});

describe("file replay store", () => {
  test("survives a new store instance and allows an expired digest to be reclaimed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frely-network-x402-"));
    try {
      let now = Date.parse("2026-09-11T00:00:00.000Z");
      const digest = "a".repeat(64);
      const expiry = "2026-09-11T00:01:00.000Z";
      const first = new FileX402ReplayStore(directory, () => now);
      expect(await first.claim(digest, expiry)).toBe(true);

      const afterRestart = new FileX402ReplayStore(directory, () => now);
      expect(await afterRestart.claim(digest, expiry)).toBe(false);

      now = Date.parse("2026-09-11T00:02:00.000Z");
      expect(await afterRestart.claim(digest, "2026-09-11T00:03:00.000Z")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

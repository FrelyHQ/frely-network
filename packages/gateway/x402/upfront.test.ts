import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { X402Gateway } from "./index.ts";
import { FileX402AttemptStore, UpfrontX402Gateway } from "./upfront.ts";

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const resource = "http://127.0.0.1:18765/v1/responses";
const body = new TextEncoder().encode('{"model":"vision-basic"}');
const bodySha256 = createHash("sha256").update(body).digest("hex");
const requirement = {
  scheme: "exact",
  network: "hedera:testnet",
  amount: "1",
  asset: "0.0.0",
  payTo: "0.0.1001",
  maxTimeoutSeconds: 60,
  extra: { feePayer: "0.0.1002" },
};
const requirements = { x402Version: 2 as const, resource: { url: resource }, accepts: [requirement] };

function payment(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: { url: resource },
    accepted: requirement,
    payload: {
      transaction: "signed",
      extensions: { bodySha256 },
    },
    ...overrides,
  };
}

function paidRequest(payload = payment(), requestId = "req-1") {
  return new Request(resource, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "PAYMENT-SIGNATURE": encode(payload),
      "x-frely-request-id": requestId,
    },
  });
}

describe("isolated upfront x402 admission", () => {
  test("returns only a challenge when proof is missing", async () => {
    const calls: string[] = [];
    const gateway = new UpfrontX402Gateway({
      network: "hedera:testnet",
      verifier: { verify: async () => { calls.push("verify"); return { isValid: true }; } },
      settler: { settle: async () => { calls.push("settle"); return { success: true, network: "hedera:testnet", transaction: "0.0.1" }; } },
      attemptStore: memoryStore(),
    });
    const admission = await gateway.admit(new Request(resource, { method: "POST" }), body, requirements);
    expect(admission.kind).toBe("response");
    if (admission.kind === "response") expect(admission.response.status).toBe(402);
    expect(calls).toEqual([]);
  });

  test("does not settle an invalid proof", async () => {
    const calls: string[] = [];
    const gateway = new UpfrontX402Gateway({
      network: "hedera:testnet",
      verifier: { verify: async () => { calls.push("verify"); return { isValid: false }; } },
      settler: { settle: async () => { calls.push("settle"); return { success: true, network: "hedera:testnet" }; } },
      attemptStore: memoryStore(calls),
    });
    const admission = await gateway.admit(paidRequest(), body, requirements);
    expect(admission.kind).toBe("response");
    expect(calls).toEqual(["claim", "verify"]);
  });

  test("claims, verifies, then settles before the caller can invoke a handler", async () => {
    const calls: string[] = [];
    const store = memoryStore(calls);
    const gateway = new UpfrontX402Gateway({
      network: "hedera:testnet",
      verifier: { verify: async () => { calls.push("verify"); return { isValid: true, payer: "0.0.2001" }; } },
      settler: { settle: async () => { calls.push("settle"); return { success: true, network: "hedera:testnet", transaction: "0.0.9@1.1" }; } },
      attemptStore: store,
    });
    const admission = await gateway.admit(paidRequest(), body, requirements);
    expect(admission.kind).toBe("settled");
    expect(calls).toEqual(["claim", "verify", "settle"]);
    if (admission.kind !== "settled") throw new Error("expected settled");
    const finished = await admission.finish(Response.json({ ok: false }, { status: 502 }));
    expect(finished.status).toBe(502);
    expect(finished.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(await finished.json()).toEqual({ ok: false });
  });

  test("does not call settle when the settler is never reached after a failed claim", async () => {
    const calls: string[] = [];
    const gateway = new UpfrontX402Gateway({
      network: "hedera:testnet",
      verifier: { verify: async () => { calls.push("verify"); return { isValid: true }; } },
      settler: { settle: async () => { calls.push("settle"); return { success: true, network: "hedera:testnet" }; } },
      attemptStore: {
        claim: async () => { calls.push("claim"); return "duplicate"; },
        markSettled: async () => {},
        markDelivered: async () => {},
      },
    });
    const admission = await gateway.admit(paidRequest(), body, requirements);
    expect(admission.kind).toBe("response");
    expect(calls).toEqual(["claim"]);
  });

  test("rejects missing, uppercase, or mismatched body hashes", async () => {
    const gateway = new UpfrontX402Gateway({
      network: "hedera:testnet",
      verifier: { verify: async () => ({ isValid: true }) },
      settler: { settle: async () => ({ success: true, network: "hedera:testnet", transaction: "0.0.1" }) },
      attemptStore: memoryStore(),
    });
    const missing = payment();
    delete (missing.payload as { extensions?: unknown }).extensions;
    const upper = payment({
      payload: { transaction: "signed", extensions: { bodySha256: bodySha256.toUpperCase() } },
    });
    const other = payment({
      payload: { transaction: "signed", extensions: { bodySha256: "ab".repeat(32) } },
    });
    for (const payload of [missing, upper, other]) {
      const admission = await gateway.admit(paidRequest(payload), body, requirements);
      expect(admission.kind).toBe("response");
    }
  });

  test("rejects a conflicting request id fingerprint", async () => {
    const store = memoryStore();
    const gateway = new UpfrontX402Gateway({
      network: "hedera:testnet",
      verifier: { verify: async () => ({ isValid: true }) },
      settler: { settle: async () => ({ success: true, network: "hedera:testnet", transaction: "0.0.1" }) },
      attemptStore: store,
    });
    const first = await gateway.admit(paidRequest(), body, requirements);
    expect(first.kind).toBe("settled");
    const otherBody = new TextEncoder().encode('{"model":"other"}');
    const otherHash = createHash("sha256").update(otherBody).digest("hex");
    const second = await gateway.admit(
      paidRequest(payment({ payload: { transaction: "signed", extensions: { bodySha256: otherHash } } })),
      otherBody,
      requirements,
    );
    expect(second.kind).toBe("response");
    if (second.kind === "response") expect(second.response.status).toBe(409);
  });

  test("does not treat a settlement without a transaction identifier as settled", async () => {
    const gateway = new UpfrontX402Gateway({
      network: "hedera:testnet",
      verifier: { verify: async () => ({ isValid: true }) },
      settler: { settle: async () => ({ success: true, network: "hedera:testnet" }) },
      attemptStore: memoryStore(),
    });
    const admission = await gateway.admit(paidRequest(), body, requirements);
    expect(admission.kind).toBe("response");
    if (admission.kind === "response") expect(admission.response.status).toBe(502);
  });
});

describe("existing gateway order is unchanged", () => {
  test("handler still runs before settle on the production gateway", async () => {
    const calls: string[] = [];
    const gateway = new X402Gateway({
      network: "hedera:testnet",
      verifier: { verify: async () => ({ isValid: true }) },
      settler: {
        settle: async () => {
          calls.push("settle");
          return { success: true, network: "hedera:testnet", transaction: "0.0.1" };
        },
      },
    });
    await gateway.handle(
      new Request(resource, { headers: { "PAYMENT-SIGNATURE": encode(payment()) } }),
      requirements,
      async () => {
        calls.push("handler");
        return Response.json({ ok: true });
      },
    );
    expect(calls).toEqual(["handler", "settle"]);
  });
});

describe("file attempt store", () => {
  test("survives reopen and reports duplicates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "x402-attempts-"));
    try {
      const first = new FileX402AttemptStore(directory);
      expect(
        await first.claim({
          requestId: "req-1",
          fingerprint: "a".repeat(64),
          proofDigest: "b".repeat(64),
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      ).toBe("claimed");
      const second = new FileX402AttemptStore(directory);
      expect(
        await second.claim({
          requestId: "req-1",
          fingerprint: "a".repeat(64),
          proofDigest: "b".repeat(64),
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      ).toBe("duplicate");
      expect(
        await second.claim({
          requestId: "req-1",
          fingerprint: "c".repeat(64),
          proofDigest: "b".repeat(64),
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      ).toBe("conflict");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("enforces claimed to settled to delivered without phase regression", async () => {
    const directory = await mkdtemp(join(tmpdir(), "x402-attempts-"));
    try {
      const store = new FileX402AttemptStore(directory);
      await store.claim({
        requestId: "req-1",
        fingerprint: "a".repeat(64),
        proofDigest: "b".repeat(64),
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      await expect(store.markDelivered("req-1", "c".repeat(64))).rejects.toThrow("ATTEMPT_STATE_INVALID");
      await store.markSettled("req-1", { success: true, network: "hedera:testnet", transaction: "tx-1" });
      await store.markDelivered("req-1", "c".repeat(64));
      await expect(store.markSettled("req-1", { success: true, network: "hedera:testnet", transaction: "tx-2" })).rejects.toThrow("ATTEMPT_STATE_INVALID");
      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function memoryStore(calls?: string[]) {
  const rows = new Map<string, { fingerprint: string; proofDigest: string }>();
  return {
    claim: async (input: {
      requestId: string;
      fingerprint: string;
      proofDigest: string;
      expiresAt: string;
    }) => {
      calls?.push("claim");
      const existing = rows.get(input.requestId);
      if (!existing) {
        rows.set(input.requestId, input);
        return "claimed" as const;
      }
      if (existing.fingerprint === input.fingerprint && existing.proofDigest === input.proofDigest) {
        return "duplicate" as const;
      }
      return "conflict" as const;
    },
    markSettled: async () => {},
    markDelivered: async () => {},
  };
}

import { describe, expect, test } from "bun:test";
import {
  createLiveHederaX402AdmissionVerifier,
  createLiveHederaX402PaymentSettlement,
  ExactHederaPaymentSigner,
  HederaX402Client,
  type HederaPaymentSigner,
  type PaymentPayload,
} from "./index.ts";

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const A2A_REQUEST = {
  resource: "https://api.frely.cloud/a2a/tasks",
  method: "POST" as const,
  requestHash: "a".repeat(64),
};

const A2A_REQUIREMENT = {
  scheme: "exact",
  network: "hedera:testnet",
  amount: "100",
  asset: "0.0.0",
  payTo: "0.0.1001",
  maxTimeoutSeconds: 60,
  extra: {},
};

const A2A_PAYMENT_REQUIRED = {
  x402Version: 2,
  resource: { url: A2A_REQUEST.resource },
  accepts: [A2A_REQUIREMENT],
};

const A2A_CHALLENGE = {
  contractVersion: "frely.payment-admission.v1" as const,
  scheme: "exact" as const,
  network: "hedera:testnet" as const,
  requirementRevision: "quote-v1",
  resource: A2A_REQUEST.resource,
  paymentRequired: encode(A2A_PAYMENT_REQUIRED),
  chargeQuote: {
    quoteReference: "quote:a2a-v1",
    billingUnit: "usd_micro" as const,
    maximumChargeUnits: "1000000",
    expiresAt: "2026-09-09T03:05:00.000Z",
  },
  expiresAt: "2026-09-09T03:05:00.000Z",
};

const A2A_PROOF = encode({
  x402Version: 2,
  resource: { url: A2A_REQUEST.resource },
  accepted: A2A_REQUIREMENT,
  payload: { transaction: "signed-in-memory" },
});

const requirement = {
  scheme: "exact",
  network: "hedera-testnet",
  maxAmountRequired: "10",
  asset: "0.0.0",
  payTo: "0.0.1001",
  maxTimeoutSeconds: 60,
};

const signer: HederaPaymentSigner = {
  async createPaymentPayload(): Promise<PaymentPayload> {
    return {
      x402Version: 1,
      scheme: "exact",
      network: "hedera-testnet",
      payload: { transaction: "signed-payload" },
    };
  },
};

describe("Hedera x402 client", () => {
  test("uses the official Hedera signer to create a v2 transaction payload locally", async () => {
    const signer = new ExactHederaPaymentSigner({
      accountId: "0.0.1001",
      privateKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
    });

    const payload = await signer.createPaymentPayload({
      scheme: "exact",
      network: "hedera:testnet",
      amount: "1",
      asset: "0.0.0",
      payTo: "0.0.1002",
      maxTimeoutSeconds: 60,
      extra: { feePayer: "0.0.1003" },
    }, { method: "POST", url: "https://provider.example/v1/responses" });

    expect(payload.x402Version).toBe(2);
    expect(payload.resource?.url).toBe("https://provider.example/v1/responses");
    expect(payload.accepted?.network).toBe("hedera:testnet");
    expect(typeof payload.payload.transaction).toBe("string");
  });

  test("retries the unchanged request body with a signed payment and retains settlement evidence", async () => {
    const calls: Array<{ body: Uint8Array; headers: Headers }> = [];
    const required = { x402Version: 1, error: "X-PAYMENT header is required", accepts: [requirement] };
    const fetcher = async (_input: string, init: RequestInit): Promise<Response> => {
      calls.push({ body: new Uint8Array(await new Response(init.body).arrayBuffer()), headers: new Headers(init.headers) });
      if (calls.length === 1) {
        return Response.json(required, { status: 402, headers: { "X-PAYMENT-REQUIRED": encode(required) } });
      }
      return new Response(JSON.stringify({ id: "response_1" }), {
        status: 200,
        headers: { "content-type": "application/json", "X-PAYMENT-RESPONSE": encode({ success: true, network: "hedera-testnet", transaction: "0.0.123@1.2" }) },
      });
    };
    const client = new HederaX402Client({ signer, fetcher, maxAmount: "10" });
    const body = new TextEncoder().encode('{"model":"vision-basic","input":"same"}');

    const result = await client.request({ method: "POST", url: "https://provider.example/v1/responses", body });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toEqual(calls[1]?.body);
    expect(calls[0]?.headers.has("X-PAYMENT")).toBe(false);
    expect(calls[1]?.headers.has("X-PAYMENT")).toBe(true);
    expect(result.payment).toEqual({ network: "hedera:testnet", transactionId: "0.0.123@1.2" });
    expect(await result.response.json()).toEqual({ id: "response_1" });
  });

  test("rejects a requirement above the configured maximum before signing", async () => {
    let signed = false;
    const expensiveSigner: HederaPaymentSigner = {
      async createPaymentPayload() {
        signed = true;
        return signer.createPaymentPayload(requirement, { method: "POST", url: "https://provider.example" });
      },
    };
    const expensive = { ...requirement, maxAmountRequired: "11" };
    const client = new HederaX402Client({
      signer: expensiveSigner,
      maxAmount: "10",
      fetcher: async () => Response.json({ x402Version: 1, accepts: [expensive] }, { status: 402 }),
    });

    await expect(client.request({ method: "POST", url: "https://provider.example" })).rejects.toThrow("PAYMENT_LIMIT_EXCEEDED");
    expect(signed).toBe(false);
  });

  test("sends both standardized and Blocky402-compatible proof headers for v2", async () => {
    const v2Signer: HederaPaymentSigner = {
      async createPaymentPayload(selected): Promise<PaymentPayload> {
        return { x402Version: 2, accepted: selected, payload: { transaction: "signed-v2" } };
      },
    };
    const required = { x402Version: 2, accepts: [{ ...requirement, network: "hedera:testnet", amount: "10" }] };
    let retryHeaders = new Headers();
    const client = new HederaX402Client({
      signer: v2Signer,
      fetcher: async (_input, init) => {
        if (init.headers && new Headers(init.headers).has("PAYMENT-SIGNATURE")) {
          retryHeaders = new Headers(init.headers);
          return new Response("ok", { status: 200, headers: { "PAYMENT-RESPONSE": encode({ success: true, network: "hedera:testnet", transaction: "tx-v2" }) } });
        }
        return Response.json(required, { status: 402 });
      },
    });

    await client.request({ method: "POST", url: "https://provider.example", body: new Uint8Array([1, 2, 3]) });
    expect(retryHeaders.has("PAYMENT-SIGNATURE")).toBe(true);
    expect(retryHeaders.has("X-PAYMENT")).toBe(true);
  });

  test("fails closed when the challenge has no Hedera testnet option", async () => {
    const client = new HederaX402Client({
      signer,
      fetcher: async () => Response.json({ x402Version: 2, accepts: [{ ...requirement, network: "eip155:84532", amount: "1" }] }, { status: 402 }),
    });

    await expect(client.request({ method: "POST", url: "https://provider.example" })).rejects.toThrow("PAYMENT_NETWORK_UNSUPPORTED");
  });

  test("rejects an internal provider URL before making a payment request", async () => {
    let called = false;
    const client = new HederaX402Client({
      signer,
      fetcher: async () => {
        called = true;
        return new Response(null, { status: 500 });
      },
    });

    await expect(client.request({ method: "POST", url: "https://127.0.0.1/v1/responses" })).rejects.toThrow("PAYMENT_FAILED");
    expect(called).toBe(false);
  });
});
import {
  createFixtureHederaX402AdmissionVerifier,
  HederaX402PaymentRejectedError,
} from "./index.ts";

const NOW = "2026-09-09T03:00:00.000Z";
const REQUEST = {
  resource: "https://api.frely.cloud/a2a/tasks",
  method: "POST" as const,
  requestHash: "a".repeat(64),
};

describe("Hedera x402 admission boundary", () => {
  test("returns an opaque challenge and allowlisted scalar admission facts", async () => {
    const verifier = createFixtureHederaX402AdmissionVerifier({ now: () => NOW, expectedProof: "proof-a" });
    const challenge = await verifier.requirements(REQUEST);
    const admission = await verifier.verify({
      ...REQUEST,
      requestId: "req_a2a_1",
      idempotencyKeyHash: "b".repeat(64),
      proof: "proof-a",
    });

    expect(challenge).toMatchObject({ scheme: "exact", network: "hedera:testnet", paymentRequired: "fixture:x402:hedera-testnet:exact:v1" });
    expect(admission).toMatchObject({ payerReference: "fixture:payer", asset: "HBAR", authorizedAmount: "1", replayStatus: "fresh" });
    expect(admission.paymentReference).toMatch(/^fixture:payment:[a-f0-9]{24}$/u);
    expect(admission).not.toHaveProperty("proof");
  });

  test("marks same-correlation proof retries as replayed and rejects cross-task reuse", async () => {
    const verifier = createFixtureHederaX402AdmissionVerifier({ now: () => NOW, expectedProof: "proof-a" });
    const input = { ...REQUEST, requestId: "req_a2a_1", idempotencyKeyHash: "b".repeat(64), proof: "proof-a" };
    await expect(verifier.verify(input)).resolves.toMatchObject({ replayStatus: "fresh" });
    await expect(verifier.verify(input)).resolves.toMatchObject({ replayStatus: "replayed" });
    await expect(verifier.verify({ ...input, requestId: "req_a2a_2", idempotencyKeyHash: "c".repeat(64) })).rejects.toMatchObject({
      name: "HederaX402PaymentRejectedError",
      code: "payment_replayed",
      status: 402,
    });
  });

  test("fails invalid proof without retaining it in the rejection", async () => {
    const verifier = createFixtureHederaX402AdmissionVerifier({ now: () => NOW, expectedProof: "proof-a" });
    const error = await verifier.verify({ ...REQUEST, requestId: "req_a2a_1", idempotencyKeyHash: "b".repeat(64), proof: "wallet-signature-secret" }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(HederaX402PaymentRejectedError);
    expect(error).toMatchObject({ code: "payment_invalid", status: 402 });
    expect(String(error)).not.toContain("wallet-signature-secret");
  });

  test("rejects secret-shaped references from the verifier", async () => {
    const verifier = createFixtureHederaX402AdmissionVerifier({
      now: () => NOW,
      expectedProof: "proof-a",
      payerReference: "sk_live_not-a-payment-reference",
    });
    await expect(verifier.verify({ ...REQUEST, requestId: "req_a2a_1", idempotencyKeyHash: "b".repeat(64), proof: "proof-a" })).rejects.toThrow("A2A_PAYMENT_ADMISSION_REFERENCE_INVALID");
  });
});

describe("Live Hedera x402 admission adapter", () => {
  test("decodes the opaque proof, calls the official verifier and stores only replay-safe facts", async () => {
    const verified: Array<{ amount: string; payer: string }> = [];
    const verifier = createLiveHederaX402AdmissionVerifier({
      now: () => "2026-09-09T03:00:00.000Z",
      requirements: async () => A2A_CHALLENGE,
      facilitator: {
        verify: async (_payload, requirement) => {
          verified.push({ amount: requirement.amount, payer: "0.0.2002" });
          return { isValid: true, payer: "0.0.2002" };
        },
        settle: async () => ({ success: true, network: "hedera:testnet", transaction: "unused" }),
      },
    });

    const admission = await verifier.verify({
      ...A2A_REQUEST,
      requestId: "req_a2a_1",
      idempotencyKeyHash: "b".repeat(64),
      proof: A2A_PROOF,
    });

    expect(verified).toEqual([{ amount: "100", payer: "0.0.2002" }]);
    expect(admission).toMatchObject({
      paymentReference: expect.stringMatching(/^hedera:proof:[a-f0-9]{48}$/u),
      payerReference: "0.0.2002",
      asset: "0.0.0",
      authorizedAmount: "100",
      chargeQuote: A2A_CHALLENGE.chargeQuote,
      replayStatus: "fresh",
    });
    expect(admission).not.toHaveProperty("proof");

    await expect(verifier.verify({
      ...A2A_REQUEST,
      requestId: "req_a2a_1",
      idempotencyKeyHash: "b".repeat(64),
      proof: A2A_PROOF,
    })).resolves.toMatchObject({ replayStatus: "replayed" });
    await expect(verifier.verify({
      ...A2A_REQUEST,
      requestId: "req_a2a_2",
      idempotencyKeyHash: "c".repeat(64),
      proof: A2A_PROOF,
    })).rejects.toMatchObject({ code: "payment_replayed", status: 402 });
    expect(verified).toHaveLength(1);
  });

  test("rejects a proof whose accepted requirement does not match the payee challenge", async () => {
    const verifier = createLiveHederaX402AdmissionVerifier({
      now: () => "2026-09-09T03:00:00.000Z",
      requirements: async () => A2A_CHALLENGE,
      facilitator: {
        verify: async () => ({ isValid: true, payer: "0.0.2002" }),
        settle: async () => ({ success: true, network: "hedera:testnet", transaction: "unused" }),
      },
    });
    const error = await verifier.verify({
      ...A2A_REQUEST,
      requestId: "req_a2a_1",
      idempotencyKeyHash: "b".repeat(64),
      proof: encode({ x402Version: 2, accepted: { ...A2A_REQUIREMENT, amount: "101" }, payload: { transaction: "signed-in-memory" } }),
    }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "payment_invalid", status: 402 });
  });

  test("rejects a replay when the payee changes the bound maximum charge quote", async () => {
    let maximumChargeUnits = "100";
    const verifier = createLiveHederaX402AdmissionVerifier({
      now: () => "2026-09-09T03:00:00.000Z",
      requirements: async () => ({ ...A2A_CHALLENGE, chargeQuote: { ...A2A_CHALLENGE.chargeQuote, maximumChargeUnits } }),
      facilitator: {
        verify: async () => ({ isValid: true, payer: "0.0.2002" }),
        settle: async () => ({ success: true, network: "hedera:testnet", transaction: "unused" }),
      },
    });
    const input = { ...A2A_REQUEST, requestId: "req_a2a_1", idempotencyKeyHash: "b".repeat(64), proof: A2A_PROOF };
    await expect(verifier.verify(input)).resolves.toMatchObject({ replayStatus: "fresh", chargeQuote: { maximumChargeUnits: "100" } });
    maximumChargeUnits = "200";
    await expect(verifier.verify(input)).rejects.toMatchObject({ code: "payment_replayed", status: 402 });
  });
});

describe("Live Hedera x402 settlement adapter", () => {
  test("delegates settlement and requires an injected real release implementation", async () => {
    let releaseCalls = 0;
    const settlement = createLiveHederaX402PaymentSettlement({
      facilitator: {
        verify: async () => ({ isValid: true, payer: "0.0.2002" }),
        settle: async () => ({ success: true, network: "hedera:testnet", transaction: "0.0.3003@1.2", payer: "0.0.2002" }),
      },
      release: async (input) => {
        releaseCalls += 1;
        expect(input.paymentPayload.payload.transaction).toBe("signed-in-memory");
        return { network: "hedera:testnet", status: "released", transactionId: "0.0.3003@1.3" };
      },
    });
    const authorization = {
      paymentPayload: { x402Version: 2 as const, accepted: A2A_REQUIREMENT, payload: { transaction: "signed-in-memory" } },
      paymentRequirement: A2A_REQUIREMENT,
    };

    await expect(settlement.settle(authorization)).resolves.toMatchObject({
      status: "settled",
      transactionId: "0.0.3003@1.2",
      payer: "0.0.2002",
      authorizedAmount: "100",
    });
    await expect(settlement.release(authorization)).resolves.toMatchObject({ status: "released", transactionId: "0.0.3003@1.3" });
    expect(releaseCalls).toBe(1);
  });
});

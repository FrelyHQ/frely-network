import { describe, expect, test } from "bun:test";

import { X402Gateway, type X402ReplayStore } from "@frely-network/x402-gateway";
import type { PaymentRequired } from "@frely-network/hedera-x402";
import { createFrelyX402ResponsesHandler } from "./frely-x402-resource.ts";

const RESOURCE = "https://network.frely.cloud/x402/frely/responses";
const UPSTREAM = "https://api.frely.cloud/v1/responses";
const requirement = {
  scheme: "exact",
  network: "hedera:testnet",
  amount: "1",
  asset: "0.0.0",
  payTo: "0.0.1001",
  maxTimeoutSeconds: 60,
  extra: {},
};
const requirements: PaymentRequired = {
  x402Version: 2,
  resource: { url: RESOURCE },
  accepts: [requirement],
};
const payment = {
  x402Version: 2,
  resource: { url: RESOURCE },
  accepted: requirement,
  payload: { transaction: "signed-in-test" },
};

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function replayStore(): X402ReplayStore {
  const claimed = new Set<string>();
  return {
    claim: async (digest) => {
      if (claimed.has(digest)) return false;
      claimed.add(digest);
      return true;
    },
  };
}

function paidRequest(): Request {
  return new Request(RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "payment-signature": encode(payment),
      "payment-required": "must-not-cross",
      "x-payment": "must-not-cross",
      authorization: "Bearer untrusted-client-value",
    },
    body: JSON.stringify({ model: "vision-basic", input: "hello" }),
  });
}

describe("Network-owned Frely x402 Responses resource", () => {
  test("returns a standard challenge without calling Frely when payment is absent", async () => {
    let upstreamCalls = 0;
    const handler = handlerWith({
      fetcher: async () => {
        upstreamCalls += 1;
        return Response.json({ output: "never" });
      },
    });
    const response = await handler(new Request(RESOURCE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "vision-basic", input: "hello" }),
    }));
    expect(response.status).toBe(402);
    expect(response.headers.get("payment-required")).toBeTruthy();
    expect(upstreamCalls).toBe(0);
  });

  test("verifies, calls Frely with a clean Web2 boundary, then settles", async () => {
    let settled = 0;
    let captured: { url: string; headers: Headers; body: string } | undefined;
    const handler = handlerWith({
      settle: async () => {
        settled += 1;
        return { success: true, network: "hedera:testnet", transaction: "0.0.900@1.000000000", payer: "0.0.77" };
      },
      fetcher: async (input, init) => {
        captured = {
          url: String(input),
          headers: new Headers(init?.headers),
          body: String(init?.body ?? ""),
        };
        return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "done" }] }] }, {
          headers: { "x-request-id": "req-frely-1" },
        });
      },
    });
    const response = await handler(paidRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("payment-response")).toBeTruthy();
    expect(response.headers.get("x-request-id")).toBe("req-frely-1");
    expect(settled).toBe(1);
    expect(captured?.url).toBe(UPSTREAM);
    expect(captured?.headers.get("authorization")).toBe("Bearer frely-api-key");
    expect(captured?.headers.get("payment-signature")).toBeNull();
    expect(captured?.headers.get("payment-required")).toBeNull();
    expect(captured?.headers.get("x-payment")).toBeNull();
    expect(captured?.headers.get("x-payment-proof")).toBeNull();
    expect(JSON.parse(captured?.body ?? "{}")).toEqual({ model: "vision-basic", input: "hello" });
  });

  test("does not settle when Frely rejects the request", async () => {
    let settled = 0;
    const handler = handlerWith({
      settle: async () => {
        settled += 1;
        return { success: true, network: "hedera:testnet", transaction: "never" };
      },
      fetcher: async () => Response.json({ code: "credit_exhausted" }, { status: 402 }),
    });
    const response = await handler(paidRequest());
    expect(response.status).toBe(402);
    expect(response.headers.get("payment-response")).toBeNull();
    expect(settled).toBe(0);
  });

  test("rejects replay before a second Frely invocation", async () => {
    let upstreamCalls = 0;
    const handler = handlerWith({
      fetcher: async () => {
        upstreamCalls += 1;
        return Response.json({ ok: true });
      },
    });
    const first = await handler(paidRequest());
    expect(first.status).toBe(200);
    const replay = await handler(paidRequest());
    expect(replay.status).toBe(402);
    expect((await replay.json()) as Record<string, unknown>).toMatchObject({ error: "PAYMENT_REPLAYED" });
    expect(upstreamCalls).toBe(1);
  });
});

function handlerWith(options: {
  readonly fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  readonly settle?: (payload: never, requirement: never) => Promise<{ success: boolean; network: string; transaction?: string; payer?: string }>;
} = {}) {
  const gateway = new X402Gateway({
    network: "hedera:testnet",
    verifier: { verify: async () => ({ isValid: true, payer: "0.0.77" }) },
    settler: { settle: (options.settle ?? (async () => ({ success: true, network: "hedera:testnet", transaction: "0.0.900@1.000000000" }))) as never },
    replayStore: replayStore(),
    now: () => Date.parse("2026-09-11T10:00:00.000Z"),
  });
  return createFrelyX402ResponsesHandler({
    resourceUrl: RESOURCE,
    upstreamUrl: UPSTREAM,
    apiKey: "frely-api-key",
    requirements,
    gateway,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
}

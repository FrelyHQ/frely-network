import { describe, expect, test } from "bun:test";
import type { PaymentRequired } from "@frely-network/hedera-x402";
import type { UpfrontAdmission } from "@frely-network/x402-gateway";
import { createStaticNetworkFetch } from "./service.ts";

const resolveBody = {
  schemaVersion: 2,
  capabilities: ["vision"],
  paymentNetwork: "hedera:testnet",
};

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer network-key");
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`http://127.0.0.1:13600${path}`, { ...init, headers });
}

function service(overrides: Partial<Parameters<typeof createStaticNetworkFetch>[0]> = {}) {
  const requirements: PaymentRequired = {
    x402Version: 2,
    resource: { url: "http://127.0.0.1:13600/v1/responses" },
    accepts: [{ scheme: "exact", network: "hedera:testnet", amount: "10", asset: "0.0.123", payTo: "0.0.456" }],
  };
  return createStaticNetworkFetch({
    apiKey: "network-key",
    expectedModel: "vision-provider",
    ready: true,
    requirements,
    resolver: { resolve: async () => ({ ok: true } as never) },
    gateway: { admit: async () => ({ kind: "response", response: Response.json(requirements, { status: 402 }) }) },
    upstream: { invoke: async () => Response.json({ ok: true }) },
    ...overrides,
  });
}

describe("static Network HTTP service", () => {
  test("separates liveness and local readiness", async () => {
    expect((await service({ ready: false })(new Request("http://127.0.0.1:13600/healthz"))).status).toBe(200);
    expect((await service({ ready: false })(new Request("http://127.0.0.1:13600/readyz"))).status).toBe(503);
  });

  test("returns 404, 405, 415 and 413 at the HTTP boundary", async () => {
    expect((await service()(new Request("http://127.0.0.1:13600/missing"))).status).toBe(404);
    expect((await service()(request("/v1/capabilities/resolve", { method: "GET" }))).status).toBe(405);
    expect((await service()(request("/v1/capabilities/resolve", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } }))).status).toBe(415);
    expect((await service()(request("/v1/capabilities/resolve", { method: "POST", body: "x".repeat(64 * 1024 + 1) }))).status).toBe(413);
  });

  test("requires an exact Bearer value before resolving", async () => {
    let calls = 0;
    const fetch = service({ resolver: { resolve: async () => { calls += 1; return { ok: true } as never; } } });
    const response = await fetch(new Request("http://127.0.0.1:13600/v1/capabilities/resolve", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify(resolveBody),
    }));
    expect(response.status).toBe(401);
    expect(calls).toBe(0);
  });

  test("parses and resolves the exact static request", async () => {
    let captured: unknown;
    const response = await service({ resolver: { resolve: async (input) => { captured = input; return { ok: true } as never; } } })(request(
      "/v1/capabilities/resolve",
      { method: "POST", body: JSON.stringify(resolveBody) },
    ));
    expect(response.status).toBe(200);
    expect(captured).toEqual(resolveBody);
  });

  test("does not call Relay when admission returns a challenge or rejection", async () => {
    let upstreamCalls = 0;
    const response = await service({
      gateway: { admit: async () => ({ kind: "response", response: Response.json({ code: "PAYMENT_REJECTED" }, { status: 402 }) }) },
      upstream: { invoke: async () => { upstreamCalls += 1; return Response.json({ ok: true }); } },
    })(request("/v1/responses", {
      method: "POST",
      headers: { "x-frely-request-id": "req-1" },
      body: JSON.stringify({ model: "vision-provider", stream: false, input: [] }),
    }));
    expect(response.status).toBe(402);
    expect(upstreamCalls).toBe(0);
  });

  test("calls Relay only after settlement and preserves settlement evidence on Relay failure", async () => {
    const calls: string[] = [];
    const settled: UpfrontAdmission = {
      kind: "settled",
      settlement: { success: true, network: "hedera:testnet", transaction: "tx-1" },
      finish: async (response) => {
        calls.push("finish");
        const headers = new Headers(response.headers);
        headers.set("PAYMENT-RESPONSE", "settled-evidence");
        return new Response(response.body, { status: response.status, headers });
      },
    };
    const response = await service({
      gateway: { admit: async () => { calls.push("settle"); return settled; } },
      upstream: { invoke: async () => { calls.push("relay"); throw new Error("UPSTREAM_FAILED"); } },
    })(request("/v1/responses", {
      method: "POST",
      headers: { "x-frely-request-id": "req-1" },
      body: JSON.stringify({ model: "vision-provider", stream: false, input: [] }),
    }));
    expect(calls).toEqual(["settle", "relay", "finish"]);
    expect(response.status).toBe(502);
    expect(response.headers.get("PAYMENT-RESPONSE")).toBe("settled-evidence");
    expect(await response.json()).toEqual({ code: "UPSTREAM_FAILED" });
  });
});

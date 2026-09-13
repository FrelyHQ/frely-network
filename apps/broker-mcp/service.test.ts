import { describe, expect, test } from "bun:test";

import { brokerMcpFetch, createBrokerMcpFetch } from "./service.ts";

describe("Broker MCP deployment boundary", () => {
  test("reports process health without claiming Broker readiness", async () => {
    const health = await brokerMcpFetch(new Request("http://service/healthz"));
    const readiness = await brokerMcpFetch(new Request("http://service/readyz"));

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ service: "frely-network-broker-mcp", status: "ok" });
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({
      service: "frely-network-broker-mcp",
      status: "not_ready",
      code: "BROKER_NOT_READY",
    });
  });

  test("fails closed at the MCP boundary", async () => {
    const response = await brokerMcpFetch(new Request("http://service/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "use_capability", arguments: { capabilities: ["vision"], task: "run" } } }),
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32004, message: "BROKER_NOT_READY" },
    });
  });

  test("exposes only the Broker tools and keeps primitives behind the boundary", async () => {
    const fetcher = createBrokerMcpFetch({
      ready: true,
      broker: {
        findCapability: async (capabilities) => [{ id: "provider-1", capabilities, protocol: "responses", verified: true }],
        useCapability: async (request) => ({ provider: { id: "provider-1", capabilities: request.capabilities, protocol: "responses" }, payment: { network: "hedera:testnet" }, output: { ok: true }, correlationId: "corr-1" }),
      },
    });
    const initialize = await fetcher(new Request("http://service/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    }));
    expect(initialize.status).toBe(200);
    expect((await initialize.json())).toMatchObject({ result: { capabilities: { tools: {} } } });

    const list = await fetcher(new Request("http://service/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }));
    const listBody = await list.json() as { result: { tools: Array<{ name: string }> } };
    expect(listBody.result.tools.map((tool) => tool.name)).toEqual(["find_capability", "use_capability"]);
  });

  test("routes the Network-owned paid Frely resources and fails closed when unconfigured", async () => {
    let responsesCalled = 0;
    let a2aCalled = 0;
    const configured = createBrokerMcpFetch({
      x402Responses: async (request) => {
        responsesCalled += 1;
        expect(new URL(request.url).pathname).toBe("/x402/frely/responses");
        return Response.json({ ok: true });
      },
      x402A2A: async (request) => {
        a2aCalled += 1;
        expect(new URL(request.url).pathname).toBe("/x402/frely/a2a");
        return Response.json({ ok: true });
      },
    });
    const paidResponses = await configured(new Request("https://network.frely.cloud/x402/frely/responses", { method: "POST" }));
    expect(paidResponses.status).toBe(200);
    const paidA2A = await configured(new Request("https://network.frely.cloud/x402/frely/a2a", { method: "POST" }));
    expect(paidA2A.status).toBe(200);
    expect(responsesCalled).toBe(1);
    expect(a2aCalled).toBe(1);

    const unconfigured = createBrokerMcpFetch({});
    for (const path of ["/x402/frely/responses", "/x402/frely/a2a"]) {
      const unavailable = await unconfigured(new Request(`https://network.frely.cloud${path}`, { method: "POST" }));
      expect(unavailable.status).toBe(503);
      expect(await unavailable.json()).toEqual({ code: "X402_RESOURCE_NOT_CONFIGURED" });
    }
  });

  test("does not require the optional Web3 resource for production readiness", async () => {
    const runtime = {
      ready: true,
      broker: {
        findCapability: async () => [],
        useCapability: async () => ({ ok: true }),
      },
    };
    const missing = createBrokerMcpFetch(runtime, { requireX402Responses: false });
    const unavailable = await missing(new Request("http://service/readyz"));
    expect(unavailable.status).toBe(200);

    const configured = createBrokerMcpFetch(runtime, {
      requireX402Responses: false,
      x402Responses: async () => Response.json({ ok: true }),
    });
    const ready = await configured(new Request("http://service/readyz"));
    expect(ready.status).toBe(200);
  });

  test("does not expose the retired Relay admission endpoints", async () => {
    const fetcher = createBrokerMcpFetch({});
    const response = await fetcher(new Request("https://network.frely.cloud/a2a/payment/verify", { method: "POST" }));
    expect(response.status).toBe(404);
  });
});

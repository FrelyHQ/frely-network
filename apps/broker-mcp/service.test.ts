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

  test("routes the Network-owned paid Frely resource and fails closed when unconfigured", async () => {
    let called = 0;
    const configured = createBrokerMcpFetch({
      x402Responses: async (request) => {
        called += 1;
        expect(new URL(request.url).pathname).toBe("/x402/frely/responses");
        return Response.json({ ok: true });
      },
    });
    const paidResource = await configured(new Request("https://network.frely.cloud/x402/frely/responses", { method: "POST" }));
    expect(paidResource.status).toBe(200);
    expect(called).toBe(1);

    const unconfigured = createBrokerMcpFetch({});
    const unavailable = await unconfigured(new Request("https://network.frely.cloud/x402/frely/responses", { method: "POST" }));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ code: "X402_RESOURCE_NOT_CONFIGURED" });
  });

  test("requires the paid resource for production readiness", async () => {
    const runtime = {
      ready: true,
      broker: {
        findCapability: async () => [],
        useCapability: async () => ({ ok: true }),
      },
    };
    const missing = createBrokerMcpFetch(runtime, { requireX402Responses: true });
    const unavailable = await missing(new Request("http://service/readyz"));
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "X402_RESOURCE_NOT_CONFIGURED" });

    const configured = createBrokerMcpFetch(runtime, {
      requireX402Responses: true,
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

import { describe, expect, test } from "bun:test";

import { brokerMcpFetch, createBrokerMcpFetch } from "./service.ts";
import { createFixtureHederaX402AdmissionVerifier } from "../../packages/payment/hedera-x402/index.ts";
import { createX402PaymentAdmissionHandler } from "../../packages/gateway/x402/index.ts";

describe("Broker MCP deployment boundary", () => {
  test("reports process health without claiming Broker readiness", async () => {
    const health = await brokerMcpFetch(new Request("http://service/healthz"));
    const readiness = await brokerMcpFetch(new Request("http://service/readyz"));

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      service: "frely-network-broker-mcp",
      status: "ok",
    });
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
      error: {
        code: -32004,
        message: "BROKER_NOT_READY",
      },
    });
  });

  test("exposes only the Broker tools and keeps discovery/payment primitives behind the boundary", async () => {
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

    const call = await fetcher(new Request("http://service/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "use_capability", arguments: { capabilities: ["vision"], task: "describe" } } }),
    }));
    expect(call.status).toBe(200);
    expect(await call.json()).toMatchObject({ result: { structuredContent: { payment: { network: "hedera:testnet" } } } });
  });

  test("only composes a configured payment admission handler into the Broker process", async () => {
    const fetch = createBrokerMcpFetch({
      paymentAdmission: createX402PaymentAdmissionHandler({
        verifier: createFixtureHederaX402AdmissionVerifier({ now: () => "2026-09-09T03:00:00.000Z" }),
        apiKey: "relay-secret",
      }),
    });
    const response = await fetch(new Request("https://network.example/a2a/payment/requirements", {
      method: "POST",
      headers: { authorization: "Bearer relay-secret", "content-type": "application/json" },
      body: JSON.stringify({ resource: "https://api.frely.cloud/a2a/tasks", method: "POST", requestHash: "a".repeat(64) }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ payment: { network: "hedera:testnet", scheme: "exact" } });
  });
});

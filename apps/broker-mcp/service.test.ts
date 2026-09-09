import { describe, expect, test } from "bun:test";

import { brokerMcpFetch } from "./service.ts";
import { createFixtureHederaX402AdmissionVerifier } from "../../packages/payment/hedera-x402/index.ts";
import { createX402PaymentAdmissionHandler } from "../../packages/gateway/x402/index.ts";
import { createBrokerMcpFetch } from "./service.ts";

describe("Broker MCP deployment boundary", () => {
  test("reports process health without claiming Broker readiness", async () => {
    const health = brokerMcpFetch(new Request("http://service/healthz"));
    const readiness = brokerMcpFetch(new Request("http://service/readyz"));

    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      service: "frely-network-broker-mcp",
      status: "ok",
    });
    expect(readiness.status).toBe(503);
    expect(await readiness.json()).toEqual({
      service: "frely-network-broker-mcp",
      status: "not_ready",
      code: "BROKER_EXECUTION_NOT_IMPLEMENTED",
    });
  });

  test("fails closed at the MCP boundary", async () => {
    const response = brokerMcpFetch(new Request("http://service/mcp", {
      method: "POST",
      body: "{}",
    }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32004,
        message: "BROKER_EXECUTION_NOT_IMPLEMENTED",
      },
    });
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

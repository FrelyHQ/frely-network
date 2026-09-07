import { describe, expect, test } from "bun:test";

import { brokerMcpFetch } from "./service.ts";

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
});

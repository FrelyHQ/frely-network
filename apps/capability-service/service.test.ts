import { expect, test } from "bun:test";
import success from "../../packages/protocol/capability-resolution/fixtures/success.json";
import { parseResolvedCapability } from "@frely-network/capability-resolution";
import { createCapabilityServiceFetch } from "./service.ts";

test("exposes resolve only after bearer authentication", async () => {
  const fetcher = createCapabilityServiceFetch({
    apiKey: "network-secret",
    resolver: { resolve: async () => parseResolvedCapability(success) },
  });
  const denied = await fetcher(new Request("https://network.example/v1/capabilities/resolve", { method: "POST" }));
  expect(denied.status).toBe(401);
  const response = await fetcher(new Request("https://network.example/v1/capabilities/resolve", {
    method: "POST",
    headers: { authorization: "Bearer network-secret", "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 1, capabilities: ["vision"], paymentNetwork: "hedera:testnet" }),
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(success);
  expect((await fetcher(new Request("https://network.example/mcp", { method: "POST" }))).status).toBe(404);
});

test("permits only health, readiness, and authenticated resolve routes without caching", async () => {
  const fetcher = createCapabilityServiceFetch({
    apiKey: "network-secret",
    resolver: { resolve: async () => parseResolvedCapability(success) },
  });

  for (const request of [
    new Request("https://network.example/healthz"),
    new Request("https://network.example/readyz"),
  ]) {
    const response = await fetcher(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }

  const response = await fetcher(new Request("https://network.example/v1/capabilities/resolve"));
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("rejects non-JSON, malformed, invalid, and oversized resolve requests", async () => {
  const fetcher = createCapabilityServiceFetch({
    apiKey: "network-secret",
    resolver: { resolve: async () => parseResolvedCapability(success) },
  });
  const headers = { authorization: "Bearer network-secret", "content-type": "application/json" };
  const requests = [
    new Request("https://network.example/v1/capabilities/resolve", { method: "POST", headers: { authorization: headers.authorization, "content-type": "text/plain" }, body: "nope" }),
    new Request("https://network.example/v1/capabilities/resolve", { method: "POST", headers, body: "{" }),
    new Request("https://network.example/v1/capabilities/resolve", { method: "POST", headers, body: JSON.stringify({ schemaVersion: 1, capabilities: [], paymentNetwork: "hedera:testnet" }) }),
    new Request("https://network.example/v1/capabilities/resolve", { method: "POST", headers, body: JSON.stringify({ schemaVersion: 1, capabilities: ["x".repeat(65 * 1024)], paymentNetwork: "hedera:testnet" }) }),
  ];

  for (const request of requests) {
    const response = await fetcher(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});

test("maps resolver failures to public error codes without leaking details", async () => {
  const headers = { authorization: "Bearer network-secret", "content-type": "application/json" };
  const request = () => new Request("https://network.example/v1/capabilities/resolve", {
    method: "POST",
    headers,
    body: JSON.stringify({ schemaVersion: 1, capabilities: ["vision"], paymentNetwork: "hedera:testnet" }),
  });

  for (const [message, status, code] of [
    ["NO_PROVIDER", 404, "NO_PROVIDER"],
    ["GRAPH_QUERY_FAILED", 502, "NETWORK_DISCOVERY_FAILED"],
    ["IDENTITY_VERIFICATION_FAILED", 502, "IDENTITY_VERIFICATION_FAILED"],
    ["CAPABILITY_NOT_SUPPORTED", 422, "CAPABILITY_NOT_SUPPORTED"],
    ["https://graph.example?apiKey=network-secret", 500, "INTERNAL_ERROR"],
  ] as const) {
    const fetcher = createCapabilityServiceFetch({
      apiKey: "network-secret",
      resolver: { resolve: async () => { throw new Error(message); } },
    });
    const response = await fetcher(request());
    expect(response.status).toBe(status);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ code });
    expect(response.headers.get("cache-control")).toBe("no-store");
    if (code === "INTERNAL_ERROR") expect(body).not.toContain(message);
  }
});

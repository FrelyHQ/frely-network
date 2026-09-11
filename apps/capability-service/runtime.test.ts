import { expect, test } from "bun:test";
import { createCapabilityServiceRuntime } from "./runtime.ts";

const environment = {
  GRAPH_ENDPOINT: "https://graph.example/query",
  ENS_SEPOLIA_RPC_URL: "https://rpc.example",
  ERC8004_IDENTITY_REGISTRY: "0x1111111111111111111111111111111111111111",
  FRELY_SERVICE_API_KEY: "network-secret",
  FRELY_ALLOWED_RELAY_ORIGIN: "https://relay.example",
};

test("composes the Network service with local defaults and a public Relay origin", async () => {
  const runtime = createCapabilityServiceRuntime(environment);
  expect(runtime.host).toBe("127.0.0.1");
  expect(runtime.port).toBe("4100");
  expect((await runtime.fetch(new Request("https://network.example/healthz"))).status).toBe(200);
});

test("rejects Relay origins that are not credential-free public HTTPS origins", () => {
  for (const origin of [
    "http://relay.example",
    "https://user:pass@relay.example",
    "https://relay.example/v1/responses",
    "https://relay.example?token=secret",
    "https://localhost",
    "https://127.0.0.1",
  ]) {
    expect(() => createCapabilityServiceRuntime({ ...environment, FRELY_ALLOWED_RELAY_ORIGIN: origin })).toThrow("RELAY_ORIGIN_INVALID");
  }
});

import { expect, test } from "bun:test";
import { createCapabilityServiceRuntime } from "./runtime.ts";

const environment = {
  FRELY_NETWORK_MODE: "static-local",
  FRELY_STATIC_PROVIDER_ID: "frely-vision-basic",
  FRELY_STATIC_PROVIDER_ENDPOINT: "https://api.frely.cloud/v1/responses",
  FRELY_NETWORK_EXECUTION_URL: "http://127.0.0.1:13600/v1/responses",
  FRELY_SERVICE_API_KEY: "network-secret",
};

test("composes the loopback static Network without Graph or RPC config", async () => {
  const runtime = createCapabilityServiceRuntime(environment);
  expect(runtime.host).toBe("127.0.0.1");
  expect(runtime.port).toBe("13600");
  expect((await runtime.fetch(new Request("http://127.0.0.1:13600/healthz"))).status).toBe(200);
  expect((await runtime.fetch(new Request("http://127.0.0.1:13600/readyz"))).status).toBe(200);

  const resolved = await runtime.fetch(new Request("http://127.0.0.1:13600/v1/capabilities/resolve", {
    method: "POST",
    headers: { authorization: "Bearer network-secret", "content-type": "application/json" },
    body: JSON.stringify({ schemaVersion: 2, capabilities: ["vision"], paymentNetwork: "hedera:testnet" }),
  }));
  expect(resolved.status).toBe(200);
  expect(await resolved.json()).toMatchObject({
    schemaVersion: 2,
    provider: { id: "frely-vision-basic", endpoint: "https://api.frely.cloud/v1/responses" },
    execution: { endpoint: "http://127.0.0.1:13600/v1/responses", managedBy: "network" },
    resolution: { source: "static_allowlist", identityVerified: false },
  });
});

test("rejects non-loopback listeners and drifted static provider config before serving", () => {
  expect(() => createCapabilityServiceRuntime({ ...environment, HOST: "0.0.0.0" }))
    .toThrow("SERVICE_CONFIG_INVALID");
  expect(() => createCapabilityServiceRuntime({ ...environment, PORT: "13601" }))
    .toThrow("SERVICE_CONFIG_INVALID");
  expect(() => createCapabilityServiceRuntime({ ...environment, FRELY_NETWORK_MODE: "graph" }))
    .toThrow("SERVICE_CONFIG_INVALID");
  expect(() => createCapabilityServiceRuntime({ ...environment, FRELY_STATIC_PROVIDER_ID: "other" }))
    .toThrow("STATIC_PROVIDER_NOT_CONFIGURED");
  expect(() => createCapabilityServiceRuntime({
    ...environment,
    FRELY_STATIC_PROVIDER_ENDPOINT: "https://other.example/v1/responses",
  })).toThrow("STATIC_PROVIDER_NOT_CONFIGURED");
  expect(() => createCapabilityServiceRuntime({
    ...environment,
    FRELY_NETWORK_EXECUTION_URL: "http://127.0.0.1:13601/v1/responses",
  })).toThrow("STATIC_PROVIDER_NOT_CONFIGURED");
});

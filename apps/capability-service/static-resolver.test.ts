import { expect, test } from "bun:test";
import { createStaticCapabilityResolver } from "./static-resolver.ts";

const resolver = createStaticCapabilityResolver({
  providerId: "frely-vision-basic",
  endpoint: "https://api.frely.cloud/v1/responses",
  executionEndpoint: "http://127.0.0.1:13600/v1/responses",
});

test("returns the one static vision provider without identity fields", async () => {
  const result = await resolver.resolve({
    schemaVersion: 2,
    capabilities: ["vision"],
    paymentNetwork: "hedera:testnet",
  });
  expect(result.resolution).toEqual({
    source: "static_allowlist",
    identityVerified: false,
  });
  expect(JSON.stringify(result)).not.toMatch(/ensName|registry|chainId/);
});

test("rejects missing or drifted static provider configuration", () => {
  const valid = {
    providerId: "frely-vision-basic",
    endpoint: "https://api.frely.cloud/v1/responses",
    executionEndpoint: "http://127.0.0.1:13600/v1/responses",
  };

  for (const change of [
    { providerId: "other" },
    { providerId: "" },
    { endpoint: "https://other.example/v1/responses" },
    { endpoint: "" },
    { executionEndpoint: "http://127.0.0.1:13601/v1/responses" },
    { executionEndpoint: "http://localhost:13600/v1/responses" },
    { executionEndpoint: "" },
  ]) {
    expect(() => createStaticCapabilityResolver({ ...valid, ...change }))
      .toThrow("STATIC_PROVIDER_NOT_CONFIGURED");
  }
});

test("rejects unsupported resolve requests without Graph or RPC dependencies", async () => {
  for (const request of [
    { schemaVersion: 1, capabilities: ["vision"], paymentNetwork: "hedera:testnet" },
    { schemaVersion: 2, capabilities: ["ocr"], paymentNetwork: "hedera:testnet" },
    { schemaVersion: 2, capabilities: ["vision", "ocr"], paymentNetwork: "hedera:testnet" },
    { schemaVersion: 2, capabilities: ["vision"], paymentNetwork: "hedera:mainnet" },
  ]) {
    await expect(resolver.resolve(request as never)).rejects.toThrow(/CAPABILITY_NOT_SUPPORTED|INVALID_REQUEST/);
  }
});

import { expect, test } from "bun:test";
import success from "./fixtures/success.json";
import {
  parseResolveCapabilitiesRequest,
  parseResolvedCapability,
} from "./index.ts";

test("accepts the frozen resolve v1 pair", () => {
  expect(
    parseResolveCapabilitiesRequest({
      schemaVersion: 1,
      capabilities: ["vision"],
      paymentNetwork: "hedera:testnet",
    }).capabilities,
  ).toEqual(["vision"]);
  expect(parseResolvedCapability(success).provider.protocol).toBe("responses");
});

test("rejects executable but unverified or unsafe responses", () => {
  for (const change of [
    { identity: { ...success.identity, verified: false } },
    {
      provider: {
        ...success.provider,
        endpoint: "http://127.0.0.1/v1/responses",
      },
    },
    { provider: { ...success.provider, protocol: "mcp" } },
    { payment: { ...success.payment, network: "hedera:mainnet" } },
  ]) {
    expect(() => parseResolvedCapability({ ...success, ...change })).toThrow(
      "INVALID_RESPONSE",
    );
  }
});

test("rejects malformed resolve requests", () => {
  for (const request of [
    {
      schemaVersion: 1,
      capabilities: ["vision"],
      paymentNetwork: "hedera:testnet",
      extra: true,
    },
    { schemaVersion: 1, capabilities: [], paymentNetwork: "hedera:testnet" },
    { schemaVersion: 1, capabilities: ["  "], paymentNetwork: "hedera:testnet" },
    {
      schemaVersion: 1,
      capabilities: ["vision", "vision"],
      paymentNetwork: "hedera:testnet",
    },
    { schemaVersion: 1, capabilities: ["vision"], paymentNetwork: "hedera:mainnet" },
  ]) {
    expect(() => parseResolveCapabilitiesRequest(request)).toThrow("INVALID_REQUEST");
  }
});

test("rejects responses outside the frozen safe boundary", () => {
  const unsafeEndpoints = [
    "http://provider.example/v1/responses",
    "https://user:pass@provider.example/v1/responses",
    "https://provider.example/v1/responses?token=secret",
    "https://provider.example/v1/responses#fragment",
    "https://localhost/v1/responses",
    "https://provider.local/v1/responses",
    "https://127.0.0.1/v1/responses",
    "https://169.254.169.254/v1/responses",
    "https://10.0.0.1/v1/responses",
    "https://172.16.0.1/v1/responses",
    "https://192.168.0.1/v1/responses",
    "https://[::1]/v1/responses",
    "https://[fe80::1]/v1/responses",
  ];

  for (const value of [
    { ...success, extra: true },
    { ...success, requestedCapabilities: [] },
    { ...success, provider: { ...success.provider, extra: true } },
    { ...success, identity: { ...success.identity, registry: "0x0000000000000000000000000000000000000000" } },
    { ...success, payment: { ...success.payment, supportsX402: false } },
    ...unsafeEndpoints.map((endpoint) => ({
      ...success,
      provider: { ...success.provider, endpoint },
    })),
  ]) {
    expect(() => parseResolvedCapability(value)).toThrow("INVALID_RESPONSE");
  }
});

test("rejects local endpoints with FQDN trailing dots", () => {
  for (const endpoint of [
    "https://localhost./v1/responses",
    "https://LOCALHOST./v1/responses",
    "https://provider.local./v1/responses",
  ]) {
    expect(() =>
      parseResolvedCapability({
        ...success,
        provider: { ...success.provider, endpoint },
      }),
    ).toThrow("INVALID_RESPONSE");
  }
});

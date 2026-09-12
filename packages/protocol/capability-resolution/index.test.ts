import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import {
  parseStaticResolveRequest,
  parseStaticResolveResult,
} from "./index.ts";

const readFixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"),
  ) as unknown;

const noProvider = readFixture("no-provider.json");
const validResult = readFixture("static-success-v2.json") as {
  schemaVersion: 2;
  requestedCapabilities: ["vision"];
  provider: {
    id: string;
    endpoint: string;
    protocol: "responses";
    extra?: boolean;
  };
  execution: {
    endpoint: string;
    managedBy: "network";
  };
  resolution: {
    source: "static_allowlist";
    identityVerified: boolean;
  };
  payment: {
    supportsX402: boolean;
    network: "hedera:testnet";
    resource: string;
  };
};

test("accepts a configurable static resolve v2 pair", () => {
  expect(
    parseStaticResolveRequest({
      schemaVersion: 2,
      capabilities: ["vision"],
      paymentNetwork: "hedera:testnet",
    }).capabilities,
  ).toEqual(["vision"]);

  const parsed = parseStaticResolveResult(validResult);
  expect(parsed.provider.id).toBe("example-vision");
  expect(parsed.provider.endpoint).toBe(
    "https://relay.example.com/v1/responses",
  );
  expect(parsed.execution.endpoint).toBe(parsed.payment.resource);
  expect(parsed.resolution).toEqual({
    source: "static_allowlist",
    identityVerified: false,
  });
});

test("never upgrades a static allowlist to verified identity", () => {
  const value = structuredClone(validResult);
  value.resolution.identityVerified = true;
  expect(() => parseStaticResolveResult(value)).toThrow("INVALID_RESPONSE");
});

test("rejects malformed static resolve requests", () => {
  for (const request of [
    {
      schemaVersion: 2,
      capabilities: ["vision"],
      paymentNetwork: "hedera:testnet",
      extra: true,
    },
    { schemaVersion: 1, capabilities: ["vision"], paymentNetwork: "hedera:testnet" },
    { schemaVersion: 2, capabilities: [], paymentNetwork: "hedera:testnet" },
    { schemaVersion: 2, capabilities: ["vision", "ocr"], paymentNetwork: "hedera:testnet" },
    {
      schemaVersion: 2,
      capabilities: ["vision", "vision"],
      paymentNetwork: "hedera:testnet",
    },
    { schemaVersion: 2, capabilities: ["ocr"], paymentNetwork: "hedera:testnet" },
    { schemaVersion: 2, capabilities: ["vision"], paymentNetwork: "hedera:mainnet" },
  ]) {
    expect(() => parseStaticResolveRequest(request)).toThrow("INVALID_REQUEST");
  }
});

test("rejects extra capabilities and extra fields in static v2 results", () => {
  for (const value of [
    { ...validResult, extra: true },
    { ...validResult, requestedCapabilities: ["vision", "ocr"] },
    { ...validResult, requestedCapabilities: ["vision", "vision"] },
    { ...validResult, provider: { ...validResult.provider, extra: true } },
    { ...validResult, payment: { ...validResult.payment, supportsX402: false } },
    noProvider,
  ]) {
    expect(() => parseStaticResolveResult(value)).toThrow("INVALID_RESPONSE");
  }
});

test("rejects execution and resource drift", () => {
  expect(() =>
    parseStaticResolveResult({
      ...validResult,
      execution: {
        ...validResult.execution,
        endpoint: "http://127.0.0.1:18766/v1/responses",
      },
    }),
  ).toThrow("INVALID_RESPONSE");
});

test("rejects non-loopback or implicit-port execution endpoints", () => {
  const unsafeExecution = [
    "http://127.0.0.1/v1/responses",
    "http://127.0.0.1:0/v1/responses",
    "http://localhost:18765/v1/responses",
    "http://0.0.0.0:18765/v1/responses",
    "http://10.0.0.1:18765/v1/responses",
    "https://127.0.0.1:18765/v1/responses",
    "http://127.0.0.1:18765/v1/responses?token=secret",
    "http://127.0.0.1:18765/v1/responses#fragment",
    "http://user:pass@127.0.0.1:18765/v1/responses",
    "http://127.0.0.1:18765/v1/other",
    "http://[::1]:18765/v1/responses",
  ];

  for (const endpoint of unsafeExecution) {
    expect(() =>
      parseStaticResolveResult({
        ...validResult,
        execution: { ...validResult.execution, endpoint },
        payment: { ...validResult.payment, resource: endpoint },
      }),
    ).toThrow("INVALID_RESPONSE");
  }
});

test("rejects non-public HTTPS provider endpoints", () => {
  const unsafeEndpoints = [
    "http://relay.example.com/v1/responses",
    "https://user:pass@relay.example.com/v1/responses",
    "https://relay.example.com/v1/responses?token=secret",
    "https://relay.example.com/v1/responses#fragment",
    "https://localhost/v1/responses",
    "https://relay.local/v1/responses",
    "https://127.0.0.1/v1/responses",
    "https://169.254.169.254/v1/responses",
    "https://10.0.0.1/v1/responses",
    "https://172.16.0.1/v1/responses",
    "https://192.168.0.1/v1/responses",
    "https://[::1]/v1/responses",
    "https://[fe80::1]/v1/responses",
    "https://relay.example.com/v1/other",
    "https://localhost./v1/responses",
    "https://relay.local./v1/responses",
  ];

  for (const endpoint of unsafeEndpoints) {
    expect(() =>
      parseStaticResolveResult({
        ...validResult,
        provider: { ...validResult.provider, endpoint },
      }),
    ).toThrow("INVALID_RESPONSE");
  }
});

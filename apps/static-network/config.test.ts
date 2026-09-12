import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseStaticNetworkConfig, resolveEnvReference, type StaticNetworkConfig } from "./config.ts";

function validConfig(): StaticNetworkConfig {
  return {
    listen: { hostname: "127.0.0.1", port: 13600 },
    provider: {
      id: "vision-provider",
      relayUrl: "https://relay.example.com/v1/responses",
    },
    auth: {
      apiKeyRef: "env:FRELY_NETWORK_API_KEY",
      relayKeyRef: "env:FRELY_RELAY_API_KEY",
    },
    payment: {
      network: "hedera:testnet",
      resourceUrl: "http://127.0.0.1:13600/v1/responses",
      asset: "0.0.123",
      amountAtomic: "10",
      payTo: "0.0.456",
      feePayer: "0.0.789",
      facilitatorUrl: "https://facilitator.example.com/",
      attemptStorePath: join(process.cwd(), ".local", "attempts"),
    },
  };
}

describe("static Network config", () => {
  test("accepts explicit loopback, Relay, payment and env-reference configuration", () => {
    expect(parseStaticNetworkConfig(validConfig())).toEqual(validConfig());
  });

  test("rejects non-loopback or resource drift", () => {
    expect(() => parseStaticNetworkConfig({
      ...validConfig(),
      listen: { hostname: "0.0.0.0", port: 13600 },
    })).toThrow("STATIC_NETWORK_CONFIG_INVALID");
    expect(() => parseStaticNetworkConfig({
      ...validConfig(),
      payment: { ...validConfig().payment, resourceUrl: "http://127.0.0.1:13601/v1/responses" },
    })).toThrow("STATIC_NETWORK_CONFIG_INVALID");
  });

  test("rejects unsafe Relay URLs, inline secrets, incomplete payment and bad store paths", () => {
    for (const value of [
      { ...validConfig(), provider: { id: "vision-provider", relayUrl: "http://relay.example.com/v1/responses" } },
      { ...validConfig(), provider: { id: "vision-provider", relayUrl: "https://relay.example.com/other" } },
      { ...validConfig(), auth: { ...validConfig().auth, apiKeyRef: "raw-secret" } },
      { ...validConfig(), payment: { ...validConfig().payment, amountAtomic: "" } },
      { ...validConfig(), payment: { ...validConfig().payment, attemptStorePath: "/tmp/bad\0path" } },
      { ...validConfig(), payment: { ...validConfig().payment, attemptStorePath: "/dev/null/attempts" } },
    ]) {
      expect(() => parseStaticNetworkConfig(value)).toThrow("STATIC_NETWORK_CONFIG_INVALID");
    }
  });

  test("resolves only named environment references without echoing their value", () => {
    expect(resolveEnvReference("env:FRELY_NETWORK_API_KEY", { FRELY_NETWORK_API_KEY: "secret" })).toBe("secret");
    expect(() => resolveEnvReference("env:MISSING", {})).toThrow("STATIC_NETWORK_SECRET_UNAVAILABLE");
    expect(() => resolveEnvReference("secret" as `env:${string}`, {})).toThrow("STATIC_NETWORK_SECRET_UNAVAILABLE");
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { loadFrelyMcpConfig, parseFrelyMcpConfig, resolveEnvReference, type FrelyMcpConfig } from "./config.ts";

function baseConfig(): Omit<FrelyMcpConfig, "payment"> {
  return {
    schemaVersion: 2,
    network: { baseUrl: "http://127.0.0.1:18765", apiKeyRef: "env:FRELY_NETWORK_API_KEY" },
    approvedProvider: { id: "example-vision", relayUrl: "https://relay.example.com/v1/responses" },
    approvedExecution: { resourceUrl: "http://127.0.0.1:18765/v1/responses" },
  };
}

function payment(directory: string) {
  return {
    livePaymentEnabled: true,
    network: "hedera:testnet",
    asset: "0.0.123",
    amountAtomic: "10",
    payTo: "0.0.456",
    feePayer: "0.0.789",
    facilitatorUrl: "https://facilitator.example.com/",
    payerAccountId: "0.0.111",
    maxTimeoutSeconds: 60,
    walletDirectory: join(directory, "wallet"),
    journalPath: join(directory, "journal.sqlite"),
  };
}

describe("frely-mcp config", () => {
  test("allows discovery-only config and defaults live payment to false", () => {
    expect(parseFrelyMcpConfig(baseConfig())).toEqual({ ...baseConfig(), payment: undefined });
    expect(parseFrelyMcpConfig({ ...baseConfig(), payment: { ...payment(process.cwd()), livePaymentEnabled: undefined } }).payment?.livePaymentEnabled).toBeFalse();
  });

  test("accepts a complete explicitly enabled payment profile", () => {
    expect(parseFrelyMcpConfig({ ...baseConfig(), payment: payment(process.cwd()) }).payment?.payerAccountId).toBe("0.0.111");
  });

  test("rejects non-loopback Network, authorization drift, inline secrets and partial payment", () => {
    for (const value of [
      { ...baseConfig(), network: { ...baseConfig().network, baseUrl: "https://network.example.com" } },
      { ...baseConfig(), approvedExecution: { resourceUrl: "http://127.0.0.1:18766/v1/responses" } },
      { ...baseConfig(), network: { ...baseConfig().network, apiKeyRef: "inline-secret" } },
      { ...baseConfig(), payment: { livePaymentEnabled: true } },
      { ...baseConfig(), approvedProvider: { id: "example-vision", relayUrl: "http://relay.example.com/v1/responses" } },
    ]) expect(() => parseFrelyMcpConfig(value)).toThrow("CONFIG_INVALID");
  });

  test("loads a bounded absolute config file and resolves named env references", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frely-mcp-config-"));
    try {
      const path = join(directory, "config.json");
      await writeFile(path, JSON.stringify(baseConfig()));
      expect((await loadFrelyMcpConfig(path)).approvedProvider.id).toBe("example-vision");
      expect(resolveEnvReference("env:FRELY_NETWORK_API_KEY", { FRELY_NETWORK_API_KEY: "network-key" })).toBe("network-key");
      expect(() => resolveEnvReference("env:MISSING", {})).toThrow("CONFIG_INVALID");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

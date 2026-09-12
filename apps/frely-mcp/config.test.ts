import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { loadFrelyMcpConfig } from "./config.ts";

type ConfigFixture = {
  configPath: string;
  cleanup(): Promise<void>;
};

async function writeConfigFixture(
  mutate: (base: Record<string, unknown>) => Record<string, unknown> = (base) => base,
): Promise<ConfigFixture> {
  const directory = await mkdtemp(join(tmpdir(), "frely-mcp-config-"));
  const base = {
    schemaVersion: 2,
    network: {
      mode: "static-local",
      baseUrl: "http://127.0.0.1:13600",
      apiKeyRef: "env:FRELY_NETWORK_API_KEY",
    },
    approvedProvider: {
      id: "frely-vision-basic",
      endpoint: "https://api.frely.cloud/v1/responses",
    },
    approvedExecution: {
      endpoint: "http://127.0.0.1:13600/v1/responses",
    },
    walletDir: resolve(directory, "wallet"),
    paymentConfigPath: resolve(directory, "payment-config.json"),
    paymentRegistryPath: resolve(directory, "payment-registry.json"),
  };
  const configPath = resolve(directory, "config.json");
  await writeFile(configPath, JSON.stringify(mutate(base)));
  return { configPath, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("loads one absolute local authorization without secrets", async () => {
  const fixture = await writeConfigFixture();
  const config = await loadFrelyMcpConfig(fixture.configPath);
  expect(config.schemaVersion).toBe(2);
  expect(config.network).toEqual({
    mode: "static-local",
    baseUrl: "http://127.0.0.1:13600",
    apiKeyRef: "env:FRELY_NETWORK_API_KEY",
  });
  expect(config.approvedProvider).toEqual({
    id: "frely-vision-basic",
    endpoint: "https://api.frely.cloud/v1/responses",
  });
  expect(config.approvedExecution).toEqual({
    endpoint: "http://127.0.0.1:13600/v1/responses",
  });
  expect(JSON.stringify(config)).not.toContain("network-secret");
  await fixture.cleanup();
});

test("rejects localhost, other ports, https Network, extra fields, old fields, secrets, paths and drift", async () => {
  const mutators: Array<(base: Record<string, unknown>) => Record<string, unknown>> = [
    (base) => ({ ...base, network: { ...(base.network as object), baseUrl: "http://localhost:13600" } }),
    (base) => ({ ...base, network: { ...(base.network as object), baseUrl: "http://127.0.0.1:13601" } }),
    (base) => ({ ...base, network: { ...(base.network as object), baseUrl: "https://127.0.0.1:13600" } }),
    (base) => ({ ...base, unexpected: true }),
    (base) => ({ ...base, network: { ...(base.network as object), chainId: 11155111 } }),
    (base) => ({ ...base, network: { ...(base.network as object), registry: "0x1111111111111111111111111111111111111111" } }),
    (base) => ({ ...base, relay: { apiKeyRef: "env:FRELY_RELAY_API_KEY" } }),
    (base) => ({ ...base, network: { ...(base.network as object), apiKeyRef: "network-secret" } }),
    (base) => ({ ...base, network: { ...(base.network as object), apiKeyRef: "env:frely_key" } }),
    (base) => ({ ...base, walletDir: "relative/wallet" }),
    (base) => ({ ...base, approvedProvider: { id: "other", endpoint: "https://api.frely.cloud/v1/responses" } }),
    (base) => ({ ...base, approvedProvider: { id: "frely-vision-basic", endpoint: "https://other.example/v1/responses" } }),
    (base) => ({ ...base, approvedExecution: { endpoint: "http://127.0.0.1:13601/v1/responses" } }),
  ];
  for (const mutate of mutators) {
    const fixture = await writeConfigFixture(mutate);
    await expect(loadFrelyMcpConfig(fixture.configPath)).rejects.toThrow("CONFIG_INVALID");
    await fixture.cleanup();
  }
});

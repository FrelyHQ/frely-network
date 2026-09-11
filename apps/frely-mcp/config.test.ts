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
    schemaVersion: 1,
    network: {
      baseUrl: "https://network.example",
      apiKeyRef: "env:FRELY_API_KEY",
      chainId: 11155111,
      registry: "0x1111111111111111111111111111111111111111",
    },
    relay: { apiKeyRef: "env:FRELY_RELAY_API_KEY" },
    walletDir: resolve(directory, "wallet"),
    approvedProviderId: "provider-1",
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
  expect(config.approvedProviderId).toBe("provider-1");
  expect(config.network.apiKeyRef).toBe("env:FRELY_API_KEY");
  expect(JSON.stringify(config)).not.toContain("network-secret");
  await fixture.cleanup();
});

test("rejects embedded secrets, relative paths and extra fields", async () => {
  for (const mutate of [
    (base: Record<string, unknown>) => ({ ...base, network: { ...(base.network as object), apiKeyRef: "network-secret" } }),
    (base: Record<string, unknown>) => ({ ...base, walletDir: "relative/wallet" }),
    (base: Record<string, unknown>) => ({ ...base, unexpected: true }),
  ]) {
    const fixture = await writeConfigFixture(mutate);
    await expect(loadFrelyMcpConfig(fixture.configPath)).rejects.toThrow("CONFIG_INVALID");
    await fixture.cleanup();
  }
});

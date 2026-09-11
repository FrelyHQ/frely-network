import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseResolvedCapability } from "@frely-network/capability-resolution";
import { createPaidExecutor } from "@frely-network/broker";
import type { CapabilityRequest } from "@frely-network/shared-types";
import { createHarness } from "../../packages/payment/hedera-x402/test-support.ts";
import successFixture from "../../packages/protocol/capability-resolution/fixtures/success.json";
import type { FrelyMcpConfig } from "./config.ts";
import { outcomeOrWalletError, wrapPaymentPorts } from "./index.ts";
import { createFrelyMcpRuntime } from "./runtime.ts";

const visionRequest = (requestId: string): CapabilityRequest => ({
  capabilities: ["vision"],
  task: "Describe",
  input: { image_url: "https://images.example/a.png" },
  payment: {
    requestId,
    budget: { network: "hedera:testnet", asset: "0.0.0", maxAmountAtomic: "1000000" },
  },
});

test("non-ready wallet is WALLET_NOT_READY and never signs", async () => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "frely-mcp-gate-")));
  const h = createHarness();
  const config: FrelyMcpConfig = {
    schemaVersion: 1,
    network: {
      baseUrl: "https://network.example",
      apiKeyRef: "env:FRELY_API_KEY",
      chainId: 11155111,
      registry: "0x1111111111111111111111111111111111111111",
    },
    relay: { apiKeyRef: "env:FRELY_RELAY_API_KEY" },
    walletDir: join(parent, "wallet"),
    approvedProviderId: "provider-1",
    paymentConfigPath: join(parent, "payment.json"),
    paymentRegistryPath: join(parent, "registry.json"),
  };
  const policy = {
    ...h.policy,
    enabled: true,
  };
  const resolved = structuredClone(successFixture);
  resolved.provider.endpoint = policy.resourceUrl;
  const ports = wrapPaymentPorts(config, policy, h.ports);
  const execute = createPaidExecutor({
    policy,
    ports,
    executionConfig: {
      mode: "integration",
      origin: new URL(policy.resourceUrl).origin,
      callerKey: "caller-test",
    },
  });
  const runtime = createFrelyMcpRuntime({
    config,
    paymentPolicy: policy,
    networkClient: { resolve: async () => parseResolvedCapability(resolved) },
    createPaymentExecutor: () => ({
      execute: async (provider, request) => outcomeOrWalletError(await execute(provider, request)),
      close: () => {},
    }),
  });
  try {
    await expect(runtime.useCapability(visionRequest("wallet-gate-1"))).rejects.toThrow("WALLET_NOT_READY");
    expect(h.counts.sign).toBe(0);
  } finally {
    h.close();
    await rm(parent, { recursive: true, force: true });
  }
});

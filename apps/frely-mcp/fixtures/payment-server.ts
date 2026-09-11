import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPaidExecutor } from "@frely-network/broker";
import { parseResolvedCapability } from "@frely-network/capability-resolution";
import { createHarness } from "../../../packages/payment/hedera-x402/test-support.ts";
import successFixture from "../../../packages/protocol/capability-resolution/fixtures/success.json";
import type { FrelyMcpConfig } from "../config.ts";
import { createFrelyMcpRuntime } from "../runtime.ts";
import { createFrelyMcpServer } from "../server.ts";

const harness = createHarness();
const resolved = parseResolvedCapability({
  ...successFixture,
  provider: { ...successFixture.provider, endpoint: harness.policy.resourceUrl },
});
const config: FrelyMcpConfig = {
  schemaVersion: 1,
  network: {
    baseUrl: "https://network.example",
    apiKeyRef: "env:FRELY_API_KEY",
    chainId: 11155111,
    registry: "0x1111111111111111111111111111111111111111",
  },
  relay: { apiKeyRef: "env:FRELY_RELAY_API_KEY" },
  walletDir: "/tmp/frely-mcp-payment-test/wallet",
  approvedProviderId: "provider-1",
  paymentConfigPath: "/tmp/frely-mcp-payment-test/payment.json",
  paymentRegistryPath: "/tmp/frely-mcp-payment-test/registry.json",
};
const runtime = createFrelyMcpRuntime({
  config,
  paymentPolicy: harness.policy,
  networkClient: { resolve: async () => structuredClone(resolved) },
  createPaymentExecutor: () => ({
    execute: createPaidExecutor({
      policy: harness.policy,
      ports: harness.ports,
      executionConfig: {
        mode: "integration",
        origin: new URL(harness.policy.resourceUrl).origin,
        callerKey: "test-only",
      },
    }),
    close: () => harness.close(),
  }),
});
await createFrelyMcpServer(runtime).connect(new StdioServerTransport());

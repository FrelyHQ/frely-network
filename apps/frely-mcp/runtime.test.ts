import { expect, test } from "bun:test";
import { parseResolvedCapability } from "@frely-network/capability-resolution";
import type { Policy } from "@frely-network/hedera-x402";
import type { CapabilityRequest } from "@frely-network/shared-types";
import successFixture from "../../packages/protocol/capability-resolution/fixtures/success.json";
import type { FrelyMcpConfig } from "./config.ts";
import { createFrelyMcpRuntime, type FrelyMcpRuntimeOptions } from "./runtime.ts";

const visionRequest = (requestId: string): CapabilityRequest => ({
  capabilities: ["vision"],
  task: "Describe",
  input: { image_url: "https://images.example/a.png" },
  payment: {
    requestId,
    budget: { network: "hedera:testnet", asset: "0.0.0", maxAmountAtomic: "1000000" },
  },
});

const validConfig: FrelyMcpConfig = {
  schemaVersion: 1,
  network: {
    baseUrl: "https://network.example",
    apiKeyRef: "env:FRELY_API_KEY",
    chainId: 11155111,
    registry: "0x1111111111111111111111111111111111111111",
  },
  relay: { apiKeyRef: "env:FRELY_RELAY_API_KEY" },
  walletDir: "/tmp/frely-mcp-runtime-test/wallet",
  approvedProviderId: "provider-1",
  paymentConfigPath: "/tmp/frely-mcp-runtime-test/payment.json",
  paymentRegistryPath: "/tmp/frely-mcp-runtime-test/registry.json",
};
const validPolicy: Policy = {
  enabled: true,
  network: "hedera:testnet",
  asset: "0.0.0",
  assetDecimals: 8,
  payerAccountId: "0.0.1234",
  payTo: "0.0.4321",
  feePayers: ["0.0.9999"],
  facilitatorUrl: "https://facilitator.example",
  resourceUrl: "https://relay.example/v1/responses",
  journalPath: ":memory:",
  mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
  signerRef: "env:PAYMENT_TEST_KEY",
  keyType: "ecdsa",
  credentialRef: "test-only",
};

function harness(settings: {
  drift?: "provider" | "endpoint";
  onResolve?: () => void;
}) {
  let signCalls = 0;
  let relayCalls = 0;
  const resolved = structuredClone(successFixture);
  // Align the frozen Network fixture with the local profile unless the case is testing endpoint drift.
  resolved.provider.endpoint = validPolicy.resourceUrl;
  if (settings.drift === "provider") resolved.provider.id = "provider-2";
  if (settings.drift === "endpoint") resolved.provider.endpoint = "https://other.example/v1/responses";
  const options: FrelyMcpRuntimeOptions = {
    config: validConfig,
    paymentPolicy: validPolicy,
    networkClient: { resolve: async () => { settings.onResolve?.(); return parseResolvedCapability(resolved); } },
    createPaymentExecutor: () => ({
      execute: async (_provider, request) => {
        signCalls += 1;
        relayCalls += 1;
        return {
          requestId: request.payment?.requestId ?? null,
          decision: "completed",
          paymentStatus: "settled",
          serviceStatus: "succeeded",
          reason: "PAYMENT_COMPLETED",
          retryAction: "none",
          evidence: { source: "synthetic", network: "hedera:testnet", transactionId: "synthetic-tx" },
          output: { output_text: "synthetic output" },
        };
      },
      close: () => {},
    }),
  };
  return { options, signCalls: () => signCalls, relayCalls: () => relayCalls };
}

test("resolves on every use and pays only the approved provider endpoint", async () => {
  let resolves = 0;
  const h = harness({ onResolve: () => resolves += 1 });
  const runtime = createFrelyMcpRuntime(h.options);
  await runtime.findCapability(["vision"]);
  const result = await runtime.useCapability(visionRequest("req-1"));
  expect(resolves).toBe(2);
  expect(result.identityVerificationSource).toBe("frely-network");
  expect(result.paymentOutcome?.paymentStatus).toBe("settled");
  expect(result.output).toEqual({ output_text: "synthetic output" });
});

test("does not sign when provider or resource differs from the local profile", async () => {
  for (const drift of ["provider", "endpoint"] as const) {
    const h = harness({ drift });
    const runtime = createFrelyMcpRuntime(h.options);
    await expect(runtime.useCapability(visionRequest("req-" + drift))).rejects.toThrow("PROVIDER_NOT_AUTHORIZED");
    expect(h.signCalls()).toBe(0);
    expect(h.relayCalls()).toBe(0);
  }
});

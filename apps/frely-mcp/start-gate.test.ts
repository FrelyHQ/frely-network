import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStaticResolvedCapability } from "@frely-network/capability-resolution";
import type { CapabilityRequest } from "@frely-network/shared-types";
import { createHarness } from "../../packages/payment/hedera-x402/test-support.ts";
import staticSuccess from "../../packages/protocol/capability-resolution/fixtures/static-success-v2.json";
import type { FrelyMcpConfig } from "./config.ts";
import { wrapPaymentPorts } from "./index.ts";
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
    walletDir: join(parent, "wallet"),
    paymentConfigPath: join(parent, "payment.json"),
    paymentRegistryPath: join(parent, "registry.json"),
  };
  const policy = {
    ...h.policy,
    enabled: true,
    resourceUrl: staticSuccess.execution.endpoint,
  };
  const ports = wrapPaymentPorts(config, policy, h.ports);
  const runtime = createFrelyMcpRuntime({
    config,
    paymentPolicy: policy,
    networkClient: { resolve: async () => parseStaticResolvedCapability(staticSuccess) },
    createPaymentExecutor: () => ({
      execute: async (_provider, request) => {
        await ports.checkNetwork({
          required: { x402Version: 2, resource: { url: policy.resourceUrl }, accepts: [] },
          requirements: {
            scheme: "exact",
            network: "hedera:testnet",
            asset: policy.asset,
            amount: "1000",
            payTo: policy.payTo,
            maxTimeoutSeconds: 120,
            extra: { feePayer: policy.feePayers[0] },
          },
          acceptIndex: 0,
        });
        return {
          requestId: request.payment?.requestId ?? null,
          decision: "completed",
          paymentStatus: "settled",
          serviceStatus: "succeeded",
          reason: "PAYMENT_COMPLETED",
          retryAction: "none",
          evidence: null,
          output: { output_text: "unreachable" },
        };
      },
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

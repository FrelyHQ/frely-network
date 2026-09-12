import { expect, test } from "bun:test";
import { parseStaticResolvedCapability } from "@frely-network/capability-resolution";
import type { Policy } from "@frely-network/hedera-x402";
import type { CapabilityRequest } from "@frely-network/shared-types";
import staticSuccess from "../../packages/protocol/capability-resolution/fixtures/static-success-v2.json";
import type { FrelyMcpConfig } from "./config.ts";
import { createFrelyMcpRuntime, type FrelyMcpRuntimeOptions } from "./runtime.ts";

const visionRequest = (requestId: string, overrides: Partial<CapabilityRequest> = {}): CapabilityRequest => ({
  capabilities: ["vision"],
  task: "Describe",
  input: { image_url: "https://images.example/a.png" },
  payment: {
    requestId,
    budget: { network: "hedera:testnet", asset: "0.0.0", maxAmountAtomic: "100000000" },
  },
  ...overrides,
});

const validConfig: FrelyMcpConfig = {
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
  walletDir: "/tmp/frely-mcp-runtime-test/wallet",
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
  amountAtomic: "100000000",
  facilitatorUrl: "https://facilitator.example",
  resourceUrl: "http://127.0.0.1:13600/v1/responses",
  journalPath: ":memory:",
  mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
  signerRef: "env:PAYMENT_TEST_KEY",
  keyType: "ecdsa",
  credentialRef: "test-only",
};

function harness(settings: {
  drift?: "provider" | "upstream" | "execution";
  onResolve?: () => void;
}) {
  let constructed = 0;
  let signCalls = 0;
  let networkExecutions = 0;
  const seen = new Map<string, string>();
  const resolved = structuredClone(staticSuccess);
  if (settings.drift === "provider") resolved.provider.id = "other";
  if (settings.drift === "upstream") resolved.provider.endpoint = "https://other.example/v1/responses";
  if (settings.drift === "execution") resolved.execution.endpoint = "http://127.0.0.1:13601/v1/responses";
  const options: FrelyMcpRuntimeOptions = {
    config: validConfig,
    paymentPolicy: validPolicy,
    networkClient: {
      resolve: async () => {
        settings.onResolve?.();
        return parseStaticResolvedCapability(resolved);
      },
    },
    createPaymentExecutor: () => {
      constructed += 1;
      return {
        execute: async (provider, request) => {
          const fingerprint = JSON.stringify({
            provider: provider.id,
            endpoint: provider.endpoint,
            task: request.task,
            input: request.input,
            budget: request.payment?.budget,
          });
          const requestId = request.payment?.requestId ?? "";
          const previous = seen.get(requestId);
          if (previous && previous !== fingerprint) throw new Error("REQUEST_ID_CONFLICT");
          if (!previous) {
            seen.set(requestId, fingerprint);
            signCalls += 1;
            networkExecutions += 1;
          }
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
      };
    },
  };
  return {
    options,
    constructed: () => constructed,
    signCalls: () => signCalls,
    networkExecutions: () => networkExecutions,
  };
}

test("resolves on every use and pays only the approved static provider", async () => {
  let resolves = 0;
  const h = harness({ onResolve: () => { resolves += 1; } });
  const runtime = createFrelyMcpRuntime(h.options);
  await runtime.findCapability(["vision"]);
  expect(h.constructed()).toBe(0);
  const result = await runtime.useCapability(visionRequest("req-1"));
  expect(resolves).toBe(2);
  expect(result).toMatchObject({
    provider: { id: "frely-vision-basic" },
    resolutionSource: "static_allowlist",
    identityVerified: false,
    paymentOutcome: { paymentStatus: "settled" },
  });
  expect(result).not.toHaveProperty("identityVerificationSource");
  expect(result).not.toHaveProperty("ensName");
  expect(result.output).toEqual({ output_text: "synthetic output" });
});

test("does not construct an executor, sign, or execute when provider fields drift", async () => {
  for (const drift of ["provider", "upstream", "execution"] as const) {
    const h = harness({ drift });
    const runtime = createFrelyMcpRuntime(h.options);
    await expect(runtime.useCapability(visionRequest("req-" + drift))).rejects.toThrow();
    expect(h.constructed()).toBe(0);
    expect(h.signCalls()).toBe(0);
    expect(h.networkExecutions()).toBe(0);
  }
});

test("rejects non-public image URLs before resolve or payment", async () => {
  const h = harness({});
  const runtime = createFrelyMcpRuntime(h.options);
  for (const image_url of [
    "http://images.example/a.png",
    "https://localhost/a.png",
    "https://printer.local/a.png",
    "https://127.0.0.1/a.png",
  ]) {
    await expect(runtime.useCapability(visionRequest("img", { input: { image_url } }))).rejects.toThrow("CAPABILITY_NOT_SUPPORTED");
  }
  expect(h.constructed()).toBe(0);
  expect(h.signCalls()).toBe(0);
});

test("same requestId with a mutated image, task, budget or provider conflicts without a second payment", async () => {
  const h = harness({});
  const runtime = createFrelyMcpRuntime(h.options);
  await runtime.useCapability(visionRequest("same-id"));
  expect(h.signCalls()).toBe(1);
  for (const override of [
    { input: { image_url: "https://images.example/b.png" } },
    { task: "Other" },
    { payment: { requestId: "same-id", budget: { network: "hedera:testnet" as const, asset: "0.0.0", maxAmountAtomic: "1" } } },
  ]) {
    await expect(runtime.useCapability(visionRequest("same-id", override))).rejects.toThrow("REQUEST_ID_CONFLICT");
  }
  expect(h.signCalls()).toBe(1);
  expect(h.networkExecutions()).toBe(1);
});

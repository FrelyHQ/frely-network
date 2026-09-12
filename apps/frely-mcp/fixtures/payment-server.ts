import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseStaticResolvedCapability } from "@frely-network/capability-resolution";
import staticSuccess from "../../../packages/protocol/capability-resolution/fixtures/static-success-v2.json";
import type { FrelyMcpConfig } from "../config.ts";
import { createFrelyMcpRuntime } from "../runtime.ts";
import { createFrelyMcpServer } from "../server.ts";

const resolved = parseStaticResolvedCapability(staticSuccess);
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
  walletDir: "/tmp/frely-mcp-payment-test/wallet",
  paymentConfigPath: "/tmp/frely-mcp-payment-test/payment.json",
  paymentRegistryPath: "/tmp/frely-mcp-payment-test/registry.json",
};
const runtime = createFrelyMcpRuntime({
  config,
  paymentPolicy: {
    enabled: true,
    network: "hedera:testnet",
    asset: "0.0.0",
    assetDecimals: 8,
    payerAccountId: "0.0.1236",
    payTo: "0.0.1234",
    feePayers: ["0.0.1235"],
    facilitatorUrl: "https://facilitator.invalid",
    resourceUrl: staticSuccess.execution.endpoint,
    journalPath: ":memory:",
    mirrorNodeUrl: "https://mirror.invalid",
    signerRef: "env:PAYMENT_TEST_KEY",
    keyType: "ecdsa",
    credentialRef: "test-only",
  },
  networkClient: { resolve: async () => structuredClone(resolved) },
  createPaymentExecutor: () => ({
    execute: async (_provider, request) => ({
      requestId: request.payment?.requestId ?? null,
      decision: "completed",
      paymentStatus: "settled",
      serviceStatus: "succeeded",
      reason: "PAYMENT_COMPLETED",
      retryAction: "none",
      evidence: {
        source: "synthetic",
        network: "hedera:testnet",
        transactionId: "synthetic-tx",
        signedDigest: "synthetic-digest",
      },
      output: { output_text: "synthetic output" },
    }),
    close: () => {},
  }),
});
await createFrelyMcpServer(runtime).connect(new StdioServerTransport());

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStaticResolveResult } from "@frely-network/capability-resolution";
import success from "../../packages/protocol/capability-resolution/fixtures/static-success-v2.json";
import { createFrelyMcpRuntime } from "./runtime.ts";

const staticSuccess = parseStaticResolveResult(success);

function config(paymentEnabled = true) {
  return {
    schemaVersion: 2 as const,
    network: { baseUrl: "http://127.0.0.1:18765" as const, apiKeyRef: "env:FRELY_NETWORK_API_KEY" as const },
    approvedProvider: { id: "example-vision", relayUrl: "https://relay.example.com/v1/responses" },
    approvedExecution: { resourceUrl: "http://127.0.0.1:18765/v1/responses" },
    payment: paymentEnabled ? {
      livePaymentEnabled: true,
      network: "hedera:testnet" as const,
      asset: "0.0.123",
      amountAtomic: "10",
      payTo: "0.0.456",
      feePayer: "0.0.789",
      facilitatorUrl: "https://facilitator.example.com/",
      payerAccountId: "0.0.111",
      maxTimeoutSeconds: 60,
      walletDirectory: "/tmp/frely-wallet",
      journalPath: "/tmp/frely-journal.sqlite",
    } : undefined,
  };
}

const useInput = {
  requestId: "req-1",
  capabilities: ["vision"] as ["vision"],
  task: "Describe the image",
  input: { image_url: "https://images.example.com/a.png" },
  maxAmountAtomic: "10",
};

describe("frely-mcp runtime", () => {
  test("find_capability does not create a payer session", async () => {
    let sessions = 0;
    const runtime = createFrelyMcpRuntime({
      config: config(),
      networkClient: { resolve: async () => staticSuccess },
      createSession: async () => { sessions += 1; throw new Error("FORBIDDEN"); },
    });
    expect(await runtime.findCapability(["vision"])).toEqual(staticSuccess);
    expect(sessions).toBe(0);
  });

  test("rejects invalid use input and disabled payment before constructing a session", async () => {
    let sessions = 0;
    const runtime = createFrelyMcpRuntime({
      config: config(false),
      networkClient: { resolve: async () => staticSuccess },
      createSession: async () => { sessions += 1; throw new Error("FORBIDDEN"); },
    });
    await expect(runtime.useCapability({ ...useInput, task: "" })).rejects.toThrow("INVALID_REQUEST");
    await expect(runtime.useCapability(useInput)).rejects.toThrow("PAYMENT_DISABLED");
    expect(sessions).toBe(0);
  });

  test("authorizes the exact provider and maps payment, service and output separately", async () => {
    let executeInput: unknown;
    const runtime = createFrelyMcpRuntime({
      config: config(),
      networkClient: { resolve: async () => staticSuccess },
      createSession: async () => ({
        execute: async (input) => {
          executeInput = input;
          return {
            requestId: input.requestId,
            paymentStatus: "settled" as const,
            serviceStatus: "succeeded" as const,
            retryAction: "none" as const,
            transactionId: "tx-1",
            output: { output_text: "synthetic" },
          };
        },
      }),
    });
    expect(await runtime.useCapability(useInput)).toEqual({
      requestId: "req-1",
      provider: { id: "example-vision" },
      resolution: { source: "static_allowlist", identityVerified: false },
      payment: { status: "settled", network: "hedera:testnet", transactionId: "tx-1" },
      service: { status: "succeeded" },
      retryAction: "none",
      output: { output_text: "synthetic" },
    });
    expect(executeInput).toMatchObject({
      requestId: "req-1",
      providerId: "example-vision",
      resourceUrl: "http://127.0.0.1:18765/v1/responses",
      maxAmountAtomic: "10",
    });
  });

  test("preserves unknown recovery guidance and rejects provider drift", async () => {
    const unknown = createFrelyMcpRuntime({
      config: config(),
      networkClient: { resolve: async () => staticSuccess },
      createSession: async () => ({ execute: async () => ({
        requestId: "req-1",
        paymentStatus: "unknown" as const,
        serviceStatus: "unknown" as const,
        retryAction: "query_original" as const,
        transactionId: "tx-1",
      }) }),
    });
    expect((await unknown.useCapability(useInput)).retryAction).toBe("query_original");

    const drifted = createFrelyMcpRuntime({
      config: config(),
      networkClient: { resolve: async () => ({ ...staticSuccess, provider: { ...staticSuccess.provider, id: "other" } }) },
      createSession: async () => { throw new Error("FORBIDDEN"); },
    });
    await expect(drifted.useCapability(useInput)).rejects.toThrow("PROVIDER_NOT_AUTHORIZED");
  });

  test("does not read wallet material before Network returns a valid payment challenge", async () => {
    const directory = await mkdtemp(join(tmpdir(), "frely-runtime-"));
    try {
      let executionCalls = 0;
      const paymentConfig = config();
      paymentConfig.payment!.walletDirectory = join(directory, "missing-wallet");
      paymentConfig.payment!.journalPath = join(directory, "journal.sqlite");
      const runtime = createFrelyMcpRuntime({
        config: paymentConfig,
        networkClient: {
          resolve: async () => staticSuccess,
          execute: async () => {
            executionCalls += 1;
            return Response.json({ code: "PAYMENT_REQUIRED" }, { status: 500 });
          },
        },
      });
      await expect(runtime.useCapability(useInput)).rejects.toThrow("PAYMENT_REQUIRED");
      expect(executionCalls).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

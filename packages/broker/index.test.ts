import { describe, expect, test } from "bun:test";
import { Broker } from "./index.ts";
import { BrokerError } from "@frely-network/shared-types";

const candidates = [
  { id: "low", ensName: "low.capability.example.eth", capabilities: ["vision-basic"], supportsX402: true, reputation: 1 },
  { id: "high", ensName: "high.capability.example.eth", capabilities: ["vision-basic"], supportsX402: true, reputation: 9 },
  { id: "unpaid", ensName: "unpaid.capability.example.eth", capabilities: ["vision-basic"], supportsX402: false, reputation: 100 },
];

describe("Broker orchestration", () => {
  test("verifies before selecting, selects the best eligible provider and invokes only that endpoint", async () => {
    const verified: string[] = [];
    const invoked: string[] = [];
    const broker = new Broker({
      discovery: { findProviders: async () => candidates },
      identity: {
        resolveProvider: async (candidate) => {
          verified.push(candidate.id);
          if (candidate.id === "unpaid") throw new Error("not eligible");
          return { id: candidate.id, ensName: candidate.ensName, endpoint: `https://${candidate.id}.example/v1/responses`, protocol: "responses", verified: true };
        },
      },
      invocation: {
        invoke: async (provider, _request, correlationId) => {
          invoked.push(provider.id);
          return { output: { provider: provider.id }, payment: { network: "hedera:testnet", transactionId: "tx-1" } };
        },
      },
    }, { idFactory: () => "corr-1" });

    const found = await broker.findCapability(["vision-basic"]);
    const result = await broker.useCapability({ capabilities: ["vision-basic"], task: "inspect image" });

    expect(found.map((provider) => provider.id)).toEqual(["high", "low"]);
    expect(verified).toEqual(["low", "high", "low", "high"]);
    expect(invoked).toEqual(["high"]);
    expect(result.provider.id).toBe("high");
    expect(result.correlationId).toBe("corr-1");
  });

  test("fails before invocation when discovery returns no verified provider", async () => {
    let invoked = false;
    const broker = new Broker({
      discovery: { findProviders: async () => [{ id: "bad", capabilities: ["vision"], supportsX402: true }] },
      identity: { resolveProvider: async () => { throw new Error("identity failed"); } },
      invocation: { invoke: async () => { invoked = true; return { output: null, payment: { network: "hedera:testnet" } }; } },
    });

    await expect(broker.useCapability({ capabilities: ["vision"], task: "run" })).rejects.toMatchObject({ code: "NO_VERIFIED_PROVIDER" });
    expect(invoked).toBe(false);
  });

  test("rejects malformed spend limits at the Broker boundary", async () => {
    const broker = new Broker({
      discovery: { findProviders: async () => [] },
      identity: { resolveProvider: async () => { throw new BrokerError("NO_VERIFIED_PROVIDER"); } },
      invocation: { invoke: async () => ({ output: null, payment: { network: "hedera:testnet" } }) },
    });

    await expect(broker.useCapability({ capabilities: ["vision"], task: "run", maxAmount: "1.2" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

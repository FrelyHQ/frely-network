import { expect, test } from "bun:test";
import { createBroker } from "./index.ts";
import type { ProviderCandidate, ResolvedProvider } from "@frely-network/shared-types";
const request = { capabilities: ["vision"], task: "Describe", input: { image_url: "https://images.example/a.png" } };
const candidates: ProviderCandidate[] = [{ id: "2", capabilities: ["vision"], supportsX402: false }, { id: "1", capabilities: ["vision"], supportsX402: false }];
const resolved: ResolvedProvider = { id: "1", endpoint: "https://frely.example/v1/responses", protocol: "responses", verified: true };

test("selects deterministically and executes only the resolved endpoint", async () => {
  const events: string[] = [];
  const broker = createBroker({
    async findProviders() { events.push("find"); return candidates; },
    async resolveProvider(candidate) { events.push("resolve:" + candidate.id); return resolved; },
    async execute(provider, input) { events.push("execute:" + provider.endpoint); expect(input).toEqual(request); return { output_text: "A bicycle" }; },
  });
  const result = await broker.useCapability(request);
  expect(events).toEqual(["find", "resolve:1", "execute:https://frely.example/v1/responses"]);
  expect(result).toEqual({ provider: { id: "1" }, output: { output_text: "A bicycle" } });
  expect(candidates[0]!.id).toBe("2");
});

test("unverified and mismatched identities never execute", async () => {
  for (const provider of [{ ...resolved, verified: false }, { ...resolved, id: "other" }]) {
    let executed = false;
    const broker = createBroker({ async findProviders() { return candidates; }, async resolveProvider() { return provider; }, async execute() { executed = true; return {}; } });
    await expect(broker.useCapability(request)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
    expect(executed).toBe(false);
  }
});

test("no matching candidates or resolver failure stops before execution", async () => {
  let executed = false;
  const broker = createBroker({ async findProviders() { return candidates; }, async resolveProvider() { throw new Error("IDENTITY_VERIFICATION_FAILED"); }, async execute() { executed = true; return {}; } });
  await expect(broker.useCapability({ ...request, capabilities: ["audio"] })).rejects.toThrow("NO_PROVIDER");
  await expect(broker.useCapability(request)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
  expect(executed).toBe(false);
});

test("paid execution preserves a settled service failure and never uses the legacy executor", async () => {
  const paymentOutcome = {
    requestId: "paid-1",
    decision: "completed" as const,
    paymentStatus: "settled" as const,
    serviceStatus: "failed" as const,
    reason: "SERVICE_FAILED_AFTER_PAYMENT",
    retryAction: "none" as const,
    evidence: { source: "synthetic" as const, network: "hedera:testnet", transactionId: "0.0.123@1.000000001" },
    output: null,
  };
  const broker = createBroker({
    async findProviders() { return candidates; },
    async resolveProvider() { return resolved; },
    async execute() { throw new Error("LEGACY_PATH_USED"); },
    async executePaid() { return paymentOutcome; },
    paymentEnabled: true,
  });
  const result = await broker.useCapability({
    ...request,
    payment: { requestId: "paid-1", budget: { network: "hedera:testnet", asset: "0.0.0", maxAmountAtomic: "1000" } },
  });
  expect(result).toEqual({ provider: { id: "1" }, paymentOutcome, payment: { network: "hedera:testnet", transactionId: "0.0.123@1.000000001" }, output: null });
});

test("payment mode rejects missing, legacy and conflicting budgets before either executor", async () => {
  let calls = 0;
  const broker = createBroker({
    async findProviders() { calls++; return candidates; }, async resolveProvider() { calls++; return resolved; },
    async execute() { calls++; return {}; }, async executePaid() { calls++; throw new Error("UNREACHABLE"); }, paymentEnabled: true,
  });
  await expect(broker.useCapability(request)).rejects.toThrow("BUDGET_INVALID");
  await expect(broker.useCapability({ ...request, maxAmount: "1" })).rejects.toThrow("LEGACY_BUDGET_UNSUPPORTED");
  await expect(broker.useCapability({ ...request, maxAmount: "1", payment: { requestId: "paid-2", budget: { network: "hedera:testnet", asset: "0.0.0", maxAmountAtomic: "1" } } })).rejects.toThrow("BUDGET_INPUT_CONFLICT");
  expect(calls).toBe(0);
});

test("disabled payment rejects a payment request before discovery", async () => {
  let called = false;
  const broker = createBroker({
    async findProviders() { called = true; return candidates; }, async resolveProvider() { return resolved; }, async execute() { return {}; },
  });
  await expect(broker.useCapability({ ...request, payment: { requestId: "paid-disabled", budget: { network: "hedera:testnet", asset: "0.0.0", maxAmountAtomic: "1" } } })).rejects.toThrow("PAYMENT_DISABLED");
  expect(called).toBe(false);
});

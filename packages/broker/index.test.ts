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

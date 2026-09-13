import { expect, test } from "bun:test";
import { Broker } from "./index.ts";
import type { ProviderCandidate } from "@frely-network/shared-types";

function fixture(supportsX402: boolean, verified = true) {
  let calls = 0;
  const dependencies = {
    discovery: { async findProviders() { return [{ id: "7", ensName: "risk.fixture.eth", capabilities: ["web3.address-risk"], supportsX402 }]; } },
    identity: { async resolveProvider(candidate: ProviderCandidate) {
      return { id: candidate.id, ensName: candidate.ensName!, endpoint: "https://api.frely.fixture.test/a2a", protocol: "a2a" as const, verified };
    } },
    invocation: { async invoke() { calls++; return { output: { fixture: true } }; } },
  };
  return { dependencies, calls: () => calls };
}
const request = { capabilities: ["web3.address-risk"], task: "Check this address" };

test("account billing can discover and invoke a verified service without claiming native x402 support", async () => {
  const f = fixture(false);
  const broker = new Broker(f.dependencies, { billingMode: "frely_account", discoverySource: "the_graph_fixture" });
  expect(await broker.findCapability(request.capabilities)).toHaveLength(1);
  const result = await broker.useCapability(request);
  expect(result.billing).toEqual({ mode: "frely_account" });
  expect(result.payment).toBeUndefined();
  expect(f.calls()).toBe(1);
});
test("the default x402 profile still rejects services without native payment support", async () => {
  const f = fixture(false); const broker = new Broker(f.dependencies);
  await expect(broker.findCapability(request.capabilities)).rejects.toThrow("NO_VERIFIED_PROVIDER");
  await expect(broker.useCapability(request)).rejects.toThrow("NO_VERIFIED_PROVIDER");
  expect(f.calls()).toBe(0);
});
test("x402 invocation still requires settlement evidence after service admission", async () => {
  const f = fixture(true); const broker = new Broker(f.dependencies);
  await expect(broker.useCapability(request)).rejects.toThrow("PAYMENT_REQUIRED");
});
test("account billing does not bypass an invalid service identity", async () => {
  const f = fixture(false, false); const broker = new Broker(f.dependencies, { billingMode: "frely_account" });
  await expect(broker.useCapability(request)).rejects.toThrow("NO_VERIFIED_PROVIDER");
  expect(f.calls()).toBe(0);
});

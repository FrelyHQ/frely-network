import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  createProviderDirectory,
  type ProviderEnvironment,
  type ProviderCandidate,
  type ResolvedProvider,
} from "@frely-network/provider-directory";
import { TheGraphDiscovery } from "@frely-network/the-graph";
import { ProviderIdentityResolver } from "@frely-network/erc8004";

// These fixtures verify composition only, not live identity checks or M3.
const env: ProviderEnvironment = {
  GRAPH_ENDPOINT: "https://graph.example.test/graphql",
  ENS_SEPOLIA_RPC_URL: "https://rpc.example.test",
  IDENTITY_CHAIN_ID: "11155111",
  PAYMENT_NETWORK: "hedera:testnet",
  ERC8004_IDENTITY_REGISTRY: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
};

const candidate: ProviderCandidate = {
  id: "7",
  ensName: "fixture.example.eth",
  capabilities: ["vision"],
  supportsX402: true,
};

const resolved: ResolvedProvider = {
  id: candidate.id,
  ensName: candidate.ensName,
  endpoint: "https://provider.example.test/a2a",
  protocol: "a2a",
  agentCardUrl: "https://provider.example.test/agent-card.json",
  a2aProtocolVersion: "0.3.0",
  verified: true,
};

const restoreSpies: Array<() => void> = [];

afterEach(() => {
  for (const restore of restoreSpies.splice(0)) restore();
});

function configurationError(overrides: ProviderEnvironment): Error {
  try {
    createProviderDirectory({ ...env, ...overrides });
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected configuration to be rejected");
}

describe("B-facing provider directory", () => {
  test("exports bound methods through its workspace package", async () => {
    let discoveryReceiver: unknown;
    let identityReceiver: unknown;
    const candidates = [candidate];
    const findSpy = spyOn(TheGraphDiscovery.prototype, "findProviders")
      .mockImplementation(function (this: TheGraphDiscovery) {
        discoveryReceiver = this;
        return Promise.resolve(candidates);
      });
    const resolveSpy = spyOn(ProviderIdentityResolver.prototype, "resolveProvider")
      .mockImplementation(function (this: ProviderIdentityResolver) {
        identityReceiver = this;
        return Promise.resolve(resolved);
      });
    restoreSpies.push(() => findSpy.mockRestore(), () => resolveSpy.mockRestore());

    const { findProviders, resolveProvider } = createProviderDirectory(env);
    const capabilities = ["vision"];
    expect(await findProviders(capabilities)).toBe(candidates);
    expect(await resolveProvider(candidate)).toBe(resolved);
    expect(discoveryReceiver).toBeInstanceOf(TheGraphDiscovery);
    expect(identityReceiver).toBeInstanceOf(ProviderIdentityResolver);
    expect(findSpy).toHaveBeenCalledTimes(1);
    expect(findSpy.mock.calls[0]?.[0]).toBe(capabilities);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy.mock.calls[0]?.[0]).toBe(candidate);
  });

  test("propagates Graph failures without a candidate fallback", async () => {
    const failure = new Error("GRAPH_QUERY_FAILED");
    const findSpy = spyOn(TheGraphDiscovery.prototype, "findProviders")
      .mockRejectedValue(failure);
    restoreSpies.push(() => findSpy.mockRestore());

    const { findProviders } = createProviderDirectory(env);
    await expect(findProviders(["vision"])).rejects.toBe(failure);
    expect(findSpy).toHaveBeenCalledTimes(1);
  });

  test("propagates identity failures without a resolved fallback", async () => {
    const failure = new Error("IDENTITY_VERIFICATION_FAILED");
    const resolveSpy = spyOn(ProviderIdentityResolver.prototype, "resolveProvider")
      .mockRejectedValue(failure);
    restoreSpies.push(() => resolveSpy.mockRestore());

    const { resolveProvider } = createProviderDirectory(env);
    await expect(resolveProvider(candidate)).rejects.toBe(failure);
    expect(resolveSpy).toHaveBeenCalledTimes(1);
  });

  test("requires every environment setting instead of providing live defaults", () => {
    for (const key of Object.keys(env)) {
      expect(configurationError({ [key]: undefined }).message)
        .toBe(`PROVIDER_CONFIG_MISSING:${key}`);
      expect(configurationError({ [key]: "  " }).message)
        .toBe(`PROVIDER_CONFIG_MISSING:${key}`);
    }
  });

  test("accepts an optional HTTPS metadata gateway and rejects unsafe values", () => {
    expect(() => createProviderDirectory({ ...env, METADATA_GATEWAY: "https://gateway.example/ipfs/{cid}" })).not.toThrow();
    for (const value of ["http://gateway.example/ipfs", "https://user:fake-secret@gateway.example", "invalid"]) {
      expect(configurationError({ METADATA_GATEWAY: value }).message).toBe("PROVIDER_CONFIG_INVALID:METADATA_GATEWAY");
    }
  });

  test("rejects unsupported identity chains, payment networks and registries", () => {
    const invalid: Array<[string, string]> = [
      ["IDENTITY_CHAIN_ID", "1"],
      ["PAYMENT_NETWORK", "hedera-testnet"],
      ["ERC8004_IDENTITY_REGISTRY", "not-an-address"],
      ["ERC8004_IDENTITY_REGISTRY", "0x0000000000000000000000000000000000000000"],
    ];
    for (const [key, value] of invalid) {
      expect(configurationError({ [key]: value }).message)
        .toBe(`PROVIDER_CONFIG_INVALID:${key}`);
    }
  });

  test("rejects invalid credential-bearing URLs without exposing their values", () => {
    const fakeKey = "not-a-real-api-key";
    const invalid: Array<[string, string]> = [
      ["GRAPH_ENDPOINT", `http://graph.example.test/api/${fakeKey}`],
      ["GRAPH_ENDPOINT", `https://${fakeKey}@graph.example.test/graphql`],
      ["GRAPH_ENDPOINT", `https://graph.example.test/api/<${fakeKey}>`],
      ["GRAPH_ENDPOINT", `invalid:${fakeKey}`],
      ["ENS_SEPOLIA_RPC_URL", `https://user:${fakeKey}@rpc.example.test`],
      ["ENS_SEPOLIA_RPC_URL", `file:///rpc/${fakeKey}`],
    ];
    for (const [key, value] of invalid) {
      const error = configurationError({ [key]: value });
      expect(error.message).toBe(`PROVIDER_CONFIG_INVALID:${key}`);
      expect(String(error)).not.toContain(fakeKey);
      expect(String(error)).not.toContain(value);
    }
  });
});

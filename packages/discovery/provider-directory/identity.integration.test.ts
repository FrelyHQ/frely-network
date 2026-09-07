import { describe, expect, mock, test } from "bun:test";
import type { PublicClient } from "viem";
import { TheGraphDiscovery } from "@frely-network/the-graph";
import { ensip25AgentRegistrationKey, ViemEnsReader } from "@frely-network/ens";
import { ProviderIdentityResolver, ViemErc8004Reader } from "@frely-network/erc8004";

// Every response below is injected fixture data. No network calls are made;
// this checks module integration, not live Graph/ENS/ERC-8004 or M3 evidence.
const registryAddress = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const resolverAddress = "0x1111111111111111111111111111111111111111";
const chainId = 11155111;
const blockNumber = 123456n;
const ensName = "fixture-vision.frely.eth";
const providerEndpoint = "https://provider.frely.dev/v1/responses";
const metadataUri = "https://metadata.frely.dev/fixture-7.json";
const graphEndpoint = "https://graph.frely.dev/fixture/graphql";
const rpcUrl = "https://rpc.frely.dev/fixture";
const registrationKey = ensip25AgentRegistrationKey(registryAddress, "7");

function metadata(format: "manifest" | "services") {
  const common = {
    name: "fixture-vision",
    description: "Synthetic integration fixture, not a registered Provider",
    active: true,
    x402Support: true,
    capabilities: ["vision"],
    payment: { protocol: "x402", network: "hedera:testnet" },
  };
  if (format === "manifest") {
    return {
      ...common,
      identity: { ens: ensName, agentId: "7" },
      interfaces: [{ protocol: "responses", endpoint: providerEndpoint }],
    };
  }
  return {
    ...common,
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    services: [
      { name: "ENS", endpoint: ensName },
      { name: "Responses", endpoint: providerEndpoint, version: "1.0" },
    ],
    registrations: [{ agentId: "7", agentRegistry: `eip155:${chainId}:${registryAddress}` }],
  };
}

function fixture(options: {
  format?: "manifest" | "services";
  ensEndpoint?: string;
  storedRegistrationKey?: string;
} = {}) {
  const document = metadata(options.format ?? "manifest");
  const graphFetch = mock(async (url: string, init: RequestInit) => {
    if (url === graphEndpoint) {
      expect(init.method).toBe("POST");
      return Response.json({
        data: {
          agents: [{
            id: "11155111:7",
            chainId,
            agentId: "7",
            agentURI: metadataUri,
            registrationFile: { ens: ensName, active: true, x402Support: true },
          }],
        },
      });
    }
    expect(url).toBe(metadataUri);
    expect(init.method).toBe("GET");
    return Response.json(document);
  });
  const graph = new TheGraphDiscovery({
    endpoint: graphEndpoint,
    network: String(chainId),
    registryAddress,
    paymentNetwork: "hedera:testnet",
  }, graphFetch);

  const tokenUriRead = mock(async (request: { address: string; functionName: string; args: readonly bigint[]; blockNumber?: bigint }) => {
    expect(request.address).toBe(registryAddress);
    expect(request.functionName).toBe("tokenURI");
    expect(request.args).toEqual([7n]);
    expect(request.blockNumber).toBe(blockNumber);
    return metadataUri;
  });
  const getIdentityBlock = mock(async () => blockNumber);
  const ercClient = {
    getChainId: mock(async () => chainId),
    getBlockNumber: getIdentityBlock,
    readContract: tokenUriRead,
  } as unknown as PublicClient;
  const metadataFetch = mock(async (url: string, init: RequestInit) => {
    expect(url).toBe(metadataUri);
    expect(init.redirect).toBe("error");
    return Response.json(document);
  });
  const erc = new ViemErc8004Reader({ rpcUrl, registryAddress }, ercClient, metadataFetch);

  const getResolver = mock(async (request: { name: string; blockNumber?: bigint }) => {
    expect(request.name).toBe(ensName);
    expect(request.blockNumber).toBe(blockNumber);
    return resolverAddress;
  });
  const getText = mock(async (request: { name: string; key: string; blockNumber?: bigint; strict?: boolean }) => {
    expect(request.name).toBe(ensName);
    expect(request.blockNumber).toBe(blockNumber);
    expect(request.strict).toBe(true);
    if (request.key === "agent-endpoint[responses]") return options.ensEndpoint ?? providerEndpoint;
    if (request.key === (options.storedRegistrationKey ?? registrationKey)) return "1";
    return null;
  });
  const getEnsBlock = mock(async () => { throw new Error("ENS must reuse the ERC-8004 block"); });
  const ensClient = {
    getChainId: mock(async () => chainId),
    getBlockNumber: getEnsBlock,
    getEnsResolver: getResolver,
    getEnsText: getText,
  } as unknown as PublicClient;
  const ens = new ViemEnsReader({ rpcUrl }, ensClient);
  const resolver = new ProviderIdentityResolver(ens, erc);
  return { graph, resolver, graphFetch, metadataFetch, tokenUriRead, getIdentityBlock, getResolver, getText, getEnsBlock };
}

describe("fixture Graph candidate to verified identity integration", () => {
  test.each(["manifest", "services"] as const)("resolves %s metadata through all real module implementations", async (format) => {
    const f = fixture({ format });
    const candidates = await f.graph.findProviders(["vision"]);
    expect(candidates).toEqual([{ id: "7", ensName, capabilities: ["vision"], supportsX402: true }]);
    expect(candidates[0]).not.toHaveProperty("endpoint");
    expect(await f.resolver.resolveProvider(candidates[0]!)).toEqual({
      id: "7", ensName, endpoint: providerEndpoint, protocol: "responses", verified: true,
    });
    expect(f.graphFetch).toHaveBeenCalledTimes(2);
    expect(f.metadataFetch).toHaveBeenCalledTimes(1);
    expect(f.tokenUriRead).toHaveBeenCalledTimes(1);
    expect(f.getIdentityBlock).toHaveBeenCalledTimes(1);
    expect(f.getResolver).toHaveBeenCalledTimes(1);
    expect(f.getText).toHaveBeenCalledTimes(2);
    expect(f.getEnsBlock).not.toHaveBeenCalled();
    expect(f.getText.mock.calls.map(([request]) => request.key)).toEqual([
      "agent-endpoint[responses]", registrationKey,
    ]);
  });

  test("rejects an ENS execution endpoint differing from the dereferenced metadata", async () => {
    const f = fixture({ format: "services", ensEndpoint: "https://other.frely.dev/v1/responses" });
    const candidates = await f.graph.findProviders(["vision"]);
    expect(candidates).toHaveLength(1);
    await expect(f.resolver.resolveProvider(candidates[0]!)).rejects.toThrow("ENS_ENDPOINT_MISMATCH");
    expect(f.getText).toHaveBeenCalledTimes(2);
  });

  test("rejects a different ENSIP-25 identity key even if an unrelated registration exists", async () => {
    const otherKey = ensip25AgentRegistrationKey(registryAddress, "17");
    const f = fixture({ storedRegistrationKey: otherKey });
    const candidates = await f.graph.findProviders(["vision"]);
    expect(candidates).toHaveLength(1);
    await expect(f.resolver.resolveProvider(candidates[0]!)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
    expect(f.getText.mock.calls.map(([request]) => request.key)).toContain(registrationKey);
    expect(f.getText.mock.calls.map(([request]) => request.key)).not.toContain(otherKey);
  });
});

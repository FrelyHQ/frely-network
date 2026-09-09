import { describe, expect, mock, test } from "bun:test";
import type { Address, PublicClient } from "viem";
import { ensip25AgentRegistrationKey, type EnsReader, type EnsRecords } from "@frely-network/ens";
import { ProviderIdentityResolver, ViemErc8004Reader, type Erc8004Identity, type Erc8004Reader } from "./index.ts";

// All identities and metadata here are fixtures, not live registration evidence.
const registry: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const otherRegistry: Address = "0x1111111111111111111111111111111111111111";
const ensName = "vision.example.eth";
const endpoint = "https://provider.frely.network/a2a";
const agentCardUrl = "https://provider.frely.network/.well-known/agent-card.json";
const candidate = { id: "7", ensName, capabilities: ["vision"], supportsX402: true };

function metadata() {
  return {
    name: "Fixture vision",
    capabilities: ["vision"],
    identity: { ens: ensName, agentId: "7" },
    interfaces: [{ protocol: "a2a", endpoint, agentCardUrl }],
    payment: { protocol: "x402", network: "hedera:testnet" },
    active: true,
    x402Support: true,
  };
}

function agentCard() {
  return {
    name: "Fixture vision", description: "Synthetic A2A discovery card", version: "1.0.0",
    protocolVersion: "0.3.0", preferredTransport: "JSONRPC", url: endpoint, capabilities: {},
    defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
    skills: [{ id: "vision", name: "Vision", description: "Image understanding", tags: ["vision"] }],
  };
}

function fixture() {
  const identity: Erc8004Identity = {
    agentId: "7", registryAddress: registry, chainId: 11155111, blockNumber: 123n,
    metadataUri: "https://metadata.example/7.json", metadata: metadata() as unknown,
  };
  const records: EnsRecords = {
    name: ensName, resolver: otherRegistry, endpoint, protocol: "a2a" as const,
    agentRegistration: "1", agentRegistrationKey: ensip25AgentRegistrationKey(registry, "7"),
  };
  const read = mock(async () => identity);
  const resolve = mock(async () => records);
  const erc8004: Erc8004Reader = { registryAddress: registry, read };
  const ens: EnsReader = { resolve };
  const fetcher = mock(async (_url: string, _init: RequestInit) => Response.json(agentCard()));
  return { identity, records, read, resolve, fetcher, resolver: new ProviderIdentityResolver(ens, erc8004, { fetcher }) };
}

describe("Provider identity verification", () => {
  test("accepts ENSIP-25 value 1 at the exact identity key", async () => {
    const f = fixture();
    expect(await f.resolver.resolveProvider(candidate)).toEqual({
      id: "7", ensName, endpoint, agentCardUrl, a2aProtocolVersion: "0.3.0", protocol: "a2a", verified: true,
    });
    expect(f.resolve).toHaveBeenCalledWith(ensName, { registryAddress: registry, agentId: "7", blockNumber: 123n });
    expect(f.fetcher.mock.calls[0]?.[0]).toBe(agentCardUrl);
    expect(f.fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
  });

  test("verifies native x402Support=false while retaining the mandatory Network payment profile", async () => {
    const f = fixture();
    f.identity.metadata = { ...metadata(), x402Support: false };
    const resolved = await f.resolver.resolveProvider({ ...candidate, supportsX402: false });
    expect(resolved).toMatchObject({ verified: true, protocol: "a2a", endpoint, agentCardUrl });
    expect(resolved).not.toHaveProperty("payment");
    expect(f.fetcher.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
    f.identity.metadata = { ...metadata(), x402Support: false, payment: undefined };
    await expect(f.resolver.resolveProvider({ ...candidate, supportsX402: false })).rejects.toThrow();
  });

  test("rejects candidate and metadata native x402 declarations that disagree", async () => {
    for (const supportsX402 of [false, true]) {
      const f = fixture();
      f.identity.metadata = { ...metadata(), x402Support: !supportsX402 };
      await expect(f.resolver.resolveProvider({ ...candidate, supportsX402 }))
        .rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
      expect(f.resolve).not.toHaveBeenCalled();
      expect(f.fetcher).not.toHaveBeenCalled();
    }
  });

  test("returns the selected A2A 1.0 protocol version after Card verification", async () => {
    const f = fixture();
    const { protocolVersion: _, preferredTransport: _transport, url: _url, ...base } = agentCard();
    f.fetcher.mockResolvedValueOnce(Response.json({
      ...base, supportedInterfaces: [{ protocolVersion: "1.0", protocolBinding: "JSONRPC", url: endpoint }],
    }));
    expect((await f.resolver.resolveProvider(candidate)).a2aProtocolVersion).toBe("1.0");
  });

  test("requires the Card execution URL to match independently verified ENS and metadata", async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(Response.json({ ...agentCard(), url: "https://other.frely.network/a2a" }));
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow("A2A_ENDPOINT_MISMATCH");
  });

  test("does not treat the Card URL as the ENS execution URL", async () => {
    const f = fixture();
    f.records.endpoint = agentCardUrl;
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow("ENS_ENDPOINT_MISMATCH");
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test.each(["https://127.0.0.1/card.json", "https://10.0.0.1/card.json", "https://cards.internal/card.json"])(
    "rejects non-public Card targets before any fetch: %s", async (unsafeUrl) => {
      const f = fixture();
      f.identity.metadata = { ...metadata(), interfaces: [{ protocol: "a2a", endpoint, agentCardUrl: unsafeUrl }] };
      await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow("A2A_CARD_INVALID");
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  test("does not interpret nonempty ENSIP-25 values as addresses or IDs", async () => {
    for (const value of ["0", " ", "registered"]) {
      const f = fixture();
      f.records.agentRegistration = value;
      expect((await f.resolver.resolveProvider(candidate)).verified).toBe(true);
    }
  });

  test("rejects a different registration key even when its value contains matching substrings", async () => {
    const f = fixture();
    f.records.agentRegistrationKey = ensip25AgentRegistrationKey(registry, "17");
    f.records.agentRegistration = `${registry}:17`;
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
  });

  test("rejects metadata/ENS endpoint mismatches", async () => {
    const f = fixture();
    f.records.endpoint = "https://other.frely.network/a2a";
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow("ENS_ENDPOINT_MISMATCH");
  });

  test("checks the ENS claim inside the manifest instead of only a root alias", async () => {
    const f = fixture();
    f.identity.metadata = { ...metadata(), identity: { ens: "someone-else.eth", agentId: "7" } };
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
    expect(f.resolve).not.toHaveBeenCalled();
  });

  test.each([
    { agentId: "17" }, { chainId: 1 }, { registryAddress: otherRegistry }, { blockNumber: -1n },
  ])("rejects a reader returning a different identity or invalid snapshot", async (change) => {
    const f = fixture();
    Object.assign(f.identity, change);
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
    expect(f.resolve).not.toHaveBeenCalled();
  });

  test.each([
    { id: "07" }, { id: "11155111:7" }, { id: "-1" }, { id: (1n << 256n).toString() },
    { ensName: "" }, { capabilities: [] }, { capabilities: [""] },
  ])("rejects invalid candidates before RPC: %j", async (change) => {
    const f = fixture();
    await expect(f.resolver.resolveProvider({ ...candidate, ...change, capabilities: [...(change.capabilities ?? candidate.capabilities)] })).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
  });

  test.each([undefined, null, "true", "false", 0, 1])("rejects non-boolean candidate x402 support before RPC: %p", async (supportsX402) => {
    const f = fixture();
    await expect(f.resolver.resolveProvider({ ...candidate, supportsX402: supportsX402 as unknown as boolean }))
      .rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
    expect(f.read).not.toHaveBeenCalled();
  });

  test("checks candidate capabilities against independently read metadata", async () => {
    const f = fixture();
    await expect(f.resolver.resolveProvider({ ...candidate, capabilities: ["ocr"] }))
      .rejects.toThrow("CAPABILITY_NOT_SUPPORTED");
    expect(f.resolve).not.toHaveBeenCalled();
  });

  test.each([
    { name: "unrelated.eth" }, { agentRegistration: "" }, { agentRegistration: undefined },
    { agentRegistrationKey: undefined }, { resolver: "0x0000000000000000000000000000000000000000" },
    { agentRegistrationKey: ensip25AgentRegistrationKey(otherRegistry, "7") },
    { agentRegistrationKey: ensip25AgentRegistrationKey(registry, "7", 1) },
  ])("rejects inconsistent or missing ENS records: %j", async (change) => {
    const f = fixture();
    Object.assign(f.records, change);
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow();
  });

  test.each(["responses", "mcp", "http"] as const)("rejects ENS protocol %s for an A2A Provider", async (protocol) => {
    const f = fixture();
    Object.assign(f.records, { protocol });
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow("PROTOCOL_NOT_SUPPORTED");
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test("rejects legacy Responses metadata before ENS or Card resolution", async () => {
    const f = fixture();
    f.identity.metadata = { ...metadata(), interfaces: [{ protocol: "responses", endpoint: "https://provider.frely.network/v1/responses" }] };
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow("PROTOCOL_NOT_SUPPORTED");
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test.each([
    "http://provider.frely.network/a2a", "https://user:password@provider.frely.network/a2a",
    "https://provider.frely.network/a2a#other", "invalid-url",
  ])("rejects unsafe ENS endpoints returned by a custom reader: %s", async (value) => {
    const f = fixture();
    f.records.endpoint = value;
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow();
  });

  test("normalizes ENS and URL syntax without ignoring path case", async () => {
    const f = fixture();
    f.records.name = ensName.toUpperCase();
    f.records.endpoint = "https://PROVIDER.FRELY.NETWORK:443/a2a";
    expect((await f.resolver.resolveProvider({ ...candidate, ensName: ensName.toUpperCase() })).endpoint).toBe(endpoint);
    f.records.endpoint = "https://provider.frely.network/A2A";
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow("ENS_ENDPOINT_MISMATCH");
  });

  test("rejects metadata with conflicting root and nested identity claims", async () => {
    const f = fixture();
    f.identity.metadata = { ...metadata(), ens: "unrelated.eth" };
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow("REGISTRATION_METADATA_INVALID");
    expect(f.resolve).not.toHaveBeenCalled();
  });

  test("sanitizes unexpected reader errors", async () => {
    const f = fixture();
    f.read.mockRejectedValueOnce(new Error("https://rpc.example/fake-secret"));
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow(/^IDENTITY_VERIFICATION_FAILED$/);
    f.resolve.mockRejectedValueOnce(new Error("https://ens.example/fake-secret"));
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow(/^IDENTITY_VERIFICATION_FAILED$/);
    f.fetcher.mockRejectedValueOnce(new Error("https://card.example/fake-secret"));
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow(/^A2A_CARD_INVALID$/);
  });
});

function readerFixture() {
  const state = { chainId: 11155111, blockNumber: 123n, uri: "https://metadata.example/7.json", metadata: metadata() as unknown };
  const rpc = {
    getChainId: mock(async () => state.chainId),
    getBlockNumber: mock(async () => state.blockNumber),
    readContract: mock(async (_request: unknown) => state.uri),
  };
  const fetcher = mock(async (_url: string, _init: RequestInit) => Response.json(state.metadata));
  const client = rpc as unknown as PublicClient;
  const config = { rpcUrl: "https://rpc.example/fixture", registryAddress: registry };
  const reader = new ViemErc8004Reader(config, client, fetcher);
  return { state, rpc, fetcher, reader, client, config };
}

describe("ERC-8004 tokenURI reader fixtures", () => {
  test("reads the configured registry at a checked Sepolia block", async () => {
    const f = readerFixture();
    expect(await f.reader.read("7")).toEqual({
      agentId: "7", registryAddress: registry, chainId: 11155111, blockNumber: 123n,
      metadataUri: f.state.uri, metadata: f.state.metadata,
    });
    expect(f.rpc.getChainId).toHaveBeenCalledTimes(1);
    expect(f.rpc.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
    expect(f.rpc.readContract.mock.calls[0]?.[0]).toMatchObject({ address: registry, functionName: "tokenURI", args: [7n], blockNumber: 123n });
    expect(f.fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
  });

  test("rejects an RPC on another chain before reading metadata", async () => {
    const f = readerFixture();
    f.state.chainId = 1;
    await expect(f.reader.read("7")).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
    expect(f.rpc.readContract).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test("preserves uint256 token IDs without Number conversion", async () => {
    const f = readerFixture();
    const id = ((1n << 256n) - 1n).toString();
    f.state.metadata = { ...metadata(), identity: { ens: ensName, agentId: id } };
    expect((await f.reader.read(id)).agentId).toBe(id);
    expect(f.rpc.readContract.mock.calls[0]?.[0]).toMatchObject({ args: [BigInt(id)] });
  });

  test.each(["07", "-1", "1e3", "11155111:7", (1n << 256n).toString()])("rejects noncanonical or overflowing ID %s", async (id) => {
    const f = readerFixture();
    await expect(f.reader.read(id)).rejects.toThrow();
    expect(f.rpc.getChainId).not.toHaveBeenCalled();
  });

  test("rejects a bad block number", async () => {
    const f = readerFixture();
    f.state.blockNumber = -1n;
    await expect(f.reader.read("7")).rejects.toThrow("IDENTITY_VERIFICATION_FAILED");
    expect(f.rpc.readContract).not.toHaveBeenCalled();
  });

  test("validates services metadata and Agent0 extension bag", async () => {
    const f = readerFixture();
    f.state.metadata = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "Fixture vision",
      active: true, x402Support: true,
      services: [{ name: "ENS", endpoint: ensName }, { name: "A2A", endpoint: agentCardUrl }],
      registrations: [{ agentId: 7, agentRegistry: `eip155:11155111:${registry}` }],
      metadata: { capabilities: ["vision"], interfaces: metadata().interfaces, payment: { protocol: "x402", network: "hedera:testnet" } },
    };
    expect((await f.reader.read("7")).metadata).toEqual(f.state.metadata);
  });

  test("preserves false native x402 support in independently fetched metadata", async () => {
    const f = readerFixture();
    f.state.metadata = { ...metadata(), x402Support: false };
    expect((await f.reader.read("7")).metadata).toEqual(f.state.metadata);
  });

  test.each([
    { payment: undefined }, { capabilities: [] }, { active: false }, { active: undefined },
    { x402Support: undefined }, { x402Support: "true" },
    { identity: { ens: ensName, agentId: "17" } },
    { interfaces: [{ protocol: "a2a", endpoint: "http://provider.frely.network/a2a", agentCardUrl }] },
    { interfaces: [{ protocol: "responses", endpoint: "https://provider.frely.network/v1/responses" }] },
  ])("rejects invalid token metadata: %j", async (change) => {
    const f = readerFixture();
    f.state.metadata = { ...metadata(), ...change };
    await expect(f.reader.read("7")).rejects.toThrow();
  });

  test.each(["http://metadata.example/7.json", "data:application/json,{}", "ipfs://bafyfixture/7.json"])("rejects unsupported URI %s before fetch", async (uri) => {
    const f = readerFixture();
    f.state.uri = uri;
    await expect(f.reader.read("7")).rejects.toThrow("METADATA_URI_INVALID");
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  test("uses an explicit IPFS gateway without losing provenance or CID path", async () => {
    const f = readerFixture();
    f.state.uri = "ipfs://bafyfixture/folder/7.json";
    const reader = new ViemErc8004Reader({ ...f.config, metadataGateway: "https://gateway.example/ipfs" }, f.client, f.fetcher);
    expect((await reader.read("7")).metadataUri).toBe(f.state.uri);
    expect(f.fetcher.mock.calls[0]?.[0]).toBe("https://gateway.example/ipfs/bafyfixture/folder/7.json");
  });

  test("sanitizes RPC and metadata failures", async () => {
    const f = readerFixture();
    f.rpc.readContract.mockRejectedValueOnce(new Error("https://rpc.example/fake-secret"));
    await expect(f.reader.read("7")).rejects.toThrow(/^IDENTITY_VERIFICATION_FAILED$/);
    f.fetcher.mockRejectedValueOnce(new Error("https://metadata.example/fake-secret"));
    await expect(f.reader.read("7")).rejects.toThrow(/^METADATA_FETCH_FAILED$/);
    f.fetcher.mockResolvedValueOnce(new Response("invalid JSON"));
    await expect(f.reader.read("7")).rejects.toThrow(/^METADATA_FETCH_FAILED$/);
  });

  test("does not allow HTTPS or metadata timeouts to be disabled", () => {
    const f = readerFixture();
    expect(() => new ViemErc8004Reader({ ...f.config, requireHttps: false }, f.client)).toThrow("ENDPOINT_NOT_HTTPS");
    expect(() => new ViemErc8004Reader({ ...f.config, requestTimeoutMs: 0 }, f.client)).toThrow("METADATA_CONFIG_INVALID");
  });
});

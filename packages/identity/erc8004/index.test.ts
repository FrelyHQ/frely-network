import { describe, expect, mock, test } from "bun:test";
import type { Address, PublicClient } from "viem";
import { ensip25AgentRegistrationKey, type EnsReader, type EnsRecords } from "@frely-network/ens";
import { ProviderIdentityResolver, ViemErc8004Reader, type Erc8004Identity, type Erc8004Reader } from "./index.ts";

// All identities and metadata here are fixtures, not live registration evidence.
const registry: Address = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const otherRegistry: Address = "0x1111111111111111111111111111111111111111";
const ensName = "vision.example.eth";
const endpoint = "https://provider.example/v1/responses";
const candidate = { id: "7", ensName, capabilities: ["vision"], supportsX402: true };

function metadata() {
  return {
    name: "Fixture vision",
    capabilities: ["vision"],
    identity: { ens: ensName, agentId: "7" },
    interfaces: [{ protocol: "responses", endpoint }],
    payment: { protocol: "x402", network: "hedera:testnet" },
  };
}

function fixture() {
  const identity: Erc8004Identity = {
    agentId: "7", registryAddress: registry, chainId: 11155111, blockNumber: 123n,
    metadataUri: "https://metadata.example/7.json", metadata: metadata() as unknown,
  };
  const records: EnsRecords = {
    name: ensName, resolver: otherRegistry, endpoint, protocol: "responses" as const,
    agentRegistration: "1", agentRegistrationKey: ensip25AgentRegistrationKey(registry, "7"),
  };
  const read = mock(async () => identity);
  const resolve = mock(async () => records);
  const erc8004: Erc8004Reader = { registryAddress: registry, read };
  const ens: EnsReader = { resolve };
  return { identity, records, read, resolve, resolver: new ProviderIdentityResolver(ens, erc8004) };
}

describe("Provider identity verification", () => {
  test("accepts ENSIP-25 value 1 at the exact identity key", async () => {
    const f = fixture();
    expect(await f.resolver.resolveProvider(candidate)).toEqual({ id: "7", ensName, endpoint, protocol: "responses", verified: true });
    expect(f.resolve).toHaveBeenCalledWith(ensName, { registryAddress: registry, agentId: "7", blockNumber: 123n });
  });

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
    f.records.endpoint = "https://other.example/v1/responses";
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
    { ensName: "" }, { capabilities: [] }, { capabilities: [""] }, { supportsX402: false },
  ])("rejects invalid candidates before RPC: %j", async (change) => {
    const f = fixture();
    await expect(f.resolver.resolveProvider({ ...candidate, ...change, capabilities: [...(change.capabilities ?? candidate.capabilities)] })).rejects.toThrow();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.resolve).not.toHaveBeenCalled();
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

  test.each(["mcp", "http"] as const)("rejects ENS protocol %s for a responses Provider", async (protocol) => {
    const f = fixture();
    f.records.protocol = protocol;
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow("PROTOCOL_NOT_SUPPORTED");
  });

  test.each([
    "http://provider.example/v1/responses", "https://user:password@provider.example/v1/responses",
    "https://provider.example/v1/responses#other", "invalid-url",
  ])("rejects unsafe ENS endpoints returned by a custom reader: %s", async (value) => {
    const f = fixture();
    f.records.endpoint = value;
    await expect(f.resolver.resolveProvider(candidate)).rejects.toThrow();
  });

  test("normalizes ENS and URL syntax without ignoring path case", async () => {
    const f = fixture();
    f.records.name = ensName.toUpperCase();
    f.records.endpoint = "https://PROVIDER.EXAMPLE:443/v1/responses";
    expect((await f.resolver.resolveProvider({ ...candidate, ensName: ensName.toUpperCase() })).endpoint).toBe(endpoint);
    f.records.endpoint = "https://provider.example/v1/Responses";
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
      services: [{ name: "ENS", endpoint: ensName }, { name: "responses", endpoint }],
      registrations: [{ agentId: 7, agentRegistry: `eip155:11155111:${registry}` }],
      metadata: { capabilities: ["vision"], payment: { protocol: "x402", network: "hedera:testnet" } },
    };
    expect((await f.reader.read("7")).metadata).toEqual(f.state.metadata);
  });

  test.each([
    { payment: undefined }, { capabilities: [] }, { active: false },
    { identity: { ens: ensName, agentId: "17" } },
    { interfaces: [{ protocol: "responses", endpoint: "http://provider.example/v1/responses" }] },
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

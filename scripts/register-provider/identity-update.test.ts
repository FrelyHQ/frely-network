import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  decodeFunctionData, parseAbi, sha256, stringToHex,
  type Address, type Hex, type PublicClient,
} from "viem";
import { namehash } from "viem/ens";
import { EnsSubnameManager } from "@frely-network/ens/subnames";
import {
  IDENTITY_REGISTRY, prepareRegistrationMetadata, ProviderRegistrationManager,
  type ProviderUpdateInput,
} from "./identity.ts";

// Synthetic chain responses verify update safety and resumption, not live M3 evidence.
const operator: Address = "0x1111111111111111111111111111111111111111";
const stranger: Address = "0x2222222222222222222222222222222222222222";
const resolver: Address = "0x3333333333333333333333333333333333333333";
const blockNumber = 200n;
const blockHash = `0x${"ab".repeat(32)}` as Hex;
const agentId = ((1n << 256n) - 1n).toString();
const ensName = "vision-basic.example.eth";
const endpoint = "https://provider.example/a2a";
const agentCardUrl = "https://provider.example/agent-card.json";
const legacyEndpoint = "https://provider.example/v1/responses";
const nextEndpoint = "https://network.example/a2a";
const endpointKey = "agent-endpoint[a2a]";
const legacyEndpointKey = "agent-endpoint[responses]";
const registrationKey = `agent-registration[0x0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e][${agentId}]`;
const writeAbi = parseAbi([
  "function setAgentURI(uint256 agentId, string newURI)",
  "function setText(bytes32 node, string key, string value)",
]);

interface ContractCall {
  address: Address;
  functionName: string;
  args: readonly unknown[];
  blockNumber?: bigint;
}
interface EnsCall { name: string; key: string; blockNumber?: bigint; strict?: boolean; }
interface SimulationCall { account: Address; to: Address; data: Hex; value: bigint; blockNumber?: bigint; }

function encodeMetadata(metadata: unknown) {
  const json = JSON.stringify(metadata);
  return {
    metadataUri: `data:application/json;base64,${Buffer.from(json).toString("base64")}`,
    metadataSha256: sha256(stringToHex(json)),
  };
}

function decodeMetadata(uri: string) {
  return JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
}

let inspectionSpy: ReturnType<typeof spyOn<EnsSubnameManager, "inspect">> | undefined;
afterEach(() => { inspectionSpy?.mockRestore(); inspectionSpy = undefined; });

function fixture(active = false, x402Support = false, legacy = false) {
  const prepared = prepareRegistrationMetadata({
    manifest: {
      name: "vision-basic", description: "Original description",
      capabilities: ["vision"], identity: { ens: ensName },
      interfaces: [{ protocol: "a2a", endpoint, agentCardUrl }],
      payment: { protocol: "x402", network: "hedera:testnet" },
    },
    active, x402Support,
  });
  const metadata = {
    ...prepared.metadata,
    image: "https://provider.example/icon.png",
    supportedTrust: ["reputation"],
    extension: { providerSpecific: "preserve me", version: 7 },
  };
  if (legacy) {
    metadata.services = [{ name: "ENS", endpoint: ensName }, { name: "responses", endpoint: legacyEndpoint }];
    Reflect.deleteProperty(metadata, "interfaces");
  }
  const original = encodeMetadata(metadata);
  const inspection = {
    blockNumber, blockHash, timestamp: 1_800_000_000n,
    children: [{ resolver, operatorCanWriteAllText: true, state: { status: 2, expiry: 1_800_086_400n } }],
  };
  inspectionSpy?.mockRestore();
  inspectionSpy = spyOn(EnsSubnameManager.prototype, "inspect")
    .mockResolvedValue(inspection as Awaited<ReturnType<EnsSubnameManager["inspect"]>>);
  const state = {
    uri: original.metadataUri, owner: operator, resolver,
    records: new Map<string, string>([[legacy ? "agent-endpoint[responses]" : endpointKey, legacy ? legacyEndpoint : endpoint], [registrationKey, "1"]]),
  };
  const card = { name: "vision", description: "Fixture", version: "1", protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC", url: endpoint, capabilities: {}, defaultInputModes: ["text"], defaultOutputModes: ["text"],
    skills: [{ id: "vision", name: "Vision", description: "Fixture", tags: [] }] };
  const cardFetch = mock(async (_url: string, _init: RequestInit) => Response.json(card));
  const client = {
    getChainId: mock(async () => 11155111),
    getBlock: mock(async () => ({ number: blockNumber, hash: blockHash })),
    getCode: mock(async () => "0x1234" as Hex | undefined),
    getEnsResolver: mock(async (_call: { name: string; blockNumber?: bigint }) => state.resolver),
    getEnsText: mock(async (call: EnsCall) => state.records.get(call.key) ?? null),
    readContract: mock(async (call: ContractCall) => {
      if (call.functionName === "tokenURI") return state.uri;
      if (call.functionName === "ownerOf") return state.owner;
      if (call.functionName === "text") return state.records.get(call.args[1] as string) ?? "";
      throw new Error(`Unexpected read: ${call.functionName}`);
    }),
    simulateContract: mock(async (_call: ContractCall) => ({ result: undefined })),
    call: mock(async (_call: SimulationCall) => ({ data: "0x" as Hex })),
    estimateGas: mock(async () => 123_456n),
    getTransactionReceipt: mock(() => { throw new Error("Current identity must not depend on initial registration receipt"); }),
    sendTransaction: mock(() => { throw new Error("Must remain unsigned"); }),
    writeContract: mock(() => { throw new Error("Must remain unsigned"); }),
  };
  const manager = new ProviderRegistrationManager({
    rpcUrl: "https://rpc.example", operator, registryAddress: IDENTITY_REGISTRY,
  }, client as unknown as PublicClient, { fetcher: cardFetch });
  function input(changes: ProviderUpdateInput["changes"] = {}): ProviderUpdateInput {
    card.url = changes.endpoint ?? endpoint;
    return { agentId, expected: { ...original, ensEndpoints: {
      responses: legacy ? legacyEndpoint : "", a2a: legacy ? "" : endpoint,
    }, resolver }, changes };
  }
  // Apply only synthetic confirmed effects; tests never call a chain write API.
  function apply(data: Hex) {
    const call = decodeFunctionData({ abi: writeAbi, data });
    if (call.functionName === "setAgentURI") {
      expect(call.args[0]).toBe(BigInt(agentId));
      state.uri = call.args[1];
    } else {
      expect(call.args[0]).toBe(namehash(ensName));
      state.records.set(call.args[1], call.args[2]);
    }
  }
  return { metadata, original, state, inspection, client, manager, input, apply, card, cardFetch };
}

describe("current Provider identity", () => {
  test("reads current metadata and preserves full uint256 IDs without a registration receipt", async () => {
    const f = fixture();
    const result = await f.manager.inspectCurrent(agentId);
    expect(result).toMatchObject({
      agentId, ensName, endpoint, ensEndpoint: endpoint, owner: operator, resolver,
      ...f.original, agentRegistrationKey: registrationKey, agentRegistration: "1",
      metadata: f.metadata, blockNumber, blockHash, registrationAndEnsVerified: true,
      updateInput: f.input(),
    });
    for (const [call] of f.client.readContract.mock.calls) {
      expect(call.blockNumber).toBe(blockNumber);
      if (call.functionName === "ownerOf" || call.functionName === "tokenURI") {
        expect(call.args).toEqual([BigInt(agentId)]);
      }
    }
    expect(f.client.getTransactionReceipt).not.toHaveBeenCalled();
    expect(f.client.call).not.toHaveBeenCalled();
  });

  test("verifies the latest metadata after a legitimate change without comparing the original registration", async () => {
    const f = fixture();
    f.state.uri = encodeMetadata({ ...f.metadata, description: "Updated after registration" }).metadataUri;
    const result = await f.manager.verifyCurrent(agentId);
    expect(result.registrationAndEnsVerified).toBe(true);
    expect(result.metadataUri).toBe(f.state.uri);
    expect(f.client.getTransactionReceipt).not.toHaveBeenCalled();
    expect(f.client.getEnsText.mock.calls.some(([call]) => call.strict && call.key === registrationKey)).toBe(true);
  });

  test("prepares missing ENS records from the latest metadata without an original registration hash", async () => {
    const f = fixture();
    f.state.uri = encodeMetadata({ ...f.metadata, description: "Updated description" }).metadataUri;
    f.state.records.clear();
    const result = await f.manager.prepareCurrentEns(agentId);
    expect(result.transactions).toHaveLength(2);
    expect(result.registrationAndEnsVerified).toBe(false);
    for (const entry of result.transactions) {
      expect(entry.transaction).toMatchObject({ from: operator, to: resolver, chainId: 11155111, value: "0" });
      f.apply(entry.transaction.data);
    }
    expect((await f.manager.verifyCurrent(agentId)).registrationAndEnsVerified).toBe(true);
    expect(f.client.getTransactionReceipt).not.toHaveBeenCalled();
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
  });

  test("skips existing ENS records, including a nonempty ENSIP-25 association value", async () => {
    const f = fixture();
    f.state.records.set(registrationKey, "verified-by-owner");
    expect(await f.manager.prepareCurrentEns(agentId)).toMatchObject({ action: "no_change", transactions: [] });
    expect(f.client.simulateContract).not.toHaveBeenCalled();
  });

  test("initial binding cannot be used to overwrite an existing conflicting endpoint", async () => {
    const f = fixture();
    f.state.records.set(endpointKey, nextEndpoint);
    await expect(f.manager.prepareCurrentEns(agentId)).rejects.toThrow();
    expect(f.client.simulateContract).not.toHaveBeenCalled();
  });

  test.each(["-1", "1.5", "9007199254740993e0", (1n << 256n).toString()])(
    "rejects an invalid uint256 agentId: %s", async (invalid) => {
      const f = fixture();
      await expect(f.manager.inspectCurrent(invalid)).rejects.toThrow();
      expect(f.client.readContract).not.toHaveBeenCalled();
    },
  );
});

describe("Provider update transaction sequence", () => {
  test("pauses an active Provider, switches ENS, then publishes matching metadata one step at a time", async () => {
    const f = fixture(true, true);
    const input = f.input({ endpoint: nextEndpoint });
    const first = await f.manager.prepareUpdate(input);
    expect(first).toMatchObject({ action: "update_provider", broadcast: false, completedSteps: 0, totalSteps: 3 });
    expect(first.nextStep?.kind).toBe("pause");
    expect(first.nextStep!.transaction).toMatchObject({ from: operator, to: IDENTITY_REGISTRY, chainId: 11155111, value: "0" });
    expect(f.client.call).toHaveBeenCalledTimes(1);
    expect(f.client.call.mock.calls[0][0]).toMatchObject({ account: operator, value: 0n, blockNumber });
    f.apply(first.nextStep!.transaction.data);
    expect(decodeMetadata(f.state.uri)).toEqual({ ...f.metadata, active: false });
    expect(f.state.records.get(endpointKey)).toBe(endpoint);

    const second = await f.manager.prepareUpdate(input);
    expect(second).toMatchObject({ completedSteps: 1, totalSteps: 3, nextStep: { kind: "endpoint" } });
    expect(second.nextStep!.transaction).toMatchObject({ from: operator, to: resolver, chainId: 11155111, value: "0" });
    expect(decodeFunctionData({ abi: writeAbi, data: second.nextStep!.transaction.data })).toMatchObject({
      functionName: "setText", args: [namehash(ensName), endpointKey, nextEndpoint],
    });
    expect(f.client.call).toHaveBeenCalledTimes(2);
    f.apply(second.nextStep!.transaction.data);
    expect(decodeMetadata(f.state.uri).active).toBe(false);
    await expect(f.manager.verifyUpdate(input)).rejects.toThrow();

    const third = await f.manager.prepareUpdate(input);
    expect(third).toMatchObject({ completedSteps: 2, totalSteps: 3, nextStep: { kind: "metadata" } });
    expect(third.target.metadata).toMatchObject({ active: true, x402Support: true });
    expect(f.client.call).toHaveBeenCalledTimes(3);
    f.apply(third.nextStep!.transaction.data);
    expect(f.state.uri).toBe(third.target.metadataUri);
    expect(decodeMetadata(f.state.uri).services).toEqual([
      { name: "ENS", endpoint: ensName }, { name: "A2A", endpoint: agentCardUrl },
    ]);
    expect(decodeMetadata(f.state.uri).interfaces).toEqual([{ protocol: "a2a", endpoint: nextEndpoint, agentCardUrl }]);

    const complete = await f.manager.prepareUpdate(input);
    expect(complete).toMatchObject({ completedSteps: 3, totalSteps: 3, nextStep: null, action: "no_change" });
    expect((await f.manager.verifyUpdate(input)).registrationAndEnsVerified).toBe(true);
    expect(f.client.call).toHaveBeenCalledTimes(3);
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
    expect(f.client.writeContract).not.toHaveBeenCalled();
    expect(input).toEqual(f.input({ endpoint: nextEndpoint }));
  });

  test("resumes after a confirmed pause with the original snapshot and never generates register", async () => {
    const f = fixture(true, true);
    const input = f.input({ endpoint: nextEndpoint, description: "Moved to x402 gateway" });
    const first = await f.manager.prepareUpdate(input);
    f.apply(first.nextStep!.transaction.data);
    f.client.call.mockClear();
    const resumed = await f.manager.prepareUpdate(input);
    expect(resumed).toMatchObject({ completedSteps: 1, nextStep: { kind: "endpoint" } });
    expect(f.client.call).toHaveBeenCalledTimes(1);
    expect(decodeFunctionData({ abi: writeAbi, data: f.client.call.mock.calls[0][0].data }).functionName).toBe("setText");
    expect(resumed.target.metadata).toMatchObject({ description: "Moved to x402 gateway", active: true });
    expect(f.client.getTransactionReceipt).not.toHaveBeenCalled();
  });

  test("skips the pause for an inactive Provider and preserves false flags", async () => {
    const f = fixture();
    const input = f.input({ endpoint: nextEndpoint });
    const first = await f.manager.prepareUpdate(input);
    expect(first).toMatchObject({ completedSteps: 0, totalSteps: 2, nextStep: { kind: "endpoint" } });
    f.apply(first.nextStep!.transaction.data);
    const second = await f.manager.prepareUpdate(input);
    expect(second).toMatchObject({ completedSteps: 1, totalSteps: 2, nextStep: { kind: "metadata" } });
    expect(second.target.metadata).toMatchObject({ active: false, x402Support: false });
    f.apply(second.nextStep!.transaction.data);
    expect((await f.manager.verifyUpdate(input)).registrationAndEnsVerified).toBe(true);
  });

  test.each([
    { active: true, x402Support: true },
    { description: "新版简介：视觉能力" },
  ])("updates only explicit fields and preserves unrelated metadata: %j", async (changes) => {
    const f = fixture();
    const input = f.input(changes);
    const plan = await f.manager.prepareUpdate(input);
    expect(plan).toMatchObject({ completedSteps: 0, totalSteps: 1, nextStep: { kind: "metadata" } });
    expect(plan.target.metadata).toEqual({ ...f.metadata, ...changes });
    expect(plan.target.endpoint).toBe(endpoint);
    expect(f.state.records.get(endpointKey)).toBe(endpoint);
    f.apply(plan.nextStep!.transaction.data);
    expect((await f.manager.verifyUpdate(input)).registrationAndEnsVerified).toBe(true);
    expect(f.client.call.mock.calls.map(([call]) => decodeFunctionData({ abi: writeAbi, data: call.data }).functionName)).toEqual(["setAgentURI"]);
  });

  test.each([{ endpoint }, { endpoint, active: false, x402Support: false, description: "Original description" }])(
    "does not simulate or rewrite an unchanged identity: %j", async (changes) => {
      const f = fixture();
      const plan = await f.manager.prepareUpdate(f.input(changes));
      expect(plan).toMatchObject({ action: "no_change", nextStep: null, totalSteps: 0, completedSteps: 0 });
      expect(plan.target.metadataUri).toBe(f.original.metadataUri);
      expect(f.client.call).not.toHaveBeenCalled();
    },
  );
});

describe("Responses identity migration to A2A", () => {
  test.each([false, true])("migrates an active=%s identity using the original input after each confirmation", async (active) => {
    const f = fixture(active, false, true);
    const input = f.input({ protocol: "a2a", endpoint: nextEndpoint, agentCardUrl });
    const originalInput = JSON.stringify(input);
    const kinds = active ? ["pause", "endpoint", "metadata"] : ["endpoint", "metadata"];
    expect(await f.manager.inspectCurrent(agentId)).toMatchObject({
      agentId, ensName, protocol: "responses", endpoint: legacyEndpoint,
      registrationAndEnsVerified: true, discoveryEligible: false,
    });

    for (const [completedSteps, kind] of kinds.entries()) {
      const resumedInput = JSON.parse(originalInput) as ProviderUpdateInput;
      const plan = await f.manager.prepareUpdate(resumedInput);
      expect(plan).toMatchObject({
        completedSteps, totalSteps: kinds.length, nextStep: { kind }, broadcast: false,
        target: { protocol: "a2a", endpoint: nextEndpoint, agentCardUrl },
      });
      expect(JSON.stringify(resumedInput)).toBe(originalInput);
      await expect(f.manager.verifyUpdate(resumedInput)).rejects.toThrow("REGISTRATION_UPDATE_INCOMPLETE");
      if (kind === "endpoint") {
        expect(decodeFunctionData({ abi: writeAbi, data: plan.nextStep!.transaction.data })).toEqual({
          functionName: "setText", args: [namehash(ensName), endpointKey, nextEndpoint],
        });
      }
      f.apply(plan.nextStep!.transaction.data);
      expect(f.state.records.get(legacyEndpointKey)).toBe(legacyEndpoint);
      expect(f.state.records.get(registrationKey)).toBe("1");
      if (kind !== "metadata") expect(decodeMetadata(f.state.uri)).toEqual({ ...f.metadata, active: false });
    }

    const result = await f.manager.verifyUpdate(JSON.parse(originalInput));
    expect(result).toMatchObject({
      completedSteps: kinds.length, nextStep: null, updateVerified: true, agentCardVerified: true,
      current: { agentId, ensName, protocol: "a2a", discoveryEligible: active,
        ensEndpoints: { responses: legacyEndpoint, a2a: nextEndpoint } },
    });
    expect(decodeMetadata(f.state.uri)).toEqual({
      ...f.metadata,
      services: [{ name: "ENS", endpoint: ensName }, { name: "A2A", endpoint: agentCardUrl }],
      interfaces: [{ protocol: "a2a", endpoint: nextEndpoint, agentCardUrl }],
    });
    expect(f.cardFetch.mock.calls.every(([url, init]) => url === agentCardUrl && init.method === "GET")).toBe(true);
    expect(f.state.records.get(endpointKey)).not.toBe(agentCardUrl);
    expect(await f.manager.prepareUpdate(JSON.parse(originalInput))).toMatchObject({ action: "no_change", nextStep: null });
    expect(f.client.call).toHaveBeenCalledTimes(kinds.length);
    expect(f.client.call.mock.calls.map(([call]) => decodeFunctionData({ abi: writeAbi, data: call.data }).functionName))
      .toEqual(active ? ["setAgentURI", "setText", "setAgentURI"] : ["setText", "setAgentURI"]);
    expect(f.client.getTransactionReceipt).not.toHaveBeenCalled();
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
    expect(f.client.writeContract).not.toHaveBeenCalled();
    expect(JSON.stringify(input)).toBe(originalInput);
  });

  test("refuses an existing destination A2A record that conflicts with the requested endpoint", async () => {
    const f = fixture(true, false, true);
    f.state.records.set(endpointKey, "https://other.example/a2a");
    const input = f.input({ protocol: "a2a", endpoint: nextEndpoint, agentCardUrl });
    input.expected.ensEndpoints.a2a = f.state.records.get(endpointKey)!;
    await expect(f.manager.prepareUpdate(input)).rejects.toThrow("REGISTRATION_ENS_RECORD_CONFLICT");
    expect(f.client.call).not.toHaveBeenCalled();
    expect(f.client.simulateContract).not.toHaveBeenCalled();
    expect(f.state.uri).toBe(f.original.metadataUri);
  });

  test.each([
    [legacyEndpointKey, 0], [endpointKey, 0],
    [legacyEndpointKey, 1], [endpointKey, 1],
    [legacyEndpointKey, 2], [endpointKey, 2],
  ] as const)("rejects a concurrent %s change after %s confirmed migration steps", async (key, completedSteps) => {
    const f = fixture(true, false, true);
    const input = f.input({ protocol: "a2a", endpoint: nextEndpoint, agentCardUrl });
    for (let index = 0; index < completedSteps; index++) {
      const plan = await f.manager.prepareUpdate(input);
      f.apply(plan.nextStep!.transaction.data);
    }
    f.state.records.set(key, "https://concurrent.example/changed");
    f.client.call.mockClear();
    await expect(f.manager.prepareUpdate(input)).rejects.toThrow("REGISTRATION_UPDATE_STATE_CHANGED");
    expect(f.client.call).not.toHaveBeenCalled();
    expect(f.client.simulateContract).not.toHaveBeenCalled();
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
  });

  test.each([
    { protocol: "a2a" },
    { protocol: "a2a", endpoint: nextEndpoint },
    { protocol: "a2a", agentCardUrl },
  ] satisfies ProviderUpdateInput["changes"][])("requires both explicit migration URLs: %j", async (changes) => {
    const f = fixture(true, false, true);
    await expect(f.manager.prepareUpdate(f.input(changes))).rejects.toThrow("REGISTRATION_A2A_TARGET_REQUIRED");
    expect(f.cardFetch).not.toHaveBeenCalled();
    expect(f.client.call).not.toHaveBeenCalled();
    expect(f.client.simulateContract).not.toHaveBeenCalled();
    expect(f.state.uri).toBe(f.original.metadataUri);
  });

  test.each([false, true])("rejects a mismatched Agent Card before simulating migration of active=%s", async (active) => {
    const f = fixture(active, false, true);
    const input = f.input({ protocol: "a2a", endpoint: nextEndpoint, agentCardUrl });
    f.card.url = "https://other.example/a2a";
    await expect(f.manager.prepareUpdate(input)).rejects.toThrow("REGISTRATION_A2A_CARD_INVALID");
    expect(f.cardFetch).toHaveBeenCalledTimes(1);
    expect(f.client.call).not.toHaveBeenCalled();
    expect(f.client.simulateContract).not.toHaveBeenCalled();
    expect(f.state.uri).toBe(f.original.metadataUri);
    expect(f.state.records.has(endpointKey)).toBe(false);
  });

  test("pauses an active A2A identity for a Card-only change and never writes ENS", async () => {
    const f = fixture(true, false);
    const nextCardUrl = "https://cards.example/vision/agent-card.json";
    const input = f.input({ agentCardUrl: nextCardUrl });
    const before = structuredClone(input);
    const originalRecords = new Map(f.state.records);
    const first = await f.manager.prepareUpdate(input);
    expect(first).toMatchObject({ completedSteps: 0, totalSteps: 2, nextStep: { kind: "pause" } });
    f.apply(first.nextStep!.transaction.data);
    expect(decodeMetadata(f.state.uri)).toEqual({ ...f.metadata, active: false });
    const second = await f.manager.prepareUpdate(input);
    expect(second).toMatchObject({ completedSteps: 1, totalSteps: 2, nextStep: { kind: "metadata" } });
    f.apply(second.nextStep!.transaction.data);
    expect(await f.manager.verifyUpdate(input)).toMatchObject({ updateVerified: true, agentCardVerified: true });
    expect(decodeMetadata(f.state.uri)).toEqual({
      ...f.metadata,
      services: [{ name: "ENS", endpoint: ensName }, { name: "A2A", endpoint: nextCardUrl }],
      interfaces: [{ protocol: "a2a", endpoint, agentCardUrl: nextCardUrl }],
    });
    expect(f.state.records).toEqual(originalRecords);
    expect(f.client.call.mock.calls.map(([call]) => decodeFunctionData({ abi: writeAbi, data: call.data }).functionName))
      .toEqual(["setAgentURI", "setAgentURI"]);
    expect(f.client.simulateContract).not.toHaveBeenCalled();
    expect(f.cardFetch.mock.calls.every(([url]) => url === nextCardUrl)).toBe(true);
    expect(input).toEqual(before);
  });
});

describe("Provider update fail-closed boundaries", () => {
  test("can deactivate an unavailable A2A service without treating its unreachable Card as verified", async () => {
    const f = fixture(true, false);
    f.cardFetch.mockRejectedValue(new Error("Card unavailable"));
    const input = f.input({ active: false });
    const plan = await f.manager.prepareUpdate(input);
    expect(plan).toMatchObject({ totalSteps: 1, nextStep: { kind: "metadata" }, agentCardVerified: false });
    f.apply(plan.nextStep!.transaction.data);
    expect(await f.manager.verifyUpdate(input)).toMatchObject({ updateVerified: true, agentCardVerified: false });
    expect(f.cardFetch).not.toHaveBeenCalled();
    expect(decodeMetadata(f.state.uri).active).toBe(false);
  });

  test("cannot activate an A2A service when the public Card is unavailable", async () => {
    const f = fixture(false, false);
    f.cardFetch.mockRejectedValue(new Error("Card unavailable"));
    await expect(f.manager.prepareUpdate(f.input({ active: true }))).rejects.toThrow("REGISTRATION_A2A_CARD_INVALID");
    expect(f.client.call).not.toHaveBeenCalled();
  });

  test.each([
    {}, { active: "true" }, { x402Support: null }, { description: 123 },
    { ensName: "other.example.eth" }, { payment: { network: "hedera:mainnet" } },
  ])("rejects unfilled, malformed, or unsupported changes: %j", async (changes) => {
    const f = fixture();
    await expect(f.manager.prepareUpdate({ ...f.input(), changes })).rejects.toThrow();
    expect(f.client.call).not.toHaveBeenCalled();
  });

  test.each(["metadata", "digest", "endpoint", "resolver", "owner", "association", "permission", "ens name"])(
    "rejects a stale or invalid %s before preparing a transaction", async (changed) => {
      const f = fixture();
      const input = f.input({ endpoint: nextEndpoint });
      switch (changed) {
        case "metadata": f.state.uri = encodeMetadata({ ...f.metadata, description: "Concurrent update" }).metadataUri; break;
        case "digest": input.expected.metadataSha256 = `0x${"ff".repeat(32)}`; break;
        case "endpoint": f.state.records.set(endpointKey, "https://other.example/a2a"); break;
        case "resolver": f.state.resolver = stranger; f.inspection.children[0].resolver = stranger; break;
        case "owner": f.state.owner = stranger; break;
        case "association": f.state.records.delete(registrationKey); break;
        case "permission": f.inspection.children[0].operatorCanWriteAllText = false; break;
        case "ens name": f.state.uri = encodeMetadata({ ...f.metadata, services: [
          { name: "ENS", endpoint: "vision-ocr.example.eth" }, { name: "A2A", endpoint: agentCardUrl },
        ] }).metadataUri; break;
      }
      await expect(f.manager.prepareUpdate(input)).rejects.toThrow();
      expect(f.client.call).not.toHaveBeenCalled();
      expect(f.client.sendTransaction).not.toHaveBeenCalled();
    },
  );

  test("does not accept switching ENS ahead of the required active-Provider pause", async () => {
    const f = fixture(true, true);
    const input = f.input({ endpoint: nextEndpoint });
    f.state.records.set(endpointKey, nextEndpoint);
    await expect(f.manager.prepareUpdate(input)).rejects.toThrow();
    expect(f.client.call).not.toHaveBeenCalled();
  });

  test("refuses to continue after an unrelated edit to paused metadata", async () => {
    const f = fixture(true, true);
    const input = f.input({ endpoint: nextEndpoint });
    const plan = await f.manager.prepareUpdate(input);
    f.apply(plan.nextStep!.transaction.data);
    f.state.uri = encodeMetadata({ ...decodeMetadata(f.state.uri), description: "Another operator changed this" }).metadataUri;
    f.client.call.mockClear();
    await expect(f.manager.prepareUpdate(input)).rejects.toThrow();
    expect(f.client.call).not.toHaveBeenCalled();
  });

  test.each([
    "http://network.example/a2a", "https://localhost/a2a",
    "https://127.0.0.1/a2a", "https://10.0.0.1/a2a",
    "https://user:secret@network.example/a2a", "javascript:alert(1)",
  ])("rejects an unsafe replacement endpoint: %s", async (unsafe) => {
    const f = fixture();
    await expect(f.manager.prepareUpdate(f.input({ endpoint: unsafe }))).rejects.toThrow();
    expect(f.client.call).not.toHaveBeenCalled();
  });

  test("does not report completion when final metadata and ENS differ", async () => {
    const f = fixture();
    const input = f.input({ endpoint: nextEndpoint });
    const plan = await f.manager.prepareUpdate(input);
    f.state.uri = plan.target.metadataUri;
    await expect(f.manager.verifyUpdate(input)).rejects.toThrow();
    await expect(f.manager.verifyCurrent(agentId)).rejects.toThrow();
  });

  test("propagates a failed next-step simulation without broadcasting or preparing later writes", async () => {
    const f = fixture(true, true);
    f.client.call.mockRejectedValue(new Error("Simulation reverted"));
    await expect(f.manager.prepareUpdate(f.input({ endpoint: nextEndpoint }))).rejects.toThrow();
    expect(f.client.call).toHaveBeenCalledTimes(1);
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
    expect(f.state.uri).toBe(f.original.metadataUri);
    expect(f.state.records.get(endpointKey)).toBe(endpoint);
  });
});

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionData,
  parseAbi, sha256, stringToHex, type Address, type Hex, type PublicClient,
} from "viem";
import { namehash } from "viem/ens";
import { EnsSubnameManager } from "@frely-network/ens/subnames";
import {
  IDENTITY_REGISTRY, identityWriteAbi, prepareRegistrationMetadata,
  ProviderRegistrationManager, registrationConfig, type RegistrationInput,
} from "./identity.ts";

// Synthetic chain responses exercise trust boundaries; they are not M3 evidence.
const operator: Address = "0x1111111111111111111111111111111111111111";
const stranger: Address = "0x2222222222222222222222222222222222222222";
const resolver: Address = "0x3333333333333333333333333333333333333333";
const hash = `0x${"aa".repeat(32)}` as Hex;
const blockHash = `0x${"bb".repeat(32)}` as Hex;
const registrationBlockHash = `0x${"cc".repeat(32)}` as Hex;
const blockNumber = 100n;
const agentId = "9007199254740993";
const endpoint = "https://provider.example/a2a";
const agentCardUrl = "https://provider.example/agent-card.json";
const ensName = "vision-basic.example.eth";
// Literal ERC-7930 encoding: version 1, EIP-155 family, Sepolia reference, registry address.
const registrationKey = `agent-registration[0x0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e][${agentId}]`;
const textAbi = parseAbi(["function setText(bytes32 node, string key, string value)"]);
const config = { rpcUrl: "https://rpc.example", operator, registryAddress: IDENTITY_REGISTRY };

function input(): RegistrationInput {
  return {
    manifest: {
      name: "vision-basic", description: "Synthetic vision Provider",
      capabilities: ["vision"], identity: { ens: ensName },
      interfaces: [{ protocol: "a2a", endpoint, agentCardUrl }],
      payment: { protocol: "x402", network: "hedera:testnet" },
    },
    active: false, x402Support: false,
  };
}

interface ContractCall {
  address: Address;
  functionName: string;
  args: readonly unknown[];
  blockNumber?: bigint;
}
interface EnsCall { name: string; key: string; blockNumber?: bigint; strict?: boolean; }

function registeredEvent(uri: string, owner = operator) {
  return {
    address: IDENTITY_REGISTRY as Address,
    topics: encodeEventTopics({ abi: identityWriteAbi, eventName: "Registered", args: { agentId: BigInt(agentId), owner } }),
    data: encodeAbiParameters([{ type: "string" }], [uri]),
  };
}

let inspectionSpy: ReturnType<typeof spyOn<EnsSubnameManager, "inspect">> | undefined;
afterEach(() => { inspectionSpy?.mockRestore(); inspectionSpy = undefined; });

function fixture() {
  const value = input();
  const prepared = prepareRegistrationMetadata(value);
  const inspection = {
    blockNumber, blockHash, timestamp: 1_800_000_000n,
    children: [{
      resolver, operatorCanWriteAllText: true,
      state: { status: 2, expiry: 1_800_086_400n },
    }],
  };
  inspectionSpy?.mockRestore();
  inspectionSpy = spyOn(EnsSubnameManager.prototype, "inspect")
    .mockResolvedValue(inspection as Awaited<ReturnType<EnsSubnameManager["inspect"]>>);
  const state = {
    chainId: 11155111, canonicalHash: registrationBlockHash, uri: prepared.metadataUri,
    owner: operator, records: new Map<string, string>(), ensRecords: new Map<string, string | null>(),
    receipt: {
      status: "success", to: IDENTITY_REGISTRY as Address | null, from: operator,
      transactionHash: hash, blockNumber: 90n, blockHash: registrationBlockHash,
      logs: [registeredEvent(prepared.metadataUri)],
    },
    transaction: {
      input: encodeFunctionData({ abi: identityWriteAbi, functionName: "register", args: [prepared.metadataUri] }),
      value: 0n,
    },
  };
  const client = {
    getChainId: mock(async () => state.chainId),
    getBlock: mock(async (call?: { blockNumber: bigint }) => ({
      number: call?.blockNumber ?? blockNumber,
      hash: call ? state.canonicalHash : blockHash,
    })),
    getCode: mock(async () => "0x1234" as Hex | undefined),
    getEnsResolver: mock(async (_call: { name: string; blockNumber?: bigint }) => resolver as Address | null),
    getEnsText: mock(async (call: EnsCall) => state.ensRecords.get(call.key) ?? null),
    simulateContract: mock(async (_call: ContractCall) => ({ result: 42n })),
    estimateGas: mock(async () => 123_456n),
    getTransactionReceipt: mock(async () => state.receipt),
    getTransaction: mock(async () => state.transaction),
    readContract: mock(async (call: ContractCall) => {
      if (call.functionName === "tokenURI") return state.uri;
      if (call.functionName === "ownerOf") return state.owner;
      if (call.functionName === "text") return state.records.get(call.args[1] as string) ?? "";
      throw new Error(`Unexpected read: ${call.functionName}`);
    }),
    sendTransaction: mock(() => { throw new Error("Must remain unsigned"); }),
    writeContract: mock(() => { throw new Error("Must remain unsigned"); }),
  };
  const manager = new ProviderRegistrationManager(config, client as unknown as PublicClient, {
    fetcher: async () => Response.json({ name: "vision", description: "Fixture", version: "1",
      protocolVersion: "0.3.0", preferredTransport: "JSONRPC", url: endpoint, capabilities: {},
      defaultInputModes: ["text"], defaultOutputModes: ["text"],
      skills: [{ id: "vision", name: "Vision", description: "Fixture", tags: [] }] }),
  });
  return { value, prepared, state, inspection, client, manager };
}

describe("Provider metadata preparation", () => {
  test.each([[false, false], [true, false], [false, true], [true, true]])(
    "preserves availability/payment declarations %s/%s without asserting verification", (active, x402Support) => {
      const value = { ...input(), active, x402Support };
      const before = structuredClone(value);
      const result = prepareRegistrationMetadata(value);
      const json = Buffer.from(result.metadataUri.split(",")[1], "base64").toString("utf8");
      expect(result.metadataUri.startsWith("data:application/json;base64,")).toBe(true);
      expect(JSON.parse(json)).toEqual(result.metadata);
      expect(result.metadataSha256).toBe(sha256(stringToHex(json)));
      expect(result.metadata).toMatchObject({ active, x402Support, payment: { network: "hedera:testnet" } });
      expect(result.discoveryEligible).toBe(active);
      expect(result.executionVerified).toBe(false);
      expect(result.paymentVerified).toBe(false);
      expect(result.metadata).not.toHaveProperty("agentId");
      expect(result.metadata).not.toHaveProperty("registrations");
      expect(value).toEqual(before);
    },
  );

  test("requires explicit boolean flags and a chain-assigned identity", () => {
    for (const value of [null, {}, { ...input(), active: "true" }, { ...input(), x402Support: undefined }]) {
      expect(() => prepareRegistrationMetadata(value)).toThrow("REGISTRATION_FLAGS_REQUIRED");
    }
    const value = input();
    value.manifest.identity.agentId = "42";
    expect(() => prepareRegistrationMetadata(value)).toThrow("REGISTRATION_ID_ASSIGNED_BY_CHAIN");
  });

  test.each(["http://provider.example/a2a", "https://localhost/a2a", "https://127.0.0.1/a2a", "https://10.0.0.1/a2a"])(
    "rejects an endpoint unsuitable for publication: %s", (unsafe) => {
      const value = input();
      expect(() => prepareRegistrationMetadata({
        ...value, manifest: { ...value.manifest, interfaces: [{ protocol: "a2a", endpoint: unsafe, agentCardUrl }] },
      })).toThrow();
    },
  );

  test("rejects incomplete or wrong-chain registry configuration", () => {
    const env = {
      IDENTITY_CHAIN_ID: "11155111", ENS_SEPOLIA_RPC_URL: config.rpcUrl,
      ERC8004_IDENTITY_REGISTRY: IDENTITY_REGISTRY, ENS_OPERATOR_ADDRESS: operator,
    };
    expect(registrationConfig(env)).toEqual(config);
    for (const invalid of [{}, { ...env, IDENTITY_CHAIN_ID: "1" }, { ...env, ERC8004_IDENTITY_REGISTRY: stranger },
      { ...env, ENS_SEPOLIA_RPC_URL: "http://rpc.example" }, { ...env, ENS_OPERATOR_ADDRESS: "invalid" }]) {
      expect(() => registrationConfig(invalid)).toThrow("REGISTRATION_CONFIG_INVALID");
    }
  });
});

describe("unsigned ERC-8004 registration", () => {
  test("simulates register but never publishes the predicted ID or broadcasts", async () => {
    const f = fixture();
    const result = await f.manager.prepareRegister(f.value);
    expect(result).toMatchObject({ broadcast: false, simulated: true, agentId: null, gasEstimate: 123_456n });
    expect(result.transaction).toMatchObject({ chainId: 11155111, from: operator, to: IDENTITY_REGISTRY, value: "0" });
    expect(decodeFunctionData({ abi: identityWriteAbi, data: result.transaction.data }))
      .toMatchObject({ functionName: "register", args: [f.prepared.metadataUri] });
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
    expect(f.client.writeContract).not.toHaveBeenCalled();
    expect(f.client.simulateContract.mock.calls[0][0].blockNumber).toBe(blockNumber);
  });

  test("requires the expected chain, deployed registry, and ENS write permission before simulation", async () => {
    const wrongChain = fixture();
    wrongChain.state.chainId = 1;
    await expect(wrongChain.manager.prepareRegister(wrongChain.value)).rejects.toThrow("REGISTRATION_CHAIN_MISMATCH");
    expect(wrongChain.client.simulateContract).not.toHaveBeenCalled();
    const missingContract = fixture();
    missingContract.client.getCode.mockResolvedValue("0x");
    await expect(missingContract.manager.prepareRegister(missingContract.value)).rejects.toThrow("REGISTRATION_CONTRACT_MISSING");
    const noPermission = fixture();
    noPermission.inspection.children[0].operatorCanWriteAllText = false;
    await expect(noPermission.manager.prepareRegister(noPermission.value)).rejects.toThrow("REGISTRATION_ENS_WRITE_PERMISSION_MISSING");
    expect(noPermission.client.simulateContract).not.toHaveBeenCalled();
  });

  test("takes the exact uint256 ID only from the confirmed Registry event", async () => {
    const f = fixture();
    expect(await f.manager.readRegistration(f.value, hash)).toMatchObject({
      agentId, transactionHash: hash, registrationBlock: 90n, registrationBlockHash,
    });
    expect(f.client.simulateContract).not.toHaveBeenCalled();
  });

  test("reconstructs the exact historical Responses receipt without allowing a new Responses registration", async () => {
    const f = fixture();
    const legacyEndpoint = "https://provider.example/v1/responses";
    const legacyInput = {
      ...f.value,
      manifest: {
        ...f.value.manifest,
        interfaces: [{ protocol: "responses", endpoint: "https://PROVIDER.example:443/v1/responses" }],
      },
    };
    // This is the original writer's field order and shape, including no interfaces extension.
    const metadata = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "vision-basic", description: "Synthetic vision Provider",
      services: [{ name: "ENS", endpoint: ensName }, { name: "responses", endpoint: legacyEndpoint }],
      active: false, x402Support: false, capabilities: ["vision"],
      payment: { protocol: "x402", network: "hedera:testnet" },
    };
    const json = JSON.stringify(metadata);
    const metadataUri = `data:application/json;base64,${Buffer.from(json).toString("base64")}`;
    f.state.uri = metadataUri;
    f.state.receipt.logs = [registeredEvent(metadataUri)];
    f.state.transaction.input = encodeFunctionData({ abi: identityWriteAbi, functionName: "register", args: [metadataUri] });
    f.state.ensRecords.set("agent-endpoint[responses]", legacyEndpoint);
    f.state.ensRecords.set(registrationKey, "historical-association");

    const result = await f.manager.readRegistration(legacyInput, hash);
    expect(result).toMatchObject({
      agentId, ensName, protocol: "responses", endpoint: legacyEndpoint,
      endpointKey: "agent-endpoint[responses]", metadata, metadataUri,
      metadataSha256: sha256(stringToHex(json)), discoveryEligible: false,
    });
    expect(result.metadata).not.toHaveProperty("interfaces");
    expect(result.metadata).not.toHaveProperty("agentId");
    expect(await f.manager.verify(legacyInput, hash)).toMatchObject({ registrationAndEnsVerified: true });
    expect(f.client.getEnsText.mock.calls.map(([call]) => call.key))
      .toEqual(["agent-endpoint[responses]", registrationKey]);
    expect(() => prepareRegistrationMetadata(legacyInput)).toThrow("REGISTRATION_INPUT_INVALID");
    await expect(f.manager.prepareRegister(legacyInput)).rejects.toThrow("REGISTRATION_INPUT_INVALID");
    expect(f.client.simulateContract).not.toHaveBeenCalled();
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
    expect(f.client.writeContract).not.toHaveBeenCalled();
  });

  test("rejects a malformed hash before receipt lookup", async () => {
    const f = fixture();
    await expect(f.manager.readRegistration(f.value, "0x1234")).rejects.toThrow("REGISTRATION_TX_HASH_INVALID");
    expect(f.client.getTransactionReceipt).not.toHaveBeenCalled();
  });

  test.each([
    ["wrong target", "REGISTRATION_TX_MISMATCH"], ["wrong sender", "REGISTRATION_TX_MISMATCH"],
    ["wrong hash", "REGISTRATION_TX_MISMATCH"], ["reverted", "REGISTRATION_TX_REVERTED"],
    ["reorg", "REGISTRATION_TX_REORGED"], ["calldata", "REGISTRATION_TX_CALLDATA_MISMATCH"],
    ["value", "REGISTRATION_TX_CALLDATA_MISMATCH"], ["missing event", "REGISTRATION_EVENT_MISSING_OR_AMBIGUOUS"],
    ["foreign emitter", "REGISTRATION_EVENT_MISSING_OR_AMBIGUOUS"], ["duplicate event", "REGISTRATION_EVENT_MISSING_OR_AMBIGUOUS"],
    ["event URI", "REGISTRATION_EVENT_MISMATCH"], ["event owner", "REGISTRATION_EVENT_MISMATCH"],
  ])("rejects registration evidence with %s", async (kind, code) => {
    const f = fixture();
    switch (kind) {
      case "wrong target": f.state.receipt.to = stranger; break;
      case "wrong sender": f.state.receipt.from = stranger; break;
      case "wrong hash": f.state.receipt.transactionHash = blockHash; break;
      case "reverted": f.state.receipt.status = "reverted"; break;
      case "reorg": f.state.canonicalHash = blockHash; break;
      case "calldata": f.state.transaction.input = encodeFunctionData({ abi: identityWriteAbi, functionName: "register", args: ["data:application/json,{}"] }); break;
      case "value": f.state.transaction.value = 1n; break;
      case "missing event": f.state.receipt.logs = []; break;
      case "foreign emitter": f.state.receipt.logs[0].address = stranger; break;
      case "duplicate event": f.state.receipt.logs.push(registeredEvent(f.prepared.metadataUri)); break;
      case "event URI": f.state.receipt.logs = [registeredEvent("data:application/json,{}")]; break;
      case "event owner": f.state.receipt.logs = [registeredEvent(f.prepared.metadataUri, stranger)]; break;
    }
    await expect(f.manager.readRegistration(f.value, hash)).rejects.toThrow(code);
  });
});

describe("ENS binding and readback", () => {
  test("builds the exact ENSIP-25 key from the receipt ID and the matching endpoint", async () => {
    const f = fixture();
    const result = await f.manager.prepareEns(f.value, hash);
    expect(result.records).toEqual([
      { key: "agent-endpoint[a2a]", value: endpoint }, { key: registrationKey, value: "1" },
    ]);
    expect(result.transactions).toHaveLength(2);
    for (const [index, entry] of result.transactions.entries()) {
      expect(entry.transaction).toMatchObject({ from: operator, to: resolver, value: "0" });
      expect(decodeFunctionData({ abi: textAbi, data: entry.transaction.data })).toMatchObject({
        functionName: "setText", args: [namehash(ensName), result.records[index].key, result.records[index].value],
      });
    }
    for (const [call] of f.client.readContract.mock.calls) expect(call.blockNumber).toBe(blockNumber);
    expect(f.client.sendTransaction).not.toHaveBeenCalled();
  });

  test("reruns skip matching records and accept an existing nonempty ENSIP-25 value", async () => {
    const f = fixture();
    f.state.records.set("agent-endpoint[a2a]", endpoint);
    f.state.records.set(registrationKey, "already-approved");
    expect(await f.manager.prepareEns(f.value, hash)).toMatchObject({ action: "no_change", transactions: [] });
    expect(f.client.simulateContract).not.toHaveBeenCalled();
  });

  test("rejects an existing conflicting endpoint instead of overwriting it", async () => {
    const f = fixture();
    f.state.records.set("agent-endpoint[a2a]", "https://other.example/a2a");
    await expect(f.manager.prepareEns(f.value, hash)).rejects.toThrow("REGISTRATION_ENS_RECORD_CONFLICT");
    expect(f.client.simulateContract).not.toHaveBeenCalled();
  });

  test.each(["uri", "owner", "resolver"])("rejects changed on-chain %s before preparing ENS writes", async (changed) => {
    const f = fixture();
    if (changed === "uri") f.state.uri = "data:application/json,{}";
    if (changed === "owner") f.state.owner = stranger;
    if (changed === "resolver") f.client.getEnsResolver.mockResolvedValue(stranger);
    await expect(f.manager.prepareEns(f.value, hash)).rejects.toThrow(
      changed === "resolver" ? "REGISTRATION_ENS_RESOLVER_MISMATCH" : "REGISTRATION_ONCHAIN_MISMATCH",
    );
    expect(f.client.simulateContract).not.toHaveBeenCalled();
  });

  test("uses strict Universal Resolver readback pinned to the identity block without claiming Graph/payment", async () => {
    const f = fixture();
    f.state.ensRecords.set("agent-endpoint[a2a]", endpoint);
    f.state.ensRecords.set(registrationKey, "confirmed");
    const result = await f.manager.verify(f.value, hash);
    expect(result).toMatchObject({
      registrationAndEnsVerified: true, graphVerified: false, executionVerified: false, paymentVerified: false,
      discoveryEligible: false, broadcast: false,
    });
    expect(f.client.getEnsText.mock.calls.map(([call]) => call)).toEqual([
      { name: ensName, key: "agent-endpoint[a2a]", blockNumber, strict: true },
      { name: ensName, key: registrationKey, blockNumber, strict: true },
    ]);
    for (const [call] of f.client.readContract.mock.calls) expect(call.blockNumber).toBe(blockNumber);
    expect(f.client.writeContract).not.toHaveBeenCalled();
  });

  test.each(["missing endpoint", "wrong endpoint", "missing association"])("fails closed on %s in Universal Resolver readback", async (problem) => {
    const f = fixture();
    f.state.ensRecords.set("agent-endpoint[a2a]", endpoint);
    f.state.ensRecords.set(registrationKey, "1");
    if (problem === "missing endpoint") f.state.ensRecords.delete("agent-endpoint[a2a]");
    if (problem === "wrong endpoint") f.state.ensRecords.set("agent-endpoint[a2a]", "https://other.example/a2a");
    if (problem === "missing association") f.state.ensRecords.set(registrationKey, "");
    await expect(f.manager.verify(f.value, hash)).rejects.toThrow("REGISTRATION_ENS_READBACK_FAILED");
  });
});

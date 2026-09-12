import { describe, expect, mock, test } from "bun:test";
import {
  decodeFunctionData,
  keccak256,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { namehash } from "viem/ens";
import {
  ENSV2_SUBNAME_DEPLOYMENT as deployment,
  factoryAbi,
  registryAbi,
  registryInitAbi,
  registrySalt,
  resolverNameResource,
  ROLE_REGISTRAR,
  ROLE_SET_SUBREGISTRY,
  ROLE_SET_TEXT,
  SUBNAME_OWNER_ROLES,
  SUBREGISTRY_ROOT_ROLES,
} from "./subname-contracts.ts";
import { EnsSubnameManager, type RegistryNameState, type SubnameOptions } from "./subnames.ts";

const operator: Address = "0x1111111111111111111111111111111111111111";
const stranger: Address = "0x2222222222222222222222222222222222222222";
const resolver: Address = "0x3333333333333333333333333333333333333333";
const subregistry: Address = "0x4444444444444444444444444444444444444444";
const otherResolver: Address = "0x5555555555555555555555555555555555555555";
const blockNumber = 12345n;
const timestamp = 1_800_000_000n;
const expiry = timestamp + 86_400n;
const blockHash = `0x${"ab".repeat(32)}` as Hex;
const options: SubnameOptions = { parent: "frely.eth", operator };
const labels = ["vision-basic", "vision-ocr"];
const labelId = (label: string) => BigInt(keccak256(stringToHex(label)));

function state(status = 0, latestOwner: Address = operator): RegistryNameState {
  return { status, expiry, latestOwner, tokenId: 1n, resource: 1n };
}

interface Call {
  address: Address;
  functionName: string;
  args: readonly unknown[];
  account?: Address;
  blockNumber?: bigint;
}

function fixture() {
  const setup = {
    chainId: deployment.chainId as number,
    block: { number: blockNumber as bigint | null, hash: blockHash as Hex | null, timestamp },
    ethRegistry: deployment.ethRegistry as Address,
    parent: state(2),
    resolver: resolver as Address,
    subregistry: zeroAddress as Address,
    registryImplementation: deployment.userRegistryImplementation as Address,
    resolverImplementation: deployment.resolverImplementation as Address,
    canSetSubregistry: true,
    canRegister: true,
    textPermission: true,
    children: new Map(labels.map((label) => [labelId(label), state()])),
    childResolver: resolver as Address,
    universalResolver: resolver as Address | null,
    text: "Existing description",
    universalText: "Existing description" as string | null,
    deploymentResult: subregistry as Address,
  };
  const readContract = mock(async (call: Call): Promise<unknown> => {
    const { address, functionName, args } = call;
    if (address === deployment.rootRegistry && functionName === "getSubregistry" && args[0] === "eth") {
      return setup.ethRegistry;
    }
    if (address === deployment.factory && functionName === "verifyContract") {
      return args[0] === setup.resolver ? setup.resolverImplementation : setup.registryImplementation;
    }
    if (address === deployment.ethRegistry) {
      if (functionName === "getState" && args[0] === labelId("frely")) return setup.parent;
      if (functionName === "getResolver" && args[0] === "frely") return setup.resolver;
      if (functionName === "getSubregistry" && args[0] === "frely") return setup.subregistry;
      if (functionName === "hasRoles" && args[0] === labelId("frely") && args[1] === ROLE_SET_SUBREGISTRY && args[2] === operator) {
        return setup.canSetSubregistry;
      }
    }
    if (address === subregistry) {
      if (functionName === "hasRoles" && args[0] === 0n && args[1] === ROLE_REGISTRAR && args[2] === operator) return setup.canRegister;
      if (functionName === "getState") return setup.children.get(args[0] as bigint) ?? state();
      if (functionName === "getResolver") return setup.childResolver;
    }
    if (address === setup.resolver) {
      if (functionName === "hasRoles" && args[1] === ROLE_SET_TEXT && args[2] === operator) {
        expect(labels.map((label) => resolverNameResource(`${label}.frely.eth`))).toContain(args[0] as bigint);
        return setup.textPermission;
      }
      if (functionName === "text" && args[1] === "description") return setup.text;
    }
    throw new Error(`Unexpected contract read: ${address} ${functionName}`);
  });
  const simulateContract = mock(async (call: Call) => ({ result: call.functionName === "deployProxy" ? setup.deploymentResult : undefined }));
  const getCode = mock(async (_call: { address: Address; blockNumber?: bigint }) => "0x1234" as Hex | undefined);
  const getEnsResolver = mock(async (_call: { name: string; blockNumber?: bigint }) => setup.universalResolver);
  const getEnsText = mock(async (_call: { name: string; key: string; blockNumber?: bigint }) => setup.universalText);
  const writeContract = mock(() => { throw new Error("Transactions must never be broadcast"); });
  const sendTransaction = mock(() => { throw new Error("Transactions must never be broadcast"); });
  const client = {
    getChainId: mock(async () => setup.chainId),
    getBlock: mock(async () => setup.block),
    getCode, readContract, simulateContract, getEnsResolver, getEnsText, writeContract, sendTransaction,
  };
  const manager = new EnsSubnameManager("https://rpc.example", client as unknown as PublicClient);
  const registeredChildren = () => {
    setup.subregistry = subregistry;
    for (const label of labels) setup.children.set(labelId(label), state(2));
  };
  const assertReadOnlyAndPinned = () => {
    expect(writeContract).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    for (const fn of [getCode, readContract, simulateContract, getEnsResolver, getEnsText]) {
      for (const [call] of fn.mock.calls) expect(call.blockNumber).toBe(blockNumber);
    }
  };
  return { setup, client, manager, registeredChildren, assertReadOnlyAndPinned };
}

describe("ENSv2 subname inspection", () => {
  test("inspects an owned parent without a child registry at one pinned block", async () => {
    const f = fixture();
    const result = await f.manager.inspect(options);
    expect(result).toMatchObject({ chainId: 11155111, blockNumber, blockHash, timestamp, canRegisterSubnames: false });
    expect(result.parent).toMatchObject({ name: "frely.eth", operatorIsOwner: true, canSetSubregistry: true, subregistry: zeroAddress });
    expect(result.children.map((child) => [child.name, child.state, child.operatorCanWriteAllText])).toEqual([
      ["vision-basic.frely.eth", null, true], ["vision-ocr.frely.eth", null, true],
    ]);
    expect(f.client.simulateContract).not.toHaveBeenCalled();
    f.assertReadOnlyAndPinned();
  });

  test("rejects a different chain before reading contracts", async () => {
    const f = fixture();
    f.setup.chainId = 1;
    await expect(f.manager.inspect(options)).rejects.toThrow("ENS_CHAIN_MISMATCH");
    expect(f.client.readContract).not.toHaveBeenCalled();
  });

  test("rejects unavailable blocks, missing bytecode, and a mismatched official registry", async () => {
    const absentBlock = fixture();
    absentBlock.setup.block.hash = null;
    await expect(absentBlock.manager.inspect(options)).rejects.toThrow("ENS_BLOCK_UNAVAILABLE");
    const absentContract = fixture();
    absentContract.client.getCode.mockResolvedValue("0x");
    await expect(absentContract.manager.inspect(options)).rejects.toThrow("ENS_CONTRACT_MISSING");
    const wrongRegistry = fixture();
    wrongRegistry.setup.ethRegistry = stranger;
    await expect(wrongRegistry.manager.inspect(options)).rejects.toThrow("ENS_DEPLOYMENT_MISMATCH");
  });

  test("rejects unregistered or expired parents", async () => {
    for (const parent of [state(0), { ...state(2), expiry: timestamp }]) {
      const f = fixture();
      f.setup.parent = parent;
      await expect(f.manager.inspect(options)).rejects.toThrow("ENS_PARENT_NOT_REGISTERED");
    }
  });

  test("requires a deployed official resolver and matching universal resolution", async () => {
    const absent = fixture();
    absent.setup.resolver = zeroAddress;
    await expect(absent.manager.inspect(options)).rejects.toThrow("ENS_RESOLVER_MISSING");
    const incompatible = fixture();
    incompatible.setup.resolverImplementation = stranger;
    await expect(incompatible.manager.inspect(options)).rejects.toThrow("ENS_DEPLOYMENT_MISMATCH");
    const mismatch = fixture();
    mismatch.setup.universalResolver = otherResolver;
    await expect(mismatch.manager.inspect(options)).rejects.toThrow("ENS_RESOLVER_MISMATCH");
  });

  test("does not infer child text permission from parent ownership or registry roles", async () => {
    const f = fixture();
    f.setup.textPermission = false;
    const inspected = await f.manager.inspect(options);
    expect(inspected.parent.operatorIsOwner).toBe(true);
    expect(inspected.children.every((child) => !child.operatorCanWriteAllText)).toBe(true);
    await expect(f.manager.prepareSubregistry(options)).rejects.toThrow("ENS_TEXT_PERMISSION_MISSING");
    expect(f.client.simulateContract).not.toHaveBeenCalled();
  });

  test("does not expose RPC credentials in upstream failures", async () => {
    const f = fixture();
    const secret = "https://user:rpc-secret@rpc.example/private-api-key";
    f.client.readContract.mockRejectedValue(new Error(`Request failed: ${secret}`));
    try {
      await f.manager.inspect(options);
      throw new Error("Expected inspection failure");
    } catch (error) {
      expect(String(error)).toBe("SubnameError: ENS_SUBNAME_READ_FAILED");
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("ENSv2 unsigned child registry preparation", () => {
  test("simulates official proxy deployment with deterministic salt and minimal root roles", async () => {
    const f = fixture();
    const result = await f.manager.prepareSubregistry(options);
    expect(result).toMatchObject({ action: "deploy_subregistry", broadcast: false, simulated: true, subregistry });
    expect(result.transaction).toMatchObject({ chainId: 11155111, from: operator, to: deployment.factory, value: "0" });
    const decoded = decodeFunctionData({ abi: factoryAbi, data: result.transaction!.data });
    expect(decoded.functionName).toBe("deployProxy");
    if (decoded.functionName !== "deployProxy") throw new Error("Wrong function");
    expect(decoded.args[0].toLowerCase()).toBe(deployment.userRegistryImplementation);
    expect(decoded.args[1]).toBe(registrySalt("frely.eth"));
    const init = decodeFunctionData({ abi: registryInitAbi, data: decoded.args[2] });
    const minimumRoles = 1n | (1n << 16n) | (1n << 128n) | (1n << 144n);
    expect(SUBREGISTRY_ROOT_ROLES).toBe(minimumRoles);
    expect(init.args).toEqual([operator, minimumRoles]);
    expect(f.client.simulateContract).toHaveBeenCalledTimes(1);
    expect(f.client.simulateContract.mock.calls[0][0]).toMatchObject({ account: operator, functionName: "deployProxy" });
    f.assertReadOnlyAndPinned();
  });

  test("requires the parent owner and permission to attach a child registry", async () => {
    const ownerMismatch = fixture();
    ownerMismatch.setup.parent.latestOwner = stranger;
    await expect(ownerMismatch.manager.prepareSubregistry(options)).rejects.toThrow("ENS_PARENT_OWNER_MISMATCH");
    const noPermission = fixture();
    noPermission.setup.canSetSubregistry = false;
    await expect(noPermission.manager.prepareSubregistry(options)).rejects.toThrow("ENS_SUBREGISTRY_PERMISSION_MISSING");
    expect(ownerMismatch.client.simulateContract).not.toHaveBeenCalled();
    expect(noPermission.client.simulateContract).not.toHaveBeenCalled();
  });

  test("simulates attachment of an official empty registry without broadcasting", async () => {
    const f = fixture();
    const result = await f.manager.prepareSubregistry(options, subregistry);
    expect(result).toMatchObject({ action: "attach_subregistry", broadcast: false, simulated: true, subregistry });
    expect(result.transaction?.to).toBe(deployment.ethRegistry);
    const decoded = decodeFunctionData({ abi: registryAbi, data: result.transaction!.data });
    expect(decoded).toMatchObject({ functionName: "setSubregistry", args: [labelId("frely"), subregistry] });
    expect(f.client.simulateContract.mock.calls[0][0]).toMatchObject({ functionName: "setSubregistry", account: operator });
    f.assertReadOnlyAndPinned();
  });

  test("rejects incompatible registries, missing registrar permission, and occupied target labels", async () => {
    const incompatible = fixture();
    incompatible.setup.registryImplementation = stranger;
    await expect(incompatible.manager.prepareSubregistry(options, subregistry)).rejects.toThrow("ENS_DEPLOYMENT_MISMATCH");
    const unauthorized = fixture();
    unauthorized.setup.canRegister = false;
    await expect(unauthorized.manager.prepareSubregistry(options, subregistry)).rejects.toThrow("ENS_REGISTRAR_PERMISSION_MISSING");
    const occupied = fixture();
    occupied.setup.children.set(labelId("vision-ocr"), state(2, stranger));
    await expect(occupied.manager.prepareSubregistry(options, subregistry)).rejects.toThrow("ENS_SUBREGISTRY_NOT_EMPTY");
    for (const f of [incompatible, unauthorized, occupied]) expect(f.client.simulateContract).not.toHaveBeenCalled();
  });

  test("keeps an existing official registry, rejecting conflicts and missing permissions", async () => {
    const f = fixture();
    f.setup.subregistry = subregistry;
    expect(await f.manager.prepareSubregistry(options)).toMatchObject({ action: "no_change", broadcast: false, simulated: false, subregistry });
    await expect(f.manager.prepareSubregistry(options, stranger)).rejects.toThrow("ENS_SUBREGISTRY_CONFLICT");
    f.setup.canRegister = false;
    await expect(f.manager.prepareSubregistry(options)).rejects.toThrow("ENS_REGISTRAR_PERMISSION_MISSING");
    expect(f.client.simulateContract).not.toHaveBeenCalled();
  });

  test("rejects a zero deployment result and sanitizes simulation errors", async () => {
    const zero = fixture();
    zero.setup.deploymentResult = zeroAddress;
    await expect(zero.manager.prepareSubregistry(options)).rejects.toThrow("ENS_DEPLOYMENT_MISMATCH");
    const failure = fixture();
    failure.client.simulateContract.mockRejectedValue(new Error("RPC https://secret@example.com"));
    await expect(failure.manager.prepareSubregistry(options)).rejects.toThrow("ENS_SUBNAME_PREPARATION_FAILED");
  });
});

describe("ENSv2 unsigned subname registration", () => {
  test("uses the parent's absolute expiry, owner role bitmap, and existing resolver", async () => {
    const f = fixture();
    f.setup.subregistry = subregistry;
    const result = await f.manager.prepareSubname(options, "vision-basic");
    expect(result).toMatchObject({ action: "register_subname", broadcast: false, simulated: true, expiry, name: "vision-basic.frely.eth" });
    const expectedRoles = (1n << 12n) | (1n << 20n) | (1n << 148n) | (1n << 24n) | (1n << 152n) | (1n << 156n);
    expect(SUBNAME_OWNER_ROLES).toBe(expectedRoles);
    expect(decodeFunctionData({ abi: registryAbi, data: result.transaction!.data })).toMatchObject({
      functionName: "register", args: ["vision-basic", operator, zeroAddress, resolver, expectedRoles, expiry],
    });
    expect(result.transaction?.to).toBe(subregistry);
    expect(f.client.simulateContract.mock.calls[0][0]).toMatchObject({ functionName: "register", account: operator });
    f.assertReadOnlyAndPinned();
  });

  test("returns no_change only for an existing matching, unexpired child", async () => {
    const f = fixture();
    f.registeredChildren();
    expect(await f.manager.prepareSubname(options, "vision-basic")).toMatchObject({ action: "no_change", broadcast: false, simulated: false });
    expect(f.client.simulateContract).not.toHaveBeenCalled();
    f.setup.children.set(labelId("vision-basic"), state(2, stranger));
    await expect(f.manager.prepareSubname(options, "vision-basic")).rejects.toThrow("ENS_SUBNAME_OWNER_MISMATCH");
    f.setup.children.set(labelId("vision-basic"), { ...state(2), expiry: timestamp });
    await expect(f.manager.prepareSubname(options, "vision-basic")).rejects.toThrow("ENS_SUBNAME_NOT_REGISTERED");
  });

  test("rejects missing registry, reserved child, and missing registrar permission", async () => {
    const f = fixture();
    await expect(f.manager.prepareSubname(options, "vision-basic")).rejects.toThrow("ENS_SUBREGISTRY_MISSING");
    f.setup.subregistry = subregistry;
    f.setup.children.set(labelId("vision-basic"), state(1));
    await expect(f.manager.prepareSubname(options, "vision-basic")).rejects.toThrow("ENS_SUBNAME_RESERVED");
    f.setup.children.set(labelId("vision-basic"), state());
    f.setup.canRegister = false;
    await expect(f.manager.prepareSubname(options, "vision-basic")).rejects.toThrow("ENS_REGISTRAR_PERMISSION_MISSING");
    expect(f.client.simulateContract).not.toHaveBeenCalled();
  });

  test("does not overwrite a child using another resolver", async () => {
    const f = fixture();
    f.registeredChildren();
    f.setup.childResolver = otherResolver;
    await expect(f.manager.prepareSubname(options, "vision-basic")).rejects.toThrow("ENS_TEXT_PERMISSION_MISSING");
    await expect(f.manager.verify(options)).rejects.toThrow("ENS_RESOLVER_MISMATCH");
    expect(f.client.simulateContract).not.toHaveBeenCalled();
  });
});

describe("ENSv2 subname verification", () => {
  test("cannot verify a parent without a registry or unregistered child names", async () => {
    const f = fixture();
    await expect(f.manager.verify(options)).rejects.toThrow("ENS_SUBREGISTRY_MISSING");
    f.setup.subregistry = subregistry;
    await expect(f.manager.verify(options)).rejects.toThrow("ENS_SUBNAME_NOT_REGISTERED");
    expect(f.client.simulateContract).not.toHaveBeenCalled();
  });

  test("verifies universal resolution and simulates reapplying only existing description records", async () => {
    const f = fixture();
    f.registeredChildren();
    const result = await f.manager.verify(options);
    expect(result).toMatchObject({ scope: "ens_subnames_only", broadcast: false, registrationVerified: true, textWriteSimulated: true, providerIdentityVerified: false });
    expect(f.client.simulateContract).toHaveBeenCalledTimes(2);
    for (const [index, label] of labels.entries()) {
      expect(f.client.simulateContract.mock.calls[index][0]).toMatchObject({
        address: resolver, functionName: "setText", args: [namehash(`${label}.frely.eth`), "description", f.setup.text], account: operator,
      });
    }
    expect(f.client.getEnsText.mock.calls.map(([call]) => call.name)).toEqual(labels.map((label) => `${label}.frely.eth`));
    f.assertReadOnlyAndPinned();
  });

  test("treats missing text as empty without inventing a Provider endpoint", async () => {
    const f = fixture();
    f.registeredChildren();
    f.setup.text = "";
    f.setup.universalText = null;
    expect((await f.manager.verify(options)).providerIdentityVerified).toBe(false);
    expect(f.client.simulateContract.mock.calls[0][0].args[2]).toBe("");
  });

  test("rejects record readback mismatch and insufficient write permission", async () => {
    const mismatch = fixture();
    mismatch.registeredChildren();
    mismatch.setup.universalText = "Unexpected record";
    await expect(mismatch.manager.verify(options)).rejects.toThrow("ENS_RECORD_READBACK_MISMATCH");
    expect(mismatch.client.simulateContract).not.toHaveBeenCalled();
    const unauthorized = fixture();
    unauthorized.registeredChildren();
    unauthorized.setup.textPermission = false;
    await expect(unauthorized.manager.verify(options)).rejects.toThrow("ENS_TEXT_PERMISSION_MISSING");
    expect(unauthorized.client.simulateContract).not.toHaveBeenCalled();
  });

  test("sanitizes failed write simulation without broadcasting", async () => {
    const f = fixture();
    f.registeredChildren();
    f.client.simulateContract.mockRejectedValue(new Error("RPC https://token-secret@example.com"));
    await expect(f.manager.verify(options)).rejects.toThrow("ENS_SUBNAME_VERIFICATION_FAILED");
    f.assertReadOnlyAndPinned();
  });
});

describe("ENSv2 subname input validation", () => {
  test("rejects unsafe names, labels, and operators before reading contracts", async () => {
    const invalid: SubnameOptions[] = [
      { ...options, parent: "eth" },
      { ...options, parent: "child.frely.eth" },
      { ...options, parent: "frely.com" },
      { ...options, operator: zeroAddress },
      { ...options, operator: "not-an-address" as Address },
      { ...options, labels: [] },
      { ...options, labels: ["vision-basic", "vision-basic"] },
      ...["vision.basic", "Vision", "-vision", "vision-", "a".repeat(64)].map((label) => ({ ...options, labels: [label] })),
    ];
    for (const input of invalid) {
      const f = fixture();
      await expect(f.manager.inspect(input)).rejects.toThrow("ENS_SUBNAME_INPUT_INVALID");
      expect(f.client.getChainId).not.toHaveBeenCalled();
    }
  });

  test("rejects invalid attachment addresses and unsupported RPC schemes", async () => {
    const f = fixture();
    for (const address of [zeroAddress, "bad-address" as Address]) {
      await expect(f.manager.prepareSubregistry(options, address)).rejects.toThrow("ENS_SUBNAME_INPUT_INVALID");
    }
    expect(f.client.getChainId).not.toHaveBeenCalled();
    for (const rpcUrl of ["not-a-url", "file:///local-secret", "ftp://example.com"]) {
      expect(() => new EnsSubnameManager(rpcUrl)).toThrow("ENS_RPC_CONFIG_INVALID");
    }
  });
});

import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { namehash, normalize } from "viem/ens";
import { sepolia } from "viem/chains";
import {
  ENSV2_SUBNAME_DEPLOYMENT,
  factoryAbi,
  registryAbi,
  registryInitAbi,
  registrySalt,
  resolverNameResource,
  resolverPermissionAbi,
  ROLE_REGISTRAR,
  ROLE_SET_SUBREGISTRY,
  ROLE_SET_TEXT,
  SUBNAME_OWNER_ROLES,
  SUBREGISTRY_ROOT_ROLES,
} from "./subname-contracts.ts";

export { registryAbi } from "./subname-contracts.ts";

export const DEMO_SUBNAME_LABELS = ["vision-basic", "vision-ocr"] as const;

export interface SubnameOptions {
  parent: string;
  operator: Address;
  labels?: readonly string[];
}

export interface RegistryNameState {
  status: number;
  expiry: bigint;
  latestOwner: Address;
  tokenId: bigint;
  resource: bigint;
}

export interface SubnameInspection {
  chainId: 11155111;
  contractsCommit: string;
  blockNumber: bigint;
  blockHash: Hex;
  timestamp: bigint;
  operator: Address;
  parent: {
    name: string;
    registry: Address;
    state: RegistryNameState;
    resolver: Address;
    subregistry: Address;
    operatorIsOwner: boolean;
    canSetSubregistry: boolean;
  };
  canRegisterSubnames: boolean;
  children: {
    label: string;
    name: string;
    state: RegistryNameState | null;
    resolver: Address;
    operatorCanWriteAllText: boolean;
  }[];
}

export interface UnsignedEnsTransaction {
  chainId: 11155111;
  from: Address;
  to: Address;
  data: Hex;
  value: "0";
}

export interface PreparedSubnameAction {
  action: "deploy_subregistry" | "attach_subregistry" | "register_subname" | "no_change";
  broadcast: false;
  simulated: boolean;
  inspection: SubnameInspection;
  transaction?: UnsignedEnsTransaction;
  subregistry?: Address;
  name?: string;
  expiry?: bigint;
}

export class SubnameError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SubnameError";
  }
}

function fail(code: string): never { throw new SubnameError(code); }
function equal(a: Address, b: Address): boolean { return isAddressEqual(a, b); }

function validateOptions(options: SubnameOptions): Required<SubnameOptions> {
  let parent: string;
  let operator: Address;
  try {
    parent = normalize(options.parent);
    operator = getAddress(options.operator);
  } catch { return fail("ENS_SUBNAME_INPUT_INVALID"); }
  // P0 manages one owned .eth parent, not arbitrary third-party registry trees.
  if (parent.split(".").length !== 2 || !parent.endsWith(".eth") || equal(operator, zeroAddress)) {
    fail("ENS_SUBNAME_INPUT_INVALID");
  }
  const labels = [...(options.labels ?? DEMO_SUBNAME_LABELS)];
  if (!labels.length || new Set(labels).size !== labels.length) fail("ENS_SUBNAME_INPUT_INVALID");
  for (const label of labels) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label) || label.length > 63) fail("ENS_SUBNAME_INPUT_INVALID");
  }
  return { parent, operator, labels };
}

/** Read-only inspection and eth_call preparation. This class never signs or broadcasts. */
export class EnsSubnameManager {
  readonly client: PublicClient;

  constructor(rpcUrl: string, client?: PublicClient) {
    if (!client) {
      try {
        if (!["https:", "http:"].includes(new URL(rpcUrl).protocol)) fail("ENS_RPC_CONFIG_INVALID");
      } catch { fail("ENS_RPC_CONFIG_INVALID"); }
    }
    this.client = client ?? createPublicClient({
      chain: sepolia,
      transport: http(rpcUrl, { timeout: 10_000, retryCount: 0 }),
    });
  }

  private async checkContract(address: Address, blockNumber: bigint): Promise<void> {
    const code = await this.client.getCode({ address, blockNumber });
    if (!code || code === "0x") fail("ENS_CONTRACT_MISSING");
  }

  private async verifyProxy(address: Address, implementation: Address, blockNumber: bigint): Promise<void> {
    await this.checkContract(address, blockNumber);
    const actual = await this.client.readContract({
      address: ENSV2_SUBNAME_DEPLOYMENT.factory,
      abi: factoryAbi,
      functionName: "verifyContract",
      args: [address],
      blockNumber,
    });
    if (!equal(actual, implementation)) fail("ENS_DEPLOYMENT_MISMATCH");
  }

  private async inspectAt(options: Required<SubnameOptions>): Promise<SubnameInspection> {
    if (await this.client.getChainId() !== ENSV2_SUBNAME_DEPLOYMENT.chainId) fail("ENS_CHAIN_MISMATCH");
    const block = await this.client.getBlock();
    if (block.number === null || block.hash === null) fail("ENS_BLOCK_UNAVAILABLE");
    const blockNumber = block.number;
    const deployment = ENSV2_SUBNAME_DEPLOYMENT;
    await this.checkContract(deployment.rootRegistry, blockNumber);
    await this.checkContract(deployment.factory, blockNumber);
    const ethRegistry = await this.client.readContract({
      address: deployment.rootRegistry, abi: registryAbi,
      functionName: "getSubregistry", args: ["eth"], blockNumber,
    });
    if (!equal(ethRegistry, deployment.ethRegistry)) fail("ENS_DEPLOYMENT_MISMATCH");
    await this.checkContract(ethRegistry, blockNumber);
    const label = options.parent.split(".")[0];
    const labelId = BigInt(keccak256(stringToHex(label)));
    const state = await this.client.readContract({
      address: ethRegistry, abi: registryAbi, functionName: "getState", args: [labelId], blockNumber,
    });
    if (state.status !== 2 || state.expiry <= block.timestamp) fail("ENS_PARENT_NOT_REGISTERED");
    const resolver = await this.client.readContract({
      address: ethRegistry, abi: registryAbi, functionName: "getResolver", args: [label], blockNumber,
    });
    if (equal(resolver, zeroAddress)) fail("ENS_RESOLVER_MISSING");
    await this.verifyProxy(resolver, deployment.resolverImplementation, blockNumber);
    const resolved = await this.client.getEnsResolver({ name: options.parent, blockNumber });
    if (!resolved || !equal(resolved, resolver)) fail("ENS_RESOLVER_MISMATCH");
    const subregistry = await this.client.readContract({
      address: ethRegistry, abi: registryAbi, functionName: "getSubregistry", args: [label], blockNumber,
    });
    const canSetSubregistry = await this.client.readContract({
      address: ethRegistry, abi: registryAbi, functionName: "hasRoles",
      args: [labelId, ROLE_SET_SUBREGISTRY, options.operator], blockNumber,
    });
    let canRegisterSubnames = false;
    if (!equal(subregistry, zeroAddress)) {
      await this.verifyProxy(subregistry, deployment.userRegistryImplementation, blockNumber);
      canRegisterSubnames = await this.client.readContract({
        address: subregistry, abi: registryAbi, functionName: "hasRoles",
        args: [0n, ROLE_REGISTRAR, options.operator], blockNumber,
      });
    }
    const children: SubnameInspection["children"] = [];
    for (const childLabel of options.labels) {
      const name = `${childLabel}.${options.parent}`;
      let childState: RegistryNameState | null = null;
      let childResolver = resolver;
      if (!equal(subregistry, zeroAddress)) {
        childState = await this.client.readContract({
          address: subregistry, abi: registryAbi, functionName: "getState",
          args: [BigInt(keccak256(stringToHex(childLabel)))], blockNumber,
        });
        if (childState.status === 2) {
          childResolver = await this.client.readContract({
            address: subregistry, abi: registryAbi, functionName: "getResolver", args: [childLabel], blockNumber,
          });
        }
      }
      // Proposed children reuse this operator's parent resolver. Never infer
      // permissions from ownership, parent-name roles, or inherited resolution.
      const operatorCanWriteAllText = equal(childResolver, resolver) && await this.client.readContract({
        address: resolver, abi: resolverPermissionAbi, functionName: "hasRoles",
        args: [resolverNameResource(name), ROLE_SET_TEXT, options.operator], blockNumber,
      });
      children.push({ label: childLabel, name, state: childState, resolver: childResolver, operatorCanWriteAllText });
    }
    return {
      chainId: deployment.chainId, contractsCommit: deployment.contractsCommit,
      blockNumber, blockHash: block.hash, timestamp: block.timestamp, operator: options.operator,
      parent: {
        name: options.parent, registry: ethRegistry, state, resolver, subregistry,
        operatorIsOwner: equal(state.latestOwner, options.operator), canSetSubregistry,
      },
      canRegisterSubnames, children,
    };
  }

  async inspect(options: SubnameOptions): Promise<SubnameInspection> {
    const input = validateOptions(options);
    try { return await this.inspectAt(input); }
    catch (error) {
      if (error instanceof SubnameError) throw error;
      // Do not expose RPC URLs or credentials embedded in upstream errors.
      return fail("ENS_SUBNAME_READ_FAILED");
    }
  }

  private assertOperator(inspection: SubnameInspection): void {
    if (!inspection.parent.operatorIsOwner) fail("ENS_PARENT_OWNER_MISMATCH");
    if (inspection.children.some((child) => !child.operatorCanWriteAllText)) fail("ENS_TEXT_PERMISSION_MISSING");
  }

  private transaction(inspection: SubnameInspection, to: Address, data: Hex): UnsignedEnsTransaction {
    return { chainId: inspection.chainId, from: inspection.operator, to, data, value: "0" };
  }

  async prepareSubregistry(options: SubnameOptions, existingRegistry?: Address): Promise<PreparedSubnameAction> {
    let supplied: Address | undefined;
    if (existingRegistry !== undefined) {
      try { supplied = getAddress(existingRegistry); } catch { fail("ENS_SUBNAME_INPUT_INVALID"); }
      if (equal(supplied, zeroAddress)) fail("ENS_SUBNAME_INPUT_INVALID");
    }
    const inspection = await this.inspect(options);
    this.assertOperator(inspection);
    if (!equal(inspection.parent.subregistry, zeroAddress)) {
      if (supplied && !equal(supplied, inspection.parent.subregistry)) fail("ENS_SUBREGISTRY_CONFLICT");
      if (!inspection.canRegisterSubnames) fail("ENS_REGISTRAR_PERMISSION_MISSING");
      return { action: "no_change", broadcast: false, simulated: false, inspection, subregistry: inspection.parent.subregistry };
    }
    if (!inspection.parent.canSetSubregistry) fail("ENS_SUBREGISTRY_PERMISSION_MISSING");
    try {
      const deployment = ENSV2_SUBNAME_DEPLOYMENT;
      if (supplied) {
        await this.verifyProxy(supplied, deployment.userRegistryImplementation, inspection.blockNumber);
        const allowed = await this.client.readContract({
          address: supplied, abi: registryAbi, functionName: "hasRoles",
          args: [0n, ROLE_REGISTRAR, inspection.operator], blockNumber: inspection.blockNumber,
        });
        if (!allowed) fail("ENS_REGISTRAR_PERMISSION_MISSING");
        // Require unused Demo labels; this is not an enumeration of the registry.
        for (const child of inspection.children) {
          const state = await this.client.readContract({
            address: supplied, abi: registryAbi, functionName: "getState",
            args: [BigInt(keccak256(stringToHex(child.label)))], blockNumber: inspection.blockNumber,
          });
          if (state.status !== 0) fail("ENS_SUBREGISTRY_NOT_EMPTY");
        }
        const args = [BigInt(keccak256(stringToHex(inspection.parent.name.split(".")[0]))), supplied] as const;
        await this.client.simulateContract({
          address: inspection.parent.registry, abi: registryAbi, functionName: "setSubregistry", args,
          account: inspection.operator, blockNumber: inspection.blockNumber,
        });
        return {
          action: "attach_subregistry", broadcast: false, simulated: true, inspection, subregistry: supplied,
          transaction: this.transaction(inspection, inspection.parent.registry, encodeFunctionData({ abi: registryAbi, functionName: "setSubregistry", args })),
        };
      }
      await this.checkContract(deployment.userRegistryImplementation, inspection.blockNumber);
      const init = encodeFunctionData({
        abi: registryInitAbi, functionName: "initialize", args: [inspection.operator, SUBREGISTRY_ROOT_ROLES],
      });
      const args = [deployment.userRegistryImplementation, registrySalt(inspection.parent.name), init] as const;
      const simulation = await this.client.simulateContract({
        address: deployment.factory, abi: factoryAbi, functionName: "deployProxy", args,
        account: inspection.operator, blockNumber: inspection.blockNumber,
      });
      if (equal(simulation.result, zeroAddress)) fail("ENS_DEPLOYMENT_MISMATCH");
      return {
        action: "deploy_subregistry", broadcast: false, simulated: true, inspection, subregistry: simulation.result,
        transaction: this.transaction(inspection, deployment.factory, encodeFunctionData({ abi: factoryAbi, functionName: "deployProxy", args })),
      };
    } catch (error) {
      if (error instanceof SubnameError) throw error;
      return fail("ENS_SUBNAME_PREPARATION_FAILED");
    }
  }

  async prepareSubname(options: SubnameOptions, label: string): Promise<PreparedSubnameAction> {
    const inspection = await this.inspect({ ...options, labels: [label] });
    this.assertOperator(inspection);
    if (equal(inspection.parent.subregistry, zeroAddress)) fail("ENS_SUBREGISTRY_MISSING");
    const child = inspection.children[0];
    if (child.state?.status === 2) {
      this.assertExistingChild(inspection, child);
      return { action: "no_change", broadcast: false, simulated: false, inspection, name: child.name };
    }
    if (child.state?.status !== 0) fail("ENS_SUBNAME_RESERVED");
    if (!inspection.canRegisterSubnames) fail("ENS_REGISTRAR_PERMISSION_MISSING");
    // Use the parent's absolute expiry; never promise longer-lived child names.
    const args = [child.label, inspection.operator, zeroAddress, inspection.parent.resolver,
      SUBNAME_OWNER_ROLES, inspection.parent.state.expiry] as const;
    try {
      await this.client.simulateContract({
        address: inspection.parent.subregistry, abi: registryAbi, functionName: "register", args,
        account: inspection.operator, blockNumber: inspection.blockNumber,
      });
    } catch { return fail("ENS_SUBNAME_PREPARATION_FAILED"); }
    return {
      action: "register_subname", broadcast: false, simulated: true, inspection,
      name: child.name, expiry: inspection.parent.state.expiry,
      transaction: this.transaction(inspection, inspection.parent.subregistry, encodeFunctionData({ abi: registryAbi, functionName: "register", args })),
    };
  }

  private assertExistingChild(inspection: SubnameInspection, child: SubnameInspection["children"][number]): void {
    if (child.state?.status !== 2 || child.state.expiry <= inspection.timestamp) fail("ENS_SUBNAME_NOT_REGISTERED");
    if (!equal(child.state.latestOwner, inspection.operator)) fail("ENS_SUBNAME_OWNER_MISMATCH");
    if (!equal(child.resolver, inspection.parent.resolver)) fail("ENS_RESOLVER_MISMATCH");
    if (!child.operatorCanWriteAllText) fail("ENS_TEXT_PERMISSION_MISSING");
  }

  async verify(options: SubnameOptions): Promise<{
    scope: "ens_subnames_only";
    broadcast: false;
    registrationVerified: true;
    textWriteSimulated: true;
    providerIdentityVerified: false;
    inspection: SubnameInspection;
  }> {
    const inspection = await this.inspect(options);
    if (equal(inspection.parent.subregistry, zeroAddress)) fail("ENS_SUBREGISTRY_MISSING");
    for (const child of inspection.children) {
      this.assertExistingChild(inspection, child);
      try {
        const resolved = await this.client.getEnsResolver({ name: child.name, blockNumber: inspection.blockNumber });
        if (!resolved || !equal(resolved, child.resolver)) fail("ENS_RESOLVER_MISMATCH");
        const node = namehash(child.name);
        const current = await this.client.readContract({
          address: child.resolver, abi: resolverPermissionAbi, functionName: "text",
          args: [node, "description"], blockNumber: inspection.blockNumber,
        });
        const universal = await this.client.getEnsText({ name: child.name, key: "description", blockNumber: inspection.blockNumber });
        if ((universal ?? "") !== current) fail("ENS_RECORD_READBACK_MISMATCH");
        // Reapply the existing value in eth_call only; no placeholder record is written.
        await this.client.simulateContract({
          address: child.resolver, abi: resolverPermissionAbi, functionName: "setText",
          args: [node, "description", current], account: inspection.operator, blockNumber: inspection.blockNumber,
        });
      } catch (error) {
        if (error instanceof SubnameError) throw error;
        return fail("ENS_SUBNAME_VERIFICATION_FAILED");
      }
    }
    return {
      scope: "ens_subnames_only", broadcast: false, registrationVerified: true,
      textWriteSimulated: true, providerIdentityVerified: false, inspection,
    };
  }
}

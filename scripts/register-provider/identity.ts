import {
  createPublicClient, decodeEventLog, encodeFunctionData, http,
  isAddressEqual, parseAbi, sha256, stringToHex, type Address, type Hex, type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { namehash } from "viem/ens";
import { ensip25AgentRegistrationKey } from "@frely-network/ens";
import { EnsSubnameManager, type UnsignedEnsTransaction } from "@frely-network/ens/subnames";
import {
  ERC8004_REGISTRATION_TYPE, normalizeEnsName, normalizeRegistrationMetadata,
  normalizeRegistryAddress, validateManifest, type P0CapabilityProviderManifest,
} from "@frely-network/protocol-manifest";

// ERC-8004 official Ethereum Sepolia deployment, also indexed by Agent0.
export const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
export const identityWriteAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function tokenURI(uint256 agentId) view returns (string)",
  "function ownerOf(uint256 agentId) view returns (address)",
  "event Registered(uint256 indexed agentId, string agentURI, address indexed owner)",
]);
const textAbi = parseAbi([
  "function text(bytes32 node, string key) view returns (string)",
  "function setText(bytes32 node, string key, string value)",
]);

export class RegistrationError extends Error {}
function fail(code: string): never { throw new RegistrationError(code); }

export interface RegistrationInput {
  manifest: P0CapabilityProviderManifest;
  active: boolean;
  x402Support: boolean;
}

/** Registration is separate from Broker eligibility. False flags remain false on chain. */
export function prepareRegistrationMetadata(value: unknown) {
  try {
    const input = value as RegistrationInput;
    if (!input || typeof input.active !== "boolean" || typeof input.x402Support !== "boolean") {
      fail("REGISTRATION_FLAGS_REQUIRED");
    }
    const manifest = validateManifest(input.manifest);
    if (manifest.identity.agentId !== undefined) fail("REGISTRATION_ID_ASSIGNED_BY_CHAIN");
    const ensName = normalizeEnsName(manifest.identity.ens);
    if (manifest.interfaces.length !== 1) fail("REGISTRATION_SINGLE_ENDPOINT_REQUIRED");
    const metadata = {
      type: ERC8004_REGISTRATION_TYPE,
      name: manifest.name,
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      services: [
        { name: "ENS", endpoint: ensName },
        { name: "responses", endpoint: manifest.interfaces[0].endpoint },
      ],
      active: input.active,
      x402Support: input.x402Support,
      capabilities: manifest.capabilities,
      payment: { protocol: manifest.payment.protocol, network: manifest.payment.network },
    };
    // Reuse strict identity/endpoint validation without inventing availability.
    // This projection is local only; the published flags below are never promoted.
    // No agentId is published before the actual Registered event exists.
    const normalized = normalizeRegistrationMetadata({ ...metadata, active: true, x402Support: true }, {
      chainId: sepolia.id, registryAddress: IDENTITY_REGISTRY, agentId: "0",
    });
    metadata.services[1].endpoint = normalized.interfaces[0].endpoint;
    const endpoint = new URL(metadata.services[1].endpoint);
    if (endpoint.hostname === "localhost" || endpoint.hostname.endsWith(".localhost") ||
        endpoint.hostname === "[::1]" || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(endpoint.hostname)) {
      fail("REGISTRATION_PUBLIC_ENDPOINT_REQUIRED");
    }
    const json = JSON.stringify(metadata);
    // Keep calldata comfortably below the block gas limit. No IPFS key is needed.
    if (Buffer.byteLength(json) > 16_384) fail("REGISTRATION_METADATA_TOO_LARGE");
    return {
      metadata,
      metadataUri: `data:application/json;base64,${Buffer.from(json).toString("base64")}`,
      metadataSha256: sha256(stringToHex(json)),
      ensName,
      endpoint: metadata.services[1].endpoint,
      discoveryEligible: metadata.active && metadata.x402Support,
      executionVerified: false as const,
      paymentVerified: false as const,
    };
  } catch (error) {
    if (error instanceof RegistrationError) throw error;
    return fail("REGISTRATION_INPUT_INVALID");
  }
}

export interface RegistrationConfig { rpcUrl: string; operator: Address; registryAddress: Address; }

export function registrationConfig(env: NodeJS.ProcessEnv): RegistrationConfig {
  try {
    if (env.IDENTITY_CHAIN_ID !== String(sepolia.id) || !env.ENS_SEPOLIA_RPC_URL) throw new Error();
    if (new URL(env.ENS_SEPOLIA_RPC_URL).protocol !== "https:") throw new Error();
    const registryAddress = normalizeRegistryAddress(env.ERC8004_IDENTITY_REGISTRY);
    if (!isAddressEqual(registryAddress, IDENTITY_REGISTRY)) throw new Error();
    const operator = normalizeRegistryAddress(env.ENS_OPERATOR_ADDRESS);
    return { rpcUrl: env.ENS_SEPOLIA_RPC_URL, operator, registryAddress };
  } catch { return fail("REGISTRATION_CONFIG_INVALID"); }
}

/** Produces unsigned wallet transactions and verifies receipts; never holds a signer. */
export class ProviderRegistrationManager {
  readonly client: PublicClient;
  readonly config: RegistrationConfig;

  constructor(config: RegistrationConfig, client?: PublicClient) {
    this.config = registrationConfig({
      IDENTITY_CHAIN_ID: String(sepolia.id), ENS_SEPOLIA_RPC_URL: config.rpcUrl,
      ENS_OPERATOR_ADDRESS: config.operator, ERC8004_IDENTITY_REGISTRY: config.registryAddress,
    });
    this.client = client ?? createPublicClient({
      chain: sepolia, transport: http(config.rpcUrl, { timeout: 15_000, retryCount: 0 }),
    });
  }

  private async snapshot() {
    if (await this.client.getChainId() !== sepolia.id) fail("REGISTRATION_CHAIN_MISMATCH");
    const block = await this.client.getBlock();
    if (block.number === null || block.hash === null) fail("REGISTRATION_BLOCK_UNAVAILABLE");
    const code = await this.client.getCode({ address: this.config.registryAddress, blockNumber: block.number });
    if (!code || code === "0x") fail("REGISTRATION_CONTRACT_MISSING");
    return { blockNumber: block.number, blockHash: block.hash };
  }

  private async inspectEns(ensName: string) {
    const parts = ensName.split(".");
    if (parts.length !== 3 || parts[2] !== "eth") fail("REGISTRATION_SUBNAME_REQUIRED");
    const inspection = await new EnsSubnameManager(this.config.rpcUrl, this.client).inspect({
      parent: parts.slice(1).join("."), labels: [parts[0]], operator: this.config.operator,
    });
    const child = inspection.children[0];
    if (child.state?.status !== 2 || child.state.expiry <= inspection.timestamp) fail("REGISTRATION_ENS_MISSING");
    if (!child.operatorCanWriteAllText) fail("REGISTRATION_ENS_WRITE_PERMISSION_MISSING");
    const resolved = await this.client.getEnsResolver({ name: ensName, blockNumber: inspection.blockNumber });
    if (!resolved || !isAddressEqual(resolved, child.resolver)) fail("REGISTRATION_ENS_RESOLVER_MISMATCH");
    return { resolver: child.resolver, blockNumber: inspection.blockNumber, blockHash: inspection.blockHash };
  }

  private transaction(to: Address, data: Hex): UnsignedEnsTransaction {
    return { chainId: sepolia.id, from: this.config.operator, to, data, value: "0" };
  }

  async prepareRegister(value: unknown) {
    const prepared = prepareRegistrationMetadata(value);
    await this.snapshot();
    const ens = await this.inspectEns(prepared.ensName);
    // A simulated return ID is only a prediction. Never use it to construct ENS keys.
    await this.client.simulateContract({
      address: this.config.registryAddress, abi: identityWriteAbi, functionName: "register",
      args: [prepared.metadataUri], account: this.config.operator, blockNumber: ens.blockNumber,
    });
    const data = encodeFunctionData({ abi: identityWriteAbi, functionName: "register", args: [prepared.metadataUri] });
    const gasEstimate = await this.client.estimateGas({ account: this.config.operator, to: this.config.registryAddress, data });
    return {
      action: "register_erc8004", broadcast: false, simulated: true, ...prepared,
      blockNumber: ens.blockNumber, blockHash: ens.blockHash, gasEstimate,
      identityRegistry: this.config.registryAddress, agentId: null,
      transaction: this.transaction(this.config.registryAddress, data),
      resume: "Use the confirmed transaction hash with prepare-ens; do not send register again after a timeout.",
    };
  }

  async readRegistration(value: unknown, hash: string) {
    const prepared = prepareRegistrationMetadata(value);
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) fail("REGISTRATION_TX_HASH_INVALID");
    await this.snapshot();
    const receipt = await this.client.getTransactionReceipt({ hash: hash as Hex });
    if (receipt.status !== "success") fail("REGISTRATION_TX_REVERTED");
    if (!receipt.to || !isAddressEqual(receipt.to, this.config.registryAddress) ||
        !isAddressEqual(receipt.from, this.config.operator) || receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
      fail("REGISTRATION_TX_MISMATCH");
    }
    const block = await this.client.getBlock({ blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash) fail("REGISTRATION_TX_REORGED");
    const transaction = await this.client.getTransaction({ hash: hash as Hex });
    const expectedInput = encodeFunctionData({ abi: identityWriteAbi, functionName: "register", args: [prepared.metadataUri] });
    if (transaction.input !== expectedInput || transaction.value !== 0n) fail("REGISTRATION_TX_CALLDATA_MISMATCH");
    const events = receipt.logs.filter((log) => isAddressEqual(log.address, this.config.registryAddress)).flatMap((log) => {
      try {
        return [decodeEventLog({ abi: identityWriteAbi, eventName: "Registered", data: log.data, topics: log.topics })];
      } catch { return []; }
    });
    if (events.length !== 1) fail("REGISTRATION_EVENT_MISSING_OR_AMBIGUOUS");
    const event = events[0].args;
    if (event.agentURI !== prepared.metadataUri || !isAddressEqual(event.owner, this.config.operator)) {
      fail("REGISTRATION_EVENT_MISMATCH");
    }
    return { ...prepared, agentId: event.agentId.toString(), transactionHash: receipt.transactionHash,
      registrationBlock: receipt.blockNumber, registrationBlockHash: receipt.blockHash };
  }

  private async binding(value: unknown, hash: string) {
    const registration = await this.readRegistration(value, hash);
    const ens = await this.inspectEns(registration.ensName);
    const [uri, owner] = await Promise.all([
      this.client.readContract({ address: this.config.registryAddress, abi: identityWriteAbi, functionName: "tokenURI",
        args: [BigInt(registration.agentId)], blockNumber: ens.blockNumber }),
      this.client.readContract({ address: this.config.registryAddress, abi: identityWriteAbi, functionName: "ownerOf",
        args: [BigInt(registration.agentId)], blockNumber: ens.blockNumber }),
    ]);
    if (uri !== registration.metadataUri || !isAddressEqual(owner, this.config.operator)) fail("REGISTRATION_ONCHAIN_MISMATCH");
    const records = [
      { key: "agent-endpoint[responses]", value: registration.endpoint },
      { key: ensip25AgentRegistrationKey(this.config.registryAddress, registration.agentId, sepolia.id), value: "1" },
    ];
    return { ...registration, ...ens, records, owner };
  }

  async prepareEns(value: unknown, hash: string) {
    const binding = await this.binding(value, hash);
    const transactions: Array<{ key: string; transaction: UnsignedEnsTransaction }> = [];
    for (const record of binding.records) {
      const current = await this.client.readContract({ address: binding.resolver, abi: textAbi,
        functionName: "text", args: [namehash(binding.ensName), record.key], blockNumber: binding.blockNumber });
      // ENSIP-25 only requires a non-empty value at the exact key.
      if (current === record.value || (record.key !== "agent-endpoint[responses]" && current.length > 0)) continue;
      if (current.length > 0) fail("REGISTRATION_ENS_RECORD_CONFLICT");
      const args = [namehash(binding.ensName), record.key, record.value] as const;
      await this.client.simulateContract({ address: binding.resolver, abi: textAbi, functionName: "setText", args,
        account: this.config.operator, blockNumber: binding.blockNumber });
      transactions.push({ key: record.key, transaction: this.transaction(binding.resolver,
        encodeFunctionData({ abi: textAbi, functionName: "setText", args })) });
    }
    return { action: transactions.length ? "write_ens_records" : "no_change", broadcast: false,
      ...binding, transactions, resume: "Confirm each transaction, then run verify. Rerunning prepare-ens skips matching records." };
  }

  async verify(value: unknown, hash: string) {
    const binding = await this.binding(value, hash);
    for (const record of binding.records) {
      const current = await this.client.getEnsText({ name: binding.ensName, key: record.key,
        blockNumber: binding.blockNumber, strict: true });
      if (typeof current !== "string" || !current.length ||
          (record.key === "agent-endpoint[responses]" && current !== record.value)) fail("REGISTRATION_ENS_READBACK_FAILED");
    }
    return { ...binding, broadcast: false, registrationAndEnsVerified: true,
      graphVerified: false, executionVerified: false, paymentVerified: false };
  }
}

import {
  createPublicClient, decodeEventLog, encodeFunctionData, http,
  isAddressEqual, parseAbi, sha256, stringToHex, type Address, type Hex, type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { namehash } from "viem/ens";
import { ensip25AgentRegistrationKey } from "@frely-network/ens";
import { EnsSubnameManager, type UnsignedEnsTransaction } from "@frely-network/ens/subnames";
import { inspectAgentCard, publicA2AUrl, type AgentCardOptions } from "@frely-network/erc8004";
import {
  ERC8004_REGISTRATION_TYPE, fetchRegistrationMetadata, normalizeAgentId, normalizeEnsName, normalizeHttpsUrl, normalizeRegistrationMetadata,
  normalizeRegistryAddress, validateManifest, validateLegacyManifest, normalizeLegacyRegistrationMetadata,
  type P0CapabilityProviderManifest,
} from "@frely-network/protocol-manifest";

// ERC-8004 official Ethereum Sepolia deployment, also indexed by Agent0.
export const IDENTITY_REGISTRY = "0x8004A818BFB912233c491871b3d84c89A494BD9e" as const;
export const identityWriteAbi = parseAbi([
  "function register(string agentURI) returns (uint256 agentId)",
  "function setAgentURI(uint256 agentId, string newURI)",
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

export interface ProviderUpdateInput {
  agentId: string;
  expected: { metadataUri: string; metadataSha256: Hex; ensEndpoints: { responses: string; a2a: string }; resolver: Address };
  changes: { protocol?: "a2a"; endpoint?: string; agentCardUrl?: string; description?: string; active?: boolean; x402Support?: boolean };
}

type EditableMetadata = Record<string, unknown> & {
  services: Array<Record<string, unknown> & { name: string; endpoint: string }>;
  active: boolean;
  x402Support: boolean;
};

function metadataHash(metadata: unknown): Hex { return sha256(stringToHex(JSON.stringify(metadata))); }

function editableMetadata(metadata: unknown, agentId: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) fail("REGISTRATION_INPUT_INVALID");
  const file = metadata as EditableMetadata;
  if (file.type !== ERC8004_REGISTRATION_TYPE || typeof file.active !== "boolean" ||
      typeof file.x402Support !== "boolean") fail("REGISTRATION_FLAGS_REQUIRED");
  // Editing inactive identities is allowed; discovery's eligibility policy stays strict.
  if (!Array.isArray(file.services) || file.services.some((service) => !service || typeof service.name !== "string")) {
    fail("REGISTRATION_INPUT_INVALID");
  }
  const a2a = file.services.filter((service) => service.name.toLowerCase() === "a2a");
  const responses = file.services.filter((service) => service.name.toLowerCase() === "responses");
  if (a2a.length + responses.length !== 1) fail("REGISTRATION_SINGLE_ENDPOINT_REQUIRED");
  const context = { chainId: sepolia.id, registryAddress: IDENTITY_REGISTRY, agentId };
  // Legacy metadata is read only for historical verification and explicit migration.
  const manifest = a2a.length
    ? normalizeRegistrationMetadata({ ...file, active: true }, context)
    : normalizeLegacyRegistrationMetadata({ ...file, active: true, x402Support: true }, context);
  const service = manifest.interfaces[0];
  return { metadata: file, manifest, protocol: service.protocol,
    endpointKey: `agent-endpoint[${service.protocol}]`,
    agentCardUrl: service.protocol === "a2a" ? service.agentCardUrl : undefined };
}

function updateInput(value: unknown): ProviderUpdateInput {
  try {
    const input = value as ProviderUpdateInput;
    if (!input || typeof input.agentId !== "string") throw new Error();
    normalizeAgentId(input.agentId);
    if (!input.expected || typeof input.expected.metadataUri !== "string" || !input.expected.metadataUri ||
        !/^0x[0-9a-f]{64}$/.test(input.expected.metadataSha256)) throw new Error();
    if (!input.expected.ensEndpoints || typeof input.expected.ensEndpoints.responses !== "string" ||
        typeof input.expected.ensEndpoints.a2a !== "string") throw new Error();
    for (const endpoint of Object.values(input.expected.ensEndpoints)) if (endpoint !== "") normalizeHttpsUrl(endpoint);
    normalizeRegistryAddress(input.expected.resolver);
    if (!input.changes || typeof input.changes !== "object" || Array.isArray(input.changes)) throw new Error();
    const keys = Object.keys(input.changes);
    if (!keys.length || keys.some((key) => !["protocol", "endpoint", "agentCardUrl", "description", "active", "x402Support"].includes(key))) throw new Error();
    if ("protocol" in input.changes && input.changes.protocol !== "a2a") throw new Error();
    if ("agentCardUrl" in input.changes) publicA2AUrl(input.changes.agentCardUrl);
    for (const key of ["active", "x402Support"] as const) {
      if (key in input.changes && typeof input.changes[key] !== "boolean") throw new Error();
    }
    if ("description" in input.changes && typeof input.changes.description !== "string") throw new Error();
    if ("endpoint" in input.changes) {
      const url = new URL(normalizeHttpsUrl(input.changes.endpoint));
      if (!url.hostname.includes(".") || url.hostname.endsWith(".localhost") ||
          url.hostname.startsWith("[") || /^(0\.|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname)) throw new Error();
    }
    return input;
  } catch { return fail("REGISTRATION_UPDATE_INPUT_INVALID"); }
}

function encodeMetadata(metadata: EditableMetadata): string {
  const json = JSON.stringify(metadata);
  if (Buffer.byteLength(json) > 16_384) fail("REGISTRATION_METADATA_TOO_LARGE");
  return `data:application/json;base64,${Buffer.from(json).toString("base64")}`;
}

/** Registration is separate from Broker eligibility. False flags remain false on chain. */
export function prepareRegistrationMetadata(value: unknown) {
  return buildRegistrationMetadata(value, false);
}

// The legacy builder is private and used only to reconstruct an already signed register() receipt.
function buildRegistrationMetadata(value: unknown, legacy: boolean) {
  try {
    const input = value as RegistrationInput;
    if (!input || typeof input.active !== "boolean" || typeof input.x402Support !== "boolean") {
      fail("REGISTRATION_FLAGS_REQUIRED");
    }
    const manifest = legacy ? validateLegacyManifest(input.manifest) : validateManifest(input.manifest);
    if (manifest.identity.agentId !== undefined) fail("REGISTRATION_ID_ASSIGNED_BY_CHAIN");
    const ensName = normalizeEnsName(manifest.identity.ens);
    if (manifest.interfaces.length !== 1) fail("REGISTRATION_SINGLE_ENDPOINT_REQUIRED");
    const service = manifest.interfaces[0];
    const metadata: EditableMetadata = {
      type: ERC8004_REGISTRATION_TYPE,
      name: manifest.name,
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      services: [
        { name: "ENS", endpoint: ensName },
        { name: service.protocol === "a2a" ? "A2A" : "responses",
          endpoint: service.protocol === "a2a" ? service.agentCardUrl : service.endpoint },
      ],
      active: input.active,
      x402Support: input.x402Support,
      capabilities: manifest.capabilities,
      payment: { protocol: manifest.payment.protocol, network: manifest.payment.network },
      ...(service.protocol === "a2a" ? { interfaces: [{ ...service }] } : {}),
    };
    // Reuse strict identity/endpoint validation without inventing availability.
    // This projection is local only; the published flags below are never promoted.
    // No agentId is published before the actual Registered event exists.
    const normalized = editableMetadata(metadata, "0");
    const endpoint = new URL(normalized.manifest.interfaces[0].endpoint);
    if (normalized.protocol === "a2a") {
      publicA2AUrl(endpoint.toString());
      publicA2AUrl(normalized.agentCardUrl);
    }
    metadata.services[1].endpoint = normalized.agentCardUrl ?? normalized.manifest.interfaces[0].endpoint;
    if (normalized.protocol === "a2a") metadata.interfaces = normalized.manifest.interfaces;
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
      endpoint: normalized.manifest.interfaces[0].endpoint,
      protocol: normalized.protocol, endpointKey: normalized.endpointKey, agentCardUrl: normalized.agentCardUrl,
      discoveryEligible: normalized.protocol === "a2a" && metadata.active,
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

  constructor(config: RegistrationConfig, client?: PublicClient, private readonly cardOptions: AgentCardOptions = {}) {
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
    await this.checkCard(prepared.agentCardUrl!, prepared.endpoint);
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
    const historical = value as { manifest?: { interfaces?: Array<{ protocol?: string }> } };
    const prepared = buildRegistrationMetadata(value, historical?.manifest?.interfaces?.[0]?.protocol === "responses");
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
      { key: registration.endpointKey, value: registration.endpoint },
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
      if (current === record.value || (record.key !== binding.endpointKey && current.length > 0)) continue;
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
          (record.key === binding.endpointKey && current !== record.value)) fail("REGISTRATION_ENS_READBACK_FAILED");
    }
    return { ...binding, broadcast: false, registrationAndEnsVerified: true,
      graphVerified: false, executionVerified: false, paymentVerified: false };
  }

  /** Current identity state, independent of the metadata captured by register(). */
  async inspectCurrent(value: string) {
    let agentId: string;
    try {
      if (typeof value !== "string") throw new Error();
      agentId = normalizeAgentId(value);
    } catch { return fail("REGISTRATION_AGENT_ID_INVALID"); }
    const snapshot = await this.snapshot();
    const uri = await this.client.readContract({ address: this.config.registryAddress, abi: identityWriteAbi,
      functionName: "tokenURI", args: [BigInt(agentId)], blockNumber: snapshot.blockNumber });
    const parsed = editableMetadata(await fetchRegistrationMetadata(uri), agentId);
    const ensName = parsed.manifest.identity.ens;
    const ens = await this.inspectEns(ensName);
    const [currentUri, owner] = await Promise.all([
      this.client.readContract({ address: this.config.registryAddress, abi: identityWriteAbi,
        functionName: "tokenURI", args: [BigInt(agentId)], blockNumber: ens.blockNumber }),
      this.client.readContract({ address: this.config.registryAddress, abi: identityWriteAbi,
        functionName: "ownerOf", args: [BigInt(agentId)], blockNumber: ens.blockNumber }),
    ]);
    if (currentUri !== uri) fail("REGISTRATION_UPDATE_STATE_CHANGED");
    if (!isAddressEqual(owner, this.config.operator)) fail("REGISTRATION_ONCHAIN_MISMATCH");
    const agentRegistrationKey = ensip25AgentRegistrationKey(this.config.registryAddress, agentId, sepolia.id);
    const [responsesEndpoint, a2aEndpoint, agentRegistration] = await Promise.all([
      this.client.getEnsText({ name: ensName, key: "agent-endpoint[responses]", blockNumber: ens.blockNumber, strict: true }),
      this.client.getEnsText({ name: ensName, key: "agent-endpoint[a2a]", blockNumber: ens.blockNumber, strict: true }),
      this.client.getEnsText({ name: ensName, key: agentRegistrationKey, blockNumber: ens.blockNumber, strict: true }),
    ]);
    const ensEndpoints = { responses: responsesEndpoint ?? "", a2a: a2aEndpoint ?? "" };
    const ensEndpoint = ensEndpoints[parsed.protocol];
    const endpoint = parsed.manifest.interfaces[0].endpoint;
    const records = [{ key: parsed.endpointKey, value: endpoint }, { key: agentRegistrationKey, value: "1" }];
    const hash = metadataHash(parsed.metadata);
    return { ...ens, agentId, identityRegistry: this.config.registryAddress, ensName, owner,
      metadata: parsed.metadata, metadataUri: uri, metadataSha256: hash, endpoint,
      protocol: parsed.protocol, endpointKey: parsed.endpointKey, agentCardUrl: parsed.agentCardUrl, ensEndpoints,
      ensEndpoint: ensEndpoint ?? "", agentRegistrationKey, agentRegistration: agentRegistration ?? "", records,
      registrationAndEnsVerified: ensEndpoint === endpoint && !!agentRegistration?.length,
      discoveryEligible: parsed.protocol === "a2a" && parsed.metadata.active,
      graphVerified: false, executionVerified: false, paymentVerified: false, broadcast: false,
      updateInput: { agentId, expected: { metadataUri: uri, metadataSha256: hash,
        ensEndpoints, resolver: ens.resolver }, changes: {} } satisfies ProviderUpdateInput,
    };
  }

  async verifyCurrent(agentId: string) {
    const current = await this.inspectCurrent(agentId);
    if (!current.registrationAndEnsVerified) fail("REGISTRATION_ENS_READBACK_FAILED");
    return { ...current, registrationAndEnsVerified: true as const };
  }

  /** Initial binding from current metadata, still refusing conflicting records. */
  async prepareCurrentEns(agentId: string) {
    const current = await this.inspectCurrent(agentId);
    const transactions: Array<{ key: string; transaction: UnsignedEnsTransaction }> = [];
    for (const record of current.records) {
      const existing = record.key === current.endpointKey ? current.ensEndpoint : current.agentRegistration;
      if (existing === record.value || (record.key !== current.endpointKey && existing.length > 0)) continue;
      if (existing.length) fail("REGISTRATION_ENS_RECORD_CONFLICT");
      const args = [namehash(current.ensName), record.key, record.value] as const;
      await this.client.simulateContract({ address: current.resolver, abi: textAbi, functionName: "setText",
        args, account: this.config.operator, blockNumber: current.blockNumber });
      transactions.push({ key: record.key, transaction: this.transaction(current.resolver,
        encodeFunctionData({ abi: textAbi, functionName: "setText", args })) });
    }
    return { ...current, action: transactions.length ? "write_ens_records" : "no_change", transactions };
  }

  private async updateState(value: unknown) {
    const input = updateInput(value);
    const base = editableMetadata(await fetchRegistrationMetadata(input.expected.metadataUri), input.agentId);
    if (metadataHash(base.metadata) !== input.expected.metadataSha256 ||
        base.manifest.interfaces[0].endpoint !== input.expected.ensEndpoints[base.protocol]) fail("REGISTRATION_UPDATE_BASE_MISMATCH");
    const finalMetadata = structuredClone(base.metadata);
    const migrating = base.protocol === "responses" && input.changes.protocol === "a2a";
    if (migrating) {
      if (!input.changes.endpoint || !input.changes.agentCardUrl) fail("REGISTRATION_A2A_TARGET_REQUIRED");
      const endpoint = publicA2AUrl(input.changes.endpoint);
      const agentCardUrl = publicA2AUrl(input.changes.agentCardUrl);
      if (input.expected.ensEndpoints.a2a && input.expected.ensEndpoints.a2a !== endpoint) fail("REGISTRATION_ENS_RECORD_CONFLICT");
      finalMetadata.services = finalMetadata.services.filter((service) => service.name.toLowerCase() !== "responses");
      finalMetadata.services.push({ name: "A2A", endpoint: agentCardUrl });
      finalMetadata.interfaces = [{ protocol: "a2a", endpoint, agentCardUrl }];
      if ("protocol" in finalMetadata) finalMetadata.protocol = "a2a";
      if ("endpoint" in finalMetadata) finalMetadata.endpoint = endpoint;
    } else if (base.protocol === "a2a") {
      const service = base.manifest.interfaces[0];
      if (service.protocol !== "a2a") fail("REGISTRATION_INPUT_INVALID");
      const endpoint = input.changes.endpoint === undefined ? service.endpoint : publicA2AUrl(input.changes.endpoint);
      const agentCardUrl = input.changes.agentCardUrl === undefined ? service.agentCardUrl : publicA2AUrl(input.changes.agentCardUrl);
      if (input.changes.endpoint !== undefined || input.changes.agentCardUrl !== undefined) {
        finalMetadata.interfaces = [{ ...service, endpoint, agentCardUrl }];
        finalMetadata.services.find((entry) => entry.name.toLowerCase() === "a2a")!.endpoint = agentCardUrl;
        if ("endpoint" in finalMetadata) finalMetadata.endpoint = endpoint;
      }
    } else {
      if (input.changes.agentCardUrl !== undefined) fail("REGISTRATION_A2A_TARGET_REQUIRED");
      if (input.changes.endpoint !== undefined) {
        finalMetadata.services.find((service) => service.name.toLowerCase() === "responses")!.endpoint = normalizeHttpsUrl(input.changes.endpoint);
      }
    }
    for (const key of ["description", "active", "x402Support"] as const) {
      if (key in input.changes) Object.assign(finalMetadata, { [key]: input.changes[key] });
    }
    const final = editableMetadata(finalMetadata, input.agentId);
    const finalHash = metadataHash(finalMetadata);
    const target = { metadata: finalMetadata, metadataSha256: finalHash,
      metadataUri: finalHash === input.expected.metadataSha256 ? input.expected.metadataUri : encodeMetadata(finalMetadata),
      endpoint: final.manifest.interfaces[0].endpoint, protocol: final.protocol,
      endpointKey: final.endpointKey, agentCardUrl: final.agentCardUrl };
    const current = await this.inspectCurrent(input.agentId);
    if (current.ensName !== base.manifest.identity.ens ||
        !isAddressEqual(current.resolver, input.expected.resolver) || !current.agentRegistration.length) {
      fail("REGISTRATION_UPDATE_IDENTITY_MISMATCH");
    }
    type State = { metadataUri: string; metadataSha256: Hex; ensEndpoints: { responses: string; a2a: string } };
    const states: State[] = [{ ...input.expected }];
    const steps: Array<{ kind: "pause" | "endpoint" | "metadata"; transaction: UnsignedEnsTransaction }> = [];
    function state(): State { return states[states.length - 1]; }
    const addMetadata = (kind: "pause" | "metadata", metadata: EditableMetadata, uri: string) => {
      steps.push({ kind, transaction: this.transaction(this.config.registryAddress,
        encodeFunctionData({ abi: identityWriteAbi, functionName: "setAgentURI", args: [BigInt(input.agentId), uri] })) });
      states.push({ ...state(), metadataUri: uri, metadataSha256: metadataHash(metadata) });
    };
    const routeChanged = target.protocol !== base.protocol || target.endpoint !== base.manifest.interfaces[0].endpoint ||
      target.agentCardUrl !== base.agentCardUrl;
    if (routeChanged) {
      if (base.metadata.active) {
        const paused = { ...base.metadata, active: false };
        addMetadata("pause", paused, encodeMetadata(paused));
      }
    }
    if (target.endpoint !== state().ensEndpoints[target.protocol]) {
      steps.push({ kind: "endpoint", transaction: this.transaction(current.resolver,
        encodeFunctionData({ abi: textAbi, functionName: "setText",
          args: [namehash(current.ensName), target.endpointKey, target.endpoint] })) });
      states.push({ ...state(), ensEndpoints: { ...state().ensEndpoints, [target.protocol]: target.endpoint } });
    }
    if (state().metadataUri !== target.metadataUri) addMetadata("metadata", target.metadata, target.metadataUri);
    const completedSteps = states.findIndex((item) => item.metadataUri === current.metadataUri &&
      item.metadataSha256 === current.metadataSha256 && item.ensEndpoints.responses === current.ensEndpoints.responses &&
      item.ensEndpoints.a2a === current.ensEndpoints.a2a);
    if (completedSteps < 0) fail("REGISTRATION_UPDATE_STATE_CHANGED");
    return { current, target, completedSteps, totalSteps: steps.length, nextStep: steps[completedSteps] ?? null,
      cardVerificationRequired: target.protocol === "a2a" && (routeChanged || target.metadata.active),
      broadcast: false as const, graphVerified: false as const, executionVerified: false as const, paymentVerified: false as const };
  }

  /** Only the next state-checked step is exposed; the caller must prepare again after confirmation. */
  async prepareUpdate(value: unknown) {
    const plan = await this.updateState(value);
    // A broken service must still be deactivatable. Route changes and active targets require a live Card.
    if (plan.cardVerificationRequired) await this.checkCard(plan.target.agentCardUrl!, plan.target.endpoint);
    if (plan.nextStep) {
      const tx = plan.nextStep.transaction;
      // eth_call from the operator verifies authorization without signing or broadcasting.
      await this.client.call({ account: this.config.operator, to: tx.to, data: tx.data, value: 0n,
        blockNumber: plan.current.blockNumber });
    }
    return { ...plan, action: plan.nextStep ? "update_provider" : "no_change",
      agentCardVerified: plan.cardVerificationRequired,
      simulated: plan.nextStep !== null,
      resume: "Confirm only nextStep, then rerun the same input. An unknown wallet result requires receipt/state lookup before retrying.",
    };
  }

  async verifyUpdate(value: unknown) {
    const plan = await this.updateState(value);
    if (plan.nextStep || !plan.current.registrationAndEnsVerified) fail("REGISTRATION_UPDATE_INCOMPLETE");
    if (plan.cardVerificationRequired) await this.checkCard(plan.target.agentCardUrl!, plan.target.endpoint);
    return { ...plan, registrationAndEnsVerified: true, updateVerified: true, agentCardVerified: plan.cardVerificationRequired };
  }

  private async checkCard(agentCardUrl: string, endpoint: string) {
    try { return await inspectAgentCard(agentCardUrl, endpoint, this.cardOptions); }
    catch { return fail("REGISTRATION_A2A_CARD_INVALID"); }
  }
}

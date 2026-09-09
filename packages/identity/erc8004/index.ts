import {
  createPublicClient,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";
import { isSafePublicHttpUrl, type ProviderCandidate, type ResolvedProvider } from "@frely-network/shared-types";
import type { EnsReader, EnsRecords } from "@frely-network/ens";

export interface Erc8004Config {
  rpcUrl: string;
  registryAddress: Address;
  requireHttps?: boolean;
  fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface RegistrationMetadata {
  identity?: string;
  agentId?: string | number;
  capabilities?: string[];
  endpoint?: string;
  protocol?: string;
  ens?: string;
  [key: string]: unknown;
}

export interface Erc8004Identity {
  agentId: string;
  registryAddress: Address;
  metadataUri: string;
  metadata: RegistrationMetadata;
}

export interface Erc8004Reader {
  read(agentId: string): Promise<Erc8004Identity>;
}

const identityAbi = parseAbi(["function tokenURI(uint256 tokenId) view returns (string)"]);

function metadataUrl(uri: string): URL {
  let parsed: URL;
  try { parsed = new URL(uri); } catch { throw new Error("IDENTITY_VERIFICATION_FAILED"); }
  if (!isSafePublicHttpUrl(parsed.toString(), { requireHttps: true })) throw new Error("IDENTITY_VERIFICATION_FAILED");
  return parsed;
}

export class ViemErc8004Reader implements Erc8004Reader {
  readonly client: PublicClient;
  constructor(readonly config: Erc8004Config, client?: PublicClient) {
    this.client = client ?? createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });
  }

  async read(agentId: string): Promise<Erc8004Identity> {
    if (!/^\d+$/.test(agentId)) throw new Error("IDENTITY_VERIFICATION_FAILED");
    let uri: string;
    try {
      uri = await this.client.readContract({ address: this.config.registryAddress, abi: identityAbi, functionName: "tokenURI", args: [BigInt(agentId)] });
    } catch {
      throw new Error("IDENTITY_VERIFICATION_FAILED");
    }
    const url = metadataUrl(uri);
    let response: Response;
    try { response = await (this.config.fetcher ?? ((input) => fetch(input)))(url.toString()); } catch { throw new Error("IDENTITY_VERIFICATION_FAILED"); }
    if (!response.ok) throw new Error("IDENTITY_VERIFICATION_FAILED");
    let metadata: RegistrationMetadata;
    try { metadata = await response.json() as RegistrationMetadata; } catch { throw new Error("IDENTITY_VERIFICATION_FAILED"); }
    if (!metadata || typeof metadata !== "object" || !Array.isArray(metadata.capabilities)) throw new Error("IDENTITY_VERIFICATION_FAILED");
    return { agentId, registryAddress: this.config.registryAddress, metadataUri: url.toString(), metadata };
  }
}

function protocol(value: unknown): ResolvedProvider["protocol"] {
  if (value === "responses" || value === "mcp" || value === "http") return value;
  throw new Error("PROTOCOL_NOT_SUPPORTED");
}

function sameRegistration(value: string | undefined, registry: Address, agentId: string): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized.includes(registry.toLowerCase()) && normalized.includes(`][${agentId.toLowerCase()}]`);
}

/** Composes ENS and ERC-8004 checks into the B-facing resolveProvider contract. */
export class ProviderIdentityResolver {
  constructor(private readonly ens: EnsReader, private readonly erc8004: Erc8004Reader) {}

  async resolveProvider(candidate: ProviderCandidate): Promise<ResolvedProvider> {
    if (!candidate.ensName || !candidate.id) throw new Error("IDENTITY_VERIFICATION_FAILED");
    const identity = await this.erc8004.read(candidate.id);
    const capabilities = identity.metadata.capabilities ?? [];
    if (!candidate.capabilities.every((capability) => capabilities.includes(capability))) throw new Error("CAPABILITY_NOT_SUPPORTED");
    if (identity.metadata.agentId !== undefined && String(identity.metadata.agentId) !== identity.agentId) throw new Error("IDENTITY_VERIFICATION_FAILED");
    if (identity.metadata.protocol !== undefined) protocol(identity.metadata.protocol);
    if (identity.metadata.endpoint !== undefined) {
      let metadataEndpoint: URL;
      try { metadataEndpoint = new URL(identity.metadata.endpoint); } catch { throw new Error("IDENTITY_VERIFICATION_FAILED"); }
      if (!isSafePublicHttpUrl(metadataEndpoint.toString(), { requireHttps: true })) throw new Error("ENDPOINT_NOT_HTTPS");
    }
    const ens: EnsRecords = await this.ens.resolve(candidate.ensName, {
      registryAddress: identity.registryAddress,
      agentId: identity.agentId,
    });
    if (!sameRegistration(ens.agentRegistration, identity.registryAddress, identity.agentId)) throw new Error("IDENTITY_VERIFICATION_FAILED");
    if (identity.metadata.ens && identity.metadata.ens !== candidate.ensName) throw new Error("IDENTITY_VERIFICATION_FAILED");
    const endpoint = new URL(ens.endpoint);
    if (!isSafePublicHttpUrl(endpoint.toString(), { requireHttps: true })) throw new Error("ENDPOINT_NOT_HTTPS");
    if (identity.metadata.endpoint && new URL(identity.metadata.endpoint).toString() !== endpoint.toString()) {
      throw new Error("IDENTITY_VERIFICATION_FAILED");
    }
    return { id: candidate.id, ensName: candidate.ensName, endpoint: ens.endpoint, protocol: protocol(ens.protocol), verified: true };
  }
}

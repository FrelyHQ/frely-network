import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem";
import { sepolia } from "viem/chains";
import type { ProviderCandidate, ResolvedProvider } from "@frely-network/shared-types";
import { ENSV2_SEPOLIA_CHAIN_ID, ensip25AgentRegistrationKey, type EnsReader } from "@frely-network/ens";
import { inspectAgentCard, type AgentCardOptions } from "./agent-card.ts";
export { inspectAgentCard, publicA2AUrl, type AgentCardOptions } from "./agent-card.ts";
import {
  fetchRegistrationMetadata,
  normalizeAgentId,
  normalizeEnsName,
  normalizeHttpsUrl,
  normalizeRegistryAddress,
  normalizeRegistrationMetadata,
  type MetadataFetcher,
} from "@frely-network/protocol-manifest";

export interface Erc8004Config {
  rpcUrl: string;
  registryAddress: Address;
  requireHttps?: boolean;
  metadataGateway?: string;
  requestTimeoutMs?: number;
}

/** Untrusted tokenURI content; normalize it before reading any claims. */
export type RegistrationMetadata = unknown;

export interface Erc8004Identity {
  agentId: string;
  registryAddress: Address;
  chainId: number;
  blockNumber: bigint;
  metadataUri: string;
  metadata: RegistrationMetadata;
}

export interface Erc8004Reader {
  readonly registryAddress: Address;
  read(agentId: string): Promise<Erc8004Identity>;
}

const identityAbi = parseAbi(["function tokenURI(uint256 tokenId) view returns (string)"]);

const safeErrors = new Set([
  "IDENTITY_VERIFICATION_FAILED", "REGISTRATION_METADATA_INVALID", "METADATA_URI_INVALID",
  "METADATA_FETCH_FAILED", "METADATA_CONFIG_INVALID", "ENS_ENDPOINT_MISSING",
  "ENS_ENDPOINT_MISMATCH", "ENDPOINT_NOT_HTTPS", "PROTOCOL_NOT_SUPPORTED", "CAPABILITY_NOT_SUPPORTED",
  "A2A_CARD_INVALID", "A2A_PROTOCOL_NOT_SUPPORTED", "A2A_ENDPOINT_MISMATCH",
]);

function verificationError(error: unknown): Error {
  // RPC/HTTP errors may contain API keys or private URLs; expose only stable codes.
  return new Error(error instanceof Error && safeErrors.has(error.message)
    ? error.message : "IDENTITY_VERIFICATION_FAILED");
}

function validBlock(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n;
}

export class ViemErc8004Reader implements Erc8004Reader {
  readonly client: PublicClient;
  readonly registryAddress: Address;

  constructor(
    readonly config: Erc8004Config,
    client?: PublicClient,
    private readonly fetcher: MetadataFetcher = (url, init) => fetch(url, init),
  ) {
    if (config.requireHttps === false) throw new Error("ENDPOINT_NOT_HTTPS");
    this.registryAddress = normalizeRegistryAddress(config.registryAddress);
    if (config.requestTimeoutMs !== undefined &&
        (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0)) {
      throw new Error("METADATA_CONFIG_INVALID");
    }
    this.client = client ?? createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });
  }

  async read(agentId: string): Promise<Erc8004Identity> {
    try {
      if (typeof agentId !== "string") throw new Error("IDENTITY_VERIFICATION_FAILED");
      const id = normalizeAgentId(agentId);
      const chainId = await this.client.getChainId();
      if (chainId !== ENSV2_SEPOLIA_CHAIN_ID) throw new Error("IDENTITY_VERIFICATION_FAILED");
      const blockNumber = await this.client.getBlockNumber({ cacheTime: 0 });
      if (!validBlock(blockNumber)) throw new Error("IDENTITY_VERIFICATION_FAILED");
      const metadataUri = await this.client.readContract({
        address: this.registryAddress, abi: identityAbi, functionName: "tokenURI", args: [BigInt(id)], blockNumber,
      });
      const metadata = await fetchRegistrationMetadata(metadataUri, {
        ...(this.config.metadataGateway === undefined ? {} : { gateway: this.config.metadataGateway }),
        ...(this.config.requestTimeoutMs === undefined ? {} : { timeoutMs: this.config.requestTimeoutMs }),
      }, this.fetcher);
      normalizeRegistrationMetadata(metadata, { chainId, registryAddress: this.registryAddress, agentId: id });
      return { agentId: id, registryAddress: this.registryAddress, chainId, blockNumber, metadataUri, metadata };
    } catch (error) { throw verificationError(error); }
  }
}

/** Composes ENS, ERC-8004 and Card checks into the B-facing A2A contract. */
export class ProviderIdentityResolver {
  constructor(private readonly ens: EnsReader, private readonly erc8004: Erc8004Reader,
    private readonly cardOptions: AgentCardOptions = {}) {}

  async resolveProvider(candidate: ProviderCandidate): Promise<ResolvedProvider> {
    try {
      if (!candidate || typeof candidate.id !== "string" || typeof candidate.supportsX402 !== "boolean" ||
          !Array.isArray(candidate.capabilities) || !candidate.capabilities.length ||
          candidate.capabilities.some((capability) => typeof capability !== "string" || !capability.trim())) {
        throw new Error("IDENTITY_VERIFICATION_FAILED");
      }
      const agentId = normalizeAgentId(candidate.id);
      const candidateName = normalizeEnsName(candidate.ensName);
      const identity = await this.erc8004.read(agentId);
      const registryAddress = normalizeRegistryAddress(identity.registryAddress);
      if (identity.agentId !== agentId || identity.chainId !== ENSV2_SEPOLIA_CHAIN_ID ||
          registryAddress !== normalizeRegistryAddress(this.erc8004.registryAddress) || !validBlock(identity.blockNumber)) {
        throw new Error("IDENTITY_VERIFICATION_FAILED");
      }
      // Revalidate even custom readers; Graph and ERC-8004 use the same profile.
      const manifest = normalizeRegistrationMetadata(identity.metadata, {
        chainId: identity.chainId, registryAddress, agentId,
      });
      if (candidate.supportsX402 !== manifest.x402Support) throw new Error("IDENTITY_VERIFICATION_FAILED");
      if (candidateName !== manifest.identity.ens) throw new Error("IDENTITY_VERIFICATION_FAILED");
      if (!candidate.capabilities.every((capability) => manifest.capabilities.includes(capability))) {
        throw new Error("CAPABILITY_NOT_SUPPORTED");
      }
      const ens = await this.ens.resolve(manifest.identity.ens, {
        registryAddress, agentId, blockNumber: identity.blockNumber,
      });
      if (normalizeEnsName(ens.name) !== manifest.identity.ens ||
          ens.agentRegistrationKey !== ensip25AgentRegistrationKey(registryAddress, agentId, identity.chainId) ||
          typeof ens.agentRegistration !== "string" || ens.agentRegistration.length === 0) {
        throw new Error("IDENTITY_VERIFICATION_FAILED");
      }
      normalizeRegistryAddress(ens.resolver);
      const providerInterface = manifest.interfaces[0];
      if (ens.protocol !== providerInterface.protocol) throw new Error("PROTOCOL_NOT_SUPPORTED");
      const endpoint = normalizeHttpsUrl(ens.endpoint);
      if (endpoint !== providerInterface.endpoint) throw new Error("ENS_ENDPOINT_MISMATCH");
      const card = await inspectAgentCard(providerInterface.agentCardUrl, endpoint, this.cardOptions);
      return { id: agentId, ensName: manifest.identity.ens, ...card, protocol: "a2a", verified: true };
    } catch (error) { throw verificationError(error); }
  }
}

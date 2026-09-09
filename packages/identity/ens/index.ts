import {
  createPublicClient,
  http,
  isAddress,
  zeroAddress,
  type Address,
  type PublicClient,
} from "viem";
import { normalize } from "viem/ens";
import { sepolia } from "viem/chains";

export const ENSIP25_AGENT_REGISTRATION_PREFIX = "agent-registration";
export const ENSV2_SEPOLIA_CHAIN_ID = 11155111;

function encodeErc7930EvmAddress(registryAddress: Address, chainId: number): string {
  if (!Number.isSafeInteger(chainId) || chainId <= 0
    || typeof registryAddress !== "string" || !isAddress(registryAddress, { strict: false })
    || registryAddress.toLowerCase() === zeroAddress) {
    throw new Error("IDENTITY_VERIFICATION_FAILED");
  }
  const chainHex = chainId.toString(16);
  const chainReference = chainHex.padStart(Math.ceil(chainHex.length / 2) * 2, "0");
  const chainReferenceLength = (chainReference.length / 2).toString(16).padStart(2, "0");
  return `0x00010000${chainReferenceLength}${chainReference}14${registryAddress.slice(2).toLowerCase()}`;
}

export function ensip25AgentRegistrationKey(
  registryAddress: Address,
  agentId: string,
  chainId = ENSV2_SEPOLIA_CHAIN_ID,
): string {
  if (typeof agentId !== "string" || !/^(0|[1-9][0-9]*)$/.test(agentId)
    || agentId.length > 78 || BigInt(agentId) >= 2n ** 256n) {
    throw new Error("IDENTITY_VERIFICATION_FAILED");
  }
  const interoperableAddress = encodeErc7930EvmAddress(registryAddress, chainId);
  return `${ENSIP25_AGENT_REGISTRATION_PREFIX}[${interoperableAddress}][${agentId}]`;
}

export interface EnsConfig {
  rpcUrl: string;
  /** Kept for ENSIP-25 key construction; resolution uses the canonical Universal Resolver. */
  registryAddress?: Address;
  agentEndpointKey?: string;
  agentRegistrationKey?: string | ((registryAddress: Address, agentId: string) => string);
  requireHttps?: boolean;
}

export interface EnsRecords {
  name: string;
  resolver: Address;
  endpoint: string;
  protocol: "a2a";
  agentRegistration?: string;
  agentRegistrationKey?: string;
}

export interface EnsReader {
  resolve(name: string, context?: { registryAddress?: Address; agentId?: string; blockNumber?: bigint }): Promise<EnsRecords>;
}

function assertEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("ENS_ENDPOINT_MISSING");
  }
  if (url.protocol !== "https:") throw new Error("ENDPOINT_NOT_HTTPS");
  if (endpoint !== endpoint.trim() || /[\x00-\x20\\]/.test(endpoint)
    || url.username || url.password || url.hash || endpoint.includes("#")) {
    throw new Error("IDENTITY_VERIFICATION_FAILED");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname.includes(".") || hostname === "localhost" || hostname === "0.0.0.0"
    || hostname.startsWith("127.") || hostname === "[::1]"
    || ["localhost", "example", "example.com", "example.net", "example.org", "invalid", "test"]
      .some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    throw new Error("IDENTITY_VERIFICATION_FAILED");
  }
  return url;
}

export class ViemEnsReader implements EnsReader {
  readonly client: PublicClient;
  readonly config: Required<Pick<EnsConfig, "agentEndpointKey" | "agentRegistrationKey" | "requireHttps">> & EnsConfig;

  constructor(config: EnsConfig, client?: PublicClient) {
    if (config.requireHttps === false) throw new Error("ENDPOINT_NOT_HTTPS");
    this.config = {
      agentEndpointKey: "agent-endpoint[a2a]",
      agentRegistrationKey: ensip25AgentRegistrationKey,
      requireHttps: true,
      ...config,
    };
    this.client = client ?? createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });
  }

  async resolve(name: string, context?: { registryAddress?: Address; agentId?: string; blockNumber?: bigint }): Promise<EnsRecords> {
    if (typeof name !== "string" || !name.includes(".") || !context?.registryAddress || context.agentId === undefined) {
      throw new Error("IDENTITY_VERIFICATION_FAILED");
    }
    if (context.blockNumber !== undefined && (typeof context.blockNumber !== "bigint" || context.blockNumber < 0n)) {
      throw new Error("IDENTITY_VERIFICATION_FAILED");
    }
    const canonicalKey = ensip25AgentRegistrationKey(context.registryAddress, context.agentId);
    let registrationKey: string;
    try {
      registrationKey = typeof this.config.agentRegistrationKey === "function"
        ? this.config.agentRegistrationKey(context.registryAddress, context.agentId)
        : this.config.agentRegistrationKey;
    } catch { throw new Error("IDENTITY_VERIFICATION_FAILED"); }
    if (registrationKey !== canonicalKey) throw new Error("IDENTITY_VERIFICATION_FAILED");
    if (this.config.agentEndpointKey !== "agent-endpoint[a2a]") {
      throw new Error("IDENTITY_VERIFICATION_FAILED");
    }
    let normalizedName: string;
    try { normalizedName = normalize(name); } catch { throw new Error("IDENTITY_VERIFICATION_FAILED"); }
    let blockNumber: bigint;
    try {
      if (await this.client.getChainId() !== ENSV2_SEPOLIA_CHAIN_ID) throw new Error("IDENTITY_VERIFICATION_FAILED");
      blockNumber = context.blockNumber ?? await this.client.getBlockNumber({ cacheTime: 0 });
    } catch { throw new Error("IDENTITY_VERIFICATION_FAILED"); }
    // Pin all records to one block so a concurrent update cannot mix identities.
    let resolver: Address | null;
    try { resolver = await this.client.getEnsResolver({ name: normalizedName, blockNumber }); }
    catch { throw new Error("IDENTITY_VERIFICATION_FAILED"); }
    if (!resolver || !isAddress(resolver, { strict: false }) || resolver.toLowerCase() === zeroAddress) {
      throw new Error("IDENTITY_VERIFICATION_FAILED");
    }
    let endpoint: string | null;
    try { endpoint = await this.client.getEnsText({ name: normalizedName, key: this.config.agentEndpointKey, blockNumber, strict: true }); }
    catch { throw new Error("ENS_ENDPOINT_MISSING"); }
    if (typeof endpoint !== "string" || !endpoint) throw new Error("ENS_ENDPOINT_MISSING");
    assertEndpoint(endpoint);
    let registration: string | null;
    try { registration = await this.client.getEnsText({ name: normalizedName, key: registrationKey, blockNumber, strict: true }); }
    catch { throw new Error("IDENTITY_VERIFICATION_FAILED"); }
    // ENSIP-25 gives the value no semantics beyond being a non-empty string.
    if (typeof registration !== "string" || registration.length === 0) {
      throw new Error("IDENTITY_VERIFICATION_FAILED");
    }
    return { name: normalizedName, resolver, endpoint, protocol: "a2a", agentRegistration: registration, agentRegistrationKey: registrationKey };
  }
}

export function createEnsReader(config: EnsConfig): EnsReader {
  return new ViemEnsReader(config);
}

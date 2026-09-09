import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { normalize } from "viem/ens";
import { sepolia } from "viem/chains";
import { isSafePublicHttpUrl } from "@frely-network/shared-types";

export const ENSIP25_AGENT_REGISTRATION_PREFIX = "agent-registration";
export const ENSV2_SEPOLIA_CHAIN_ID = 11155111;

function encodeErc7930EvmAddress(registryAddress: Address, chainId: number): string {
  if (!Number.isSafeInteger(chainId) || chainId < 0) throw new Error("IDENTITY_VERIFICATION_FAILED");
  const chainReference = chainId.toString(16).padStart(2, "0");
  const chainReferenceLength = (chainReference.length / 2).toString(16).padStart(2, "0");
  return `0x00010000${chainReferenceLength}${chainReference}14${registryAddress.slice(2).toLowerCase()}`;
}

export function ensip25AgentRegistrationKey(
  registryAddress: Address,
  agentId: string,
  chainId = ENSV2_SEPOLIA_CHAIN_ID,
): string {
  if (!agentId || /[\[\]]/.test(agentId)) throw new Error("IDENTITY_VERIFICATION_FAILED");
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
  protocol: "responses" | "mcp" | "http";
  agentRegistration?: string;
}

export interface EnsReader {
  resolve(name: string, context?: { registryAddress?: Address; agentId?: string }): Promise<EnsRecords>;
}

function assertEndpoint(endpoint: string, requireHttps: boolean): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("ENS_ENDPOINT_MISSING");
  }
  if (!isSafePublicHttpUrl(url.toString(), { requireHttps })) throw new Error("ENDPOINT_NOT_HTTPS");
  return url;
}

export class ViemEnsReader implements EnsReader {
  readonly client: PublicClient;
  readonly config: Required<Pick<EnsConfig, "agentEndpointKey" | "agentRegistrationKey" | "requireHttps">> & EnsConfig;

  constructor(config: EnsConfig, client?: PublicClient) {
    this.config = {
      agentEndpointKey: "agent-endpoint[responses]",
      agentRegistrationKey: ensip25AgentRegistrationKey,
      requireHttps: true,
      ...config,
    };
    this.client = client ?? createPublicClient({ chain: sepolia, transport: http(config.rpcUrl) });
  }

  async resolve(name: string, context?: { registryAddress?: Address; agentId?: string }): Promise<EnsRecords> {
    if (!name || !name.includes(".")) throw new Error("IDENTITY_VERIFICATION_FAILED");
    let normalizedName: string;
    try { normalizedName = normalize(name); } catch { throw new Error("IDENTITY_VERIFICATION_FAILED"); }
    let resolver: Address | null;
    try { resolver = await this.client.getEnsResolver({ name: normalizedName }); }
    catch { throw new Error("IDENTITY_VERIFICATION_FAILED"); }
    if (!resolver) throw new Error("IDENTITY_VERIFICATION_FAILED");
    let endpoint: string | null;
    try { endpoint = await this.client.getEnsText({ name: normalizedName, key: this.config.agentEndpointKey }); }
    catch { throw new Error("ENS_ENDPOINT_MISSING"); }
    if (!endpoint) throw new Error("ENS_ENDPOINT_MISSING");
    assertEndpoint(endpoint, this.config.requireHttps);
    const registrationKey = typeof this.config.agentRegistrationKey === "function"
      ? context?.registryAddress && context.agentId
        ? this.config.agentRegistrationKey(context.registryAddress, context.agentId)
        : ""
      : this.config.agentRegistrationKey;
    let registration = "";
    if (registrationKey) {
      try { registration = await this.client.getEnsText({ name: normalizedName, key: registrationKey }) ?? ""; }
      catch { throw new Error("IDENTITY_VERIFICATION_FAILED"); }
    }
    const protocolMatch = this.config.agentEndpointKey.match(/agent-endpoint\[([^\]]+)\]/i)?.[1];
    const protocol = protocolMatch === "mcp" ? "mcp" : protocolMatch === "http" ? "http" : "responses";
    return { name: normalizedName, resolver, endpoint, protocol, agentRegistration: registration || undefined };
  }
}

export function createEnsReader(config: EnsConfig): EnsReader {
  return new ViemEnsReader(config);
}

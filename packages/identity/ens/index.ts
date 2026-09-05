import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  namehash,
  type Address,
  type PublicClient,
} from "viem";
import { sepolia } from "viem/chains";

export const ENSIP25_AGENT_REGISTRATION_PREFIX = "agent-registration";

export function ensip25AgentRegistrationKey(registryAddress: Address, agentId: string): string {
  return `${ENSIP25_AGENT_REGISTRATION_PREFIX}[${registryAddress.toLowerCase()}][${agentId}]`;
}

export interface EnsConfig {
  rpcUrl: string;
  registryAddress: Address;
  /** Optional resolver address when the registry does not expose resolver(bytes32). */
  resolverAddress?: Address;
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

const resolverAbi = [
  {
    type: "function",
    name: "resolver",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "text",
    stateMutability: "view",
    inputs: [{ name: "node", type: "bytes32" }, { name: "key", type: "string" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

function assertEndpoint(endpoint: string, requireHttps: boolean): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("ENS_ENDPOINT_MISSING");
  }
  if (requireHttps && url.protocol !== "https:") throw new Error("ENDPOINT_NOT_HTTPS");
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("ENDPOINT_NOT_HTTPS");
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

  private async readText(resolver: Address, node: `0x${string}`, key: string): Promise<string> {
    const data = encodeFunctionData({ abi: resolverAbi, functionName: "text", args: [node, key] });
    const raw = await this.client.call({ to: resolver, data });
    if (!raw.data) return "";
    return decodeFunctionResult({ abi: resolverAbi, functionName: "text", data: raw.data });
  }

  async resolve(name: string, context?: { registryAddress?: Address; agentId?: string }): Promise<EnsRecords> {
    if (!name || !name.includes(".")) throw new Error("IDENTITY_VERIFICATION_FAILED");
    const node = namehash(name);
    let resolver = this.config.resolverAddress;
    if (!resolver) {
      const data = encodeFunctionData({ abi: resolverAbi, functionName: "resolver", args: [node] });
      const raw = await this.client.call({ to: this.config.registryAddress, data });
      if (!raw.data) throw new Error("IDENTITY_VERIFICATION_FAILED");
      resolver = decodeFunctionResult({ abi: resolverAbi, functionName: "resolver", data: raw.data }) as Address;
    }
    if (!resolver || /^0x0{40}$/i.test(resolver)) throw new Error("IDENTITY_VERIFICATION_FAILED");
    const endpoint = await this.readText(resolver, node, this.config.agentEndpointKey);
    if (!endpoint) throw new Error("ENS_ENDPOINT_MISSING");
    assertEndpoint(endpoint, this.config.requireHttps);
    const registrationKey = typeof this.config.agentRegistrationKey === "function"
      ? context?.registryAddress && context.agentId
        ? this.config.agentRegistrationKey(context.registryAddress, context.agentId)
        : ""
      : this.config.agentRegistrationKey;
    const registration = registrationKey ? await this.readText(resolver, node, registrationKey) : "";
    const protocolMatch = this.config.agentEndpointKey.match(/agent-endpoint\[([^\]]+)\]/i)?.[1];
    const protocol = protocolMatch === "mcp" ? "mcp" : protocolMatch === "http" ? "http" : "responses";
    return { name, resolver, endpoint, protocol, agentRegistration: registration || undefined };
  }
}

export function createEnsReader(config: EnsConfig): EnsReader {
  return new ViemEnsReader(config);
}

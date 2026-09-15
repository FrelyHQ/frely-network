import type { ProviderCandidate, ResolvedProvider } from "@frely-network/shared-types";

export interface ProviderIdentityResolverPort {
  resolveProvider(candidate: ProviderCandidate): Promise<ResolvedProvider>;
}

export interface FrelyAgentDiscoveryConfig {
  readonly origin: string;
  readonly apiKey: string;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
}

export interface FrelyAgentCapability {
  readonly id: string;
  readonly level: "base" | "advanced";
  readonly entrypoints: readonly ("model" | "mcp" | "a2a")[];
  readonly description?: string;
  readonly priceRef?: string;
}

export interface FrelyAgentCatalogEntry {
  readonly id: string;
  readonly model: string;
  readonly name: string;
  readonly owned_by: string;
  readonly agent_id: string;
  readonly version: string;
  readonly capabilities: readonly FrelyAgentCapability[];
}

function validOrigin(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error();
    return url;
  } catch { throw new Error("FRELY_DISCOVERY_CONFIG_INVALID"); }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\r\n\u0000]/u.test(value);
}

function parseCapability(value: unknown): FrelyAgentCapability | undefined {
  const source = record(value);
  if (!source || !boundedString(source.id, 96) || (source.level !== "base" && source.level !== "advanced") || !Array.isArray(source.entrypoints)) return undefined;
  const entrypoints = source.entrypoints.filter((entrypoint): entrypoint is "model" | "mcp" | "a2a" => entrypoint === "model" || entrypoint === "mcp" || entrypoint === "a2a");
  if (entrypoints.length !== source.entrypoints.length || entrypoints.length < 1 || new Set(entrypoints).size !== entrypoints.length) return undefined;
  if (source.description !== undefined && !boundedString(source.description, 256)) return undefined;
  if (source.priceRef !== undefined && !boundedString(source.priceRef, 256)) return undefined;
  return {
    id: source.id,
    level: source.level,
    entrypoints,
    ...(source.description === undefined ? {} : { description: source.description }),
    ...(source.priceRef === undefined ? {} : { priceRef: source.priceRef }),
  };
}

function parseEntry(value: unknown): FrelyAgentCatalogEntry | undefined {
  const source = record(value);
  if (!source || source.object !== "agent" || !boundedString(source.id, 256) || !boundedString(source.model, 256) || source.id !== source.model ||
      !boundedString(source.name, 256) || !boundedString(source.owned_by, 256) || !boundedString(source.agent_id, 128) ||
      !/^vm-[a-f0-9]{32}$/u.test(source.agent_id) || !boundedString(source.version, 32) || !Array.isArray(source.capabilities)) return undefined;
  const parsedCapabilities = source.capabilities.map(parseCapability);
  if (parsedCapabilities.some((capability) => capability === undefined)) return undefined;
  return {
    id: source.id,
    model: source.model,
    name: source.name,
    owned_by: source.owned_by,
    agent_id: source.agent_id,
    version: source.version,
    capabilities: parsedCapabilities as FrelyAgentCapability[],
  };
}

/** Reads Bob-owned executable Agents from Frely's authenticated Web2 catalog. */
export class FrelyAgentDiscovery {
  private readonly origin: URL;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly config: FrelyAgentDiscoveryConfig,
    private readonly fetcher: (input: string, init: RequestInit) => Promise<Response> = (input, init) => fetch(input, init),
  ) {
    this.origin = validOrigin(config.origin);
    if (!boundedString(config.apiKey, 4096)) throw new Error("FRELY_DISCOVERY_CONFIG_INVALID");
    this.timeoutMs = config.requestTimeoutMs ?? 10_000;
    this.maxResponseBytes = config.maxResponseBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new Error("FRELY_DISCOVERY_CONFIG_INVALID");
    }
  }

  async findProviders(capabilities: string[]): Promise<ProviderCandidate[]> {
    const wanted = [...new Set(capabilities.filter((value): value is string => boundedString(value, 96)))];
    if (!wanted.length) throw new Error("CAPABILITY_NOT_SUPPORTED");
    const endpoint = new URL("/v1/agents", this.origin).toString();
    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "GET",
        headers: { accept: "application/json", authorization: `Bearer ${this.config.apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { throw new Error("FRELY_DISCOVERY_FAILED"); }
    if (!response.ok || response.redirected) throw new Error("FRELY_DISCOVERY_FAILED");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength < 1 || bytes.byteLength > this.maxResponseBytes) throw new Error("FRELY_DISCOVERY_FAILED");
    let payload: unknown;
    try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("FRELY_DISCOVERY_SCHEMA_INVALID"); }
    const root = record(payload);
    if (!root || root.object !== "list" || !Array.isArray(root.data)) throw new Error("FRELY_DISCOVERY_SCHEMA_INVALID");

    const result: ProviderCandidate[] = [];
    for (const raw of root.data) {
      const entry = parseEntry(raw);
      if (!entry) continue;
      const callable = entry.capabilities.filter((capability) => capability.entrypoints.includes("a2a"));
      const ids = callable.map((capability) => capability.id);
      if (!wanted.every((capability) => ids.includes(capability))) continue;
      result.push({
        id: entry.agent_id,
        capabilities: ids,
        supportsX402: false,
        protocol: "a2a",
        endpoint: new URL("/a2a", this.origin).toString(),
        model: entry.model,
        source: "frely",
        underlyingAgent: {
          platform: "frely",
          agentId: entry.agent_id,
          model: entry.model,
          version: entry.version,
          ownerRef: entry.owned_by,
        },
      });
    }
    if (!result.length) throw new Error("NO_PROVIDER");
    return result;
  }
}

/** Resolves an authenticated Frely catalog row without treating it as Alice's Web3 identity. */
export class FrelyAgentResolver {
  private readonly origin: URL;
  constructor(origin: string) { this.origin = validOrigin(origin); }

  async resolveProvider(candidate: ProviderCandidate): Promise<ResolvedProvider> {
    if (candidate.source !== "frely" || candidate.protocol !== "a2a" || !candidate.model || !candidate.underlyingAgent || candidate.offering) {
      throw new Error("IDENTITY_VERIFICATION_FAILED");
    }
    const endpoint = new URL("/a2a", this.origin).toString();
    if (candidate.endpoint !== endpoint || candidate.id !== candidate.underlyingAgent.agentId || candidate.model !== candidate.underlyingAgent.model) {
      throw new Error("IDENTITY_VERIFICATION_FAILED");
    }
    return {
      id: candidate.id,
      endpoint,
      protocol: "a2a",
      verified: true,
      model: candidate.model,
      source: "frely",
      underlyingAgent: candidate.underlyingAgent,
    };
  }
}


/** Resolves Alice's Web3 identity and binds an Offering to Bob's current Frely Agent catalog entry. */
export class FrelyOfferingResolver implements ProviderIdentityResolverPort {
  constructor(
    private readonly publisherIdentity: ProviderIdentityResolverPort,
    private readonly underlyingAgents: Pick<FrelyAgentDiscovery, "findProviders">,
  ) {}

  async resolveProvider(candidate: ProviderCandidate): Promise<ResolvedProvider> {
    const publisher = await this.publisherIdentity.resolveProvider(candidate);
    if (!candidate.offering) return publisher;
    if (!candidate.underlyingAgent) throw new Error("IDENTITY_VERIFICATION_FAILED");

    const catalog = await this.underlyingAgents.findProviders(candidate.capabilities);
    const target = catalog.find((agent) =>
      agent.source === "frely"
      && agent.protocol === "a2a"
      && Boolean(agent.endpoint)
      && agent.model === candidate.underlyingAgent?.model
      && agent.underlyingAgent?.agentId === candidate.underlyingAgent?.agentId
      && (candidate.underlyingAgent?.ownerRef === undefined || agent.underlyingAgent?.ownerRef === candidate.underlyingAgent.ownerRef),
    );
    if (!target?.endpoint || !target.model || !target.underlyingAgent) throw new Error("IDENTITY_VERIFICATION_FAILED");

    return {
      ...publisher,
      endpoint: target.endpoint,
      protocol: "a2a",
      model: target.model,
      source: "the_graph",
      underlyingAgent: target.underlyingAgent,
      offering: { ...candidate.offering, underlyingAgent: target.underlyingAgent },
    };
  }
}

export function createFrelyAgentDiscovery(config: FrelyAgentDiscoveryConfig): FrelyAgentDiscovery {
  return new FrelyAgentDiscovery(config);
}
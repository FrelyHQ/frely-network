import type { ProviderCandidate } from "@frely-network/shared-types";
import {
  fetchRegistrationMetadata,
  normalizeAgentId,
  normalizeEnsName,
  normalizeRegistrationMetadata,
  normalizeRegistryAddress,
  P0_PAYMENT_NETWORK,
  type P0CapabilityProviderManifest,
} from "@frely-network/protocol-manifest";

export interface GraphConfig {
  endpoint: string;
  query?: string;
  network?: string;
  registryAddress: string;
  paymentNetwork: string;
  /** Optional HTTPS gateway for agentURI values using ipfs://. */
  metadataGateway?: string;
  requestTimeoutMs?: number;
}

export interface GraphRegistrationFile {
  ens?: string;
  active?: boolean;
  x402Support?: boolean;
  oasfSkills?: unknown;
  oasfDomains?: unknown;
  endpointsRawJson?: unknown;
  [key: string]: unknown;
}

export interface GraphProviderRow {
  id?: string;
  chainId?: string | number;
  agentId?: string | number;
  ensName?: string;
  ens?: string;
  active?: boolean;
  capabilities?: unknown;
  supportsX402?: boolean;
  payment?: { protocol?: string; network?: string };
  reputation?: number;
  metadataUri?: string;
  agentURI?: string;
  registrationFile?: GraphRegistrationFile | null;
  metadata?: { capabilities?: unknown; endpoint?: string; protocol?: string; payment?: { protocol?: string; network?: string } };
  [key: string]: unknown;
}

export interface GraphFetcher {
  (endpoint: string, init: RequestInit): Promise<Response>;
}

const defaultQuery = `query Providers { agents(first: 1000) { id chainId agentId agentURI registrationFile { ens active x402Support oasfSkills oasfDomains endpointsRawJson } } }`;

function asCapabilities(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return [];
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validGraphEndpoint(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password && !parsed.hash;
  } catch { return false; }
}

function enabled(values: unknown[]): boolean {
  const present = values.filter((value) => value !== undefined);
  return present.length > 0 && present.every((value) => value === true);
}

function agentIdFromRow(row: GraphProviderRow, network: string): string {
  if (row.chainId !== undefined && normalizeAgentId(row.chainId) !== network) {
    throw new Error("GRAPH_IDENTITY_MISMATCH");
  }
  let compositeAgentId: string | undefined;
  if (row.id !== undefined) {
    if (typeof row.id !== "string") throw new Error("GRAPH_IDENTITY_MISMATCH");
    const parts = row.id.split(":");
    if (parts.length !== 2 || parts[0] !== network) throw new Error("GRAPH_IDENTITY_MISMATCH");
    compositeAgentId = normalizeAgentId(parts[1]);
  }
  const agentId = row.agentId !== undefined ? normalizeAgentId(row.agentId) : compositeAgentId;
  if (agentId === undefined || (compositeAgentId !== undefined && compositeAgentId !== agentId)) {
    throw new Error("GRAPH_IDENTITY_MISMATCH");
  }
  return agentId;
}

export class TheGraphDiscovery {
  private readonly fetcher: GraphFetcher;
  private readonly network: string;
  private readonly registryAddress: string;
  constructor(private readonly config: GraphConfig, fetcher: GraphFetcher = (endpoint, init) => fetch(endpoint, init)) {
    try {
      if (!config.endpoint || !validGraphEndpoint(config.endpoint)) throw new Error();
      this.network = config.network ?? "11155111";
      if (this.network !== "11155111" || config.paymentNetwork !== P0_PAYMENT_NETWORK) throw new Error();
      this.registryAddress = normalizeRegistryAddress(config.registryAddress);
      if (config.query !== undefined && (typeof config.query !== "string" || !config.query.trim())) throw new Error();
      if (config.requestTimeoutMs !== undefined && (!Number.isSafeInteger(config.requestTimeoutMs) || config.requestTimeoutMs <= 0)) throw new Error();
    } catch { throw new Error("GRAPH_CONFIG_INVALID"); }
    this.fetcher = fetcher;
  }

  async findProviders(capabilities: string[]): Promise<ProviderCandidate[]> {
    const wanted = [...new Set(
      capabilities
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean),
    )];
    if (!wanted.length) throw new Error("CAPABILITY_NOT_SUPPORTED");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs ?? 10_000);
    let response: Response;
    try {
      response = await this.fetcher(this.config.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: this.config.query ?? defaultQuery }),
        signal: controller.signal,
        redirect: "error",
      });
    } catch { throw new Error("GRAPH_QUERY_FAILED"); }
    finally { clearTimeout(timeout); }
    if (!response.ok) throw new Error("GRAPH_QUERY_FAILED");
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new Error("GRAPH_SCHEMA_INVALID"); }
    const rows = this.extractRows(payload);
    const result: ProviderCandidate[] = [];
    for (const row of rows) {
      const registration = row.registrationFile;
      if (registration !== undefined && registration !== null && !isRecord(registration)) continue;
      if (!enabled([row.active, registration?.active]) || !enabled([row.supportsX402, registration?.x402Support])) continue;
      let agentId: string;
      let manifest: P0CapabilityProviderManifest;
      let ensName: string;
      try {
        agentId = agentIdFromRow(row, this.network);
        const names = [registration?.ens, row.ensName, row.ens].filter((value) => value !== undefined).map(normalizeEnsName);
        if (!names.length || names.some((name) => name !== names[0])) continue;
        ensName = names[0]!;
        if (row.agentURI !== undefined && row.metadataUri !== undefined && row.agentURI !== row.metadataUri) continue;
        const sourceUri = row.agentURI ?? row.metadataUri;
        if (typeof sourceUri !== "string" || !sourceUri) continue;
        // Indexed fields never replace a missing or invalid registration file.
        const metadata = await fetchRegistrationMetadata(sourceUri, {
          ...(this.config.metadataGateway !== undefined ? { gateway: this.config.metadataGateway } : {}),
          ...(this.config.requestTimeoutMs !== undefined ? { timeoutMs: this.config.requestTimeoutMs } : {}),
        }, this.fetcher);
        if (!isRecord(metadata)) continue;
        if ((metadata.active !== undefined && metadata.active !== true) ||
            (metadata.x402Support !== undefined && metadata.x402Support !== true)) continue;
        manifest = normalizeRegistrationMetadata(metadata, {
          chainId: Number(this.network), registryAddress: this.registryAddress, agentId,
        });
        if (normalizeEnsName(manifest.identity.ens) !== ensName || manifest.payment.network !== this.config.paymentNetwork) continue;
        const payments = [row.payment, row.metadata?.payment].filter((payment) => payment !== undefined);
        if (payments.some((payment) => !isRecord(payment) ||
          (payment.protocol !== undefined && payment.protocol !== manifest.payment.protocol) ||
          (payment.network !== undefined && payment.network !== manifest.payment.network))) continue;
      } catch { continue; }
      const rowCaps = asCapabilities(manifest.capabilities);
      if (!wanted.every((capability) => rowCaps.includes(capability))) continue;
      result.push({ id: agentId, ensName, capabilities: rowCaps, supportsX402: true, ...(typeof row.reputation === "number" && Number.isFinite(row.reputation) ? { reputation: row.reputation } : {}) });
    }
    if (!result.length) throw new Error("NO_PROVIDER");
    return result;
  }

  private extractRows(payload: unknown): GraphProviderRow[] {
    if (!isRecord(payload)) throw new Error("GRAPH_SCHEMA_INVALID");
    if (payload.errors !== undefined) {
      if (!Array.isArray(payload.errors)) throw new Error("GRAPH_SCHEMA_INVALID");
      if (payload.errors.length > 0) throw new Error("GRAPH_QUERY_FAILED");
    }
    if (!isRecord(payload.data)) throw new Error("GRAPH_SCHEMA_INVALID");
    const collection = payload.data.agents;
    if (!Array.isArray(collection) || !collection.every(isRecord)) throw new Error("GRAPH_SCHEMA_INVALID");
    return collection as GraphProviderRow[];
  }
}

export function createGraphDiscovery(config: GraphConfig): TheGraphDiscovery {
  return new TheGraphDiscovery(config);
}

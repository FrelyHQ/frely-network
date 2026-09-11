import { isSafePublicHttpUrl, type ProviderCandidate } from "@frely-network/shared-types";
import {
  validateManifest,
  type P0CapabilityProviderManifest,
} from "@frely-network/protocol-manifest";

export interface GraphConfig {
  endpoint: string;
  query?: string;
  network?: string;
  paymentNetwork: string;
  /** Optional HTTP gateway for agentURI values using ipfs://. */
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
  registrationFile?: GraphRegistrationFile;
  metadata?: { capabilities?: unknown; endpoint?: string; protocol?: string; payment?: { protocol?: string; network?: string } };
  [key: string]: unknown;
}

export interface GraphFetcher {
  (endpoint: string, init: RequestInit): Promise<Response>;
}

const defaultQuery = `query Providers { agents(first: 1000) { id agentId agentURI registrationFile { ens active x402Support oasfSkills oasfDomains endpointsRawJson } } }`;

function asCapabilities(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return [];
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function validUri(value: string): boolean {
  return isSafePublicHttpUrl(value, { requireHttps: false });
}

function metadataUri(value: string, gateway?: string): string | undefined {
  try {
    const parsed = new URL(value);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && isSafePublicHttpUrl(parsed.toString(), { requireHttps: false })) return parsed.toString();
    if (parsed.protocol !== "ipfs:" || !gateway) return undefined;
    const base = gateway.endsWith("/") ? gateway : `${gateway}/`;
    const resolved = base.includes("{cid}")
      ? base.replace("{cid}", parsed.pathname.replace(/^\/+/, ""))
      : `${base}${parsed.pathname.replace(/^\/+/, "")}`;
    return isSafePublicHttpUrl(resolved, { requireHttps: false }) ? resolved : undefined;
  } catch { return undefined; }
}

function indexedManifest(row: GraphProviderRow, ensName: string, paymentNetwork: string): unknown | undefined {
  const file = row.registrationFile;
  if (!file) return undefined;
  const capabilities = [
    ...asCapabilities(file.oasfSkills),
    ...asCapabilities(file.oasfDomains),
  ];
  let interfaces: unknown;
  try {
    const parsed = typeof file.endpointsRawJson === "string" ? JSON.parse(file.endpointsRawJson) : file.endpointsRawJson;
    const entries = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed) : [];
    interfaces = entries.map((entry) => {
      if (typeof entry === "string") return { protocol: "responses", endpoint: entry };
      if (entry && typeof entry === "object") {
        const value = entry as { endpoint?: unknown; url?: unknown; protocol?: unknown };
        return { protocol: value.protocol ?? "responses", endpoint: value.endpoint ?? value.url };
      }
      return entry;
    });
  } catch { return undefined; }
  return {
    name: ensName,
    capabilities,
    identity: { ens: file.ens ?? ensName, ...(row.agentId !== undefined ? { agentId: String(row.agentId) } : {}) },
    interfaces,
    payment: { protocol: "x402", network: paymentNetwork },
  };
}

export class TheGraphDiscovery {
  private readonly fetcher: GraphFetcher;
  constructor(private readonly config: GraphConfig, fetcher: GraphFetcher = (endpoint, init) => fetch(endpoint, init)) {
    if (!config.endpoint || !validUri(config.endpoint)) throw new Error("GRAPH_CONFIG_INVALID");
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
      if (row.active !== true && registration?.active !== true) continue;
      const ensName = typeof registration?.ens === "string"
        ? registration.ens
        : typeof row.ensName === "string" ? row.ensName : typeof row.ens === "string" ? row.ens : undefined;
      if (!ensName) continue;
      const rowPayment = row.payment ?? row.metadata?.payment;
      const supportsX402 = registration?.x402Support === true || row.supportsX402 === true || rowPayment?.protocol?.toLowerCase() === "x402";
      if (!supportsX402 || (rowPayment?.network && rowPayment.network !== this.config.paymentNetwork)) continue;
      // A Graph row is only a discovery hint. The registration manifest is the
      // authority for capabilities, identity, endpoint and payment eligibility.
      let manifest: P0CapabilityProviderManifest;
      const sourceUri = typeof row.metadataUri === "string" ? row.metadataUri : row.agentURI;
      const resolvedUri = sourceUri ? metadataUri(sourceUri, this.config.metadataGateway) : undefined;
      if (resolvedUri) {
        let metadataResponse: Response;
        try { metadataResponse = await this.fetcher(resolvedUri, { method: "GET", headers: { accept: "application/json" } }); }
        catch { continue; }
        if (!metadataResponse.ok) continue;
        try { manifest = validateManifest(await metadataResponse.json()); }
        catch { continue; }
      } else {
        const indexed = indexedManifest(row, ensName, this.config.paymentNetwork);
        if (!indexed) continue;
        try { manifest = validateManifest(indexed); }
        catch { continue; }
      }
      if (manifest.identity.ens !== ensName || manifest.payment.network !== this.config.paymentNetwork) continue;
      const rowCaps = asCapabilities(manifest.capabilities);
      if (!wanted.every((capability) => rowCaps.includes(capability))) continue;
      const idValue = row.agentId ?? row.id;
      if (idValue === undefined || idValue === null || String(idValue).length === 0) continue;
      const supportsA2A = manifest.interfaces.some((entry) => entry.protocol === "a2a");
      result.push({ id: String(idValue), ensName, ...(supportsA2A ? { protocol: "a2a" as const } : {}), capabilities: rowCaps, supportsX402: true, ...(typeof row.reputation === "number" ? { reputation: row.reputation } : {}) });
    }
    if (!result.length) throw new Error("NO_PROVIDER");
    return result;
  }

  private extractRows(payload: unknown): GraphProviderRow[] {
    if (!payload || typeof payload !== "object") throw new Error("GRAPH_SCHEMA_INVALID");
    const body = payload as { errors?: unknown; data?: Record<string, unknown> };
    if (body.errors || !body.data) throw new Error("GRAPH_SCHEMA_INVALID");
    const collection = Object.values(body.data).find((value) => Array.isArray(value));
    if (!Array.isArray(collection) || !collection.every((row) => row && typeof row === "object")) throw new Error("GRAPH_SCHEMA_INVALID");
    return collection as GraphProviderRow[];
  }
}

export function createGraphDiscovery(config: GraphConfig): TheGraphDiscovery {
  return new TheGraphDiscovery(config);
}

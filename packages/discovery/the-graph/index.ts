import type { ProviderCandidate } from "@frely-network/shared-types";
import {
  validateManifest,
  type P0CapabilityProviderManifest,
} from "@frely-network/protocol-manifest";

export interface GraphConfig {
  endpoint: string;
  query?: string;
  network?: string;
  paymentNetwork: string;
  requestTimeoutMs?: number;
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
  metadata?: { capabilities?: unknown; endpoint?: string; protocol?: string; payment?: { protocol?: string; network?: string } };
  [key: string]: unknown;
}

export interface GraphFetcher {
  (endpoint: string, init: RequestInit): Promise<Response>;
}

const defaultQuery = `query Providers { agents(first: 1000, where: { active: true }) { id agentId ensName ens active capabilities supportsX402 reputation metadataUri metadata { capabilities endpoint protocol payment { protocol network } } } }`;

function asCapabilities(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return [];
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function validUri(value: string): boolean {
  try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; }
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
      if (row.active !== true) continue;
      const ensName = typeof row.ensName === "string" ? row.ensName : typeof row.ens === "string" ? row.ens : undefined;
      if (!ensName) continue;
      const rowPayment = row.payment ?? row.metadata?.payment;
      const supportsX402 = row.supportsX402 === true || rowPayment?.protocol?.toLowerCase() === "x402";
      if (!supportsX402 || (rowPayment?.network && rowPayment.network !== this.config.paymentNetwork)) continue;
      // A Graph row is only a discovery hint. The registration manifest is the
      // authority for capabilities, identity, endpoint and payment eligibility.
      if (typeof row.metadataUri !== "string" || !validUri(row.metadataUri)) continue;
      let metadataResponse: Response;
      try { metadataResponse = await this.fetcher(row.metadataUri, { method: "GET", headers: { accept: "application/json" } }); }
      catch { continue; }
      if (!metadataResponse.ok) continue;
      let manifest: P0CapabilityProviderManifest;
      try { manifest = validateManifest(await metadataResponse.json()); }
      catch { continue; }
      if (manifest.identity.ens !== ensName || manifest.payment.network !== this.config.paymentNetwork) continue;
      const rowCaps = asCapabilities(manifest.capabilities);
      if (!wanted.every((capability) => rowCaps.includes(capability))) continue;
      const idValue = row.agentId ?? row.id;
      if (idValue === undefined || idValue === null || String(idValue).length === 0) continue;
      result.push({ id: String(idValue), ensName, capabilities: rowCaps, supportsX402: true, ...(typeof row.reputation === "number" ? { reputation: row.reputation } : {}) });
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

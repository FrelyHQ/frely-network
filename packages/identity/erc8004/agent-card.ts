import { fetchRegistrationMetadata, normalizeHttpsUrl, type MetadataFetcher } from "@frely-network/protocol-manifest";

export type A2AProtocolVersion = "0.3.0" | "1.0";
export interface AgentCardOptions { fetcher?: MetadataFetcher; timeoutMs?: number; }

/** P0 fetch/execute targets exclude local names and non-public IP literals. */
export function publicA2AUrl(value: unknown): `https://${string}` {
  const normalized = normalizeHttpsUrl(value);
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (String(value).includes("#") || !host.includes(".") || host.startsWith("[") ||
      ["localhost", "local", "internal"].some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new Error("A2A_CARD_INVALID");
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
        (a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) ||
        (a === 203 && b === 0 && c === 113)) throw new Error("A2A_CARD_INVALID");
  }
  return normalized;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(text); }

/** Validate discovery information only; this never proves task execution or payment. */
export async function inspectAgentCard(
  cardUrl: string, executionUrl: string, options: AgentCardOptions = {},
): Promise<{ agentCardUrl: string; endpoint: string; a2aProtocolVersion: A2AProtocolVersion }> {
  try {
    const agentCardUrl = publicA2AUrl(cardUrl);
    const endpoint = publicA2AUrl(executionUrl);
    const card = await fetchRegistrationMetadata(agentCardUrl,
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }, options.fetcher);
    if (!record(card) || !text(card.name) || !text(card.description) || !text(card.version) ||
        !record(card.capabilities) || !strings(card.defaultInputModes) || !card.defaultInputModes.length ||
        !strings(card.defaultOutputModes) || !card.defaultOutputModes.length ||
        !Array.isArray(card.skills) || !card.skills.length ||
        card.skills.some((skill) => !record(skill) || !text(skill.id) || !text(skill.name) ||
          !text(skill.description) || !strings(skill.tags))) throw new Error("A2A_CARD_INVALID");
    if (new Set(card.skills.map((skill) => (skill as { id: string }).id)).size !== card.skills.length) {
      throw new Error("A2A_CARD_INVALID");
    }
    if (card.supportedInterfaces !== undefined) {
      if (card.url !== undefined || card.protocolVersion !== undefined || card.preferredTransport !== undefined ||
          !Array.isArray(card.supportedInterfaces) || !card.supportedInterfaces.length) throw new Error("A2A_CARD_INVALID");
      const interfaces = card.supportedInterfaces.map((entry) => {
        if (!record(entry) || !text(entry.protocolVersion) || !text(entry.protocolBinding) || !text(entry.url)) {
          throw new Error("A2A_CARD_INVALID");
        }
        return { protocolVersion: entry.protocolVersion, protocolBinding: entry.protocolBinding,
          url: publicA2AUrl(entry.url), tenant: entry.tenant };
      });
      const supported = interfaces.filter((entry) => entry.protocolVersion === "1.0" && entry.protocolBinding === "JSONRPC");
      if (!supported.length) throw new Error("A2A_PROTOCOL_NOT_SUPPORTED");
      const matching = supported.filter((entry) => entry.url === endpoint);
      if (!matching.length) throw new Error("A2A_ENDPOINT_MISMATCH");
      if (matching.some((entry) => entry.tenant !== undefined && entry.tenant !== "")) {
        throw new Error("A2A_PROTOCOL_NOT_SUPPORTED");
      }
      return { agentCardUrl, endpoint, a2aProtocolVersion: "1.0" };
    }
    if (card.protocolVersion !== "0.3.0" || card.preferredTransport !== "JSONRPC") {
      throw new Error("A2A_PROTOCOL_NOT_SUPPORTED");
    }
    if (publicA2AUrl(card.url) !== endpoint) throw new Error("A2A_ENDPOINT_MISMATCH");
    return { agentCardUrl, endpoint, a2aProtocolVersion: "0.3.0" };
  } catch (error) {
    const safe = ["A2A_CARD_INVALID", "A2A_PROTOCOL_NOT_SUPPORTED", "A2A_ENDPOINT_MISMATCH"];
    throw new Error(error instanceof Error && safe.includes(error.message) ? error.message : "A2A_CARD_INVALID");
  }
}

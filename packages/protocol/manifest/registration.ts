import { getAddress, zeroAddress, type Address } from "viem";
import { normalize } from "viem/ens";
import {
  validateManifest, validateLegacyManifest,
  type P0CapabilityProviderManifest, type LegacyResponsesManifest,
} from "./index.ts";

export const ERC8004_REGISTRATION_TYPE = "https://eips.ethereum.org/EIPS/eip-8004#registration-v1";

export interface RegistrationContext {
  chainId: number;
  registryAddress: string;
  agentId: string;
}

function invalid(): never { throw new Error("REGISTRATION_METADATA_INVALID"); }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return invalid();
  return value.trim();
}

export function normalizeAgentId(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return invalid();
    value = String(value);
  }
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) ||
      value.length > 78 || BigInt(value) >= (1n << 256n)) return invalid();
  return value;
}

export function normalizeRegistryAddress(value: unknown): Address {
  try {
    const address = getAddress(string(value));
    if (address === zeroAddress) return invalid();
    return address;
  } catch { return invalid(); }
}

export function normalizeEnsName(value: unknown): string {
  try {
    const name = normalize(string(value));
    if (!name.includes(".")) return invalid();
    return name;
  } catch { return invalid(); }
}

export function normalizeHttpsUrl(value: unknown): `https://${string}` {
  const text = string(value);
  let url: URL;
  try { url = new URL(text); } catch { return invalid(); }
  if (url.protocol !== "https:") throw new Error("ENDPOINT_NOT_HTTPS");
  if (/[<>\s\\]/.test(text) || url.username || url.password || url.hash || !url.hostname) return invalid();
  return url.toString() as `https://${string}`;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return invalid();
  return [...new Set(value.map(string))];
}

function agree(values: string[]): string {
  if (!values.length || values.some((value) => value !== values[0])) return invalid();
  return values[0];
}

function verifyRegistrations(value: unknown, context: RegistrationContext): void {
  if (!Array.isArray(value) || !value.length) return invalid();
  let matched = false;
  for (const item of value) {
    const entry = record(item);
    const id = normalizeAgentId(entry.agentId);
    const parts = string(entry.agentRegistry).split(":");
    if (parts.length !== 3 || parts[0] !== "eip155" || !/^[1-9][0-9]*$/.test(parts[1])) return invalid();
    const chain = Number(parts[1]);
    if (!Number.isSafeInteger(chain)) return invalid();
    const address = normalizeRegistryAddress(parts[2]);
    if (chain === context.chainId && address === context.registryAddress) {
      if (id !== context.agentId) return invalid();
      matched = true;
    }
  }
  if (!matched) return invalid();
}

/** Normalize A2A metadata, preserving the native x402 declaration separately from the Network payment profile. */
export function normalizeRegistrationMetadata(
  value: unknown,
  context: RegistrationContext,
): P0CapabilityProviderManifest & { x402Support: boolean } {
  return normalizeMetadata(value, context, "a2a") as P0CapabilityProviderManifest & { x402Support: boolean };
}

/** Management and historical audit only. Production normalization never falls back to Responses. */
export function normalizeLegacyRegistrationMetadata(
  value: unknown,
  context: RegistrationContext,
): LegacyResponsesManifest {
  return normalizeMetadata(value, context, "responses") as LegacyResponsesManifest;
}

function normalizeMetadata(
  value: unknown,
  context: RegistrationContext,
  protocol: "a2a" | "responses",
): (P0CapabilityProviderManifest & { x402Support: boolean }) | LegacyResponsesManifest {
  if (!Number.isSafeInteger(context.chainId) || context.chainId <= 0) return invalid();
  const registryAddress = normalizeRegistryAddress(context.registryAddress);
  const agentId = normalizeAgentId(context.agentId);
  const file = record(value);
  const extension = file.metadata === undefined ? {} : record(file.metadata);
  const sources = [file, extension];
  const isRegistration = file.type !== undefined || file.services !== undefined;
  if (isRegistration && (file.type !== ERC8004_REGISTRATION_TYPE || !Array.isArray(file.services) ||
      file.active !== true)) return invalid();
  if (protocol === "a2a") {
    if (file.active !== true || typeof file.x402Support !== "boolean") return invalid();
  } else if (isRegistration && file.x402Support !== true) return invalid();

  const names: string[] = [];
  const endpoints: string[] = [];
  const cardUrls: string[] = [];
  let hasA2AInterface = false;
  let hasA2AService = false;
  const capabilityClaims: string[][] = [];
  const paymentClaims: Array<Record<string, unknown>> = [];
  const oasfSkills: string[] = [];

  for (const source of sources) {
    if (source.active !== undefined && source.active !== true) return invalid();
    if (source.x402Support !== undefined && source.x402Support !==
        (protocol === "a2a" ? file.x402Support : true)) return invalid();
    if (source.identity !== undefined) {
      const identity = record(source.identity);
      if (identity.ens !== undefined) names.push(normalizeEnsName(identity.ens));
      if (identity.agentId !== undefined && normalizeAgentId(identity.agentId) !== agentId) return invalid();
    }
    for (const field of ["ens", "ensName"]) {
      if (source[field] !== undefined) names.push(normalizeEnsName(source[field]));
    }
    if (source.agentId !== undefined && normalizeAgentId(source.agentId) !== agentId) return invalid();
    if (source.agentRegistry !== undefined) {
      verifyRegistrations([{ agentId, agentRegistry: source.agentRegistry }], { ...context, registryAddress, agentId });
    }
    if (source.registrations !== undefined) {
      verifyRegistrations(source.registrations, { ...context, registryAddress, agentId });
    }
    if (source.capabilities !== undefined) {
      const capabilities = strings(source.capabilities);
      if (!capabilities.length) return invalid();
      capabilityClaims.push(capabilities);
    }
    if (source.payment !== undefined) paymentClaims.push(record(source.payment));
    if (source.interfaces !== undefined) {
      if (!Array.isArray(source.interfaces) || !source.interfaces.length) return invalid();
      if (protocol === "a2a" && source.interfaces.length !== 1) return invalid();
      for (const item of source.interfaces) {
        const providerInterface = record(item);
        if (providerInterface.protocol !== protocol) throw new Error("PROTOCOL_NOT_SUPPORTED");
        endpoints.push(normalizeHttpsUrl(providerInterface.endpoint));
        if (protocol === "a2a") {
          cardUrls.push(normalizeHttpsUrl(providerInterface.agentCardUrl));
          hasA2AInterface = true;
        }
      }
    }
    if (source.protocol !== undefined && source.protocol !== protocol) throw new Error("PROTOCOL_NOT_SUPPORTED");
    if (source.endpoint !== undefined) {
      if (source.protocol !== protocol) throw new Error("PROTOCOL_NOT_SUPPORTED");
      endpoints.push(normalizeHttpsUrl(source.endpoint));
    }
  }

  if (Array.isArray(file.services)) {
    for (const item of file.services) {
      const service = record(item);
      const name = string(service.name).toLowerCase();
      const endpoint = string(service.endpoint);
      if (name === "ens") names.push(normalizeEnsName(endpoint));
      if (protocol === "responses" && name === "responses") endpoints.push(normalizeHttpsUrl(endpoint));
      if (protocol === "a2a" && name === "a2a") {
        // ERC-8004 publishes the Agent Card here, never the execution endpoint.
        cardUrls.push(normalizeHttpsUrl(endpoint));
        hasA2AService = true;
      }
      if (name === "oasf" && service.skills !== undefined) oasfSkills.push(...strings(service.skills));
    }
  }

  // Explicit Frely capabilities take precedence over OASF's separate taxonomy.
  // Without that extension, only exact OASF skill IDs are exposed; no vision/ocr aliases.
  const capabilities = capabilityClaims[0] ?? [...new Set(oasfSkills)];
  if (capabilityClaims.some((claim) => claim.length !== capabilities.length ||
      claim.some((capability) => !capabilities.includes(capability)))) return invalid();
  if (!paymentClaims.length || paymentClaims.some((payment) =>
      payment.protocol !== "x402" || payment.network !== "hedera:testnet")) return invalid();
  // This synchronous profile requires an explicit execution claim before the
  // resolver cross-checks ENS and fetches the Card; it never guesses a URL.
  if (protocol === "a2a" && !hasA2AInterface) throw new Error("A2A_EXECUTION_ENDPOINT_REQUIRED");
  if (protocol === "a2a" && isRegistration && !hasA2AService) return invalid();

  const manifest = {
    name: file.name,
    ...(file.description === undefined ? {} : { description: file.description }),
    capabilities,
    identity: { ens: agree(names), agentId },
    interfaces: [{
      protocol,
      endpoint: agree(endpoints),
      ...(protocol === "a2a" ? { agentCardUrl: agree(cardUrls) } : {}),
    }],
    payment: { ...paymentClaims[0] },
  };
  if (protocol === "responses") return validateLegacyManifest(manifest);
  return { ...validateManifest(manifest), x402Support: file.x402Support as boolean };
}

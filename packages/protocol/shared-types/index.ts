export type ProviderProtocol = "responses" | "mcp" | "http";

/** A provider returned by live discovery before identity resolution. */
export interface ProviderCandidate {
  id: string;
  ensName?: string;
  capabilities: string[];
  supportsX402: boolean;
  reputation?: number;
}

/** A provider whose identity and execution endpoint have been verified. */
export interface ResolvedProvider {
  id: string;
  ensName?: string;
  endpoint: string;
  protocol: ProviderProtocol;
  verified: boolean;
}

/** A capability request accepted by the Broker MCP layer. */
export interface CapabilityRequest {
  capabilities: string[];
  task: string;
  input?: unknown;
  model?: string;
  maxAmount?: string;
}

/** A normalized, bounded payment outcome. Raw payment payloads are never retained. */
export interface PaymentEvidence {
  network: string;
  transactionId?: string;
  payer?: string;
}

/** The result returned after provider execution and payment settlement. */
export interface CapabilityResult {
  provider: {
    id: string;
    ensName?: string;
    capabilities: string[];
    protocol: ProviderProtocol;
  };
  payment: PaymentEvidence;
  output: unknown;
  correlationId: string;
}

/** Public result for discovery; endpoint URLs remain Broker-internal. */
export interface CapabilityDescriptor {
  id: string;
  ensName?: string;
  capabilities: string[];
  protocol: ProviderProtocol;
  verified: true;
}

/** Stable error categories exposed at the MCP boundary. */
export type BrokerErrorCode =
  | "INVALID_REQUEST"
  | "CAPABILITY_NOT_SUPPORTED"
  | "NO_PROVIDER"
  | "NO_VERIFIED_PROVIDER"
  | "IDENTITY_VERIFICATION_FAILED"
  | "PROTOCOL_NOT_SUPPORTED"
  | "PAYMENT_REQUIRED"
  | "PAYMENT_LIMIT_EXCEEDED"
  | "PAYMENT_NETWORK_UNSUPPORTED"
  | "PAYMENT_FAILED"
  | "PROVIDER_REQUEST_FAILED"
  | "PROVIDER_RESPONSE_INVALID"
  | "BROKER_NOT_READY";

export class BrokerError extends Error {
  readonly code: BrokerErrorCode;

  constructor(code: BrokerErrorCode, message = code) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
  }
}

function parseIpv4(value: string): number[] | undefined {
  const parts = value.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d+$/u.test(part))) return undefined;
  const octets = parts.map(Number);
  return octets.every((part) => part >= 0 && part <= 255) ? octets : undefined;
}

function isPrivateIpv4(value: string): boolean {
  const octets = parseIpv4(value);
  if (!octets) return false;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function parseIpv6(value: string): number[] | undefined {
  const halves = value.split("::");
  if (halves.length > 2) return undefined;

  const parseGroups = (part: string): number[] | undefined => {
    if (!part) return [];
    const groups = part.split(":");
    const result: number[] = [];
    for (const [index, group] of groups.entries()) {
      if (group.includes(".")) {
        if (index !== groups.length - 1) return undefined;
        const octets = parseIpv4(group);
        if (!octets) return undefined;
        result.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/u.test(group)) return undefined;
        result.push(Number.parseInt(group, 16));
      }
    }
    return result;
  };

  const left = parseGroups(halves[0] ?? "");
  const right = halves.length === 2 ? parseGroups(halves[1] ?? "") : [];
  if (!left || !right) return undefined;
  if (halves.length === 1) return left.length === 8 ? left : undefined;
  const missing = 8 - left.length - right.length;
  return missing > 0 ? [...left, ...Array.from({ length: missing }, () => 0), ...right] : undefined;
}

function isPrivateIpv6(value: string): boolean {
  const groups = parseIpv6(value);
  if (!groups) return false;
  const allZero = groups.every((group) => group === 0);
  const loopback = groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
  if (allZero || loopback) return true;

  const first = groups[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true;

  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  const compatible = groups.slice(0, 6).every((group) => group === 0);
  if (!mapped && !compatible) return false;
  const octets = [
    (groups[6] ?? 0) >> 8,
    (groups[6] ?? 0) & 0xff,
    (groups[7] ?? 0) >> 8,
    (groups[7] ?? 0) & 0xff,
  ];
  return isPrivateIpv4(octets.join("."));
}

/** Reject private, loopback, link-local and credential-bearing HTTP URLs. */
export function isSafePublicHttpUrl(
  value: unknown,
  options: { requireHttps?: boolean } = {},
): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (options.requireHttps !== false && url.protocol !== "https:") return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal"
  ) return false;

  if (isPrivateIpv4(hostname) || (hostname.includes(":") && isPrivateIpv6(hostname))) return false;
  return true;
}

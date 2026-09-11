import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { readBoundedJson } from "@frely-network/hedera-x402";

type EnvRef = `env:${string}`;

export type FrelyMcpConfig = {
  schemaVersion: 1;
  network: {
    baseUrl: string;
    apiKeyRef: EnvRef;
    chainId: 11155111;
    registry: `0x${string}`;
  };
  relay: { apiKeyRef: EnvRef };
  walletDir: string;
  approvedProviderId: string;
  paymentConfigPath: string;
  paymentRegistryPath: string;
};

const envRefPattern = /^env:[A-Z_][A-Z0-9_]*$/;
const registryPattern = /^0x[0-9a-f]{40}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

function isPublicHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/" &&
      host !== "localhost" &&
      !host.endsWith(".local") &&
      isIP(host.replace(/^\[|\]$/g, "")) === 0
    );
  } catch {
    return false;
  }
}

function parseConfig(value: unknown): FrelyMcpConfig {
  if (!isRecord(value) || !hasOnlyFields(value, ["schemaVersion", "network", "relay", "walletDir", "approvedProviderId", "paymentConfigPath", "paymentRegistryPath"])) throw new Error();
  const { network, relay } = value;
  if (!isRecord(network) || !hasOnlyFields(network, ["baseUrl", "apiKeyRef", "chainId", "registry"])) throw new Error();
  if (!isRecord(relay) || !hasOnlyFields(relay, ["apiKeyRef"])) throw new Error();
  if (
    value.schemaVersion !== 1 ||
    !isPublicHttpsOrigin(network.baseUrl) ||
    typeof network.apiKeyRef !== "string" || !envRefPattern.test(network.apiKeyRef) ||
    network.chainId !== 11155111 ||
    typeof network.registry !== "string" || !registryPattern.test(network.registry) || /^0x0{40}$/i.test(network.registry) ||
    typeof relay.apiKeyRef !== "string" || !envRefPattern.test(relay.apiKeyRef) ||
    !isCanonicalAbsolutePath(value.walletDir) ||
    typeof value.approvedProviderId !== "string" || !value.approvedProviderId.trim() ||
    !isCanonicalAbsolutePath(value.paymentConfigPath) ||
    !isCanonicalAbsolutePath(value.paymentRegistryPath)
  ) throw new Error();
  return value as FrelyMcpConfig;
}

export async function loadFrelyMcpConfig(path: string): Promise<FrelyMcpConfig> {
  try {
    if (!isCanonicalAbsolutePath(path)) throw new Error();
    return parseConfig(await readBoundedJson(path));
  } catch {
    throw new Error("CONFIG_INVALID");
  }
}

export function resolveSecret(ref: EnvRef): string {
  if (!envRefPattern.test(ref)) throw new Error("CONFIG_INVALID");
  const value = process.env[ref.slice(4)];
  if (!value) throw new Error("CONFIG_INVALID");
  return value;
}

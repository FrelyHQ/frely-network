import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { readBoundedJson } from "@frely-network/hedera-x402";

type EnvRef = `env:${string}`;

export type FrelyMcpConfig = {
  schemaVersion: 2;
  network: {
    mode: "static-local";
    baseUrl: "http://127.0.0.1:13600";
    apiKeyRef: "env:FRELY_NETWORK_API_KEY";
  };
  approvedProvider: {
    id: "frely-vision-basic";
    endpoint: "https://api.frely.cloud/v1/responses";
  };
  approvedExecution: {
    endpoint: "http://127.0.0.1:13600/v1/responses";
  };
  walletDir: string;
  paymentConfigPath: string;
  paymentRegistryPath: string;
};

const envRefPattern = /^env:[A-Z_][A-Z0-9_]*$/;
const NETWORK_ORIGIN = "http://127.0.0.1:13600";
const EXECUTION_ENDPOINT = "http://127.0.0.1:13600/v1/responses";
const PROVIDER_ID = "frely-vision-basic";
const PROVIDER_ENDPOINT = "https://api.frely.cloud/v1/responses";
const NETWORK_KEY_REF = "env:FRELY_NETWORK_API_KEY";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).every((key) => fields.includes(key));
}

function isCanonicalAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && resolve(value) === value;
}

export function isPublicHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/, "");
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      host !== "localhost" &&
      !host.endsWith(".local") &&
      isIP(host.replace(/^\[|\]$/g, "")) === 0
    );
  } catch {
    return false;
  }
}

function parseConfig(value: unknown): FrelyMcpConfig {
  if (
    !isRecord(value)
    || !hasOnlyFields(value, [
      "schemaVersion",
      "network",
      "approvedProvider",
      "approvedExecution",
      "walletDir",
      "paymentConfigPath",
      "paymentRegistryPath",
    ])
  ) throw new Error();
  const { network, approvedProvider, approvedExecution } = value;
  if (!isRecord(network) || !hasOnlyFields(network, ["mode", "baseUrl", "apiKeyRef"])) throw new Error();
  if (!isRecord(approvedProvider) || !hasOnlyFields(approvedProvider, ["id", "endpoint"])) throw new Error();
  if (!isRecord(approvedExecution) || !hasOnlyFields(approvedExecution, ["endpoint"])) throw new Error();
  if (
    value.schemaVersion !== 2
    || network.mode !== "static-local"
    || network.baseUrl !== NETWORK_ORIGIN
    || network.apiKeyRef !== NETWORK_KEY_REF
    || approvedProvider.id !== PROVIDER_ID
    || approvedProvider.endpoint !== PROVIDER_ENDPOINT
    || approvedExecution.endpoint !== EXECUTION_ENDPOINT
    || !isCanonicalAbsolutePath(value.walletDir)
    || !isCanonicalAbsolutePath(value.paymentConfigPath)
    || !isCanonicalAbsolutePath(value.paymentRegistryPath)
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

import { isIP } from "node:net";
import { accessSync, constants, existsSync, lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type EnvReference = `env:${string}`;

export type StaticNetworkConfig = {
  listen: { hostname: "127.0.0.1"; port: number };
  provider: { id: string; relayUrl: string };
  auth: { apiKeyRef: EnvReference; relayKeyRef: EnvReference };
  payment: {
    network: "hedera:testnet";
    resourceUrl: string;
    asset: string;
    amountAtomic: string;
    payTo: string;
    feePayer: string;
    facilitatorUrl: string;
    attemptStorePath: string;
  };
};

type Environment = Readonly<Record<string, string | undefined>>;

const ENV_REFERENCE = /^env:[A-Z_][A-Z0-9_]*$/u;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;
const HEDERA_ID = /^\d+\.\d+\.\d+$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function publicHttpsUrl(value: unknown, expectedPath?: string): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/u, "");
    const ipHost = host.replace(/^\[|\]$/gu, "");
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!expectedPath || url.pathname === expectedPath) &&
      host !== "localhost" &&
      !host.endsWith(".local") &&
      isIP(ipHost) === 0
    );
  } catch {
    return false;
  }
}

function canonicalAbsolutePath(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value) {
    return false;
  }
  let candidate = value;
  while (!existsSync(candidate)) {
    const parent = resolve(candidate, "..");
    if (parent === candidate) return false;
    candidate = parent;
  }
  try {
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    accessSync(candidate, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function parseStaticNetworkConfig(value: unknown): StaticNetworkConfig {
  try {
    const root = record(value);
    if (!root || !exactKeys(root, ["listen", "provider", "auth", "payment"])) throw new Error();
    const listen = record(root.listen);
    const provider = record(root.provider);
    const auth = record(root.auth);
    const payment = record(root.payment);
    if (
      !listen || !exactKeys(listen, ["hostname", "port"]) ||
      !provider || !exactKeys(provider, ["id", "relayUrl"]) ||
      !auth || !exactKeys(auth, ["apiKeyRef", "relayKeyRef"]) ||
      !payment || !exactKeys(payment, [
        "network",
        "resourceUrl",
        "asset",
        "amountAtomic",
        "payTo",
        "feePayer",
        "facilitatorUrl",
        "attemptStorePath",
      ])
    ) throw new Error();

    if (
      listen.hostname !== "127.0.0.1" ||
      typeof listen.port !== "number" ||
      !Number.isSafeInteger(listen.port) ||
      listen.port < 1 ||
      listen.port > 65_535 ||
      typeof provider.id !== "string" ||
      !SAFE_VALUE.test(provider.id) ||
      !publicHttpsUrl(provider.relayUrl, "/v1/responses") ||
      typeof auth.apiKeyRef !== "string" ||
      !ENV_REFERENCE.test(auth.apiKeyRef) ||
      typeof auth.relayKeyRef !== "string" ||
      !ENV_REFERENCE.test(auth.relayKeyRef) ||
      payment.network !== "hedera:testnet" ||
      typeof payment.resourceUrl !== "string" ||
      payment.resourceUrl !== `http://127.0.0.1:${listen.port}/v1/responses` ||
      typeof payment.asset !== "string" ||
      !SAFE_VALUE.test(payment.asset) ||
      typeof payment.amountAtomic !== "string" ||
      !/^[1-9][0-9]*$/u.test(payment.amountAtomic) ||
      typeof payment.payTo !== "string" ||
      !HEDERA_ID.test(payment.payTo) ||
      typeof payment.feePayer !== "string" ||
      !HEDERA_ID.test(payment.feePayer) ||
      !publicHttpsUrl(payment.facilitatorUrl) ||
      !canonicalAbsolutePath(payment.attemptStorePath)
    ) throw new Error();

    return value as StaticNetworkConfig;
  } catch {
    throw new Error("STATIC_NETWORK_CONFIG_INVALID");
  }
}

export function loadStaticNetworkConfig(environment: Environment = process.env): StaticNetworkConfig {
  const source = environment.FRELY_STATIC_NETWORK_CONFIG;
  if (!source || new TextEncoder().encode(source).byteLength > 64 * 1024) {
    throw new Error("STATIC_NETWORK_CONFIG_INVALID");
  }
  try {
    return parseStaticNetworkConfig(JSON.parse(source));
  } catch {
    throw new Error("STATIC_NETWORK_CONFIG_INVALID");
  }
}

export function resolveEnvReference(reference: EnvReference, environment: Environment = process.env): string {
  if (!ENV_REFERENCE.test(reference)) throw new Error("STATIC_NETWORK_SECRET_UNAVAILABLE");
  const value = environment[reference.slice(4)]?.trim();
  if (!value || /[\r\n\0]/u.test(value)) throw new Error("STATIC_NETWORK_SECRET_UNAVAILABLE");
  return value;
}

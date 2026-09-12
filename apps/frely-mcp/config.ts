import { isIP } from "node:net";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";

export type EnvReference = `env:${string}`;
export type Environment = Readonly<Record<string, string | undefined>>;

export type FrelyMcpPaymentConfig = {
  livePaymentEnabled: boolean;
  network: "hedera:testnet";
  asset: string;
  amountAtomic: string;
  payTo: string;
  feePayer: string;
  facilitatorUrl: string;
  payerAccountId: string;
  maxTimeoutSeconds: number;
  walletDirectory: string;
  journalPath: string;
};

export type FrelyMcpConfig = {
  schemaVersion: 2;
  network: { baseUrl: string; apiKeyRef: EnvReference };
  approvedProvider: { id: string; relayUrl: string };
  approvedExecution: { resourceUrl: string };
  payment?: FrelyMcpPaymentConfig;
};

const ENV_REFERENCE = /^env:[A-Z_][A-Z0-9_]*$/u;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;
const HEDERA_ID = /^\d+\.\d+\.\d+$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], required = allowed): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}

function loopbackOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.pathname === "/" &&
      !value.endsWith("/") &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      Number.isSafeInteger(port) &&
      port >= 1 &&
      port <= 65_535
    );
  } catch {
    return false;
  }
}

function publicHttps(value: unknown, expectedPath?: string): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/u, "");
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!expectedPath || url.pathname === expectedPath) &&
      host !== "localhost" &&
      !host.endsWith(".local") &&
      isIP(host.replace(/^\[|\]$/gu, "")) === 0
    );
  } catch {
    return false;
  }
}

function absolutePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value) && normalize(value) === value && !/[\0\r\n]/u.test(value);
}

export function parseFrelyMcpConfig(value: unknown): FrelyMcpConfig {
  try {
    const root = record(value);
    if (!root || !onlyKeys(root, ["schemaVersion", "network", "approvedProvider", "approvedExecution", "payment"], ["schemaVersion", "network", "approvedProvider", "approvedExecution"])) throw new Error();
    const network = record(root.network);
    const provider = record(root.approvedProvider);
    const execution = record(root.approvedExecution);
    if (
      root.schemaVersion !== 2 ||
      !network || !onlyKeys(network, ["baseUrl", "apiKeyRef"]) ||
      !provider || !onlyKeys(provider, ["id", "relayUrl"]) ||
      !execution || !onlyKeys(execution, ["resourceUrl"]) ||
      !loopbackOrigin(network.baseUrl) ||
      typeof network.apiKeyRef !== "string" || !ENV_REFERENCE.test(network.apiKeyRef) ||
      typeof provider.id !== "string" || !SAFE_VALUE.test(provider.id) ||
      !publicHttps(provider.relayUrl, "/v1/responses") ||
      execution.resourceUrl !== `${network.baseUrl}/v1/responses`
    ) throw new Error();

    let payment: FrelyMcpPaymentConfig | undefined;
    if (root.payment !== undefined) {
      const candidate = record(root.payment);
      const keys = [
        "livePaymentEnabled",
        "network",
        "asset",
        "amountAtomic",
        "payTo",
        "feePayer",
        "facilitatorUrl",
        "payerAccountId",
        "maxTimeoutSeconds",
        "walletDirectory",
        "journalPath",
      ] as const;
      if (!candidate || !onlyKeys(candidate, keys, keys.filter((key) => key !== "livePaymentEnabled"))) throw new Error();
      const enabled = candidate.livePaymentEnabled ?? false;
      if (
        typeof enabled !== "boolean" ||
        candidate.network !== "hedera:testnet" ||
        typeof candidate.asset !== "string" || !SAFE_VALUE.test(candidate.asset) ||
        typeof candidate.amountAtomic !== "string" || !/^[1-9][0-9]*$/u.test(candidate.amountAtomic) ||
        typeof candidate.payTo !== "string" || !HEDERA_ID.test(candidate.payTo) ||
        typeof candidate.feePayer !== "string" || !HEDERA_ID.test(candidate.feePayer) ||
        !publicHttps(candidate.facilitatorUrl) ||
        typeof candidate.payerAccountId !== "string" || !HEDERA_ID.test(candidate.payerAccountId) ||
        typeof candidate.maxTimeoutSeconds !== "number" || !Number.isSafeInteger(candidate.maxTimeoutSeconds) || candidate.maxTimeoutSeconds < 1 || candidate.maxTimeoutSeconds > 86_400 ||
        !absolutePath(candidate.walletDirectory) ||
        !absolutePath(candidate.journalPath)
      ) throw new Error();
      payment = { ...(candidate as Omit<FrelyMcpPaymentConfig, "livePaymentEnabled">), livePaymentEnabled: enabled };
    }
    return {
      schemaVersion: 2,
      network: { baseUrl: network.baseUrl as string, apiKeyRef: network.apiKeyRef as EnvReference },
      approvedProvider: { id: provider.id as string, relayUrl: provider.relayUrl as string },
      approvedExecution: { resourceUrl: execution.resourceUrl as string },
      payment,
    };
  } catch {
    throw new Error("CONFIG_INVALID");
  }
}

export async function loadFrelyMcpConfig(path: string): Promise<FrelyMcpConfig> {
  try {
    if (!absolutePath(path) || resolve(path) !== path) throw new Error();
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 64 * 1024) throw new Error();
    return parseFrelyMcpConfig(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new Error("CONFIG_INVALID");
  }
}

export function resolveEnvReference(reference: EnvReference, environment: Environment = process.env): string {
  if (!ENV_REFERENCE.test(reference)) throw new Error("CONFIG_INVALID");
  const value = environment[reference.slice(4)]?.trim();
  if (!value || /[\0\r\n]/u.test(value)) throw new Error("CONFIG_INVALID");
  return value;
}

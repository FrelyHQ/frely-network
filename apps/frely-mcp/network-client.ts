import {
  parseStaticResolveRequest,
  parseStaticResolveResult,
  type StaticResolveResult,
} from "@frely-network/capability-resolution";
import { resolveEnvReference, type Environment, type FrelyMcpConfig } from "./config.ts";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const KNOWN_CODES = new Set([
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "CAPABILITY_NOT_SUPPORTED",
  "STATIC_PROVIDER_NOT_CONFIGURED",
  "REQUEST_ID_CONFLICT",
  "PAYMENT_REQUIRED",
  "PAYMENT_REJECTED",
  "PAYMENT_LIMIT_EXCEEDED",
  "UPSTREAM_FAILED",
]);

export type NetworkFetcher = (request: Request) => Promise<Response>;

export class FrelyNetworkClient {
  private readonly fetcher: NetworkFetcher;
  private readonly environment: Environment;

  constructor(
    private readonly config: Pick<FrelyMcpConfig, "network" | "approvedProvider" | "approvedExecution">,
    options: { fetcher?: NetworkFetcher; environment?: Environment } = {},
  ) {
    this.fetcher = options.fetcher ?? ((request) => fetch(request));
    this.environment = options.environment ?? process.env;
  }

  async resolve(capabilities: string[]): Promise<StaticResolveResult> {
    if (capabilities.length !== 1 || capabilities[0] !== "vision") throw new Error("CAPABILITY_NOT_SUPPORTED");
    const payload = parseStaticResolveRequest({ schemaVersion: 2, capabilities, paymentNetwork: "hedera:testnet" });
    let response: Response;
    try {
      response = await this.fetcher(new Request(`${this.config.network.baseUrl}/v1/capabilities/resolve`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${resolveEnvReference(this.config.network.apiKeyRef, this.environment)}`,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "CONFIG_INVALID") throw error;
      throw new Error("NETWORK_UNAVAILABLE");
    }
    const body = await boundedJson(response).catch(() => { throw new Error("NETWORK_UNAVAILABLE"); });
    if (response.status !== 200) {
      const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : "";
      if (KNOWN_CODES.has(code)) throw new Error(code);
      throw new Error("NETWORK_UNAVAILABLE");
    }
    let result: StaticResolveResult;
    try {
      result = parseStaticResolveResult(body);
    } catch {
      throw new Error("NETWORK_UNAVAILABLE");
    }
    assertAuthorized(result, this.config);
    return result;
  }

  async execute(request: Request): Promise<Response> {
    if (request.url !== this.config.approvedExecution.resourceUrl || request.method !== "POST") {
      throw new Error("PROVIDER_NOT_AUTHORIZED");
    }
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${resolveEnvReference(this.config.network.apiKeyRef, this.environment)}`);
    return this.fetcher(new Request(request, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }));
  }
}

export function assertAuthorized(
  result: StaticResolveResult,
  config: Pick<FrelyMcpConfig, "approvedProvider" | "approvedExecution">,
): void {
  if (
    result.provider.id !== config.approvedProvider.id ||
    result.provider.endpoint !== config.approvedProvider.relayUrl ||
    result.provider.protocol !== "responses" ||
    result.execution.endpoint !== config.approvedExecution.resourceUrl ||
    result.execution.managedBy !== "network" ||
    result.resolution.source !== "static_allowlist" ||
    result.resolution.identityVerified !== false ||
    result.payment.network !== "hedera:testnet" ||
    result.payment.resource !== config.approvedExecution.resourceUrl ||
    result.requestedCapabilities.length !== 1 ||
    result.requestedCapabilities[0] !== "vision"
  ) throw new Error("PROVIDER_NOT_AUTHORIZED");
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RESPONSE_BYTES) throw new Error();
  }
  if (!response.body) throw new Error();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

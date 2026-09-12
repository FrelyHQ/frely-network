import {
  parseStaticResolveCapabilitiesRequest,
  parseStaticResolvedCapability,
  type StaticResolvedCapability,
} from "@frely-network/capability-resolution";
import { resolveSecret, type FrelyMcpConfig } from "./config.ts";

const MAX_RESPONSE_BYTES = 1024 * 1024;
export type NetworkFetcher = (request: Request) => Promise<Response>;
const knownServerCodes = new Set([
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "NO_PROVIDER",
  "NETWORK_DISCOVERY_FAILED",
  "IDENTITY_VERIFICATION_FAILED",
  "CAPABILITY_NOT_SUPPORTED",
  "STATIC_PROVIDER_NOT_CONFIGURED",
]);

async function readBoundedJson(response: Response): Promise<unknown> {
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
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function assertStaticAuthorization(
  resolved: StaticResolvedCapability,
  config: Pick<FrelyMcpConfig, "approvedProvider" | "approvedExecution">,
): void {
  if (
    resolved.provider.id !== config.approvedProvider.id
    || resolved.provider.endpoint !== config.approvedProvider.endpoint
    || resolved.execution.endpoint !== config.approvedExecution.endpoint
    || resolved.payment.resource !== config.approvedExecution.endpoint
    || resolved.provider.protocol !== "responses"
    || resolved.execution.managedBy !== "network"
    || resolved.resolution.source !== "static_allowlist"
    || resolved.resolution.identityVerified !== false
    || resolved.payment.network !== "hedera:testnet"
    || resolved.requestedCapabilities.length !== 1
    || resolved.requestedCapabilities[0] !== "vision"
  ) throw new Error("PROVIDER_NOT_AUTHORIZED");
}

export class FrelyNetworkClient {
  constructor(
    private readonly config: Pick<FrelyMcpConfig, "network" | "approvedProvider" | "approvedExecution">,
    private readonly fetcher: NetworkFetcher = fetch,
  ) {}

  async resolve(capabilities: string[]): Promise<StaticResolvedCapability> {
    if (capabilities.length !== 1 || capabilities[0] !== "vision") {
      throw new Error("CAPABILITY_NOT_SUPPORTED");
    }
    const payload = parseStaticResolveCapabilitiesRequest({
      schemaVersion: 2,
      capabilities,
      paymentNetwork: "hedera:testnet",
    });
    let response: Response;
    try {
      response = await this.fetcher(new Request(new URL("/v1/capabilities/resolve", this.config.network.baseUrl), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${resolveSecret(this.config.network.apiKeyRef)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }));
    } catch (error) {
      if (error instanceof Error && (error.message === "CONFIG_INVALID" || error.message === "CAPABILITY_NOT_SUPPORTED")) {
        throw error;
      }
      throw new Error("NETWORK_UNAVAILABLE");
    }

    let body: unknown;
    try {
      body = await readBoundedJson(response);
    } catch {
      throw new Error("NETWORK_UNAVAILABLE");
    }
    if (response.status !== 200) {
      const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" ? body.code : undefined;
      if (code && knownServerCodes.has(code)) throw new Error(code);
      throw new Error("NETWORK_UNAVAILABLE");
    }

    let result: StaticResolvedCapability;
    try {
      result = parseStaticResolvedCapability(body);
    } catch {
      throw new Error("NETWORK_UNAVAILABLE");
    }
    assertStaticAuthorization(result, this.config);
    return result;
  }
}

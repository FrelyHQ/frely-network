import {
  parseResolveCapabilitiesRequest,
  parseResolvedCapability,
  type ResolvedCapability,
} from "@frely-network/capability-resolution";
import { resolveSecret, type FrelyMcpConfig } from "./config.ts";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const knownServerCodes = new Set([
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "NO_PROVIDER",
  "NETWORK_DISCOVERY_FAILED",
  "IDENTITY_VERIFICATION_FAILED",
  "CAPABILITY_NOT_SUPPORTED",
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

function sameCapabilities(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

export class FrelyNetworkClient {
  constructor(
    private readonly config: FrelyMcpConfig["network"],
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async resolve(capabilities: string[]): Promise<ResolvedCapability> {
    const payload = parseResolveCapabilitiesRequest({
      schemaVersion: 1,
      capabilities,
      paymentNetwork: "hedera:testnet",
    });
    let response: Response;
    try {
      response = await this.fetcher(new Request(new URL("/v1/capabilities/resolve", this.config.baseUrl), {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
        headers: {
          authorization: `Bearer ${resolveSecret(this.config.apiKeyRef)}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(payload),
      }));
    } catch (error) {
      if (error instanceof Error && error.message === "CONFIG_INVALID") throw error;
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

    let result: ResolvedCapability;
    try {
      result = parseResolvedCapability(body);
    } catch {
      throw new Error("NETWORK_UNAVAILABLE");
    }
    if (!sameCapabilities(result.requestedCapabilities, capabilities)) throw new Error("CAPABILITY_NOT_SUPPORTED");
    if (
      result.identity.chainId !== this.config.chainId ||
      result.identity.registry.toLowerCase() !== this.config.registry.toLowerCase()
    ) throw new Error("IDENTITY_VERIFICATION_FAILED");
    if (result.payment.network !== "hedera:testnet") throw new Error("CAPABILITY_NOT_SUPPORTED");
    return result;
  }
}

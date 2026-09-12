import { createHederaX402GatewayPorts, HEDERA_TESTNET_NETWORK, type PaymentRequired } from "@frely-network/hedera-x402";
import { FileX402ReplayStore, X402Gateway } from "@frely-network/x402-gateway";
import { isSafePublicHttpUrl } from "@frely-network/shared-types";

const DEFAULT_RESOURCE_URL = "https://network.frely.cloud/x402/frely/responses";
const DEFAULT_UPSTREAM_URL = "https://api.frely.cloud/v1/responses";
const DEFAULT_MAX_REQUEST_BYTES = 512 * 1024;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;

type Environment = Readonly<Record<string, string | undefined>>;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface FrelyX402ResponsesOptions {
  readonly resourceUrl: string;
  readonly upstreamUrl: string;
  readonly apiKey: string;
  readonly requirements: PaymentRequired;
  readonly gateway: X402Gateway;
  readonly fetcher?: Fetcher;
  readonly maxRequestBytes?: number;
}

export type FrelyX402ResponsesHandler = (request: Request) => Promise<Response>;

export function createFrelyX402ResponsesHandler(options: FrelyX402ResponsesOptions): FrelyX402ResponsesHandler {
  const resourceUrl = publicUrl(options.resourceUrl, "/x402/frely/responses");
  const upstreamUrl = publicUrl(options.upstreamUrl, "/v1/responses");
  const apiKey = options.apiKey.trim();
  if (!apiKey || /[\r\n\u0000]/u.test(apiKey)) throw new Error("FRELY_API_KEY_INVALID");
  if (options.requirements.x402Version !== 2 || options.requirements.resource?.url !== resourceUrl) throw new Error("X402_REQUIREMENTS_INVALID");

  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 4 * 1024 * 1024) throw new Error("X402_REQUEST_LIMIT_INVALID");
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));

  return async (request) => {
    if (request.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return json({ code: "INVALID_REQUEST" }, 415);

    const paymentRequest = new Request(resourceUrl, { method: "POST", headers: request.headers });
    return options.gateway.handle(paymentRequest, options.requirements, async () => {
      let body: string;
      try {
        body = await boundedBody(request, maxRequestBytes);
      } catch {
        return json({ code: "INVALID_REQUEST" }, 413);
      }

      let upstream: Response;
      try {
        upstream = await fetcher(upstreamUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          body,
        });
      } catch {
        return json({ code: "FRELY_UPSTREAM_UNAVAILABLE" }, 502);
      }
      return projectUpstreamResponse(upstream);
    });
  };
}

export function createFrelyX402ResponsesHandlerFromEnv(
  environment: Environment = process.env,
): FrelyX402ResponsesHandler | undefined {
  const apiKey = value(environment, "FRELY_API_KEY");
  const accountId = value(environment, "X402_FACILITATOR_ACCOUNT_ID");
  const privateKey = value(environment, "X402_FACILITATOR_PRIVATE_KEY");
  const amount = value(environment, "FRELY_NETWORK_X402_AMOUNT");
  const asset = value(environment, "FRELY_NETWORK_X402_ASSET");
  const payTo = value(environment, "FRELY_NETWORK_X402_PAY_TO");
  const replayDirectory = value(environment, "FRELY_NETWORK_X402_REPLAY_DIR");
  if (!apiKey || !accountId || !privateKey || !amount || !asset || !payTo || !replayDirectory) return undefined;
  if (!/^[1-9][0-9]*$/u.test(amount) || !SAFE_VALUE.test(asset) || !SAFE_VALUE.test(payTo)) throw new Error("X402_REQUIREMENTS_INVALID");

  const timeoutSeconds = number(environment.FRELY_NETWORK_X402_TIMEOUT_SECONDS ?? "60", 1, 86_400, "X402_TIMEOUT_INVALID");
  const resourceUrl = publicUrl(environment.FRELY_NETWORK_X402_RESOURCE_URL ?? DEFAULT_RESOURCE_URL, "/x402/frely/responses");
  const upstreamUrl = publicUrl(environment.FRELY_RESPONSES_URL ?? DEFAULT_UPSTREAM_URL, "/v1/responses");
  const requirements: PaymentRequired = {
    x402Version: 2,
    resource: { url: resourceUrl },
    accepts: [{
      scheme: "exact",
      network: HEDERA_TESTNET_NETWORK,
      amount,
      asset,
      payTo,
      maxTimeoutSeconds: timeoutSeconds,
      extra: {},
    }],
  };
  const ports = createHederaX402GatewayPorts(accountId, privateKey);
  const gateway = new X402Gateway({
    network: HEDERA_TESTNET_NETWORK,
    verifier: ports.verifier,
    settler: ports.settler,
    maxAmount: amount,
    replayStore: new FileX402ReplayStore(replayDirectory),
  });
  return createFrelyX402ResponsesHandler({ resourceUrl, upstreamUrl, apiKey, requirements, gateway });
}

function value(environment: Environment, name: string): string | undefined {
  const result = environment[name]?.trim();
  return result || undefined;
}

function number(value: string, minimum: number, maximum: number, code: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code);
  return parsed;
}

function publicUrl(value: string, expectedPath: string): string {
  if (!isSafePublicHttpUrl(value, { requireHttps: true })) throw new Error("X402_URL_INVALID");
  const url = new URL(value);
  if (url.pathname !== expectedPath || url.search || url.hash || url.username || url.password) throw new Error("X402_URL_INVALID");
  return url.toString();
}

async function boundedBody(request: Request, maximum: number): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum) throw new Error("REQUEST_TOO_LARGE");
  }
  const text = await request.text();
  const byteLength = new TextEncoder().encode(text).byteLength;
  if (byteLength === 0 || byteLength > maximum) throw new Error("REQUEST_TOO_LARGE");
  return text;
}

function projectUpstreamResponse(upstream: Response): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  const contentType = upstream.headers.get("content-type");
  const requestId = upstream.headers.get("x-request-id");
  if (contentType) headers.set("content-type", contentType);
  if (requestId && !/[\r\n\u0000]/u.test(requestId)) headers.set("x-request-id", requestId);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

import { createHederaX402GatewayPorts, HEDERA_TESTNET_NETWORK, type PaymentRequired } from "@frely-network/hedera-x402";
import { FileX402ReplayStore, X402Gateway } from "@frely-network/x402-gateway";
import { isSafePublicHttpUrl } from "@frely-network/shared-types";

const DEFAULT_RESPONSES_RESOURCE_URL = "https://network.frely.cloud/x402/frely/responses";
const DEFAULT_RESPONSES_UPSTREAM_URL = "https://api.frely.cloud/v1/responses";
const DEFAULT_A2A_RESOURCE_URL = "https://network.frely.cloud/x402/frely/a2a";
const DEFAULT_A2A_UPSTREAM_URL = "https://api.frely.cloud/a2a";
const DEFAULT_MAX_REQUEST_BYTES = 512 * 1024;
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;
const SAFE_HEADER_VALUE = /^[^\r\n\u0000]{1,512}$/u;

type Environment = Readonly<Record<string, string | undefined>>;
type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

export interface FrelyX402ResourceOptions {
  readonly resourceUrl: string;
  readonly upstreamUrl: string;
  readonly apiKey: string;
  readonly requirements: PaymentRequired;
  readonly gateway: X402Gateway;
  readonly fetcher?: Fetcher;
  readonly maxRequestBytes?: number;
}

export type FrelyX402ResourceHandler = (request: Request) => Promise<Response>;
export type FrelyX402ResponsesOptions = FrelyX402ResourceOptions;
export type FrelyX402ResponsesHandler = FrelyX402ResourceHandler;
export type FrelyX402A2AOptions = FrelyX402ResourceOptions;
export type FrelyX402A2AHandler = FrelyX402ResourceHandler;

export function createFrelyX402ResponsesHandler(options: FrelyX402ResponsesOptions): FrelyX402ResponsesHandler {
  return createFrelyX402ResourceHandler(options, {
    resourcePath: "/x402/frely/responses",
    upstreamPath: "/v1/responses",
    acceptedContentTypes: new Set(["application/json"]),
    forwardedHeaders: [],
  });
}

export function createFrelyX402A2AHandler(options: FrelyX402A2AOptions): FrelyX402A2AHandler {
  return createFrelyX402ResourceHandler(options, {
    resourcePath: "/x402/frely/a2a",
    upstreamPath: "/a2a",
    acceptedContentTypes: new Set(["application/json", "application/a2a+json"]),
    forwardedHeaders: ["idempotency-key", "x-a2a-agent-id"],
  });
}

function createFrelyX402ResourceHandler(
  options: FrelyX402ResourceOptions,
  profile: {
    readonly resourcePath: string;
    readonly upstreamPath: string;
    readonly acceptedContentTypes: ReadonlySet<string>;
    readonly forwardedHeaders: readonly string[];
  },
): FrelyX402ResourceHandler {
  const resourceUrl = publicUrl(options.resourceUrl, profile.resourcePath);
  const upstreamUrl = publicUrl(options.upstreamUrl, profile.upstreamPath);
  const apiKey = options.apiKey.trim();
  if (!apiKey || /[\r\n\u0000]/u.test(apiKey)) throw new Error("FRELY_API_KEY_INVALID");
  if (options.requirements.x402Version !== 2 || options.requirements.resource?.url !== resourceUrl) throw new Error("X402_REQUIREMENTS_INVALID");

  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 4 * 1024 * 1024) throw new Error("X402_REQUEST_LIMIT_INVALID");
  const fetcher: Fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));

  return async (request) => {
    if (request.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (!contentType || !profile.acceptedContentTypes.has(contentType)) return json({ code: "INVALID_REQUEST" }, 415);

    const paymentRequest = new Request(resourceUrl, { method: "POST", headers: request.headers });
    return options.gateway.handle(paymentRequest, options.requirements, async () => {
      let body: string;
      try {
        body = await boundedBody(request, maxRequestBytes);
      } catch {
        return json({ code: "INVALID_REQUEST" }, 413);
      }

      const upstreamHeaders = new Headers({
        authorization: `Bearer ${apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      });
      for (const name of profile.forwardedHeaders) copySafeHeader(request.headers, upstreamHeaders, name);

      let upstream: Response;
      try {
        upstream = await fetcher(upstreamUrl, {
          method: "POST",
          headers: upstreamHeaders,
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
  const common = commonEnvironment(environment);
  if (!common) return undefined;
  const resourceUrl = publicUrl(environment.FRELY_NETWORK_X402_RESOURCE_URL ?? DEFAULT_RESPONSES_RESOURCE_URL, "/x402/frely/responses");
  const upstreamUrl = publicUrl(environment.FRELY_RESPONSES_URL ?? DEFAULT_RESPONSES_UPSTREAM_URL, "/v1/responses");
  return createFrelyX402ResponsesHandler(resourceOptions(common, resourceUrl, upstreamUrl));
}

export function createFrelyX402A2AHandlerFromEnv(
  environment: Environment = process.env,
): FrelyX402A2AHandler | undefined {
  const common = commonEnvironment(environment);
  if (!common) return undefined;
  const resourceUrl = publicUrl(environment.FRELY_NETWORK_X402_A2A_RESOURCE_URL ?? DEFAULT_A2A_RESOURCE_URL, "/x402/frely/a2a");
  const upstreamUrl = publicUrl(environment.FRELY_A2A_URL ?? DEFAULT_A2A_UPSTREAM_URL, "/a2a");
  return createFrelyX402A2AHandler(resourceOptions(common, resourceUrl, upstreamUrl));
}

function commonEnvironment(environment: Environment): {
  readonly apiKey: string;
  readonly accountId: string;
  readonly privateKey: string;
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly replayDirectory: string;
  readonly timeoutSeconds: number;
} | undefined {
  const apiKey = value(environment, "FRELY_API_KEY");
  const accountId = value(environment, "X402_FACILITATOR_ACCOUNT_ID");
  const privateKey = value(environment, "X402_FACILITATOR_PRIVATE_KEY");
  const amount = value(environment, "FRELY_NETWORK_X402_AMOUNT");
  const asset = value(environment, "FRELY_NETWORK_X402_ASSET");
  const payTo = value(environment, "FRELY_NETWORK_X402_PAY_TO");
  const replayDirectory = value(environment, "FRELY_NETWORK_X402_REPLAY_DIR");
  if (!apiKey || !accountId || !privateKey || !amount || !asset || !payTo || !replayDirectory) return undefined;
  if (!/^[1-9][0-9]*$/u.test(amount) || !SAFE_VALUE.test(asset) || !SAFE_VALUE.test(payTo)) throw new Error("X402_REQUIREMENTS_INVALID");
  return {
    apiKey,
    accountId,
    privateKey,
    amount,
    asset,
    payTo,
    replayDirectory,
    timeoutSeconds: number(environment.FRELY_NETWORK_X402_TIMEOUT_SECONDS ?? "60", 1, 86_400, "X402_TIMEOUT_INVALID"),
  };
}

function resourceOptions(
  common: NonNullable<ReturnType<typeof commonEnvironment>>,
  resourceUrl: string,
  upstreamUrl: string,
): FrelyX402ResourceOptions {
  const requirements: PaymentRequired = {
    x402Version: 2,
    resource: { url: resourceUrl },
    accepts: [{
      scheme: "exact",
      network: HEDERA_TESTNET_NETWORK,
      amount: common.amount,
      asset: common.asset,
      payTo: common.payTo,
      maxTimeoutSeconds: common.timeoutSeconds,
      extra: {},
    }],
  };
  const ports = createHederaX402GatewayPorts(common.accountId, common.privateKey);
  const gateway = new X402Gateway({
    network: HEDERA_TESTNET_NETWORK,
    verifier: ports.verifier,
    settler: ports.settler,
    maxAmount: common.amount,
    replayStore: new FileX402ReplayStore(common.replayDirectory),
  });
  return { resourceUrl, upstreamUrl, apiKey: common.apiKey, requirements, gateway };
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

function copySafeHeader(source: Headers, target: Headers, name: string): void {
  const value = source.get(name);
  if (value !== null && SAFE_HEADER_VALUE.test(value)) target.set(name, value);
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

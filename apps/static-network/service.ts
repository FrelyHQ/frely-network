import { timingSafeEqual } from "node:crypto";
import {
  parseStaticResolveRequest,
  type StaticResolveRequest,
  type StaticResolveResult,
} from "@frely-network/capability-resolution";
import type { PaymentRequired } from "@frely-network/hedera-x402";
import type { UpfrontAdmission } from "@frely-network/x402-gateway";
import type { RelayUpstream } from "./upstream.ts";

const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/u;
const ROUTES = new Set(["/healthz", "/readyz", "/v1/capabilities/resolve", "/v1/responses"]);

export type StaticNetworkFetchOptions = {
  apiKey: string;
  expectedModel: string;
  ready: boolean;
  requirements: PaymentRequired;
  resolver: { resolve(input: StaticResolveRequest): Promise<StaticResolveResult> };
  gateway: { admit(request: Request, body: Uint8Array, requirements: PaymentRequired): Promise<UpfrontAdmission> };
  upstream: RelayUpstream;
};

export function createStaticNetworkFetch(options: StaticNetworkFetchOptions): (request: Request) => Promise<Response> {
  if (!options.apiKey || /[\r\n\0]/u.test(options.apiKey)) throw new Error("STATIC_NETWORK_SECRET_UNAVAILABLE");
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (!ROUTES.has(path)) return json({ code: "NOT_FOUND" }, 404);

    if (path === "/healthz" || path === "/readyz") {
      if (request.method !== "GET") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
      if (path === "/readyz" && !options.ready) return json({ status: "not_ready" }, 503);
      return json({ status: path === "/healthz" ? "alive" : "ready" }, 200);
    }

    if (request.method !== "POST") return json({ code: "METHOD_NOT_ALLOWED" }, 405);
    if (!authorized(request.headers.get("authorization"), options.apiKey)) {
      return json({ code: "UNAUTHORIZED" }, 401, { "www-authenticate": "Bearer" });
    }
    const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") return json({ code: "INVALID_REQUEST" }, 415);

    let body: Uint8Array;
    try {
      body = await boundedBody(request, MAX_REQUEST_BYTES);
    } catch {
      return json({ code: "INVALID_REQUEST" }, 413);
    }

    if (path === "/v1/capabilities/resolve") {
      try {
        const parsed = parseStaticResolveRequest(parseJson(body));
        return json(await options.resolver.resolve(parsed), 200);
      } catch (error) {
        return mappedError(error);
      }
    }

    const requestId = request.headers.get("x-frely-request-id") ?? "";
    if (!REQUEST_ID.test(requestId)) return json({ code: "INVALID_REQUEST" }, 400);
    try {
      const parsed = parseJson(body);
      if (!validResponsesBody(parsed, options.expectedModel)) return json({ code: "INVALID_REQUEST" }, 400);
      const admission = await options.gateway.admit(request, body, options.requirements);
      if (admission.kind === "response") return admission.response;
      let upstreamResponse: Response;
      try {
        upstreamResponse = await options.upstream.invoke(new TextDecoder().decode(body), requestId);
      } catch {
        upstreamResponse = json({ code: "UPSTREAM_FAILED" }, 502);
      }
      return await admission.finish(upstreamResponse);
    } catch (error) {
      return mappedError(error);
    }
  };
}

function authorized(header: string | null, apiKey: string): boolean {
  const expected = Buffer.from(`Bearer ${apiKey}`);
  const actual = Buffer.from(header ?? "");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function boundedBody(request: Request, maximum: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 1 || length > maximum) throw new Error();
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength < 1 || bytes.byteLength > maximum) throw new Error();
  return bytes;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new Error("INVALID_REQUEST");
  }
}

function validResponsesBody(value: unknown, expectedModel: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  return (
    Object.keys(body).every((key) => ["model", "stream", "input"].includes(key)) &&
    body.model === expectedModel &&
    body.stream === false &&
    Array.isArray(body.input)
  );
}

function mappedError(error: unknown): Response {
  const code = error instanceof Error ? error.message : "";
  if (code === "CAPABILITY_NOT_SUPPORTED") return json({ code }, 422);
  if (code === "STATIC_PROVIDER_NOT_CONFIGURED") return json({ code }, 503);
  if (code === "INVALID_REQUEST") return json({ code }, 400);
  if (code === "UPSTREAM_FAILED") return json({ code }, 502);
  return json({ code: "INTERNAL_ERROR" }, 500);
}

function json(body: unknown, status: number, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...Object.fromEntries(new Headers(headers)) },
  });
}

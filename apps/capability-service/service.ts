import { timingSafeEqual } from "node:crypto";
import {
  parseStaticResolveCapabilitiesRequest,
  type ResolvedCapability,
  type StaticResolvedCapability,
  type StaticResolveCapabilitiesRequest,
} from "@frely-network/capability-resolution";
import type { NetworkX402Gate } from "@frely-network/x402-gateway";
import type { RelayUpstream } from "./upstream.ts";

export type CapabilityResolver = {
  resolve(
    request: StaticResolveCapabilitiesRequest,
  ): Promise<StaticResolvedCapability | ResolvedCapability>;
};

const maxRequestBytes = 64 * 1024;

function response(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function emptyResponse(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

function authorized(header: string | null, apiKey: string): boolean {
  const expected = Buffer.from(`Bearer ${apiKey}`);
  const received = Buffer.from(header ?? "");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  if (message === "INVALID_REQUEST") return response({ code: "INVALID_REQUEST" }, 400);
  if (message === "NO_PROVIDER") return response({ code: "NO_PROVIDER" }, 404);
  if (["GRAPH_QUERY_FAILED", "GRAPH_SCHEMA_INVALID"].includes(message)) {
    return response({ code: "NETWORK_DISCOVERY_FAILED" }, 502);
  }
  if (["IDENTITY_VERIFICATION_FAILED", "ENS_ENDPOINT_MISSING", "INVALID_RESPONSE"].includes(message)) {
    return response({ code: "IDENTITY_VERIFICATION_FAILED" }, 502);
  }
  if (message === "CAPABILITY_NOT_SUPPORTED") {
    return response({ code: "CAPABILITY_NOT_SUPPORTED" }, 422);
  }
  if (message === "STATIC_PROVIDER_NOT_CONFIGURED") {
    return response({ code: "STATIC_PROVIDER_NOT_CONFIGURED" }, 503);
  }
  if (message === "UPSTREAM_PAYMENT_UNEXPECTED") {
    return response({ code: "UPSTREAM_PAYMENT_UNEXPECTED" }, 502);
  }
  if (message === "UPSTREAM_FAILED") {
    return response({ code: "UPSTREAM_FAILED" }, 502);
  }
  return response({ code: "INTERNAL_ERROR" }, 500);
}

async function readBoundedText(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("INVALID_REQUEST");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxRequestBytes) throw new Error("INVALID_REQUEST");
  return new TextDecoder().decode(bytes);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("INVALID_REQUEST");
  }
}

function isApprovedModelBody(value: unknown): value is { model: "gpt-5.6-luna"; stream: false } {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { model?: unknown }).model === "gpt-5.6-luna"
    && (value as { stream?: unknown }).stream === false,
  );
}

async function parseResolveRequest(request: Request): Promise<StaticResolveCapabilitiesRequest> {
  return parseStaticResolveCapabilitiesRequest(parseJson(await readBoundedText(request)));
}

async function handleResponses(
  request: Request,
  options: { x402Gate: NetworkX402Gate; upstream: RelayUpstream },
): Promise<Response> {
  const body = await readBoundedText(request);
  const parsed = parseJson(body);
  if (!isApprovedModelBody(parsed)) throw new Error("INVALID_REQUEST");
  const requestId = request.headers.get("x-frely-request-id")?.trim() ?? "";
  if (!requestId) throw new Error("INVALID_REQUEST");
  const admission = await options.x402Gate.admit(request, body);
  if (admission.kind !== "settled") return admission.response;
  const upstreamResponse = await options.upstream.invoke(body, requestId);
  return admission.finish(upstreamResponse);
}

export function createCapabilityServiceFetch(options: {
  apiKey: string;
  resolver: CapabilityResolver;
  x402Gate?: NetworkX402Gate;
  upstream?: RelayUpstream;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && (path === "/healthz" || path === "/readyz")) {
      return response({ status: "ok" });
    }
    if (request.method === "POST" && path === "/v1/responses") {
      if (!options.x402Gate || !options.upstream) return emptyResponse(404);
      if (!authorized(request.headers.get("authorization"), options.apiKey)) {
        return response({ code: "UNAUTHORIZED" }, 401);
      }
      try {
        return await handleResponses(request, {
          x402Gate: options.x402Gate,
          upstream: options.upstream,
        });
      } catch (error) {
        return errorResponse(error);
      }
    }
    if (request.method !== "POST" || path !== "/v1/capabilities/resolve") {
      return emptyResponse(404);
    }
    if (!authorized(request.headers.get("authorization"), options.apiKey)) {
      return response({ code: "UNAUTHORIZED" }, 401);
    }
    try {
      const parsed = await parseResolveRequest(request);
      return response(await options.resolver.resolve(parsed));
    } catch (error) {
      return errorResponse(error);
    }
  };
}

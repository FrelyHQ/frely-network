import { timingSafeEqual } from "node:crypto";
import {
  parseResolveCapabilitiesRequest,
  type ResolvedCapability,
  type ResolveCapabilitiesRequest,
} from "@frely-network/capability-resolution";

export type CapabilityResolver = {
  resolve(request: ResolveCapabilitiesRequest): Promise<ResolvedCapability>;
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
  return response({ code: "INTERNAL_ERROR" }, 500);
}

async function parseRequest(request: Request): Promise<ResolveCapabilitiesRequest> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new Error("INVALID_REQUEST");
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > maxRequestBytes) throw new Error("INVALID_REQUEST");
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("INVALID_REQUEST");
  }
  return parseResolveCapabilitiesRequest(body);
}

export function createCapabilityServiceFetch(options: {
  apiKey: string;
  resolver: CapabilityResolver;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && (path === "/healthz" || path === "/readyz")) {
      return response({ status: "ok" });
    }
    if (request.method !== "POST" || path !== "/v1/capabilities/resolve") {
      return emptyResponse(404);
    }
    if (!authorized(request.headers.get("authorization"), options.apiKey)) {
      return response({ code: "UNAUTHORIZED" }, 401);
    }
    try {
      const parsed = await parseRequest(request);
      return response(await options.resolver.resolve(parsed));
    } catch (error) {
      return errorResponse(error);
    }
  };
}

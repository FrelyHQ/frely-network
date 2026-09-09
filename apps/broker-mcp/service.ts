import {
  BrokerError,
  type CapabilityRequest,
} from "@frely-network/shared-types";

const SERVICE = "frely-network-broker-mcp";
const MCP_PROTOCOL_VERSION = "2024-11-05";
const MAX_MCP_BODY_BYTES = 128 * 1024;

export interface BrokerService {
  findCapability(capabilities: unknown): Promise<unknown>;
  useCapability(request: CapabilityRequest): Promise<unknown>;
}

export interface BrokerRuntime {
  broker?: BrokerService;
  ready: boolean;
}

const defaultRuntime: BrokerRuntime = { ready: false };

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function requestId(value: unknown): string | number | null {
  if (value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  throw new Error("INVALID_REQUEST");
}

function rpcResult(id: string | number | null, result: unknown): Response {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcError(id: string | number | null, code: number, message: string, status = 200): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message } }, status);
}

function tools(): unknown[] {
  return [
    {
      name: "find_capability",
      description: "Discover and verify external capability providers.",
      inputSchema: {
        type: "object",
        properties: { capabilities: { type: "array", items: { type: "string" }, minItems: 1 } },
        required: ["capabilities"],
        additionalProperties: false,
      },
    },
    {
      name: "use_capability",
      description: "Pay for and invoke a verified Responses-compatible capability.",
      inputSchema: {
        type: "object",
        properties: {
          capabilities: { type: "array", items: { type: "string" }, minItems: 1 },
          task: { type: "string", minLength: 1 },
          input: {},
          model: { type: "string" },
          maxAmount: { type: "string", pattern: "^[0-9]+$" },
        },
        required: ["capabilities", "task"],
        additionalProperties: false,
      },
    },
  ];
}

function toolText(value: unknown): { content: [{ type: "text"; text: string }]; structuredContent: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  return value as Record<string, unknown>;
}

function capabilityRequest(args: Record<string, unknown>): CapabilityRequest {
  return {
    capabilities: args.capabilities as string[],
    task: args.task as string,
    ...(Object.prototype.hasOwnProperty.call(args, "input") ? { input: args.input } : {}),
    ...(args.model !== undefined ? { model: args.model as string } : {}),
    ...(args.maxAmount !== undefined ? { maxAmount: args.maxAmount as string } : {}),
  };
}

async function handleMcp(request: Request, runtime: BrokerRuntime): Promise<Response> {
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_MCP_BODY_BYTES) return rpcError(null, -32600, "INVALID_REQUEST", 413);
  let message: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    message = parsed as Record<string, unknown>;
  } catch {
    return rpcError(null, -32700, "INVALID_REQUEST", 400);
  }

  let id: string | number | null;
  try {
    id = requestId(message.id ?? null);
  } catch {
    return rpcError(null, -32600, "INVALID_REQUEST", 400);
  }
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return rpcError(id, -32600, "INVALID_REQUEST", 400);
  if (message.method === "notifications/initialized") return new Response(null, { status: 204 });
  if (message.method === "initialize") {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVICE, version: "0.1.0" },
    });
  }
  if (message.method === "ping") return rpcResult(id, {});
  if (message.method === "tools/list") return rpcResult(id, { tools: tools() });
  if (message.method !== "tools/call") return rpcError(id, -32601, "METHOD_NOT_FOUND");
  if (!runtime.ready || !runtime.broker) return rpcError(id, -32004, "BROKER_NOT_READY", 503);

  try {
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
      ? message.params as Record<string, unknown>
      : {};
    const name = params.name;
    const args = parseToolArguments(params.arguments ?? {});
    if (name === "find_capability") return rpcResult(id, toolText(await runtime.broker.findCapability(args.capabilities)));
    if (name === "use_capability") return rpcResult(id, toolText(await runtime.broker.useCapability(capabilityRequest(args))));
    return rpcError(id, -32602, "INVALID_REQUEST");
  } catch (error) {
    if (error instanceof BrokerError) return rpcError(id, -32001, error.code);
    return rpcError(id, -32001, "BROKER_REQUEST_FAILED");
  }
}

export function createBrokerMcpFetch(runtime: BrokerRuntime): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json({ service: SERVICE, status: "ok" });
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      return runtime.ready && runtime.broker
        ? json({ service: SERVICE, status: "ready" })
        : json({ service: SERVICE, status: "not_ready", code: "BROKER_NOT_READY" }, 503);
    }
    if (request.method === "POST" && url.pathname === "/mcp") return handleMcp(request, runtime);
    return json({ code: "NOT_FOUND" }, 404);
  };
}

export async function brokerMcpFetch(request: Request): Promise<Response> {
  return createBrokerMcpFetch(defaultRuntime)(request);
}

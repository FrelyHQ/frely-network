import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { FrelyMcpRuntime } from "./runtime.ts";

const KNOWN_CODES = new Set([
  "INVALID_REQUEST",
  "CAPABILITY_NOT_SUPPORTED",
  "CONFIG_INVALID",
  "NETWORK_UNAVAILABLE",
  "PROVIDER_NOT_AUTHORIZED",
  "PAYMENT_DISABLED",
  "PAYMENT_REQUIRED",
  "PAYMENT_REJECTED",
  "PAYMENT_LIMIT_EXCEEDED",
  "REQUEST_ID_CONFLICT",
  "REQUEST_IN_PROGRESS",
  "JOURNAL_UNAVAILABLE",
  "SIGNER_UNAVAILABLE",
  "PAYMENT_PROCESSING_UNKNOWN",
  "UPSTREAM_FAILED",
  "OUTPUT_UNAVAILABLE",
]);

const capabilities = z.tuple([z.literal("vision")]);

export function createFrelyMcpServer(runtime: FrelyMcpRuntime): McpServer {
  const server = new McpServer({ name: "frely-mcp", version: "0.1.0" });
  server.registerTool("find_capability", {
    title: "Find capability",
    description: "Resolve the configured static allowlist Provider through the local Frely Network without reading a wallet.",
    inputSchema: z.object({ capabilities }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ capabilities: requested }) => {
    try {
      return response(await runtime.findCapability(requested));
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool("use_capability", {
    title: "Use capability",
    description: "Resolve, authorize and invoke the configured vision Provider through the local Network payment boundary.",
    inputSchema: z.object({
      requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u),
      capabilities,
      task: z.string().trim().min(1).max(8192),
      input: z.object({ image_url: z.string().url() }).strict(),
      maxAmountAtomic: z.string().regex(/^[1-9][0-9]*$/u),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input) => {
    try {
      const result = await runtime.useCapability(input);
      return response(result, result.payment.status !== "settled" || result.service.status !== "succeeded");
    } catch (error) {
      return toolError(error);
    }
  });
  return server;
}

function response(value: object, isError = false) {
  const structuredContent = value as Record<string, unknown>;
  return {
    ...(isError ? { isError: true as const } : {}),
    structuredContent,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
  };
}

function toolError(error: unknown) {
  const code = error instanceof Error && KNOWN_CODES.has(error.message) ? error.message : "EXECUTION_FAILED";
  return { isError: true as const, content: [{ type: "text" as const, text: code }] };
}

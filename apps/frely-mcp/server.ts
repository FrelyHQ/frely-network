import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CapabilityResult, PaymentEvidence, PaymentOutcome } from "@frely-network/shared-types";
import type { FrelyMcpRuntime } from "./runtime.ts";

const known = new Set([
  "NO_PROVIDER",
  "NETWORK_DISCOVERY_FAILED",
  "IDENTITY_VERIFICATION_FAILED",
  "CAPABILITY_NOT_SUPPORTED",
  "CONFIG_INVALID",
  "NETWORK_UNAVAILABLE",
  "WALLET_NOT_READY",
  "PAYMENT_DISABLED",
  "PROVIDER_NOT_AUTHORIZED",
  "QUOTE_MISMATCH",
  "BUDGET_EXCEEDED",
  "PAYMENT_UNKNOWN",
  "PROVIDER_EXECUTION_FAILED",
]);

type ToolResult = CapabilityResult & { identityVerificationSource: "frely-network" };

function toolError(error: unknown) {
  const code = error instanceof Error && known.has(error.message) ? error.message : "EXECUTION_FAILED";
  return { isError: true as const, content: [{ type: "text" as const, text: code }] };
}

function publicEvidence(evidence: PaymentEvidence): PaymentEvidence {
  const { signedDigest, ...safe } = evidence;
  return signedDigest === undefined ? evidence : safe;
}

function publicResult(result: ToolResult): ToolResult {
  const outcome: PaymentOutcome | undefined = result.paymentOutcome;
  if (!outcome?.evidence) return result;
  return {
    ...result,
    paymentOutcome: { ...outcome, evidence: publicEvidence(outcome.evidence) },
  };
}

function asToolResponse(structuredContent: object, isError = false) {
  const payload = structuredContent as { [key: string]: unknown };
  return {
    ...(isError ? { isError: true as const } : {}),
    structuredContent: payload,
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
  };
}

export function createFrelyMcpServer(runtime: FrelyMcpRuntime): McpServer {
  const server = new McpServer({ name: "frely-mcp", version: "0.1.0" });
  server.registerTool("find_capability", {
    description: "Resolve a verified provider for the requested capabilities from Frely Network. Does not invoke Relay or read the wallet.",
    inputSchema: { capabilities: z.array(z.string().trim().min(1)).min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ capabilities }) => {
    try {
      return asToolResponse(await runtime.findCapability(capabilities));
    } catch (error) {
      return toolError(error);
    }
  });
  server.registerTool("use_capability", {
    description: "Re-resolve, authorize the local Provider profile, then pay and invoke the approved Relay.",
    inputSchema: {
      capabilities: z.array(z.string().trim().min(1)).min(1),
      task: z.string().trim().min(1),
      input: z.object({ image_url: z.string().url() }).strict(),
      payment: z.object({
        requestId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
        budget: z.object({
          network: z.literal("hedera:testnet"),
          asset: z.string().min(1),
          maxAmountAtomic: z.string().max(128).regex(/^(0|[1-9][0-9]*)$/),
        }).strict(),
      }).strict(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (request) => {
    try {
      const result = publicResult(await runtime.useCapability(request));
      const isError = result.paymentOutcome
        ? result.paymentOutcome.decision === "blocked" || result.paymentOutcome.decision === "paused" || result.paymentOutcome.serviceStatus === "failed"
        : false;
      return asToolResponse(result, isError);
    } catch (error) {
      return toolError(error);
    }
  });
  return server;
}

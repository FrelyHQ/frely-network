import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CapabilityRequest, CapabilityResult, ProviderCandidate } from "@frely-network/shared-types";

export function createBrokerServer(discovery: {
  findProviders(capabilities: string[]): Promise<ProviderCandidate[]>;
}, broker?: { useCapability(request: CapabilityRequest): Promise<CapabilityResult> }): McpServer {
  const server = new McpServer({ name: "frely-broker", version: "0.0.0" });
  server.registerTool("find_capability", {
    description: "Discover candidate providers for all requested capabilities. Candidates have not been identity-verified.",
    inputSchema: { capabilities: z.array(z.string().trim().min(1)).min(1) },
  }, async ({ capabilities }) => {
    try {
      const providers = await discovery.findProviders(capabilities);
      const structuredContent = { providers };
      return { structuredContent, content: [{ type: "text", text: JSON.stringify(structuredContent) }] };
    } catch (error) {
      const known = ["NO_PROVIDER", "GRAPH_QUERY_FAILED", "GRAPH_SCHEMA_INVALID", "CAPABILITY_NOT_SUPPORTED"];
      const code = error instanceof Error && known.includes(error.message) ? error.message : "DISCOVERY_FAILED";
      return { isError: true, content: [{ type: "text", text: code }] };
    }
  });
  if (broker) server.registerTool("use_capability", {
    description: "Select and verify a provider, then invoke Frely with an optional approved x402 payment budget.",
    inputSchema: {
      capabilities: z.array(z.string().trim().min(1)).min(1),
      task: z.string().trim().min(1),
      input: z.object({ image_url: z.string().url() }).strict(),
      maxAmount: z.string().regex(/^[1-9][0-9]*$/).optional(),
      payment: z.object({
        requestId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/),
        budget: z.object({
          network: z.literal("hedera:testnet"),
          asset: z.string().min(1),
          maxAmountAtomic: z.string().max(128).regex(/^(0|[1-9][0-9]*)$/),
        }).strict(),
        acceptIndex: z.number().int().nonnegative().optional(),
      }).strict().optional(),
    },
  }, async (request) => {
    try {
      const result = await broker.useCapability(request);
      const isError = result.paymentOutcome
        ? result.paymentOutcome.decision === "blocked" || result.paymentOutcome.decision === "paused" || result.paymentOutcome.serviceStatus === "failed"
        : false;
      return { ...(isError ? { isError: true } : {}), structuredContent: { ...result }, content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const known = ["NO_PROVIDER", "GRAPH_QUERY_FAILED", "GRAPH_SCHEMA_INVALID", "CAPABILITY_NOT_SUPPORTED", "IDENTITY_VERIFICATION_FAILED", "PROTOCOL_NOT_SUPPORTED", "ENDPOINT_NOT_HTTPS", "EXECUTION_CONFIG_INVALID", "BUDGET_CHECK_UNAVAILABLE", "BUDGET_INVALID", "LEGACY_BUDGET_UNSUPPORTED", "BUDGET_INPUT_CONFLICT", "PAYMENT_DISABLED", "IDENTITY_CONFIG_INVALID", "EXECUTION_ORIGIN_MISMATCH", "INPUT_INVALID", "INPUT_UNSUPPORTED", "PAYMENT_REQUIRED", "PROVIDER_EXECUTION_FAILED", "PROVIDER_RESULT_INVALID"];
      const code = error instanceof Error && known.includes(error.message) ? error.message : "EXECUTION_FAILED";
      return { isError: true, content: [{ type: "text", text: code }] };
    }
  });
  return server;
}

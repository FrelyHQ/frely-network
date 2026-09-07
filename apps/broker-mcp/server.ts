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
    description: "Select and verify a provider, then invoke Frely in explicitly configured integration mode. No x402 payment is performed.",
    inputSchema: {
      capabilities: z.array(z.string().trim().min(1)).min(1),
      task: z.string().trim().min(1),
      input: z.object({ image_url: z.string().url() }).strict(),
      maxAmount: z.string().regex(/^[1-9][0-9]*$/).optional(),
    },
  }, async (request) => {
    try {
      const result = await broker.useCapability(request);
      return { structuredContent: { ...result }, content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      const known = ["NO_PROVIDER", "GRAPH_QUERY_FAILED", "GRAPH_SCHEMA_INVALID", "CAPABILITY_NOT_SUPPORTED", "IDENTITY_VERIFICATION_FAILED", "PROTOCOL_NOT_SUPPORTED", "ENDPOINT_NOT_HTTPS", "EXECUTION_CONFIG_INVALID", "BUDGET_CHECK_UNAVAILABLE", "IDENTITY_CONFIG_INVALID", "EXECUTION_ORIGIN_MISMATCH", "INPUT_INVALID", "PAYMENT_REQUIRED", "PROVIDER_EXECUTION_FAILED", "PROVIDER_RESULT_INVALID"];
      const code = error instanceof Error && known.includes(error.message) ? error.message : "EXECUTION_FAILED";
      return { isError: true, content: [{ type: "text", text: code }] };
    }
  });
  return server;
}

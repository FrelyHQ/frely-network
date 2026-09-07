import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ProviderCandidate } from "@frely-network/shared-types";

export function createBrokerServer(discovery: {
  findProviders(capabilities: string[]): Promise<ProviderCandidate[]>;
}): McpServer {
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
  return server;
}

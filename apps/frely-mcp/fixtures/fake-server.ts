// Test-only discovery: never imported by the production entry.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBrokerServer } from "../server.ts";

const server = createBrokerServer({
  async findProviders(capabilities: string[]) {
    if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error("FAKE_CALLED_INVALID");
    }
    const first = capabilities[0]!;
    if (first === "unexpected") throw new Error("https://secret.example/?key=DO_NOT_EXPOSE");
    if (["NO_PROVIDER", "GRAPH_QUERY_FAILED", "GRAPH_SCHEMA_INVALID", "CAPABILITY_NOT_SUPPORTED"].includes(first)) throw new Error(first);
    return [{ id: "fake-provider", capabilities, supportsX402: true }];
  },
});
await server.connect(new StdioServerTransport());

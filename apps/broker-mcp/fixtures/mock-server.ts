// Explicit offline development entry. Never imported by index.ts.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ProviderCandidate } from "@frely-network/shared-types";
import { createBrokerServer } from "../server.ts";

const providers: ProviderCandidate[] = [
  { id: "mock-vision-basic", capabilities: ["vision"], supportsX402: false },
  { id: "mock-vision-ocr", capabilities: ["vision", "ocr"], supportsX402: false },
];
const scenario = process.env.MOCK_DISCOVERY_SCENARIO ?? "success";
if (!["success", "empty", "query-error"].includes(scenario)) {
  console.error("MOCK_SCENARIO_INVALID");
  process.exit(1);
}
console.error("MOCK DISCOVERY: synthetic offline candidates; not Graph, identity, execution or payment evidence.");
const server = createBrokerServer({
  async findProviders(capabilities) {
    if (scenario === "query-error") throw new Error("GRAPH_QUERY_FAILED");
    const matches = scenario === "empty" ? [] : providers.filter((provider) =>
      capabilities.every((capability) => provider.capabilities.includes(capability)),
    );
    if (!matches.length) throw new Error("NO_PROVIDER");
    return structuredClone(matches);
  },
});
await server.connect(new StdioServerTransport());

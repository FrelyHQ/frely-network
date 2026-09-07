// Protocol test only: all identity and execution responses are synthetic.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBroker } from "@frely-network/broker";
import { createBrokerServer } from "../server.ts";
const discovery = {
  async findProviders(capabilities: string[]) {
    return [{ id: "mock-use", capabilities, supportsX402: false }];
  },
};
const broker = createBroker({
  ...discovery,
  async resolveProvider(candidate) {
    return { id: candidate.id, protocol: "responses" as const, endpoint: "https://frely.example/v1/responses", verified: !candidate.capabilities.includes("invalid") };
  },
  async execute() { return { output_text: "synthetic result" }; },
});
await createBrokerServer(discovery, broker).connect(new StdioServerTransport());

// Explicit offline development entry. Never imported by index.ts.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseResolvedCapability } from "@frely-network/capability-resolution";
import successFixture from "../../../packages/protocol/capability-resolution/fixtures/success.json";
import type { FrelyMcpRuntime } from "../runtime.ts";
import { createFrelyMcpServer } from "../server.ts";

const scenario = process.env.MOCK_DISCOVERY_SCENARIO ?? "success";
if (!["success", "empty", "query-error"].includes(scenario)) {
  console.error("MOCK_SCENARIO_INVALID");
  process.exit(1);
}
console.error("MOCK DISCOVERY: synthetic offline candidates; not Graph, identity, execution or payment evidence.");

const runtime: FrelyMcpRuntime = {
  async findCapability(capabilities) {
    if (scenario === "query-error") throw new Error("NETWORK_DISCOVERY_FAILED");
    if (scenario === "empty" || capabilities.some((capability) => capability !== "vision")) {
      throw new Error("NO_PROVIDER");
    }
    return parseResolvedCapability(successFixture);
  },
  async useCapability() {
    throw new Error("PAYMENT_DISABLED");
  },
  close() {},
};
await createFrelyMcpServer(runtime).connect(new StdioServerTransport());

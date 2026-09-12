// Protocol test only: all identity and execution responses are synthetic.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseStaticResolvedCapability } from "@frely-network/capability-resolution";
import staticSuccess from "../../../packages/protocol/capability-resolution/fixtures/static-success-v2.json";
import type { FrelyMcpRuntime } from "../runtime.ts";
import { createFrelyMcpServer } from "../server.ts";

const runtime: FrelyMcpRuntime = {
  async findCapability() {
    return parseStaticResolvedCapability(staticSuccess);
  },
  async useCapability(request) {
    if (request.capabilities.includes("invalid")) throw new Error("CAPABILITY_NOT_SUPPORTED");
    return {
      provider: { id: "frely-vision-basic" },
      resolutionSource: "static_allowlist",
      identityVerified: false,
      output: { output_text: "synthetic result" },
    };
  },
  close() {},
};
await createFrelyMcpServer(runtime).connect(new StdioServerTransport());

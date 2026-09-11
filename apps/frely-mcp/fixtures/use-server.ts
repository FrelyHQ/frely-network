// Protocol test only: all identity and execution responses are synthetic.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseResolvedCapability } from "@frely-network/capability-resolution";
import successFixture from "../../../packages/protocol/capability-resolution/fixtures/success.json";
import type { FrelyMcpRuntime } from "../runtime.ts";
import { createFrelyMcpServer } from "../server.ts";

const runtime: FrelyMcpRuntime = {
  async findCapability() {
    return parseResolvedCapability(successFixture);
  },
  async useCapability(request) {
    if (request.capabilities.includes("invalid")) throw new Error("CAPABILITY_NOT_SUPPORTED");
    return {
      provider: { id: "provider-1", ensName: "vision.example.eth" },
      identityVerificationSource: "frely-network",
      output: { output_text: "synthetic result" },
    };
  },
  close() {},
};
await createFrelyMcpServer(runtime).connect(new StdioServerTransport());

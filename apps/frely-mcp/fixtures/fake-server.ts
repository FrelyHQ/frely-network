import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseStaticResolveResult } from "@frely-network/capability-resolution";
import success from "../../../packages/protocol/capability-resolution/fixtures/static-success-v2.json";
import { createFrelyMcpServer } from "../server.ts";

const staticSuccess = parseStaticResolveResult(success);

const runtime = {
  async findCapability(capabilities: string[]) {
    if (capabilities[0] === "explode") throw new Error("secret.example/internal");
    return staticSuccess;
  },
  async useCapability(input: { requestId: string }) {
    if (input.requestId === "explode") throw new Error("secret.example/internal");
    return {
      requestId: input.requestId,
      provider: { id: "example-vision" },
      resolution: { source: "static_allowlist" as const, identityVerified: false as const },
      payment: { status: "settled" as const, network: "hedera:testnet" as const, transactionId: "tx-1" },
      service: { status: "succeeded" as const },
      retryAction: "none" as const,
      output: { output_text: "synthetic" },
    };
  },
  close() {},
};

const server = createFrelyMcpServer(runtime);
await server.connect(new StdioServerTransport());
await new Promise<void>((resolve) => {
  if (process.stdin.readableEnded || process.stdin.destroyed) resolve();
  else {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
  }
});
await server.close();

// Test-only discovery: never imported by the production entry.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { parseResolvedCapability } from "@frely-network/capability-resolution";
import successFixture from "../../../packages/protocol/capability-resolution/fixtures/success.json";
import type { FrelyMcpRuntime } from "../runtime.ts";
import { createFrelyMcpServer } from "../server.ts";

const known = [
  "NO_PROVIDER",
  "NETWORK_DISCOVERY_FAILED",
  "IDENTITY_VERIFICATION_FAILED",
  "CAPABILITY_NOT_SUPPORTED",
  "CONFIG_INVALID",
  "NETWORK_UNAVAILABLE",
  "WALLET_NOT_READY",
  "PAYMENT_DISABLED",
  "PROVIDER_NOT_AUTHORIZED",
  "QUOTE_MISMATCH",
  "BUDGET_EXCEEDED",
  "PAYMENT_UNKNOWN",
  "PROVIDER_EXECUTION_FAILED",
];

const runtime: FrelyMcpRuntime = {
  async findCapability(capabilities) {
    if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some((value) => typeof value !== "string" || !value.trim())) {
      throw new Error("FAKE_CALLED_INVALID");
    }
    const first = capabilities[0]!;
    if (first === "unexpected") throw new Error("https://secret.example/?key=DO_NOT_EXPOSE");
    if (known.includes(first)) throw new Error(first);
    return parseResolvedCapability(successFixture);
  },
  async useCapability() {
    throw new Error("FAKE_CALLED_INVALID");
  },
  close() {},
};
await createFrelyMcpServer(runtime).connect(new StdioServerTransport());

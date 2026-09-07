import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBroker, createPaidExecutor } from "@frely-network/broker";
import { createHarness } from "../../../packages/payment/hedera-x402/test-support.ts";
import { createBrokerServer } from "../server.ts";

const harness = createHarness();
const discovery = { async findProviders(capabilities: string[]) { return [{ id: "synthetic-provider", capabilities, supportsX402: true }]; } };
const executePaid = createPaidExecutor({ policy: harness.policy, ports: harness.ports, executionConfig: { mode: "integration", origin: new URL(harness.policy.resourceUrl).origin, callerKey: "test-only" } });
const broker = createBroker({
  ...discovery,
  async resolveProvider(candidate) { return { id: candidate.id, endpoint: harness.policy.resourceUrl, protocol: "responses" as const, verified: true }; },
  async execute() { throw new Error("LEGACY_PATH_USED"); },
  executePaid,
  paymentEnabled: true,
});
await createBrokerServer(discovery, broker).connect(new StdioServerTransport());

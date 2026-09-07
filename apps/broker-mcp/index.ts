import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGraphDiscovery } from "@frely-network/the-graph";
import { createBrokerServer } from "./server.ts";

try {
  const endpoint = process.env.GRAPH_ENDPOINT?.trim();
  const paymentNetwork = process.env.PAYMENT_NETWORK?.trim();
  if (!endpoint || !paymentNetwork) throw new Error("GRAPH_CONFIG_INVALID");
  const url = new URL(endpoint);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("GRAPH_CONFIG_INVALID");
  const discovery = createGraphDiscovery({ endpoint, paymentNetwork, requestTimeoutMs: 10_000 });
  const server = createBrokerServer(discovery);
  await server.connect(new StdioServerTransport());
} catch {
  // Never print configuration, credentials or non-protocol data on stdout.
  console.error("GRAPH_CONFIG_INVALID");
  process.exitCode = 1;
}

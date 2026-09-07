import { createBroker, createFrelyExecutor } from "@frely-network/broker";
import { createEnsReader } from "@frely-network/ens";
import { ProviderIdentityResolver, ViemErc8004Reader } from "@frely-network/erc8004";
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
  const broker = createBroker({
    findProviders: (capabilities) => discovery.findProviders(capabilities),
    async resolveProvider(candidate) {
      const rpcUrl = process.env.ENS_SEPOLIA_RPC_URL;
      const registry = process.env.ERC8004_IDENTITY_REGISTRY;
      if (!rpcUrl || !registry || !/^0x[0-9a-fA-F]{40}$/.test(registry) || /^0x0{40}$/.test(registry) || process.env.IDENTITY_CHAIN_ID !== "11155111") throw new Error("IDENTITY_CONFIG_INVALID");
      const resolver = new ProviderIdentityResolver(createEnsReader({ rpcUrl }), new ViemErc8004Reader({ rpcUrl, registryAddress: registry as `0x${string}` }));
      return resolver.resolveProvider(candidate);
    },
    execute: createFrelyExecutor({ mode: process.env.BROKER_EXECUTION_MODE, origin: process.env.FRELY_ALLOWED_ORIGIN, callerKey: process.env.FRELY_CALLER_API_KEY }),
  });
  const server = createBrokerServer(discovery, broker);
  await server.connect(new StdioServerTransport());
} catch {
  // Never print configuration, credentials or non-protocol data on stdout.
  console.error("GRAPH_CONFIG_INVALID");
  process.exitCode = 1;
}

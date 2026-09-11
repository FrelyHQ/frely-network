import { isIP } from "node:net";
import { createEnsReader } from "@frely-network/ens";
import { ProviderIdentityResolver, ViemErc8004Reader } from "@frely-network/erc8004";
import { createGraphDiscovery } from "@frely-network/the-graph";
import { createCapabilityResolver } from "./resolver.ts";
import { createCapabilityServiceFetch } from "./service.ts";

type Environment = Record<string, string | undefined>;

export type CapabilityServiceRuntime = {
  fetch: ReturnType<typeof createCapabilityServiceFetch>;
  host: string;
  port: string;
};

function required(environment: Environment, name: keyof Environment): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error("SERVICE_CONFIG_INVALID");
  return value;
}

function relayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RELAY_ORIGIN_INVALID");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "");
  const ipHost = hostname.replace(/^\[|\]$/g, "");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !hostname.includes(".") ||
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    isIP(ipHost) !== 0
  ) {
    throw new Error("RELAY_ORIGIN_INVALID");
  }
  return url.origin;
}

function registry(value: string): `0x${string}` {
  if (!/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error("SERVICE_CONFIG_INVALID");
  }
  return value as `0x${string}`;
}

export function createCapabilityServiceRuntime(
  environment: Environment = process.env,
): CapabilityServiceRuntime {
  const graphEndpoint = required(environment, "GRAPH_ENDPOINT");
  const rpcUrl = required(environment, "ENS_SEPOLIA_RPC_URL");
  const registryAddress = registry(required(environment, "ERC8004_IDENTITY_REGISTRY"));
  const apiKey = required(environment, "FRELY_SERVICE_API_KEY");
  const allowedRelayOrigin = relayOrigin(required(environment, "FRELY_ALLOWED_RELAY_ORIGIN"));
  const host = environment.HOST?.trim() || "127.0.0.1";
  const port = environment.PORT?.trim() || "4100";
  const graph = createGraphDiscovery({
    endpoint: graphEndpoint,
    paymentNetwork: "hedera:testnet",
  });
  const identity = new ProviderIdentityResolver(
    createEnsReader({ rpcUrl }),
    new ViemErc8004Reader({ rpcUrl, registryAddress }),
  );
  const resolver = createCapabilityResolver({
    findProviders: (capabilities) => graph.findProviders(capabilities),
    resolveProvider: (candidate) => identity.resolveProvider(candidate),
    chainId: 11155111,
    registry: registryAddress,
    allowedRelayOrigin,
  });

  return {
    fetch: createCapabilityServiceFetch({ apiKey, resolver }),
    host,
    port,
  };
}

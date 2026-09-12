import { getAddress, zeroAddress } from "viem";
import { createGraphDiscovery } from "@frely-network/the-graph";
import { createEnsReader } from "@frely-network/ens";
import { ProviderIdentityResolver, ViemErc8004Reader } from "@frely-network/erc8004";
import type { ProviderCandidate, ResolvedProvider } from "@frely-network/shared-types";

export type { ProviderCandidate, ResolvedProvider } from "@frely-network/shared-types";

export interface ProviderDirectory {
  findProviders(capabilities: string[]): Promise<ProviderCandidate[]>;
  resolveProvider(candidate: ProviderCandidate): Promise<ResolvedProvider>;
}

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

function required(env: ProviderEnvironment, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`PROVIDER_CONFIG_MISSING:${key}`);
  return value;
}

function url(value: string, key: string, httpsOnly = false): string {
  try {
    const parsed = new URL(value);
    if (/[<>]/.test(value) || parsed.username || parsed.password ||
        !(httpsOnly ? ["https:"] : ["http:", "https:"]).includes(parsed.protocol)) {
      throw new Error();
    }
    return value;
  } catch {
    // Do not include endpoint URLs: Graph/RPC credentials may be in the path.
    throw new Error(`PROVIDER_CONFIG_INVALID:${key}`);
  }
}

/** Server-side composition only: no selection, provider execution, or payment. */
export function createProviderDirectory(env: ProviderEnvironment = process.env): ProviderDirectory {
  const graphEndpoint = url(required(env, "GRAPH_ENDPOINT"), "GRAPH_ENDPOINT", true);
  const rpcUrl = url(required(env, "ENS_SEPOLIA_RPC_URL"), "ENS_SEPOLIA_RPC_URL");
  const metadataGateway = env.METADATA_GATEWAY?.trim()
    ? url(env.METADATA_GATEWAY.trim(), "METADATA_GATEWAY", true) : undefined;
  if (required(env, "IDENTITY_CHAIN_ID") !== "11155111") {
    throw new Error("PROVIDER_CONFIG_INVALID:IDENTITY_CHAIN_ID");
  }
  if (required(env, "PAYMENT_NETWORK") !== "hedera:testnet") {
    throw new Error("PROVIDER_CONFIG_INVALID:PAYMENT_NETWORK");
  }
  const registry = required(env, "ERC8004_IDENTITY_REGISTRY");
  let registryAddress: ReturnType<typeof getAddress>;
  try {
    registryAddress = getAddress(registry);
    if (registryAddress === zeroAddress) throw new Error();
  } catch {
    throw new Error("PROVIDER_CONFIG_INVALID:ERC8004_IDENTITY_REGISTRY");
  }

  const discovery = createGraphDiscovery({
    endpoint: graphEndpoint,
    network: "11155111",
    registryAddress,
    paymentNetwork: "hedera:testnet",
    ...(metadataGateway === undefined ? {} : { metadataGateway }),
  });
  const resolver = new ProviderIdentityResolver(
    createEnsReader({ rpcUrl, requireHttps: true }),
    new ViemErc8004Reader({ rpcUrl, registryAddress, ...(metadataGateway === undefined ? {} : { metadataGateway }) }),
  );

  // Bound closures remain usable when passed directly to B's orchestrator.
  return {
    findProviders: (capabilities) => discovery.findProviders(capabilities),
    resolveProvider: (candidate) => resolver.resolveProvider(candidate),
  };
}

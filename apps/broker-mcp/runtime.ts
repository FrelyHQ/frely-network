import { A2AServiceInvocation, Broker, ProtocolInvocation, ResponsesInvocation } from "@frely-network/broker";
import { TheGraphDiscovery } from "@frely-network/the-graph";
import { FrelyAgentDiscovery, FrelyOfferingResolver } from "@frely-network/frely-discovery";
import { ViemEnsReader } from "@frely-network/ens";
import { ProviderIdentityResolver, ViemErc8004Reader } from "@frely-network/erc8004";
import { BrokerError, type ResolvedProvider, type CapabilityRequest, isSafePublicHttpUrl } from "@frely-network/shared-types";
import type { Address } from "viem";
import type { BrokerRuntime } from "./service.ts";
import { FrelyAccountBillingClient } from "./frely-account-billing.ts";

type RuntimeEnvironment = Record<string, string | undefined>;

function required(environment: RuntimeEnvironment, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value || undefined;
}

function address(value: string): Address | undefined {
  return /^0x[0-9a-f]{40}$/iu.test(value) ? value as Address : undefined;
}

export function createBrokerRuntimeFromEnv(environment: RuntimeEnvironment = process.env): BrokerRuntime {
  const graphEndpoint = required(environment, "GRAPH_ENDPOINT");
  const ensRpcUrl = required(environment, "ENS_RPC_URL");
  const registryAddress = required(environment, "ERC8004_REGISTRY_ADDRESS");
  const frelyApiKey = required(environment, "FRELY_API_KEY");
  if (
    !graphEndpoint ||
    !ensRpcUrl ||
    !registryAddress ||
    !frelyApiKey ||
    !isSafePublicHttpUrl(graphEndpoint, { requireHttps: true }) ||
    !isSafePublicHttpUrl(ensRpcUrl, { requireHttps: true })
  ) return { ready: false };
  const registry = address(registryAddress);
  if (!registry) return { ready: false };

  try {
    const responses = new ResponsesInvocation({
      payment: new FrelyAccountBillingClient(frelyApiKey),
      requirePayment: false,
      headers: { authorization: `Bearer ${frelyApiKey}` },
    });
    const a2a = new A2AServiceInvocation({
      headers: { authorization: `Bearer ${frelyApiKey}` },
      ...(required(environment, "FRELY_NETWORK_A2A_AGENT_ID") ? { agentId: required(environment, "FRELY_NETWORK_A2A_AGENT_ID") } : {}),
      defaultModel: required(environment, "FRELY_A2A_DEFAULT_MODEL"),
    });
    const transportInvocation = new ProtocolInvocation({ responses, a2a });
    const frelyOrigin = required(environment, "FRELY_API_ORIGIN") ?? "https://api.frely.cloud";
    if (!isSafePublicHttpUrl(frelyOrigin, { requireHttps: true }) || new URL(frelyOrigin).pathname !== "/" || new URL(frelyOrigin).search || new URL(frelyOrigin).hash) return { ready: false };
    const invocation = {
      invoke(provider: ResolvedProvider, request: CapabilityRequest, correlationId: string) {
        // A verified publisher must not redirect the platform credential to another origin.
        const endpoint = new URL(provider.endpoint);
        if (endpoint.origin !== new URL(frelyOrigin).origin || endpoint.username || endpoint.password || endpoint.hash) throw new BrokerError("IDENTITY_VERIFICATION_FAILED");
        return transportInvocation.invoke(provider, request, correlationId);
      },
    };
    const underlyingAgents = new FrelyAgentDiscovery({ origin: frelyOrigin, apiKey: frelyApiKey });
    const web3Identity = new ProviderIdentityResolver(
      new ViemEnsReader({ rpcUrl: ensRpcUrl }),
      new ViemErc8004Reader({ rpcUrl: ensRpcUrl, registryAddress: registry }),
    );
    const identity = new FrelyOfferingResolver(web3Identity, underlyingAgents);
    const broker = new Broker({
      discovery: new TheGraphDiscovery({
        endpoint: graphEndpoint,
        registryAddress: registry,
        paymentNetwork: "hedera:testnet",
        metadataGateway: required(environment, "GRAPH_METADATA_GATEWAY"),
      }),
      identity,
      invocation,
    }, { billingMode: "frely_account", discoverySource: "the_graph", registryChainId: "11155111" });
    return { ready: true, broker, underlyingAgents };
  } catch {
    return { ready: false };
  }
}

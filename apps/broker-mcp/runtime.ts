import { A2AServiceInvocation, Broker, ProtocolInvocation, ResponsesInvocation } from "@frely-network/broker";
import { TheGraphDiscovery } from "@frely-network/the-graph";
import { ViemEnsReader } from "@frely-network/ens";
import { ProviderIdentityResolver, ViemErc8004Reader } from "@frely-network/erc8004";
import {
  createHederaPaymentSigner,
  HederaX402Client,
} from "@frely-network/hedera-x402";
import { isSafePublicHttpUrl } from "@frely-network/shared-types";
import type { Address } from "viem";
import type { BrokerRuntime } from "./service.ts";

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
  const accountId = required(environment, "X402_ACCOUNT_ID");
  const privateKey = required(environment, "X402_PRIVATE_KEY");
  const frelyApiKey = required(environment, "FRELY_API_KEY");
  if (
    !graphEndpoint ||
    !ensRpcUrl ||
    !registryAddress ||
    !accountId ||
    !privateKey ||
    !frelyApiKey ||
    !isSafePublicHttpUrl(graphEndpoint, { requireHttps: true }) ||
    !isSafePublicHttpUrl(ensRpcUrl, { requireHttps: true })
  ) return { ready: false };
  const registry = address(registryAddress);
  if (!registry) return { ready: false };

  try {
    const signer = createHederaPaymentSigner(accountId, privateKey);
    const responsesPayment = new HederaX402Client({
      signer,
      maxAmount: required(environment, "X402_MAX_AMOUNT"),
    });
    const a2aPayment = new HederaX402Client({
      signer,
      maxAmount: required(environment, "X402_MAX_AMOUNT"),
      // Relay returns its own bounded quote projection; Network settlement is
      // a separate adapter and remains pending until one is configured.
      requireSettlementEvidence: false,
    });
    const responses = new ResponsesInvocation({
      payment: responsesPayment,
      requirePayment: true,
      headers: { authorization: `Bearer ${frelyApiKey}` },
    });
    const a2a = new A2AServiceInvocation({
      payment: a2aPayment,
      headers: { authorization: `Bearer ${frelyApiKey}` },
      ...(required(environment, "FRELY_NETWORK_A2A_AGENT_ID") ? { agentId: required(environment, "FRELY_NETWORK_A2A_AGENT_ID") } : {}),
      defaultModel: required(environment, "FRELY_A2A_DEFAULT_MODEL"),
      requireSettlement: false,
    });
    const invocation = new ProtocolInvocation({ responses, a2a });
    const identity = new ProviderIdentityResolver(
      new ViemEnsReader({ rpcUrl: ensRpcUrl }),
      new ViemErc8004Reader({ rpcUrl: ensRpcUrl, registryAddress: registry }),
    );
    const broker = new Broker({
      discovery: new TheGraphDiscovery({
        endpoint: graphEndpoint,
        paymentNetwork: "hedera:testnet",
        metadataGateway: required(environment, "GRAPH_METADATA_GATEWAY"),
      }),
      identity,
      invocation,
    });
    return { ready: true, broker };
  } catch {
    return { ready: false };
  }
}

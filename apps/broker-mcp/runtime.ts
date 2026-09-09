import { Broker, ResponsesInvocation } from "@frely-network/broker";
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
    const payment = new HederaX402Client({
      signer: createHederaPaymentSigner(accountId, privateKey),
      maxAmount: required(environment, "X402_MAX_AMOUNT"),
    });
    const invocation = new ResponsesInvocation({
      payment,
      requirePayment: true,
      headers: { authorization: `Bearer ${frelyApiKey}` },
    });
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

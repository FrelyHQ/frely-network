import {
  parseStaticResolvedCapability,
  type StaticResolveCapabilitiesRequest,
  type StaticResolvedCapability,
} from "@frely-network/capability-resolution";

export function createStaticCapabilityResolver(config: {
  providerId: string;
  endpoint: string;
  executionEndpoint: string;
}) {
  if (
    config.providerId !== "frely-vision-basic"
    || config.endpoint !== "https://api.frely.cloud/v1/responses"
    || config.executionEndpoint !== "http://127.0.0.1:13600/v1/responses"
  ) throw new Error("STATIC_PROVIDER_NOT_CONFIGURED");

  return {
    async resolve(request: StaticResolveCapabilitiesRequest): Promise<StaticResolvedCapability> {
      if (
        request.schemaVersion !== 2
        || request.paymentNetwork !== "hedera:testnet"
        || request.capabilities.length !== 1
        || request.capabilities[0] !== "vision"
      ) throw new Error("CAPABILITY_NOT_SUPPORTED");
      return parseStaticResolvedCapability({
        schemaVersion: 2,
        requestedCapabilities: ["vision"],
        provider: {
          id: "frely-vision-basic",
          endpoint: "https://api.frely.cloud/v1/responses",
          protocol: "responses",
        },
        execution: {
          endpoint: "http://127.0.0.1:13600/v1/responses",
          managedBy: "network",
        },
        resolution: { source: "static_allowlist", identityVerified: false },
        payment: {
          supportsX402: true,
          network: "hedera:testnet",
          resource: "http://127.0.0.1:13600/v1/responses",
        },
      });
    },
  };
}

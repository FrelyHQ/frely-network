import {
  parseStaticResolveRequest,
  parseStaticResolveResult,
  type StaticResolveRequest,
  type StaticResolveResult,
} from "@frely-network/capability-resolution";

export type StaticCapabilityResolver = {
  resolve(request: StaticResolveRequest): Promise<StaticResolveResult>;
};

export function createStaticCapabilityResolver(config: {
  providerId: string;
  relayUrl: string;
  resourceUrl: string;
}): StaticCapabilityResolver {
  const result = parseStaticResolveResult({
    schemaVersion: 2,
    requestedCapabilities: ["vision"],
    provider: {
      id: config.providerId,
      endpoint: config.relayUrl,
      protocol: "responses",
    },
    execution: {
      endpoint: config.resourceUrl,
      managedBy: "network",
    },
    resolution: {
      source: "static_allowlist",
      identityVerified: false,
    },
    payment: {
      supportsX402: true,
      network: "hedera:testnet",
      resource: config.resourceUrl,
    },
  });

  return {
    async resolve(request) {
      try {
        parseStaticResolveRequest(request);
      } catch {
        throw new Error("CAPABILITY_NOT_SUPPORTED");
      }
      return result;
    },
  };
}

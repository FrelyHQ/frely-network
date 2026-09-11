import {
  parseResolvedCapability,
  type ResolveCapabilitiesRequest,
  type ResolvedCapability,
} from "@frely-network/capability-resolution";

type ProviderCandidate = {
  id: string;
  ensName?: string;
  capabilities: string[];
  supportsX402: boolean;
};

type ResolvedProvider = {
  id: string;
  ensName?: string;
  endpoint: string;
  protocol: "responses" | "mcp" | "http";
  verified: boolean;
};

type CapabilityResolverDependencies = {
  findProviders(capabilities: string[]): Promise<ProviderCandidate[]>;
  resolveProvider(candidate: ProviderCandidate): Promise<ResolvedProvider>;
  chainId: 11155111;
  registry: `0x${string}`;
  allowedRelayOrigin: string;
};

const identitySkipCodes = new Set([
  "IDENTITY_VERIFICATION_FAILED",
  "ENDPOINT_NOT_HTTPS",
  "PROTOCOL_NOT_SUPPORTED",
  "ENS_ENDPOINT_MISSING",
  "INVALID_RESPONSE",
  "CAPABILITY_NOT_SUPPORTED",
]);

function compareCandidate(left: ProviderCandidate, right: ProviderCandidate): number {
  return `${left.ensName?.toLowerCase() ?? ""}\0${left.id}`.localeCompare(
    `${right.ensName?.toLowerCase() ?? ""}\0${right.id}`,
  );
}

export function createCapabilityResolver(deps: CapabilityResolverDependencies): {
  resolve(request: ResolveCapabilitiesRequest): Promise<ResolvedCapability>;
} {
  return {
    async resolve(request) {
      const candidates = await deps.findProviders(request.capabilities);
      const matching = candidates.filter((candidate) =>
        candidate.supportsX402 && request.capabilities.every((capability) => candidate.capabilities.includes(capability)),
      );
      if (!matching.length) throw new Error("NO_PROVIDER");
      const skipped = new Set<string>();
      for (const candidate of matching.sort(compareCandidate)) {
        try {
          const provider = await deps.resolveProvider(candidate);
          if (new URL(provider.endpoint).origin !== deps.allowedRelayOrigin) {
            throw new Error("IDENTITY_VERIFICATION_FAILED");
          }
          return parseResolvedCapability({
            schemaVersion: 1,
            requestedCapabilities: [...request.capabilities],
            provider: {
              id: provider.id,
              ensName: provider.ensName,
              endpoint: provider.endpoint,
              protocol: provider.protocol,
            },
            identity: { verified: true, chainId: deps.chainId, registry: deps.registry },
            payment: { supportsX402: true, network: "hedera:testnet" },
          });
        } catch (error) {
          if (!(error instanceof Error) || !identitySkipCodes.has(error.message)) {
            throw error;
          }
          skipped.add(error.message);
        }
      }
      if (skipped.size === 1 && skipped.has("CAPABILITY_NOT_SUPPORTED")) {
        throw new Error("CAPABILITY_NOT_SUPPORTED");
      }
      throw new Error("IDENTITY_VERIFICATION_FAILED");
    },
  };
}

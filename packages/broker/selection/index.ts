import {
  BrokerError,
  type ProviderCandidate,
  type ResolvedProvider,
} from "@frely-network/shared-types";

export interface VerifiedCandidate {
  candidate: ProviderCandidate;
  provider: ResolvedProvider;
}

export function normalizeCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) throw new BrokerError("CAPABILITY_NOT_SUPPORTED");
  const capabilities = [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
  if (capabilities.length === 0 || capabilities.length > 16) throw new BrokerError("CAPABILITY_NOT_SUPPORTED");
  return capabilities;
}

export function selectVerifiedCandidate(
  candidates: VerifiedCandidate[],
  capabilities: string[],
): VerifiedCandidate {
  const eligible = candidates
    .filter(({ candidate, provider }) =>
      candidate.supportsX402 &&
      provider.verified &&
      provider.protocol === "responses" &&
      capabilities.every((capability) => candidate.capabilities.includes(capability)),
    )
    .sort((left, right) => {
      const reputationDelta = (right.candidate.reputation ?? 0) - (left.candidate.reputation ?? 0);
      return reputationDelta || left.provider.id.localeCompare(right.provider.id);
    });
  const selected = eligible[0];
  if (!selected) throw new BrokerError("NO_VERIFIED_PROVIDER");
  return selected;
}

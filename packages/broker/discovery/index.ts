import {
  BrokerError,
  type ProviderCandidate,
  type ResolvedProvider,
} from "@frely-network/shared-types";
import { normalizeCapabilities, type VerifiedCandidate } from "../selection/index.ts";

export interface ProviderDiscoveryPort {
  findProviders(capabilities: string[]): Promise<ProviderCandidate[]>;
}

export interface ProviderIdentityPort {
  resolveProvider(candidate: ProviderCandidate): Promise<ResolvedProvider>;
}

function isProviderCandidate(value: unknown): value is ProviderCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ProviderCandidate>;
  return Boolean(
    typeof candidate.id === "string" &&
    candidate.id.trim() &&
    Array.isArray(candidate.capabilities) &&
    candidate.capabilities.every((capability) => typeof capability === "string") &&
    typeof candidate.supportsX402 === "boolean",
  );
}

export async function discoverVerified(
  discovery: ProviderDiscoveryPort,
  identity: ProviderIdentityPort,
  requestedCapabilities: unknown,
): Promise<{ capabilities: string[]; candidates: VerifiedCandidate[] }> {
  const capabilities = normalizeCapabilities(requestedCapabilities);
  let discovered: ProviderCandidate[];
  try {
    discovered = await discovery.findProviders(capabilities);
  } catch {
    throw new BrokerError("NO_PROVIDER");
  }
  if (!Array.isArray(discovered) || discovered.length === 0) throw new BrokerError("NO_PROVIDER");

  const candidates: VerifiedCandidate[] = [];
  for (const candidate of discovered) {
    if (!isProviderCandidate(candidate) || !candidate.supportsX402 || !capabilities.every((capability) => candidate.capabilities.includes(capability))) continue;
    try {
      const provider = await identity.resolveProvider(candidate);
      if (provider.verified && provider.protocol === "responses") candidates.push({ candidate, provider });
    } catch {
      // A failed identity check is an ineligible candidate, never a payment or invocation path.
    }
  }
  if (candidates.length === 0) throw new BrokerError("NO_VERIFIED_PROVIDER");
  return { capabilities, candidates };
}

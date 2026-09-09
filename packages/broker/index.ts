import {
  BrokerError,
  type CapabilityDescriptor,
  type CapabilityRequest,
  type CapabilityResult,
} from "@frely-network/shared-types";
import {
  discoverVerified,
  type ProviderDiscoveryPort,
  type ProviderIdentityPort,
} from "./discovery/index.ts";
import { selectVerifiedCandidate } from "./selection/index.ts";
import type { CapabilityInvocationPort } from "./execution/index.ts";

export interface BrokerDependencies {
  discovery: ProviderDiscoveryPort;
  identity: ProviderIdentityPort;
  invocation: CapabilityInvocationPort;
}

export interface BrokerConfig {
  idFactory?: () => string;
  maxTaskLength?: number;
}

function validateRequest(request: CapabilityRequest): CapabilityRequest {
  if (!request || typeof request !== "object") throw new BrokerError("INVALID_REQUEST");
  if (typeof request.task !== "string" || request.task.trim().length === 0) {
    throw new BrokerError("INVALID_REQUEST");
  }
  if (request.model !== undefined && (typeof request.model !== "string" || request.model.trim().length === 0 || request.model.length > 256)) {
    throw new BrokerError("INVALID_REQUEST");
  }
  if (request.maxAmount !== undefined && (typeof request.maxAmount !== "string" || !/^\d+$/u.test(request.maxAmount))) {
    throw new BrokerError("INVALID_REQUEST");
  }
  return request;
}

/** Stateless Broker orchestration: discovery, identity, qualification, selection and invocation. */
export class Broker {
  private readonly idFactory: () => string;
  private readonly maxTaskLength: number;

  constructor(
    private readonly dependencies: BrokerDependencies,
    config: BrokerConfig = {},
  ) {
    this.idFactory = config.idFactory ?? (() => crypto.randomUUID());
    this.maxTaskLength = config.maxTaskLength ?? 16_384;
    if (!Number.isSafeInteger(this.maxTaskLength) || this.maxTaskLength < 1) throw new BrokerError("INVALID_REQUEST");
  }

  async findCapability(capabilities: unknown): Promise<CapabilityDescriptor[]> {
    const discovered = await discoverVerified(this.dependencies.discovery, this.dependencies.identity, capabilities);
    return discovered.candidates
      .sort((left, right) => left.provider.id.localeCompare(right.provider.id))
      .map(({ provider, candidate }) => ({
        id: provider.id,
        ...(provider.ensName ? { ensName: provider.ensName } : {}),
        capabilities: [...candidate.capabilities],
        protocol: provider.protocol,
        verified: true as const,
      }));
  }

  async useCapability(request: CapabilityRequest): Promise<CapabilityResult> {
    const validated = validateRequest(request);
    if (validated.task.length > this.maxTaskLength) throw new BrokerError("INVALID_REQUEST");
    const discovered = await discoverVerified(
      this.dependencies.discovery,
      this.dependencies.identity,
      validated.capabilities,
    );
    const selected = selectVerifiedCandidate(discovered.candidates, discovered.capabilities);
    const correlationId = this.idFactory();
    let invocation;
    try {
      invocation = await this.dependencies.invocation.invoke(selected.provider, validated, correlationId);
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError("PROVIDER_REQUEST_FAILED");
    }
    if (!invocation.payment) throw new BrokerError("PAYMENT_REQUIRED");
    return {
      provider: {
        id: selected.provider.id,
        ...(selected.provider.ensName ? { ensName: selected.provider.ensName } : {}),
        capabilities: [...selected.candidate.capabilities],
        protocol: selected.provider.protocol,
      },
      payment: invocation.payment,
      output: invocation.output,
      correlationId,
    };
  }
}

export type {
  CapabilityInvocationPort,
  InvocationResult,
  ResponsesInvocationConfig,
} from "./execution/index.ts";
export { ResponsesInvocation } from "./execution/index.ts";
export type { BrokerPaymentPort } from "./payment/index.ts";

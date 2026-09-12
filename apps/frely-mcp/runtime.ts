import type { StaticResolvedCapability } from "@frely-network/capability-resolution";
import type { Policy } from "@frely-network/hedera-x402";
import type {
  CapabilityRequest,
  CapabilityResult,
  PaymentOutcome,
  ResolvedProvider,
} from "@frely-network/shared-types";
import { isPublicHttpsUrl, type FrelyMcpConfig } from "./config.ts";
import type { FrelyNetworkClient } from "./network-client.ts";

export type FrelyMcpRuntime = {
  findCapability(capabilities: string[]): Promise<StaticResolvedCapability>;
  useCapability(request: CapabilityRequest): Promise<CapabilityResult & {
    resolutionSource: "static_allowlist";
    identityVerified: false;
  }>;
  close(): void;
};

export type FrelyMcpRuntimeOptions = {
  config: FrelyMcpConfig;
  paymentPolicy: Policy;
  networkClient: Pick<FrelyNetworkClient, "resolve">;
  createPaymentExecutor(): {
    execute(provider: ResolvedProvider, request: CapabilityRequest): Promise<PaymentOutcome>;
    close(): void;
  };
};

type PaymentExecutor = ReturnType<FrelyMcpRuntimeOptions["createPaymentExecutor"]>;

function assertVisionRequest(request: CapabilityRequest): void {
  if (request.capabilities.length !== 1 || request.capabilities[0] !== "vision") {
    throw new Error("CAPABILITY_NOT_SUPPORTED");
  }
  if (typeof request.task !== "string" || !request.task.trim()) {
    throw new Error("CAPABILITY_NOT_SUPPORTED");
  }
  const input = request.input as { image_url?: unknown } | undefined;
  if (typeof input?.image_url !== "string" || !isPublicHttpsUrl(input.image_url)) {
    throw new Error("CAPABILITY_NOT_SUPPORTED");
  }
  if (!request.payment) throw new Error("PAYMENT_DISABLED");
}

export function authorizeProvider(
  resolved: StaticResolvedCapability,
  config: FrelyMcpConfig,
  policy: Policy,
): void {
  if (
    resolved.provider.id !== config.approvedProvider.id
    || resolved.provider.endpoint !== config.approvedProvider.endpoint
    || resolved.execution.endpoint !== config.approvedExecution.endpoint
    || resolved.execution.endpoint !== policy.resourceUrl
    || resolved.payment.resource !== policy.resourceUrl
    || resolved.provider.protocol !== "responses"
    || resolved.execution.managedBy !== "network"
    || resolved.resolution.source !== "static_allowlist"
    || resolved.resolution.identityVerified !== false
    || resolved.payment.network !== "hedera:testnet"
    || policy.network !== "hedera:testnet"
  ) throw new Error("PROVIDER_NOT_AUTHORIZED");
}

function toResolvedProvider(resolved: StaticResolvedCapability): ResolvedProvider {
  return {
    id: resolved.provider.id,
    endpoint: resolved.execution.endpoint,
    protocol: "responses",
    verified: false,
    authorizationSource: "static_allowlist",
  };
}

export function createFrelyMcpRuntime(options: FrelyMcpRuntimeOptions): FrelyMcpRuntime {
  let executor: PaymentExecutor | undefined;
  return {
    findCapability(capabilities) {
      return options.networkClient.resolve(capabilities);
    },
    async useCapability(request) {
      assertVisionRequest(request);
      const resolved = await options.networkClient.resolve(request.capabilities);
      authorizeProvider(resolved, options.config, options.paymentPolicy);
      executor ??= options.createPaymentExecutor();
      const paymentOutcome = await executor.execute(toResolvedProvider(resolved), request);
      return {
        provider: { id: resolved.provider.id },
        resolutionSource: "static_allowlist",
        identityVerified: false,
        paymentOutcome,
        ...(paymentOutcome.evidence?.network ? {
          payment: {
            network: paymentOutcome.evidence.network,
            ...(paymentOutcome.evidence.transactionId ? { transactionId: paymentOutcome.evidence.transactionId } : {}),
          },
        } : {}),
        output: paymentOutcome.output,
      };
    },
    close() {
      executor?.close();
      executor = undefined;
    },
  };
}

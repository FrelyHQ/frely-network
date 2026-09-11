import type { ResolvedCapability } from "@frely-network/capability-resolution";
import type { Policy } from "@frely-network/hedera-x402";
import type {
  CapabilityRequest,
  CapabilityResult,
  PaymentOutcome,
  ResolvedProvider,
} from "@frely-network/shared-types";
import type { FrelyMcpConfig } from "./config.ts";
import type { FrelyNetworkClient } from "./network-client.ts";

export type FrelyMcpRuntime = {
  findCapability(capabilities: string[]): Promise<ResolvedCapability>;
  useCapability(request: CapabilityRequest): Promise<CapabilityResult & {
    identityVerificationSource: "frely-network";
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
  let image: URL;
  try {
    image = new URL(typeof input?.image_url === "string" ? input.image_url : "");
  } catch {
    throw new Error("CAPABILITY_NOT_SUPPORTED");
  }
  if (!["https:", "http:"].includes(image.protocol) || image.username || image.password) {
    throw new Error("CAPABILITY_NOT_SUPPORTED");
  }
  if (!request.payment) throw new Error("PAYMENT_DISABLED");
}

function authorizeProvider(
  resolved: ResolvedCapability,
  config: FrelyMcpConfig,
  policy: Policy,
): void {
  if (
    resolved.provider.id !== config.approvedProviderId ||
    resolved.provider.endpoint !== policy.resourceUrl ||
    resolved.provider.protocol !== "responses" ||
    resolved.identity.chainId !== config.network.chainId ||
    resolved.identity.registry.toLowerCase() !== config.network.registry.toLowerCase() ||
    resolved.payment.network !== "hedera:testnet" ||
    policy.network !== "hedera:testnet"
  ) {
    throw new Error("PROVIDER_NOT_AUTHORIZED");
  }
}

function toResolvedProvider(resolved: ResolvedCapability): ResolvedProvider {
  return {
    id: resolved.provider.id,
    ensName: resolved.provider.ensName,
    endpoint: resolved.provider.endpoint,
    protocol: resolved.provider.protocol,
    verified: resolved.identity.verified,
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
        provider: { id: resolved.provider.id, ensName: resolved.provider.ensName },
        identityVerificationSource: "frely-network",
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

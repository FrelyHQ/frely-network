import type { CapabilityRequest, CapabilityResult, PaymentOutcome, ProviderCandidate, ResolvedProvider } from "@frely-network/shared-types";

export function createBroker(ports: {
  findProviders(capabilities: string[]): Promise<ProviderCandidate[]>;
  resolveProvider(candidate: ProviderCandidate): Promise<ResolvedProvider>;
  execute(provider: ResolvedProvider, request: CapabilityRequest): Promise<unknown>;
  executePaid?(provider: ResolvedProvider, request: CapabilityRequest): Promise<PaymentOutcome>;
  paymentEnabled?: boolean;
}) {
  return {
    async useCapability(request: CapabilityRequest): Promise<CapabilityResult> {
      if (request.payment && request.maxAmount !== undefined) throw new Error("BUDGET_INPUT_CONFLICT");
      if (ports.paymentEnabled) {
        if (!request.payment && request.maxAmount !== undefined) throw new Error("LEGACY_BUDGET_UNSUPPORTED");
        if (!request.payment) throw new Error("BUDGET_INVALID");
      } else if (request.payment) {
        throw new Error("PAYMENT_DISABLED");
      }
      const candidates = await ports.findProviders(request.capabilities);
      const matching = candidates.filter((candidate) => request.capabilities.every((value) => candidate.capabilities.includes(value)));
      const key = (candidate: ProviderCandidate) => `${candidate.ensName?.toLowerCase() ?? ""}\0${candidate.id}`;
      matching.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
      const selected = matching[0];
      if (!selected) throw new Error("NO_PROVIDER");
      const provider = await ports.resolveProvider(selected);
      if (provider.verified !== true || provider.id !== selected.id || provider.ensName !== selected.ensName) throw new Error("IDENTITY_VERIFICATION_FAILED");
      if (provider.protocol !== "responses") throw new Error("PROTOCOL_NOT_SUPPORTED");
      let endpoint: URL;
      try { endpoint = new URL(provider.endpoint); } catch { throw new Error("ENDPOINT_NOT_HTTPS"); }
      if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("ENDPOINT_NOT_HTTPS");
      if (request.payment) {
        if (!ports.executePaid) throw new Error("PAYMENT_DISABLED");
        const paymentOutcome = await ports.executePaid(provider, request);
        const evidence = paymentOutcome.paymentStatus === "settled" ? paymentOutcome.evidence : null;
        return {
          provider: { id: provider.id, ...(provider.ensName ? { ensName: provider.ensName } : {}) },
          paymentOutcome,
          ...(evidence?.network ? { payment: { network: evidence.network, ...(evidence.transactionId ? { transactionId: evidence.transactionId } : {}) } } : {}),
          output: paymentOutcome.output ?? null,
        };
      }
      const output = await ports.execute(provider, request);
      return { provider: { id: provider.id, ...(provider.ensName ? { ensName: provider.ensName } : {}) }, output };
    },
  };
}

export { createFrelyExecutor } from "./execution/index.ts";
export { parseFrelyResponse } from "./execution/response.ts";
export { createPaidExecutor } from "./payment/index.ts";

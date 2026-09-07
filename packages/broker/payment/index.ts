import { createPaymentSession, type PaymentOutcome, type Policy, type Ports } from "@frely-network/hedera-x402";
import type { CapabilityRequest, ResolvedProvider } from "@frely-network/shared-types";
import { prepareFrelyRequest, type ExecutionConfig } from "../execution/request.ts";

export function createPaidExecutor({ policy, ports, executionConfig }: { policy: Policy; ports: Ports; executionConfig: ExecutionConfig }) {
  if (!policy.enabled) throw new Error("PAYMENT_DISABLED");
  const session = createPaymentSession(policy, ports);
  return async (provider: ResolvedProvider, request: CapabilityRequest): Promise<PaymentOutcome> => {
    if (!request.payment) throw new Error("BUDGET_INVALID");
    return session.execute(prepareFrelyRequest(executionConfig, provider, request));
  };
}

/** A provider returned by live discovery before identity resolution. */
export interface ProviderCandidate {
  id: string;
  ensName?: string;
  capabilities: string[];
  supportsX402: boolean;
  reputation?: number;
}

/** A provider whose identity and execution endpoint have been verified. */
export interface ResolvedProvider {
  id: string;
  ensName?: string;
  endpoint: string;
  protocol: "responses" | "mcp" | "http";
  verified: boolean;
  authorizationSource?: "identity_verified" | "static_allowlist";
}

/** A capability request accepted by the Broker MCP layer. */
export interface CapabilityRequest {
  capabilities: string[];
  task: string;
  input?: unknown;
  maxAmount?: string;
  payment?: PaymentInput;
}

export interface PaymentInput {
  requestId: string;
  budget: { network: string; asset: string; maxAmountAtomic: string };
  acceptIndex?: number;
}

export interface PaymentEvidence {
  source: "synthetic" | "testnet";
  network?: string;
  asset?: string;
  amountAtomic?: string;
  payer?: string;
  payTo?: string;
  transactionId?: string;
  signedDigest?: string;
  verificationUrl?: string;
  verifiedAt?: string;
  consensusTimestamp?: string;
}

export interface PaymentOutcome {
  requestId: string | null;
  decision: "prepared" | "blocked" | "completed" | "paused";
  paymentStatus: "not_paid" | "unknown" | "settled";
  serviceStatus: "not_started" | "unknown" | "succeeded" | "failed";
  reason: string;
  retryAction: "none" | "query_original";
  evidence: PaymentEvidence | null;
  output: unknown | null;
}

/** The result returned after provider execution and optional payment. */
export interface CapabilityResult {
  provider: {
    id: string;
    ensName?: string;
  };
  payment?: {
    network: string;
    transactionId?: string;
  };
  paymentOutcome?: PaymentOutcome;
  output: unknown;
}

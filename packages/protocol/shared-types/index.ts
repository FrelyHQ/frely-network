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
}

/** A capability request accepted by the Broker MCP layer. */
export interface CapabilityRequest {
  capabilities: string[];
  task: string;
  input?: unknown;
  maxAmount?: string;
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
  output: unknown;
}

/** Stable protocol values shared by the Network admission boundary and its consumers. */
export const A2A_PROTOCOL_VERSION = "frely.a2a.v1" as const;
export const A2A_TASK_KIND = "model.inference" as const;
export const A2A_PAYMENT_CONTRACT_VERSION = "frely.payment-admission.v1" as const;
export const A2A_PAYMENT_SCHEME = "exact" as const;
export const A2A_PAYMENT_NETWORK = "hedera:testnet" as const;

export interface A2APaymentRequirementsRequest {
  readonly resource: string;
  readonly method: "POST";
  readonly requestHash: string;
}

/** Opaque x402 requirement text. Network owns its encoding and verification. */
export interface A2APaymentChallenge {
  readonly contractVersion: typeof A2A_PAYMENT_CONTRACT_VERSION;
  readonly scheme: typeof A2A_PAYMENT_SCHEME;
  readonly network: typeof A2A_PAYMENT_NETWORK;
  readonly requirementRevision: string;
  readonly resource: string;
  readonly paymentRequired: string;
  readonly expiresAt: string;
}

export interface A2APaymentVerifyRequest extends A2APaymentRequirementsRequest {
  readonly requestId: string;
  readonly idempotencyKeyHash: string;
  /** Opaque proof; only the payment verifier may inspect it. */
  readonly proof: string;
}

export type A2APaymentReplayStatus = "fresh" | "replayed";

/** Allowlisted scalar facts returned from Network to Relay after verification. */
export interface A2APaymentAdmission {
  readonly contractVersion: typeof A2A_PAYMENT_CONTRACT_VERSION;
  readonly paymentReference: string;
  readonly requirementRevision: string;
  readonly scheme: typeof A2A_PAYMENT_SCHEME;
  readonly payerReference: string;
  readonly network: typeof A2A_PAYMENT_NETWORK;
  readonly asset: string;
  readonly authorizedAmount: string;
  readonly verifiedAt: string;
  readonly expiresAt: string;
  readonly replayStatus: A2APaymentReplayStatus;
}

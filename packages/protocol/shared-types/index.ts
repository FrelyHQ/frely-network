/** A provider returned by live discovery before identity resolution. */
export interface ProviderCandidate {
  id: string;
  ensName?: string;
  capabilities: string[];
  /** Native service declaration; Network payment is enforced separately even when false. */
  supportsX402: boolean;
  reputation?: number;
}

/** A provider whose identity and execution endpoint have been verified. */
export interface ResolvedProvider {
  id: string;
  ensName?: string;
  /** Verified Frely A2A execution URL, never the Network payment ingress or Card URL. */
  endpoint: string;
  protocol: "a2a";
  agentCardUrl: string;
  a2aProtocolVersion: "0.3.0" | "1.0";
  verified: boolean;
}

/** A capability request accepted by the Network A2A orchestration layer. */
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

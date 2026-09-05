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

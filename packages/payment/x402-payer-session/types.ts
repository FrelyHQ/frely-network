import type { PaymentRequirement } from "@frely-network/hedera-x402";

export type PaymentStatus = "not_paid" | "unknown" | "settled";
export type ServiceStatus = "not_started" | "unknown" | "succeeded" | "failed";
export type RetryAction = "none" | "query_original";

export type JournalPhase =
  | "new"
  | "challenged"
  | "signed"
  | "paid_dispatch_started"
  | "settled"
  | "service_succeeded"
  | "service_failed"
  | "unknown";

export type PayerPolicy = {
  network: "hedera:testnet";
  asset: string;
  amountAtomic: string;
  maxAmountAtomic: string;
  payerAccountId: string;
  payTo: string;
  feePayer: string;
  facilitatorUrl: string;
  resourceUrl: string;
  walletDirectory: string;
  journalPath: string;
  maxTimeoutSeconds: number;
};

export type PayerExecuteInput = {
  requestId: string;
  providerId: string;
  method: "POST";
  resourceUrl: string;
  body: Uint8Array;
  maxAmountAtomic: string;
};

export type PayerSessionResult = {
  requestId: string;
  paymentStatus: PaymentStatus;
  serviceStatus: ServiceStatus;
  retryAction: RetryAction;
  transactionId?: string;
  output?: unknown;
};

export type SignedPayment = {
  paymentHeader: string;
  transactionId: string;
  payloadDigest: string;
};

export type PayerSessionPorts = {
  fetch(request: Request): Promise<Response>;
  sign(input: {
    requirement: PaymentRequirement;
    resourceUrl: string;
    bodySha256: string;
  }): Promise<SignedPayment>;
  verifyOriginal(input: {
    transactionId: string;
    payloadDigest: string;
    requirement: PaymentRequirement;
  }): Promise<"settled" | "pending" | "failed">;
};

export type JournalRecord = {
  requestId: string;
  fingerprint: string;
  phase: JournalPhase;
  policyJson: string;
  transactionId: string | null;
  payloadDigest: string | null;
  paymentStatus: PaymentStatus;
  serviceStatus: ServiceStatus;
  responseDigest: string | null;
  outputJson: string | null;
  quoteJson: string | null;
  createdAt: string;
  updatedAt: string;
};

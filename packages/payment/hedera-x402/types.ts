import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";

export type { PaymentPayload, PaymentRequired, PaymentRequirements };

export type AtomicBudget = {
  network: string;
  asset: string;
  maxAmountAtomic: string;
};

export type PaymentInput = {
  requestId: string;
  budget: AtomicBudget;
  acceptIndex?: number;
};

export type Policy = {
  enabled: boolean;
  network: "hedera:testnet";
  asset: string;
  assetDecimals: number;
  amountAtomic: string;
  payerAccountId: string;
  payTo: string;
  feePayers: string[];
  facilitatorUrl: string;
  resourceUrl: string;
  journalPath: string;
  mirrorNodeUrl: string;
  signerRef: string;
  keyType: "ecdsa" | "ed25519";
  credentialRef: string;
};

export type Captured402 = {
  status: number;
  paymentRequiredHeader: string;
};

export type PreparedRequest = {
  method: "POST";
  url: string;
  body: string;
  headers: Record<string, string>;
  providerId: string;
  payment: PaymentInput;
};

export type PaymentEvidence = {
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
};

export type PaymentOutcome = {
  requestId: string | null;
  decision: "prepared" | "blocked" | "completed" | "paused";
  paymentStatus: "not_paid" | "unknown" | "settled";
  serviceStatus: "not_started" | "unknown" | "succeeded" | "failed";
  reason: string;
  retryAction: "none" | "query_original";
  evidence: PaymentEvidence | null;
  output: unknown | null;
};

export type Selection = {
  required: PaymentRequired;
  requirements: PaymentRequirements;
  acceptIndex: number;
};

export type LocalPreflight =
  | {
      requestId: string;
      decision: "prepared";
      paymentStatus: "not_paid";
      serviceStatus: "not_started";
      reason: "DRY_RUN_ONLY";
      retryAction: "none";
      evidence: null;
      output: null;
      selection: Selection;
    }
  | {
      requestId: string | null;
      decision: "blocked";
      paymentStatus: "not_paid";
      serviceStatus: "not_started";
      reason: string;
      retryAction: "none";
      evidence: null;
      output: null;
    };

export type RecoveryPolicy = Pick<
  Policy,
  | "network"
  | "asset"
  | "assetDecimals"
  | "payerAccountId"
  | "payTo"
  | "feePayers"
  | "facilitatorUrl"
  | "resourceUrl"
  | "mirrorNodeUrl"
  | "credentialRef"
>;
export type JournalPhase =
  | "admitted"
  | "quote-intent"
  | "quoted"
  | "authorized"
  | "signed"
  | "dispatch-intent"
  | "captured"
  | "finished"
  | "closed-before-payment";
export type JournalRecord = {
  requestId: string;
  fingerprint: string;
  phase: JournalPhase;
  phaseBeforeFinish: JournalPhase | null;
  policy: RecoveryPolicy;
  dispatched: boolean;
  required: PaymentRequired | null;
  quote: PaymentRequirements | null;
  evidence: PaymentEvidence | null;
  outcome: PaymentOutcome | null;
  serviceStatus: PaymentOutcome["serviceStatus"];
  output: unknown | null;
  outputDigest: string | null;
  outputExpiresAt: number | null;
  responseTransaction: string | null;
  responseConflict: boolean;
};
export interface Journal {
  claimRun(): string;
  heartbeat(token: string): void;
  releaseRun(token: string): void;
  isRunActive(): boolean;
  beforeDispatch(requestId: string, token?: string): JournalRecord;
  admit(
    requestId: string,
    fingerprint: string,
    policy: RecoveryPolicy,
  ): { fresh: boolean; record: JournalRecord };
  read(requestId: string): JournalRecord | null;
  update(
    requestId: string,
    change: Partial<
      Omit<JournalRecord, "requestId" | "fingerprint" | "policy">
    >,
    token?: string,
  ): JournalRecord;
  close(): void;
}
export type SignedPayment = {
  payload: PaymentPayload;
  transactionId: string;
  signedDigest: string;
};
export type Verification =
  | { verified: true; evidence: PaymentEvidence }
  | { verified: false; reason: string };
export type Ports = {
  fetcher: (request: Request) => Promise<Response>;
  sign: (selection: Selection) => Promise<SignedPayment>;
  checkNetwork: (selection: Selection) => Promise<void>;
  verify: (
    evidence: PaymentEvidence,
    responseTransaction?: string,
  ) => Promise<Verification>;
  parseService: (response: Response) => Promise<unknown>;
  journal: Journal;
  source: "synthetic" | "testnet";
  now: () => number;
};

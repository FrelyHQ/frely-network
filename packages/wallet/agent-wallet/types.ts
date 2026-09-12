export type Limits = { maxFeeTinybar: string; reserveTinybar: string };

export type Wallet = {
  schemaVersion: 1;
  network: 'hedera:testnet';
  keyType: 'ecdsa';
  publicKey: string;
  evmAddress: string;
  signerRef: string;
  accountId: string | null;
  verifiedAt: string | null;
};

export type Intent = {
  transactionId: string;
  bodyDigest: string;
  submittedAt: string;
};

export type Evidence = {
  transactionId: string;
  consensusTimestamp: string;
  chargedFeeTinybar: string;
  verificationUrl: string;
};

export type State = {
  workflowId: 'agent-wallet-init';
  runId: string;
  limits: Limits;
  phase: 'LocalReady' | 'AwaitFunding' | 'InspectAccount' | 'Activate' | 'Verify' | 'Ready' | 'Blocked';
  intent: Intent | null;
  evidence: Evidence | null;
  reason: string | null;
};

export type Snapshot = { wallet: Wallet; state: State };

export type Identity = {
  network: 'hedera:testnet';
  payerAccountId: string;
  keyType: 'ecdsa';
  signerRef: string;
  reserveTinybar: string;
};

export type Outcome = {
  status: 'ready' | 'waiting_funds' | 'activation_unknown' | 'paused' | 'blocked';
  exitCode: 0 | 2 | 3;
  reason: string | null;
  walletPath: string;
  verifiedAt: string | null;
  paymentIdentity: Identity | null;
};

export type Progress = {
  kind: 'funding' | 'phase';
  walletPath: string;
  evmAddress: string;
  balanceTinybar: string;
  requiredTinybar: string;
  deficitTinybar: string;
  limits: Limits;
  phase: State['phase'];
};

export type Options = {
  network: 'hedera:testnet';
  walletDir: string;
  limits?: Limits;
};

export type Account = {
  accountId: string;
  evmAddress: string;
  publicKey: string | null;
  balanceTinybar: string;
  memo: string;
};

export type TransactionCheck =
  | { kind: 'success'; evidence: Evidence }
  | { kind: 'unknown' }
  | { kind: 'failed'; reason: string };

export type PreparedActivation = { intent: Intent; submit(): Promise<void> };

export type ChainPort = {
  account(wallet: Wallet, signal: AbortSignal): Promise<Account | null>;
  prepare(wallet: Wallet, limits: Limits): Promise<PreparedActivation>;
  transaction(
    intent: Intent,
    wallet: Wallet,
    limits: Limits,
    signal: AbortSignal,
  ): Promise<TransactionCheck>;
  close(): void;
};

export type InitPorts = {
  chain: ChainPort;
  now(): number;
  delay(ms: number): Promise<void>;
  progress(event: Progress): void;
};

export type AgentWalletDescriptor = {
  version: 1;
  network: "hedera:testnet";
  accountId: string;
  keyType: "ecdsa";
  publicKey: string;
  privateKeyRef: string;
};

export type HederaKeySigner = {
  accountId: string;
  publicKey: string;
  loadPrivateKey(): Promise<string>;
};

export type ReadOnlyAccount = {
  accountId: string;
  evmAddress: string;
  balanceTinybar: string;
};

import { initLocalWallet } from "./local-wallet.ts";
import type { AgentWalletDescriptor } from "./types.ts";

export async function initAgentWallet(input: {
  directory: string;
  network: "hedera:testnet";
}): Promise<AgentWalletDescriptor> {
  return initLocalWallet(input);
}

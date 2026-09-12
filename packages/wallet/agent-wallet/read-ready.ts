import { readWalletFiles } from "./local-wallet.ts";
import type { AgentWalletDescriptor } from "./types.ts";

export async function readReadyAgentWallet(
  directory: string,
): Promise<AgentWalletDescriptor> {
  return (await readWalletFiles(directory)).descriptor;
}

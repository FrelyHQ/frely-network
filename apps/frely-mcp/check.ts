import { PayerJournal } from "@frely-network/x402-payer-session";
import { readReadyAgentWallet } from "@frely-network/agent-wallet";
import type { StaticResolveResult } from "@frely-network/capability-resolution";
import { loadFrelyMcpConfig, resolveEnvReference, type Environment } from "./config.ts";
import { FrelyNetworkClient, assertAuthorized } from "./network-client.ts";

export type CheckResult = {
  status: "ready" | "blocked";
  findReady: boolean;
  useReady: boolean;
  providerId: string;
  reason: string | null;
};

export async function checkFrelyMcp(configPath: string, ports: {
  environment?: Environment;
  resolve?: (capabilities: string[]) => Promise<StaticResolveResult>;
  forbiddenSideEffect?: () => never;
} = {}): Promise<CheckResult> {
  let providerId = "unknown";
  try {
    const config = await loadFrelyMcpConfig(configPath);
    providerId = config.approvedProvider.id;
    resolveEnvReference(config.network.apiKeyRef, ports.environment ?? process.env);
    const resolved = ports.resolve
      ? await ports.resolve(["vision"])
      : await new FrelyNetworkClient(config, { environment: ports.environment }).resolve(["vision"]);
    assertAuthorized(resolved, config);
    if (!config.payment?.livePaymentEnabled) {
      return { status: "ready", findReady: true, useReady: false, providerId, reason: "PAYMENT_DISABLED" };
    }
    const wallet = await readReadyAgentWallet(config.payment.walletDirectory);
    if (wallet.network !== config.payment.network) throw new Error("WALLET_NOT_READY");
    const journal = new PayerJournal(config.payment.journalPath);
    journal.close();
    return { status: "ready", findReady: true, useReady: true, providerId, reason: null };
  } catch (error) {
    const reason = error instanceof Error && [
      "CONFIG_INVALID",
      "NETWORK_UNAVAILABLE",
      "PROVIDER_NOT_AUTHORIZED",
      "WALLET_NOT_READY",
      "JOURNAL_UNAVAILABLE",
    ].includes(error.message) ? error.message : "EXECUTION_FAILED";
    return { status: "blocked", findReady: false, useReady: false, providerId, reason };
  }
}

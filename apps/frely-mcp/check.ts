import { readReadyWalletIdentity, type Identity } from "@frely-network/agent-wallet";
import { parseResolvedCapability, type ResolvedCapability } from "@frely-network/capability-resolution";
import { loadApprovedPaymentConfig, type Policy } from "@frely-network/hedera-x402";
import { loadFrelyMcpConfig, resolveSecret, type FrelyMcpConfig } from "./config.ts";
import { FrelyNetworkClient } from "./network-client.ts";

export type CheckResult = {
  status: "ready" | "blocked";
  paymentEnabled: boolean;
  providerId: string;
  reason: string | null;
};

export type CheckPorts = {
  networkResolve?: (capabilities: string[]) => Promise<unknown>;
  relayFetch?: (request: Request) => Promise<Response>;
  sign?: () => Promise<never>;
};

const known = new Set([
  "CONFIG_INVALID",
  "CONFIG_INCOMPLETE",
  "WALLET_NOT_READY",
  "NETWORK_UNAVAILABLE",
  "PROVIDER_NOT_AUTHORIZED",
  "IDENTITY_VERIFICATION_FAILED",
  "NO_PROVIDER",
  "CAPABILITY_NOT_SUPPORTED",
  "UNAUTHORIZED",
  "INVALID_REQUEST",
]);

function blocked(providerId: string, paymentEnabled: boolean, reason: string): CheckResult {
  return { status: "blocked", paymentEnabled, providerId, reason };
}

function assertWalletMatchesPolicy(identity: Identity, policy: Policy): void {
  if (
    identity.network !== policy.network ||
    identity.payerAccountId !== policy.payerAccountId ||
    identity.signerRef !== policy.signerRef ||
    identity.keyType !== policy.keyType
  ) {
    throw new Error("WALLET_NOT_READY");
  }
}

function assertProviderMatches(config: FrelyMcpConfig, policy: Policy, resolved: ResolvedCapability): void {
  if (resolved.provider.id !== config.approvedProviderId || resolved.provider.endpoint !== policy.resourceUrl) {
    throw new Error("PROVIDER_NOT_AUTHORIZED");
  }
}

async function resolveOnce(config: FrelyMcpConfig, ports?: CheckPorts): Promise<ResolvedCapability> {
  if (ports?.networkResolve) return parseResolvedCapability(await ports.networkResolve(["vision"]));
  return new FrelyNetworkClient(config.network).resolve(["vision"]);
}

// 只读：不打开 journal、不调用 Relay、不签名；disabled profile 不得改成 enabled。
export async function checkFrelyMcp(configPath: string, ports?: CheckPorts): Promise<CheckResult> {
  const config = await loadFrelyMcpConfig(configPath);
  let paymentEnabled = false;
  try {
    resolveSecret(config.network.apiKeyRef);
    resolveSecret(config.relay.apiKeyRef);
    const identity = await readReadyWalletIdentity(config.walletDir);
    const policy = await loadApprovedPaymentConfig(config.paymentConfigPath, config.paymentRegistryPath);
    paymentEnabled = policy.enabled;
    assertWalletMatchesPolicy(identity, policy);
    const resolved = await resolveOnce(config, ports);
    assertProviderMatches(config, policy, resolved);
    return { status: "ready", paymentEnabled: policy.enabled, providerId: resolved.provider.id, reason: null };
  } catch (error) {
    const reason = error instanceof Error && known.has(error.message) ? error.message : "EXECUTION_FAILED";
    return blocked(config.approvedProviderId, paymentEnabled, reason);
  }
}

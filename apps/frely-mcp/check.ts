import { readReadyWalletIdentity, type Identity } from "@frely-network/agent-wallet";
import { parseStaticResolvedCapability, type StaticResolvedCapability } from "@frely-network/capability-resolution";
import { loadApprovedPaymentConfig, type Policy } from "@frely-network/hedera-x402";
import { loadFrelyMcpConfig, resolveSecret, type FrelyMcpConfig } from "./config.ts";
import { FrelyNetworkClient } from "./network-client.ts";
import { authorizeProvider } from "./runtime.ts";


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
  "STATIC_PROVIDER_NOT_CONFIGURED",
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

async function resolveOnce(config: FrelyMcpConfig, ports?: CheckPorts): Promise<StaticResolvedCapability> {
  if (ports?.networkResolve) return parseStaticResolvedCapability(await ports.networkResolve(["vision"]));
  return new FrelyNetworkClient(config).resolve(["vision"]);
}

// 只读：读取 Network secret、Ready wallet、付款 policy 并本地 resolve。
// 不打开 journal、不调用 execution endpoint 或 Relay、不签名。
export async function checkFrelyMcp(configPath: string, ports?: CheckPorts): Promise<CheckResult> {
  const config = await loadFrelyMcpConfig(configPath);
  let paymentEnabled = false;
  try {
    resolveSecret(config.network.apiKeyRef);
    const identity = await readReadyWalletIdentity(config.walletDir);
    const policy = await loadApprovedPaymentConfig(config.paymentConfigPath, config.paymentRegistryPath);
    paymentEnabled = policy.enabled;
    assertWalletMatchesPolicy(identity, policy);
    const resolved = await resolveOnce(config, ports);
    authorizeProvider(resolved, config, policy);
    return { status: "ready", paymentEnabled: policy.enabled, providerId: resolved.provider.id, reason: null };
  } catch (error) {
    const reason = error instanceof Error && known.has(error.message) ? error.message : "EXECUTION_FAILED";
    return blocked(config.approvedProvider.id, paymentEnabled, reason);
  }
}

import { isIP } from "node:net";
import { createHederaSigner } from "@frely-network/agent-wallet";
import type { StaticResolveResult } from "@frely-network/capability-resolution";
import {
  PayerSession,
  signPayerQuote,
  type PayerExecuteInput,
  type PayerPolicy,
  type PayerSessionResult,
} from "@frely-network/x402-payer-session";
import type { FrelyMcpConfig } from "./config.ts";
import { assertAuthorized, FrelyNetworkClient } from "./network-client.ts";

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u;

export type StaticCapabilityUseResult = {
  requestId: string;
  provider: { id: string };
  resolution: { source: "static_allowlist"; identityVerified: false };
  payment: { status: "not_paid" | "unknown" | "settled"; network: "hedera:testnet"; transactionId?: string };
  service: { status: "not_started" | "unknown" | "succeeded" | "failed" };
  retryAction: "none" | "query_original";
  output?: unknown;
};

export type CapabilityUseInput = {
  requestId: string;
  capabilities: ["vision"];
  task: string;
  input: { image_url: string };
  maxAmountAtomic: string;
};

export type FrelyMcpRuntime = {
  findCapability(capabilities: string[]): Promise<StaticResolveResult>;
  useCapability(input: CapabilityUseInput): Promise<StaticCapabilityUseResult>;
  close(): void;
};

type Session = { execute(input: PayerExecuteInput): Promise<PayerSessionResult> };
type NetworkClient = Pick<FrelyNetworkClient, "resolve"> & Partial<Pick<FrelyNetworkClient, "execute">>;

export function createFrelyMcpRuntime(options: {
  config: FrelyMcpConfig;
  networkClient?: NetworkClient;
  createSession?: () => Promise<Session>;
}): FrelyMcpRuntime {
  const client = options.networkClient ?? new FrelyNetworkClient(options.config);
  let session: Promise<Session> | undefined;
  let closed = false;

  return {
    async findCapability(capabilities) {
      if (closed) throw new Error("EXECUTION_FAILED");
      return client.resolve(capabilities);
    },
    async useCapability(input) {
      if (closed) throw new Error("EXECUTION_FAILED");
      assertUseInput(input);
      const payment = options.config.payment;
      if (!payment?.livePaymentEnabled) throw new Error("PAYMENT_DISABLED");
      const resolved = await client.resolve(input.capabilities);
      assertAuthorized(resolved, options.config);
      session ??= options.createSession
        ? options.createSession()
        : createDefaultSession(options.config, client);
      const body = new TextEncoder().encode(JSON.stringify({
        model: resolved.provider.id,
        stream: false,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: input.task.trim() },
            { type: "input_image", image_url: input.input.image_url },
          ],
        }],
      }));
      const result = await (await session).execute({
        requestId: input.requestId,
        providerId: resolved.provider.id,
        method: "POST",
        resourceUrl: resolved.execution.endpoint,
        body,
        maxAmountAtomic: input.maxAmountAtomic,
      });
      return publicResult(resolved, result);
    },
    close() {
      closed = true;
      session = undefined;
    },
  };
}

async function createDefaultSession(config: FrelyMcpConfig, client: NetworkClient): Promise<Session> {
  const payment = config.payment;
  if (!payment?.livePaymentEnabled || !client.execute) throw new Error("PAYMENT_DISABLED");
  let signer: ReturnType<typeof createHederaSigner> | undefined;
  const policy: PayerPolicy = {
    network: payment.network,
    asset: payment.asset,
    amountAtomic: payment.amountAtomic,
    maxAmountAtomic: payment.amountAtomic,
    payerAccountId: payment.payerAccountId,
    payTo: payment.payTo,
    feePayer: payment.feePayer,
    facilitatorUrl: payment.facilitatorUrl,
    resourceUrl: config.approvedExecution.resourceUrl,
    walletDirectory: payment.walletDirectory,
    journalPath: payment.journalPath,
    maxTimeoutSeconds: payment.maxTimeoutSeconds,
  };
  return new PayerSession(policy, {
    fetch: (request) => client.execute!(request),
    sign: async (input) => {
      signer ??= createHederaSigner({ directory: payment.walletDirectory, accountId: payment.payerAccountId });
      return signPayerQuote({
        ...input,
        policy,
        privateKey: await (await signer).loadPrivateKey(),
      });
    },
    verifyOriginal: async () => "pending",
  });
}

function assertUseInput(input: CapabilityUseInput): void {
  if (
    !input ||
    !REQUEST_ID.test(input.requestId) ||
    input.capabilities.length !== 1 ||
    input.capabilities[0] !== "vision" ||
    typeof input.task !== "string" ||
    input.task.trim().length < 1 ||
    input.task.length > 8192 ||
    !publicImageUrl(input.input?.image_url) ||
    typeof input.maxAmountAtomic !== "string" ||
    !/^[1-9][0-9]*$/u.test(input.maxAmountAtomic)
  ) throw new Error("INVALID_REQUEST");
}

function publicImageUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.+$/u, "");
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      host !== "localhost" &&
      !host.endsWith(".local") &&
      isIP(host.replace(/^\[|\]$/gu, "")) === 0
    );
  } catch {
    return false;
  }
}

function publicResult(resolved: StaticResolveResult, result: PayerSessionResult): StaticCapabilityUseResult {
  return {
    requestId: result.requestId,
    provider: { id: resolved.provider.id },
    resolution: { source: "static_allowlist", identityVerified: false },
    payment: {
      status: result.paymentStatus,
      network: "hedera:testnet",
      ...(result.transactionId ? { transactionId: result.transactionId } : {}),
    },
    service: { status: result.serviceStatus },
    retryAction: result.retryAction,
    ...(result.output !== undefined ? { output: result.output } : {}),
  };
}

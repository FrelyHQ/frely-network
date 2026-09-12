import type { PaymentPayload, PaymentRequired, PaymentRequirement } from "@frely-network/hedera-x402";
import {
  FileX402AttemptStore,
  UpfrontX402Gateway,
  type X402GatewaySettler,
  type X402GatewayVerifier,
} from "@frely-network/x402-gateway";
import { parseStaticNetworkConfig, resolveEnvReference, type StaticNetworkConfig } from "./config.ts";
import { createStaticNetworkFetch } from "./service.ts";
import { createStaticCapabilityResolver } from "./static-resolver.ts";
import { createRelayUpstream, type RelayFetcher } from "./upstream.ts";

type Environment = Readonly<Record<string, string | undefined>>;

export type StaticNetworkRuntime = {
  fetch(request: Request): Promise<Response>;
  host: "127.0.0.1";
  port: number;
  close(): void;
};

export type StaticNetworkRuntimeOptions = {
  environment?: Environment;
  fetcher?: RelayFetcher;
  gatewayPorts?: {
    verifier: X402GatewayVerifier;
    settler: X402GatewaySettler;
  };
};

export function createStaticNetworkRuntime(
  input: StaticNetworkConfig,
  options: StaticNetworkRuntimeOptions = {},
): StaticNetworkRuntime {
  const config = parseStaticNetworkConfig(input);
  const environment = options.environment ?? process.env;
  const apiKey = resolveEnvReference(config.auth.apiKeyRef, environment);
  const relayKey = resolveEnvReference(config.auth.relayKeyRef, environment);
  const fetcher = options.fetcher ?? ((request: Request) => fetch(request));
  const ports = options.gatewayPorts ?? createRemoteFacilitatorPorts(config.payment.facilitatorUrl, fetcher);
  const attemptStore = new FileX402AttemptStore(config.payment.attemptStorePath);
  const requirements: PaymentRequired = {
    x402Version: 2,
    resource: { url: config.payment.resourceUrl },
    accepts: [{
      scheme: "exact",
      network: config.payment.network,
      amount: config.payment.amountAtomic,
      asset: config.payment.asset,
      payTo: config.payment.payTo,
      maxTimeoutSeconds: 60,
      extra: { feePayer: config.payment.feePayer },
    }],
  };
  const gateway = new UpfrontX402Gateway({
    network: config.payment.network,
    verifier: ports.verifier,
    settler: ports.settler,
    attemptStore,
  });
  const resolver = createStaticCapabilityResolver({
    providerId: config.provider.id,
    relayUrl: config.provider.relayUrl,
    resourceUrl: config.payment.resourceUrl,
  });
  const upstream = createRelayUpstream({ url: config.provider.relayUrl, apiKey: relayKey }, fetcher);
  const handler = createStaticNetworkFetch({
    apiKey,
    expectedModel: config.provider.id,
    ready: true,
    requirements,
    resolver,
    gateway,
    upstream,
  });

  return {
    fetch: handler,
    host: config.listen.hostname,
    port: config.listen.port,
    close: () => attemptStore.close(),
  };
}

function createRemoteFacilitatorPorts(baseUrl: string, fetcher: RelayFetcher): {
  verifier: X402GatewayVerifier;
  settler: X402GatewaySettler;
} {
  return {
    verifier: {
      async verify(payload, requirement) {
        const body = await facilitatorCall(baseUrl, "verify", payload, requirement, fetcher);
        return {
          isValid: body.isValid === true,
          ...(typeof body.payer === "string" ? { payer: body.payer } : {}),
        };
      },
    },
    settler: {
      async settle(payload, requirement) {
        const body = await facilitatorCall(baseUrl, "settle", payload, requirement, fetcher);
        return {
          success: body.success === true,
          network: typeof body.network === "string" ? body.network : "",
          ...(typeof body.transaction === "string" ? { transaction: body.transaction } : {}),
          ...(typeof body.payer === "string" ? { payer: body.payer } : {}),
        };
      },
    },
  };
}

async function facilitatorCall(
  baseUrl: string,
  operation: "verify" | "settle",
  paymentPayload: PaymentPayload,
  paymentRequirements: PaymentRequirement,
  fetcher: RelayFetcher,
): Promise<Record<string, unknown>> {
  const endpoint = new URL(operation, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const response = await fetcher(new Request(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  }));
  if (response.redirected || !response.ok) throw new Error("FACILITATOR_UNAVAILABLE");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 1024 * 1024) throw new Error("FACILITATOR_UNAVAILABLE");
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("FACILITATOR_UNAVAILABLE");
  return value as Record<string, unknown>;
}

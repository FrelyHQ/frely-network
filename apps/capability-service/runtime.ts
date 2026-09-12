import {
  createNetworkX402Gate,
  readNetworkX402Config,
  type NetworkX402Gate,
  type NetworkX402GateConfig,
} from "@frely-network/x402-gateway";
import { createCapabilityServiceFetch } from "./service.ts";
import { createStaticCapabilityResolver } from "./static-resolver.ts";
import { createRelayUpstream, type RelayFetcher } from "./upstream.ts";

type Environment = Record<string, string | undefined>;

export type CapabilityServiceRuntime = {
  fetch: ReturnType<typeof createCapabilityServiceFetch>;
  host: string;
  port: string;
};

function required(environment: Environment, name: keyof Environment): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error("SERVICE_CONFIG_INVALID");
  return value;
}

export function createCapabilityServiceRuntime(
  environment: Environment = process.env,
  options: {
    facilitator?: NetworkX402GateConfig["facilitator"];
    fetch?: RelayFetcher;
  } = {},
): CapabilityServiceRuntime {
  const mode = required(environment, "FRELY_NETWORK_MODE");
  const providerId = required(environment, "FRELY_STATIC_PROVIDER_ID");
  const endpoint = required(environment, "FRELY_STATIC_PROVIDER_ENDPOINT");
  const executionEndpoint = required(environment, "FRELY_NETWORK_EXECUTION_URL");
  const apiKey = required(environment, "FRELY_SERVICE_API_KEY");
  if (mode !== "static-local") throw new Error("SERVICE_CONFIG_INVALID");
  if (providerId !== "frely-vision-basic") throw new Error("STATIC_PROVIDER_NOT_CONFIGURED");
  if (endpoint !== "https://api.frely.cloud/v1/responses") {
    throw new Error("STATIC_PROVIDER_NOT_CONFIGURED");
  }
  if (executionEndpoint !== "http://127.0.0.1:13600/v1/responses") {
    throw new Error("STATIC_PROVIDER_NOT_CONFIGURED");
  }
  const host = environment.HOST?.trim() || "127.0.0.1";
  const port = environment.PORT?.trim() || "13600";
  // 静态 MVP 只绑定 loopback 13600，拒绝 0.0.0.0 和其他端口。
  if (host !== "127.0.0.1" || port !== "13600") throw new Error("SERVICE_CONFIG_INVALID");
  const x402 = readNetworkX402Config(environment);
  const relayUrl = required(environment, "FRELY_UPSTREAM_RELAY_URL");
  const relayApiKey = required(environment, "FRELY_RELAY_API_KEY");
  if (relayUrl !== "https://api.frely.cloud/v1/responses") {
    throw new Error("UPSTREAM_NOT_CONFIGURED");
  }
  const resolver = createStaticCapabilityResolver({
    providerId,
    endpoint,
    executionEndpoint,
  });
  const upstream = createRelayUpstream({ url: relayUrl, apiKey: relayApiKey }, options.fetch);
  let gatePromise: Promise<NetworkX402Gate> | undefined;
  const x402Gate: NetworkX402Gate = {
    async admit(request, body) {
      if (!gatePromise) {
        const pending = createNetworkX402Gate({
          ...x402,
          ...(options.facilitator ? { facilitator: options.facilitator } : {}),
        });
        const tracked = pending.catch((error: unknown) => {
          if (gatePromise === tracked) gatePromise = undefined;
          throw error;
        });
        gatePromise = tracked;
      }
      return (await gatePromise).admit(request, body);
    },
  };

  return {
    fetch: createCapabilityServiceFetch({ apiKey, resolver, x402Gate, upstream }),
    host,
    port,
  };
}

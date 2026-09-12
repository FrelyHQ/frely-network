import { createCapabilityServiceFetch } from "./service.ts";
import { createStaticCapabilityResolver } from "./static-resolver.ts";

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
  const resolver = createStaticCapabilityResolver({
    providerId,
    endpoint,
    executionEndpoint,
  });

  return {
    fetch: createCapabilityServiceFetch({ apiKey, resolver }),
    host,
    port,
  };
}

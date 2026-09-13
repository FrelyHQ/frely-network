import { createConsumerGatewayFromEnv } from "./consumer/service.ts";
import { createBrokerRuntimeFromEnv } from "./runtime.ts";
import { createFrelyX402ResponsesHandlerFromEnv } from "./frely-x402-resource.ts";
import { createBrokerMcpFetch } from "./service.ts";

function port(value: string | undefined): number {
  if (value === undefined) return 4100;
  if (!/^\d+$/u.test(value)) throw new Error("PORT_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error("PORT_INVALID");
  return parsed;
}

const hostname = process.env.HOST?.trim() || "127.0.0.1";
const runtime = createBrokerRuntimeFromEnv();
const x402Responses = process.env.ENABLE_INBOUND_X402 === "true"
  ? createFrelyX402ResponsesHandlerFromEnv()
  : undefined;
const brokerMcpFetch = createBrokerMcpFetch(runtime, {
  ...(x402Responses === undefined ? {} : { x402Responses }),
  requireX402Responses: false,
  consumerGateway: createConsumerGatewayFromEnv(runtime),
  requireConsumerAuthorization: true,
  staticRoot: process.env.FRELY_NETWORK_SITE_ROOT || "/app/site",
});
const server = Bun.serve({
  hostname,
  port: port(process.env.PORT),
  fetch: brokerMcpFetch,
});

console.log(JSON.stringify({
  event: "broker_mcp_started",
  hostname: server.hostname,
  port: server.port,
  x402Responses: x402Responses === undefined ? "not_configured" : "configured",
}));

import { createFixtureHederaX402AdmissionVerifier } from "@frely-network/hedera-x402";
import { createX402PaymentAdmissionHandler } from "@frely-network/x402-gateway";
import { createBrokerMcpFetch } from "./service.ts";

function port(value: string | undefined): number {
  if (value === undefined) return 4100;
  if (!/^\d+$/u.test(value)) throw new Error("PORT_INVALID");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT_INVALID");
  }
  return parsed;
}

const hostname = process.env.HOST?.trim() || "127.0.0.1";
const paymentAdmission = process.env.FRELY_NETWORK_A2A_PAYMENT_FIXTURE === "1"
  ? createX402PaymentAdmissionHandler({
    verifier: createFixtureHederaX402AdmissionVerifier(),
    ...(process.env.FRELY_NETWORK_RELAY_API_KEY ? { apiKey: process.env.FRELY_NETWORK_RELAY_API_KEY } : {}),
  })
  : undefined;
const server = Bun.serve({
  hostname,
  port: port(process.env.PORT),
  fetch: createBrokerMcpFetch({ paymentAdmission }),
});

console.log(JSON.stringify({
  event: "broker_mcp_started",
  hostname: server.hostname,
  port: server.port,
}));

import { createBrokerRuntimeFromEnv } from "./runtime.ts";
import {
  createFixtureHederaX402AdmissionVerifier,
  createHederaX402FacilitatorFromConfig,
  createLiveHederaX402AdmissionVerifier,
} from "@frely-network/hedera-x402";
import {
  A2A_PAYMENT_CONTRACT_VERSION,
  A2A_PAYMENT_NETWORK,
  A2A_PAYMENT_SCHEME,
  type A2APaymentRequirementsRequest,
} from "@frely-network/shared-types";
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
const runtime = createBrokerRuntimeFromEnv();
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`PAYMENT_ADMISSION_CONFIG_MISSING:${name}`);
  return value;
}

function livePaymentVerifier() {
  const paymentRequired = required("FRELY_NETWORK_A2A_PAYMENT_REQUIRED");
  const requirementRevision = required("FRELY_NETWORK_A2A_PAYMENT_REVISION");
  const quoteReference = required("FRELY_NETWORK_A2A_QUOTE_REFERENCE");
  const maximumChargeUnits = required("FRELY_NETWORK_A2A_MAX_AMOUNT");
  const expirySeconds = Number(process.env.FRELY_NETWORK_A2A_QUOTE_EXPIRY_SECONDS ?? "300");
  if (!Number.isSafeInteger(expirySeconds) || expirySeconds < 1 || expirySeconds > 86_400) {
    throw new Error("PAYMENT_ADMISSION_QUOTE_EXPIRY_INVALID");
  }
  const facilitator = createHederaX402FacilitatorFromConfig(
    required("X402_FACILITATOR_ACCOUNT_ID"),
    required("X402_FACILITATOR_PRIVATE_KEY"),
  );
  return createLiveHederaX402AdmissionVerifier({
    facilitator,
    requirements: async (input: A2APaymentRequirementsRequest) => {
      const expiresAt = new Date(Date.now() + expirySeconds * 1_000).toISOString();
      return {
        contractVersion: A2A_PAYMENT_CONTRACT_VERSION,
        scheme: A2A_PAYMENT_SCHEME,
        network: A2A_PAYMENT_NETWORK,
        requirementRevision,
        resource: input.resource,
        paymentRequired,
        chargeQuote: {
          quoteReference,
          billingUnit: "usd_micro",
          maximumChargeUnits,
          expiresAt,
        },
        expiresAt,
      };
    },
  });
}

const paymentAdmission = process.env.FRELY_NETWORK_A2A_PAYMENT_FIXTURE === "1"
  ? createX402PaymentAdmissionHandler({
    verifier: createFixtureHederaX402AdmissionVerifier(),
    ...(process.env.FRELY_NETWORK_RELAY_API_KEY ? { apiKey: process.env.FRELY_NETWORK_RELAY_API_KEY } : {}),
  })
  : createX402PaymentAdmissionHandler({
    verifier: livePaymentVerifier(),
    ...(process.env.FRELY_NETWORK_RELAY_API_KEY ? { apiKey: process.env.FRELY_NETWORK_RELAY_API_KEY } : {}),
  });
runtime.paymentReady = paymentAdmission !== undefined;
const brokerMcpFetch = createBrokerMcpFetch(runtime, {
  ...(paymentAdmission === undefined ? {} : { paymentAdmission }),
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
}));

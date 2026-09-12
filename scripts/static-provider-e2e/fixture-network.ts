import { appendFileSync } from "node:fs";
import { inspectHederaTransaction } from "@x402/hedera";
import { parseStaticNetworkConfig } from "../../apps/static-network/config.ts";
import { createStaticNetworkRuntime } from "../../apps/static-network/runtime.ts";

const rawConfig = process.env.FIXTURE_CONFIG_JSON;
const relayFixtureUrl = process.env.FIXTURE_RELAY_URL;
const eventPath = process.env.FIXTURE_EVENT_PATH;
if (!rawConfig || !relayFixtureUrl || !eventPath) throw new Error("FIXTURE_CONFIG_INVALID");
const config = parseStaticNetworkConfig(JSON.parse(rawConfig));
const counters = { challenges: 0, proofs: 0, verifies: 0, settlements: 0, externalPayment: 0 };
const event = (name: string) => appendFileSync(eventPath, `${name}\n`, { encoding: "utf8", mode: 0o600 });

const runtime = createStaticNetworkRuntime(config, {
  environment: {
    FRELY_NETWORK_API_KEY: process.env.FRELY_NETWORK_API_KEY,
    FRELY_RELAY_API_KEY: process.env.FRELY_RELAY_API_KEY,
  },
  gatewayPorts: {
    verifier: {
      async verify() {
        counters.verifies += 1;
        event("verify");
        return { isValid: true, payer: "0.0.111" };
      },
    },
    settler: {
      async settle(payload) {
        counters.settlements += 1;
        event("settle");
        const transaction = payload.payload.transaction;
        if (typeof transaction !== "string") return { success: false, network: "hedera:testnet" };
        return {
          success: true,
          network: "hedera:testnet",
          transaction: inspectHederaTransaction(transaction).transactionId,
          payer: "0.0.111",
        };
      },
    },
  },
  fetcher: async (request) => {
    if (request.url !== config.provider.relayUrl) {
      counters.externalPayment += 1;
      throw new Error("EXTERNAL_REQUEST_FORBIDDEN");
    }
    return fetch(new Request(relayFixtureUrl, {
      method: request.method,
      headers: request.headers,
      body: await request.arrayBuffer(),
      redirect: "error",
      signal: request.signal,
    }));
  },
});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: config.listen.port,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/__state") return Response.json(counters);
    if (request.method === "POST" && url.pathname === "/v1/responses") {
      const paid = request.headers.has("PAYMENT-SIGNATURE") || request.headers.has("X-PAYMENT");
      if (paid) {
        counters.proofs += 1;
        event("sign");
      } else {
        counters.challenges += 1;
        event("challenge");
      }
      const body = await request.clone().text();
      const response = await runtime.fetch(request);
      if (paid && body.includes("drop-response")) {
        return Response.json({ code: "SIMULATED_RESPONSE_LOSS" }, { status: 504 });
      }
      return response;
    }
    return runtime.fetch(request);
  },
});

process.stdout.write(`${JSON.stringify({ ready: true, port: server.port })}\n`);
const close = () => {
  server.stop(true);
  runtime.close();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);

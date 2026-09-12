import { expect, test } from "bun:test";
import staticSuccess from "../../packages/protocol/capability-resolution/fixtures/static-success-v2.json";
import { parseStaticResolvedCapability } from "@frely-network/capability-resolution";
import { createCapabilityServiceFetch } from "./service.ts";

const v2Body = JSON.stringify({
  schemaVersion: 2,
  capabilities: ["vision"],
  paymentNetwork: "hedera:testnet",
});

function resolveRequest(init?: RequestInit): Request {
  return new Request("https://network.example/v1/capabilities/resolve", {
    method: "POST",
    ...init,
  });
}

test("rejects missing bearer before parsing the resolve body", async () => {
  const fetcher = createCapabilityServiceFetch({
    apiKey: "network-secret",
    resolver: { resolve: async () => parseStaticResolvedCapability(staticSuccess) },
  });
  const denied = await fetcher(resolveRequest({
    headers: { "content-type": "application/json" },
    body: v2Body,
  }));
  expect(denied.status).toBe(401);
  expect(await denied.json()).toEqual({ code: "UNAUTHORIZED" });
});

test("rejects v1 resolve requests and returns the static v2 provider", async () => {
  const fetcher = createCapabilityServiceFetch({
    apiKey: "network-secret",
    resolver: { resolve: async () => parseStaticResolvedCapability(staticSuccess) },
  });
  const headers = { authorization: "Bearer network-secret", "content-type": "application/json" };
  const v1 = await fetcher(resolveRequest({
    headers,
    body: JSON.stringify({ schemaVersion: 1, capabilities: ["vision"], paymentNetwork: "hedera:testnet" }),
  }));
  expect(v1.status).toBe(400);
  expect(await v1.json()).toEqual({ code: "INVALID_REQUEST" });

  const v2 = await fetcher(resolveRequest({ headers, body: v2Body }));
  expect(v2.status).toBe(200);
  expect(await v2.json()).toEqual(staticSuccess);
  expect((await fetcher(new Request("https://network.example/mcp", { method: "POST" }))).status).toBe(404);
});

test("permits only health, readiness, and authenticated resolve routes without caching", async () => {
  const fetcher = createCapabilityServiceFetch({
    apiKey: "network-secret",
    resolver: { resolve: async () => parseStaticResolvedCapability(staticSuccess) },
  });

  for (const request of [
    new Request("https://network.example/healthz"),
    new Request("https://network.example/readyz"),
  ]) {
    const response = await fetcher(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }

  const response = await fetcher(new Request("https://network.example/v1/capabilities/resolve"));
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
});

test("rejects non-JSON, malformed, invalid, and oversized resolve requests", async () => {
  const fetcher = createCapabilityServiceFetch({
    apiKey: "network-secret",
    resolver: { resolve: async () => parseStaticResolvedCapability(staticSuccess) },
  });
  const headers = { authorization: "Bearer network-secret", "content-type": "application/json" };
  const requests = [
    new Request("https://network.example/v1/capabilities/resolve", { method: "POST", headers: { authorization: headers.authorization, "content-type": "text/plain" }, body: "nope" }),
    new Request("https://network.example/v1/capabilities/resolve", { method: "POST", headers, body: "{" }),
    new Request("https://network.example/v1/capabilities/resolve", { method: "POST", headers, body: JSON.stringify({ schemaVersion: 2, capabilities: [], paymentNetwork: "hedera:testnet" }) }),
    new Request("https://network.example/v1/capabilities/resolve", { method: "POST", headers, body: JSON.stringify({ schemaVersion: 2, capabilities: ["vision"], paymentNetwork: "hedera:testnet", padding: "x".repeat(65 * 1024) }) }),
  ];

  for (const request of requests) {
    const response = await fetcher(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});

test("maps resolver failures to public error codes without leaking secrets or endpoints", async () => {
  const headers = { authorization: "Bearer network-secret", "content-type": "application/json" };
  const request = () => resolveRequest({ headers, body: v2Body });

  for (const [message, status, code] of [
    ["STATIC_PROVIDER_NOT_CONFIGURED", 503, "STATIC_PROVIDER_NOT_CONFIGURED"],
    ["CAPABILITY_NOT_SUPPORTED", 422, "CAPABILITY_NOT_SUPPORTED"],
    ["https://api.frely.cloud/v1/responses?apiKey=network-secret", 500, "INTERNAL_ERROR"],
  ] as const) {
    const fetcher = createCapabilityServiceFetch({
      apiKey: "network-secret",
      resolver: { resolve: async () => { throw new Error(message); } },
    });
    const response = await fetcher(request());
    expect(response.status).toBe(status);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ code });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).not.toContain("network-secret");
    expect(body).not.toContain("https://api.frely.cloud/v1/responses");
    if (code === "INTERNAL_ERROR") expect(body).not.toContain(message);
  }
});

function responsesRequest(init?: RequestInit): Request {
  return new Request("http://127.0.0.1:13600/v1/responses", {
    method: "POST",
    ...init,
  });
}

const visionBody = JSON.stringify({ model: "gpt-5.6-luna", stream: false });

test("returns 402 from /v1/responses without calling upstream", async () => {
  let upstreamCalls = 0;
  const fetcher = createCapabilityServiceFetch({
    apiKey: "network-secret",
    resolver: { resolve: async () => parseStaticResolvedCapability(staticSuccess) },
    x402Gate: {
      admit: async () => ({
        kind: "response",
        response: new Response(null, { status: 402, headers: { "PAYMENT-REQUIRED": "quote" } }),
      }),
    },
    upstream: {
      invoke: async () => {
        upstreamCalls += 1;
        return Response.json({ output_text: "nope" });
      },
    },
  });
  const denied = await fetcher(responsesRequest({
    headers: { "content-type": "application/json", "x-frely-request-id": "request-1" },
    body: visionBody,
  }));
  expect(denied.status).toBe(401);

  const quoted = await fetcher(responsesRequest({
    headers: {
      authorization: "Bearer network-secret",
      "content-type": "application/json",
      "x-frely-request-id": "request-1",
    },
    body: visionBody,
  }));
  expect(quoted.status).toBe(402);
  expect(quoted.headers.get("PAYMENT-REQUIRED")).toBe("quote");
  expect(upstreamCalls).toBe(0);
});

test("rejects non-gpt-5.6-luna, truthy stream, and missing requestId before the gate", async () => {
  let admits = 0;
  let upstreamCalls = 0;
  const fetcher = createCapabilityServiceFetch({
    apiKey: "network-secret",
    resolver: { resolve: async () => parseStaticResolvedCapability(staticSuccess) },
    x402Gate: {
      admit: async () => {
        admits += 1;
        return { kind: "response", response: new Response(null, { status: 402 }) };
      },
    },
    upstream: {
      invoke: async () => {
        upstreamCalls += 1;
        return Response.json({ output_text: "nope" });
      },
    },
  });
  const headers = {
    authorization: "Bearer network-secret",
    "content-type": "application/json",
    "x-frely-request-id": "request-1",
  };
  for (const request of [
    responsesRequest({ headers, body: JSON.stringify({ model: "vision-basic", stream: false }) }),
    responsesRequest({ headers, body: JSON.stringify({ model: "gpt-5.6-luna", stream: true }) }),
    responsesRequest({ headers, body: JSON.stringify({ model: "gpt-5.6-luna", stream: "true" }) }),
    responsesRequest({
      headers: { authorization: headers.authorization, "content-type": "application/json" },
      body: visionBody,
    }),
  ]) {
    const response = await fetcher(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "INVALID_REQUEST" });
  }
  expect(admits).toBe(0);
  expect(upstreamCalls).toBe(0);
});

test("calls upstream only after settled admission and attaches PAYMENT-RESPONSE", async () => {
  let upstreamCalls = 0;
  const fetcher = createCapabilityServiceFetch({
    apiKey: "network-secret",
    resolver: { resolve: async () => parseStaticResolvedCapability(staticSuccess) },
    x402Gate: {
      admit: async (request) => {
        if (!request.headers.get("PAYMENT-SIGNATURE")) {
          return { kind: "response", response: new Response(null, { status: 402 }) };
        }
        return {
          kind: "settled",
          finish: async (response: Response) => {
            const headers = new Headers(response.headers);
            headers.set("PAYMENT-RESPONSE", "settled");
            return new Response(await response.arrayBuffer(), { status: response.status, headers });
          },
        };
      },
    },
    upstream: {
      invoke: async (body, requestId) => {
        upstreamCalls += 1;
        expect(JSON.parse(body)).toEqual({ model: "gpt-5.6-luna", stream: false });
        expect(requestId).toBe("request-1");
        return Response.json({ output_text: "FRELY X402 OK" });
      },
    },
  });
  const unsigned = await fetcher(responsesRequest({
    headers: {
      authorization: "Bearer network-secret",
      "content-type": "application/json",
      "x-frely-request-id": "request-1",
    },
    body: visionBody,
  }));
  expect(unsigned.status).toBe(402);
  expect(upstreamCalls).toBe(0);

  const settled = await fetcher(responsesRequest({
    headers: {
      authorization: "Bearer network-secret",
      "content-type": "application/json",
      "x-frely-request-id": "request-1",
      "PAYMENT-SIGNATURE": "signed",
    },
    body: visionBody,
  }));
  expect(settled.status).toBe(200);
  expect(settled.headers.get("PAYMENT-RESPONSE")).toBe("settled");
  expect(await settled.json()).toEqual({ output_text: "FRELY X402 OK" });
  expect(upstreamCalls).toBe(1);
});

test("maps Relay 402 after settlement to UPSTREAM_PAYMENT_UNEXPECTED", async () => {
  const fetcher = createCapabilityServiceFetch({
    apiKey: "network-secret",
    resolver: { resolve: async () => parseStaticResolvedCapability(staticSuccess) },
    x402Gate: {
      admit: async () => ({
        kind: "settled",
        finish: async (response) => response,
      }),
    },
    upstream: {
      invoke: async () => {
        throw new Error("UPSTREAM_PAYMENT_UNEXPECTED");
      },
    },
  });
  const response = await fetcher(responsesRequest({
    headers: {
      authorization: "Bearer network-secret",
      "content-type": "application/json",
      "x-frely-request-id": "request-1",
      "PAYMENT-SIGNATURE": "signed",
    },
    body: visionBody,
  }));
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ code: "UPSTREAM_PAYMENT_UNEXPECTED" });
});

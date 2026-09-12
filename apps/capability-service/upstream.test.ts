import { expect, test } from "bun:test";
import { createRelayUpstream } from "./upstream.ts";

const RELAY_URL = "https://api.frely.cloud/v1/responses";
const config = {
  url: RELAY_URL,
  apiKey: "upstream-test-key",
};
const body = JSON.stringify({
  model: "gpt-5.6-luna",
  stream: false,
  input: "ocr",
});

function createRelayCapture(response: Response) {
  let request: Request | undefined;
  return {
    get request() {
      if (!request) throw new Error("upstream was not called");
      return request;
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      request = input instanceof Request ? input.clone() : new Request(input, init);
      return response;
    },
  };
}

test("forwards no x402 or local authorization headers to Relay", async () => {
  const capture = createRelayCapture(Response.json({ output_text: "FRELY X402 OK" }));
  await createRelayUpstream(config, capture.fetch).invoke(body, "request-1");
  expect(capture.request.url).toBe(RELAY_URL);
  expect(capture.request.headers.get("authorization")).toBe("Bearer upstream-test-key");
  expect(capture.request.headers.get("content-type")).toBe("application/json");
  expect(capture.request.headers.get("accept")).toBe("application/json");
  expect(capture.request.headers.get("x-frely-request-id")).toBe("request-1");
  for (const name of [
    "PAYMENT-SIGNATURE",
    "PAYMENT-REQUIRED",
    "PAYMENT-RESPONSE",
  ]) expect(capture.request.headers.has(name)).toBe(false);
  expect(await capture.request.json()).toEqual({
    model: "gpt-5.6-luna",
    stream: false,
    input: "ocr",
  });
});

test("does not relay a second payment requirement", async () => {
  const upstream = createRelayUpstream(config, async () => new Response(null, { status: 402 }));
  await expect(upstream.invoke(body, "request-1"))
    .rejects.toThrow("UPSTREAM_PAYMENT_UNEXPECTED");
});

test("maps other non-2xx Relay responses to UPSTREAM_FAILED without leaking the body", async () => {
  const upstream = createRelayUpstream(config, async () => new Response("secret-upstream", { status: 500 }));
  await expect(upstream.invoke(body, "request-1")).rejects.toThrow("UPSTREAM_FAILED");
  try {
    await upstream.invoke(body, "request-1");
  } catch (error) {
    expect(error instanceof Error ? error.message : "").toBe("UPSTREAM_FAILED");
    expect(String(error)).not.toContain("secret-upstream");
  }
});

test("accepts only the frozen Relay responses URL", () => {
  expect(() => createRelayUpstream({
    url: "https://api.frely.cloud/v1/responses?model=vision-basic",
    apiKey: "upstream-test-key",
  })).toThrow("UPSTREAM_NOT_CONFIGURED");
  expect(() => createRelayUpstream({
    url: RELAY_URL,
    apiKey: "",
  })).toThrow("UPSTREAM_NOT_CONFIGURED");
});

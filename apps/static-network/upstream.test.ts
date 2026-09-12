import { describe, expect, test } from "bun:test";
import { createRelayUpstream } from "./upstream.ts";

describe("Relay upstream", () => {
  test("forwards only ordinary Bearer JSON and a safe request id", async () => {
    let captured: Request | undefined;
    const upstream = createRelayUpstream({
      url: "https://relay.example.com/v1/responses",
      apiKey: "relay-key",
    }, async (request) => {
      captured = request;
      return Response.json({ ok: true }, {
        headers: {
          "x-request-id": "relay-1",
          "PAYMENT-RESPONSE": "must-not-cross",
          "set-cookie": "must-not-cross",
        },
      });
    });

    const response = await upstream.invoke('{"model":"vision-provider","stream":false}', "req-1");
    expect(captured?.url).toBe("https://relay.example.com/v1/responses");
    expect(captured?.headers.get("authorization")).toBe("Bearer relay-key");
    expect(captured?.headers.get("content-type")).toBe("application/json");
    expect(captured?.headers.get("x-frely-request-id")).toBe("req-1");
    for (const header of ["PAYMENT-REQUIRED", "PAYMENT-SIGNATURE", "PAYMENT-RESPONSE", "X-PAYMENT", "x-frely-wallet"]) {
      expect(captured?.headers.has(header)).toBeFalse();
    }
    expect(response.headers.get("x-request-id")).toBe("relay-1");
    expect(response.headers.has("PAYMENT-RESPONSE")).toBeFalse();
    expect(response.headers.has("set-cookie")).toBeFalse();
  });

  test("maps network, redirect, non-success and oversized responses to UPSTREAM_FAILED", async () => {
    const fetchers = [
      async () => { throw new Error("sensitive failure"); },
      async () => new Response(null, { status: 302 }),
      async () => Response.json({ secret: "upstream detail" }, { status: 503 }),
      async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)),
    ];
    for (const fetcher of fetchers) {
      const upstream = createRelayUpstream({
        url: "https://relay.example.com/v1/responses",
        apiKey: "relay-key",
      }, fetcher);
      await expect(upstream.invoke("{}", "req-1")).rejects.toThrow("UPSTREAM_FAILED");
    }
  });

  test("rejects unsafe request ids before any network call", async () => {
    let calls = 0;
    const upstream = createRelayUpstream({ url: "https://relay.example.com/v1/responses", apiKey: "relay-key" }, async () => {
      calls += 1;
      return Response.json({ ok: true });
    });
    await expect(upstream.invoke("{}", "bad\r\nid")).rejects.toThrow("UPSTREAM_FAILED");
    expect(calls).toBe(0);
  });
});

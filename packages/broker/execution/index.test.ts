import { describe, expect, test } from "bun:test";
import { A2AServiceInvocation, ResponsesInvocation } from "./index.ts";

const provider = {
  id: "provider-1",
  ensName: "provider.capability.example.eth",
  endpoint: "https://provider.example/v1/responses",
  protocol: "responses" as const,
  verified: true as const,
};

const a2aProvider = {
  id: "provider-a2a",
  endpoint: "https://provider.example/a2a",
  protocol: "a2a" as const,
  verified: true as const,
};

describe("Responses invocation boundary", () => {
  test("sends the selected provider request through the payment port", async () => {
    let request: { url: string; body: Uint8Array; headers: Headers } | undefined;
    const invocation = new ResponsesInvocation({
      headers: { authorization: "Bearer secret-is-not-logged" },
      payment: {
        request: async (value) => {
          request = { url: value.url, body: value.body ?? new Uint8Array(), headers: new Headers(value.headers) };
          return { response: Response.json({ output: "ok" }), payment: { network: "hedera:testnet", transactionId: "tx-1" }, challenged: true };
        },
      },
    });

    const result = await invocation.invoke(provider, { capabilities: ["vision"], task: "describe", input: [{ type: "input_text", text: "describe" }] }, "corr-1");

    expect(request?.url).toBe(provider.endpoint);
    expect(request?.headers.get("x-correlation-id")).toBe("corr-1");
    expect(request?.headers.get("authorization")).toBe("Bearer secret-is-not-logged");
    expect(JSON.parse(new TextDecoder().decode(request?.body))).toEqual({ model: "vision-basic", input: [{ type: "input_text", text: "describe" }] });
    expect(result).toEqual({ output: { output: "ok" }, payment: { network: "hedera:testnet", transactionId: "tx-1" } });
  });

  test("does not accept an invocation without settlement evidence", async () => {
    const invocation = new ResponsesInvocation({
      payment: { request: async () => ({ response: Response.json({ output: "ok" }), challenged: false }) },
    });
    await expect(invocation.invoke(provider, { capabilities: ["vision"], task: "describe" }, "corr-1")).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
  });
});

describe("Frely A2A invocation boundary", () => {
  test("uses ordinary Bearer JSON-RPC and strips payment headers before calling Frely", async () => {
    let captured: { url: string; headers: Headers; body: string } | undefined;
    const invocation = new A2AServiceInvocation({
      headers: {
        authorization: "Bearer frely-api-key",
        "payment-signature": "must-not-cross",
        "x-payment": "must-not-cross",
      },
      agentId: "network-agent",
      fetcher: async (input, init) => {
        captured = {
          url: String(input),
          headers: new Headers(init?.headers),
          body: String(init?.body ?? ""),
        };
        return Response.json({
          jsonrpc: "2.0",
          id: "corr-1",
          result: {
            kind: "task",
            id: "a2a_task_1",
            status: { state: "completed" },
            artifacts: [{ artifactId: "result", parts: [{ kind: "text", text: "done" }] }],
          },
        });
      },
    });

    const result = await invocation.invoke(a2aProvider, { capabilities: ["vision"], task: "describe" }, "corr-1");

    expect(captured?.url).toBe("https://provider.example/a2a");
    expect(captured?.headers.get("authorization")).toBe("Bearer frely-api-key");
    expect(captured?.headers.get("payment-signature")).toBeNull();
    expect(captured?.headers.get("x-payment")).toBeNull();
    expect(captured?.headers.get("idempotency-key")).toBe("a2a-corr-1");
    expect(captured?.headers.get("x-a2a-agent-id")).toBe("network-agent");
    expect(JSON.parse(captured?.body ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: "corr-1",
      method: "message/send",
      params: {
        message: {
          kind: "message",
          role: "user",
          messageId: "a2a-corr-1",
          parts: [{ kind: "text", text: "describe" }],
        },
        metadata: { "frely.model": "vision-basic" },
      },
    });
    expect(result).toEqual({ output: "done" });
  });

  test("does not translate a Frely failure into chain settlement", async () => {
    const invocation = new A2AServiceInvocation({ fetcher: async () => Response.json({ code: "failed" }, { status: 503 }) });
    await expect(invocation.invoke(a2aProvider, { capabilities: ["vision"], task: "describe" }, "corr-2")).rejects.toMatchObject({ code: "PROVIDER_REQUEST_FAILED" });
  });
});

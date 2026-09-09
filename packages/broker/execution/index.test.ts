import { describe, expect, test } from "bun:test";
import { ResponsesInvocation } from "./index.ts";

const provider = {
  id: "provider-1",
  ensName: "provider.capability.example.eth",
  endpoint: "https://provider.example/v1/responses",
  protocol: "responses" as const,
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
      payment: {
        request: async () => ({ response: Response.json({ output: "ok" }), challenged: false }),
      },
    });

    await expect(invocation.invoke(provider, { capabilities: ["vision"], task: "describe" }, "corr-1")).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });
  });
});

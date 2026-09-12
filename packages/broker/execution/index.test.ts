import { describe, expect, test } from "bun:test";
import { A2AServiceInvocation, ResponsesInvocation } from "./index.ts";
import type { PaymentAuthorization } from "@frely-network/hedera-x402";

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

const authorization: PaymentAuthorization = {
  paymentPayload: {
    x402Version: 2,
    accepted: { scheme: "exact", network: "hedera:testnet", amount: "10", asset: "0.0.0", payTo: "0.0.1001", maxTimeoutSeconds: 60 },
    payload: { transaction: "opaque-in-memory" },
  },
  paymentRequirement: { scheme: "exact", network: "hedera:testnet", amount: "10", asset: "0.0.0", payTo: "0.0.1001", maxTimeoutSeconds: 60 },
};

function a2aResponse(
  status: "settled" | "released" | "pending_settlement" = "settled",
  taskStatus: "completed" | "failed" = "completed",
  httpStatus = 200,
): Response {
  return Response.json({
    protocolVersion: "frely.a2a.v1",
    task: {
      id: "a2a_task_1",
      kind: "model.inference",
      model: "vision-basic",
      status: taskStatus,
      requestId: "req_a2a_1",
      ...(taskStatus === "completed" ? { message: { role: "assistant", parts: [{ kind: "text", text: "done" }] } } : { errorCode: "provider_failed" }),
    },
    payment: {
      status,
      paymentReference: "hedera:proof:abc123",
      billingUnit: "usd_micro",
      maximumChargeUnits: "100",
      authorizedAmount: "10",
      ...(status === "settled" ? { finalChargeUnits: "60", releasedChargeUnits: "40" } : {}),
      ...(status === "released" ? { finalChargeUnits: "0", releasedChargeUnits: "100" } : {}),
    },
  }, { status: httpStatus, headers: { "content-type": "application/json" } });
}

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

describe("A2A service invocation boundary", () => {
  test("posts the canonical A2A task and settles the transient x402 authorization", async () => {
    let request: { url: string; body: Uint8Array; headers: Headers } | undefined;
    let settled = 0;
    let released = 0;
    const invocation = new A2AServiceInvocation({
      headers: { authorization: "Bearer secret-is-not-logged" },
      payment: {
        request: async (value) => {
          request = { url: value.url, body: value.body ?? new Uint8Array(), headers: new Headers(value.headers) };
          return { response: a2aResponse(), authorization, challenged: true };
        },
      },
      settlement: {
        settle: async () => {
          settled += 1;
          return { network: "hedera:testnet", status: "settled", transactionId: "tx-settle" };
        },
        release: async () => {
          released += 1;
          return { network: "hedera:testnet", status: "released", transactionId: "tx-release" };
        },
      },
    });

    const result = await invocation.invoke(a2aProvider, { capabilities: ["vision"], task: "describe" }, "corr-1");

    expect(request?.url).toBe("https://provider.example/a2a/tasks");
    expect(request?.headers.get("authorization")).toBe("Bearer secret-is-not-logged");
    expect(request?.headers.get("idempotency-key")).toBe("a2a-corr-1");
    expect(JSON.parse(new TextDecoder().decode(request?.body))).toEqual({
      protocolVersion: "frely.a2a.v1",
      kind: "model.inference",
      model: "vision-basic",
      message: { role: "user", parts: [{ kind: "text", text: "describe" }] },
    });
    expect(settled).toBe(1);
    expect(released).toBe(1);
    expect(result).toEqual({
      output: "done",
      payment: {
        network: "hedera:testnet",
        status: "settled",
        paymentReference: "hedera:proof:abc123",
        billingUnit: "usd_micro",
        maximumChargeUnits: "100",
        authorizedAmount: "10",
        finalChargeUnits: "60",
        releasedChargeUnits: "40",
        transactionId: "tx-settle",
      },
    });
  });

  test("does not report chain settlement when only the Relay projection is available", async () => {
    const invocation = new A2AServiceInvocation({
      payment: { request: async () => ({ response: a2aResponse(), authorization, challenged: true }) },
      requireSettlement: false,
    });
    const result = await invocation.invoke(a2aProvider, { capabilities: ["vision"], task: "describe" }, "corr-2");
    expect(result.payment?.status).toBe("pending_settlement");
  });

  test("does not broadcast or refund an uncharged failed A2A task", async () => {
    let released = 0;
    const invocation = new A2AServiceInvocation({
      payment: { request: async () => ({ response: a2aResponse("released", "failed"), authorization, challenged: true }) },
      settlement: {
        settle: async () => ({ network: "hedera:testnet", status: "settled", transactionId: "never" }),
        release: async () => {
          released += 1;
          return { network: "hedera:testnet", status: "released", transactionId: "tx-release" };
        },
      },
    });
    await expect(invocation.invoke(a2aProvider, { capabilities: ["vision"], task: "describe" }, "corr-3")).rejects.toMatchObject({ code: "PROVIDER_REQUEST_FAILED" });
    expect(released).toBe(0);
  });

  test("settles a charged failed task before surfacing a non-2xx provider response", async () => {
    let settled = 0;
    let released = 0;
    const invocation = new A2AServiceInvocation({
      payment: { request: async () => ({ response: a2aResponse("settled", "failed", 500), authorization, challenged: true }) },
      settlement: {
        settle: async () => {
          settled += 1;
          return { network: "hedera:testnet", status: "settled", transactionId: "tx-settle" };
        },
        release: async () => {
          released += 1;
          return { network: "hedera:testnet", status: "released", transactionId: "tx-release" };
        },
      },
    });

    await expect(invocation.invoke(a2aProvider, { capabilities: ["vision"], task: "describe" }, "corr-4")).rejects.toMatchObject({ code: "PROVIDER_REQUEST_FAILED" });
    expect(settled).toBe(1);
    expect(released).toBe(1);
  });
});

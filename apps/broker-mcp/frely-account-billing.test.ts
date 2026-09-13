import { describe, expect, test } from "bun:test";
import { FrelyAccountBillingClient } from "./frely-account-billing.ts";

describe("Frely account billing client", () => {
  test("uses the account API key without creating a payment header", async () => {
    let captured: RequestInit | undefined;
    const client = new FrelyAccountBillingClient("frely-key", async (_url, init) => {
      captured = init;
      return new Response(JSON.stringify({ output: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await client.request({
      method: "POST",
      url: "https://api.frely.cloud/v1/responses",
      headers: { "x-payment": "must-not-send", "content-type": "application/json" },
      body: new TextEncoder().encode("{}"),
    });

    expect(result.challenged).toBe(false);
    expect(result.payment).toBeUndefined();
    const headers = new Headers(captured?.headers);
    expect(headers.get("authorization")).toBe("Bearer frely-key");
    expect(headers.get("x-payment")).toBeNull();
    expect(headers.get("payment-signature")).toBeNull();
  });

  test("rejects an empty API key", () => {
    expect(() => new FrelyAccountBillingClient(" ")).toThrow("FRELY_API_KEY_INVALID");
  });
});

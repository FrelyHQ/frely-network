import { describe, expect, test } from "bun:test";
import { NETWORK_WEB2_PURCHASE_CONTRACT_VERSION } from "@frely-network/web2-fulfillment-contract";
import { FrelyWeb2FulfillmentClient } from "./index.ts";

const token = "n".repeat(48);
const intent = {
  contractVersion: NETWORK_WEB2_PURCHASE_CONTRACT_VERSION,
  intentId: "intent_1",
  product: { productId: "plan_1", productVersion: "3", productKind: "plan", ownerKind: "frely_owned" },
  recipient: { frelyUserId: "user_1" },
  payment: { network: "hedera-testnet", asset: "USDC", amountAtomic: "8000000", payeeReference: "0.0.9001" },
  createdAt: "2026-09-15T03:00:00.000Z",
  expiresAt: "2026-09-15T03:15:00.000Z",
} as const;

const skillIntent = {
  ...intent,
  intentId: "intent_skill_1",
  product: { productId: "skill_1", productVersion: "2", productKind: "official_skill", ownerKind: "frely_owned" },
  payment: { ...intent.payment, amountAtomic: "2500000" },
} as const;

function response(value: unknown, status = 200): Response { return Response.json(value, { status }); }

describe("FrelyWeb2FulfillmentClient", () => {
  test("creates a Relay-issued purchase intent without sending amount or payee", async () => {
    let body: Record<string, unknown> | undefined;
    const client = new FrelyWeb2FulfillmentClient({ origin: "https://frely.example", token }, async (url, init) => {
      expect(url).toBe("https://frely.example/api/internal/network/web2-purchases/intents");
      expect(new Headers(init.headers).get("x-frely-network-token")).toBe(token);
      body = JSON.parse(String(init.body));
      return response(intent, 201);
    });
    expect(await client.createPlanPurchaseIntent({ planId: "plan_1", planVersion: "3", recipientFrelyUserId: "user_1" })).toEqual(intent);
    expect(body).toEqual({ planId: "plan_1", planVersion: "3", recipientFrelyUserId: "user_1" });
  });

  test("creates an official Skill intent through the dedicated endpoint without amount or recipient override", async () => {
    let body: Record<string, unknown> | undefined;
    const client = new FrelyWeb2FulfillmentClient({ origin: "https://frely.example", token }, async (url, init) => {
      expect(url).toBe("https://frely.example/api/internal/network/web2-purchases/official-skill-intents");
      body = JSON.parse(String(init.body));
      return response(skillIntent, 201);
    });
    expect(await client.createOfficialSkillPurchaseIntent({ productId: "skill_1", productVersion: "2", recipientFrelyUserId: "user_1" })).toEqual(skillIntent);
    expect(body).toEqual({ productId: "skill_1", productVersion: "2", recipientFrelyUserId: "user_1" });
  });

  test("submits only the frozen intent id and settled payment evidence", async () => {
    const request = {
      contractVersion: NETWORK_WEB2_PURCHASE_CONTRACT_VERSION,
      intentId: intent.intentId,
      payment: { sourceKind: "network_purchase", purchaseId: "purchase_1", network: "hedera-testnet", asset: "USDC", amountAtomic: "8000000", transactionId: "0.0.1@123", paymentReference: "payment_1", payerReference: "0.0.7", payeeReference: "0.0.9001", settledAt: "2026-09-15T03:05:00.000Z" },
    } as const;
    const result = { contractVersion: NETWORK_WEB2_PURCHASE_CONTRACT_VERSION, intentId: intent.intentId, purchaseId: "purchase_1", product: intent.product, recipient: intent.recipient, entitlement: { entitlementId: "plan_sub_1", binding: "account_bound", entitlementKind: "plan_subscription" }, provenance: { network: "hedera-testnet", transactionId: "0.0.1@123", paymentReference: "payment_1" }, state: "fulfilled", fulfilledAt: "2026-09-15T03:05:02.000Z", replayed: false } as const;
    let sent: unknown;
    const client = new FrelyWeb2FulfillmentClient({ origin: "https://frely.example", token }, async (_url, init) => { sent = JSON.parse(String(init.body)); return response(result); });
    expect(await client.fulfill(request)).toEqual(result);
    expect(sent).toEqual(request);
  });

  test("fails closed on transport or malformed Relay responses", async () => {
    const failing = new FrelyWeb2FulfillmentClient({ origin: "https://frely.example", token }, async () => response({ error: "no" }, 401));
    await expect(failing.createPlanPurchaseIntent({ planId: "plan_1", planVersion: "3", recipientFrelyUserId: "user_1" })).rejects.toMatchObject({ code: "REQUEST_FAILED" });
    const malformed = new FrelyWeb2FulfillmentClient({ origin: "https://frely.example", token }, async () => response({ ok: true }));
    await expect(malformed.createPlanPurchaseIntent({ planId: "plan_1", planVersion: "3", recipientFrelyUserId: "user_1" })).rejects.toThrow();
  });
});

describe("settled x402 to Relay fulfillment", () => {
  test("derives asset and payee from the Relay intent and provenance from settled evidence", async () => {
    let sent: any;
    const result = { contractVersion: NETWORK_WEB2_PURCHASE_CONTRACT_VERSION, intentId: intent.intentId, purchaseId: "purchase_live_1", product: intent.product, recipient: intent.recipient, entitlement: { entitlementId: "plan_sub_live", binding: "account_bound", entitlementKind: "plan_subscription" }, provenance: { network: intent.payment.network, transactionId: "0.0.1@123", paymentReference: "payment_live_1" }, state: "fulfilled", fulfilledAt: "2026-09-15T03:05:02.000Z", replayed: false } as const;
    const client = new FrelyWeb2FulfillmentClient({ origin: "https://frely.example", token }, async (_url, init) => { sent = JSON.parse(String(init.body)); return response(result); });
    expect(await client.fulfillSettledPayment({
      intent,
      purchaseId: "purchase_live_1",
      payment: { network: intent.payment.network, status: "settled", transactionId: "0.0.1@123", paymentReference: "payment_live_1", payer: "0.0.7", authorizedAmount: intent.payment.amountAtomic },
      settledAt: "2026-09-15T03:05:00.000Z",
    })).toEqual(result);
    expect(sent.payment).toMatchObject({ asset: intent.payment.asset, payeeReference: intent.payment.payeeReference, payerReference: "0.0.7", amountAtomic: intent.payment.amountAtomic });
  });

  test("fails closed when settled evidence lacks provenance or does not match the intent", async () => {
    const client = new FrelyWeb2FulfillmentClient({ origin: "https://frely.example", token }, async () => { throw new Error("must not call"); });
    await expect(client.fulfillSettledPayment({ intent, purchaseId: "purchase_bad", payment: { network: intent.payment.network, status: "settled", transactionId: "0.0.1@bad", authorizedAmount: intent.payment.amountAtomic }, settledAt: "2026-09-15T03:05:00.000Z" })).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
    await expect(client.fulfillSettledPayment({ intent, purchaseId: "purchase_bad2", payment: { network: intent.payment.network, status: "settled", transactionId: "0.0.1@bad2", paymentReference: "p_bad", payer: "0.0.7", authorizedAmount: "1" }, settledAt: "2026-09-15T03:05:00.000Z" })).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
  });
});

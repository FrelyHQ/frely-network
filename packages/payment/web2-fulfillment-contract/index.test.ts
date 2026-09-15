import { describe, expect, test } from "bun:test";
import {
  WEB3_WEB2_PURCHASE_CONTRACT_VERSION,
  Web3Web2PurchaseContractError,
  assertWeb3Web2FulfillmentMatchesRequest,
  assertWeb3Web2PaymentMatchesIntent,
  validateWeb3Web2FulfillmentRequest,
  validateWeb3Web2FulfillmentResponse,
  validateWeb3Web2PurchaseIntent,
} from "./index.ts";

const intent = {
  contractVersion: WEB3_WEB2_PURCHASE_CONTRACT_VERSION,
  intentId: "intent:official-skill:1",
  product: { productId: "skill:research", productVersion: "v3", productKind: "official_skill", ownerKind: "frely_owned" },
  recipient: { frelyUserId: "user_123" },
  payment: { network: "hedera:testnet", asset: "USDC", amountAtomic: "8000000", payeeReference: "0.0.9001" },
  createdAt: "2026-09-15T02:00:00.000Z",
  expiresAt: "2026-09-15T02:15:00.000Z",
} as const;

const request = {
  contractVersion: WEB3_WEB2_PURCHASE_CONTRACT_VERSION,
  intentId: intent.intentId,
  payment: {
    sourceKind: "web3_purchase",
    purchaseId: "purchase:network:1",
    network: intent.payment.network,
    asset: intent.payment.asset,
    amountAtomic: intent.payment.amountAtomic,
    transactionId: "0.0.7001@1757901900.000000001",
    paymentReference: "payment:1",
    payerReference: "0.0.7001",
    payeeReference: intent.payment.payeeReference,
    settledAt: "2026-09-15T02:05:00.000Z",
  },
} as const;

describe("Web3 to Web2 fulfillment contract", () => {
  test("accepts a settled payment bound to the Relay-issued intent", () => {
    expect(validateWeb3Web2PurchaseIntent(intent)).toEqual(intent);
    expect(validateWeb3Web2FulfillmentRequest(request)).toEqual(request);
    expect(assertWeb3Web2PaymentMatchesIntent(intent, request)).toEqual({ intent, request });
  });

  test("forbids Network-side product and recipient overrides", () => {
    expect(() => validateWeb3Web2FulfillmentRequest({ ...request, product: intent.product })).toThrow(Web3Web2PurchaseContractError);
    expect(() => validateWeb3Web2FulfillmentRequest({ ...request, recipient: intent.recipient })).toThrow(Web3Web2PurchaseContractError);
  });

  test("rejects mismatched payment, expired intents and non-Frely products", () => {
    expect(() => assertWeb3Web2PaymentMatchesIntent(intent, { ...request, payment: { ...request.payment, amountAtomic: "1" } })).toThrow("WEB3_WEB2_PAYMENT_MISMATCH");
    expect(() => assertWeb3Web2PaymentMatchesIntent(intent, { ...request, payment: { ...request.payment, settledAt: intent.expiresAt } })).toThrow("WEB3_WEB2_INTENT_EXPIRED");
    expect(() => validateWeb3Web2PurchaseIntent({ ...intent, product: { ...intent.product, ownerKind: "creator_owned" } })).toThrow(Web3Web2PurchaseContractError);
  });

  test("rejects secret-like references and accepts only stable rejection codes", () => {
    expect(() => validateWeb3Web2FulfillmentRequest({ ...request, payment: { ...request.payment, paymentReference: "authorization:secretvalue" } })).toThrow(Web3Web2PurchaseContractError);
    expect(validateWeb3Web2FulfillmentResponse({
      contractVersion: WEB3_WEB2_PURCHASE_CONTRACT_VERSION,
      state: "rejected",
      code: "purchase_reused",
    })).toEqual({ contractVersion: WEB3_WEB2_PURCHASE_CONTRACT_VERSION, state: "rejected", code: "purchase_reused" });
  });

  test("requires account-bound fulfillment tied to the payment provenance", () => {
    const result = {
      contractVersion: WEB3_WEB2_PURCHASE_CONTRACT_VERSION,
      intentId: intent.intentId,
      purchaseId: request.payment.purchaseId,
      product: intent.product,
      recipient: intent.recipient,
      entitlement: { entitlementId: "entitlement:1", binding: "account_bound", entitlementKind: "official_skill_usage" },
      provenance: { network: request.payment.network, transactionId: request.payment.transactionId, paymentReference: request.payment.paymentReference },
      state: "fulfilled",
      fulfilledAt: "2026-09-15T02:06:00.000Z",
      replayed: false,
    } as const;
    expect(assertWeb3Web2FulfillmentMatchesRequest(intent, request, result)).toEqual(result);
    expect(() => assertWeb3Web2FulfillmentMatchesRequest(intent, request, { ...result, purchaseId: "purchase:other" })).toThrow("WEB3_WEB2_FULFILLMENT_MISMATCH");
  });
});

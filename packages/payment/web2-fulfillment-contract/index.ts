export const NETWORK_WEB2_PURCHASE_CONTRACT_VERSION = "frely.network-web2-purchase.v1" as const;
export const NETWORK_WEB2_PURCHASE_SOURCE_KIND = "network_purchase" as const;

export type NetworkWeb2PurchaseContractVersion = typeof NETWORK_WEB2_PURCHASE_CONTRACT_VERSION;
export type NetworkWeb2PurchaseSourceKind = typeof NETWORK_WEB2_PURCHASE_SOURCE_KIND;
export type NetworkWeb2ProductKind = "official_skill" | "plan" | "api" | "service";

export interface NetworkWeb2ProductReference {
  readonly productId: string;
  readonly productVersion: string;
  readonly productKind: NetworkWeb2ProductKind;
  readonly ownerKind: "frely_owned";
}

export interface NetworkWeb2RecipientReference {
  readonly frelyUserId: string;
}

export interface NetworkWeb2ExpectedPayment {
  readonly network: string;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly payeeReference: string;
}

export interface NetworkWeb2PurchaseIntent {
  readonly contractVersion: NetworkWeb2PurchaseContractVersion;
  readonly intentId: string;
  readonly product: NetworkWeb2ProductReference;
  readonly recipient: NetworkWeb2RecipientReference;
  readonly payment: NetworkWeb2ExpectedPayment;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface NetworkWeb2SettledPaymentEvidence {
  readonly sourceKind: NetworkWeb2PurchaseSourceKind;
  readonly purchaseId: string;
  readonly network: string;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly transactionId: string;
  readonly paymentReference: string;
  readonly payerReference: string;
  readonly payeeReference: string;
  readonly settledAt: string;
}

export interface NetworkWeb2FulfillmentRequest {
  readonly contractVersion: NetworkWeb2PurchaseContractVersion;
  readonly intentId: string;
  readonly payment: NetworkWeb2SettledPaymentEvidence;
}

export interface NetworkWeb2AccountBoundEntitlementReference {
  readonly entitlementId: string;
  readonly binding: "account_bound";
  readonly entitlementKind: string;
}

export type NetworkWeb2FulfillmentRejectionCode =
  | "contract_invalid"
  | "contract_version_unsupported"
  | "intent_not_found"
  | "intent_expired"
  | "intent_conflict"
  | "payment_not_settled"
  | "payment_mismatch"
  | "purchase_reused"
  | "product_unavailable"
  | "recipient_not_eligible"
  | "fulfillment_failed";

export interface NetworkWeb2FulfillmentResult {
  readonly contractVersion: NetworkWeb2PurchaseContractVersion;
  readonly intentId: string;
  readonly purchaseId: string;
  readonly product: NetworkWeb2ProductReference;
  readonly recipient: NetworkWeb2RecipientReference;
  readonly entitlement: NetworkWeb2AccountBoundEntitlementReference;
  readonly provenance: {
    readonly network: string;
    readonly transactionId: string;
    readonly paymentReference: string;
  };
  readonly state: "fulfilled";
  readonly fulfilledAt: string;
  readonly replayed: boolean;
}

export interface NetworkWeb2FulfillmentRejection {
  readonly contractVersion: NetworkWeb2PurchaseContractVersion;
  readonly state: "rejected";
  readonly code: NetworkWeb2FulfillmentRejectionCode;
}

export type NetworkWeb2FulfillmentResponse = NetworkWeb2FulfillmentResult | NetworkWeb2FulfillmentRejection;

export type NetworkWeb2PurchaseContractErrorCode =
  | "NETWORK_WEB2_CONTRACT_INVALID"
  | "NETWORK_WEB2_CONTRACT_VERSION_UNSUPPORTED"
  | "NETWORK_WEB2_PAYMENT_MISMATCH"
  | "NETWORK_WEB2_INTENT_EXPIRED"
  | "NETWORK_WEB2_FULFILLMENT_MISMATCH";

export class NetworkWeb2PurchaseContractError extends Error {
  constructor(readonly code: NetworkWeb2PurchaseContractErrorCode) {
    super(code);
    this.name = "NetworkWeb2PurchaseContractError";
  }
}

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/u;
const AMOUNT = /^(0|[1-9][0-9]{0,127})$/u;
const PRODUCT_KINDS = new Set<NetworkWeb2ProductKind>(["official_skill", "plan", "api", "service"]);
const REJECTION_CODES = new Set<NetworkWeb2FulfillmentRejectionCode>([
  "contract_invalid", "contract_version_unsupported", "intent_not_found", "intent_expired", "intent_conflict", "payment_not_settled", "payment_mismatch",
  "purchase_reused", "product_unavailable", "recipient_not_eligible", "fulfillment_failed",
]);
const SECRET_REFERENCE_PATTERNS = [
  /^(?:bearer|basic)[_.:/-]/iu,
  /^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{8,}$/u,
  /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9_.:/-]{8,}$/u,
  /^(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|credential|authorization)[:=_-][A-Za-z0-9_.:/@-]{8,}$/iu,
] as const;

function fail(code: NetworkWeb2PurchaseContractErrorCode): never {
  throw new NetworkWeb2PurchaseContractError(code);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("NETWORK_WEB2_CONTRACT_INVALID");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("NETWORK_WEB2_CONTRACT_INVALID");
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !REFERENCE.test(value) || SECRET_REFERENCE_PATTERNS.some((pattern) => pattern.test(value))) fail("NETWORK_WEB2_CONTRACT_INVALID");
  return value;
}

function amount(value: unknown, positive = true): string {
  if (typeof value !== "string" || !AMOUNT.test(value) || (positive && BigInt(value) <= 0n)) fail("NETWORK_WEB2_CONTRACT_INVALID");
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) fail("NETWORK_WEB2_CONTRACT_INVALID");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("NETWORK_WEB2_CONTRACT_INVALID");
  return value;
}

function version(value: unknown): NetworkWeb2PurchaseContractVersion {
  if (value !== NETWORK_WEB2_PURCHASE_CONTRACT_VERSION) fail("NETWORK_WEB2_CONTRACT_VERSION_UNSUPPORTED");
  return NETWORK_WEB2_PURCHASE_CONTRACT_VERSION;
}

function product(value: unknown): NetworkWeb2ProductReference {
  const source = object(value);
  exactKeys(source, ["productId", "productVersion", "productKind", "ownerKind"]);
  const productKind = source.productKind;
  if (typeof productKind !== "string" || !PRODUCT_KINDS.has(productKind as NetworkWeb2ProductKind) || source.ownerKind !== "frely_owned") fail("NETWORK_WEB2_CONTRACT_INVALID");
  return {
    productId: reference(source.productId),
    productVersion: reference(source.productVersion),
    productKind: productKind as NetworkWeb2ProductKind,
    ownerKind: "frely_owned",
  };
}

function recipient(value: unknown): NetworkWeb2RecipientReference {
  const source = object(value);
  exactKeys(source, ["frelyUserId"]);
  return { frelyUserId: reference(source.frelyUserId) };
}

function expectedPayment(value: unknown): NetworkWeb2ExpectedPayment {
  const source = object(value);
  exactKeys(source, ["network", "asset", "amountAtomic", "payeeReference"]);
  return {
    network: reference(source.network),
    asset: reference(source.asset),
    amountAtomic: amount(source.amountAtomic),
    payeeReference: reference(source.payeeReference),
  };
}

function settledPayment(value: unknown): NetworkWeb2SettledPaymentEvidence {
  const source = object(value);
  exactKeys(source, ["sourceKind", "purchaseId", "network", "asset", "amountAtomic", "transactionId", "paymentReference", "payerReference", "payeeReference", "settledAt"]);
  if (source.sourceKind !== NETWORK_WEB2_PURCHASE_SOURCE_KIND) fail("NETWORK_WEB2_CONTRACT_INVALID");
  return {
    sourceKind: NETWORK_WEB2_PURCHASE_SOURCE_KIND,
    purchaseId: reference(source.purchaseId),
    network: reference(source.network),
    asset: reference(source.asset),
    amountAtomic: amount(source.amountAtomic),
    transactionId: reference(source.transactionId),
    paymentReference: reference(source.paymentReference),
    payerReference: reference(source.payerReference),
    payeeReference: reference(source.payeeReference),
    settledAt: canonicalTimestamp(source.settledAt),
  };
}

export function validateNetworkWeb2PurchaseIntent(value: unknown): NetworkWeb2PurchaseIntent {
  const source = object(value);
  exactKeys(source, ["contractVersion", "intentId", "product", "recipient", "payment", "createdAt", "expiresAt"]);
  const createdAt = canonicalTimestamp(source.createdAt);
  const expiresAt = canonicalTimestamp(source.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) fail("NETWORK_WEB2_CONTRACT_INVALID");
  return {
    contractVersion: version(source.contractVersion),
    intentId: reference(source.intentId),
    product: product(source.product),
    recipient: recipient(source.recipient),
    payment: expectedPayment(source.payment),
    createdAt,
    expiresAt,
  };
}

export function validateNetworkWeb2FulfillmentRequest(value: unknown): NetworkWeb2FulfillmentRequest {
  const source = object(value);
  exactKeys(source, ["contractVersion", "intentId", "payment"]);
  return {
    contractVersion: version(source.contractVersion),
    intentId: reference(source.intentId),
    payment: settledPayment(source.payment),
  };
}

export function assertNetworkWeb2PaymentMatchesIntent(
  intentValue: unknown,
  requestValue: unknown,
): { readonly intent: NetworkWeb2PurchaseIntent; readonly request: NetworkWeb2FulfillmentRequest } {
  const intent = validateNetworkWeb2PurchaseIntent(intentValue);
  const request = validateNetworkWeb2FulfillmentRequest(requestValue);
  if (request.intentId !== intent.intentId || request.contractVersion !== intent.contractVersion) fail("NETWORK_WEB2_PAYMENT_MISMATCH");
  const settledAt = Date.parse(request.payment.settledAt);
  if (settledAt < Date.parse(intent.createdAt)) fail("NETWORK_WEB2_PAYMENT_MISMATCH");
  if (settledAt >= Date.parse(intent.expiresAt)) fail("NETWORK_WEB2_INTENT_EXPIRED");
  if (
    request.payment.network !== intent.payment.network ||
    request.payment.asset !== intent.payment.asset ||
    request.payment.amountAtomic !== intent.payment.amountAtomic ||
    request.payment.payeeReference !== intent.payment.payeeReference
  ) fail("NETWORK_WEB2_PAYMENT_MISMATCH");
  return { intent, request };
}

export function validateNetworkWeb2FulfillmentResult(value: unknown): NetworkWeb2FulfillmentResult {
  const source = object(value);
  exactKeys(source, ["contractVersion", "intentId", "purchaseId", "product", "recipient", "entitlement", "provenance", "state", "fulfilledAt", "replayed"]);
  if (source.state !== "fulfilled" || typeof source.replayed !== "boolean") fail("NETWORK_WEB2_CONTRACT_INVALID");
  const entitlementSource = object(source.entitlement);
  exactKeys(entitlementSource, ["entitlementId", "binding", "entitlementKind"]);
  if (entitlementSource.binding !== "account_bound") fail("NETWORK_WEB2_CONTRACT_INVALID");
  const provenanceSource = object(source.provenance);
  exactKeys(provenanceSource, ["network", "transactionId", "paymentReference"]);
  return {
    contractVersion: version(source.contractVersion),
    intentId: reference(source.intentId),
    purchaseId: reference(source.purchaseId),
    product: product(source.product),
    recipient: recipient(source.recipient),
    entitlement: {
      entitlementId: reference(entitlementSource.entitlementId),
      binding: "account_bound",
      entitlementKind: reference(entitlementSource.entitlementKind),
    },
    provenance: {
      network: reference(provenanceSource.network),
      transactionId: reference(provenanceSource.transactionId),
      paymentReference: reference(provenanceSource.paymentReference),
    },
    state: "fulfilled",
    fulfilledAt: canonicalTimestamp(source.fulfilledAt),
    replayed: source.replayed,
  };
}

export function assertNetworkWeb2FulfillmentMatchesRequest(
  intentValue: unknown,
  requestValue: unknown,
  resultValue: unknown,
): NetworkWeb2FulfillmentResult {
  const intent = validateNetworkWeb2PurchaseIntent(intentValue);
  const request = validateNetworkWeb2FulfillmentRequest(requestValue);
  const result = validateNetworkWeb2FulfillmentResult(resultValue);
  if (
    result.contractVersion !== intent.contractVersion ||
    result.intentId !== intent.intentId ||
    result.purchaseId !== request.payment.purchaseId ||
    result.product.productId !== intent.product.productId ||
    result.product.productVersion !== intent.product.productVersion ||
    result.product.productKind !== intent.product.productKind ||
    result.recipient.frelyUserId !== intent.recipient.frelyUserId ||
    result.provenance.network !== request.payment.network ||
    result.provenance.transactionId !== request.payment.transactionId ||
    result.provenance.paymentReference !== request.payment.paymentReference ||
    Date.parse(result.fulfilledAt) < Date.parse(request.payment.settledAt)
  ) fail("NETWORK_WEB2_FULFILLMENT_MISMATCH");
  return result;
}

export function validateNetworkWeb2FulfillmentResponse(value: unknown): NetworkWeb2FulfillmentResponse {
  const source = object(value);
  if (source.state === "fulfilled") return validateNetworkWeb2FulfillmentResult(source);
  exactKeys(source, ["contractVersion", "state", "code"]);
  if (source.state !== "rejected" || typeof source.code !== "string" || !REJECTION_CODES.has(source.code as NetworkWeb2FulfillmentRejectionCode)) {
    fail("NETWORK_WEB2_CONTRACT_INVALID");
  }
  return {
    contractVersion: version(source.contractVersion),
    state: "rejected",
    code: source.code as NetworkWeb2FulfillmentRejectionCode,
  };
}

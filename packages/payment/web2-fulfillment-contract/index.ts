export const WEB3_WEB2_PURCHASE_CONTRACT_VERSION = "frely.web3-web2-purchase.v1" as const;
export const WEB3_WEB2_PURCHASE_SOURCE_KIND = "web3_purchase" as const;

export type Web3Web2PurchaseContractVersion = typeof WEB3_WEB2_PURCHASE_CONTRACT_VERSION;
export type Web3Web2PurchaseSourceKind = typeof WEB3_WEB2_PURCHASE_SOURCE_KIND;
export type Web3Web2ProductKind = "official_skill" | "plan" | "api" | "service";

export interface Web3Web2ProductReference {
  readonly productId: string;
  readonly productVersion: string;
  readonly productKind: Web3Web2ProductKind;
  readonly ownerKind: "frely_owned";
}

export interface Web3Web2RecipientReference {
  readonly frelyUserId: string;
}

export interface Web3Web2ExpectedPayment {
  readonly network: string;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly payeeReference: string;
}

export interface Web3Web2PurchaseIntent {
  readonly contractVersion: Web3Web2PurchaseContractVersion;
  readonly intentId: string;
  readonly product: Web3Web2ProductReference;
  readonly recipient: Web3Web2RecipientReference;
  readonly payment: Web3Web2ExpectedPayment;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface Web3Web2SettledPaymentEvidence {
  readonly sourceKind: Web3Web2PurchaseSourceKind;
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

export interface Web3Web2FulfillmentRequest {
  readonly contractVersion: Web3Web2PurchaseContractVersion;
  readonly intentId: string;
  readonly payment: Web3Web2SettledPaymentEvidence;
}

export interface Web3Web2AccountBoundEntitlementReference {
  readonly entitlementId: string;
  readonly binding: "account_bound";
  readonly entitlementKind: string;
}

export type Web3Web2FulfillmentRejectionCode =
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

export interface Web3Web2FulfillmentResult {
  readonly contractVersion: Web3Web2PurchaseContractVersion;
  readonly intentId: string;
  readonly purchaseId: string;
  readonly product: Web3Web2ProductReference;
  readonly recipient: Web3Web2RecipientReference;
  readonly entitlement: Web3Web2AccountBoundEntitlementReference;
  readonly provenance: {
    readonly network: string;
    readonly transactionId: string;
    readonly paymentReference: string;
  };
  readonly state: "fulfilled";
  readonly fulfilledAt: string;
  readonly replayed: boolean;
}

export interface Web3Web2FulfillmentRejection {
  readonly contractVersion: Web3Web2PurchaseContractVersion;
  readonly state: "rejected";
  readonly code: Web3Web2FulfillmentRejectionCode;
}

export type Web3Web2FulfillmentResponse = Web3Web2FulfillmentResult | Web3Web2FulfillmentRejection;

export type Web3Web2PurchaseContractErrorCode =
  | "WEB3_WEB2_CONTRACT_INVALID"
  | "WEB3_WEB2_CONTRACT_VERSION_UNSUPPORTED"
  | "WEB3_WEB2_PAYMENT_MISMATCH"
  | "WEB3_WEB2_INTENT_EXPIRED"
  | "WEB3_WEB2_FULFILLMENT_MISMATCH";

export class Web3Web2PurchaseContractError extends Error {
  constructor(readonly code: Web3Web2PurchaseContractErrorCode) {
    super(code);
    this.name = "Web3Web2PurchaseContractError";
  }
}

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,255}$/u;
const AMOUNT = /^(0|[1-9][0-9]{0,127})$/u;
const PRODUCT_KINDS = new Set<Web3Web2ProductKind>(["official_skill", "plan", "api", "service"]);
const REJECTION_CODES = new Set<Web3Web2FulfillmentRejectionCode>([
  "contract_invalid", "contract_version_unsupported", "intent_not_found", "intent_expired", "intent_conflict", "payment_not_settled", "payment_mismatch",
  "purchase_reused", "product_unavailable", "recipient_not_eligible", "fulfillment_failed",
]);
const SECRET_REFERENCE_PATTERNS = [
  /^(?:bearer|basic)[_.:/-]/iu,
  /^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{8,}$/u,
  /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9_.:/-]{8,}$/u,
  /^(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|credential|authorization)[:=_-][A-Za-z0-9_.:/@-]{8,}$/iu,
] as const;

function fail(code: Web3Web2PurchaseContractErrorCode): never {
  throw new Web3Web2PurchaseContractError(code);
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("WEB3_WEB2_CONTRACT_INVALID");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail("WEB3_WEB2_CONTRACT_INVALID");
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !REFERENCE.test(value) || SECRET_REFERENCE_PATTERNS.some((pattern) => pattern.test(value))) fail("WEB3_WEB2_CONTRACT_INVALID");
  return value;
}

function amount(value: unknown, positive = true): string {
  if (typeof value !== "string" || !AMOUNT.test(value) || (positive && BigInt(value) <= 0n)) fail("WEB3_WEB2_CONTRACT_INVALID");
  return value;
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) fail("WEB3_WEB2_CONTRACT_INVALID");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("WEB3_WEB2_CONTRACT_INVALID");
  return value;
}

function version(value: unknown): Web3Web2PurchaseContractVersion {
  if (value !== WEB3_WEB2_PURCHASE_CONTRACT_VERSION) fail("WEB3_WEB2_CONTRACT_VERSION_UNSUPPORTED");
  return WEB3_WEB2_PURCHASE_CONTRACT_VERSION;
}

function product(value: unknown): Web3Web2ProductReference {
  const source = object(value);
  exactKeys(source, ["productId", "productVersion", "productKind", "ownerKind"]);
  const productKind = source.productKind;
  if (typeof productKind !== "string" || !PRODUCT_KINDS.has(productKind as Web3Web2ProductKind) || source.ownerKind !== "frely_owned") fail("WEB3_WEB2_CONTRACT_INVALID");
  return {
    productId: reference(source.productId),
    productVersion: reference(source.productVersion),
    productKind: productKind as Web3Web2ProductKind,
    ownerKind: "frely_owned",
  };
}

function recipient(value: unknown): Web3Web2RecipientReference {
  const source = object(value);
  exactKeys(source, ["frelyUserId"]);
  return { frelyUserId: reference(source.frelyUserId) };
}

function expectedPayment(value: unknown): Web3Web2ExpectedPayment {
  const source = object(value);
  exactKeys(source, ["network", "asset", "amountAtomic", "payeeReference"]);
  return {
    network: reference(source.network),
    asset: reference(source.asset),
    amountAtomic: amount(source.amountAtomic),
    payeeReference: reference(source.payeeReference),
  };
}

function settledPayment(value: unknown): Web3Web2SettledPaymentEvidence {
  const source = object(value);
  exactKeys(source, ["sourceKind", "purchaseId", "network", "asset", "amountAtomic", "transactionId", "paymentReference", "payerReference", "payeeReference", "settledAt"]);
  if (source.sourceKind !== WEB3_WEB2_PURCHASE_SOURCE_KIND) fail("WEB3_WEB2_CONTRACT_INVALID");
  return {
    sourceKind: WEB3_WEB2_PURCHASE_SOURCE_KIND,
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

export function validateWeb3Web2PurchaseIntent(value: unknown): Web3Web2PurchaseIntent {
  const source = object(value);
  exactKeys(source, ["contractVersion", "intentId", "product", "recipient", "payment", "createdAt", "expiresAt"]);
  const createdAt = canonicalTimestamp(source.createdAt);
  const expiresAt = canonicalTimestamp(source.expiresAt);
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) fail("WEB3_WEB2_CONTRACT_INVALID");
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

export function validateWeb3Web2FulfillmentRequest(value: unknown): Web3Web2FulfillmentRequest {
  const source = object(value);
  exactKeys(source, ["contractVersion", "intentId", "payment"]);
  return {
    contractVersion: version(source.contractVersion),
    intentId: reference(source.intentId),
    payment: settledPayment(source.payment),
  };
}

export function assertWeb3Web2PaymentMatchesIntent(
  intentValue: unknown,
  requestValue: unknown,
): { readonly intent: Web3Web2PurchaseIntent; readonly request: Web3Web2FulfillmentRequest } {
  const intent = validateWeb3Web2PurchaseIntent(intentValue);
  const request = validateWeb3Web2FulfillmentRequest(requestValue);
  if (request.intentId !== intent.intentId || request.contractVersion !== intent.contractVersion) fail("WEB3_WEB2_PAYMENT_MISMATCH");
  const settledAt = Date.parse(request.payment.settledAt);
  if (settledAt < Date.parse(intent.createdAt)) fail("WEB3_WEB2_PAYMENT_MISMATCH");
  if (settledAt >= Date.parse(intent.expiresAt)) fail("WEB3_WEB2_INTENT_EXPIRED");
  if (
    request.payment.network !== intent.payment.network ||
    request.payment.asset !== intent.payment.asset ||
    request.payment.amountAtomic !== intent.payment.amountAtomic ||
    request.payment.payeeReference !== intent.payment.payeeReference
  ) fail("WEB3_WEB2_PAYMENT_MISMATCH");
  return { intent, request };
}

export function validateWeb3Web2FulfillmentResult(value: unknown): Web3Web2FulfillmentResult {
  const source = object(value);
  exactKeys(source, ["contractVersion", "intentId", "purchaseId", "product", "recipient", "entitlement", "provenance", "state", "fulfilledAt", "replayed"]);
  if (source.state !== "fulfilled" || typeof source.replayed !== "boolean") fail("WEB3_WEB2_CONTRACT_INVALID");
  const entitlementSource = object(source.entitlement);
  exactKeys(entitlementSource, ["entitlementId", "binding", "entitlementKind"]);
  if (entitlementSource.binding !== "account_bound") fail("WEB3_WEB2_CONTRACT_INVALID");
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

export function assertWeb3Web2FulfillmentMatchesRequest(
  intentValue: unknown,
  requestValue: unknown,
  resultValue: unknown,
): Web3Web2FulfillmentResult {
  const intent = validateWeb3Web2PurchaseIntent(intentValue);
  const request = validateWeb3Web2FulfillmentRequest(requestValue);
  const result = validateWeb3Web2FulfillmentResult(resultValue);
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
  ) fail("WEB3_WEB2_FULFILLMENT_MISMATCH");
  return result;
}

export function validateWeb3Web2FulfillmentResponse(value: unknown): Web3Web2FulfillmentResponse {
  const source = object(value);
  if (source.state === "fulfilled") return validateWeb3Web2FulfillmentResult(source);
  exactKeys(source, ["contractVersion", "state", "code"]);
  if (source.state !== "rejected" || typeof source.code !== "string" || !REJECTION_CODES.has(source.code as Web3Web2FulfillmentRejectionCode)) {
    fail("WEB3_WEB2_CONTRACT_INVALID");
  }
  return {
    contractVersion: version(source.contractVersion),
    state: "rejected",
    code: source.code as Web3Web2FulfillmentRejectionCode,
  };
}

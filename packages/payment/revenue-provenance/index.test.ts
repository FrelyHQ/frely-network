import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CREATOR_REVENUE_SOURCE_KIND,
  RevenueProvenanceLedger,
  type RecordWeb3PurchaseInput,
} from "./index.ts";

const offering = {
  id: "off_alice_security_1",
  publisherId: "alice",
  publisherEnsName: "web3-safety.frely.eth",
  underlyingAgent: {
    platform: "frely",
    agentId: "vm-0123456789abcdef0123456789abcdef",
    model: "user/vm-0123456789abcdef0123456789abcdef/v1",
    version: "v1",
    ownerRef: "user:bob",
  },
  capabilities: ["web3-safety"],
  price: {
    network: "hedera:testnet",
    asset: "0.0.429274",
    amountAtomic: "1000000",
    publisherPayTo: "0.0.1234",
    networkFeeBps: 500,
  },
  status: "published",
} as const;

const purchase = (overrides: Partial<RecordWeb3PurchaseInput["payment"]> = {}): RecordWeb3PurchaseInput => ({
  purchaseId: "purchase-1",
  offering,
  payment: {
    network: "hedera:testnet",
    asset: "0.0.429274",
    amountAtomic: "1000000",
    transactionId: "0.0.2002@1757910000.000000001",
    paymentReference: "hedera:proof:0123456789abcdef",
    payerReference: "0.0.2002",
    payeeReference: "0.0.1234",
    settledAt: "2026-09-15T01:00:00.000Z",
    ...overrides,
  },
});

async function withPrivateTempDir(run: (directory: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "frely-revenue-provenance-"));
  await rm(base, { recursive: true, force: true });
  await mkdir(base, { mode: 0o700 });
  try { await run(base); } finally { await rm(base, { recursive: true, force: true }); }
}

describe("RevenueProvenanceLedger", () => {
  test("records a settled Web3 purchase and closes the Creator revenue provenance chain", () => {
    const ledger = new RevenueProvenanceLedger(":memory:", () => Date.parse("2026-09-15T01:01:00.000Z"));
    try {
      const recordedPurchase = ledger.recordWeb3Purchase(purchase());
      const revenue = ledger.recordCreatorRevenue({
        revenueId: "revenue-1",
        purchaseId: recordedPurchase.purchaseId,
        networkFeeAmountAtomic: "50000",
        creatorAmountAtomic: "950000",
      });

      expect(revenue.sourceKind).toBe(CREATOR_REVENUE_SOURCE_KIND);
      expect(revenue).toMatchObject({
        creatorId: "alice",
        creatorPayTo: "0.0.1234",
        asset: "0.0.429274",
        grossAmountAtomic: "1000000",
        networkFeeAmountAtomic: "50000",
        creatorAmountAtomic: "950000",
        status: "recorded",
      });
      expect(recordedPurchase).toMatchObject({
        offeringId: "off_alice_security_1",
        underlyingAgentId: offering.underlyingAgent.agentId,
        underlyingModel: offering.underlyingAgent.model,
        underlyingVersion: "v1",
        settlementStatus: "settled",
      });

      for (const selector of [
        { revenueId: "revenue-1" },
        { purchaseId: "purchase-1" },
        { transactionId: purchase().payment.transactionId },
      ] as const) {
        expect(ledger.getRevenueProvenance(selector)).toEqual({
          sourceKind: "web3_purchase",
          purchase: recordedPurchase,
          revenue,
        });
      }
    } finally { ledger.close(); }
  });

  test("fails closed when settlement evidence does not match the Offering price snapshot", () => {
    const ledger = new RevenueProvenanceLedger(":memory:");
    try {
      for (const payment of [
        { network: "hedera:mainnet" },
        { asset: "HBAR" },
        { amountAtomic: "999999" },
        { payeeReference: "0.0.9999" },
      ]) {
        expect(() => ledger.recordWeb3Purchase(purchase(payment))).toThrow("PROVENANCE_PAYMENT_MISMATCH");
      }
    } finally { ledger.close(); }
  });

  test("requires a published, versioned Offering before recording a purchase", () => {
    const ledger = new RevenueProvenanceLedger(":memory:");
    try {
      expect(() => ledger.recordWeb3Purchase({ ...purchase(), offering: { ...offering, status: "draft" } })).toThrow("PROVENANCE_INVALID");
      const { version: _version, ...withoutVersion } = offering.underlyingAgent;
      expect(() => ledger.recordWeb3Purchase({ ...purchase(), offering: { ...offering, underlyingAgent: withoutVersion } })).toThrow("PROVENANCE_INVALID");
    } finally { ledger.close(); }
  });

  test("does not create Creator revenue without a settled Web3 purchase or reconciled amounts", () => {
    const ledger = new RevenueProvenanceLedger(":memory:");
    try {
      expect(() => ledger.recordCreatorRevenue({
        revenueId: "revenue-missing",
        purchaseId: "purchase-missing",
        networkFeeAmountAtomic: "1",
        creatorAmountAtomic: "9",
      })).toThrow("PROVENANCE_SOURCE_MISSING");

      ledger.recordWeb3Purchase(purchase());
      expect(() => ledger.recordCreatorRevenue({
        revenueId: "revenue-bad-sum",
        purchaseId: "purchase-1",
        networkFeeAmountAtomic: "50000",
        creatorAmountAtomic: "949999",
      })).toThrow("PROVENANCE_RECONCILIATION_FAILED");
    } finally { ledger.close(); }
  });

  test("is idempotent for identical facts and rejects transaction, payment and purchase reuse", () => {
    const ledger = new RevenueProvenanceLedger(":memory:", () => Date.parse("2026-09-15T01:01:00.000Z"));
    try {
      const first = ledger.recordWeb3Purchase(purchase());
      expect(ledger.recordWeb3Purchase(purchase())).toEqual(first);
      expect(() => ledger.recordWeb3Purchase({ ...purchase(), purchaseId: "purchase-2" })).toThrow("PROVENANCE_CONFLICT");

      const firstRevenue = ledger.recordCreatorRevenue({ revenueId: "revenue-1", purchaseId: "purchase-1" });
      expect(ledger.recordCreatorRevenue({ revenueId: "revenue-1", purchaseId: "purchase-1" })).toEqual(firstRevenue);
      expect(() => ledger.recordCreatorRevenue({ revenueId: "revenue-2", purchaseId: "purchase-1" })).toThrow("PROVENANCE_CONFLICT");
    } finally { ledger.close(); }
  });

  test("persists provenance across reopen with private ledger permissions", async () => {
    await withPrivateTempDir(async (directory) => {
      const path = join(directory, "provenance.sqlite");
      const ledger = new RevenueProvenanceLedger(path, () => Date.parse("2026-09-15T01:01:00.000Z"));
      ledger.recordWeb3Purchase(purchase());
      ledger.recordCreatorRevenue({ revenueId: "revenue-1", purchaseId: "purchase-1", networkFeeAmountAtomic: "50000", creatorAmountAtomic: "950000" });
      ledger.close();

      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const reopened = new RevenueProvenanceLedger(path);
      try {
        expect(reopened.getRevenueProvenance({ revenueId: "revenue-1" })?.purchase.transactionId).toBe(purchase().payment.transactionId);
      } finally { reopened.close(); }
    });
  });

  test("refuses shared ledger directories and secret-like payment references", async () => {
    const memory = new RevenueProvenanceLedger(":memory:");
    try {
      expect(() => memory.recordWeb3Purchase(purchase({ payerReference: "sk_live_abcdefgh" }))).toThrow("PROVENANCE_INVALID");
    } finally { memory.close(); }

    await withPrivateTempDir(async (directory) => {
      const shared = join(directory, "shared");
      await mkdir(shared, { mode: 0o755 });
      expect(() => new RevenueProvenanceLedger(join(shared, "provenance.sqlite"))).toThrow("PROVENANCE_LEDGER_UNAVAILABLE");
      expect((await stat(shared)).mode & 0o777).toBe(0o755);
    });
  });
});


test("computes the fee allocation from the Offering snapshot instead of trusting caller amounts", () => {
  const ledger = new RevenueProvenanceLedger(":memory:");
  try {
    ledger.recordWeb3Purchase({
      ...purchase({ amountAtomic: "1000001" }),
      offering: { ...offering, price: { ...offering.price, amountAtomic: "1000001" } },
    });
    const revenue = ledger.recordCreatorRevenue({ revenueId: "revenue-rounding", purchaseId: "purchase-1" });
    expect(revenue.networkFeeAmountAtomic).toBe("50000");
    expect(revenue.creatorAmountAtomic).toBe("950001");
    expect(() => ledger.recordCreatorRevenue({
      revenueId: "revenue-bad-assertion", purchaseId: "purchase-1", networkFeeAmountAtomic: "50001", creatorAmountAtomic: "950000",
    })).toThrow("PROVENANCE_RECONCILIATION_FAILED");
  } finally { ledger.close(); }
});

test("blocks non-zero-fee direct USDC revenue because the Network fee has no settlement evidence", () => {
  const ledger = new RevenueProvenanceLedger(":memory:");
  try {
    ledger.recordWeb3Purchase(purchase());
    ledger.recordCreatorRevenue({ revenueId: "revenue-held", purchaseId: "purchase-1" });
    expect(ledger.assessCreatorRevenueAvailability("revenue-held")).toEqual({
      revenueId: "revenue-held", state: "blocked", reason: "fee_settlement_unproven", symbol: "USDC",
    });
  } finally { ledger.close(); }
});

test("recognizes zero-fee publisher-direct USDC as settled directly, not a platform withdrawable balance", () => {
  const ledger = new RevenueProvenanceLedger(":memory:");
  try {
    ledger.recordWeb3Purchase({ ...purchase(), offering: { ...offering, price: { ...offering.price, networkFeeBps: 0 } } });
    ledger.recordCreatorRevenue({ revenueId: "revenue-direct", purchaseId: "purchase-1" });
    expect(ledger.assessCreatorRevenueAvailability("revenue-direct")).toEqual({
      revenueId: "revenue-direct", state: "settled_direct", reason: "direct_settlement", symbol: "USDC",
    });
  } finally { ledger.close(); }
});

test("records non-USDC purchases but rejects them as Creator USDC revenue", () => {
  const ledger = new RevenueProvenanceLedger(":memory:");
  try {
    const hbarOffering = { ...offering, price: { ...offering.price, asset: "0.0.0", networkFeeBps: 0 } };
    expect(ledger.recordWeb3Purchase({ ...purchase({ asset: "0.0.0" }), offering: hbarOffering }).asset).toBe("0.0.0");
    expect(() => ledger.recordCreatorRevenue({ revenueId: "revenue-hbar", purchaseId: "purchase-1" }))
      .toThrow("PROVENANCE_ASSET_NOT_ALLOWED");
  } finally { ledger.close(); }
});

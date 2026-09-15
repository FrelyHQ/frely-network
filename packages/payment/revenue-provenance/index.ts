import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { validateOffering, type NetworkOffering } from "@frely-network/offering";

const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,191}$/u;
const SAFE_CHAIN_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,191}$/u;
const SAFE_AMOUNT = /^(0|[1-9][0-9]{0,127})$/u;
const SECRET_REFERENCE_PATTERNS = [
  /^(?:bearer|basic)[_.:/-]/iu,
  /^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{8,}$/u,
  /^(?:sk|rk)_(?:live|test)_[A-Za-z0-9_.:/-]{8,}$/u,
  /^(?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|credential|authorization)[:=_-][A-Za-z0-9_.:/-]{8,}$/iu,
] as const;

export const CREATOR_REVENUE_SOURCE_KIND = "web3_purchase" as const;
export type CreatorRevenueSourceKind = typeof CREATOR_REVENUE_SOURCE_KIND;
export type Web3PurchaseSettlementStatus = "settled";
export type CreatorRevenueStatus = "recorded" | "voided";

export interface SettledWeb3PaymentInput {
  readonly network: string;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly transactionId: string;
  readonly paymentReference: string;
  readonly payerReference: string;
  readonly payeeReference: string;
  readonly settledAt: string;
}

export interface RecordWeb3PurchaseInput {
  readonly purchaseId: string;
  readonly offering: NetworkOffering;
  readonly payment: SettledWeb3PaymentInput;
}

export interface Web3PurchaseRecord {
  readonly purchaseId: string;
  readonly network: string;
  readonly transactionId: string;
  readonly paymentReference: string;
  readonly payerReference: string;
  readonly payeeReference: string;
  readonly offeringId: string;
  readonly publisherId: string;
  readonly publisherPayTo: string;
  readonly underlyingAgentId: string;
  readonly underlyingModel: string;
  readonly underlyingVersion: string;
  readonly asset: string;
  readonly grossAmountAtomic: string;
  readonly networkFeeBpsSnapshot: number;
  readonly settlementStatus: Web3PurchaseSettlementStatus;
  readonly offeringSnapshot: NetworkOffering;
  readonly settledAt: string;
  readonly recordedAt: string;
}

export interface RecordCreatorRevenueInput {
  readonly revenueId: string;
  readonly purchaseId: string;
  readonly networkFeeAmountAtomic: string;
  readonly creatorAmountAtomic: string;
  readonly status?: CreatorRevenueStatus;
}

export interface CreatorRevenueRecord {
  readonly revenueId: string;
  readonly sourceKind: CreatorRevenueSourceKind;
  readonly purchaseId: string;
  readonly creatorId: string;
  readonly creatorPayTo: string;
  readonly asset: string;
  readonly grossAmountAtomic: string;
  readonly networkFeeAmountAtomic: string;
  readonly creatorAmountAtomic: string;
  readonly status: CreatorRevenueStatus;
  readonly recordedAt: string;
}

export type RevenueProvenanceSelector =
  | { readonly revenueId: string }
  | { readonly purchaseId: string }
  | { readonly transactionId: string };

export interface CreatorRevenueProvenance {
  readonly sourceKind: CreatorRevenueSourceKind;
  readonly purchase: Web3PurchaseRecord;
  readonly revenue: CreatorRevenueRecord;
}

export class RevenueProvenanceError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RevenueProvenanceError";
  }
}

interface PurchaseRow {
  purchase_id: string;
  network: string;
  transaction_id: string;
  payment_reference: string;
  payer_reference: string;
  payee_reference: string;
  offering_id: string;
  publisher_id: string;
  publisher_pay_to: string;
  underlying_agent_id: string;
  underlying_model: string;
  underlying_version: string;
  asset: string;
  gross_amount_atomic: string;
  network_fee_bps_snapshot: number;
  settlement_status: string;
  offering_snapshot_json: string;
  settled_at: string;
  recorded_at: string;
}

interface RevenueRow {
  revenue_id: string;
  source_kind: string;
  purchase_id: string;
  creator_id: string;
  creator_pay_to: string;
  asset: string;
  gross_amount_atomic: string;
  network_fee_amount_atomic: string;
  creator_amount_atomic: string;
  status: string;
  recorded_at: string;
}

function failure(code: string): RevenueProvenanceError {
  return new RevenueProvenanceError(code);
}

function safeReference(value: unknown): value is string {
  return typeof value === "string" && SAFE_REFERENCE.test(value) && !SECRET_REFERENCE_PATTERNS.some((pattern) => pattern.test(value));
}

function safeChainReference(value: unknown): value is string {
  return typeof value === "string" && SAFE_CHAIN_REFERENCE.test(value) && !SECRET_REFERENCE_PATTERNS.some((pattern) => pattern.test(value));
}

function amount(value: unknown, positive = false): string {
  if (typeof value !== "string" || !SAFE_AMOUNT.test(value) || (positive && BigInt(value) <= 0n)) throw failure("PROVENANCE_INVALID");
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64) throw failure("PROVENANCE_INVALID");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw failure("PROVENANCE_INVALID");
  return value;
}

function nowIso(now: () => number): string {
  return new Date(now()).toISOString();
}

function currentUid(): number {
  if (typeof process.getuid !== "function") throw failure("PROVENANCE_LEDGER_UNAVAILABLE");
  return process.getuid();
}

function prepareDirectory(path: string): void {
  if (path === ":memory:") return;
  if (!path || path.includes("\0")) throw failure("PROVENANCE_LEDGER_UNAVAILABLE");
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== currentUid() || (info.mode & 0o7777) !== 0o700) {
    throw failure("PROVENANCE_LEDGER_UNAVAILABLE");
  }
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (file && (file.isSymbolicLink() || !file.isFile() || file.uid !== currentUid())) throw failure("PROVENANCE_LEDGER_UNAVAILABLE");
}

function applyFilePermissions(path: string): void {
  if (path === ":memory:") return;
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    if (!existsSync(file)) continue;
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile() || info.uid !== currentUid()) throw failure("PROVENANCE_LEDGER_UNAVAILABLE");
    chmodSync(file, 0o600);
  }
}

function purchaseFromRow(row: PurchaseRow): Web3PurchaseRecord {
  let offeringSnapshot: NetworkOffering;
  try { offeringSnapshot = validateOffering(JSON.parse(row.offering_snapshot_json)); }
  catch { throw failure("PROVENANCE_LEDGER_UNAVAILABLE"); }
  return {
    purchaseId: row.purchase_id,
    network: row.network,
    transactionId: row.transaction_id,
    paymentReference: row.payment_reference,
    payerReference: row.payer_reference,
    payeeReference: row.payee_reference,
    offeringId: row.offering_id,
    publisherId: row.publisher_id,
    publisherPayTo: row.publisher_pay_to,
    underlyingAgentId: row.underlying_agent_id,
    underlyingModel: row.underlying_model,
    underlyingVersion: row.underlying_version,
    asset: row.asset,
    grossAmountAtomic: row.gross_amount_atomic,
    networkFeeBpsSnapshot: row.network_fee_bps_snapshot,
    settlementStatus: row.settlement_status as Web3PurchaseSettlementStatus,
    offeringSnapshot,
    settledAt: row.settled_at,
    recordedAt: row.recorded_at,
  };
}

function revenueFromRow(row: RevenueRow): CreatorRevenueRecord {
  if (row.source_kind !== CREATOR_REVENUE_SOURCE_KIND || (row.status !== "recorded" && row.status !== "voided")) {
    throw failure("PROVENANCE_LEDGER_UNAVAILABLE");
  }
  return {
    revenueId: row.revenue_id,
    sourceKind: CREATOR_REVENUE_SOURCE_KIND,
    purchaseId: row.purchase_id,
    creatorId: row.creator_id,
    creatorPayTo: row.creator_pay_to,
    asset: row.asset,
    grossAmountAtomic: row.gross_amount_atomic,
    networkFeeAmountAtomic: row.network_fee_amount_atomic,
    creatorAmountAtomic: row.creator_amount_atomic,
    status: row.status,
    recordedAt: row.recorded_at,
  };
}

function stablePurchase(record: Web3PurchaseRecord): string {
  return JSON.stringify({ ...record, recordedAt: undefined });
}

function stableRevenue(record: CreatorRevenueRecord): string {
  return JSON.stringify({ ...record, recordedAt: undefined });
}

/**
 * Durable audit ledger for Network Web3 purchases and Creator revenue facts.
 * It records provenance only. It does not transfer assets or make a revenue row withdrawable.
 */
export class RevenueProvenanceLedger {
  private readonly db: Database;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    try {
      prepareDirectory(path);
      this.db = new Database(path, { create: true, strict: true });
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS web3_purchases (
          purchase_id TEXT PRIMARY KEY,
          network TEXT NOT NULL,
          transaction_id TEXT NOT NULL UNIQUE,
          payment_reference TEXT NOT NULL UNIQUE,
          payer_reference TEXT NOT NULL,
          payee_reference TEXT NOT NULL,
          offering_id TEXT NOT NULL,
          publisher_id TEXT NOT NULL,
          publisher_pay_to TEXT NOT NULL,
          underlying_agent_id TEXT NOT NULL,
          underlying_model TEXT NOT NULL,
          underlying_version TEXT NOT NULL,
          asset TEXT NOT NULL,
          gross_amount_atomic TEXT NOT NULL,
          network_fee_bps_snapshot INTEGER NOT NULL,
          settlement_status TEXT NOT NULL CHECK(settlement_status = 'settled'),
          offering_snapshot_json TEXT NOT NULL,
          settled_at TEXT NOT NULL,
          recorded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS web3_purchases_offering ON web3_purchases(offering_id);
        CREATE INDEX IF NOT EXISTS web3_purchases_publisher ON web3_purchases(publisher_id);
        CREATE TABLE IF NOT EXISTS creator_revenues (
          revenue_id TEXT PRIMARY KEY,
          source_kind TEXT NOT NULL CHECK(source_kind = 'web3_purchase'),
          purchase_id TEXT NOT NULL UNIQUE REFERENCES web3_purchases(purchase_id) ON DELETE RESTRICT,
          creator_id TEXT NOT NULL,
          creator_pay_to TEXT NOT NULL,
          asset TEXT NOT NULL,
          gross_amount_atomic TEXT NOT NULL,
          network_fee_amount_atomic TEXT NOT NULL,
          creator_amount_atomic TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('recorded', 'voided')),
          recorded_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS creator_revenues_creator ON creator_revenues(creator_id);
      `);
      applyFilePermissions(path);
    } catch (error) {
      if (error instanceof RevenueProvenanceError) throw error;
      throw failure("PROVENANCE_LEDGER_UNAVAILABLE");
    }
  }

  recordWeb3Purchase(input: RecordWeb3PurchaseInput): Web3PurchaseRecord {
    this.assertOpen();
    if (!safeReference(input.purchaseId)) throw failure("PROVENANCE_INVALID");
    let offering: NetworkOffering;
    try { offering = validateOffering(input.offering); }
    catch { throw failure("PROVENANCE_INVALID"); }
    if (offering.status !== "published" || !offering.underlyingAgent.version || !safeReference(offering.underlyingAgent.version)) {
      throw failure("PROVENANCE_INVALID");
    }
    const payment = input.payment;
    if (!safeReference(payment.network) || !safeReference(payment.asset) || !safeChainReference(payment.transactionId) ||
        !safeReference(payment.paymentReference) || !safeReference(payment.payerReference) || !safeChainReference(payment.payeeReference)) throw failure("PROVENANCE_INVALID");
    const settledAt = timestamp(payment.settledAt);
    const grossAmountAtomic = amount(payment.amountAtomic, true);
    if (payment.network !== offering.price.network || payment.asset !== offering.price.asset || grossAmountAtomic !== offering.price.amountAtomic ||
        payment.payeeReference !== offering.price.publisherPayTo) {
      throw failure("PROVENANCE_PAYMENT_MISMATCH");
    }
    const candidate: Web3PurchaseRecord = {
      purchaseId: input.purchaseId,
      network: payment.network,
      transactionId: payment.transactionId,
      paymentReference: payment.paymentReference,
      payerReference: payment.payerReference,
      payeeReference: payment.payeeReference,
      offeringId: offering.id,
      publisherId: offering.publisherId,
      publisherPayTo: offering.price.publisherPayTo,
      underlyingAgentId: offering.underlyingAgent.agentId,
      underlyingModel: offering.underlyingAgent.model,
      underlyingVersion: offering.underlyingAgent.version,
      asset: payment.asset,
      grossAmountAtomic,
      networkFeeBpsSnapshot: offering.price.networkFeeBps,
      settlementStatus: "settled",
      offeringSnapshot: offering,
      settledAt,
      recordedAt: nowIso(this.now),
    };
    try {
      return this.db.transaction(() => {
        const existingById = this.purchaseById(input.purchaseId);
        if (existingById) {
          if (stablePurchase(existingById) !== stablePurchase(candidate)) throw failure("PROVENANCE_CONFLICT");
          return existingById;
        }
        const collision = this.db.query<{ purchase_id: string }, [string, string]>(
          "SELECT purchase_id FROM web3_purchases WHERE transaction_id = ? OR payment_reference = ? LIMIT 1",
        ).get(payment.transactionId, payment.paymentReference);
        if (collision) throw failure("PROVENANCE_CONFLICT");
        this.db.query(`INSERT INTO web3_purchases (
          purchase_id, network, transaction_id, payment_reference, payer_reference, payee_reference,
          offering_id, publisher_id, publisher_pay_to, underlying_agent_id, underlying_model, underlying_version,
          asset, gross_amount_atomic, network_fee_bps_snapshot, settlement_status, offering_snapshot_json,
          settled_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'settled', ?, ?, ?)`).run(
          candidate.purchaseId, candidate.network, candidate.transactionId, candidate.paymentReference, candidate.payerReference, candidate.payeeReference,
          candidate.offeringId, candidate.publisherId, candidate.publisherPayTo, candidate.underlyingAgentId,
          candidate.underlyingModel, candidate.underlyingVersion, candidate.asset, candidate.grossAmountAtomic,
          candidate.networkFeeBpsSnapshot, JSON.stringify(candidate.offeringSnapshot), candidate.settledAt, candidate.recordedAt,
        );
        applyFilePermissions(this.path);
        return this.purchaseById(candidate.purchaseId)!;
      }).immediate();
    } catch (error) {
      if (error instanceof RevenueProvenanceError) throw error;
      throw failure("PROVENANCE_LEDGER_UNAVAILABLE");
    }
  }

  recordCreatorRevenue(input: RecordCreatorRevenueInput): CreatorRevenueRecord {
    this.assertOpen();
    if (!safeReference(input.revenueId) || !safeReference(input.purchaseId)) throw failure("PROVENANCE_INVALID");
    const networkFeeAmountAtomic = amount(input.networkFeeAmountAtomic);
    const creatorAmountAtomic = amount(input.creatorAmountAtomic, true);
    const status = input.status ?? "recorded";
    if (status !== "recorded" && status !== "voided") throw failure("PROVENANCE_INVALID");
    try {
      return this.db.transaction(() => {
        const purchase = this.purchaseById(input.purchaseId);
        if (!purchase || purchase.settlementStatus !== "settled") throw failure("PROVENANCE_SOURCE_MISSING");
        if (BigInt(networkFeeAmountAtomic) + BigInt(creatorAmountAtomic) !== BigInt(purchase.grossAmountAtomic)) {
          throw failure("PROVENANCE_RECONCILIATION_FAILED");
        }
        const candidate: CreatorRevenueRecord = {
          revenueId: input.revenueId,
          sourceKind: CREATOR_REVENUE_SOURCE_KIND,
          purchaseId: purchase.purchaseId,
          creatorId: purchase.publisherId,
          creatorPayTo: purchase.publisherPayTo,
          asset: purchase.asset,
          grossAmountAtomic: purchase.grossAmountAtomic,
          networkFeeAmountAtomic,
          creatorAmountAtomic,
          status,
          recordedAt: nowIso(this.now),
        };
        const existingById = this.revenueById(input.revenueId);
        if (existingById) {
          if (stableRevenue(existingById) !== stableRevenue(candidate)) throw failure("PROVENANCE_CONFLICT");
          return existingById;
        }
        const purchaseRevenue = this.db.query<{ revenue_id: string }, [string]>(
          "SELECT revenue_id FROM creator_revenues WHERE purchase_id = ?",
        ).get(input.purchaseId);
        if (purchaseRevenue) throw failure("PROVENANCE_CONFLICT");
        this.db.query(`INSERT INTO creator_revenues (
          revenue_id, source_kind, purchase_id, creator_id, creator_pay_to, asset, gross_amount_atomic,
          network_fee_amount_atomic, creator_amount_atomic, status, recorded_at
        ) VALUES (?, 'web3_purchase', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          candidate.revenueId, candidate.purchaseId, candidate.creatorId, candidate.creatorPayTo, candidate.asset,
          candidate.grossAmountAtomic, candidate.networkFeeAmountAtomic, candidate.creatorAmountAtomic,
          candidate.status, candidate.recordedAt,
        );
        applyFilePermissions(this.path);
        return this.revenueById(candidate.revenueId)!;
      }).immediate();
    } catch (error) {
      if (error instanceof RevenueProvenanceError) throw error;
      throw failure("PROVENANCE_LEDGER_UNAVAILABLE");
    }
  }

  readPurchase(purchaseId: string): Web3PurchaseRecord | null {
    this.assertOpen();
    if (!safeReference(purchaseId)) throw failure("PROVENANCE_INVALID");
    return this.purchaseById(purchaseId);
  }

  readCreatorRevenue(revenueId: string): CreatorRevenueRecord | null {
    this.assertOpen();
    if (!safeReference(revenueId)) throw failure("PROVENANCE_INVALID");
    return this.revenueById(revenueId);
  }

  getRevenueProvenance(selector: RevenueProvenanceSelector): CreatorRevenueProvenance | null {
    this.assertOpen();
    const entries = Object.entries(selector);
    if (entries.length !== 1) throw failure("PROVENANCE_INVALID");
    const [key, value] = entries[0]!;
    if ((key !== "revenueId" && key !== "purchaseId" && key !== "transactionId") ||
        (key === "transactionId" ? !safeChainReference(value) : !safeReference(value))) throw failure("PROVENANCE_INVALID");
    const where = key === "revenueId" ? "r.revenue_id = ?" : key === "purchaseId" ? "p.purchase_id = ?" : "p.transaction_id = ?";
    const row = this.db.query<Record<string, unknown>, [string]>(`
      SELECT
        p.purchase_id AS p_purchase_id, p.network AS p_network, p.transaction_id AS p_transaction_id,
        p.payment_reference AS p_payment_reference, p.payer_reference AS p_payer_reference, p.payee_reference AS p_payee_reference,
        p.offering_id AS p_offering_id, p.publisher_id AS p_publisher_id, p.publisher_pay_to AS p_publisher_pay_to,
        p.underlying_agent_id AS p_underlying_agent_id, p.underlying_model AS p_underlying_model,
        p.underlying_version AS p_underlying_version, p.asset AS p_asset,
        p.gross_amount_atomic AS p_gross_amount_atomic, p.network_fee_bps_snapshot AS p_network_fee_bps_snapshot,
        p.settlement_status AS p_settlement_status, p.offering_snapshot_json AS p_offering_snapshot_json,
        p.settled_at AS p_settled_at, p.recorded_at AS p_recorded_at,
        r.revenue_id AS r_revenue_id, r.source_kind AS r_source_kind, r.purchase_id AS r_purchase_id,
        r.creator_id AS r_creator_id, r.creator_pay_to AS r_creator_pay_to, r.asset AS r_asset,
        r.gross_amount_atomic AS r_gross_amount_atomic, r.network_fee_amount_atomic AS r_network_fee_amount_atomic,
        r.creator_amount_atomic AS r_creator_amount_atomic, r.status AS r_status, r.recorded_at AS r_recorded_at
      FROM creator_revenues r JOIN web3_purchases p ON p.purchase_id = r.purchase_id
      WHERE ${where} LIMIT 1
    `).get(value);
    if (!row) return null;
    const purchase = purchaseFromRow({
      purchase_id: row.p_purchase_id as string,
      network: row.p_network as string,
      transaction_id: row.p_transaction_id as string,
      payment_reference: row.p_payment_reference as string,
      payer_reference: row.p_payer_reference as string,
      payee_reference: row.p_payee_reference as string,
      offering_id: row.p_offering_id as string,
      publisher_id: row.p_publisher_id as string,
      publisher_pay_to: row.p_publisher_pay_to as string,
      underlying_agent_id: row.p_underlying_agent_id as string,
      underlying_model: row.p_underlying_model as string,
      underlying_version: row.p_underlying_version as string,
      asset: row.p_asset as string,
      gross_amount_atomic: row.p_gross_amount_atomic as string,
      network_fee_bps_snapshot: row.p_network_fee_bps_snapshot as number,
      settlement_status: row.p_settlement_status as string,
      offering_snapshot_json: row.p_offering_snapshot_json as string,
      settled_at: row.p_settled_at as string,
      recorded_at: row.p_recorded_at as string,
    });
    const revenue = revenueFromRow({
      revenue_id: row.r_revenue_id as string,
      source_kind: row.r_source_kind as string,
      purchase_id: row.r_purchase_id as string,
      creator_id: row.r_creator_id as string,
      creator_pay_to: row.r_creator_pay_to as string,
      asset: row.r_asset as string,
      gross_amount_atomic: row.r_gross_amount_atomic as string,
      network_fee_amount_atomic: row.r_network_fee_amount_atomic as string,
      creator_amount_atomic: row.r_creator_amount_atomic as string,
      status: row.r_status as string,
      recorded_at: row.r_recorded_at as string,
    });
    return { sourceKind: CREATOR_REVENUE_SOURCE_KIND, purchase, revenue };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private purchaseById(purchaseId: string): Web3PurchaseRecord | null {
    const row = this.db.query<PurchaseRow, [string]>("SELECT * FROM web3_purchases WHERE purchase_id = ?").get(purchaseId);
    return row ? purchaseFromRow(row) : null;
  }

  private revenueById(revenueId: string): CreatorRevenueRecord | null {
    const row = this.db.query<RevenueRow, [string]>("SELECT * FROM creator_revenues WHERE revenue_id = ?").get(revenueId);
    return row ? revenueFromRow(row) : null;
  }

  private assertOpen(): void {
    if (this.closed) throw failure("PROVENANCE_LEDGER_UNAVAILABLE");
  }
}

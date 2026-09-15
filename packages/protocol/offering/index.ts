import type { OfferingReference, UnderlyingAgentReference } from "@frely-network/shared-types";

export type OfferingStatus = "draft" | "published" | "unpublished" | "disabled";

export interface OfferingPrice {
  readonly network: string;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly publisherPayTo: string;
  readonly networkFeeBps: number;
}

/** Alice-owned sale object. The ERC-8004 Agent ID comes from registration context. */
export interface NetworkOffering extends OfferingReference {
  readonly capabilities: readonly string[];
  readonly price: OfferingPrice;
  readonly status: OfferingStatus;
}

export interface OfferingRegistrationExtension {
  readonly offerings: readonly NetworkOffering[];
}

function invalid(): never { throw new Error("OFFERING_INVALID"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.trim() !== value || /[\r\n\u0000]/u.test(value)) return invalid();
  return value;
}
function capabilities(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return invalid();
  const result = value.map((item) => text(item, 96));
  if (new Set(result).size !== result.length) return invalid();
  return result;
}
function status(value: unknown): OfferingStatus {
  if (value !== "draft" && value !== "published" && value !== "unpublished" && value !== "disabled") return invalid();
  return value;
}
function underlying(value: unknown): UnderlyingAgentReference {
  const source = record(value);
  if (source.platform !== "frely") return invalid();
  const agentId = text(source.agentId, 128);
  const model = text(source.model, 256);
  const version = source.version === undefined ? undefined : text(source.version, 64);
  const ownerRef = source.ownerRef === undefined ? undefined : text(source.ownerRef, 256);
  return { platform: "frely", agentId, model, ...(version === undefined ? {} : { version }), ...(ownerRef === undefined ? {} : { ownerRef }) };
}
function price(value: unknown): OfferingPrice {
  const source = record(value);
  const network = text(source.network, 96);
  const asset = text(source.asset, 96);
  const amountAtomic = text(source.amountAtomic, 96);
  if (!/^(0|[1-9][0-9]*)$/u.test(amountAtomic)) return invalid();
  const publisherPayTo = text(source.publisherPayTo, 256);
  if (!Number.isSafeInteger(source.networkFeeBps) || (source.networkFeeBps as number) < 0 || (source.networkFeeBps as number) > 10_000) return invalid();
  return { network, asset, amountAtomic, publisherPayTo, networkFeeBps: source.networkFeeBps as number };
}

/** Validate Alice's sale object and its reference to Bob's Web2 Agent. */
export function validateOffering(value: unknown): NetworkOffering {
  const source = record(value);
  const id = text(source.id, 128);
  const publisherId = text(source.publisherId, 256);
  const publisherEnsName = source.publisherEnsName === undefined ? undefined : text(source.publisherEnsName, 256).toLowerCase();
  return {
    id,
    publisherId,
    ...(publisherEnsName === undefined ? {} : { publisherEnsName }),
    underlyingAgent: underlying(source.underlyingAgent),
    capabilities: capabilities(source.capabilities),
    price: price(source.price),
    status: status(source.status),
  };
}

export function validateOfferings(value: unknown): NetworkOffering[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return invalid();
  const result = value.map(validateOffering);
  if (new Set(result.map((offering) => offering.id)).size !== result.length) return invalid();
  return result;
}

/** Parse the Offering list stored in ERC-8004 agentURI metadata. */
export function offeringsFromRegistrationMetadata(value: unknown): NetworkOffering[] {
  const source = record(value);
  if (source.offerings === undefined) return [];
  return validateOfferings(source.offerings);
}

/** Build the metadata extension merged into an ERC-8004 registration document. */
export function offeringRegistrationExtension(value: unknown): OfferingRegistrationExtension {
  return { offerings: validateOfferings(value) };
}
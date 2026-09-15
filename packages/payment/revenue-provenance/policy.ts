import {
  HEDERA_TESTNET_NETWORK,
  HEDERA_TESTNET_USDC_ASSET,
  HEDERA_USDC_DECIMALS,
} from "@frely-network/hedera-x402";

export interface CreatorRevenueAsset {
  readonly network: string;
  readonly asset: string;
  readonly symbol: "USDC";
  readonly decimals: number;
}

/**
 * Creator payout assets are an explicit allowlist. Adding a network or token
 * requires a code review; an Offering cannot label an arbitrary token as USDC.
 */
export const CREATOR_REVENUE_ASSET_ALLOWLIST: readonly CreatorRevenueAsset[] = Object.freeze([
  Object.freeze({
    network: HEDERA_TESTNET_NETWORK,
    asset: HEDERA_TESTNET_USDC_ASSET,
    symbol: "USDC" as const,
    decimals: HEDERA_USDC_DECIMALS,
  }),
]);

export interface CreatorRevenueAllocation {
  readonly grossAmountAtomic: string;
  readonly networkFeeBps: number;
  readonly networkFeeAmountAtomic: string;
  readonly creatorAmountAtomic: string;
}

export function creatorRevenueAsset(network: string, asset: string): CreatorRevenueAsset | undefined {
  return CREATOR_REVENUE_ASSET_ALLOWLIST.find((candidate) => candidate.network === network && candidate.asset === asset);
}

/**
 * Split atomic units without inventing fractional token units. The Network fee
 * rounds down; any atomic-unit remainder stays with the Creator.
 */
export function calculateCreatorRevenueAllocation(grossAmountAtomic: string, networkFeeBps: number): CreatorRevenueAllocation {
  if (!/^[1-9][0-9]{0,127}$/u.test(grossAmountAtomic) || !Number.isSafeInteger(networkFeeBps) || networkFeeBps < 0 || networkFeeBps > 10_000) {
    throw new Error("CREATOR_REVENUE_ALLOCATION_INVALID");
  }
  const gross = BigInt(grossAmountAtomic);
  const fee = gross * BigInt(networkFeeBps) / 10_000n;
  return {
    grossAmountAtomic,
    networkFeeBps,
    networkFeeAmountAtomic: fee.toString(),
    creatorAmountAtomic: (gross - fee).toString(),
  };
}

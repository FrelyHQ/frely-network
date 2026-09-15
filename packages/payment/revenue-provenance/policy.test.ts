import { expect, test } from "bun:test";
import { HEDERA_TESTNET_USDC_ASSET } from "@frely-network/hedera-x402";
import { calculateCreatorRevenueAllocation, creatorRevenueAsset } from "./policy.ts";

test("allowlists only the pinned Hedera testnet USDC asset for Creator USDC revenue", () => {
  expect(HEDERA_TESTNET_USDC_ASSET).toBe("0.0.429274");
  expect(creatorRevenueAsset("hedera:testnet", "0.0.429274")).toMatchObject({ symbol: "USDC", decimals: 6 });
  expect(creatorRevenueAsset("hedera:testnet", "0.0.0")).toBeUndefined();
  expect(creatorRevenueAsset("hedera:testnet", "0.0.456858")).toBeUndefined();
});

test("rounds the Network fee down and leaves atomic-unit remainder with the Creator", () => {
  expect(calculateCreatorRevenueAllocation("1000001", 500)).toEqual({
    grossAmountAtomic: "1000001",
    networkFeeBps: 500,
    networkFeeAmountAtomic: "50000",
    creatorAmountAtomic: "950001",
  });
});


test("supports a 10000 bps policy without producing a negative Creator allocation", () => {
  expect(calculateCreatorRevenueAllocation("1", 10000)).toEqual({
    grossAmountAtomic: "1", networkFeeBps: 10000, networkFeeAmountAtomic: "1", creatorAmountAtomic: "0",
  });
});

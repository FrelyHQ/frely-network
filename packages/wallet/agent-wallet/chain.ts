import type { ReadOnlyAccount } from "./types.ts";

const ACCOUNT_ID = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;
const MAX_TINYBAR = 9_223_372_036_854_775_807n;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function integerString(value: unknown): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("NETWORK_CHECK_FAILED");
  }
  return BigInt(value);
}

/** 解析只读账户快照。存在余额字段不等于 funded/activated。 */
export function parseReadOnlyAccount(value: unknown): ReadOnlyAccount {
  const object = asObject(value);
  if (
    !object ||
    typeof object.accountId !== "string" ||
    !ACCOUNT_ID.test(object.accountId) ||
    typeof object.evmAddress !== "string" ||
    !EVM.test(object.evmAddress) ||
    typeof object.balanceTinybar !== "string"
  ) {
    throw new Error("NETWORK_CHECK_FAILED");
  }
  const balance = integerString(object.balanceTinybar);
  if (balance < 0n || balance > MAX_TINYBAR) {
    throw new Error("NETWORK_CHECK_FAILED");
  }
  return {
    accountId: object.accountId,
    evmAddress: object.evmAddress,
    balanceTinybar: object.balanceTinybar,
  };
}

import { expect, test } from "bun:test";
import { assertLiveAuthorization, runLive } from "./live.ts";

test("does not construct transport when live confirmation is missing", async () => {
  let constructed = 0;
  await expect(runLive({
    confirmation: undefined,
    createTransport() {
      constructed += 1;
      throw new Error("transport-should-not-construct");
    },
  })).rejects.toThrow("LIVE_PAYMENT_NOT_AUTHORIZED");
  expect(constructed).toBe(0);
});

test("does not construct transport when live confirmation is wrong", async () => {
  let constructed = 0;
  await expect(runLive({
    confirmation: "yes",
    createTransport() {
      constructed += 1;
      throw new Error("transport-should-not-construct");
    },
  })).rejects.toThrow("LIVE_PAYMENT_NOT_AUTHORIZED");
  expect(constructed).toBe(0);
});

test("assertLiveAuthorization only accepts the frozen confirmation string", () => {
  expect(() => assertLiveAuthorization(undefined)).toThrow("LIVE_PAYMENT_NOT_AUTHORIZED");
  expect(() => assertLiveAuthorization("I AUTHORIZE ONE 1 HBAR TESTNET PAYMENT")).not.toThrow();
});

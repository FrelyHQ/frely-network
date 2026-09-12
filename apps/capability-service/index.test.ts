import { expect, test } from "bun:test";
import { parsePort } from "./index.ts";

test("accepts only TCP port numbers", () => {
  expect(parsePort("13600")).toBe(13600);
  for (const value of ["0", "65536", "13600.5", "not-a-port"]) {
    expect(() => parsePort(value)).toThrow("PORT_INVALID");
  }
});

import { expect, test } from "bun:test";
import { parsePort } from "./index.ts";

test("accepts only TCP port numbers", () => {
  expect(parsePort("4100")).toBe(4100);
  for (const value of ["0", "65536", "4100.5", "not-a-port"]) {
    expect(() => parsePort(value)).toThrow("PORT_INVALID");
  }
});

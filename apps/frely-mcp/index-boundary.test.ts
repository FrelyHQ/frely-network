import { readFile } from "node:fs/promises";
import { expect, test } from "bun:test";

test("intermediate entrypoint has no legacy discovery or identity dependencies", async () => {
  const index = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  expect(index).not.toContain("@frely-network/the-graph");
  expect(index).not.toContain("@frely-network/ens");
  expect(index).not.toContain("@frely-network/erc8004");
});

test("README identifies the renamed app without documenting a legacy service", async () => {
  const readme = await readFile(new URL("./README.md", import.meta.url), "utf8");
  expect(readme).not.toContain("apps/broker-mcp");
  expect(readme).toContain("not a usable MCP service");
});

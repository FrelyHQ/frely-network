import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function query(capabilities: string[], scenario = "success") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [import.meta.dir + "/fixtures/mock-server.ts"],
    env: { MOCK_DISCOVERY_SCENARIO: scenario },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
  const client = new Client({ name: "mock-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "find_capability", arguments: { capabilities } });
    expect(diagnostics).toContain("MOCK DISCOVERY");
    return result;
  } finally {
    await client.close();
    await transport.close();
  }
}

test("fixed mock candidates use all-capability matching and repeatable results", async () => {
  const vision = await query(["vision"]);
  expect(vision.isError).not.toBe(true);
  const providers = (vision.structuredContent as { providers: { id: string }[] }).providers;
  expect(providers.map((p) => p.id)).toEqual(["mock-vision-basic", "mock-vision-ocr"]);
  expect(await query(["vision"])).toEqual(vision);
  const ocr = await query(["vision", "ocr"]);
  expect(ocr.structuredContent).toEqual({ providers: [{ id: "mock-vision-ocr", capabilities: ["vision", "ocr"], supportsX402: false }] });
  expect(JSON.stringify(vision)).not.toContain('"endpoint"');
  expect(JSON.stringify(vision)).not.toContain('"verified"');
});

test("unknown capabilities and empty scenario return NO_PROVIDER", async () => {
  for (const [capabilities, scenario] of [[["audio"], "success"], [["vision"], "empty"]] as const) {
    const result = await query([...capabilities], scenario);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "NO_PROVIDER" }]);
  }
});

test("query-error scenario returns an explicit tool error", async () => {
  const result = await query(["vision"], "query-error");
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([{ type: "text", text: "GRAPH_QUERY_FAILED" }]);
});

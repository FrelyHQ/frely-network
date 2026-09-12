import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio MCP exposes only find_capability and use_capability with stable output", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [import.meta.dir + "/fixtures/fake-server.ts"],
    stderr: "pipe",
  });
  const errors: string[] = [];
  transport.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  const client = new Client({ name: "frely-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["find_capability", "use_capability"]);
    const found = await client.callTool({ name: "find_capability", arguments: { capabilities: ["vision"] } });
    expect(found.isError).not.toBe(true);
    expect(found.structuredContent).toMatchObject({ resolution: { source: "static_allowlist", identityVerified: false } });
    const used = await client.callTool({
      name: "use_capability",
      arguments: {
        requestId: "req-1",
        capabilities: ["vision"],
        task: "Describe",
        input: { image_url: "https://images.example.com/a.png" },
        maxAmountAtomic: "10",
      },
    });
    expect(used.structuredContent).toMatchObject({
      payment: { status: "settled" },
      service: { status: "succeeded" },
    });
    expect(errors).toEqual([]);
  } finally {
    await client.close();
    await transport.close();
  }
});

test("stdio MCP rejects extra fields and redacts unexpected errors", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [import.meta.dir + "/fixtures/fake-server.ts"], stderr: "pipe" });
  const client = new Client({ name: "frely-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const extra = await client.callTool({ name: "find_capability", arguments: { capabilities: ["vision"], secret: "must-not-echo" } });
    expect(extra.isError).toBe(true);
    expect(JSON.stringify(extra)).not.toContain("must-not-echo");
    const unexpected = await client.callTool({
      name: "use_capability",
      arguments: {
        requestId: "explode",
        capabilities: ["vision"],
        task: "Describe",
        input: { image_url: "https://images.example.com/a.png" },
        maxAmountAtomic: "10",
      },
    });
    expect(unexpected.isError).toBe(true);
    expect(unexpected.content).toEqual([{ type: "text", text: "EXECUTION_FAILED" }]);
  } finally {
    await client.close();
    await transport.close();
  }
});

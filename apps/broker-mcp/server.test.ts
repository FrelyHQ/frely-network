import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function withClient(run: (client: Client) => Promise<void>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [import.meta.dir + "/fixtures/fake-server.ts"],
    stderr: "pipe",
  });
  const errors: string[] = [];
  transport.stderr?.on("data", (chunk) => errors.push(String(chunk)));
  const client = new Client({ name: "broker-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    await run(client);
    expect(errors).toEqual([]);
  } finally {
    await client.close();
    await transport.close();
  }
}

describe("Broker stdio MCP", () => {
  test("handshakes, lists only find_capability and returns discovery candidates", async () => {
    await withClient(async (client) => {
      const list = await client.listTools();
      expect(list.tools.map((tool) => tool.name)).toEqual(["find_capability"]);
      const result = await client.callTool({ name: "find_capability", arguments: { capabilities: ["vision", "ocr"] } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({ providers: [{ id: "fake-provider", capabilities: ["vision", "ocr"], supportsX402: true }] });
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
    });
  });
  test("rejects invalid capabilities before discovery", async () => {
    await withClient(async (client) => {
      for (const capabilities of [[], [" "], [123], "vision"]) {
        const result = await client.callTool({ name: "find_capability", arguments: { capabilities } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain("FAKE_CALLED_INVALID");
      }
    });
  });
  test("preserves known failures and redacts unexpected failures", async () => {
    await withClient(async (client) => {
      for (const code of ["NO_PROVIDER", "GRAPH_QUERY_FAILED", "GRAPH_SCHEMA_INVALID", "CAPABILITY_NOT_SUPPORTED"]) {
        const result = await client.callTool({ name: "find_capability", arguments: { capabilities: [code] } });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: "text", text: code }]);
      }
      const result = await client.callTool({ name: "find_capability", arguments: { capabilities: ["unexpected"] } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "DISCOVERY_FAILED" }]);
    });
  });
  test("production entry rejects absent or invalid config without stdout or fake fallback", async () => {
    for (const config of [{}, { GRAPH_ENDPOINT: "invalid-secret-url", PAYMENT_NETWORK: "hedera:testnet" }]) {
      const child = Bun.spawn([process.execPath, import.meta.dir + "/index.ts"], {
        env: { PATH: process.env.PATH ?? "", GRAPH_ENDPOINT: "", PAYMENT_NETWORK: "", ...config }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(status).toBe(1);
      expect(stdout).toBe("");
      expect(stderr.trim()).toBe("GRAPH_CONFIG_INVALID");
    }
  });
});

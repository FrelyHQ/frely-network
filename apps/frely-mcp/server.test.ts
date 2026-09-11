import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import successFixture from "../../packages/protocol/capability-resolution/fixtures/success.json";

async function withClient(run: (client: Client) => Promise<void>, entry = "fake-server.ts") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [import.meta.dir + "/fixtures/" + entry],
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

describe("Frely stdio MCP", () => {
  test("handshakes, lists both tools and returns a verified capability", async () => {
    await withClient(async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["find_capability", "use_capability"]);
      expect(tools.tools.find((tool) => tool.name === "find_capability")?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(tools.tools.find((tool) => tool.name === "use_capability")?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      });
      const result = await client.callTool({ name: "find_capability", arguments: { capabilities: ["vision"] } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(successFixture);
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
      for (const code of ["NO_PROVIDER", "NETWORK_UNAVAILABLE", "IDENTITY_VERIFICATION_FAILED", "CAPABILITY_NOT_SUPPORTED", "PROVIDER_NOT_AUTHORIZED"]) {
        const result = await client.callTool({ name: "find_capability", arguments: { capabilities: [code] } });
        expect(result.isError).toBe(true);
        expect(result.content).toEqual([{ type: "text", text: code }]);
      }
      const result = await client.callTool({ name: "find_capability", arguments: { capabilities: ["unexpected"] } });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: "text", text: "EXECUTION_FAILED" }]);
      expect(JSON.stringify(result)).not.toContain("secret.example");
    });
  });
  test("CLI without a command writes a fixed error and no stdout", async () => {
    for (const config of [{}, { GRAPH_ENDPOINT: "invalid-secret-url", PAYMENT_NETWORK: "hedera:testnet" }]) {
      const child = Bun.spawn([process.execPath, import.meta.dir + "/index.ts"], {
        env: { PATH: process.env.PATH ?? "", GRAPH_ENDPOINT: "", PAYMENT_NETWORK: "", ...config }, stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(status).toBe(2);
      expect(stdout).toBe("");
      expect(stderr.trim()).toBe("INPUT_INVALID");
    }
  });
});

test("use_capability is callable over stdio and rejects unverified providers", async () => {
  await withClient(async (client) => {
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["find_capability", "use_capability"]);
    const args = {
      capabilities: ["vision"],
      task: "Describe",
      input: { image_url: "https://images.example/a.png" },
      payment: { requestId: "mcp-use-1", budget: { network: "hedera:testnet" as const, asset: "0.0.0", maxAmountAtomic: "1000" } },
    };
    const result = await client.callTool({ name: "use_capability", arguments: args });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      provider: { id: "provider-1", ensName: "vision.example.eth" },
      identityVerificationSource: "frely-network",
      output: { output_text: "synthetic result" },
    });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
    const invalid = await client.callTool({ name: "use_capability", arguments: { ...args, capabilities: ["invalid"] } });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toEqual([{ type: "text", text: "CAPABILITY_NOT_SUPPORTED" }]);
  }, "use-server.ts");
});

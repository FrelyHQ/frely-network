import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("use_capability carries a budgeted payment through stdio with structured evidence", async () => {
  const transport = new StdioClientTransport({ command: process.execPath, args: [import.meta.dir + "/fixtures/payment-server.ts"], stderr: "pipe" });
  const client = new Client({ name: "payment-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "use_capability", arguments: {
      capabilities: ["vision"], task: "Describe", input: { image_url: "https://images.example/a.png" },
      payment: { requestId: "mcp-paid-1", budget: { network: "hedera:testnet", asset: "0.0.0", maxAmountAtomic: "1000" } },
    } });
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.paymentOutcome.paymentStatus).toBe("settled");
    expect(structured.paymentOutcome.serviceStatus).toBe("succeeded");
    expect(structured.payment.transactionId).toBe("synthetic-tx");
    expect(structured.output).toEqual({ output_text: "synthetic output" });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify(result.structuredContent) }]);
  } finally { await client.close(); await transport.close(); }
});

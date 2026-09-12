import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function command(args: string[], cwd: string) {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

test("packed MCP contains only the public entry and starts outside the repository", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "frely-mcp-package-"));
  const unpacked = join(temporary, "unpacked");
  const consumer = join(temporary, "consumer");
  await mkdir(unpacked);
  await mkdir(consumer);
  try {
    expect((await command([process.execPath, "build-package.ts"], import.meta.dir)).exitCode).toBe(0);
    const packed = await command([process.execPath, "pm", "pack", "--destination", temporary], import.meta.dir);
    expect(packed.exitCode).toBe(0);
    const archive = (await readdir(temporary)).find((entry) => entry.endsWith(".tgz"));
    expect(archive).toBeTruthy();
    const archivePath = join(temporary, archive ?? "");
    expect((await command(["tar", "-xzf", archivePath, "-C", unpacked], temporary)).exitCode).toBe(0);
    const files = (await command(["find", "package", "-type", "f"], unpacked)).stdout.trim().split("\n").sort();
    expect(files).toEqual(["package/README.md", "package/dist/frely-mcp.js", "package/package.json"]);
    const bundle = await Bun.file(join(unpacked, "package/dist/frely-mcp.js")).text();
    expect(bundle).not.toContain("/Users/");
    expect(bundle).not.toContain("workspace:");
    expect(bundle).not.toContain("fixtures");
    const help = await command([process.execPath, join(unpacked, "package/dist/frely-mcp.js"), "--help"], temporary);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("frely-mcp start --config");

    await writeFile(join(consumer, "package.json"), JSON.stringify({ name: "frely-mcp-consumer", private: true }));
    expect((await command([process.execPath, "add", archivePath, "--ignore-scripts"], consumer)).exitCode).toBe(0);
    const installedPackage = join(consumer, "node_modules/frely-mcp");
    let networkPort = 0;
    const network = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request): Promise<Response> => {
        expect(request.headers.get("authorization")).toBe("Bearer network-key");
        return Response.json({
          schemaVersion: 2,
          requestedCapabilities: ["vision"],
          provider: { id: "package-vision", endpoint: "https://relay.example.com/v1/responses", protocol: "responses" },
          execution: { endpoint: `http://127.0.0.1:${networkPort}/v1/responses`, managedBy: "network" },
          resolution: { source: "static_allowlist", identityVerified: false },
          payment: { supportsX402: true, network: "hedera:testnet", resource: `http://127.0.0.1:${networkPort}/v1/responses` },
        });
      },
    });
    if (typeof network.port !== "number") throw new Error("TEST_SERVER_PORT_UNAVAILABLE");
    networkPort = network.port;
    const configPath = join(temporary, "config.json");
    await writeFile(configPath, JSON.stringify({
      schemaVersion: 2,
      network: { baseUrl: `http://127.0.0.1:${network.port}`, apiKeyRef: "env:FRELY_NETWORK_API_KEY" },
      approvedProvider: { id: "package-vision", relayUrl: "https://relay.example.com/v1/responses" },
      approvedExecution: { resourceUrl: `http://127.0.0.1:${network.port}/v1/responses` },
    }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(installedPackage, "dist/frely-mcp.js"), "start", "--config", configPath],
      cwd: temporary,
      env: { PATH: process.env.PATH ?? "", FRELY_NETWORK_API_KEY: "network-key" },
      stderr: "pipe",
    });
    const errors: string[] = [];
    transport.stderr?.on("data", (chunk) => errors.push(String(chunk)));
    const client = new Client({ name: "packed-test", version: "0.0.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["find_capability", "use_capability"]);
      const result = await client.callTool({ name: "find_capability", arguments: { capabilities: ["vision"] } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ provider: { id: "package-vision" } });
      expect(errors).toEqual([]);
    } finally {
      await client.close();
      await transport.close();
      network.stop(true);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);

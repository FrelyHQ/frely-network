#!/usr/bin/env bun
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outDir = join(import.meta.dir, "dist");
const outFile = join(outDir, "frely-mcp.js");

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "index.ts")],
  target: "bun",
  format: "esm",
  minify: true,
});

if (!result.success) {
  console.error("PACKAGE_BUILD_FAILED");
  process.exit(1);
}

const artifact = result.outputs[0];
if (!artifact) {
  console.error("PACKAGE_BUILD_FAILED");
  process.exit(1);
}

const body = await artifact.text();
const source = body.startsWith("#!") ? body : `#!/usr/bin/env bun\n${body}`;
await mkdir(outDir, { recursive: true });
await writeFile(outFile, source);
await chmod(outFile, 0o755);

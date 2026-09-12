#!/usr/bin/env bun
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function buildFrelyMcpPackage(outputDirectory = join(import.meta.dir, "dist")): Promise<string> {
  const output = join(outputDirectory, "frely-mcp.js");
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "index.ts")],
    target: "bun",
    format: "esm",
    minify: true,
    external: ["@grpc/grpc-js", "pino", "thread-stream"],
  });
  if (!result.success || !result.outputs[0]) throw new Error("PACKAGE_BUILD_FAILED");
  const artifact = await result.outputs[0].text();
  if (artifact.includes("/Users/") || artifact.includes("workspace:") || artifact.includes("fixtures")) {
    throw new Error("PACKAGE_BUILD_FAILED");
  }
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(output, artifact.startsWith("#!") ? artifact : `#!/usr/bin/env bun\n${artifact}`);
  await chmod(output, 0o755);
  return output;
}

if (import.meta.main) {
  try {
    await buildFrelyMcpPackage();
  } catch {
    process.stderr.write("PACKAGE_BUILD_FAILED\n");
    process.exitCode = 1;
  }
}

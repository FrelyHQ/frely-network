import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CommandResult = { exitCode: number; stdout: string; stderr: string };
async function run(command: string[], cwd: string): Promise<CommandResult> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function buildAndPack(): Promise<{
  unpackDir: string;
  installDir: string;
  files: string[];
  cleanup(): Promise<void>;
}> {
  const temporary = await mkdtemp(join(tmpdir(), "frely-mcp-pack-"));
  const unpackDir = join(temporary, "unpacked");
  const installDir = join(temporary, "installed");
  await mkdir(unpackDir);
  await mkdir(installDir);
  const built = await run([process.execPath, "build-package.ts"], import.meta.dir);
  if (built.exitCode !== 0) throw new Error("PACKAGE_BUILD_FAILED");
  const packed = await run(["npm", "pack", "--json"], import.meta.dir);
  if (packed.exitCode !== 0) throw new Error("PACKAGE_BUILD_FAILED");
  const metadata = JSON.parse(packed.stdout)[0] as {
    filename: string;
    files: Array<{ path: string }>;
  };
  const archive = join(import.meta.dir, metadata.filename);
  if ((await run(["tar", "-xzf", archive, "-C", unpackDir], temporary)).exitCode !== 0) {
    throw new Error("PACKAGE_BUILD_FAILED");
  }
  if ((await run(["npm", "install", "--ignore-scripts", archive], installDir)).exitCode !== 0) {
    throw new Error("PACKAGE_BUILD_FAILED");
  }
  return {
    unpackDir,
    installDir,
    files: metadata.files.map(file => file.path).sort(),
    cleanup: async () => {
      await rm(temporary, { recursive: true, force: true });
      await rm(archive, { force: true });
    },
  };
}

test("packed artifact is a Bun CLI without workspace dependencies or secrets", async () => {
  const packed = await buildAndPack();
  try {
    const manifest = await Bun.file(join(packed.unpackDir, "package/package.json")).json();
    const bundle = await Bun.file(join(packed.unpackDir, "package/dist/frely-mcp.js")).text();
    expect(manifest.name).toBe("frely-mcp");
    expect(manifest.bin).toEqual({ "frely-mcp": "dist/frely-mcp.js" });
    expect(JSON.stringify(manifest.dependencies ?? {})).not.toContain("workspace:");
    expect(packed.files).toEqual(["README.md", "dist/frely-mcp.js", "package.json"]);
    expect(bundle).not.toContain("/Users/");
    expect(bundle).not.toContain("workspace:");
    expect((await run([join(packed.installDir, "node_modules/.bin/frely-mcp"), "--help"], packed.installDir)).exitCode).toBe(0);
  } finally {
    await packed.cleanup();
  }
}, 60_000);

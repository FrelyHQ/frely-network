import { describe, expect, test } from "bun:test";
import { manifestDigest, parseReleaseArguments, releasePlan, writeManifestOnce } from "./release.mjs";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sourceSha = "a".repeat(40);

describe("frely-network release contract", () => {
  test("binds the release identity to the Network target and ctb-eu", () => {
    const plan = releasePlan({ version: "1.2.3", sha: sourceSha });
    expect(plan.target).toBe("frely-network");
    expect(plan.host).toBe("ctb-eu");
    expect(plan.compose_project).toBe("frely-network");
    expect(plan.release_tag).toBe("release/frely-network/v1.2.3");
    expect(plan.source_sha).toBe(sourceSha);
  });

  test("requires a semver and full source SHA for a build", () => {
    expect(parseReleaseArguments([
      "--target", "frely-network", "--version", "1.2.3", "--sha", sourceSha, "--stage", "build",
    ])).toMatchObject({ target: "frely-network", version: "1.2.3", sha: sourceSha, stage: "build" });
    expect(() => parseReleaseArguments([
      "--target", "frely-network", "--version", "1", "--sha", sourceSha, "--stage", "build",
    ])).toThrow();
  });

  test("requires an integrity digest for deploy and verify", () => {
    expect(() => parseReleaseArguments([
      "--target", "frely-network", "--stage", "deploy", "--manifest", "release.json",
    ])).toThrow();
    expect(parseReleaseArguments([
      "--target", "frely-network", "--stage", "verify", "--manifest", "release.json",
      "--manifest-digest", `sha256:${"b".repeat(64)}`,
    ])).toMatchObject({ stage: "verify", manifest: "release.json" });
  });

  test("produces a stable manifest digest", () => {
    expect(manifestDigest({ b: 2, a: 1 })).toBe(manifestDigest({ a: 1, b: 2 }));
  });

  test("does not overwrite an existing manifest with different content", () => {
    const path = join(mkdtempSync(join(tmpdir(), "frely-network-release-")), "manifest.json");
    const first = { release_id: "one" };
    writeManifestOnce(path, first);
    writeManifestOnce(path, first);
    expect(() => writeManifestOnce(path, { release_id: "two" })).toThrow();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(first);
  });
});

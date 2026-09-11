#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG = JSON.parse(readFileSync(new URL("./release-config.json", import.meta.url), "utf8"));
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function parseReleaseArguments(args) {
  const result = { target: null, version: null, sha: null, stage: "release", manifest: null, manifestDigest: null, dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") { result.dryRun = true; continue; }
    if (arg === "--help" || arg === "-h") return { help: true };
    const key = arg?.startsWith("--") ? arg.slice(2).replaceAll("-", "_") : "";
    if (!["target", "version", "sha", "stage", "manifest", "manifest_digest"].includes(key)) fail("release_argument_invalid");
    const value = args[++index];
    if (!value || value.startsWith("--")) fail("release_argument_missing");
    result[key === "manifest_digest" ? "manifestDigest" : key] = value;
  }
  if (result.target !== CONFIG.target.id) fail("release_target_invalid");
  if (!["build", "deploy", "verify", "release"].includes(result.stage)) fail("release_stage_invalid");
  if (["build", "release"].includes(result.stage)) {
    if (!VERSION.test(result.version ?? "") || !SHA.test(result.sha ?? "")) fail("release_identity_invalid");
  } else if (!result.manifest || !DIGEST.test(result.manifestDigest ?? "")) fail("release_manifest_input_invalid");
  return result;
}

export function releasePlan({ version, sha }) {
  if (!VERSION.test(version) || !SHA.test(sha)) fail("release_identity_invalid");
  return {
    schema: "frely-network.release-plan.v1",
    release_tag: `release/${CONFIG.target.tag_selector}/v${version}`,
    release_id: `v${version.replaceAll("+", "_")}-${sha.slice(0, 12)}`,
    version,
    source_sha: sha,
    target: CONFIG.target.id,
    host: CONFIG.target.deploy_host,
    instance: CONFIG.target.instance,
    compose_project: CONFIG.target.compose_project,
    environment: CONFIG.target.environment,
    platform: CONFIG.target.platform,
    public_health_url: CONFIG.target.public_health_url,
  };
}

export function manifestDigest(value) {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function build(options) {
  const plan = releasePlan(options);
  const head = run("git", ["rev-parse", "HEAD"]).trim();
  if (head !== plan.source_sha) fail("release_source_mismatch");
  const tag = `frely-network-broker-mcp:v${plan.version}-${plan.source_sha.slice(0, 12)}`;
  run("docker", ["build", "--platform", plan.platform, "--file", "Dockerfile", "--target", "runtime", "--tag", tag,
    "--label", `org.opencontainers.image.revision=${plan.source_sha}`,
    "--label", `org.opencontainers.image.version=${plan.version}`,
    "--label", `deployment.release-tag=${plan.release_tag}`,
    "--label", `deployment.release-id=${plan.release_id}`,
    "--label", `deployment.source-sha=${plan.source_sha}`,
    "--label", `deployment.instance=${plan.instance}`, "."]);
  const imageId = run("docker", ["image", "inspect", "--format", "{{.Id}}", tag]).trim();
  if (!DIGEST.test(imageId)) fail("release_image_identity_invalid");
  const manifest = { ...plan, image: { tag, digest: imageId, platform: plan.platform }, created_at: new Date().toISOString() };
  const output = options.manifest
    ? resolve(options.manifest)
    : resolve(CONFIG.host.release_state_root, `${plan.release_id}.json`);
  mkdirSync(dirname(output), { recursive: true, mode: 0o755 });
  writeManifestOnce(output, manifest);
  process.stdout.write(`${JSON.stringify({ schema: "frely-network.release-build-result.v1", status: "completed", manifest: output, manifest_digest: manifestDigest(manifest), release_id: plan.release_id })}\n`);
  return { manifest: output, digest: manifestDigest(manifest) };
}

export function writeManifestOnce(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const fd = openSync(path, "wx", 0o644);
    try { writeFileSync(fd, content); } finally { closeSync(fd); }
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let existing;
    try { existing = JSON.parse(readFileSync(path, "utf8")); } catch { fail("release_manifest_collision"); }
    if (manifestDigest(existing) !== manifestDigest(value)) fail("release_manifest_collision");
  }
}

function deploy(options) {
  const manifest = readManifest(options);
  assertHost();
  const compose = resolve(ROOT, CONFIG.target.compose_file);
  run("docker", ["compose", "-p", CONFIG.target.compose_project, "-f", compose, "--env-file", CONFIG.host.environment_file, "up", "-d", "--no-build", "--no-deps", "--pull", "never", "--wait", "--wait-timeout", "120", "broker-mcp"], {
    env: { FRELY_NETWORK_IMAGE: manifest.image.digest },
  });
  process.stdout.write(`${JSON.stringify({ schema: "frely-network.release-deploy-result.v1", status: "completed", release_id: manifest.release_id, target: manifest.target, host: manifest.host })}\n`);
}

function verify(options) {
  const manifest = readManifest(options);
  const result = run("curl", ["--fail", "--silent", "--show-error", "--max-time", "10", CONFIG.target.public_health_url]);
  if (!result.trim()) fail("release_health_empty");
  process.stdout.write(`${JSON.stringify({ schema: "frely-network.release-verify-result.v1", status: "completed", release_id: manifest.release_id, health: "passed" })}\n`);
}

export function readManifest(options) {
  const path = resolve(options.manifest);
  if (!existsSync(path)) fail("release_manifest_missing");
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { fail("release_manifest_invalid"); }
  if (manifestDigest(value) !== options.manifestDigest
    || value.target !== CONFIG.target.id
    || value.host !== CONFIG.target.deploy_host
    || value.compose_project !== CONFIG.target.compose_project
    || !DIGEST.test(value.image?.digest ?? "")
    || typeof value.image?.tag !== "string") fail("release_manifest_identity_invalid");
  return value;
}

function assertHost() {
  const hostId = readFileSync("/etc/deploy/host-id", "utf8").trim();
  if (hostId !== CONFIG.host.id) fail("release_host_invalid");
}

function run(command, args, options = {}) {
  try { return execFileSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: options.stdio ?? ["ignore", "pipe", "inherit"], env: { ...process.env, ...(options.env ?? {}) } }); }
  catch { fail("release_command_failed"); }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function fail(code) { throw Object.assign(new Error(code), { code }); }

export function main(args = process.argv.slice(2)) {
  const options = parseReleaseArguments(args);
  if (options.help) return;
  if (options.dryRun) { process.stdout.write(`${JSON.stringify({ schema: "frely-network.release-selection.v1", status: "parsed", target: options.target, stage: options.stage, ...(options.version && options.sha ? { plan: releasePlan(options) } : {}) })}\n`); return; }
  if (options.stage === "build") return build(options);
  if (options.stage === "deploy") return deploy(options);
  if (options.stage === "verify") return verify(options);
  const built = build(options);
  deploy({ ...options, manifest: built.manifest, manifestDigest: built.digest });
  return verify({ ...options, manifest: built.manifest, manifestDigest: built.digest });
}

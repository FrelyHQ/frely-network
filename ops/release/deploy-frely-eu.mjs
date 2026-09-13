#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const TARGET = "frely-network";
const HOST = "ctb-eu";
const IMAGE = "ghcr.io/frelyhq/frely-network";
const COMPOSE = "/opt/frely-eu/services/frely-network/compose.production.yaml";
const ENV_FILE = "/opt/frely-eu/services/frely-network/deployment.env";
const SERVICE = "broker-mcp";

function run(command, args, options = {}) {
  process.stdout.write(`$ ${command} ${args.join(" ")}\n`);
  return execFileSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit" });
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const version = arg("--version");
const sha = arg("--sha") ?? run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
const deploy = process.argv.includes("--deploy");
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("version must be SemVer via --version");
if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("sha must be a full 40-character commit SHA");

const tag = `${IMAGE}:v${version}-${sha.slice(0, 12)}`;
const manifestPath = resolve(ROOT, `.local/release/${TARGET}-v${version}.json`);
mkdirSync(resolve(ROOT, ".local/release"), { recursive: true });

run("ssh", [HOST, "node /opt/deploy/bin/deploy-compose-release.mjs --preflight --deployment-target frely-eu --postgres-target frely-eu --expected-host-contract-revision friday-relay.release-host-contract.v35"]);

run("bun", ["ops/release/release-cli.mjs", "--target", TARGET, "--version", version, "--sha", sha, "--stage", "build", "--manifest", manifestPath]);
const localDigest = JSON.parse(readFileSync(manifestPath, "utf8")).image.digest;
run("docker", ["tag", `frely-network-broker-mcp:v${version}-${sha.slice(0, 12)}`, tag]);
run("docker", ["push", tag]);
const remoteDigest = run("docker", ["buildx", "imagetools", "inspect", tag, "--format", "{{.Manifest.Digest}}"], { capture: true }).trim();
if (!/^sha256:[0-9a-f]{64}$/.test(remoteDigest)) throw new Error("registry digest unavailable");
const imageRef = `${IMAGE}@${remoteDigest}`;
writeFileSync(manifestPath, `${JSON.stringify({ target: TARGET, host: HOST, version, sha, image: imageRef, localDigest }, null, 2)}\n`, { mode: 0o600 });

if (!deploy) {
  process.stdout.write(`${JSON.stringify({ status: "ready_to_deploy", target: TARGET, host: HOST, version, sha, image: imageRef, manifest: manifestPath })}\n`);
  process.exit(0);
}

run("ssh", [HOST, `set -eu; export FRELY_NETWORK_IMAGE=${imageRef}; docker compose -p ${TARGET} -f ${COMPOSE} --env-file ${ENV_FILE} pull ${SERVICE}; docker compose -p ${TARGET} -f ${COMPOSE} --env-file ${ENV_FILE} up -d --no-build --no-deps --pull never --wait --wait-timeout 120 ${SERVICE}; docker inspect ${TARGET}-${SERVICE}-1 --format '{{.State.Status}} {{.State.Health.Status}} {{.Config.Image}}'; curl -fsS --max-time 10 https://network.frely.cloud/readyz`]);
process.stdout.write(`${JSON.stringify({ status: "deployed", target: TARGET, host: HOST, version, sha, image: imageRef })}\n`);

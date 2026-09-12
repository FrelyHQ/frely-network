#!/usr/bin/env bun
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { parseArgs } from "node:util";

export type LiveApproval = {
  targetSha: string;
  amountAtomic: string;
  requestId: string;
  authorizedAt: string;
  expiresAt: string;
};

export async function runLiveGate(input: {
  approvalPath: string;
  targetSha: string;
  amountAtomic: string;
  requestId: string;
  now?: () => number;
  initialize: () => Promise<void>;
}): Promise<{ exitCode: 0 | 2; code: "LIVE_GATE_PASSED" | "LIVE_PAYMENT_NOT_AUTHORIZED" | "LIVE_RUNNER_DISABLED" }> {
  try {
    if (!isAbsolute(input.approvalPath) || !input.approvalPath.includes(`${sep}.local${sep}`)) throw new Error();
    const info = await lstat(input.approvalPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 2 || info.size > 4096) throw new Error();
    const approval = parseApproval(JSON.parse(await readFile(input.approvalPath, "utf8")));
    const now = input.now?.() ?? Date.now();
    const authorized = Date.parse(approval.authorizedAt);
    const expires = Date.parse(approval.expiresAt);
    if (
      approval.targetSha !== input.targetSha ||
      approval.amountAtomic !== input.amountAtomic ||
      approval.requestId !== input.requestId ||
      !Number.isFinite(authorized) ||
      !Number.isFinite(expires) ||
      authorized > now ||
      expires <= now ||
      expires - authorized > 15 * 60 * 1000 ||
      !isIgnoredAndUntracked(input.approvalPath)
    ) throw new Error();
    try {
      await input.initialize();
    } catch {
      return { exitCode: 2, code: "LIVE_RUNNER_DISABLED" };
    }
    return { exitCode: 0, code: "LIVE_GATE_PASSED" };
  } catch {
    return { exitCode: 2, code: "LIVE_PAYMENT_NOT_AUTHORIZED" };
  }
}

function parseApproval(value: unknown): LiveApproval {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (
    keys.length !== 5 ||
    !["targetSha", "amountAtomic", "requestId", "authorizedAt", "expiresAt"].every((key) => keys.includes(key)) ||
    typeof object.targetSha !== "string" || !/^[0-9a-f]{40}$/u.test(object.targetSha) ||
    typeof object.amountAtomic !== "string" || !/^[1-9][0-9]*$/u.test(object.amountAtomic) ||
    typeof object.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/u.test(object.requestId) ||
    typeof object.authorizedAt !== "string" ||
    typeof object.expiresAt !== "string"
  ) throw new Error();
  return object as LiveApproval;
}

function isIgnoredAndUntracked(path: string): boolean {
  const root = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  if (root.exitCode !== 0) return false;
  const repository = root.stdout.toString().trim();
  const pathFromRoot = relative(repository, path);
  if (!pathFromRoot || pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) return false;
  const tracked = Bun.spawnSync(["git", "ls-files", "--error-unmatch", "--", pathFromRoot], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  if (tracked.exitCode === 0) return false;
  const ignored = Bun.spawnSync(["git", "check-ignore", "--quiet", "--", pathFromRoot], { cwd: repository, stdout: "pipe", stderr: "pipe" });
  return ignored.exitCode === 0;
}

if (import.meta.main) {
  let result: Awaited<ReturnType<typeof runLiveGate>> = { exitCode: 2, code: "LIVE_PAYMENT_NOT_AUTHORIZED" };
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      allowPositionals: false,
      options: {
        approval: { type: "string" },
        "target-sha": { type: "string" },
        "amount-atomic": { type: "string" },
        "request-id": { type: "string" },
      },
    });
    if (!parsed.values.approval || !parsed.values["target-sha"] || !parsed.values["amount-atomic"] || !parsed.values["request-id"]) throw new Error();
    result = await runLiveGate({
      approvalPath: parsed.values.approval,
      targetSha: parsed.values["target-sha"],
      amountAtomic: parsed.values["amount-atomic"],
      requestId: parsed.values["request-id"],
      initialize: async () => { throw new Error("LIVE_RUNNER_DISABLED"); },
    });
  } catch {}
  process.stderr.write(`${result.code}\n`);
  process.exitCode = result.exitCode;
}

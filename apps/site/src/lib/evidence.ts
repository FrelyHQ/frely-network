/**
 * API-010 stage names only (docs: Planned).
 * No HTTP client, no invented success payloads.
 * E consumes B's projection when available; until then UI stays empty/blocked.
 */
export const EVIDENCE_STAGES = [
  "discovered",
  "verified",
  "quoted",
  "payment_submitted",
  "verifying",
  "settled",
  "executing",
  "completed",
] as const;

export const EVIDENCE_TERMINAL = [
  "blocked",
  "failed",
  "payment_unknown",
] as const;

export type EvidenceStage = (typeof EVIDENCE_STAGES)[number];
export type EvidenceTerminal = (typeof EVIDENCE_TERMINAL)[number];

export type StageUiStatus = "not_provided" | "awaiting_api";

export const STAGE_LABELS: Record<EvidenceStage, string> = {
  discovered: "Discover",
  verified: "Verify",
  quoted: "HTTP 402 / Quote",
  payment_submitted: "Pay (submitted)",
  verifying: "Verify payment",
  settled: "Settled",
  executing: "Execute",
  completed: "Completed",
};

export const TERMINAL_LABELS: Record<EvidenceTerminal, string> = {
  blocked: "blocked",
  failed: "failed",
  payment_unknown: "payment_unknown",
};

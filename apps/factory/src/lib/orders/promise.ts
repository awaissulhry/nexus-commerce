/**
 * EPO.4 — promise integrity, pure. The first promise is immutable
 * (`Order.originalPromiseDateAt`, Amazon first-promise discipline); every
 * change lives in the audit trail; a SLIP is a change that moved the promise
 * LATER than the promise it replaced. At-risk fires BEFORE lateness: the days
 * left are fewer than the remaining stages need at historical pace. No Prisma,
 * no Date.now() — callers pass `now`.
 */

/** Count slips from the ordered audit trail of promise values (nulls = cleared, not slips). */
export function countSlips(originalISO: string | null, changes: (string | null)[]): number {
  let prev = originalISO;
  let slips = 0;
  for (const c of changes) {
    if (c && prev && new Date(c).getTime() > new Date(prev).getTime()) slips++;
    if (c) prev = c;
  }
  return slips;
}

/** States where a promise can still be defended (post-READY it's shipping's problem). */
const RISK_STATES = new Set(["CONFIRMED", "IN_PRODUCTION"]);

export type PromiseRisk = {
  atRisk: boolean;
  late: boolean;
  daysLeft: number | null;
  neededDays: number | null;
};

/**
 * At-risk = promise still in the future, but the remaining stages × the
 * historical per-stage pace won't fit in the time left. Late is its own state
 * (a late order is past risk). No history yet (perStageMs null) ⇒ never
 * at-risk — honest until data exists.
 */
export function promiseRisk(input: {
  promiseAtISO: string | null;
  state: string;
  remainingStages: number;
  perStageMs: number | null;
  now: number;
}): PromiseRisk {
  const none: PromiseRisk = { atRisk: false, late: false, daysLeft: null, neededDays: null };
  if (!input.promiseAtISO || !RISK_STATES.has(input.state)) return none;
  const msLeft = new Date(input.promiseAtISO).getTime() - input.now;
  const daysLeft = msLeft / 86_400_000;
  if (msLeft < 0) return { atRisk: false, late: true, daysLeft, neededDays: null };
  if (input.perStageMs == null || input.perStageMs <= 0 || input.remainingStages <= 0) return { ...none, daysLeft };
  const neededMs = input.remainingStages * input.perStageMs;
  return { atRisk: neededMs > msLeft, late: false, daysLeft, neededDays: neededMs / 86_400_000 };
}

export type AttentionReason = "late" | "at-risk" | "deposit-blocked" | "stalled";

/** ~a week of silence on an in-production order = stalled (no stage started or finished). */
export const STALLED_AFTER_MS = 7 * 86_400_000;

export function attentionReasons(input: {
  state: string;
  promiseAtISO: string | null;
  woBlocked: boolean;
  lastStageActivityISO: string | null;
  risk: PromiseRisk;
  now: number;
}): AttentionReason[] {
  const r: AttentionReason[] = [];
  if (input.risk.late) r.push("late");
  else if (input.risk.atRisk) r.push("at-risk");
  if (input.woBlocked) r.push("deposit-blocked");
  if (
    input.state === "IN_PRODUCTION" &&
    (!input.lastStageActivityISO || input.now - new Date(input.lastStageActivityISO).getTime() > STALLED_AFTER_MS)
  ) {
    r.push("stalled");
  }
  return r;
}

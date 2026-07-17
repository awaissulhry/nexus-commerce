/** EPO.4 — promise integrity folds: slips, pre-late risk, attention reasons. */
import { describe, expect, it } from "vitest";
import { attentionReasons, countSlips, promiseRisk, STALLED_AFTER_MS } from "@/lib/orders/promise";

const D = (s: string) => `${s}T12:00:00.000Z`;
const NOW = new Date(D("2026-07-17")).getTime();

describe("countSlips", () => {
  it("later = slip; earlier or equal = not; cleared = not", () => {
    expect(countSlips(D("2026-07-10"), [D("2026-07-15")])).toBe(1);
    expect(countSlips(D("2026-07-10"), [D("2026-07-08")])).toBe(0);
    expect(countSlips(D("2026-07-10"), [null, D("2026-07-20"), D("2026-07-18"), D("2026-07-25")])).toBe(2);
    expect(countSlips(null, [D("2026-07-10"), D("2026-07-12")])).toBe(1); // first set seeds, second slips
  });
});

describe("promiseRisk", () => {
  const base = { promiseAtISO: D("2026-07-20"), state: "IN_PRODUCTION", remainingStages: 4, now: NOW };
  it("needs more stage-time than remains ⇒ at risk (before lateness)", () => {
    expect(promiseRisk({ ...base, perStageMs: 86_400_000 }).atRisk).toBe(true); // 4 days work, 3 left
    expect(promiseRisk({ ...base, perStageMs: 0.5 * 86_400_000 }).atRisk).toBe(false); // 2 days work
  });
  it("past promise = late, not at-risk; READY/SHIPPED never flagged; no history ⇒ honest silence", () => {
    const r = promiseRisk({ ...base, promiseAtISO: D("2026-07-10"), perStageMs: 86_400_000 });
    expect(r.late).toBe(true);
    expect(r.atRisk).toBe(false);
    expect(promiseRisk({ ...base, state: "READY", perStageMs: 86_400_000 }).atRisk).toBe(false);
    expect(promiseRisk({ ...base, perStageMs: null }).atRisk).toBe(false);
  });
});

describe("attentionReasons", () => {
  const risk = (late: boolean, atRisk: boolean) => ({ late, atRisk, daysLeft: null, neededDays: null });
  it("late and at-risk are mutually exclusive; deposit + stalled stack", () => {
    expect(attentionReasons({ state: "IN_PRODUCTION", promiseAtISO: D("2026-07-10"), woBlocked: true, lastStageActivityISO: null, risk: risk(true, false), now: NOW })).toEqual(["late", "deposit-blocked", "stalled"]);
    expect(attentionReasons({ state: "CONFIRMED", promiseAtISO: D("2026-07-20"), woBlocked: false, lastStageActivityISO: null, risk: risk(false, true), now: NOW })).toEqual(["at-risk"]);
  });
  it("recent stage activity clears stalled", () => {
    const recent = new Date(NOW - STALLED_AFTER_MS / 2).toISOString();
    expect(attentionReasons({ state: "IN_PRODUCTION", promiseAtISO: null, woBlocked: false, lastStageActivityISO: recent, risk: risk(false, false), now: NOW })).toEqual([]);
  });
});

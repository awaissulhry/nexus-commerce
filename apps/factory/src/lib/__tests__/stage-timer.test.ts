/** FP6 — stage timing is the floor's source of truth; every state pinned here. */
import { describe, expect, it } from "vitest";
import { stageStatus, elapsedMs, start, pause, resume, finish, currentStage, woComplete, canStart, type StageTiming, type StageRow } from "../production/stage-timer";

const t = (o: Partial<StageTiming>): StageTiming => ({ startedAt: null, pausedMs: 0, pausedAt: null, finishedAt: null, ...o });
const D = (n: number) => new Date(n);

describe("stageStatus", () => {
  it("classifies each state", () => {
    expect(stageStatus(t({}))).toBe("not_started");
    expect(stageStatus(t({ startedAt: D(0) }))).toBe("running");
    expect(stageStatus(t({ startedAt: D(0), pausedAt: D(500) }))).toBe("paused");
    expect(stageStatus(t({ startedAt: D(0), finishedAt: D(900) }))).toBe("done");
  });
});

describe("elapsedMs excludes paused spans", () => {
  it("running: now − startedAt", () => {
    expect(elapsedMs(t({ startedAt: D(0) }), 1000)).toBe(1000);
  });
  it("paused: frozen at the moment of pause", () => {
    expect(elapsedMs(t({ startedAt: D(0), pausedAt: D(600) }), 1000)).toBe(600);
  });
  it("after resume: pausedMs is subtracted", () => {
    // worked 0–600, paused 600–1000 (400ms), resumed at 1000, now 1500
    expect(elapsedMs(t({ startedAt: D(0), pausedMs: 400 }), 1500)).toBe(1100);
  });
  it("done: fixed at finish", () => {
    expect(elapsedMs(t({ startedAt: D(0), pausedMs: 400, finishedAt: D(1500) }), 9999)).toBe(1100);
  });
  it("not started: zero", () => {
    expect(elapsedMs(t({}), 1000)).toBe(0);
  });
});

describe("transitions return patches and reject illegal moves", () => {
  it("start only from not_started", () => {
    expect(start(t({}), 100)).toEqual({ startedAt: D(100) });
    expect(start(t({ startedAt: D(0) }), 100)).toBeNull();
  });
  it("pause only while running; resume only while paused", () => {
    expect(pause(t({ startedAt: D(0) }), 600)).toEqual({ pausedAt: D(600) });
    expect(pause(t({ startedAt: D(0), pausedAt: D(600) }), 700)).toBeNull();
    expect(resume(t({ startedAt: D(0), pausedAt: D(600) }), 1000)).toEqual({ pausedMs: 400, pausedAt: null });
    expect(resume(t({ startedAt: D(0) }), 1000)).toBeNull();
  });
  it("finish folds an in-progress pause, then closes", () => {
    expect(finish(t({ startedAt: D(0), pausedAt: D(600) }), 1000)).toEqual({ pausedMs: 400, pausedAt: null, finishedAt: D(1000) });
    expect(finish(t({ startedAt: D(0), pausedMs: 200 }), 1000)).toEqual({ pausedMs: 200, pausedAt: null, finishedAt: D(1000) });
    expect(finish(t({}), 1000)).toBeNull();
  });
});

describe("work-order derivations", () => {
  const rows = (spec: [string, number, boolean][]): StageRow[] => spec.map(([stage, sort, done]) => ({ id: stage, stage, sort, startedAt: done ? D(0) : null, pausedMs: 0, pausedAt: null, finishedAt: done ? D(1) : null }));

  it("currentStage is the first unfinished, in sort order", () => {
    const s = rows([["CUTTING", 0, true], ["STITCHING", 1, false], ["QC", 2, false]]);
    expect(currentStage(s)?.stage).toBe("STITCHING");
    expect(currentStage(rows([["A", 0, true]]))).toBeNull();
  });
  it("woComplete when every stage finished", () => {
    expect(woComplete(rows([["A", 0, true], ["B", 1, true]]))).toBe(true);
    expect(woComplete(rows([["A", 0, true], ["B", 1, false]]))).toBe(false);
    expect(woComplete([])).toBe(false);
  });
  it("canStart only when all earlier stages are finished (forward-only)", () => {
    const s = rows([["CUTTING", 0, true], ["STITCHING", 1, false], ["QC", 2, false]]);
    expect(canStart(s, "STITCHING")).toBe(true);
    expect(canStart(s, "QC")).toBe(false); // STITCHING not done
  });
});

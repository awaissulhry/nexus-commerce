/**
 * FP6 — stage timing (pure). A stage is timed by three fields: `startedAt`,
 * `pausedMs` (total paused ms from completed pauses), and `pausedAt` (set while
 * currently paused). Active worked time excludes all paused spans. Transitions
 * return the field patch to persist — the route is a thin wrapper. No Date.now()
 * here: the caller passes `now` so the logic is deterministic + testable.
 */
export type StageTiming = { startedAt: Date | string | null; pausedMs: number; pausedAt: Date | string | null; finishedAt: Date | string | null };
export type StageStatus = "not_started" | "running" | "paused" | "done";

const ms = (d: Date | string | null): number | null => (d == null ? null : (d instanceof Date ? d.getTime() : new Date(d).getTime()));

export function stageStatus(s: StageTiming): StageStatus {
  if (s.finishedAt) return "done";
  if (!s.startedAt) return "not_started";
  return s.pausedAt ? "paused" : "running";
}

/** Active worked milliseconds (paused spans excluded). `nowMs` = current epoch ms. */
export function elapsedMs(s: StageTiming, nowMs: number): number {
  const started = ms(s.startedAt);
  if (started == null) return 0;
  const end = ms(s.finishedAt) ?? nowMs;
  const currentPause = s.pausedAt ? end - (ms(s.pausedAt) as number) : 0;
  return Math.max(0, end - started - s.pausedMs - currentPause);
}

/** The transitions — each returns the partial fields to write. Illegal ⇒ null. */
export function start(s: StageTiming, nowMs: number): Partial<StageTiming> | null {
  if (stageStatus(s) !== "not_started") return null;
  return { startedAt: new Date(nowMs) };
}
export function pause(s: StageTiming, nowMs: number): Partial<StageTiming> | null {
  if (stageStatus(s) !== "running") return null;
  return { pausedAt: new Date(nowMs) };
}
export function resume(s: StageTiming, nowMs: number): Partial<StageTiming> | null {
  if (stageStatus(s) !== "paused") return null;
  return { pausedMs: s.pausedMs + (nowMs - (ms(s.pausedAt) as number)), pausedAt: null };
}
export function finish(s: StageTiming, nowMs: number): Partial<StageTiming> | null {
  const st = stageStatus(s);
  if (st !== "running" && st !== "paused") return null;
  // fold an in-progress pause into pausedMs, then close the stage
  const foldedPause = s.pausedAt ? nowMs - (ms(s.pausedAt) as number) : 0;
  return { pausedMs: s.pausedMs + foldedPause, pausedAt: null, finishedAt: new Date(nowMs) };
}

// ── Work-order-level derivations over its ordered stages ──────────
export type StageRow = StageTiming & { id: string; stage: string; sort: number };

export function sortStages<T extends { sort: number }>(stages: T[]): T[] {
  return [...stages].sort((a, b) => a.sort - b.sort);
}

/** The current stage = the first unfinished one (in sort order); null ⇒ all done. */
export function currentStage(stages: StageRow[]): StageRow | null {
  return sortStages(stages).find((s) => !s.finishedAt) ?? null;
}

export function woComplete(stages: StageRow[]): boolean {
  return stages.length > 0 && stages.every((s) => !!s.finishedAt);
}

/** A stage may only start when every earlier stage is finished (forward-only floor). */
export function canStart(stages: StageRow[], stageId: string): boolean {
  const ordered = sortStages(stages);
  const idx = ordered.findIndex((s) => s.id === stageId);
  if (idx < 0) return false;
  return ordered.slice(0, idx).every((s) => !!s.finishedAt);
}

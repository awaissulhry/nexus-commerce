/**
 * FP10 — stage lead times: the median active time each stage takes (CUTTING…
 * PACKING), from the FP6 pause-aware `elapsedMs` on FINISHED stages only. The
 * bottleneck is the slowest median — a decision, not just a bar. Pure.
 */
import { elapsedMs, type StageTiming } from "../production/stage-timer";

export type StageLead = { stage: string; medianMs: number; count: number };
export type StageRow = StageTiming & { stage: string };

export function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid];
}

/** Median active ms per stage, over completed stages. `nowMs` is unused for done stages but kept for the signature. */
export function stageLeadTimes(stages: StageRow[], nowMs: number): StageLead[] {
  const by = new Map<string, number[]>();
  for (const s of stages) {
    if (!s.finishedAt) continue; // only completed stages have a lead time
    const arr = by.get(s.stage) ?? [];
    arr.push(elapsedMs(s, nowMs));
    by.set(s.stage, arr);
  }
  return [...by.entries()].map(([stage, xs]) => ({ stage, medianMs: median(xs), count: xs.length }));
}

export function bottleneck(rows: StageLead[]): StageLead | null {
  if (rows.length === 0) return null;
  return rows.reduce((max, r) => (r.medianMs > max.medianMs ? r : max), rows[0]);
}

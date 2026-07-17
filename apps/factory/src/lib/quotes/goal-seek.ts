/**
 * EPQ.3 — goal-seek for the editor rail (kills seam S7): type a target QUOTE
 * net (or margin %) and solve the ACTIVE LINE's per-unit adjustment that lands
 * there. Reuses the FP2 engine's goalSeekByNet/goalSeekByMargin verbatim on an
 * aggregated base (other lines' persisted totals + this line's composed
 * list/cost × qty) — no forked math. The only new arithmetic is dividing the
 * solved total adjustment across the line's qty units (nearest cent), so a
 * qty-1 line round-trips exactly and a qty-N line lands within N/2 cents.
 */
import { goalSeekByMargin, goalSeekByNet } from "@/lib/pricing";

export type GoalSeekBy = "net" | "margin";

/** The active line as composed WITHOUT adjustment (per-unit money) + its qty. */
export type GoalSeekLine = { listPriceCents: number; costCents: number; qty: number };

/** Every OTHER line's persisted totals (net × qty and cost × qty, summed). */
export type GoalSeekOthers = { netCents: number; costCents: number };

export type GoalSeekSolution = {
  adjustmentCents: number; // per-unit, ready for the normal line PATCH
  projected: { netCents: number; costCents: number; marginCents: number; marginPct: number }; // quote-level after applying
};

export function solveLineAdjustment(by: GoalSeekBy, value: number, line: GoalSeekLine, others: GoalSeekOthers): GoalSeekSolution {
  const base = {
    listPriceCents: others.netCents + line.listPriceCents * line.qty,
    costCents: others.costCents + line.costCents * line.qty,
  };
  const gs = by === "net" ? goalSeekByNet(base, value) : goalSeekByMargin(base, value);
  const qty = Math.max(1, line.qty);
  const adjustmentCents = Math.round(gs.adjustmentCents / qty);
  const netCents = others.netCents + (line.listPriceCents + adjustmentCents) * qty;
  const marginCents = netCents - base.costCents;
  const marginPct = netCents === 0 ? 0 : (marginCents / netCents) * 100;
  return { adjustmentCents, projected: { netCents, costCents: base.costCents, marginCents, marginPct } };
}

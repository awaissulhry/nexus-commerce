/**
 * FP9.1 — the money page's data: headline tiles + a per-order rollup. Actual
 * cost is the FP6 number (Σ OUT movements × material cost across the order's work
 * orders); an order that hasn't consumed yet shows its estimate, flagged. Money
 * grain-stripped at the edge (defence in depth — the page itself is the gate).
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { tiles } from "@/lib/financials/rollup";
import { loadOrderFinancials } from "@/lib/financials/load";

export const permission = PAGES.financials;

export const GET = guarded(PAGES.financials, async (req, { resolved }) => {
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const createdAt = from || to ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } : undefined;

  const fins = await loadOrderFinancials(createdAt);
  const monthKey = new Date().toISOString().slice(0, 7);
  return jsonStripped({ monthKey, tiles: tiles(fins, monthKey), orders: fins }, resolved);
});

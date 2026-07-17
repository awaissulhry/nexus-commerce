/**
 * FP9.1 — the money page's data: headline tiles + a per-order rollup. Actual
 * cost is the FP6 number (Σ OUT movements × material cost across the order's work
 * orders); an order that hasn't consumed yet shows its estimate, flagged. Money
 * grain-stripped at the edge (defence in depth — the page itself is the gate).
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { tiles, cancelledWithMoney, romeMonthKey } from "@/lib/financials/rollup";
import { loadOrderFinancials, loadMonthMoney } from "@/lib/financials/load";

export const permission = PAGES.financials;

export const GET = guarded(PAGES.financials, async (req, { resolved }) => {
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const createdAt = from || to ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } : undefined;

  // EPF1 (D-13): the current month is a Rome month; its invoiced/paid tile
  // figures come from TZ-exact range-bounded SQL sums (loadMonthMoney), not
  // from materializing 90k document rows — the split-path hot loader.
  const monthKey = romeMonthKey(new Date().toISOString());
  // EPF1 (D-04): cancelled orders carrying money ride along and are split into
  // their own bucket — visible beside the tiles, never inside them.
  const [all, month] = await Promise.all([
    loadOrderFinancials(createdAt, { includeCancelledMoney: true }),
    loadMonthMoney(monthKey, { createdAt }),
  ]);
  const fins = all.filter((f) => f.state !== "CANCELLED");
  // FS1 — tiles fold over EVERY order; the by-order table ships a bounded page
  // (22.5 MB → <500 KB at 50k orders). FS3 adds paging UI; till then the count
  // is surfaced so nothing is silently hidden.
  const TAKE = 200;
  return jsonStripped(
    { monthKey, tiles: tiles(fins, month), orders: fins.slice(0, TAKE), ordersTotal: fins.length, cancelledWithMoney: cancelledWithMoney(all) },
    resolved,
  );
});

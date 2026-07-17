/**
 * FP9.1 — the money page's data: headline tiles + a per-order rollup. Actual
 * cost is the FP6 number (Σ OUT movements × material cost across the order's work
 * orders); an order that hasn't consumed yet shows its estimate, flagged. Money
 * grain-stripped at the edge (defence in depth — the page itself is the gate).
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { tiles, cancelledWithMoney, romeMonthKey, topNewest } from "@/lib/financials/rollup";
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
  // sorted:false — the fold is order-independent and the page needs only the
  // newest 200, selected via topNewest (kills the 48.9k-row SQL sort)
  const [all, month] = await Promise.all([
    loadOrderFinancials(createdAt, { includeCancelledMoney: true, sorted: false }),
    loadMonthMoney(monthKey, { createdAt }),
  ]);
  const fins = all.filter((f) => f.state !== "CANCELLED");
  // FS1 — tiles fold over EVERY order; the by-order table ships a bounded page
  // (22.5 MB → <500 KB at 50k orders). FS3 adds paging UI; till then the count
  // is surfaced so nothing is silently hidden.
  const TAKE = 200;
  // The cancelled-money bucket ships its SUMS + a bounded sample — the full
  // row set (~1.1k orders at the 50k harness) is 500 KB of payload the page
  // never renders; the count keeps nothing silently hidden.
  const cancelled = cancelledWithMoney(all);
  return jsonStripped(
    {
      monthKey,
      tiles: tiles(fins, month),
      orders: topNewest(fins, TAKE),
      ordersTotal: fins.length,
      cancelledWithMoney: { ...cancelled, orders: cancelled.orders.slice(0, 50) },
    },
    resolved,
  );
});

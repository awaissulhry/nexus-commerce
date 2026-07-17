/**
 * FP9.1 — the money page's data: headline tiles + a per-order rollup. Actual
 * cost is the FP6 number (Σ OUT movements × material cost across the order's work
 * orders); an order that hasn't consumed yet shows its estimate, flagged. Money
 * grain-stripped at the edge (defence in depth — the page itself is the gate).
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { tiles, cancelledWithMoney, romeMonthKey } from "@/lib/financials/rollup";
import { loadOrderFinancials } from "@/lib/financials/load";

export const permission = PAGES.financials;

export const GET = guarded(PAGES.financials, async (req, { resolved }) => {
  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const createdAt = from || to ? { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } : undefined;

  // EPF1 (D-04): cancelled orders carrying money ride along and are split into
  // their own bucket — visible beside the tiles, never inside them.
  const all = await loadOrderFinancials(createdAt, { includeCancelledMoney: true });
  const fins = all.filter((f) => f.state !== "CANCELLED");
  // EPF1 (D-13): the current month is a Rome month, and the tiles bucket by
  // invoice-issue/payment-received dates inside the fold.
  const monthKey = romeMonthKey(new Date().toISOString());
  // FS1 — tiles fold over EVERY order; the by-order table ships a bounded page
  // (22.5 MB → <500 KB at 50k orders). FS3 adds paging UI; till then the count
  // is surfaced so nothing is silently hidden.
  const TAKE = 200;
  return jsonStripped(
    { monthKey, tiles: tiles(fins, monthKey), orders: fins.slice(0, TAKE), ordersTotal: fins.length, cancelledWithMoney: cancelledWithMoney(all) },
    resolved,
  );
});

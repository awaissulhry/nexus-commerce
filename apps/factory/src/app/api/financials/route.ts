/**
 * FP9.1 → EPF2 — the money page's data: headline tiles + a per-order rollup.
 * Actual cost is the FP6 number (Σ OUT movements × material cost across the
 * order's work orders); an order that hasn't consumed yet shows its estimate,
 * flagged. Money grain-stripped at the edge (defence in depth — the page
 * itself is the gate).
 *
 * EPF2: `from`/`to` are Rome-local days (romeDayWindowUtc — was raw UTC
 * Date parsing), `party` scopes the fold to one customer (EPO D-5 law), the
 * by-order list is a REAL cursor page (`cursor` = createdAtISO~orderId,
 * newest-first — the "Showing N of M" dead-end became Load-more), and rows
 * are projected through `projectHotOrder` (the degraded month maps + invoice
 * numbers no longer ship; the by-month tab reads /period's doc-dates fold).
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { tiles, cancelledWithMoney, romeMonthKey, topNewest, projectHotOrder } from "@/lib/financials/rollup";
import { loadOrderFinancials, loadMonthMoney } from "@/lib/financials/load";
import { romeDayWindowUtc } from "@/lib/financials/rome-time";
import { encodeOrderCursor, parseOrderCursor } from "@/lib/financials/money-ux";

export const permission = PAGES.financials;

export const GET = guarded(PAGES.financials, async (req, { resolved }) => {
  const url = new URL(req.url);
  // EPF2: Rome-day window semantics (a `from` of 2026-07-01 starts at Rome
  // midnight, not UTC midnight) + the ?party= scope, both index-backed.
  const createdAt = romeDayWindowUtc(url.searchParams.get("from"), url.searchParams.get("to"));
  const partyId = url.searchParams.get("party")?.trim() || undefined;
  const before = parseOrderCursor(url.searchParams.get("cursor"));

  // EPF1 (D-13): the current month is a Rome month; its invoiced/paid tile
  // figures come from TZ-exact range-bounded SQL sums (loadMonthMoney), not
  // from materializing 90k document rows — the split-path hot loader.
  const monthKey = romeMonthKey(new Date().toISOString());
  // EPF1 (D-04): cancelled orders carrying money ride along and are split into
  // their own bucket — visible beside the tiles, never inside them.
  // sorted:false — the fold is order-independent and the page needs only the
  // newest 200, selected via topNewest (kills the 48.9k-row SQL sort)
  const [all, month] = await Promise.all([
    loadOrderFinancials(createdAt, { includeCancelledMoney: true, sorted: false, partyId }),
    loadMonthMoney(monthKey, { createdAt, partyId }),
  ]);
  const fins = all.filter((f) => f.state !== "CANCELLED");
  // FS1 — tiles fold over EVERY order; the by-order table ships a bounded page
  // (22.5 MB → <500 KB at 50k orders). EPF2 — the page is cursored: the client
  // appends the next 200 on demand instead of dead-ending at a truncation note.
  const TAKE = 200;
  const page = topNewest(fins, TAKE, before ?? undefined);
  const last = page.length > 0 ? page[page.length - 1] : null;
  // The cancelled-money bucket ships its SUMS + a bounded sample — the full
  // row set (~1.1k orders at the 50k harness) is 500 KB of payload the page
  // never renders; the count keeps nothing silently hidden.
  const cancelled = cancelledWithMoney(all);
  return jsonStripped(
    {
      monthKey,
      tiles: tiles(fins, month),
      orders: page.map(projectHotOrder),
      ordersTotal: fins.length,
      nextCursor: page.length === TAKE && last ? encodeOrderCursor({ createdAtISO: last.createdAtISO, orderId: last.orderId }) : null,
      cancelledWithMoney: { count: cancelled.count, paidCents: cancelled.paidCents, invoicedCents: cancelled.invoicedCents, orders: cancelled.orders.slice(0, 50).map(projectHotOrder) },
    },
    resolved,
  );
});

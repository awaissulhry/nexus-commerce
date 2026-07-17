/**
 * FP9.4 → EPF2 — money by customer: revenue / paid / outstanding / actual
 * margin per party. Money grain-stripped. EPF2: accepts the same Rome-day
 * `from`/`to` window and `?party=` scope as the main route (bounded — the fold
 * is SQL aggregates), so the tab always honors the page's active filters.
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { partyRollup } from "@/lib/financials/rollup";
import { loadOrderFinancials } from "@/lib/financials/load";
import { romeDayWindowUtc } from "@/lib/financials/rome-time";

export const permission = PAGES.financials;

export const GET = guarded(PAGES.financials, async (req, { resolved }) => {
  const url = new URL(req.url);
  const createdAt = romeDayWindowUtc(url.searchParams.get("from"), url.searchParams.get("to"));
  const partyId = url.searchParams.get("party")?.trim() || undefined;
  return jsonStripped({ parties: partyRollup(await loadOrderFinancials(createdAt, { sorted: false, partyId })) }, resolved);
});

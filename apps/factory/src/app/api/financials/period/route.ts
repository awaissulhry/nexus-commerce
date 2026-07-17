/**
 * FP9.4 — money by month: revenue / invoiced / paid / outstanding / actual
 * margin per calendar month. Grain-stripped. EPF1: the by-month table
 * genuinely needs per-document Rome month keys, so this route opts into the
 * loader's doc-dates path (off the hot p50 gate by design). EPF2: same
 * Rome-day `from`/`to` window + `?party=` scope as the main route — the tab
 * follows the page filters (window applies to order-creation date; invoiced/
 * paid columns keep their own document-date buckets, labeled in the fold).
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { periodRollup } from "@/lib/financials/rollup";
import { loadOrderFinancials } from "@/lib/financials/load";
import { romeDayWindowUtc } from "@/lib/financials/rome-time";

export const permission = PAGES.financials;

export const GET = guarded(PAGES.financials, async (req, { resolved }) => {
  const url = new URL(req.url);
  const createdAt = romeDayWindowUtc(url.searchParams.get("from"), url.searchParams.get("to"));
  const partyId = url.searchParams.get("party")?.trim() || undefined;
  return jsonStripped({ months: periodRollup(await loadOrderFinancials(createdAt, { sorted: false, docDates: true, partyId })) }, resolved);
});

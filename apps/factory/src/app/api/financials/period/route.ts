/**
 * FP9.4 — money by month: revenue / invoiced / paid / outstanding / actual
 * margin per calendar month. Grain-stripped. EPF1: the by-month table
 * genuinely needs per-document Rome month keys, so this route opts into the
 * loader's doc-dates path (off the hot p50 gate by design).
 */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { periodRollup } from "@/lib/financials/rollup";
import { loadOrderFinancials } from "@/lib/financials/load";

export const permission = PAGES.financials;

export const GET = guarded(PAGES.financials, async (_req, { resolved }) => {
  return jsonStripped({ months: periodRollup(await loadOrderFinancials(undefined, { sorted: false, docDates: true })) }, resolved);
});

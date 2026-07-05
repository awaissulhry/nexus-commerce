/** FP9.4 — money by customer: revenue / paid / outstanding / actual margin per party. Money grain-stripped. */
import { guarded, jsonStripped } from "@/lib/auth/guard";
import { PAGES } from "@/lib/auth/permissions";
import { partyRollup } from "@/lib/financials/rollup";
import { loadOrderFinancials } from "@/lib/financials/load";

export const permission = PAGES.financials;

export const GET = guarded(PAGES.financials, async (_req, { resolved }) => {
  return jsonStripped({ parties: partyRollup(await loadOrderFinancials()) }, resolved);
});

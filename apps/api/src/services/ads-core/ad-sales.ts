/**
 * ADM-P6/DC — THE definition of ad-attributed sales, in one place.
 *
 * 🔴 Why this exists. Fourteen readers across five files open-coded:
 *
 *     const salesCents = (sum.sales7dCents ?? 0) + (sum.sales14dCents ?? 0)
 *
 * That was correct only under an unwritten contract — each ad product populates exactly ONE of the
 * two columns, so the sum picks whichever is real. `sales14dCents` therefore meant two different
 * things at once: "the Sponsored Brands headline" to every reader, and "the 14-day attribution
 * window" to the report ingest. One column, two meanings, and nothing enforcing either.
 *
 * The overloading became live on 2026-08-22. A widened ingest — authored but never landed — was run
 * locally against production and wrote a REAL 14-day figure for 301 Sponsored PRODUCTS rows. Those
 * rows were then summed with themselves. Measured over the last 30 days: **EUR 18,953 of ad sales
 * shown against EUR 9,483 true**, every affected ACoS exactly halved (ES_Phrase_3_Keywords read
 * 20.6% where the truth is 45.3%). Not only a display fault — the rule engine reads ACoS, so a
 * campaign truly at 46.8% could never trip a 40% threshold.
 *
 * THE CONTRACT, now singular and enforced at the write boundary in `ads-reports.service.ts`:
 *
 *   sales7dCents   the HEADLINE ad-attributed sales, for every ad product without exception.
 *                  SP writes its 7-day figure, SD and SB write theirs. This is what "sales" means.
 *   sales14dCents  the 14-day attribution WINDOW and nothing else. Never part of the headline,
 *                  never summed with the above, safe to populate for any product.
 *
 * Sponsored Brands was the only product routed into the 14-day column, and there has never been a
 * single SB row in this account — measured all-time, all entity types, zero — so moving it needs no
 * migration and changes no existing number.
 */

/** The `_sum` shape every daily-performance aggregate produces. */
export interface AdSalesSums {
  sales7dCents?: number | null
  /** Present on many callers' selects; deliberately NOT read. See the contract above. */
  sales14dCents?: number | null
}

/**
 * Ad-attributed sales in cents.
 *
 * Takes the aggregate rather than the two numbers so that a caller cannot pass them in the wrong
 * order, and so the one place that decides which column is the headline is this function.
 */
export function adSalesCents(sums: AdSalesSums | null | undefined): number {
  return sums?.sales7dCents ?? 0
}

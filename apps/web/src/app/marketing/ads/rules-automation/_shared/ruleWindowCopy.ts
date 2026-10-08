/**
 * ruleWindowCopy.ts — the rule builder's words for WHICH DAYS a rule reads.
 *
 * 6c (2026-10-04; review G.2, Owner decision S9) — every rule window ends at the ad product's
 * attribution lag: 7 days ago for Sponsored Products, 14 for Sponsored Brands and Display. Amazon
 * keeps adding sales to a day for that long, so a rule that read the newest days saw spend with no
 * sales yet. The phrase comes from `@nexus/shared/data-vintage`, the same function the API's
 * sentences use, so the builder and the engine cannot describe different days.
 *
 * BB-14 (2026-10-08) — the engine's window now ends at the newest day Amazon has SETTLED (a re-read of the day asked at
 * least 7 / 14 days after it): normally one day past the attribution lag, 8 days ago for Sponsored Products and 15 for
 * Brands and Display; until a settled re-read exists, at the lag itself. The builder cannot read that fact, so it says
 * the rule and the normal case; the API's sentences (`settledEndText`) say the exact day.
 */
import { settledLagDays } from '@nexus/shared/data-vintage'

/** The days ago a window normally ends once the nightly re-read has settled the day: the lag plus one. */
const settledAgo = (adProduct: string) => settledLagDays(adProduct) + 1

/** "the last 30 days, ending at the newest day Amazon has settled (normally 8 days ago; 15 for Sponsored Brands and Display)" */
export const settledWindowText = (days: number): string =>
  `the last ${days} days, ending at the newest day Amazon has settled (normally ${settledAgo('SPONSORED_PRODUCTS')} days ago; ${settledAgo('SPONSORED_BRANDS')} for Sponsored Brands and Display)`

/** Why the newest days are left out, in one plain sentence. */
export const LATE_SALES_NOTE = 'Amazon is still adding late sales to the newest days.'

/**
 * What a builder rule stores as its `exclude`, beside its lookback: Sponsored Products' lag. A record
 * of what the author was told — the engine and the review queue never read it.
 */
export const SETTLED_EXCLUDE_LABEL = `Last ${settledLagDays('SPONSORED_PRODUCTS')} Days`

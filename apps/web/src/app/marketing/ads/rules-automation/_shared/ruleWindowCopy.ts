/**
 * ruleWindowCopy.ts — the rule builder's words for WHICH DAYS a rule reads.
 *
 * 6c (2026-10-04; review G.2, Owner decision S9) — every rule window ends at the ad product's
 * attribution lag: 7 days ago for Sponsored Products, 14 for Sponsored Brands and Display. Amazon
 * keeps adding sales to a day for that long, so a rule that read the newest days saw spend with no
 * sales yet. The phrase comes from `@nexus/shared/data-vintage`, the same function the API's
 * sentences use, so the builder and the engine cannot describe different days.
 */
import { settledEndPhrase, settledLagDays } from '@nexus/shared/data-vintage'

/** "the last 30 days, ending 7 days ago (14 for Sponsored Brands and Display)" */
export const settledWindowText = (days: number): string => `the last ${days} days, ${settledEndPhrase()}`

/** Why the newest days are left out, in one plain sentence. */
export const LATE_SALES_NOTE = 'Amazon is still adding late sales to the newest days.'

/**
 * What a builder rule stores as its `exclude`, beside its lookback: Sponsored Products' lag. A record
 * of what the author was told — the engine and the review queue never read it.
 */
export const SETTLED_EXCLUDE_LABEL = `Last ${settledLagDays('SPONSORED_PRODUCTS')} Days`

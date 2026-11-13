/**
 * B-W2b-358 (PRD-017, SAL-292, SAL-300): the made-to-measure line rule's codes (api modules/sales/mtm/line-check.ts, one rule of
 * api sales/line-checks). They are also send checks of a quote (sales/quotes/send SEND_CHECK_CODES lists them) and findings of
 * an order's line checks. No imports: send.ts reads it without the rules.
 *
 *   MTM_NOT_STARTED     BLOCKS   the style is not made to measure, has no template, its template's rules are off (made-to-measure
 *                                not started, GATE-MTM), or the rider was measured for another garment type
 *   MTM_OUTSIDE_RANGE   BLOCKS   the one check (B-W2b-248) blocks the unit: a blocking rule, an alteration beyond its limit or
 *                                the certificate's refusal (outside the certified basic model, PRD-288)
 *   MTM_NOT_CONFIRMED   WARNING  the factory has not confirmed the measures yet (waiting, or more was asked): the order waits
 *   MTM_NOT_LATEST      WARNING  the rider has a newer revision than the one the line is made to
 *   MTM_OLD_MEASURES    WARNING  the measures are older than 12 months: ask for a new measure
 */
export const MTM_LINE_CODES = ['MTM_NOT_STARTED', 'MTM_OUTSIDE_RANGE', 'MTM_NOT_CONFIRMED', 'MTM_NOT_LATEST', 'MTM_OLD_MEASURES'] as const
export type MtmLineCode = (typeof MTM_LINE_CODES)[number]

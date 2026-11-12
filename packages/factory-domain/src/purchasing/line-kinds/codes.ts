/**
 * B-W2b-328 (purchase lines by kind): the send checks this step adds to W1's (purchasing/orders SEND_CHECK_CODES lists them
 * after B-W2b-296's, so the contracts' enum knows them). No import: purchasing/orders.ts reads this file.
 *
 *   ROLLS_NOT_THE_QUANTITY     a line bought by rolls no longer is its rolls × length (× width) in its unit (SCM-076)
 *   PPE_NO_CERTIFICATE         a PPE component's line (a protector) names no certificate while the register has one that
 *                              covers it from this supplier (SCM-077); a warning when the register has none, or on a sample
 *                              order (development parts are often not certified yet)
 *   PPE_CERTIFICATE_NOT_VALID  the certificate a line names no longer holds today (suspended, withdrawn, expired), no longer
 *                              covers the line's material, or covers it only as bought from another supplier
 *   PPE_CERTIFICATE_ENDS_EARLY a warning: the certificate ends before the line's need date (the goods may come after it)
 *   VARIANT_NOT_USABLE         the variant a line buys was archived, or is of another colour than the line (SCM-186)
 */
export const LINE_KIND_SEND_CHECK_CODES = ['ROLLS_NOT_THE_QUANTITY', 'PPE_NO_CERTIFICATE', 'PPE_CERTIFICATE_NOT_VALID', 'PPE_CERTIFICATE_ENDS_EARLY', 'VARIANT_NOT_USABLE'] as const
export type LineKindSendCheckCode = (typeof LINE_KIND_SEND_CHECK_CODES)[number]

/** One check of this step, in the shape of W1's SendCheck. */
export interface LineKindCheck {
  readonly code: LineKindSendCheckCode
  readonly severity: 'BLOCKS' | 'WARNING'
  readonly path: string
  readonly message: string
}

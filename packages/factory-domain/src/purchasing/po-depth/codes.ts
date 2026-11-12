/**
 * B-W2b-296 (purchase orders in depth): the send checks this step adds to W1's (purchasing/orders SEND_CHECK_CODES lists
 * them after its own, so the contracts' enum knows them). No import: purchasing/orders.ts reads this file.
 *
 *   SCHEDULE_NOT_THE_LINE     a line's deliveries no longer add up to the line, or the first is not on its need date
 *   DELIVERY_DATE_PAST        a delivery of a line is asked for a day that is past
 *   NO_RATE_AT_ORDER          the order is in another currency than its company's and has no rate at order (SCM-065)
 *   SHIP_TO_NOT_USABLE        the third party it ships to, or its address, cannot take the goods any more (SCM-066)
 *   SHIP_TO_NO_WORKSHOP_PLACE a warning: it ships to a workshop that has no place of ours on the order's site, so the
 *                             receipt cannot land on the workshop's stock (SCM-147)
 */
export const DEPTH_SEND_CHECK_CODES = ['SCHEDULE_NOT_THE_LINE', 'DELIVERY_DATE_PAST', 'NO_RATE_AT_ORDER', 'SHIP_TO_NOT_USABLE', 'SHIP_TO_NO_WORKSHOP_PLACE'] as const
export type DepthSendCheckCode = (typeof DEPTH_SEND_CHECK_CODES)[number]

/** One check of this step, in the shape of W1's SendCheck. */
export interface DepthCheck {
  readonly code: DepthSendCheckCode
  readonly severity: 'BLOCKS' | 'WARNING'
  readonly path: string
  readonly message: string
}

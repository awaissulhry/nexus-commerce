import type { BusinessDate } from '../../core/time'
import { Dec, type Decimal } from '../../tax/decimal'

/**
 * Supplier on-time and material shortages (B-W2b-429; ANA-023 "supplier on-time rate, open shortages per order, days of
 * cover of critical leathers"), pure.
 *
 *   received       a goods receipt line against a purchase order line, POSTED (a reversed receipt drops out), counted on the
 *                  day it was posted on the site's clock
 *   on time        posted on or before the line's confirmed date, else the date it was needed by (what the supplier said,
 *                  else what we asked); KPI purchasing.supplier_on_time = on time ÷ received × 100, per supplier in the drill
 *   shortages      the materials an open work order misses in the latest plan (the planning module's own read: Not enough,
 *                  Delayed), counted per work order in the drill
 *   cover          days of cover of a critical leather: what is on hand at the site ÷ what was cut from its hides per day over
 *                  the last COVER_WINDOW_DAYS days; critical = a leather an open work order still needs. No use in the window:
 *                  no cover figure (never "infinite")
 */

export const COVER_WINDOW_DAYS = 30

/** The day a purchase line was due: its confirmed date, else the date it was needed by. */
export const supplierDueOf = (line: { readonly confirmedDate: BusinessDate | null; readonly needDate: BusinessDate }): BusinessDate => line.confirmedDate ?? line.needDate

/** Received on time: posted on or before its due day. */
export const receivedOnTime = (postedDay: BusinessDate, due: BusinessDate): boolean => postedDay <= due

/** Days of cover: on hand ÷ (used in the window ÷ its days), one decimal; null with nothing used. */
export function coverDays(onHand: Decimal, used: Decimal, windowDays = COVER_WINDOW_DAYS): string | null {
  if (used.lte(0) || windowDays <= 0) return null
  return Dec.max(onHand, 0).div(used.div(windowDays)).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)
}

/** An on-time rate in percent (one decimal), null with nothing received. */
export function onTimePct(onTime: number, received: number): string | null {
  return received === 0 ? null : new Dec(onTime).div(received).times(100).toDecimalPlaces(1, Dec.ROUND_HALF_UP).toFixed(1)
}

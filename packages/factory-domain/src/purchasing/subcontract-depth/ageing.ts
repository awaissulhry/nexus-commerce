import { businessDate, type BusinessDate } from '../../core/time'
import { decimalOf, QUANTITY_SCALE } from '../../product/units/units'
import { Dec, type Decimal } from '../../tax/decimal'
import { daysBetween } from './terms'

/**
 * Days out of our material at each workshop (B-W2b-331; SCM-150; design purchasing.subcontracting "Stock at
 * subcontractors" › days out). Pure. Our stock at a workshop is the ledger's balance at its place (W2a, SCM-141); what is
 * still there is read first in, first out: every move into the place is a layer dated when it came, every move out takes
 * the oldest layer first. The layers left say since when each part of the balance is out, so the oldest one gives the
 * line's days out, and the layers fall in four buckets (up to 30 days, 31 to 60, 61 to 90, over 90). In base units, 4 places.
 */

export const AGE_BUCKETS = ['upTo30', 'upTo60', 'upTo90', 'over90'] as const
export type AgeBucket = (typeof AGE_BUCKETS)[number]

/** Material out longer than this many days is flagged on the order and the workshop. */
export const LONG_OUT_DAYS = 60

const ZERO = new Dec(0)
const q = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)

export const bucketOf = (days: number): AgeBucket => (days <= 30 ? 'upTo30' : days <= 60 ? 'upTo60' : days <= 90 ? 'upTo90' : 'over90')

export interface Layer {
  readonly since: Date
  readonly quantity: Decimal
}

/** What is left of the moves in after the moves out took the oldest first. */
export function layersOf(ins: readonly { readonly at: Date; readonly quantity: string }[], out: string): Layer[] {
  let left = decimalOf(out)
  const layers: Layer[] = []
  for (const move of [...ins].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const quantity = decimalOf(move.quantity)
    if (left.greaterThanOrEqualTo(quantity)) {
      left = left.minus(quantity)
      continue
    }
    layers.push({ since: move.at, quantity: quantity.minus(left) })
    left = ZERO
  }
  return layers
}

export interface Ageing {
  /** The oldest layer still out: since when, and how many days to `today`. */
  readonly since: BusinessDate | null
  readonly daysOut: number | null
  readonly buckets: Readonly<Record<AgeBucket, string>>
  readonly longOut: boolean
}

/** The days out of a line's layers on `today`. */
export function ageingOf(layers: readonly Layer[], today: BusinessDate): Ageing {
  const sums: Record<AgeBucket, Decimal> = { upTo30: ZERO, upTo60: ZERO, upTo90: ZERO, over90: ZERO }
  let since: BusinessDate | null = null
  for (const layer of layers) {
    const day = businessDate(layer.since)
    if (since === null || day < since) since = day
    const bucket = bucketOf(Math.max(0, daysBetween(day, today)))
    sums[bucket] = sums[bucket].plus(layer.quantity)
  }
  const daysOut = since === null ? null : Math.max(0, daysBetween(since, today))
  return {
    since,
    daysOut,
    buckets: { upTo30: q(sums.upTo30), upTo60: q(sums.upTo60), upTo90: q(sums.upTo90), over90: q(sums.over90) },
    longOut: daysOut !== null && daysOut > LONG_OUT_DAYS,
  }
}

/** The days a kit line's open rest has been out (since it was sent), or null when nothing is open. */
export function lineDaysOut(sentAt: Date | null, open: string, today: BusinessDate): number | null {
  if (sentAt === null || !decimalOf(open).greaterThan(0)) return null
  return Math.max(0, daysBetween(businessDate(sentAt), today))
}

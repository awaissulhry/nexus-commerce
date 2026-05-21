/**
 * I7 — money precision discipline.
 *
 * All money math inside the insights aggregators should round-trip
 * through integer cents to avoid float drift compounding across
 * thousands of order lines. Prisma returns money columns as Decimal
 * (string under the hood); naively casting to Number and then
 * accumulating with `+=` introduces sub-cent error that grows with
 * row count.
 *
 * Pattern:
 *   const cents = decimalToCents(it.price) * (it.quantity ?? 0)
 *   slot.cents += cents
 *   // ...later, at the response boundary:
 *   revenue: centsToMajor(slot.cents)
 *
 * Always accumulate in cents (integer), divide-by-100 once on the
 * way out. Prices > 21M EUR would overflow Number.MAX_SAFE_INTEGER
 * after the *100; not a concern for SKU-level rows.
 */

import type { Prisma } from '@prisma/client'

type DecimalLike =
  | Prisma.Decimal
  | string
  | number
  | null
  | undefined

/** Convert a monetary value to integer cents.
 *  Returns 0 for null/undefined. Uses Math.round on the *100 product
 *  so 19.99 → 1999 exactly (rather than 1998 via floor or 1999.000004
 *  → 1999 via parseInt). */
export function decimalToCents(value: DecimalLike): number {
  if (value == null) return 0
  if (typeof value === 'number') return Math.round(value * 100)
  const asString = typeof value === 'string' ? value : value.toString()
  if (asString.length === 0) return 0
  // Split into integer + fractional parts to avoid float multiplication
  // entirely. "19.999" → ["19", "999"] → 1999 (rounded to 2dp).
  const negative = asString.startsWith('-')
  const body = negative ? asString.slice(1) : asString
  const dot = body.indexOf('.')
  if (dot === -1) {
    const n = Number(body) * 100
    return negative ? -n : n
  }
  const intPart = body.slice(0, dot)
  const fracPart = body.slice(dot + 1)
  // pad/truncate fractional to 3 digits, then round the third away
  const padded = (fracPart + '000').slice(0, 3)
  const intCents = Number(intPart) * 100
  const fracCents = Math.round(Number(padded) / 10)
  const total = intCents + fracCents
  return negative ? -total : total
}

/** Convert integer cents back to major units with 2dp precision. */
export function centsToMajor(cents: number): number {
  return Math.round(cents) / 100
}

/** Snap a major-unit value to 2dp, used at the response boundary
 *  when we don't have a clean cents accumulation upstream. */
export function roundMajor(value: number): number {
  return Math.round(value * 100) / 100
}

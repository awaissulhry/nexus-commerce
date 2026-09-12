/**
 * PES.7 — reading the analytics payload honestly. Pure, tested.
 *
 * 🔴 **On a parent product every figure here is zero, and the family is selling.**
 *
 * Measured on GALE-JACKET, scanning the full set of 20 children rather than sampling:
 *
 * | | parent row | children |
 * |---|---|---|
 * | `sales.byChannel` | `[]` at 30, 60 and 90 days | 3 channels on the first child alone |
 * | units (90d) | **0** | **427 across 17 of 20 children** |
 *
 * `totalUnits` is `byChannel.reduce(...)` — the sum of an empty list, not a measured zero. So a tab
 * that renders "0 units · £0 revenue" on a parent is stating, confidently, the opposite of the
 * truth. This module refuses to produce that number: with no channel rows it reports **absence**,
 * and on a parent it says where the figures actually live.
 *
 * Aggregating the children would be feature invention (this lane is a port), so the surface names
 * the situation instead of inventing a total nobody computed.
 */
import type { AnalyticsPayload, TrendPoint } from './types'

export type SalesReading =
  /** Channel rows exist; the totals mean what they say. */
  | {
    kind: 'measured'
    units: number
    revenue: number
    orders: number
    avgDailyUnits: number
    /**
     * 🔴 `null` when the payload did not report it — NOT 0.
     *
     * It travels in the reading with its four siblings for a reason: while it was read straight off
     * the raw payload in the component (`analytics?.sales.stockoutDays ?? 0`) it was the one figure
     * in that list that could silently print "0 stockout days" — a clean bill of health — for a
     * field the server never sent.
     */
    stockoutDays: number | null
  }
  /** No channel rows, and this row is a parent — the figures belong to its variants. */
  | { kind: 'parentHasNoRows'; note: string }
  /** No channel rows on a product that should have its own. */
  | { kind: 'noData'; note: string }

export function readSales(
  payload: AnalyticsPayload,
  product: { isParent: boolean; variantCount?: number | null },
): SalesReading {
  const { sales, days } = payload
  if (sales.byChannel.length > 0) {
    return {
      kind: 'measured',
      units: sales.totalUnits,
      revenue: sales.totalRevenue,
      orders: sales.totalOrders,
      avgDailyUnits: sales.avgDailyUnits,
      stockoutDays: typeof sales.stockoutDays === 'number' && Number.isFinite(sales.stockoutDays)
        ? sales.stockoutDays
        : null,
    }
  }
  if (product.isParent) {
    const n = product.variantCount ?? null
    return {
      kind: 'parentHasNoRows',
      note: `Sales are recorded against each variant, and this parent row has none of its own. `
        + `Its ${n === null ? '' : `${n} `}variants hold the figures for the last ${days} days — `
        + 'open one to see them. Nothing here is a measurement of zero.',
    }
  }
  return {
    kind: 'noData',
    note: `No sales rows were recorded for this product in the last ${days} days. That is an `
      + 'absence of data, which is not the same as no sales.',
  }
}

/**
 * Stock on hand.
 *
 * 🔴 A genuine `0` is a MEASURED zero and must read as 0 — it means out of stock, which is the most
 * actionable number on the page. An ABSENT value must not render as 0, which says the same thing
 * with none of the evidence. `?? 0` collapses the two, and did here until it was caught: the field
 * is undefined exactly when the read failed, so the tab reported "out of stock" precisely when it
 * knew least. Same shape as the empty-list sum in `readSales` at the top of this file.
 */
export function readAvailable(value: number | null | undefined): { text: string; known: boolean } {
  return typeof value === 'number' && Number.isFinite(value)
    ? { text: String(value), known: true }
    : { text: 'Not known', known: false }
}

/** Days of cover. `null` is "cannot be calculated", never 0. */
export function readDaysOfInventory(value: number | null): { text: string; known: boolean } {
  return value === null
    ? { text: 'Not calculable', known: false }
    : { text: `${value} days`, known: true }
}

/**
 * Stockout risk. `UNKNOWN` is its own state and is never folded into `LOW` — "we do not know"
 * and "you are fine" are opposite messages to an operator deciding whether to reorder.
 */
export function readStockoutRisk(risk: string): { label: string; tone: 'danger' | 'warning' | 'success' | 'neutral' } {
  switch ((risk ?? '').toUpperCase()) {
    case 'HIGH': return { label: 'High', tone: 'danger' }
    case 'MEDIUM':
    case 'MED': return { label: 'Medium', tone: 'warning' }
    case 'LOW': return { label: 'Low', tone: 'success' }
    default: return { label: 'Not known', tone: 'neutral' }
  }
}

/** A price list with `null` prices is not a list of free products. */
export function readPrices(
  rows: ReadonlyArray<{ channel: string; marketplace: string | null; price?: number | null; buyBoxPrice?: number | null }>,
): Array<{ channel: string; marketplace: string | null; text: string; known: boolean }> {
  return rows.map((r) => {
    const value = r.price ?? r.buyBoxPrice ?? null
    // 🔴 `0` is kept as a real reading — a zero price is a data problem worth seeing, and hiding it
    // behind "not set" would silently repair it on screen.
    return value === null
      ? { channel: r.channel, marketplace: r.marketplace, text: 'Not set', known: false }
      : { channel: r.channel, marketplace: r.marketplace, text: value.toFixed(2), known: true }
  })
}

export interface TrendReading {
  points: TrendPoint[]
  max: number
  /** True when there is nothing to draw — the caller shows a sentence, not an empty chart. */
  empty: boolean
}

export function readTrend(points: readonly TrendPoint[]): TrendReading {
  const clean = points.filter((p) => typeof p.units === 'number' && Number.isFinite(p.units))
  return {
    points: [...clean],
    max: clean.reduce((m, p) => Math.max(m, p.units), 0),
    // A single point is not a trend; a flat line drawn from one reading implies a history.
    empty: clean.length < 2,
  }
}

/**
 * The sparkline path. Pure arithmetic, tested — the crop-geometry lesson: a wrong path and a right
 * one look equally plausible on screen and neither is diagnosable by looking.
 */
export function sparklinePath(points: readonly TrendPoint[], width: number, height: number): string {
  if (points.length < 2) return ''
  const max = points.reduce((m, p) => Math.max(m, p.units), 0)
  const stepX = width / (points.length - 1)
  // An all-zero series draws along the BOTTOM, not through the middle: dividing by a zero max
  // would put a flat line at half height and imply activity.
  const y = (units: number) => (max <= 0 ? height : height - (units / max) * height)
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(2)},${y(p.units).toFixed(2)}`)
    .join(' ')
}

export interface PriceRowReading {
  key: string
  channel: string
  marketplace: string | null
  price: string
  priceKnown: boolean
  buyBox: string
  buyBoxKnown: boolean
}

/**
 * Pair each current price with its buy-box price, **joined on (channel, marketplace)**.
 *
 * 🔴 Not by array position. Both sides carry the coordinate, and the version this replaces threw it
 * away and paired `currentPrices[i]` with `latestBuyBoxPrices[i]`. On the live payload the arrays
 * arrive the same length in the same order, so nothing was wrong on screen — which is exactly why
 * it needed a test rather than a look. A server omitting ONE coordinate's buy-box row shifts every
 * row below the gap under the wrong label, and the result looks entirely plausible: real prices,
 * real markets, silently mismatched.
 *
 * Second instance of this fault in this lane (the first produced a phantom "moved" in a snapshot
 * diff): **an array index is a fact about the array, not about the data.** Where a key exists, join
 * on it — and put the join somewhere a test can reach, because a component helper is where the
 * first one hid too.
 */
export function joinPriceRows(
  current: ReadonlyArray<{ channel: string; marketplace: string | null; price?: number | null }>,
  buyBox: ReadonlyArray<{ channel: string; marketplace: string | null; buyBoxPrice?: number | null }>,
): PriceRowReading[] {
  const coordOf = (r: { channel: string; marketplace: string | null }) =>
    `${r.channel}-${r.marketplace ?? ''}`
  const byCoord = new Map(readPrices(buyBox).map((b) => [coordOf(b), b] as [string, ReturnType<typeof readPrices>[number]]))
  /*
   * 🔴 The join key and the row's IDENTITY are different things.
   *
   * A buy-box price is a property of the COORDINATE (Amazon's buy box is per ASIN × marketplace),
   * so the lookup fans out one-to-many: several listings on one coordinate all show that
   * coordinate's price, which is the true answer. But `currentPrices` is one entry per LISTING ROW,
   * so two aliases on one coordinate produce two rows that are identical in channel and marketplace
   * — and a `key` of just the coordinate would collide. Nothing consumes `key` today; a future
   * `getRowId` would silently merge the two rows. So identity carries an ordinal and the join
   * does not.
   */
  const seen = new Map<string, number>()
  return readPrices(current).map((p) => {
    const coord = coordOf(p)
    const bb = byCoord.get(coord)
    const n = seen.get(coord) ?? 0
    seen.set(coord, n + 1)
    return {
      key: n === 0 ? coord : `${coord}#${n}`,
      channel: p.channel,
      marketplace: p.marketplace,
      price: p.text,
      priceKnown: p.known,
      /*
       * 🔴 "No observation", not "Not set" — they are different claims.
       *
       * An unset PRICE is a configuration the seller has not made. An absent BUY BOX is a reading
       * *we* have never taken: `BuyBoxHistory` holds zero rows today, so every buy-box value on
       * every product is null (PES.5, 2026-09-02). "Not set" would put that on the seller. The
       * absence is ours, and the column says so — and it is never borrowed from a neighbouring row.
       */
      buyBox: bb?.known ? bb.text : 'No observation',
      buyBoxKnown: bb?.known ?? false,
    }
  })
}

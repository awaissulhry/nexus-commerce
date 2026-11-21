import type { Order } from '../../api'
import type { Dates, Headline, OrderProduction } from '../overview/api'
import { readyDayOf } from '../overview/dates'
import { daysBetween } from './now'

/**
 * F-PT-201 (order PRODUCTION tab, 10-design §5 Block A; bugs B7–B10, B13, B14) — Dates & plan's key dates, without a screen, each its
 * own door in the view: Customer asked · We promised (how often it moved, the first promise) · Plan says ready (the LINE forecast —
 * the same one day as Overview's, readyDayOf; withheld without planning.promise.view, never a bare "—") · Customer sees (the plan's
 * days only when the customer's sharing level shows them: GATES or QUALITY; else "the promise only") · Shipped. Derived, never set.
 */

export interface PromisedTile {
  readonly date: string
  readonly moves: number
  readonly first: string | null
}

/** Plan says ready: a day (and how it stands against the promise: + after, − before), nothing planned yet, or not shown to this reader. */
export type ReadyTile = { readonly kind: 'reading' } | { readonly kind: 'withheld' } | { readonly kind: 'none' } | { readonly kind: 'day'; readonly date: string; readonly days: number | null }

/** Customer sees: the plan's days (from GATES on), the promise only, or not known (the read does not say the level). */
export type SeesTile = { readonly kind: 'unknown' } | { readonly kind: 'promiseOnly' } | { readonly kind: 'days'; readonly cut: string | null; readonly sew: string | null; readonly finish: string | null }

export interface ShippedTile {
  readonly shipments: readonly { readonly id: string; readonly number: string; readonly shippedAt: string; readonly deliveredAt: string | null }[]
}

export interface KeyDates {
  readonly asked: string | null
  readonly promised: PromisedTile | null
  readonly ready: ReadyTile
  readonly sees: SeesTile
  readonly shipped: ShippedTile
}

/** The levels from which the customer's portal shows the plan's days (production-brand/levels: GATES adds the gates and the days). */
export const SEES_DAYS_FROM: readonly string[] = Object.freeze(['GATES', 'QUALITY'])

export function readyTileOf(read: Pick<OrderProduction, 'withheld'> | null, dates: Dates | null | undefined, promise: string | null): ReadyTile {
  if (!read || !dates) return { kind: 'reading' } // not read yet: no claim (never "not shown to you" while it is read)
  if (read.withheld.includes('dates.forecast') || dates.forecast === null) return { kind: 'withheld' }
  const day = readyDayOf(dates)
  if (!day) return { kind: 'none' }
  return { kind: 'day', date: day, days: promise ? daysBetween(promise, day) : null }
}

export function keyDatesOf(order: Pick<Order, 'requestedDate' | 'promiseDate' | 'originalPromiseDate' | 'chain'>, read: OrderProduction | null, headline: Pick<Headline, 'promise'> | null | undefined): KeyDates {
  const dates = read?.dates ?? null
  const date = headline?.promise.date ?? order.promiseDate
  const level = dates?.customer?.level ?? null
  return {
    asked: order.requestedDate,
    promised: date ? { date, moves: headline?.promise.moves ?? 0, first: headline?.promise.first ?? order.originalPromiseDate } : null,
    ready: readyTileOf(read, dates, date),
    sees: level === null || !dates ? { kind: 'unknown' } : SEES_DAYS_FROM.includes(level) ? { kind: 'days', cut: dates.planned.cutStart, sew: dates.planned.sewStart, finish: dates.planned.finish } : { kind: 'promiseOnly' },
    shipped: { shipments: order.chain.shipments.flatMap((shipment) => (shipment.shippedAt ? [{ id: shipment.id, number: shipment.number, shippedAt: shipment.shippedAt, deliveredAt: shipment.deliveredAt }] : [])) },
  }
}

import type { FactoryClient } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { currentPromiseOf } from '@nexus/factory-domain/planning/promise/rules'
import type { CommandTx } from '../../../core/command'
import { readPromiseRows } from '../../planning/promise/store'

/**
 * The ship-by day of garments (B-W2b-386; LOG-018, LOG-110): the current promise of their order line and size — B-W2b-301's
 * promise per size (its newest own row, else the line's newest every-size row; planning/promise rules `currentPromiseOf`),
 * else the date typed on the line, else the order's. One read per table for many lines.
 */

type Reader = FactoryClient | CommandTx

export interface PromisedGarments {
  readonly salesOrderLineId: string
  readonly size: string
}

const dayText = (value: Date | null): BusinessDate | null => (value ? value.toISOString().slice(0, 10) : null)

/** A lookup of the ship-by day of an order line's size. */
export async function shipByLookup(db: Reader, garments: readonly PromisedGarments[]): Promise<(salesOrderLineId: string, size: string) => BusinessDate | null> {
  const lineIds = [...new Set(garments.map((entry) => entry.salesOrderLineId))]
  if (lineIds.length === 0) return () => null
  const lines = await db.salesOrderLine.findMany({ where: { id: { in: lineIds } }, select: { id: true, promiseDate: true, order: { select: { promiseDate: true } } } })
  const typed = new Map(lines.map((line) => [line.id, dayText(line.promiseDate) ?? dayText(line.order.promiseDate)]))
  const rows = await readPromiseRows(db, lineIds)
  return (salesOrderLineId, size) => currentPromiseOf(size, rows.get(salesOrderLineId) ?? [], typed.get(salesOrderLineId) ?? null)?.date ?? null
}

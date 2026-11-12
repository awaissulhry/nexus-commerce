import { newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { typedChangeRowsOf } from '@nexus/factory-domain/planning/promise-keep/history'
import type { PromiseRow } from '@nexus/factory-domain/planning/promise/rules'
import type { CommandTools } from '../../../core/command'
import { readPromiseRows } from '../promise/store'
import { dayOf } from '../store'
import { lockLinePromise } from './store'

/**
 * One promise history per line (B-W2b-317; PLN-173): W1's "Change promise date" (sales/orders `changePromiseInCommand`)
 * overwrote the order's or the lines' typed date; now, in the same command, it also writes the lines' PromiseRecord rows —
 * the line's first promise first when it has none (the date it had: kept forever, made when the order was), then the new
 * date for every size and for each size promised apart (factory-domain planning/promise-keep `typedChangeRowsOf`). An
 * order-wide change reaches the lines without a date of their own (as W1's date does); a change of some lines, those
 * lines. A SHIPPED order is promised nothing more (the PromiseRecord guard): its rows are not written, W1's change stands.
 * Nobody is told here (customerToldAt stays empty; the re-promise workflow tells the customer).
 */

const NO_MORE_PROMISES = ['SHIPPED', 'CLOSED', 'CANCELLED']

export interface TypedChange {
  /** The order as it was before the change (W1's read under its lock). */
  readonly order: {
    readonly id: string
    readonly companyId: string
    readonly partyId: string
    readonly status: string
    readonly orderDate: Date
    readonly promiseDate: Date | null
    readonly originalPromiseDate: Date | null
    readonly createdAt: Date
    readonly createdById: string | null
  }
  /** The order's lines as they were. */
  readonly lines: readonly { readonly id: string; readonly kind: string; readonly promiseDate: Date | null; readonly sizes: readonly { readonly size: string }[] }[]
  /** The lines changed; none: the whole order. */
  readonly lineIds: readonly string[]
  readonly promiseDate: BusinessDate
  readonly reason: string
}

/** Writes the rows of a typed change; answers how many rows it wrote. */
export async function typedPromiseRowsInCommand(tools: CommandTools, change: TypedChange): Promise<number> {
  const { tx, now, context } = tools
  if (NO_MORE_PROMISES.includes(change.order.status)) return 0
  const tenantId = 'tenantId' in context ? context.tenantId : undefined
  if (!tenantId) return 0
  const actorId = context.audience === 'office' ? context.actorId : null
  const affected = change.lines.filter((line) => line.kind !== 'FEE' && (change.lineIds.length > 0 ? change.lineIds.includes(line.id) : line.promiseDate === null))
  const orderDate = dayOf(change.order.orderDate)
  const original = change.order.originalPromiseDate ? dayOf(change.order.originalPromiseDate) : null
  let written = 0
  for (const line of [...affected].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    await lockLinePromise(tx, tenantId, line.id)
    const rows = (await readPromiseRows(tx, [line.id])).get(line.id) ?? []
    const before = line.promiseDate ?? change.order.promiseDate
    const planned: PromiseRow[] = typedChangeRowsOf({
      sizes: line.kind === 'MADE_TO_MEASURE' ? [] : line.sizes.map((entry) => entry.size),
      rows,
      first: original ?? (before ? dayOf(before) : null),
      date: change.promiseDate,
      reason: change.reason,
      orderDate,
    })
    if (planned.length === 0) continue
    const promisedById = actorId ?? change.order.createdById
    if (!promisedById) continue
    for (const row of planned) {
      await tx.promiseRecord.create({
        data: {
          id: newId(),
          salesOrderLineId: line.id,
          partyId: change.order.partyId,
          size: row.size,
          promisedDate: new Date(`${row.promisedDate}T00:00:00.000Z`),
          kind: row.kind,
          reasonCode: row.reasonCode,
          reason: row.reason,
          // The first promise was made when the order was, by whoever made it.
          promisedById: row.backfill ? (change.order.createdById ?? promisedById) : promisedById,
          promisedAt: row.backfill ? change.order.createdAt : now,
          siteId: null,
          planVersionId: null,
          createdById: actorId,
        },
        select: { id: true },
      })
    }
    written += planned.length
    tools.emit({
      type: 'order_promise.recorded',
      subject: change.order.id,
      companyId: change.order.companyId,
      payload: { orderId: change.order.id, orderLineId: line.id, siteId: null, rows: planned.map((row) => ({ size: row.size, promisedDate: row.promisedDate, kind: row.kind })) },
    })
  }
  return written
}

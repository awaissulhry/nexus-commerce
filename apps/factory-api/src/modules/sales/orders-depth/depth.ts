import { ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { CONFIRMATION_KIND } from '@nexus/factory-domain/sales/orders-depth/confirmation'
import { PRIORITY_WORDS, type SalesOrderPriorityLevel } from '@nexus/factory-domain/sales/orders-depth/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { seasonNotice, type SeasonStatus } from '@nexus/factory-domain/sales/seasons/rules'
import type { Prisma } from '@nexus/factory-db'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf } from '../orders/access'
import { officeOrder } from '../orders/moves'
import type { Reader } from '../orders/store'
import { creditHoldOf } from './approval'

/**
 * What W2b adds to an order's record and to the list's rows (B-W2b-303; design sales.orders "Priority (W2b)", "Season (W2b)"
 * columns; the record's priority, season, the wait for a yes, the confirmation, the orders split from the same quote). W1's
 * GET /sales/orders and GET /sales/orders/:orderId stay as they were; the screens read these beside them.
 *
 *   GET /sales/orders/:orderId/depth   orders.view: the record's W2b facts
 *   GET /sales/orders/depth?orderIds=  orders.view: the list rows' W2b columns (at most 200 ids; the ones the reader may not
 *                                      see are left out)
 */

const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
const MAX_IDS = 200

const COLUMNS = { id: true, number: true, status: true, priority: true, priorityLevel: true, urgentReason: true, seasonId: true, quoteVersionId: true, confirmationSentAt: true, confirmationVersion: true } as const satisfies Prisma.SalesOrderSelect
type Row = Prisma.SalesOrderGetPayload<{ select: typeof COLUMNS }>

async function seasonsOf(db: Reader, ids: readonly string[], today: BusinessDate) {
  if (ids.length === 0) return new Map<string, { id: string; code: string; name: string; status: SeasonStatus; notice: { en: string; it: string } | null }>()
  const rows = await db.season.findMany({ where: { id: { in: [...ids] } }, select: { id: true, code: true, name: true, status: true, endsOn: true, orderBookClosesOn: true } })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name, status: row.status as SeasonStatus, notice: seasonNotice({ code: row.code, status: row.status as SeasonStatus, endsOn: dayOf(row.endsOn), orderBookClosesOn: row.orderBookClosesOn ? dayOf(row.orderBookClosesOn) : null }, today) }]))
}

function priorityView(row: Row) {
  const level = row.priorityLevel as SalesOrderPriorityLevel
  return { level, words: PRIORITY_WORDS[level], urgentReason: row.urgentReason, number: row.priority }
}

/** GET /sales/orders/:orderId/depth */
export async function orderDepth(caller: CommandCaller, orderId: string) {
  const order = await officeOrder(caller, orderId)
  const context = officeContextOf(caller)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (db) => {
    const row = await db.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: COLUMNS })
    const seasons = await seasonsOf(db, row.seasonId ? [row.seasonId] : [], today)
    const pending = await db.approvalTask.findFirst({ where: { kind: 'SALES_ORDER', recordType: 'SalesOrder', recordId: row.id, status: 'PENDING' }, select: { id: true } })
    const hold = row.status === 'PENDING_APPROVAL' ? await creditHoldOf(db, row.id) : null
    const confirmations = await db.generatedDocument.count({ where: { recordType: 'SalesOrder', recordId: row.id, kind: CONFIRMATION_KIND } })
    const family = row.quoteVersionId
      ? await db.salesOrder.findMany({ where: { AND: [{ quoteVersionId: row.quoteVersionId, id: { not: row.id } }, scopeWhere(actorOf(context), ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput] }, select: { id: true, number: true, status: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      : []
    return {
      orderId: row.id,
      number: row.number,
      status: row.status,
      priority: priorityView(row),
      season: row.seasonId ? (seasons.get(row.seasonId) ?? null) : null,
      waiting: row.status === 'PENDING_APPROVAL' ? { requestTaskId: pending?.id ?? null, creditHold: hold !== null } : null,
      confirmation: { versions: confirmations, sentAt: row.confirmationSentAt ? toUtcIso(row.confirmationSentAt) : null, sentVersion: row.confirmationVersion },
      sameQuote: family,
    }
  })
}

/** GET /sales/orders/depth?orderIds= */
export async function ordersDepth(caller: CommandCaller, query: { readonly orderIds: string }) {
  const context = officeContextOf(caller)
  const ids = [...new Set(query.orderIds.split(',').map((id) => id.trim()).filter((id) => id !== ''))]
  if (ids.length === 0 || ids.length > MAX_IDS || ids.some((id) => !isUuid(id))) throw new ValidationError(`1 to ${MAX_IDS} order ids, separated by commas.`, [{ path: 'query/orderIds', message: `1 to ${MAX_IDS} order ids.` }])
  const today = businessDate(serverClock.now())
  return caller.withClient(async (db) => {
    const rows = await db.salesOrder.findMany({ where: { AND: [{ id: { in: ids } }, scopeWhere(actorOf(context), ORDERS_VIEW, { company: 'companyId', party: 'partyId' }) as Prisma.SalesOrderWhereInput] }, select: COLUMNS, orderBy: [{ number: 'asc' }, { id: 'asc' }] })
    const seasons = await seasonsOf(db, [...new Set(rows.flatMap((row) => (row.seasonId ? [row.seasonId] : [])))], today)
    const pending = new Set((await db.approvalTask.findMany({ where: { kind: 'SALES_ORDER', recordType: 'SalesOrder', recordId: { in: rows.map((row) => row.id) }, status: 'PENDING' }, select: { recordId: true } })).map((row) => row.recordId))
    return {
      orders: rows.map((row) => ({
        orderId: row.id,
        number: row.number,
        priority: priorityView(row),
        season: row.seasonId ? { id: row.seasonId, code: seasons.get(row.seasonId)?.code ?? '' } : null,
        waitingForYes: row.status === 'PENDING_APPROVAL',
        requestPending: pending.has(row.id),
        confirmationSentAt: row.confirmationSentAt ? toUtcIso(row.confirmationSentAt) : null,
      })),
    }
  })
}

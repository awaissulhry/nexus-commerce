import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { isLengthUom } from '@nexus/factory-domain/inventory/rolls/rolls'
import { PRODUCTION_CUTTING_VIEW } from '@nexus/factory-domain/production/cutting/permissions'
import { PRODUCTION_CUTORDERS_MANAGE } from '@nexus/factory-domain/production/cutorders/permissions'
import { cellLeft, type CutOrderKind, type CutOrderStatus } from '@nexus/factory-domain/production/cutorders/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import { may, notFound, officeOf } from './access'
import { CUT_ORDER_COLUMNS, garmentsElsewhere, readCutOrder, readLayRolls, readLays, readLines, readPlyRuns, readTickets, type CutOrderRow, type Reader } from './store'
import { recordView, summaryView } from './views'

/**
 * Reading cut orders (B-W2b-112; design production.cutting "Cut orders", pop "New cut order", the Cut record): the list of the
 * caller's scope with its tiles, one cut order's record, and the cells waiting for a cut order per material and colour. Office,
 * production.cutting.view over the cut orders' (and work orders') companies and sites. Never who cut; no money.
 */

export const CUT_ORDER_VIEWS = ['open', 'planned', 'released', 'cutting', 'cut', 'cancelled', 'all'] as const
export type CutOrderView = (typeof CUT_ORDER_VIEWS)[number]
const IN_VIEW: Readonly<Record<CutOrderView, readonly CutOrderStatus[]>> = {
  open: ['PLANNED', 'RELEASED', 'IN_PROGRESS'],
  planned: ['PLANNED'],
  released: ['RELEASED'],
  cutting: ['IN_PROGRESS'],
  cut: ['CUT', 'RECONCILED'],
  cancelled: ['CANCELLED'],
  all: ['PLANNED', 'RELEASED', 'IN_PROGRESS', 'CUT', 'RECONCILED', 'CANCELLED'],
}

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly view?: CutOrderView | undefined
  readonly kind?: CutOrderKind | undefined
  readonly q?: string | undefined
  readonly limit: number
  readonly cursor?: string | undefined
}

/** GET /production/cut-orders: newest first, `limit` a page, with the tiles of the scope (counts per status). */
export async function listCutOrders(caller: CommandCaller, query: ListQuery) {
  const context = officeOf(caller)
  const scope = scopeWhere(actorOf(context), PRODUCTION_CUTTING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.CutOrderWhereInput
  const q = query.q?.trim()
  const search: Prisma.CutOrderWhereInput = q
    ? {
        OR: [
          { number: { contains: q, mode: 'insensitive' } },
          { markerName: { contains: q, mode: 'insensitive' } },
          { item: { is: { OR: [{ code: { contains: q, mode: 'insensitive' } }, { name: { contains: q, mode: 'insensitive' } }] } } },
          { lines: { some: { workOrderSize: { is: { workOrder: { is: { number: { contains: q, mode: 'insensitive' } } } } } } } },
        ],
      }
    : {}
  const base: Prisma.CutOrderWhereInput = { AND: [scope, query.siteId ? { siteId: query.siteId } : {}, query.kind ? { kind: query.kind } : {}] }
  return caller.withClient(async (db) => {
    const rows = await db.cutOrder.findMany({
      where: { AND: [base, search, { status: { in: [...IN_VIEW[query.view ?? 'open']] } }] },
      select: CUT_ORDER_COLUMNS,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    })
    const page = rows.slice(0, query.limit)
    const ids = page.map((row) => row.id)
    const [lines, lays, tickets, counts] = await Promise.all([
      readLines(db, ids),
      readLays(db, ids),
      readTickets(db, ids),
      db.cutOrder.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
    ])
    const tiles = Object.fromEntries(['PLANNED', 'RELEASED', 'IN_PROGRESS', 'CUT', 'RECONCILED', 'CANCELLED'].map((status) => [status, counts.find((row) => row.status === status)?._count._all ?? 0]))
    return {
      rows: page.map((row) =>
        summaryView(
          row,
          lines.filter((line) => line.cutOrderId === row.id),
          lays.filter((lay) => lay.cutOrderId === row.id),
          tickets.filter((ticket) => ticket.cutOrderId === row.id),
        ),
      ),
      nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
      tiles: { planned: tiles.PLANNED!, released: tiles.RELEASED!, cutting: tiles.IN_PROGRESS!, cut: tiles.CUT! + tiles.RECONCILED!, cancelled: tiles.CANCELLED! },
    }
  })
}

/** The record of a cut order the caller sees, read with `db` (the caller's client, or a command's transaction). */
export async function recordOf(db: Reader, context: OfficeContext | FloorContext, order: CutOrderRow) {
  const [lines, lays, tickets] = await Promise.all([readLines(db, [order.id]), readLays(db, [order.id]), readTickets(db, [order.id])])
  const layIds = lays.map((lay) => lay.id)
  const [layRolls, plyRuns] = await Promise.all([readLayRolls(db, layIds), readPlyRuns(db, layIds)])
  return recordView({ order, lines, lays, layRolls, tickets, plyRuns, manage: context.audience === 'office' && may(context, PRODUCTION_CUTORDERS_MANAGE, order) })
}

/** The record of one cut order (production.cutting.view at its company and site). */
export async function readRecord(caller: CommandCaller, cutOrderId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const order = await readCutOrder(db, cutOrderId)
    if (!order || !may(context, PRODUCTION_CUTTING_VIEW, order)) return notFound('Cut order')
    return recordOf(db, context, order!)
  })
}

export interface WaitingQuery {
  readonly siteId?: string | undefined
  readonly itemId?: string | undefined
  readonly itemColourId?: string | undefined
}

/** At most this many work orders are weighed for one answer. */
const WAITING_WORK_ORDERS = 300

/**
 * GET /production/cut-orders/waiting: the cells of released or running work orders that still have garments for a cut order,
 * per material (a leather article tracked by hide, or a fabric tracked by lot and counted by length) and colour — what "New cut
 * order" groups (work orders of the same material and colour). A cell's left = its garments less what live cut orders of the
 * material already cut of it.
 */
export async function waitingCells(caller: CommandCaller, query: WaitingQuery) {
  const context = officeOf(caller)
  const scope = scopeWhere(actorOf(context), PRODUCTION_CUTTING_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.WorkOrderWhereInput
  return caller.withClient(async (db) => {
    const orders = await db.workOrder.findMany({
      where: { AND: [scope, query.siteId ? { siteId: query.siteId } : {}, { status: { in: ['RELEASED', 'IN_PROGRESS'] } }] },
      select: { id: true },
      orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { number: 'asc' }],
      take: WAITING_WORK_ORDERS,
    })
    const materials = await db.workOrderMaterial.findMany({
      where: { workOrderId: { in: orders.map((order) => order.id) }, ...(query.itemId ? { itemId: query.itemId } : {}), ...(query.itemColourId ? { itemColourId: query.itemColourId } : {}) },
      select: {
        itemId: true,
        itemColourId: true,
        workOrderSizeId: true,
        bomLine: { select: { item: { select: { id: true, code: true, name: true, tracking: true, baseUom: true } } } },
        itemColour: { select: { id: true, code: true, name: true } },
        workOrderSize: {
          select: {
            id: true,
            size: true,
            quantity: true,
            colourway: { select: { id: true, code: true, name: true } },
            workOrder: { select: { id: true, number: true, status: true, dueDate: true, companyId: true, siteId: true, style: { select: { id: true, code: true, name: true } } } },
          },
        },
      },
    })
    type Group = { kind: CutOrderKind; item: { id: string; code: string; name: string }; colour: { id: string; code: string; name: string } | null; siteId: string; cells: Map<string, (typeof materials)[number]['workOrderSize']> }
    const groups = new Map<string, Group>()
    for (const row of materials) {
      const item = row.bomLine.item
      const kind: CutOrderKind | null = item.tracking === 'HIDE' ? 'LEATHER' : item.tracking === 'LOT' && isLengthUom(item.baseUom) ? 'FABRIC' : null
      if (!kind) continue
      const siteId = row.workOrderSize.workOrder.siteId
      const key = `${siteId}|${row.itemId}|${row.itemColourId ?? ''}`
      const group = groups.get(key) ?? { kind, item: { id: item.id, code: item.code, name: item.name }, colour: row.itemColour, siteId, cells: new Map() }
      group.cells.set(row.workOrderSize.id, row.workOrderSize)
      groups.set(key, group)
    }
    const answer = []
    for (const group of groups.values()) {
      const cells = [...group.cells.values()]
      const elsewhere = await garmentsElsewhere(db, { itemId: group.item.id, itemColourId: group.colour?.id ?? null }, cells.map((cell) => cell.id), null)
      const rows = cells
        .map((cell) => {
          const onCutOrders = elsewhere.get(cell.id) ?? 0
          return {
            workOrderSizeId: cell.id,
            workOrder: { id: cell.workOrder.id, number: cell.workOrder.number, status: cell.workOrder.status, dueDate: cell.workOrder.dueDate ? cell.workOrder.dueDate.toISOString().slice(0, 10) : null },
            style: cell.workOrder.style,
            colourway: cell.colourway,
            size: cell.size,
            quantity: cell.quantity,
            onCutOrders,
            left: cellLeft(cell.quantity, onCutOrders),
          }
        })
        .filter((cell) => cell.left > 0)
        .sort((left, right) => left.workOrder.number.localeCompare(right.workOrder.number) || left.colourway.code.localeCompare(right.colourway.code) || left.size.localeCompare(right.size, undefined, { numeric: true }))
      if (rows.length === 0) continue
      answer.push({ kind: group.kind, siteId: group.siteId, item: group.item, colour: group.colour, garmentsLeft: rows.reduce((sum, cell) => sum + cell.left, 0), cells: rows })
    }
    answer.sort((left, right) => left.kind.localeCompare(right.kind) || left.item.code.localeCompare(right.item.code) || (left.colour?.code ?? '').localeCompare(right.colour?.code ?? ''))
    return { groups: answer }
  })
}

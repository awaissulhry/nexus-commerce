import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { businessDate, businessDayRange, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { boardOrder, CUTBOARD_LIST_LIMIT, dayPlan, differencePct, isLate, OPEN_CUT_STATUSES, type DayRange, type PlanOrder } from '@nexus/factory-domain/production/cutboard/board'
import { groupTotals } from '@nexus/factory-domain/production/cutboard/yield'
import { PRODUCTION_CUTTING_VIEW } from '@nexus/factory-domain/production/cutting/permissions'
import { yieldFigures, yieldTotals } from '@nexus/factory-domain/production/yield/rules'
import { Dec, ZERO } from '@nexus/factory-domain/tax/decimal'
import type { UOMS } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import type { Reader } from '../cutorders/store'
import { officeContextOf, siteFor, sitesFor } from '../reports/daily'
import { liveEntries, yieldEntries, type EntryRow } from '../yield/views'

/**
 * GET /production/cutboard (B-W2b-130; MES-163; design production.floor "Cutting room": "Cut orders waiting, in progress, cut vs
 * plan today, hides used and yield today; no cutter names"): one site's cutting room on one day (today by default), for Floor now.
 *
 *   tiles    the open cut orders by state now (planned, released to the table, cutting), and the late ones
 *   lays     at the tables now (spread or counted), and cut lays whose fabric used is still to confirm
 *   plan     cut against plan in garments (factory-domain production/cutboard/board dayPlan): the cut orders due by the day, from
 *            112's ticket end (leather: the cut order's cutAt) and 116's lays (fabric: Lay.cutAt × plies counted × ratio)
 *   leather  the cut log of the day (production/yield): hides cut, area used, pattern, yield against what the BOM expects, per
 *            area unit; the pieces cut
 *   fabric   the lays cut that day: the estimate against the fabric the table confirmed (CutConsumption), in metres
 *   orders   the open cut orders, cutting first, earliest due first (at most CUTBOARD_LIST_LIMIT; `more` counts the rest)
 *
 * Office, production.cutting.view at the site. Read without any worker column: nothing names who spread, cut or counted.
 */

const ORDER_SELECT = {
  id: true,
  number: true,
  kind: true,
  status: true,
  companyId: true,
  siteId: true,
  dueDate: true,
  createdAt: true,
  cutAt: true,
  cancelledAt: true,
  item: { select: { id: true, code: true, name: true } },
  itemColour: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.CutOrderSelect
type OrderRow = Prisma.CutOrderGetPayload<{ select: typeof ORDER_SELECT }>

const dayOf = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
const m4 = (value: Prisma.Decimal | null | undefined) => new Dec(value ? value.toString() : '0')
const unique = (values: readonly string[]): string[] => [...new Set(values)]
export type AreaUom = (typeof UOMS)[number]

/** The cut orders a day's board reads: open now, cut or cancelled since the day began, or with a lay cut that day. */
async function ordersOfDay(db: Reader, siteId: string, range: DayRange): Promise<OrderRow[]> {
  return db.cutOrder.findMany({
    where: {
      siteId,
      // Open now (the list is always now's), or cut or cancelled since the day began, or with a lay cut that day; the day's plan
      // leaves out what was made after the day (dayPlan).
      OR: [{ status: { in: [...OPEN_CUT_STATUSES] } }, { cutAt: { gte: range.start } }, { cancelledAt: { gte: range.start } }, { lays: { some: { cutAt: { gte: range.start, lt: range.end } } } }],
    },
    select: ORDER_SELECT,
    take: 2000,
  })
}

/** The leather cut on the day: per area unit, the hides, the yield figures, and the pieces cut. */
export async function leatherOfDay(db: Reader, siteId: string, range: DayRange) {
  const entries = await liveEntries(db, { siteId, serverTime: { gte: range.start, lt: range.end } })
  if (entries.length === 0) return { hides: 0, pieces: 0, rows: [] as ReturnType<typeof leatherRows> }
  const figures = await yieldEntries(db, entries)
  const hides = await db.hide.findMany({ where: { id: { in: unique(entries.map((entry) => entry.hideId)) } }, select: { id: true, itemId: true } })
  const items = new Map((await db.item.findMany({ where: { id: { in: unique(hides.map((hide) => hide.itemId)) } }, select: { id: true, baseUom: true } })).map((row) => [row.id, row.baseUom]))
  const uomOfHide = new Map<string, AreaUom>(hides.map((hide) => [hide.id, items.get(hide.itemId) ?? 'FT2']))
  const pieces = await db.cutLogPiece.aggregate({ where: { cutLogId: { in: entries.map((entry) => entry.id) } }, _sum: { pieces: true } })
  return { hides: unique(entries.map((entry) => entry.hideId)).length, pieces: pieces._sum.pieces ?? 0, rows: leatherRows(entries, figures, uomOfHide) }
}

function leatherRows(entries: readonly EntryRow[], figures: Awaited<ReturnType<typeof yieldEntries>>, uomOfHide: ReadonlyMap<string, AreaUom>) {
  return groupTotals(
    entries,
    (entry) => uomOfHide.get(entry.hideId) ?? 'FT2',
    (entry) => yieldTotals([figures.get(entry.id)!]),
  ).map((group) => ({ uom: uomOfHide.get(group.first.hideId) ?? ('FT2' as AreaUom), hides: unique(group.rows.map((entry) => entry.hideId)).length, ...yieldFigures(group.totals) }))
}

/** GET /production/cutboard. */
export async function cuttingBoard(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly date?: BusinessDate | undefined }) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const sites = await sitesFor(db, actor, PRODUCTION_CUTTING_VIEW, context.companyId)
    const site = query.siteId ? await siteFor(db, actor, PRODUCTION_CUTTING_VIEW, query.siteId, context.companyId) : sites[0]
    if (!site) throw new NotFoundError('No site where you may read the cutting room.')
    const today = businessDate(now, site.timezone)
    const day = query.date ?? today
    const range = businessDayRange(day, site.timezone)

    const orders = await ordersOfDay(db, site.id, range)
    const orderIds = orders.map((order) => order.id)
    const [lines, lays] = orderIds.length
      ? await Promise.all([
          db.cutOrderLine.findMany({ where: { cutOrderId: { in: orderIds } }, select: { cutOrderId: true, quantity: true, ratio: true, workOrderId: true, workOrderSize: { select: { workOrder: { select: { id: true, number: true } } } } } }),
          db.lay.findMany({ where: { cutOrderId: { in: orderIds } }, select: { id: true, cutOrderId: true, status: true, plies: true, plyCountLeft: true, cutAt: true } }),
        ])
      : [[], []]
    const linesOf = (id: string) => lines.filter((line) => line.cutOrderId === id)
    const laysOf = (id: string) => lays.filter((lay) => lay.cutOrderId === id)
    const plan = dayPlan(
      orders.map((order): PlanOrder => {
        const own = linesOf(order.id)
        return {
          kind: order.kind,
          status: order.status,
          dueDate: dayOf(order.dueDate),
          createdAt: order.createdAt,
          cutAt: order.cutAt,
          cancelledAt: order.cancelledAt,
          garments: own.reduce((sum, line) => sum + line.quantity, 0),
          ratioSum: own.reduce((sum, line) => sum + (line.ratio ?? 0), 0),
          cutLays: laysOf(order.id).flatMap((lay) => (lay.status === 'CUT' && lay.cutAt ? [{ cutAt: lay.cutAt, plies: lay.plyCountLeft ?? lay.plies }] : [])),
        }
      }),
      day,
      range,
    )

    const open = orders.filter((order) => (OPEN_CUT_STATUSES as readonly string[]).includes(order.status))
    const count = (status: string) => open.filter((order) => order.status === status).length
    const late = open.filter((order) => isLate({ status: order.status, dueDate: dayOf(order.dueDate) }, day)).length

    const [atTable, waitingFabric, cutLays] = await Promise.all([
      db.lay.count({ where: { siteId: site.id, status: { in: ['SPREADING', 'CHECKED'] } } }),
      db.lay.count({ where: { siteId: site.id, status: 'CUT', consumptions: { none: {} } } }),
      db.lay.findMany({ where: { siteId: site.id, status: 'CUT', cutAt: { gte: range.start, lt: range.end } }, select: { id: true, consumptions: { select: { estimated: true, recorded: true, confirmed: true } } } }),
    ])
    let estimated = ZERO
    let used = ZERO
    let confirmed = 0
    for (const lay of cutLays) {
      const consumption = lay.consumptions[0]
      if (!consumption) continue
      confirmed += 1
      estimated = estimated.plus(m4(consumption.estimated))
      used = used.plus(consumption.confirmed ? m4(consumption.confirmed) : m4(consumption.recorded))
    }

    const leather = await leatherOfDay(db, site.id, range)
    const sorted = [...open].sort((a, b) => boardOrder({ ...a, dueDate: dayOf(a.dueDate) }, { ...b, dueDate: dayOf(b.dueDate) }))
    const listed = sorted.slice(0, CUTBOARD_LIST_LIMIT)
    return {
      asOf: toUtcIso(now),
      site: { id: site.id, code: site.code, name: site.name, timeZone: site.timezone },
      sites: sites.map((entry) => ({ id: entry.id, code: entry.code, name: entry.name })),
      day,
      today,
      tiles: { planned: count('PLANNED'), released: count('RELEASED'), inProgress: count('IN_PROGRESS'), late },
      lays: { atTable, waitingFabric },
      plan,
      cut: {
        cutOrders: orders.filter((order) => order.cutAt !== null && order.cutAt >= range.start && order.cutAt < range.end).length,
        lays: cutLays.length,
        leatherPieces: leather.pieces,
      },
      hides: leather.hides,
      leather: leather.rows,
      fabric: { lays: cutLays.length, confirmed, estimated: estimated.toFixed(4), used: used.toFixed(4), differencePct: differencePct(used, estimated) },
      orders: listed.map((order) => {
        const own = linesOf(order.id)
        const live = laysOf(order.id).filter((lay) => lay.status !== 'CANCELLED')
        const workOrders = new Map(own.map((line) => [line.workOrderId, line.workOrderSize.workOrder.number]))
        return {
          id: order.id,
          number: order.number,
          kind: order.kind,
          status: order.status,
          companyId: order.companyId,
          siteId: order.siteId,
          item: order.item,
          colour: order.itemColour,
          dueDate: dayOf(order.dueDate),
          late: isLate({ status: order.status, dueDate: dayOf(order.dueDate) }, day),
          garments: own.reduce((sum, line) => sum + line.quantity, 0),
          lays: order.kind === 'FABRIC' ? { cut: live.filter((lay) => lay.status === 'CUT').length, of: live.length } : null,
          workOrders: [...workOrders.entries()].map(([id, number]) => ({ id, number })).sort((a, b) => a.number.localeCompare(b.number)),
        }
      }),
      more: Math.max(0, sorted.length - listed.length),
    }
  })
}

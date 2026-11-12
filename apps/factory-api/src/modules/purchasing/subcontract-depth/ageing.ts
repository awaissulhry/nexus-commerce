import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { decimalOf } from '@nexus/factory-domain/product/units/units'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import { AGE_BUCKETS, ageingOf, layersOf, lineDaysOut, LONG_OUT_DAYS, type AgeBucket } from '@nexus/factory-domain/purchasing/subcontract-depth/ageing'
import type { SubcontractOrderStatus } from '@nexus/factory-domain/purchasing/subcontracting/rules'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf } from '../store'
import { nameOf } from '../subcontracting/store'

/**
 * Days out of our material at each workshop (B-W2b-331; SCM-150; design purchasing.subcontracting "Stock at subcontractors"
 * › days out, and the "Balance open" tile). Office only, purchasing.view over the place's (the order's) company, site and
 * workshop; no money (the stock's value is W2a's GET …/stock, by the same keys).
 *
 *   ageing    GET /purchasing/subcontracting/ageing (siteId | partyId | locationId | itemId): our stock at every workshop
 *             place by material, colour, lot and hide, read first in, first out (factory-domain subcontract-depth/ageing):
 *             since when the oldest part is out, its days out, the quantities per bucket (up to 30, 60, 90 days, over 90),
 *             flagged past LONG_OUT_DAYS; per workshop the lines, the oldest days out and the lines past it
 *   balances  GET /purchasing/subcontracting/balances (siteId | partyId | open): the subcontract orders whose kit material is
 *             still open (sent but not declared used, returned or scrapped), with the open quantities per unit and the days
 *             the oldest open line has been out; `open=true` keeps the jobs whose pieces are all back (RECEIVED, CLOSED):
 *             the "Balance open" tile counts them
 */

const ROW_LIMIT = 5_000
const MOVE_LIMIT = 50_000
const unique = <T>(values: readonly (T | null | undefined)[]): T[] => [...new Set(values.filter((value): value is T => value !== null && value !== undefined))]
const today = (): BusinessDate => businessDate(new Date())

export interface AgeingQuery {
  readonly siteId?: string | undefined
  readonly partyId?: string | undefined
  readonly locationId?: string | undefined
  readonly itemId?: string | undefined
}

/** GET /purchasing/subcontracting/ageing */
export async function subcontractorAgeing(caller: CommandCaller, query: AgeingQuery) {
  const context = officeContextOf(caller)
  const day = today()
  return caller.withClient(async (client) => {
    const locations = await client.location.findMany({
      where: {
        AND: [
          scopeWhere(actorOf(context), PURCHASING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.LocationWhereInput,
          { kind: 'SUBCONTRACTOR' },
          query.siteId ? { siteId: query.siteId } : {},
          query.partyId ? { partyId: query.partyId } : {},
          query.locationId ? { id: query.locationId } : {},
        ],
      },
      select: { id: true, siteId: true, code: true, name: true, partyId: true },
      orderBy: { code: 'asc' },
    })
    const ids = locations.map((location) => location.id)
    if (ids.length === 0) return { asOf: day, longOutDays: LONG_OUT_DAYS, rows: [], workshops: [], truncated: false }
    const item = query.itemId ? { itemId: query.itemId } : {}
    // One query after another (a scoped client may be one transaction's connection).
    const ins = await client.stockMove.findMany({
      where: { toLocationId: { in: ids }, ...item },
      select: { toLocationId: true, itemId: true, itemColourId: true, lotId: true, hideId: true, baseQuantity: true, occurredAt: true },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: MOVE_LIMIT,
    })
    const outs = await client.stockMove.groupBy({ by: ['fromLocationId', 'itemId', 'itemColourId', 'lotId', 'hideId'], where: { fromLocationId: { in: ids }, ...item }, _sum: { baseQuantity: true } })
    const keyOf = (location: string, row: { itemId: string; itemColourId: string | null; lotId: string | null; hideId: string | null }) => `${location}|${row.itemId}|${row.itemColourId}|${row.lotId}|${row.hideId}`
    const grouped = new Map<string, { locationId: string; itemId: string; itemColourId: string | null; lotId: string | null; hideId: string | null; ins: { at: Date; quantity: string }[]; out: string }>()
    for (const move of ins) {
      const key = keyOf(move.toLocationId!, move)
      const entry = grouped.get(key) ?? { locationId: move.toLocationId!, itemId: move.itemId, itemColourId: move.itemColourId, lotId: move.lotId, hideId: move.hideId, ins: [], out: '0' }
      entry.ins.push({ at: move.occurredAt, quantity: move.baseQuantity.toString() })
      grouped.set(key, entry)
    }
    for (const out of outs) {
      const entry = grouped.get(keyOf(out.fromLocationId!, out))
      if (entry) entry.out = out._sum.baseQuantity?.toString() ?? '0'
    }
    const lines = [...grouped.values()]
      .map((entry) => {
        const layers = layersOf(entry.ins, entry.out)
        const onHand = layers.reduce((sum, layer) => sum.plus(layer.quantity), new Dec(0))
        return { ...entry, onHand, ageing: ageingOf(layers, day) }
      })
      .filter((entry) => entry.onHand.greaterThan(0))
      .sort((a, b) => (b.ageing.daysOut ?? 0) - (a.ageing.daysOut ?? 0))
    const items = new Map((await client.item.findMany({ where: { id: { in: unique(lines.map((row) => row.itemId)) } }, select: { id: true, code: true, name: true, baseUom: true } })).map((row) => [row.id, row]))
    const colours = new Map((await client.itemColour.findMany({ where: { id: { in: unique(lines.map((row) => row.itemColourId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
    const lots = new Map((await client.lot.findMany({ where: { id: { in: unique(lines.map((row) => row.lotId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
    const hides = new Map((await client.hide.findMany({ where: { id: { in: unique(lines.map((row) => row.hideId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
    const parties = new Map((await client.party.findMany({ where: { id: { in: unique(locations.map((row) => row.partyId)) } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((row) => [row.id, { id: row.id, code: row.code, name: nameOf(row) }]))
    const sites = new Map((await client.site.findMany({ where: { id: { in: unique(locations.map((row) => row.siteId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
    const locationOf = new Map(locations.map((location) => [location.id, location]))
    const workshopOf = (location: (typeof locations)[number]) => parties.get(location.partyId ?? '') ?? { id: location.partyId ?? location.id, code: '', name: '' }
    const rows = lines.slice(0, ROW_LIMIT).map((line) => {
      const location = locationOf.get(line.locationId)!
      const itemRow = items.get(line.itemId)
      return {
        site: sites.get(location.siteId) ?? { id: location.siteId, code: '' },
        workshop: workshopOf(location),
        location: { id: location.id, code: location.code, name: location.name },
        item: itemRow ? { id: itemRow.id, code: itemRow.code, name: itemRow.name, baseUom: itemRow.baseUom } : { id: line.itemId, code: '', name: '', baseUom: 'PCS' as const },
        colour: line.itemColourId ? (colours.get(line.itemColourId) ?? null) : null,
        lot: line.lotId ? (lots.get(line.lotId) ?? null) : null,
        hide: line.hideId ? (hides.get(line.hideId) ?? null) : null,
        onHand: line.onHand.toFixed(4),
        since: line.ageing.since,
        daysOut: line.ageing.daysOut,
        buckets: line.ageing.buckets,
        longOut: line.ageing.longOut,
      }
    })
    const workshops = locations
      .map((location) => {
        const mine = lines.filter((line) => line.locationId === location.id)
        const perBucket = Object.fromEntries(AGE_BUCKETS.map((bucket) => [bucket, 0])) as Record<AgeBucket, number>
        for (const line of mine) {
          for (const bucket of AGE_BUCKETS) if (decimalOf(line.ageing.buckets[bucket]).greaterThan(0)) perBucket[bucket] += 1
        }
        return {
          workshop: workshopOf(location),
          location: { id: location.id, code: location.code, name: location.name },
          site: sites.get(location.siteId) ?? { id: location.siteId, code: '' },
          lines: mine.length,
          oldestDaysOut: mine.reduce<number | null>((top, line) => (line.ageing.daysOut === null ? top : top === null ? line.ageing.daysOut : Math.max(top, line.ageing.daysOut)), null),
          longOut: mine.filter((line) => line.ageing.longOut).length,
          linesPerBucket: perBucket,
        }
      })
      .filter((entry) => entry.lines > 0 || query.locationId !== undefined || query.partyId !== undefined)
    return { asOf: day, longOutDays: LONG_OUT_DAYS, rows, workshops, truncated: lines.length > ROW_LIMIT || ins.length >= MOVE_LIMIT }
  })
}

export interface BalancesQuery {
  readonly siteId?: string | undefined
  readonly partyId?: string | undefined
  /** Only the jobs whose pieces are all back and whose material is still open: the "Balance open" tile. */
  readonly open?: boolean | undefined
}

const BACK_STATUSES: readonly SubcontractOrderStatus[] = ['RECEIVED', 'CLOSED']
const OPEN_STATUSES: readonly SubcontractOrderStatus[] = ['AT_WORKSHOP', 'PARTLY_RECEIVED', ...BACK_STATUSES]

/** GET /purchasing/subcontracting/balances */
export async function openBalances(caller: CommandCaller, query: BalancesQuery) {
  const context = officeContextOf(caller)
  const day = today()
  return caller.withClient(async (client) => {
    const orders = await client.subcontractOrder.findMany({
      where: {
        AND: [
          scopeWhere(actorOf(context), PURCHASING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.SubcontractOrderWhereInput,
          { status: { in: [...(query.open ? BACK_STATUSES : OPEN_STATUSES)] } },
          { kitLines: { some: { status: 'SENT' } } },
          query.siteId ? { siteId: query.siteId } : {},
          query.partyId ? { partyId: query.partyId } : {},
        ],
      },
      select: { id: true, number: true, status: true, companyId: true, siteId: true, partyId: true, workOrderId: true, expectedBackDate: true, version: true },
      orderBy: [{ orderDate: 'asc' }, { id: 'asc' }],
      take: 2_000,
    })
    if (orders.length === 0) return { asOf: day, items: [], counts: { balanceOpen: 0, open: 0, longOut: 0 } }
    const lines = await client.subcontractKitLine.findMany({ where: { subcontractOrderId: { in: orders.map((order) => order.id) }, status: 'SENT' }, select: { id: true, subcontractOrderId: true, quantity: true, uom: true, sentAt: true } })
    const sums = await client.subcontractConsumption.groupBy({ by: ['kitLineId'], where: { kitLineId: { in: lines.map((line) => line.id) } }, _sum: { usedQuantity: true, returnedQuantity: true, scrappedQuantity: true } })
    const declared = new Map(sums.map((row) => [row.kitLineId, decimalOf((row._sum.usedQuantity ?? 0).toString()).plus(decimalOf((row._sum.returnedQuantity ?? 0).toString())).plus(decimalOf((row._sum.scrappedQuantity ?? 0).toString()))]))
    const openLines = lines
      .map((line) => ({ ...line, open: decimalOf(line.quantity.toString()).minus(declared.get(line.id) ?? new Dec(0)) }))
      .filter((line) => line.open.greaterThan(0))
    const parties = new Map((await client.party.findMany({ where: { id: { in: unique(orders.map((order) => order.partyId)) } }, select: { id: true, code: true, legalName: true, tradeName: true } })).map((row) => [row.id, { id: row.id, code: row.code, name: nameOf(row) }]))
    const workOrders = new Map((await client.workOrder.findMany({ where: { id: { in: unique(orders.map((order) => order.workOrderId)) } }, select: { id: true, number: true } })).map((row) => [row.id, row]))
    const items = orders
      .map((order) => {
        const mine = openLines.filter((line) => line.subcontractOrderId === order.id)
        const perUnit = new Map<(typeof mine)[number]['uom'], Decimal>()
        for (const line of mine) perUnit.set(line.uom, (perUnit.get(line.uom) ?? new Dec(0)).plus(line.open))
        const daysOut = mine.reduce<number | null>((top, line) => {
          const days = lineDaysOut(line.sentAt, line.open.toFixed(4), day)
          return days === null ? top : top === null ? days : Math.max(top, days)
        }, null)
        return {
          order: { id: order.id, number: order.number, status: order.status, version: order.version, workshop: parties.get(order.partyId) ?? { id: order.partyId, code: '', name: '' }, workOrder: workOrders.get(order.workOrderId) ?? { id: order.workOrderId, number: '' } },
          kitLines: lines.filter((line) => line.subcontractOrderId === order.id).length,
          openLines: mine.length,
          open: [...perUnit.entries()].map(([uom, quantity]) => ({ uom, quantity: quantity.toFixed(4) })),
          oldestSentAt: mine.reduce<Date | null>((first, line) => (line.sentAt && (first === null || line.sentAt < first) ? line.sentAt : first), null),
          daysOut,
          balanceOpen: BACK_STATUSES.includes(order.status as SubcontractOrderStatus) && mine.length > 0,
        }
      })
      .filter((item) => item.openLines > 0)
      .map((item) => ({ ...item, oldestSentAt: item.oldestSentAt ? toUtcIso(item.oldestSentAt) : null }))
    return {
      asOf: day,
      items,
      counts: { balanceOpen: items.filter((item) => item.balanceOpen).length, open: items.length, longOut: items.filter((item) => item.daysOut !== null && item.daysOut > LONG_OUT_DAYS).length },
    }
  })
}

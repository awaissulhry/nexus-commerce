import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { reasonsInForce, type ShipmentHoldReason } from '@nexus/factory-domain/shipping/holds/holds'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { carrierKeyOf } from '@nexus/factory-domain/shipping/queue/cutoff'
import { AT_RISK_QUEUE, earliestDay, riskOf, riskRank, willMiss, type QueueRisk } from '@nexus/factory-domain/shipping/queue/risk'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { mayOn, officeContextOf } from '../access'
import { readyToShip } from '../shipments/ready'
import { factsOf, holdsInForceBy } from '../holds/store'
import { shipByLookup } from './promise'
import { cutOffToday, siteDaysOf, type CutOffToday, type SiteDay } from './site-day'

/**
 * The ship-today queue and the at-risk queue (B-W2b-386; LOG-018, LOG-110; design warehouse.shipments "Carrier cut-offs
 * today", the views Ship today and At risk of missing the promise; rules factory-domain shipping/queue). Office,
 * shipping.view: the open shipments (DRAFT, PACKED) of a site the reader's grants reach, each with its ship-by day (the
 * current promise of its garments), its carrier's cut-off today on the site's clock, its holds and its risk. The at-risk
 * queue adds the orders whose released garments are due and on no shipment yet (not packed by the cut-off). No money, no
 * person.
 */

const OPEN_LIMIT = 1000

const place = (shipTo: unknown) => {
  const value = shipTo && typeof shipTo === 'object' ? (shipTo as Record<string, unknown>) : {}
  return { city: typeof value.city === 'string' && value.city !== '' ? value.city : null, country: typeof value.country === 'string' && value.country !== '' ? value.country : null }
}

const cutOffView = (cutOff: CutOffToday | null) => (cutOff ? { time: cutOff.time, at: toUtcIso(cutOff.at), source: cutOff.source, minutesLeft: cutOff.minutesLeft, passed: cutOff.passed } : null)

const dayView = (day: SiteDay) => ({
  siteId: day.siteId,
  companyId: day.companyId,
  code: day.code,
  name: day.name,
  timeZone: day.timeZone,
  today: day.today,
  open: day.open,
  closed: day.closed,
  nextWorkingDay: day.nextWorkingDay,
})

/** The open shipments of the sites with their risk, as the queues read them. */
async function openRows(caller: CommandCaller, siteIds: readonly string[], warnMinutes: number | undefined, now: Date, days: ReadonlyMap<string, SiteDay>) {
  const context = officeContextOf(caller)
  const where: Prisma.ShipmentWhereInput = {
    AND: [scopeWhere(actorOf(context), SHIPPING_VIEW, { company: 'companyId', site: 'siteId', party: 'partyId' }) as Prisma.ShipmentWhereInput, { status: { in: ['DRAFT', 'PACKED'] }, siteId: { in: [...siteIds] } }],
  }
  return caller.withClient(async (client) => {
    const rows = await client.shipment.findMany({
      where,
      orderBy: { id: 'asc' },
      take: OPEN_LIMIT,
      select: {
        id: true,
        number: true,
        status: true,
        version: true,
        companyId: true,
        siteId: true,
        partyId: true,
        salesOrderId: true,
        transportBy: true,
        carrierCode: true,
        carrierName: true,
        serviceCode: true,
        shipTo: true,
        splitFromId: true,
        salesOrder: { select: { number: true, customerRef: true, party: { select: { code: true, legalName: true } } } },
        lines: { select: { salesOrderLineId: true, size: true, quantity: true } },
        parcels: { select: { trackingNumber: true, labelledAt: true } },
      },
    })
    const visible = rows.filter((row) => mayOn(context, SHIPPING_VIEW, row))
    const shipBy = await shipByLookup(client, visible.flatMap((row) => row.lines))
    const holds = await holdsInForceBy(client, visible.map((row) => row.id))
    return visible.map((row) => {
      const day = days.get(row.siteId)!
      const key = carrierKeyOf(row)
      const cutOff = cutOffToday(day, key, now)
      const due = earliestDay(row.lines.map((line) => shipBy(line.salesOrderLineId, line.size)))
      const reasons = reasonsInForce((holds.get(row.id) ?? []).map(factsOf))
      const risk: QueueRisk = riskOf({ shipBy: due, today: day.today, now, status: row.status as 'DRAFT' | 'PACKED', held: reasons.length > 0, siteOpen: day.open, cutOffAt: cutOff?.at ?? null, dayEnd: day.dayEnd, warnMinutes })
      return {
        id: row.id,
        number: row.number,
        status: row.status,
        version: row.version,
        companyId: row.companyId,
        siteId: row.siteId,
        partyId: row.partyId,
        salesOrderId: row.salesOrderId,
        salesOrderNumber: row.salesOrder.number,
        customerRef: row.salesOrder.customerRef,
        partyCode: row.salesOrder.party.code,
        partyName: row.salesOrder.party.legalName,
        carrierKey: key,
        transportBy: row.transportBy,
        carrierCode: row.carrierCode,
        carrierName: row.carrierName,
        serviceCode: row.serviceCode,
        shipTo: place(row.shipTo),
        splitFromId: row.splitFromId,
        garments: row.lines.reduce((sum, line) => sum + line.quantity, 0),
        parcels: row.parcels.length,
        labelled: row.parcels.filter((parcel) => parcel.trackingNumber !== null && parcel.labelledAt !== null).length,
        shipBy: due,
        cutOff: cutOffView(cutOff),
        risk,
        willMiss: willMiss(risk),
        held: reasons.length > 0,
        holdReasons: reasons as ShipmentHoldReason[],
      }
    })
  })
}
type QueueRow = Awaited<ReturnType<typeof openRows>>[number]

const byUrgency = (a: QueueRow, b: QueueRow) =>
  riskRank(a.risk) - riskRank(b.risk) || (a.cutOff?.at ?? '9').localeCompare(b.cutOff?.at ?? '9') || (a.shipBy ?? '9').localeCompare(b.shipBy ?? '9') || a.number.localeCompare(b.number)

const isDue = (row: QueueRow, today: BusinessDate): boolean => row.shipBy !== null && row.shipBy <= today

export interface QueueQuery {
  readonly siteId: string
  readonly warnMinutes?: number | undefined
}

/** The site's day the reader may see (else 404). */
async function siteDayFor(caller: CommandCaller, siteId: string, now: Date): Promise<SiteDay> {
  const context = officeContextOf(caller)
  const day = (await caller.withClient((client) => siteDaysOf(client, [siteId], now))).get(siteId)
  if (!day || !mayOn(context, SHIPPING_VIEW, { companyId: day.companyId, siteId: day.siteId })) throw new NotFoundError('Site not found.')
  return day
}

/**
 * GET /shipping/queue/today?siteId (shipping.view): what must leave the site today — the open shipments due today or
 * before, worst first — with one card per carrier (its cut-off today and how many are packed, still to pack, held, will
 * miss) and the day's tiles.
 */
export async function shipToday(caller: CommandCaller, query: QueueQuery) {
  const now = serverClock.now()
  const day = await siteDayFor(caller, query.siteId, now)
  const rows = await openRows(caller, [day.siteId], query.warnMinutes, now, new Map([[day.siteId, day]]))
  const due = rows.filter((row) => isDue(row, day.today)).sort(byUrgency)
  const cards = new Map<string, QueueRow[]>()
  for (const row of due) cards.set(row.carrierKey, [...(cards.get(row.carrierKey) ?? []), row])
  const carriers = [...cards.entries()]
    .map(([key, list]) => {
      const first = list[0]!
      return {
        key,
        transportBy: first.transportBy,
        carrierCode: first.carrierCode,
        carrierName: first.carrierName,
        cutOff: cutOffView(cutOffToday(day, key, now)),
        shipments: list.length,
        packed: list.filter((row) => row.status === 'PACKED').length,
        toPack: list.filter((row) => row.status === 'DRAFT').length,
        labelled: list.filter((row) => row.parcels > 0 && row.labelled === row.parcels).length,
        held: list.filter((row) => row.held).length,
        willMiss: list.filter((row) => row.willMiss).length,
        parcels: list.reduce((sum, row) => sum + row.parcels, 0),
        garments: list.reduce((sum, row) => sum + row.garments, 0),
      }
    })
    .sort((a, b) => (a.cutOff?.at ?? '9').localeCompare(b.cutOff?.at ?? '9') || a.key.localeCompare(b.key))
  return {
    site: dayView(day),
    now: toUtcIso(now),
    carriers,
    tiles: {
      dueToday: due.length,
      toPack: due.filter((row) => row.status === 'DRAFT').length,
      packed: due.filter((row) => row.status === 'PACKED').length,
      held: due.filter((row) => row.held).length,
      atRisk: due.filter((row) => AT_RISK_QUEUE.includes(row.risk)).length,
      willMiss: due.filter((row) => row.willMiss).length,
      late: due.filter((row) => row.risk === 'LATE').length,
      /** Open shipments due later or with no promise known (not in today's queue). */
      notDue: rows.length - due.length,
    },
    shipments: due,
    truncated: rows.length >= OPEN_LIMIT,
  }
}

export interface AtRiskQuery {
  readonly siteId?: string | undefined
  readonly warnMinutes?: number | undefined
}

const MAX_SITES = 20
const READY_PAGES = 10

/**
 * GET /shipping/queue/at-risk?siteId (shipping.view): the shipments that will miss their promise (late, held, past the
 * cut-off) or may (not packed with the cut-off near), worst first, and the orders whose released garments are due and on no
 * shipment yet. Without a site: every site the reader sees (at most 20).
 */
export async function atRisk(caller: CommandCaller, query: AtRiskQuery) {
  const context = officeContextOf(caller)
  const now = serverClock.now()
  const siteIds = query.siteId
    ? [query.siteId]
    : (await caller.withClient((client) => client.site.findMany({ select: { id: true, companyId: true }, orderBy: { code: 'asc' } }))).filter((site) => mayOn(context, SHIPPING_VIEW, { companyId: site.companyId, siteId: site.id })).slice(0, MAX_SITES).map((site) => site.id)
  if (query.siteId) await siteDayFor(caller, query.siteId, now)
  const days = await caller.withClient((client) => siteDaysOf(client, siteIds, now))
  const rows = (await openRows(caller, [...days.keys()], query.warnMinutes, now, days)).filter((row) => AT_RISK_QUEUE.includes(row.risk)).sort(byUrgency)
  const orders: Awaited<ReturnType<typeof readyToShip>>['orders'] = []
  for (const siteId of days.keys()) {
    let cursor: string | undefined
    for (let page = 0; page < READY_PAGES; page++) {
      const ready = await readyToShip(caller, { siteId, cursor, warnMinutes: query.warnMinutes })
      orders.push(...ready.orders.filter((order) => AT_RISK_QUEUE.includes(order.risk)))
      if (!ready.nextCursor) break
      cursor = ready.nextCursor
    }
  }
  return {
    now: toUtcIso(now),
    sites: [...days.values()].map(dayView),
    tiles: {
      late: rows.filter((row) => row.risk === 'LATE').length,
      held: rows.filter((row) => row.risk === 'HELD').length,
      missedCutOff: rows.filter((row) => row.risk === 'MISSED_CUT_OFF').length,
      atRisk: rows.filter((row) => row.risk === 'AT_RISK').length,
      notPlanned: orders.length,
    },
    shipments: rows,
    /** Orders with released garments due and on no shipment yet: not packed by the cut-off. */
    notPlanned: orders.map((order) => ({ salesOrderId: order.salesOrderId, number: order.number, customerRef: order.customerRef, partyCode: order.party.code, partyName: order.party.legalName, siteId: order.shipBy?.siteId ?? null, shipBy: order.shipBy?.day ?? null, cutOff: order.shipBy?.cutOff ?? null, risk: order.risk, garments: order.cells.reduce((sum, cell) => sum + cell.shippable, 0) })),
  }
}

/**
 * Today's source (modules/insights/sources/shipments-at-risk.ts; attention kind SHIPMENT_AT_RISK): the open shipments of every
 * site the reader sees (at most 20) that are in the at-risk queue, worst first.
 */
export async function shipmentsAtRiskFor(caller: CommandCaller): Promise<{ rows: QueueRow[]; complete: boolean }> {
  const context = officeContextOf(caller)
  const now = serverClock.now()
  const sites = (await caller.withClient((client) => client.site.findMany({ select: { id: true, companyId: true }, orderBy: { code: 'asc' } }))).filter((site) => mayOn(context, SHIPPING_VIEW, { companyId: site.companyId, siteId: site.id }))
  const days = await caller.withClient((client) => siteDaysOf(client, sites.slice(0, MAX_SITES).map((site) => site.id), now))
  const rows = (await openRows(caller, [...days.keys()], undefined, now, days)).filter((row) => AT_RISK_QUEUE.includes(row.risk)).sort(byUrgency)
  return { rows, complete: sites.length <= MAX_SITES && rows.length < OPEN_LIMIT }
}

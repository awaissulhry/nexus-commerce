import type { Prisma, Uom } from '@nexus/factory-db'
import { actorOf } from '../../../core/context'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { addDays } from '@nexus/factory-domain/planning/buy'
import { checkShipNotice, noticeStateOf, NOTICE_STATE_WORDS } from '@nexus/factory-domain/purchasing/ship-notices/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import type { CommandCaller } from '../../../core/command'
import { officeContextOf } from '../../inventory/ledger/access'
import { expectedLinesOf } from '../orders'
import { dayOf, dayValue } from '../store'

/**
 * The inbound board (B-W2b-182; SCM-110 "Inbound board"; design warehouse.receipts sec:rc-inbound "Expected arrivals by day
 * and site from ship notices and confirmed POs: 7 day columns × site rows; a card per delivery: supplier, PO, lines, ASN
 * tracking status, dock note"). One read for the office's Receipts page, inventory.stock.view over each site (scopeWhere):
 *
 *   a ship notice card   every SENT notice of the sites, on its expected day (else its ship day); one expected before the
 *                        board's first day and not received is drawn on the first day, marked late
 *   an order card        the lines of CONFIRMED and PARTLY_RECEIVED orders still to come (W1's expected lines: the confirmed
 *                        date, else the date asked), one card per order and day, the lines a sent notice already announces
 *                        left out (that notice's card carries them)
 *
 * No price, cost or amount; no person. The board's day is the business calendar's (Europe/Rome).
 */

const CARDS_MAX = 400
const ITEMS_ON_CARD = 3

export interface InboundQuery {
  readonly from?: BusinessDate | undefined
  readonly days?: number | undefined
  readonly siteId?: string | undefined
}

export async function inboundBoard(caller: CommandCaller, query: InboundQuery, now: Date) {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const today = businessDate(now)
  const from = query.from ?? today
  const count = query.days ?? 7
  const days = Array.from({ length: count }, (_, index) => addDays(from, index))
  const until = addDays(from, count)
  return caller.withClient(async (client) => {
    const sites = await client.site.findMany({
      where: { AND: [scopeWhere(actor, INVENTORY_STOCK_VIEW, { company: 'companyId', site: 'id' }) as Prisma.SiteWhereInput, query.siteId ? { id: query.siteId } : {}] },
      orderBy: { code: 'asc' },
      select: { id: true, code: true, name: true, companyId: true },
    })
    const siteIds = sites.map((site) => site.id)
    if (siteIds.length === 0) return { asOf: toUtcIso(now), from, days, sites: [], cards: [], complete: true }

    // Ship notices on their way: expected inside the board, or late (expected before it and not received).
    const notices = await client.shipNotice.findMany({
      where: {
        siteId: { in: siteIds },
        status: 'SENT',
        OR: [{ expectedDate: { lt: dayValue(until) } }, { expectedDate: null, shipDate: { lt: dayValue(until) } }],
      },
      orderBy: [{ expectedDate: 'asc' }, { number: 'asc' }],
      take: CARDS_MAX + 1,
      select: {
        id: true,
        number: true,
        status: true,
        siteId: true,
        partyId: true,
        purchaseOrderId: true,
        supplierRef: true,
        ddtNumber: true,
        shipDate: true,
        expectedDate: true,
        carrier: true,
        trackingNumber: true,
        parcels: true,
        note: true,
        internalNote: true,
        version: true,
        lines: { orderBy: { seq: 'asc' }, select: { id: true, seq: true, purchaseOrderLineId: true, quantity: true, uom: true, dyeBatch: true, receivedQuantity: true, hides: { select: { seq: true, hideNumber: true, area: true, areaUom: true, grade: true, thicknessMm: true, dyeBatch: true } } } },
      },
    })
    const announcedLines = new Set(notices.flatMap((notice) => notice.lines.map((line) => line.purchaseOrderLineId)))

    // Confirmed orders' lines still to come (W1's expected lines), at the board's sites.
    const expected = await expectedLinesOf(client as unknown as Prisma.TransactionClient, [{ siteId: { in: siteIds } }, { status: { in: ['CONFIRMED', 'PARTLY_RECEIVED'] } }], today)
    const orderLines = expected.lines.filter((line) => !announcedLines.has(line.lineId) && line.expectedDate < until)

    const orderIds = [...new Set([...notices.map((notice) => notice.purchaseOrderId), ...orderLines.map((line) => line.purchaseOrderId)])]
    const orders = new Map((await client.purchaseOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true, siteId: true, partyId: true } })).map((order) => [order.id, order]))
    const parties = new Map((await client.party.findMany({ where: { id: { in: [...new Set([...orders.values()].map((order) => order.partyId))] } }, select: { id: true, legalName: true } })).map((party) => [party.id, party.legalName]))
    const poLines = await client.purchaseOrderLine.findMany({
      where: { id: { in: [...new Set([...notices.flatMap((notice) => notice.lines.map((line) => line.purchaseOrderLineId)), ...orderLines.map((line) => line.lineId)])] } },
      select: { id: true, seq: true, uom: true, grade: true, thicknessMinMm: true, thicknessMaxMm: true, oneDyeBatch: true, areaTolerancePct: true, estimatedHides: true, quantity: true, confirmedQuantity: true, item: { select: { code: true, name: true, tracking: true } } },
    })
    const lineOf = new Map(poLines.map((line) => [line.id, line]))

    const cards = []
    for (const notice of notices.slice(0, CARDS_MAX)) {
      const expectedDay = dayOf(notice.expectedDate) ?? dayOf(notice.shipDate) ?? today
      const late = expectedDay < today
      const day = expectedDay < from ? from : expectedDay
      if (day >= until) continue
      const order = orders.get(notice.purchaseOrderId)
      const state = noticeStateOf({ status: notice.status, shipDate: dayOf(notice.shipDate), lines: [] }, today)
      // The card's verdict: the packing list against the order lines' asks (the dock sees what to look at; the full check with
      // what was received and Cr VI is the notice's own page).
      const check = checkShipNotice({
        orderLines: notice.lines.flatMap((line) => {
          const po = lineOf.get(line.purchaseOrderLineId)
          if (!po) return []
          const asked = (po.confirmedQuantity ?? po.quantity).toString()
          return [{ id: po.id, seq: po.seq, uom: po.uom as Uom, leather: po.item.tracking === 'HIDE', expected: asked, received: '0', inTransit: '0', tolerancePct: po.areaTolerancePct?.toString() ?? null, grade: po.grade, thicknessMinMm: po.thicknessMinMm?.toString() ?? null, thicknessMaxMm: po.thicknessMaxMm?.toString() ?? null, oneDyeBatch: po.oneDyeBatch, estimatedHides: null, requiresCrViTest: false, earlierDyeBatches: [] }]
        }),
        lines: notice.lines.map((line) => ({ id: line.id, seq: line.seq, purchaseOrderLineId: line.purchaseOrderLineId, quantity: line.quantity.toString(), uom: line.uom as Uom, dyeBatch: line.dyeBatch })),
        hides: notice.lines.flatMap((line) => line.hides.map((hide) => ({ lineId: line.id, seq: hide.seq, hideNumber: hide.hideNumber, area: hide.area.toString(), areaUom: hide.areaUom as Uom, grade: hide.grade, thicknessMm: hide.thicknessMm?.toString() ?? null, dyeBatch: hide.dyeBatch }))),
        crViEvidence: true,
      })
      cards.push({
        id: `asn:${notice.id}`,
        kind: 'SHIP_NOTICE' as const,
        day,
        late,
        siteId: notice.siteId,
        supplier: { id: notice.partyId, name: parties.get(notice.partyId) ?? '' },
        purchaseOrder: { id: notice.purchaseOrderId, number: order?.number ?? '' },
        shipNotice: {
          id: notice.id,
          number: notice.number ?? '',
          state,
          words: NOTICE_STATE_WORDS[state],
          shipDate: dayOf(notice.shipDate),
          carrier: notice.carrier,
          trackingNumber: notice.trackingNumber,
          parcels: notice.parcels,
          supplierRef: notice.supplierRef,
          ddtNumber: notice.ddtNumber,
          hides: notice.lines.reduce((sum, line) => sum + line.hides.length, 0),
          verdict: check.verdict,
          supplierNote: notice.note,
          version: notice.version,
        },
        lines: notice.lines.length,
        items: notice.lines.slice(0, ITEMS_ON_CARD).map((line) => {
          const po = lineOf.get(line.purchaseOrderLineId)
          return { code: po?.item.code ?? '', name: po?.item.name ?? '', quantity: new Dec(line.quantity.toString()).toFixed(4), uom: line.uom as Uom }
        }),
        dockNote: notice.internalNote,
      })
    }

    // One card per order and day (its lines' remaining quantity in their own unit).
    const groups = new Map<string, typeof orderLines>()
    for (const line of orderLines) {
      const day = line.expectedDate < from ? from : line.expectedDate
      const key = `${line.purchaseOrderId}:${day}`
      groups.set(key, [...(groups.get(key) ?? []), line])
    }
    for (const [key, lines] of groups) {
      const [orderId, day] = key.split(':') as [string, BusinessDate]
      const order = orders.get(orderId)
      if (!order || !siteIds.includes(order.siteId)) continue
      cards.push({
        id: `po:${key}`,
        kind: 'ORDER' as const,
        day,
        late: lines.some((line) => line.expectedDate < today),
        siteId: order.siteId,
        supplier: { id: order.partyId, name: parties.get(order.partyId) ?? '' },
        purchaseOrder: { id: order.id, number: order.number },
        shipNotice: null,
        lines: lines.length,
        items: lines.slice(0, ITEMS_ON_CARD).map((line) => {
          const po = lineOf.get(line.lineId)
          // What is still to come, in the order line's own unit.
          const rest = po && !new Dec(line.expectedBase).isZero() ? new Dec(line.outstandingBase).times(po.confirmedQuantity ?? po.quantity).dividedBy(line.expectedBase) : new Dec(line.outstandingBase)
          return { code: po?.item.code ?? '', name: po?.item.name ?? '', quantity: rest.toFixed(4), uom: (po?.uom ?? line.uom) as Uom }
        }),
        dockNote: null,
      })
    }
    cards.sort((a, b) => (a.day === b.day ? (a.kind === b.kind ? a.purchaseOrder.number.localeCompare(b.purchaseOrder.number) : a.kind === 'SHIP_NOTICE' ? -1 : 1) : a.day.localeCompare(b.day)))
    return {
      asOf: toUtcIso(now),
      from,
      days,
      sites: sites.map((site) => ({ id: site.id, code: site.code, name: site.name })),
      cards,
      complete: notices.length <= CARDS_MAX && expected.complete,
    }
  })
}

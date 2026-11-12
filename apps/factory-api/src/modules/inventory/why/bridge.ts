import type { FactoryClient, Prisma, StockMoveReason } from '@nexus/factory-db'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { locationDelta, siteDelta } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { bridgeOf, bridgeWords, FORMULA_WORDS, type ReasonSum } from '@nexus/factory-domain/inventory/why/bridge'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { plusCalendarDays } from '@nexus/factory-domain/timers/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayAt, officeContextOf } from '../ledger/access'
import { fixed, SCOPE } from '../stock/read-kit'
import { before, postingDayRange, type DayBasis } from './days'

/**
 * GET /inventory/why (B-W2b-314; SCM-191 "start balance, each move by kind, end balance, every step a link to its move";
 * design warehouse.stock st-why "Why is it 84.20 m²?", warehouse.moves mv-why BalanceBridge). One stock key — a site's
 * stock of an item, narrowed by colour, lot, hide and location — over the days `from` … `to` (by the day the moves count on
 * in the books, or the day they happened): the balance at the start, one step per reason with what it brought in and took
 * out, the balance at the end read apart from the steps (a gap is a bug, and the words say so), the figure now, the last
 * five moves, and for each step the Movements grid's query of its moves (its only move's id when it has one).
 *
 * Office, inventory.stock.view at the site (a site the reader may not see is not found); read only, on the reader's client.
 * W1's GET /inventory/stock/explain (one figure as of an instant, per reason) stays as it is.
 */

export interface WhyQuery {
  readonly siteId: string
  readonly itemId: string
  readonly itemColourId?: string | undefined
  readonly lotId?: string | undefined
  readonly hideId?: string | undefined
  readonly locationId?: string | undefined
  readonly from?: string | undefined
  readonly to?: string | undefined
  readonly basis?: DayBasis | undefined
}

type Db = FactoryClient

const keyWhere = (query: WhyQuery): Prisma.StockMoveWhereInput[] => [
  { siteId: query.siteId, itemId: query.itemId },
  query.itemColourId ? { itemColourId: query.itemColourId } : {},
  query.lotId ? { lotId: query.lotId } : {},
  query.hideId ? { hideId: query.hideId } : {},
  query.locationId ? { OR: [{ fromLocationId: query.locationId }, { toLocationId: query.locationId }] } : {},
]

/** The figure of the moves matching `where`: the location's, else the site's (Σ in − Σ out). One query after another. */
async function balance(db: Db, where: Prisma.StockMoveWhereInput, locationId: string | null): Promise<Decimal> {
  const into = await db.stockMove.aggregate({ where: { AND: [where, locationId ? { toLocationId: locationId } : { toLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
  const outOf = await db.stockMove.aggregate({ where: { AND: [where, locationId ? { fromLocationId: locationId } : { fromLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
  return new Dec(into._sum.baseQuantity?.toString() ?? '0').minus(outOf._sum.baseQuantity?.toString() ?? '0')
}

const LAST_SELECT = {
  id: true,
  siteId: true,
  itemId: true,
  itemColourId: true,
  lotId: true,
  hideId: true,
  reason: true,
  occurredAt: true,
  postingDate: true,
  fromLocationId: true,
  toLocationId: true,
  baseQuantity: true,
  workOrderId: true,
  reference: true,
  receiptLine: { select: { receipt: { select: { id: true, number: true } } } },
} as const satisfies Prisma.StockMoveSelect

export async function whyIsItThisNumber(caller: CommandCaller, query: WhyQuery, now: Date = new Date()) {
  const context = officeContextOf(caller)
  const basis: DayBasis = query.basis ?? 'POSTING'
  const today = businessDate(now)
  const to = query.to ?? today
  const from = query.from ?? null
  if (from !== null && from > to) throw new ValidationError('The period starts after it ends.', [{ path: 'querystring/from', message: 'The first day is on or before the last day.' }])
  const locationId = query.locationId ?? null
  const scope = scopeWhere(actorOf(context), INVENTORY_STOCK_VIEW, SCOPE) as Prisma.StockMoveWhereInput
  const key: Prisma.StockMoveWhereInput = { AND: [scope, ...keyWhere(query)] }
  const period: Prisma.StockMoveWhereInput = { AND: [key, postingDayRange(from, to, basis)] }

  return caller.withClient(async (db) => {
    const site = await db.site.findUnique({ where: { id: query.siteId }, select: { id: true, companyId: true, code: true, name: true } })
    const item = await db.item.findUnique({ where: { id: query.itemId }, select: { id: true, code: true, name: true, baseUom: true, tracking: true } })
    if (!site || !item || !mayAt(context, INVENTORY_STOCK_VIEW, { companyId: site.companyId, siteId: site.id })) throw new NotFoundError('Stock not found.')
    const colour = query.itemColourId ? await db.itemColour.findUnique({ where: { id: query.itemColourId }, select: { id: true, code: true, name: true, itemId: true } }) : null
    const lot = query.lotId ? await db.lot.findUnique({ where: { id: query.lotId }, select: { id: true, code: true, siteId: true } }) : null
    const hide = query.hideId ? await db.hide.findUnique({ where: { id: query.hideId }, select: { id: true, code: true, siteId: true } }) : null
    const location = locationId ? await db.location.findUnique({ where: { id: locationId }, select: { id: true, code: true, name: true, siteId: true } }) : null
    if ((query.itemColourId && colour?.itemId !== item.id) || (query.lotId && lot?.siteId !== site.id) || (query.hideId && hide?.siteId !== site.id) || (locationId && location?.siteId !== site.id)) {
      throw new NotFoundError('Stock not found.')
    }

    const start = from === null ? new Dec(0) : await balance(db, { AND: [key, before(from, basis)] }, locationId)
    const end = await balance(db, { AND: [key, before(plusCalendarDays(to, 1), basis)] }, locationId)
    const onHandNow = await balance(db, key, locationId)
    const into = await db.stockMove.groupBy({ by: ['reason'], where: { AND: [period, locationId ? { toLocationId: locationId } : { toLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
    const outOf = await db.stockMove.groupBy({ by: ['reason'], where: { AND: [period, locationId ? { fromLocationId: locationId } : { fromLocationId: { not: null } }] }, _sum: { baseQuantity: true } })
    const counted = await db.stockMove.groupBy({ by: ['reason'], where: period, _count: { _all: true } })
    const sumOf = (rows: typeof into, reason: StockMoveReason) => rows.find((row) => row.reason === reason)?._sum.baseQuantity?.toString() ?? '0'
    const sums: ReasonSum[] = counted.map((row) => ({ reason: row.reason, in: sumOf(into, row.reason), out: sumOf(outOf, row.reason), moves: row._count._all }))
    const bridge = bridgeOf({ start, sums, end })

    // The link of a step (and of all moves): the Movements grid's query over the same key and days.
    const keyQuery = {
      siteId: site.id,
      itemId: item.id,
      ...(query.itemColourId ? { itemColourId: query.itemColourId } : {}),
      ...(query.lotId ? { lotId: query.lotId } : {}),
      ...(query.hideId ? { hideId: query.hideId } : {}),
      ...(locationId ? { locationId } : {}),
    }
    const days =
      basis === 'POSTING'
        ? { ...(from ? { postedFrom: from } : {}), postedTo: to }
        : { ...(from ? { from: toUtcIso(businessDayStart(from)) } : {}), to: toUtcIso(businessDayStart(plusCalendarDays(to, 1))) }
    const link = (reason?: StockMoveReason) => ({ path: '/inventory/ledger' as const, query: { ...keyQuery, ...(reason ? { reasons: reason } : {}), ...days } })
    const steps = []
    for (const step of bridge.steps) {
      const only = step.moves === 1 ? await db.stockMove.findFirst({ where: { AND: [period, { reason: step.reason }] }, select: { id: true } }) : null
      steps.push({ ...step, moveId: only?.id ?? null, link: link(step.reason) })
    }

    const recent = await db.stockMove.findMany({ where: period, orderBy: { id: 'desc' }, take: 5, select: LAST_SELECT })
    const orders = [...new Set(recent.flatMap((row) => (row.workOrderId ? [row.workOrderId] : [])))]
    const numbers = new Map((orders.length ? await db.workOrder.findMany({ where: { id: { in: orders } }, select: { id: true, number: true } }) : []).map((row) => [row.id, row.number]))
    const last = recent.map((row) => {
      const ledger = { ...row, baseQuantity: row.baseQuantity.toString() }
      const receipt = row.receiptLine?.receipt ?? null
      const orderNumber = row.workOrderId ? numbers.get(row.workOrderId) : undefined
      const day = row.postingDate ? row.postingDate.toISOString().slice(0, 10) : businessDate(row.occurredAt)
      return {
        id: row.id,
        reason: row.reason,
        occurredAt: toUtcIso(row.occurredAt),
        postingDay: day,
        backDated: row.postingDate !== null,
        delta: fixed(locationId ? locationDelta(ledger, locationId) : siteDelta(ledger)),
        document: receipt ? { type: 'GoodsReceipt' as const, id: receipt.id, number: receipt.number } : row.workOrderId && orderNumber ? { type: 'WorkOrder' as const, id: row.workOrderId, number: orderNumber } : null,
        reference: row.reference,
      }
    })

    const periodWords = { from, to: to as BusinessDate }
    return {
      site: { id: site.id, code: site.code, name: site.name },
      item,
      colour: colour ? { id: colour.id, code: colour.code, name: colour.name } : null,
      lot: lot ? { id: lot.id, code: lot.code } : null,
      hide: hide ? { id: hide.id, code: hide.code } : null,
      location: location ? { id: location.id, code: location.code, name: location.name } : null,
      uom: item.baseUom,
      basis,
      period: { from, to },
      start: bridge.start,
      steps,
      sum: bridge.sum,
      end: bridge.end,
      addsUp: bridge.addsUp,
      gap: bridge.gap,
      onHandNow: fixed(onHandNow),
      moves: bridge.moves,
      last,
      allMoves: link(),
      formula: { en: FORMULA_WORDS.en, it: FORMULA_WORDS.it },
      words: { en: bridgeWords(bridge, periodWords, item.baseUom, 'en'), it: bridgeWords(bridge, periodWords, item.baseUom, 'it') },
    }
  })
}

import type { Prisma } from '@nexus/factory-db'
import { heldGrains, type Grain } from '@nexus/factory-domain/auth/grains/grains'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import { isProvisional, methodWords, type CostingMethod } from '@nexus/factory-domain/costing/ledger/entries'
import { actualOf, minorParts, standardOfCells } from '@nexus/factory-domain/costing/ledger/variance'
import type { MarginsQuery, OrderMarginRowView, OrderMarginView } from '@nexus/factory-domain/costing/margins/contracts'
import {
  averageMarginPct,
  estimateNowOf,
  leatherInMix,
  marginPctOf,
  mixOfSnapshot,
  partsInMix,
  shareOf,
  shareParts,
  sumParts,
  totalOf,
  valueNowOf,
  waterfallOf,
  type Parts,
} from '@nexus/factory-domain/costing/margins/rules'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { SalesOrderStatus } from '@nexus/factory-domain/sales/orders/orders'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { contextOf } from '../../product/materials/store'
import { costFactsOf } from '../actual/reads'
import { readWorkOrders, unique, type CostedWorkOrder, type Reader } from '../actual/store'
import { methodInForce } from '../method/method'
// B-W2b-416 (FIN-050, KA3:01): the floor each order is held to (the Sales settings') and its flag.
import { belowCount, type FloorFigures } from '@nexus/factory-domain/costing/profitability/floor'
import { flagOf, floorFields, orderFloors, type OrderFloor } from './floor'
// B-SA-043: the order's extra pieces (cut beyond what it now wants).
import { madeExtraOf, type MadeExtra } from '../../sales/orders/made-extra'
// B-OM-007 (order money tab M6-B3): the freight of the orders' shipments counts in the margin now and so far.
import { shipmentsOfOrdersWhere } from '../../shipping/shipments/orders-of'
// B-OM-021 (order money tab; lead L2, L4): the hand cost lines count in the margin now and so far; the order's own target.
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { MARGIN_TARGET_ACTION } from '@nexus/factory-domain/costing/margins/hand-lines'

/**
 * Order margin from estimate to actual (B-W2a-29; FIN-047; design finance.margins SCR-155 "Order margin, quote to
 * actual", "By customer and style", the profitability DetailModal; sales.orders Margin tab). Office reads with
 * costing.view over the order's company and customer (scopeWhere / can() with company and party, so a role limited to
 * some customers sees only theirs). Computed on read from the order lines (net, cost at quote and the quote's cost
 * snapshot) and the work orders that make them (B-W2a-21's cost facts: frozen standards, estimate at release, the cost
 * ledger), by factory-domain costing/margins. The value is money.price, costs money.cost, margins money.margin; a margin
 * amount goes only to a caller who also holds the cost grain (Owner answer S2).
 */

const SCOPE = { company: 'companyId', party: 'partyId' } as const
const DONE = new Set(['COMPLETED', 'CLOSED', 'CANCELLED'])
const CHUNK = 50

const ORDER_COLUMNS = { id: true, number: true, status: true, orderDate: true, companyId: true, partyId: true, customerRef: true, currency: true } as const satisfies Prisma.SalesOrderSelect
type OrderRow = Prisma.SalesOrderGetPayload<{ select: typeof ORDER_COLUMNS }>

const LINE_COLUMNS = { id: true, orderId: true, seq: true, styleId: true, colourwayId: true, quantity: true, netAmount: true, costAmount: true, quoteLineId: true, closedShortQuantity: true } as const satisfies Prisma.SalesOrderLineSelect
type LineRow = Prisma.SalesOrderLineGetPayload<{ select: typeof LINE_COLUMNS }>

type Plan = 'STANDARD' | 'ESTIMATE' | 'QUOTED' | 'ACTUAL'

/** A work order's figures, whole (its share per order line is taken by garments). */
interface WorkOrderFigures {
  readonly workOrder: CostedWorkOrder
  readonly done: boolean
  readonly plan: Plan
  /** Its plan, whole (null: QUOTED, taken per line from the line's quoted cost). */
  readonly planParts: Parts | null
  readonly actualParts: Parts
  readonly leather: number
  readonly entries: number
  /** Garments per sales order line (of every order), the keys sorted. */
  readonly weights: ReadonlyMap<string, number>
  readonly method: CostingMethod
}

interface LineShare {
  readonly figures: WorkOrderFigures
  readonly pieces: number
  readonly estimate: Parts | null
  readonly actual: Parts
}

interface LineComputed {
  readonly line: LineRow
  readonly style: { id: string; code: string; name: string }
  readonly colourway: { id: string; code: string }
  readonly quotedValue: number
  readonly value: number
  readonly quotedParts: Parts | null
  readonly estimateParts: Parts | null
  readonly actualParts: Parts
  readonly quotedLeather: number | null
  readonly actualLeather: number
  readonly inWorkOrders: number
  readonly uncovered: number
  readonly shares: readonly LineShare[]
}

interface OrderComputed {
  readonly order: OrderRow
  readonly partyName: string
  readonly lines: readonly LineComputed[]
  readonly figures: readonly WorkOrderFigures[]
  readonly method: CostingMethod
  readonly methodLockedAt: Date | null
  /** The order's costs are in another currency than its value: no margin. */
  readonly currencyMismatch: string | null
  readonly quotedValue: number
  readonly value: number
  readonly quotedParts: Parts | null
  readonly estimateParts: Parts | null
  readonly actualParts: Parts
  readonly started: boolean
  readonly final: boolean
  /** B-OM-007: the freight counted (in the order's currency) and what is left out. */
  readonly freight: OrderFreight
  /** B-OM-021: the hand cost lines still counted (in the order's currency: the DB guard). */
  readonly hand: OrderHand
}

// ── B-OM-021 (order money tab; lead L2; 13-backend §5) ──────────────────────────────────────────────────────────────────────
const HAND_LINE_COLUMNS = { id: true, salesOrderId: true, kind: true, amount: true, currency: true, reason: true, createdById: true, createdAt: true } as const satisfies Prisma.OrderCostLineSelect
type HandLineRow = Prisma.OrderCostLineGetPayload<{ select: typeof HAND_LINE_COLUMNS }>
/** An order's hand cost lines still counted (added only; a removed one stays in the history) and their sum. */
interface OrderHand {
  readonly cost: number
  readonly lines: readonly HandLineRow[]
}
const NO_HAND: OrderHand = Object.freeze({ cost: 0, lines: Object.freeze([]) as readonly HandLineRow[] })

/** The hand cost lines of some orders not removed, oldest first, in each order's currency. */
async function handOf(db: Reader, orders: readonly OrderRow[]): Promise<Map<string, OrderHand>> {
  const out = new Map<string, OrderHand>()
  if (orders.length === 0) return out
  const currencyOf = new Map(orders.map((row) => [row.id, row.currency]))
  const rows = await db.orderCostLine.findMany({ where: { salesOrderId: { in: orders.map((row) => row.id) }, removedAt: null }, select: HAND_LINE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  for (const row of rows) {
    if (row.currency !== currencyOf.get(row.salesOrderId)) continue // never converted (the guard keeps a line in its order's currency)
    const hand = out.get(row.salesOrderId) ?? { cost: 0, lines: [] }
    out.set(row.salesOrderId, { cost: hand.cost + row.amount, lines: [...hand.lines, row] })
  }
  return out
}
// ── end B-OM-021 ──

// ── B-OM-007 (order money tab M6-B3, B4, B8; 13-backend §1) ──────────────────────────────────────────────────────────────────
/** An order's freight: what the carriers charged us for its shipments, in its currency; `leftOut` the other currencies. */
interface OrderFreight {
  readonly cost: number
  /** The shipments counted (a cost recorded in the order's currency). */
  readonly counted: number
  readonly leftOut: readonly string[]
}
const NO_FREIGHT: OrderFreight = Object.freeze({ cost: 0, counted: 0, leftOut: Object.freeze([]) as readonly string[] })

/**
 * The freight of some orders, one query per kind: each shipment of theirs that is not cancelled and has the carrier's cost
 * (Shipment.freightCost, office only), shared by the pieces each order carries on it (a shipment of several orders of the same
 * customer; none yet: its first order's), counted in the order's currency; one in another currency is left out, never converted.
 */
async function freightOf(db: Reader, orders: readonly OrderRow[]): Promise<Map<string, OrderFreight>> {
  const out = new Map<string, OrderFreight>()
  if (orders.length === 0) return out
  const shipments = await db.shipment.findMany({ where: { AND: [shipmentsOfOrdersWhere(orders.map((row) => row.id)), { status: { not: 'CANCELLED' } }, { freightCost: { not: null } }] }, select: { id: true, salesOrderId: true, freightCost: true, freightCostCurrency: true }, orderBy: { id: 'asc' } })
  if (shipments.length === 0) return out
  const carried = await db.shipmentLine.findMany({ where: { shipmentId: { in: shipments.map((row) => row.id) } }, select: { shipmentId: true, quantity: true, salesOrderLine: { select: { orderId: true } } } })
  const currencyOf = new Map(orders.map((row) => [row.id, row.currency]))
  const sums = new Map<string, { cost: number; counted: number; leftOut: Set<string> }>()
  for (const shipment of shipments) {
    const pieces = new Map<string, number>()
    for (const line of carried) if (line.shipmentId === shipment.id) pieces.set(line.salesOrderLine.orderId, (pieces.get(line.salesOrderLine.orderId) ?? 0) + line.quantity)
    if (pieces.size === 0) pieces.set(shipment.salesOrderId, 1)
    const keys = [...pieces.keys()].sort()
    const shares = shareOf(shipment.freightCost!, keys.map((key) => pieces.get(key)!))
    keys.forEach((orderId, index) => {
      const currency = currencyOf.get(orderId)
      if (currency === undefined) return // another order of the customer, not asked here
      const sum = sums.get(orderId) ?? { cost: 0, counted: 0, leftOut: new Set<string>() }
      if (shipment.freightCostCurrency === currency) {
        sum.cost += shares[index]!
        sum.counted += 1
      } else sum.leftOut.add(shipment.freightCostCurrency ?? '—')
      sums.set(orderId, sum)
    })
  }
  for (const [orderId, sum] of sums) out.set(orderId, { cost: sum.cost, counted: sum.counted, leftOut: [...sum.leftOut].sort() })
  return out
}

/** The freight's words on the order's profitability. */
function freightWords(freight: OrderFreight, currency: string): string {
  const counted =
    freight.counted > 0
      ? `Freight counted now and so far: what the carriers charged us for ${freight.counted} shipment(s) of the order (a shipment of several orders shared by the pieces each carries).`
      : "No freight cost is recorded on the order's shipments yet: it is counted once the carrier's charge is on a shipment."
  const leftOut = freight.leftOut.length > 0 ? ` Freight in ${freight.leftOut.join(', ')} is left out: the order is in ${currency} and costs are not converted.` : ''
  return `${counted}${leftOut}`
}

/** B-OM-007 (M6-B8): what the quoted cost was based on: the cost sheet revision and the day of the first costed line's snapshot. */
function basedOnOf(lines: readonly LineComputed[], snapshots: ReadonlyMap<string, unknown>) {
  for (const line of lines) {
    const snapshot = line.line.quoteLineId ? snapshots.get(line.line.quoteLineId) : null
    if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object' || Array.isArray(snapshot)) continue
    const fields = snapshot as { readonly revision?: unknown; readonly computedAt?: unknown }
    const at = typeof fields.computedAt === 'string' ? new Date(fields.computedAt) : null
    return { pricedOn: at && !Number.isNaN(at.getTime()) ? businessDate(at) : null, revision: typeof fields.revision === 'number' ? fields.revision : null }
  }
  return null
}

/** The cost now (the estimate) and so far (the actual), freight counted. B-OM-021: and the hand cost lines. */
const estimateCostOf = (computed: OrderComputed): number | null => {
  const cost = costOf(computed.estimateParts)
  return cost === null ? null : cost + computed.freight.cost + computed.hand.cost
}
const actualCostOf = (computed: OrderComputed): number => totalOf(computed.actualParts) + computed.freight.cost + computed.hand.cost
// ── end B-OM-007 ──

const partsOfActual = (actual: ReturnType<typeof actualOf>): Parts => ({ material: actual.material, labour: actual.labour, subcontract: actual.subcontract, overhead: actual.overhead, adjustment: actual.adjustment })
const partsOfMinor = (minor: { material: number; labour: number; subcontract: number; overhead: number }): Parts => ({ material: minor.material, labour: minor.labour, subcontract: minor.subcontract, overhead: minor.overhead, adjustment: 0 })
const allKnown = <T>(list: readonly (T | null)[]): list is T[] => list.every((entry) => entry !== null)

/** The work orders (not drafts) that make these lines, with their figures. */
async function workOrderFigures(db: Reader, lineIds: readonly string[], now: Date): Promise<WorkOrderFigures[]> {
  if (lineIds.length === 0) return []
  const mine = await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: [...lineIds] } }, select: { workOrderId: true } })
  const workOrders = await readWorkOrders(db, { id: { in: unique(mine.map((row) => row.workOrderId)) }, status: { not: 'DRAFT' } })
  if (workOrders.length === 0) return []
  const cells = await db.workOrderSize.findMany({ where: { workOrderId: { in: workOrders.map((row) => row.id) } }, select: { workOrderId: true, salesOrderLineId: true, quantity: true } })
  const facts = await costFactsOf(db, workOrders, now)
  const leathers = new Set((await db.item.findMany({ where: { id: { in: unique(facts.flatMap((row) => row.entries.map((entry) => entry.itemId))) }, kind: 'LEATHER' }, select: { id: true } })).map((row) => row.id))
  const methods = new Map<string, CostingMethod>()
  for (const companyId of unique(workOrders.map((row) => row.companyId))) methods.set(companyId, (await methodInForce(db, companyId)).method)
  return facts.map((fact) => {
    const workOrder = fact.workOrder
    const currency = workOrder.currency
    const standard = standardOfCells(fact.cells.map((cell) => ({ cellId: cell.id, quantity: cell.quantity, standard: cell.standard })))
    const actualParts = partsOfActual(actualOf(fact.variance, currency))
    const done = DONE.has(workOrder.status)
    const byActual = workOrder.kind === 'REPAIR' || workOrder.status === 'CANCELLED'
    const plan: Plan = byActual ? 'ACTUAL' : standard ? 'STANDARD' : fact.estimate.complete ? 'ESTIMATE' : 'QUOTED'
    const planParts = plan === 'ACTUAL' ? actualParts : plan === 'STANDARD' ? partsOfMinor(minorParts(standard!, currency)) : plan === 'ESTIMATE' ? partsOfMinor(minorParts(fact.estimate.parts, currency)) : null
    const weights = new Map<string, number>()
    // B-W2b-275: a SAMPLE cell may name no order line; it weighs on none.
    for (const cell of cells.filter((row) => row.workOrderId === workOrder.id)) if (cell.salesOrderLineId !== null) weights.set(cell.salesOrderLineId, (weights.get(cell.salesOrderLineId) ?? 0) + cell.quantity)
    const sorted = new Map([...weights.entries()].sort(([a], [b]) => a.localeCompare(b)))
    const leather = fact.entries.filter((entry) => (entry.kind === 'MATERIAL' || entry.kind === 'SCRAP') && entry.itemId !== null && leathers.has(entry.itemId)).reduce((sum, entry) => sum + entry.amount, 0)
    return { workOrder, done, plan, planParts, actualParts, leather, entries: fact.entries.length, weights: sorted, method: methods.get(workOrder.companyId) ?? 'UNDECIDED' }
  })
}

/** The share of a work order's figures for one order line (by garments). */
function shareFor(figures: WorkOrderFigures, line: LineRow, mix: ReturnType<typeof mixOfSnapshot>): LineShare | null {
  const pieces = figures.weights.get(line.id)
  if (pieces === undefined) return null
  const keys = [...figures.weights.keys()]
  const index = keys.indexOf(line.id)
  const weights = keys.map((key) => figures.weights.get(key)!)
  const actual = shareParts(figures.actualParts, weights)[index]!
  const plan = figures.planParts
    ? shareParts(figures.planParts, weights)[index]!
    : line.costAmount === null
      ? null
      : partsInMix(shareOf(line.costAmount, [pieces, Math.max(0, line.quantity - pieces)])[0]!, mix)
  const estimate = figures.done ? actual : plan === null ? null : estimateNowOf(plan, actual, false)
  return { figures, pieces, estimate, actual }
}

/** The margins of some orders, computed. */
async function computeOrders(db: Reader, orders: readonly OrderRow[], now: Date): Promise<OrderComputed[]> {
  return (await computeOrdersWithSnapshots(db, orders, now)).computed
}

/** computeOrders, and the quote lines' cost snapshots it read (B-OM-007: the profitability's `basedOn`). */
async function computeOrdersWithSnapshots(db: Reader, orders: readonly OrderRow[], now: Date): Promise<{ computed: OrderComputed[]; snapshots: ReadonlyMap<string, unknown> }> {
  if (orders.length === 0) return { computed: [], snapshots: new Map() }
  const lines = await db.salesOrderLine.findMany({ where: { orderId: { in: orders.map((row) => row.id) } }, select: LINE_COLUMNS, orderBy: [{ orderId: 'asc' }, { seq: 'asc' }] })
  const snapshots = new Map((await db.quoteLine.findMany({ where: { id: { in: unique(lines.map((line) => line.quoteLineId)) } }, select: { id: true, costSnapshot: true } })).map((row) => [row.id, row.costSnapshot]))
  const styles = new Map((await db.style.findMany({ where: { id: { in: unique(lines.map((line) => line.styleId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: unique(lines.map((line) => line.colourwayId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
  const parties = new Map((await db.party.findMany({ where: { id: { in: unique(orders.map((row) => row.partyId)) } }, select: { id: true, legalName: true } })).map((row) => [row.id, row.legalName]))
  const companies = new Map((await db.company.findMany({ where: { id: { in: unique(orders.map((row) => row.companyId)) } }, select: { id: true, currency: true } })).map((row) => [row.id, costingCurrency(row.currency)]))
  const methods = new Map<string, Awaited<ReturnType<typeof methodInForce>>>()
  for (const companyId of unique(orders.map((row) => row.companyId))) methods.set(companyId, await methodInForce(db, companyId))
  const figures = await workOrderFigures(db, lines.map((line) => line.id), now)
  const freights = await freightOf(db, orders) // B-OM-007
  const hands = await handOf(db, orders) // B-OM-021

  const computed = orders.map((order): OrderComputed => {
    const mineLines = lines.filter((line) => line.orderId === order.id)
    const mineFigures = figures.filter((row) => mineLines.some((line) => row.weights.has(line.id)))
    const costCurrency = companies.get(order.companyId) ?? costingCurrency(null)
    const otherCurrency = [costCurrency, ...mineFigures.map((row) => row.workOrder.currency)].find((currency) => currency !== order.currency) ?? null
    const computedLines: LineComputed[] = mineLines.map((line) => {
      const mix = mixOfSnapshot(line.quoteLineId ? snapshots.get(line.quoteLineId) : null)
      const closedShort = line.closedShortQuantity ?? 0
      const quotedParts = otherCurrency || line.costAmount === null ? null : partsInMix(line.costAmount, mix)
      const shares = mineFigures.map((row) => shareFor(row, line, mix)).filter((share): share is LineShare => share !== null)
      const inWorkOrders = shares.filter((share) => share.figures.plan !== 'ACTUAL').reduce((sum, share) => sum + share.pieces, 0)
      const uncovered = Math.max(0, line.quantity - closedShort - inWorkOrders)
      const uncoveredCost = uncovered === 0 ? 0 : line.costAmount === null ? null : shareOf(line.costAmount, [uncovered, line.quantity - uncovered])[0]!
      const uncoveredParts = uncoveredCost === null ? null : partsInMix(uncoveredCost, mix)
      const estimates = [...shares.map((share) => share.estimate), uncoveredParts]
      return {
        line,
        style: styles.get(line.styleId) ?? { id: line.styleId, code: '', name: '' },
        colourway: colourways.get(line.colourwayId) ?? { id: line.colourwayId, code: '' },
        quotedValue: line.netAmount,
        value: valueNowOf(line.netAmount, line.quantity, closedShort),
        quotedParts,
        estimateParts: otherCurrency || !allKnown(estimates) ? null : sumParts(estimates),
        actualParts: sumParts(shares.map((share) => share.actual)),
        quotedLeather: otherCurrency || line.costAmount === null ? null : leatherInMix(line.costAmount, mix),
        actualLeather: shares.reduce((sum, share) => sum + shareOf(share.figures.leather, [...share.figures.weights.values()])[[...share.figures.weights.keys()].indexOf(line.id)]!, 0),
        inWorkOrders,
        uncovered,
        shares,
      }
    })
    const method = methods.get(order.companyId)
    const quotedParts = computedLines.map((line) => line.quotedParts)
    const estimateParts = computedLines.map((line) => line.estimateParts)
    const started = mineFigures.some((row) => row.entries > 0)
    return {
      order,
      partyName: parties.get(order.partyId) ?? '',
      lines: computedLines,
      figures: mineFigures,
      method: method?.method ?? 'UNDECIDED',
      methodLockedAt: method?.row?.methodLockedAt ?? null,
      currencyMismatch: otherCurrency,
      quotedValue: computedLines.reduce((sum, line) => sum + line.quotedValue, 0),
      value: computedLines.reduce((sum, line) => sum + line.value, 0),
      quotedParts: computedLines.length > 0 && allKnown(quotedParts) ? sumParts(quotedParts) : null,
      estimateParts: computedLines.length > 0 && allKnown(estimateParts) ? sumParts(estimateParts) : null,
      actualParts: sumParts(computedLines.map((line) => line.actualParts)),
      started,
      final: mineFigures.length > 0 && mineFigures.every((row) => row.done) && computedLines.every((line) => line.uncovered === 0),
      freight: freights.get(order.id) ?? NO_FREIGHT, // B-OM-007
      hand: hands.get(order.id) ?? NO_HAND, // B-OM-021
    }
  })
  return { computed, snapshots }
}

const costOf = (parts: Parts | null): number | null => (parts === null ? null : totalOf(parts))
const marginOf = (value: number, cost: number | null): number | null => (cost === null ? null : value - cost)

/** B-W2b-416: what the floor flag reads of an order (the final margin once final, else the estimate now). */
const floorFiguresOfComputed = (computed: OrderComputed): FloorFigures => ({
  final: computed.final,
  value: computed.value,
  // B-OM-007: freight counted (one rule for the tab, the list column, Finance › Margins and the low-margin alert).
  estimateMargin: marginOf(computed.value, estimateCostOf(computed)),
  actualMargin: computed.started && !computed.currencyMismatch ? computed.value - actualCostOf(computed) : null,
})

/** B-W2b-416: the floor flag's figures of some orders, computed as this read does (the low-margin alert's finder reads them). */
export async function floorFiguresOf(db: Reader, orderIds: readonly string[], now: Date) {
  const orders = orderIds.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: [...orderIds] } }, select: ORDER_COLUMNS, orderBy: { id: 'asc' } })
  const out = new Map<string, FloorFigures & { readonly number: string; readonly companyId: string; readonly partyId: string; readonly status: string }>()
  for (let index = 0; index < orders.length; index += CHUNK) {
    for (const computed of await computeOrders(db, orders.slice(index, index + CHUNK), now)) out.set(computed.order.id, { ...floorFiguresOfComputed(computed), number: computed.order.number, companyId: computed.order.companyId, partyId: computed.order.partyId, status: computed.order.status })
  }
  return out
}

function rowOf(computed: OrderComputed, floor?: OrderFloor): OrderMarginRowView {
  const { order } = computed
  const quotedCost = costOf(computed.quotedParts)
  const estimateCost = estimateCostOf(computed) // B-OM-007: freight counted
  const actualCost = actualCostOf(computed) // B-OM-007
  const actualKnown = computed.started && !computed.currencyMismatch
  const quotedMargin = marginOf(computed.quotedValue, quotedCost)
  const estimateMargin = marginOf(computed.value, estimateCost)
  return {
    order: { id: order.id, number: order.number, status: order.status as SalesOrderStatus, orderDate: order.orderDate.toISOString().slice(0, 10), companyId: order.companyId, party: { id: order.partyId, name: computed.partyName }, customerRef: order.customerRef },
    currency: order.currency,
    quotedValue: asMoney('price', computed.quotedValue),
    value: asMoney('price', computed.value),
    quotedCost: asMoney('cost', quotedCost),
    quotedMargin: asMoney('margin', quotedMargin),
    quotedMarginPct: asMoney('margin', marginPctOf(computed.quotedValue, quotedCost)),
    estimateCost: asMoney('cost', estimateCost),
    estimateMargin: asMoney('margin', estimateMargin),
    estimateMarginPct: asMoney('margin', marginPctOf(computed.value, estimateCost)),
    actualCost: asMoney('cost', actualCost),
    actualMargin: asMoney('margin', actualKnown ? computed.value - actualCost : null),
    actualMarginPct: asMoney('margin', actualKnown ? marginPctOf(computed.value, actualCost) : null),
    marginChange: asMoney('margin', quotedMargin === null || estimateMargin === null ? null : estimateMargin - quotedMargin),
    final: computed.final,
    started: computed.started,
    workOrders: computed.figures.length,
    // B-W2b-416: the floor of the Sales settings and the flag (was null in W2a).
    ...floorFields(flagOf(floorFiguresOfComputed(computed), floor), floor),
    method: computed.method,
    provisional: isProvisional(computed.method),
  }
}

/** Sales see margin %, never a margin amount (with the price it would give the cost away): drop them without the cost grain. */
function forCaller<Answer extends Record<string, unknown>>(answer: Answer, grains: ReadonlySet<Grain>): Answer {
  if (grains.has('cost')) return answer
  const AMOUNTS = new Set(['quotedMargin', 'estimateMargin', 'actualMargin', 'marginChange', 'margin', 'marginLostSinceQuote'])
  const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !AMOUNTS.has(key))
        .map(([key, item]) => [key, key === 'waterfall' ? null : strip(item)]),
    )
  }
  return strip(answer) as Answer
}

const grainsOf = (caller: CommandCaller): ReadonlySet<Grain> => heldGrains(actorOf(contextOf(caller)))

function whereOf(caller: CommandCaller, query: MarginsQuery): Prisma.SalesOrderWhereInput {
  const actor = actorOf(contextOf(caller))
  return {
    AND: [
      scopeWhere(actor, COSTING_VIEW, SCOPE) as Prisma.SalesOrderWhereInput,
      // B-W2b-22 (Z9:05): only the orders asked for (the orders list's Margin % column: the rows on screen).
      query.ids ? { id: { in: [...query.ids] } } : {},
      query.companyId ? { companyId: query.companyId } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.styleId ? { lines: { some: { styleId: query.styleId } } } : {},
      query.status && query.status.length > 0 ? { status: { in: [...query.status] } } : { status: { not: 'CANCELLED' } },
      query.from ? { orderDate: { gte: new Date(`${query.from}T00:00:00.000Z`) } } : {},
      query.to ? { orderDate: { lte: new Date(`${query.to}T00:00:00.000Z`) } } : {},
      query.q ? { OR: [{ number: { contains: query.q, mode: 'insensitive' } }, { customerRef: { contains: query.q, mode: 'insensitive' } }] } : {},
    ],
  }
}

interface Group {
  readonly orders: number
  readonly value: number
  readonly cost: number | null
  readonly rows: { value: number; cost: number | null }[]
}

function groupView(group: Group, oneCurrency: boolean) {
  return {
    orders: group.orders,
    value: asMoney('price', group.value),
    estimateCost: asMoney('cost', oneCurrency ? group.cost : null),
    marginPct: asMoney('margin', oneCurrency ? averageMarginPct(group.rows) : null),
  }
}

/** GET /costing/margins: a page of orders with their margin quoted, now and so far, and the tiles and groups over every order in scope. */
export async function orderMargins(caller: CommandCaller, query: MarginsQuery) {
  const now = serverClock.now()
  const where = whereOf(caller, query)
  const answer = await caller.withClient(async (db) => {
    const all = await db.salesOrder.findMany({ where, select: ORDER_COLUMNS, orderBy: { id: 'desc' } })
    const computed: OrderComputed[] = []
    for (let index = 0; index < all.length; index += CHUNK) computed.push(...(await computeOrders(db, all.slice(index, index + CHUNK), now)))
    // B-W2b-416: each order's floor and flag; the tile counts them over every order in scope, `floor=below` keeps those below.
    const floors = await orderFloors(db, all.map((row) => row.id), now)
    const flags = new Map(computed.map((row) => [row.order.id, flagOf(floorFiguresOfComputed(row), floors.get(row.order.id))]))
    const listed = query.floor === 'below' ? computed.filter((row) => flags.get(row.order.id)?.below === true) : computed
    const after = query.cursor ? listed.filter((row) => row.order.id < query.cursor!) : listed
    const page = after.slice(0, query.limit)

    const currencies = unique(computed.map((row) => row.order.currency))
    const oneCurrency = currencies.length <= 1
    // B-OM-007: the estimate now counts the order's freight.
    const estimates = computed.map((row) => ({ value: row.value, cost: row.currencyMismatch ? null : estimateCostOf(row) }))
    const both = computed.filter((row) => row.quotedParts !== null && row.estimateParts !== null && !row.currencyMismatch)
    const lost = both.reduce((sum, row) => sum + (row.quotedValue - totalOf(row.quotedParts!)) - (row.value - estimateCostOf(row)!), 0)

    const byParty = new Map<string, Group & { name: string }>()
    const byStyle = new Map<string, Group & { style: { id: string; code: string; name: string } }>()
    const add = <G extends Group>(map: Map<string, G>, key: string, seed: () => G, value: number, cost: number | null, order: boolean): void => {
      const group = map.get(key) ?? seed()
      map.set(key, { ...group, orders: group.orders + (order ? 1 : 0), value: group.value + value, cost: group.cost === null || cost === null ? null : group.cost + cost, rows: [...group.rows, { value, cost }] })
    }
    for (const row of computed) {
      const cost = row.currencyMismatch ? null : estimateCostOf(row) // B-OM-007 (by customer; by style stays per line, no freight)
      add(byParty, row.order.partyId, () => ({ name: row.partyName, orders: 0, value: 0, cost: 0, rows: [] }), row.value, cost, true)
      const counted = new Set<string>()
      for (const line of row.lines) {
        add(byStyle, line.style.id, () => ({ style: line.style, orders: 0, value: 0, cost: 0, rows: [] }), line.value, row.currencyMismatch ? null : costOf(line.estimateParts), !counted.has(line.style.id))
        counted.add(line.style.id)
      }
    }
    return {
      rows: page.map((row) => rowOf(row, floors.get(row.order.id))),
      nextCursor: after.length > query.limit ? page.at(-1)!.order.id : null,
      tiles: {
        averageMarginPct: asMoney('margin', oneCurrency ? averageMarginPct(estimates) : null),
        belowFloor: asMoney('margin', belowCount([...flags.values()])),
        marginLostSinceQuote: asMoney('margin', oneCurrency && both.length > 0 ? lost : null),
        orders: computed.length,
        unknown: estimates.filter((row) => row.cost === null).length,
        currency: oneCurrency ? (currencies[0] ?? null) : null,
        words: oneCurrency ? null : 'The orders in view are in more than one currency: choose one company to see the totals.',
      },
      byCustomer: [...byParty.entries()].map(([id, group]) => ({ party: { id, name: group.name }, ...groupView(group, oneCurrency) })).sort((a, b) => (b.value as number) - (a.value as number)),
      byStyle: [...byStyle.values()].map((group) => ({ style: group.style, ...groupView(group, oneCurrency) })).sort((a, b) => (b.value as number) - (a.value as number)),
    }
  })
  return forCaller(answer, grainsOf(caller))
}

const stageOf = (value: number, parts: Parts | null, known = true) => {
  const cost = costOf(parts)
  return {
    value: asMoney('price', value),
    cost: asMoney('cost', known ? cost : null),
    parts: parts === null || !known ? null : { material: asMoney('cost', parts.material), labour: asMoney('cost', parts.labour), subcontract: asMoney('cost', parts.subcontract), overhead: asMoney('cost', parts.overhead), adjustment: asMoney('cost', parts.adjustment) },
    margin: asMoney('margin', known ? marginOf(value, cost) : null),
    marginPct: asMoney('margin', known ? marginPctOf(value, cost) : null),
  }
}

/**
 * B-OM-007: a stage now or so far with the order's freight in its cost (the parts stay the work's; `freight` says the rest).
 * B-OM-021: and the hand cost lines (`handCost`; the computed cost is cost − handCost).
 */
const stageWithFreight = (value: number, parts: Parts | null, freight: number, known = true, hand = 0) => {
  const cost = known && parts !== null ? totalOf(parts) + freight + hand : null
  return {
    ...stageOf(value, parts, known),
    cost: asMoney('cost', cost),
    margin: asMoney('margin', marginOf(value, cost)),
    marginPct: asMoney('margin', cost === null ? null : marginPctOf(value, cost)),
    freight: asMoney('cost', known && parts !== null ? freight : null),
    handCost: asMoney('cost', known && parts !== null ? hand : null), // B-OM-021
  }
}

/** B-OM-021: the hand lines and the target as the profitability shows them (the office people named, never a floor worker). */
async function handViewsOf(db: Reader, orderId: string, hand: OrderHand, floor: OrderFloor | undefined) {
  const set = floor?.targetPct ? await db.auditLog.findFirst({ where: { recordType: 'SalesOrder', recordId: orderId, action: MARGIN_TARGET_ACTION }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: { at: true, audience: true, actorId: true, reason: true } }) : null
  const setBy = set && set.audience === 'office' ? set.actorId : null
  const peopleIds = [...new Set([...hand.lines.flatMap((line) => (line.createdById ? [line.createdById] : [])), ...(setBy ? [setBy] : [])])]
  const people = new Map(peopleIds.length === 0 ? [] : (await db.user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
  return {
    handLines: asMoney(
      'cost',
      hand.lines.map((line) => ({ id: line.id, kind: line.kind, amount: asMoney('cost', line.amount), currency: line.currency, reason: asMoney('cost', line.reason), by: line.createdById ? (people.get(line.createdById) ?? null) : null, at: toUtcIso(line.createdAt) })),
    ),
    target: asMoney('margin', floor?.targetPct ? { pct: asMoney('margin', floor.targetPct), by: setBy ? (people.get(setBy) ?? null) : null, at: set ? toUtcIso(set.at) : null, reason: asMoney('margin', set?.reason ?? null) } : null),
  }
}

// ── B-SA-043 ──
/** The order's extra pieces and their share of the actual cost (by garments, as a shared work order's cost is shared). */
function extraPiecesOf(lines: readonly LineComputed[], extra: readonly MadeExtra[]) {
  let cost = 0
  const rows: { lineId: string; seq: number; size: string; count: number }[] = []
  for (const line of lines) {
    const mine = extra.filter((entry) => entry.lineId === line.line.id)
    const count = mine.reduce((sum, entry) => sum + entry.count, 0)
    if (count === 0) continue
    for (const entry of mine) rows.push({ lineId: line.line.id, seq: line.line.seq, size: entry.size, count: entry.count })
    const pieces = line.shares.reduce((sum, share) => sum + share.pieces, 0)
    if (pieces > 0) cost += shareOf(totalOf(line.actualParts), [Math.min(count, pieces), Math.max(0, pieces - count)])[0]!
  }
  const count = rows.reduce((sum, row) => sum + row.count, 0)
  return {
    count,
    cost: asMoney('cost', count > 0 ? cost : null),
    lines: rows,
    words: count > 0 ? `${count} piece(s) were cut beyond what the order now wants: their share of the actual cost is named here, and it stays in the order's cost.` : null,
  }
}
// ── end B-SA-043 ──

/** GET /costing/margins/orders/:orderId: one order's profitability (the DetailModal and the order's Margin tab). */
export async function orderMargin(caller: CommandCaller, orderId: string): Promise<OrderMarginView> {
  const actor = actorOf(contextOf(caller))
  const now = serverClock.now()
  const view = await caller.withClient(async (db) => {
    const order = isUuid(orderId) ? await db.salesOrder.findUnique({ where: { id: orderId }, select: ORDER_COLUMNS }) : null
    if (!order || !can(actor, COSTING_VIEW, { companyId: order.companyId, partyId: order.partyId })) throw new NotFoundError('Sales order not found.')
    const { computed: [computed], snapshots } = await computeOrdersWithSnapshots(db, [order], now) // B-OM-007: + the snapshots (basedOn)
    const extra = await madeExtraOf(db, (contextOf(caller) as { readonly tenantId: string }).tenantId, order) // B-SA-043: office only (costing.view)
    const floor = (await orderFloors(db, [order.id], now)).get(order.id) // B-OM-021: + its target (handViewsOf)
    const row = rowOf(computed!, floor)
    const { lines, figures } = computed!
    const actualKnown = computed!.started && !computed!.currencyMismatch
    const shared = figures.some((entry) => entry.weights.size > 1)
    const uncovered = lines.reduce((sum, line) => sum + line.uncovered, 0)
    const closedShort = lines.reduce((sum, line) => sum + (line.line.closedShortQuantity ?? 0), 0)
    const quotedLeathers = lines.map((line) => line.quotedLeather)
    const words = [
      methodWords(computed!.method, computed!.methodLockedAt ? businessDate(computed!.methodLockedAt) : null),
      // B-OM-007 (M6-B4): the honest words (exchange rates exist; the margin does not convert the costs).
      computed!.currencyMismatch ? `The order is in ${order.currency} and its costs in ${computed!.currencyMismatch}: no margin is worked out, as the costs are not converted into the order's currency.` : null,
      computed!.final
        ? 'Every work order of the order is done: the actual is its final cost.'
        : figures.length === 0
          ? 'No work order makes the order yet: the estimate is the quoted cost.'
          : 'The order is open: the estimate counts each open work order at the larger of its plan and what it already cost, part by part; the actual grows as work is reported, so the actual margin reads high until every work order is done.',
      shared ? 'A work order that makes several order lines shares its cost by garments.' : null,
      uncovered > 0 ? `${uncovered} piece(s) have no work order yet: counted at the quoted cost per piece.` : null,
      closedShort > 0 ? `${closedShort} piece(s) were closed short: they are taken off the value pro rata and are not costed.` : null,
    ]
      .filter((text): text is string => text !== null)
      .join(' ')
    return {
      ...row,
      quoted: stageOf(computed!.quotedValue, computed!.quotedParts),
      // B-OM-007: now and so far count the order's freight.
      // B-OM-021: and the hand cost lines.
      estimate: stageWithFreight(computed!.value, computed!.estimateParts, computed!.freight.cost, true, computed!.hand.cost),
      actual: stageWithFreight(computed!.value, computed!.actualParts, computed!.freight.cost, actualKnown, computed!.hand.cost),
      waterfall:
        computed!.quotedParts && computed!.estimateParts
          ? waterfallOf({ value: computed!.quotedValue, parts: computed!.quotedParts }, { value: computed!.value, parts: computed!.estimateParts, freight: computed!.freight.cost /* B-OM-007 */, byHand: computed!.hand.cost /* B-OM-021 */ }).map((step) => ({ reason: step.reason, amount: asMoney('margin', step.amount) }))
          : null,
      leather: { quoted: asMoney('cost', allKnown(quotedLeathers) && !computed!.currencyMismatch ? quotedLeathers.reduce((sum, value) => sum + value, 0) : null), actual: asMoney('cost', lines.reduce((sum, line) => sum + line.actualLeather, 0)) },
      // B-OM-007 (M6-B3): the freight counted, in words; and what the quoted cost was based on (M6-B8).
      freight: { cost: asMoney('cost', computed!.freight.counted > 0 ? computed!.freight.cost : null), words: freightWords(computed!.freight, order.currency) },
      basedOn: basedOnOf(lines, snapshots),
      // B-OM-021 (L2, L4): the hand cost lines still counted and the order's target, with who set them.
      ...(await handViewsOf(db, order.id, computed!.hand, floor)),
      // B-SA-043 (R1, review P6-4): the extra pieces' cost line — their share by garments of each line's actual cost.
      extraPieces: extraPiecesOf(lines, extra),
      lines: lines.map((line) => {
        const quotedCost = costOf(line.quotedParts)
        const estimateCost = costOf(line.estimateParts)
        const actualCost = totalOf(line.actualParts)
        return {
          id: line.line.id,
          seq: line.line.seq,
          style: line.style,
          colourway: line.colourway,
          quantity: line.line.quantity,
          closedShort: line.line.closedShortQuantity ?? 0,
          inWorkOrders: line.inWorkOrders,
          quotedValue: asMoney('price', line.quotedValue),
          value: asMoney('price', line.value),
          quotedCost: asMoney('cost', quotedCost),
          estimateCost: asMoney('cost', estimateCost),
          actualCost: asMoney('cost', actualCost),
          quotedMarginPct: asMoney('margin', marginPctOf(line.quotedValue, quotedCost)),
          estimateMarginPct: asMoney('margin', marginPctOf(line.value, estimateCost)),
          actualMarginPct: asMoney('margin', actualKnown && line.shares.length > 0 ? marginPctOf(line.value, actualCost) : null),
        }
      }),
      workOrderShares: figures.map((entry) => {
        const shares = lines.flatMap((line) => line.shares.filter((share) => share.figures === entry))
        const estimates = shares.map((share) => share.estimate)
        return {
          workOrder: { id: entry.workOrder.id, number: entry.workOrder.number, kind: entry.workOrder.kind, status: entry.workOrder.status },
          pieces: shares.reduce((sum, share) => sum + share.pieces, 0),
          ofPieces: [...entry.weights.values()].reduce((sum, pieces) => sum + pieces, 0),
          done: entry.done,
          plan: entry.plan,
          estimateCost: asMoney('cost', allKnown(estimates) ? totalOf(sumParts(estimates)) : null),
          actualCost: asMoney('cost', totalOf(sumParts(shares.map((share) => share.actual)))),
          method: entry.method,
          provisional: isProvisional(entry.method),
        }
      }),
      words,
    }
  })
  return forCaller(view, grainsOf(caller)) as OrderMarginView
}


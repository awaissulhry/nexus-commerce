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
}

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
    for (const cell of cells.filter((row) => row.workOrderId === workOrder.id)) weights.set(cell.salesOrderLineId, (weights.get(cell.salesOrderLineId) ?? 0) + cell.quantity)
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
  if (orders.length === 0) return []
  const lines = await db.salesOrderLine.findMany({ where: { orderId: { in: orders.map((row) => row.id) } }, select: LINE_COLUMNS, orderBy: [{ orderId: 'asc' }, { seq: 'asc' }] })
  const snapshots = new Map((await db.quoteLine.findMany({ where: { id: { in: unique(lines.map((line) => line.quoteLineId)) } }, select: { id: true, costSnapshot: true } })).map((row) => [row.id, row.costSnapshot]))
  const styles = new Map((await db.style.findMany({ where: { id: { in: unique(lines.map((line) => line.styleId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: unique(lines.map((line) => line.colourwayId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row]))
  const parties = new Map((await db.party.findMany({ where: { id: { in: unique(orders.map((row) => row.partyId)) } }, select: { id: true, legalName: true } })).map((row) => [row.id, row.legalName]))
  const companies = new Map((await db.company.findMany({ where: { id: { in: unique(orders.map((row) => row.companyId)) } }, select: { id: true, currency: true } })).map((row) => [row.id, costingCurrency(row.currency)]))
  const methods = new Map<string, Awaited<ReturnType<typeof methodInForce>>>()
  for (const companyId of unique(orders.map((row) => row.companyId))) methods.set(companyId, await methodInForce(db, companyId))
  const figures = await workOrderFigures(db, lines.map((line) => line.id), now)

  return orders.map((order) => {
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
    }
  })
}

const costOf = (parts: Parts | null): number | null => (parts === null ? null : totalOf(parts))
const marginOf = (value: number, cost: number | null): number | null => (cost === null ? null : value - cost)

function rowOf(computed: OrderComputed): OrderMarginRowView {
  const { order } = computed
  const quotedCost = costOf(computed.quotedParts)
  const estimateCost = costOf(computed.estimateParts)
  const actualCost = totalOf(computed.actualParts)
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
    belowFloor: null,
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
    const after = query.cursor ? computed.filter((row) => row.order.id < query.cursor!) : computed
    const page = after.slice(0, query.limit)

    const currencies = unique(computed.map((row) => row.order.currency))
    const oneCurrency = currencies.length <= 1
    const estimates = computed.map((row) => ({ value: row.value, cost: row.currencyMismatch ? null : costOf(row.estimateParts) }))
    const both = computed.filter((row) => row.quotedParts !== null && row.estimateParts !== null && !row.currencyMismatch)
    const lost = both.reduce((sum, row) => sum + (row.quotedValue - totalOf(row.quotedParts!)) - (row.value - totalOf(row.estimateParts!)), 0)

    const byParty = new Map<string, Group & { name: string }>()
    const byStyle = new Map<string, Group & { style: { id: string; code: string; name: string } }>()
    const add = <G extends Group>(map: Map<string, G>, key: string, seed: () => G, value: number, cost: number | null, order: boolean): void => {
      const group = map.get(key) ?? seed()
      map.set(key, { ...group, orders: group.orders + (order ? 1 : 0), value: group.value + value, cost: group.cost === null || cost === null ? null : group.cost + cost, rows: [...group.rows, { value, cost }] })
    }
    for (const row of computed) {
      const cost = row.currencyMismatch ? null : costOf(row.estimateParts)
      add(byParty, row.order.partyId, () => ({ name: row.partyName, orders: 0, value: 0, cost: 0, rows: [] }), row.value, cost, true)
      const counted = new Set<string>()
      for (const line of row.lines) {
        add(byStyle, line.style.id, () => ({ style: line.style, orders: 0, value: 0, cost: 0, rows: [] }), line.value, row.currencyMismatch ? null : costOf(line.estimateParts), !counted.has(line.style.id))
        counted.add(line.style.id)
      }
    }
    return {
      rows: page.map(rowOf),
      nextCursor: after.length > query.limit ? page.at(-1)!.order.id : null,
      tiles: {
        averageMarginPct: asMoney('margin', oneCurrency ? averageMarginPct(estimates) : null),
        belowFloor: null,
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

/** GET /costing/margins/orders/:orderId: one order's profitability (the DetailModal and the order's Margin tab). */
export async function orderMargin(caller: CommandCaller, orderId: string): Promise<OrderMarginView> {
  const actor = actorOf(contextOf(caller))
  const now = serverClock.now()
  const view = await caller.withClient(async (db) => {
    const order = isUuid(orderId) ? await db.salesOrder.findUnique({ where: { id: orderId }, select: ORDER_COLUMNS }) : null
    if (!order || !can(actor, COSTING_VIEW, { companyId: order.companyId, partyId: order.partyId })) throw new NotFoundError('Sales order not found.')
    const [computed] = await computeOrders(db, [order], now)
    const row = rowOf(computed!)
    const { lines, figures } = computed!
    const actualKnown = computed!.started && !computed!.currencyMismatch
    const shared = figures.some((entry) => entry.weights.size > 1)
    const uncovered = lines.reduce((sum, line) => sum + line.uncovered, 0)
    const closedShort = lines.reduce((sum, line) => sum + (line.line.closedShortQuantity ?? 0), 0)
    const quotedLeathers = lines.map((line) => line.quotedLeather)
    const words = [
      methodWords(computed!.method, computed!.methodLockedAt ? businessDate(computed!.methodLockedAt) : null),
      computed!.currencyMismatch ? `The order is in ${order.currency} and its costs in ${computed!.currencyMismatch}: no margin until exchange rates come (W2b).` : null,
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
      estimate: stageOf(computed!.value, computed!.estimateParts),
      actual: stageOf(computed!.value, computed!.actualParts, actualKnown),
      waterfall:
        computed!.quotedParts && computed!.estimateParts
          ? waterfallOf({ value: computed!.quotedValue, parts: computed!.quotedParts }, { value: computed!.value, parts: computed!.estimateParts }).map((step) => ({ reason: step.reason, amount: asMoney('margin', step.amount) }))
          : null,
      leather: { quoted: asMoney('cost', allKnown(quotedLeathers) && !computed!.currencyMismatch ? quotedLeathers.reduce((sum, value) => sum + value, 0) : null), actual: asMoney('cost', lines.reduce((sum, line) => sum + line.actualLeather, 0)) },
      freight: { cost: asMoney('cost', null), words: "No freight cost is recorded on an order yet (the carrier's invoices come with supplier invoices): the margin leaves freight out." },
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


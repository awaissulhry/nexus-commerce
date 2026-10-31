import type { Prisma } from '@nexus/factory-db'
import { leadTimeWindow, orderByDate } from '@nexus/factory-domain/calendars/suppliers'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { stockValue } from '@nexus/factory-domain/inventory/ledger/valuation'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { addDays, hidesFor, type SupplyRules } from '@nexus/factory-domain/planning/buy'
import { itemPlanningFor } from '@nexus/factory-domain/planning/settings/items'
import { sourceFor, sourceRules, type SourceFacts } from '@nexus/factory-domain/purchasing/sources/sources'
import { readDecisionNote } from '@nexus/factory-domain/planning/decisions'
import type { PlanWarning, RequirementSource } from '@nexus/factory-domain/planning/explode'
import { whyLine } from '@nexus/factory-domain/planning/explain'
import { COST_SCALE, QUANTITY_SCALE, toBase, unitCostIn } from '@nexus/factory-domain/product/units/units'
import type { PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { supplierCalendarsFor, type LoadedSupplierCalendar } from '../../platform/calendars/service'
import { activeSourcesOf } from '../purchasing/supplier-items/store'
import type { LineView, RunView } from './contract'
import { ITEM_PLANNING_COLUMNS, type ItemPlanningRow } from './inputs'
import { dayOf, ITEM_COLUMNS, readSupplyRules, unitsOf, type ItemRow, type Reader } from './store'

/**
 * How runs and their lines are answered (A2 SCR-055): a run with its warnings and counts; a line with its snapshot
 * numbers, the suggestion in the purchase unit and in the base unit, about how many hides, the order-by day from the
 * supplier's terms as they are today, the netting as one line, the orders behind it, its decision, and, for a caller
 * with the cost grain only, the item's standard cost per suggested unit and the suggestion's expected value.
 *
 * B-W2a-22: a line's firm planned order (PLN-075: how much, by when, from whom, since when; carried from an earlier
 * plan or made firm on this one), and the order-by day as the buyer's queue counts it (B-W2a-10): the need (the firm
 * date when firm) less the site's safety lead days, less the lead time (the site's buy lead time, else the supplier's
 * approved source's, else the item's or supplier's terms), walked back around the supplier's closed days (B-W2a-08).
 */

export const RUN_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  trigger: true,
  status: true,
  orderLines: true,
  startedAt: true,
  finishedAt: true,
  error: true,
  note: true,
  warnings: true,
  createdById: true,
  version: true,
} as const satisfies Prisma.PlanningRunSelect
export type RunRow = Prisma.PlanningRunGetPayload<{ select: typeof RUN_COLUMNS }>

export const REQUIREMENT_COLUMNS = {
  id: true,
  runId: true,
  siteId: true,
  seq: true,
  version: true,
  action: true,
  itemId: true,
  itemColourId: true,
  uom: true,
  grossQuantity: true,
  usableStock: true,
  heldStock: true,
  onOrder: true,
  netQuantity: true,
  suggestedQuantity: true,
  suggestedUom: true,
  needDate: true,
  supplierId: true,
  sources: true,
  decision: true,
  decisionNote: true,
  purchaseOrderLineId: true,
  decidedAt: true,
  // B-W2a-22: the firm planned order.
  firmQuantity: true,
  firmBaseQuantity: true,
  firmDate: true,
  firmSupplierId: true,
  firmedAt: true,
  firmedById: true,
  // B-W2b-20: the earlier run's firm line this line carries (history; stays when the line is made planned again).
  firmCarriedFromId: true,
  createdAt: true,
} as const satisfies Prisma.MaterialRequirementSelect
export type RequirementRow = Prisma.MaterialRequirementGetPayload<{ select: typeof REQUIREMENT_COLUMNS }>

/** A stored quantity as answered: four decimals. */
export const quantityOf = (value: { toString(): string }): string => {
  const [whole, fraction = ''] = value.toString().split('.')
  return `${whole}.${(fraction + '0000').slice(0, 4)}`
}

/** The stored warnings, as typed (a row written before the column existed has none). */
export const warningsOf = (value: Prisma.JsonValue): PlanWarning[] => (Array.isArray(value) ? (value as unknown as PlanWarning[]) : [])

export function runViewOf(row: RunRow, counts: { readonly requirements: number; readonly short: number }): RunView {
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    trigger: row.trigger,
    status: row.status,
    orderLines: row.orderLines,
    startedAt: toUtcIso(row.startedAt),
    finishedAt: row.finishedAt ? toUtcIso(row.finishedAt) : null,
    error: row.error,
    note: row.note,
    warnings: warningsOf(row.warnings),
    createdById: row.createdById,
    requirements: counts.requirements,
    short: counts.short,
    version: row.version,
  }
}

/** Lines and short lines per run. */
export async function runCounts(db: Reader, runIds: readonly string[]): Promise<Map<string, { requirements: number; short: number }>> {
  const ids = [...new Set(runIds)]
  const counts = new Map(ids.map((id) => [id, { requirements: 0, short: 0 }]))
  if (ids.length === 0) return counts
  const all = await db.materialRequirement.groupBy({ by: ['runId'], where: { runId: { in: ids } }, _count: { _all: true } })
  const short = await db.materialRequirement.groupBy({ by: ['runId'], where: { runId: { in: ids }, netQuantity: { gt: 0 } }, _count: { _all: true } })
  for (const row of all) counts.set(row.runId, { requirements: row._count._all, short: 0 })
  for (const row of short) counts.set(row.runId, { ...counts.get(row.runId)!, short: row._count._all })
  return counts
}

/** The sources as stored, each field read defensively (an older row may hold fewer). */
export function sourcesOf(value: Prisma.JsonValue): RequirementSource[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return []
    const row = entry as Record<string, unknown>
    const str = (key: string, fallback: string) => (typeof row[key] === 'string' ? (row[key] as string) : fallback)
    const int = (key: string, fallback: number) => (typeof row[key] === 'number' && Number.isSafeInteger(row[key]) ? (row[key] as number) : fallback)
    return [
      {
        orderId: str('orderId', ''),
        orderNumber: str('orderNumber', ''),
        orderLineId: str('orderLineId', ''),
        lineSeq: int('lineSeq', 0),
        size: str('size', ''),
        pieces: int('pieces', 0),
        made: int('made', 0),
        quantity: quantityOf(str('quantity', '0')),
        issued: quantityOf(str('issued', '0')),
        dueDate: typeof row.dueDate === 'string' ? row.dueDate : null,
        workOrders: Array.isArray(row.workOrders) ? row.workOrders.filter((value): value is string => typeof value === 'string') : [],
      },
    ]
  })
}

/** What the line views of some lines need, read once. */
export interface LineContext {
  readonly items: ReadonlyMap<string, ItemRow & { standardCost?: Prisma.Decimal | null }>
  readonly colours: ReadonlyMap<string, { id: string; code: string; name: string }>
  readonly suppliers: ReadonlyMap<string, { id: string; code: string; name: string }>
  readonly orders: ReadonlyMap<string, string>
  /** The purchase order each ordered line went into (by its purchase order line), for the "In draft PO-…" words. */
  readonly purchaseOrders: ReadonlyMap<string, { id: string; number: string; status: PurchaseOrderStatus }>
  readonly rulesOf: (itemId: string, supplierId: string | null) => SupplyRules
  /** B-W2a-22: the site's item parameters, the approved sources, the suppliers' calendars and companies (order-by days). */
  readonly itemPlanning: readonly (ItemPlanningRow & { siteId: string })[]
  readonly sources: readonly SourceFacts[]
  readonly calendars: ReadonlyMap<string, LoadedSupplierCalendar>
  readonly companyOf: ReadonlyMap<string, string>
  readonly supplierLeadTimes: ReadonlyMap<string, number | null>
}

export async function readLineContext(db: Reader, rows: readonly RequirementRow[], withCost: boolean): Promise<LineContext> {
  const itemIds = [...new Set(rows.map((row) => row.itemId))]
  const items = itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { ...ITEM_COLUMNS, ...(withCost ? { standardCost: true } : {}) } })
  const colourIds = [...new Set(rows.flatMap((row) => (row.itemColourId ? [row.itemColourId] : [])))]
  const colours = colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } })
  const supplierIds = [...new Set(rows.flatMap((row) => [row.supplierId, row.firmSupplierId].filter((value): value is string => value !== null)))]
  const suppliers = supplierIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: supplierIds } }, select: { id: true, code: true, legalName: true, tradeName: true, leadTimeDays: true } })
  const orderIds = [...new Set(rows.flatMap((row) => sourcesOf(row.sources).map((source) => source.orderId)))].filter((id) => id !== '')
  const orders = orderIds.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } })
  const orderLineIds = [...new Set(rows.flatMap((row) => (row.purchaseOrderLineId ? [row.purchaseOrderLineId] : [])))]
  const purchaseLines =
    orderLineIds.length === 0
      ? []
      : await db.purchaseOrderLine.findMany({ where: { id: { in: orderLineIds } }, select: { id: true, purchaseOrder: { select: { id: true, number: true, status: true } } } })
  const siteIds = [...new Set(rows.map((row) => row.siteId))]
  const sites = siteIds.length === 0 ? [] : await db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, companyId: true } })
  const itemPlanning = itemIds.length === 0 ? [] : await db.itemPlanning.findMany({ where: { siteId: { in: siteIds }, itemId: { in: itemIds } }, select: { ...ITEM_PLANNING_COLUMNS, siteId: true }, orderBy: { id: 'asc' } })
  const sources = await activeSourcesOf(db, itemIds)
  const base: LineContext = {
    items: new Map(items.map((item) => [item.id, item])),
    colours: new Map(colours.map((colour) => [colour.id, colour])),
    suppliers: new Map(suppliers.map((party) => [party.id, { id: party.id, code: party.code, name: party.tradeName ?? party.legalName }])),
    orders: new Map(orders.map((order) => [order.id, order.number])),
    purchaseOrders: new Map(purchaseLines.map((line) => [line.id, { id: line.purchaseOrder.id, number: line.purchaseOrder.number, status: line.purchaseOrder.status }])),
    rulesOf: await readSupplyRules(db, items, supplierIds),
    itemPlanning,
    sources,
    calendars: new Map(),
    companyOf: new Map(sites.map((site) => [site.id, site.companyId])),
    supplierLeadTimes: new Map(suppliers.map((party) => [party.id, party.leadTimeDays])),
  }
  // The suppliers' closed days around every buy's need date (one read for all lines).
  const windows = rows.flatMap((row) => {
    const timing = orderTimingOf(row, base)
    return timing && timing.lead !== null && timing.supplierId ? [leadTimeWindow(timing.target, timing.lead, 'back')] : []
  })
  if (windows.length === 0) return base
  const calendars = await supplierCalendarsFor(db as Prisma.TransactionClient, supplierIds, {
    from: windows.map((window) => window.from).sort()[0]!,
    to: windows.map((window) => window.to).sort().reverse()[0]!,
  })
  return { ...base, calendars }
}

/** A buy line's order timing: the supplier, the day it must be there (less the site's safety days) and the lead time. */
function orderTimingOf(row: RequirementRow, context: LineContext): { supplierId: string | null; target: BusinessDate; lead: number | null } | null {
  if (row.action !== 'BUY') return null
  const supplierId = row.firmedAt !== null ? (row.firmSupplierId ?? row.supplierId) : row.supplierId
  const rule = itemPlanningFor(context.itemPlanning.filter((entry) => entry.siteId === row.siteId && entry.itemId === row.itemId), row.itemColourId)
  const companyId = context.companyOf.get(row.siteId)
  const source = supplierId && companyId ? sourceFor(context.sources, { companyId, itemId: row.itemId, itemColourId: row.itemColourId }, supplierId) : null
  const lead = rule?.buyLeadTimeDays ?? (source ? sourceRules(source, context.supplierLeadTimes.get(supplierId!) ?? null).leadTimeDays : context.rulesOf(row.itemId, supplierId).leadTimeDays)
  const need = dayOf(row.firmDate ?? row.needDate)
  return { supplierId, target: addDays(need, -(rule?.safetyLeadTimeDays ?? 0)), lead }
}

/** The order-by day of a buy line, around its supplier's closed days. */
function orderByOfLine(row: RequirementRow, context: LineContext, today: BusinessDate): LineView['orderBy'] {
  const timing = orderTimingOf(row, context)
  if (!timing) return null
  if (timing.lead === null) return { date: timing.target, leadTimeDays: null, passed: timing.target < today, closedDaysSkipped: 0 }
  const calendar = timing.supplierId ? (context.calendars.get(timing.supplierId)?.calendar ?? null) : null
  const walk = orderByDate(calendar, timing.target, timing.lead)
  return { date: walk.date, leadTimeDays: timing.lead, passed: walk.date < today, closedDaysSkipped: walk.skipped.length }
}

export function lineViewOf(row: RequirementRow, context: LineContext, today: BusinessDate, withCost: boolean): LineView {
  const item = context.items.get(row.itemId)!
  const units = unitsOf(item)
  const numbers = {
    action: row.action,
    uom: row.uom,
    grossQuantity: quantityOf(row.grossQuantity),
    usableStock: quantityOf(row.usableStock),
    heldStock: quantityOf(row.heldStock),
    onOrder: quantityOf(row.onOrder),
    netQuantity: quantityOf(row.netQuantity),
    needDate: dayOf(row.needDate),
  }
  // The stored suggestion is the run's; what it brings in the base unit follows from it (the item's factor).
  const brings = toBase(row.suggestedQuantity.toString(), row.suggestedUom, units, { scale: QUANTITY_SCALE, rounding: 'HALF_UP' }).toFixed(QUANTITY_SCALE)
  const sources = sourcesOf(row.sources)
  const orderIds = [...new Set(sources.map((source) => source.orderId))]
  const decided = row.decision === 'IGNORED' ? readDecisionNote(row.decisionNote) : null
  const standardCost = withCost ? (item.standardCost ?? null) : null
  const unitCost = standardCost === null ? null : unitCostIn(standardCost.toString(), row.suggestedUom, units, { scale: COST_SCALE, rounding: 'HALF_UP' }).toFixed(COST_SCALE)
  const expected = standardCost === null ? null : stockValue(brings, standardCost.toString(), item.currency)
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    version: row.version,
    item: { id: item.id, code: item.code, name: item.name, kind: item.kind, baseUom: item.baseUom, purchaseUom: item.purchaseUom, requiresCrViTest: item.requiresCrViTest },
    colour: row.itemColourId ? (context.colours.get(row.itemColourId) ?? null) : null,
    ...numbers,
    suggestedQuantity: quantityOf(row.suggestedQuantity),
    suggestedUom: row.suggestedUom,
    suggestedBaseQuantity: quantityOf(brings),
    estimatedHides: hidesFor(brings, units),
    orderBy: orderByOfLine(row, context, today),
    supplier: row.supplierId ? (context.suppliers.get(row.supplierId) ?? null) : null,
    why: whyLine(numbers),
    orders: orderIds.map((id) => ({ id, number: context.orders.get(id) ?? sources.find((source) => source.orderId === id)?.orderNumber ?? '' })),
    sources: sources.map((source) => ({ ...source, workOrders: [...source.workOrders] })),
    decision: row.decision,
    decisionReason: decided?.reason ?? null,
    decisionNote: decided ? decided.note : row.decisionNote,
    purchaseOrderLineId: row.purchaseOrderLineId,
    purchaseOrder: row.purchaseOrderLineId ? (context.purchaseOrders.get(row.purchaseOrderLineId) ?? null) : null,
    decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
    // B-W2a-22 (PLN-075): the firm planned order; `carried` when it was made firm on an earlier plan.
    firm:
      row.firmedAt !== null && row.firmQuantity !== null && row.firmBaseQuantity !== null && row.firmDate !== null
        ? {
            quantity: quantityOf(row.firmQuantity),
            uom: row.suggestedUom,
            baseQuantity: quantityOf(row.firmBaseQuantity),
            date: dayOf(row.firmDate),
            supplier: row.firmSupplierId ? (context.suppliers.get(row.firmSupplierId) ?? null) : null,
            firmedAt: toUtcIso(row.firmedAt),
            firmedById: row.firmedById,
            // B-W2b-20: a run writes a carried line with firmCarriedFromId; before W2b by its shape (version 1, or firmed
            // before the line was made).
            carried: row.firmCarriedFromId !== null || row.version === 1 || row.firmedAt.getTime() < row.createdAt.getTime(),
          }
        : null,
    ...(withCost ? { unitCost: asMoney('cost', unitCost), expectedAmount: asMoney('cost', expected) } : {}),
    currency: item.currency,
  }
}

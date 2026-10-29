import type { Prisma } from '@nexus/factory-db'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { stockValue } from '@nexus/factory-domain/inventory/ledger/valuation'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { hidesFor, orderByOf, type SupplyRules } from '@nexus/factory-domain/planning/buy'
import { readDecisionNote } from '@nexus/factory-domain/planning/decisions'
import type { PlanWarning, RequirementSource } from '@nexus/factory-domain/planning/explode'
import { whyLine } from '@nexus/factory-domain/planning/explain'
import { COST_SCALE, QUANTITY_SCALE, toBase, unitCostIn } from '@nexus/factory-domain/product/units/units'
import type { LineView, RunView } from './contract'
import { dayOf, ITEM_COLUMNS, readSupplyRules, unitsOf, type ItemRow, type Reader } from './store'

/**
 * How runs and their lines are answered (A2 SCR-055): a run with its warnings and counts; a line with its snapshot
 * numbers, the suggestion in the purchase unit and in the base unit, about how many hides, the order-by day from the
 * supplier's terms as they are today, the netting as one line, the orders behind it, its decision, and, for a caller
 * with the cost grain only, the item's standard cost per suggested unit and the suggestion's expected value.
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
  readonly rulesOf: (itemId: string, supplierId: string | null) => SupplyRules
}

export async function readLineContext(db: Reader, rows: readonly RequirementRow[], withCost: boolean): Promise<LineContext> {
  const itemIds = [...new Set(rows.map((row) => row.itemId))]
  const items = itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { ...ITEM_COLUMNS, ...(withCost ? { standardCost: true } : {}) } })
  const colourIds = [...new Set(rows.flatMap((row) => (row.itemColourId ? [row.itemColourId] : [])))]
  const colours = colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: colourIds } }, select: { id: true, code: true, name: true } })
  const supplierIds = [...new Set(rows.flatMap((row) => (row.supplierId ? [row.supplierId] : [])))]
  const suppliers = supplierIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: supplierIds } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  const orderIds = [...new Set(rows.flatMap((row) => sourcesOf(row.sources).map((source) => source.orderId)))].filter((id) => id !== '')
  const orders = orderIds.length === 0 ? [] : await db.salesOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, number: true } })
  return {
    items: new Map(items.map((item) => [item.id, item])),
    colours: new Map(colours.map((colour) => [colour.id, colour])),
    suppliers: new Map(suppliers.map((party) => [party.id, { id: party.id, code: party.code, name: party.tradeName ?? party.legalName }])),
    orders: new Map(orders.map((order) => [order.id, order.number])),
    rulesOf: await readSupplyRules(db, items, supplierIds),
  }
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
  const rules = context.rulesOf(row.itemId, row.supplierId)
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
    orderBy: row.action === 'BUY' ? orderByOf(numbers.needDate, rules, today) : null,
    supplier: row.supplierId ? (context.suppliers.get(row.supplierId) ?? null) : null,
    why: whyLine(numbers),
    orders: orderIds.map((id) => ({ id, number: context.orders.get(id) ?? sources.find((source) => source.orderId === id)?.orderNumber ?? '' })),
    sources: sources.map((source) => ({ ...source, workOrders: [...source.workOrders] })),
    decision: row.decision,
    decisionReason: decided?.reason ?? null,
    decisionNote: decided ? decided.note : row.decisionNote,
    purchaseOrderLineId: row.purchaseOrderLineId,
    decidedAt: row.decidedAt ? toUtcIso(row.decidedAt) : null,
    ...(withCost ? { unitCost: asMoney('cost', unitCost), expectedAmount: asMoney('cost', expected) } : {}),
    currency: item.currency,
  }
}

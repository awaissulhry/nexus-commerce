import type { Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { BuyingRule, PlanInput, RequirementAction } from '@nexus/factory-domain/planning/explode'
import type { FirmSupply, PlanReservation } from '@nexus/factory-domain/planning/mrp/net'
import { itemPlanningFor } from '@nexus/factory-domain/planning/settings/items'
import { buyFromSource, sourceFor, unitsBoughtIn } from '@nexus/factory-domain/purchasing/sources/sources'
import type { SourceFacts } from '@nexus/factory-domain/purchasing/sources/sources'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { demandOpen, readDemands, RESERVATION_COLUMNS } from '../inventory/reservations/store'
import { activeSourcesOf } from '../purchasing/supplier-items/store'
import { dayOf, ITEM_COLUMNS, lotFactsOf, planItemOf, readDemand, readLots, readPurchases, readStock, readSupplyRules, readWorkOrders, unitsOf, type DemandRead, type ItemRow, type PurchaseRead, type Reader, type SiteRow } from './store'

/**
 * What a run, and every live read of the plan (readiness, the shortage list), reads of a site (B-W2a-22), in one client,
 * one query after another: W1's inputs (open orders, BOMs, work orders, stock, lots, open purchase lines: ./store), and
 *
 *   reservations   the site's ACTIVE reservations of the materials (B-W2a-11), with whether their demand is still open
 *   firm supply    the firm OPEN lines of the site's latest DONE run (PLN-075): the run carries them
 *   parameters     the site's item parameters (B-W2a-16: make or buy, preferred supplier, lead times, safety stock)
 *   sources        the approved sources of the materials (B-W2a-10): the supplier a buy goes to and how it is rounded,
 *                  so the plan grid and the purchase order line agree (`buyingOf`)
 *
 * Materials with a safety stock but no demand are read too (their stock and purchase lines), for the exception list.
 */

export const ITEM_PLANNING_COLUMNS = {
  id: true,
  itemId: true,
  itemColourId: true,
  method: true,
  source: true,
  supplierId: true,
  buyLeadTimeDays: true,
  makeLeadTimeDays: true,
  safetyLeadTimeDays: true,
  safetyStock: true,
} as const satisfies Prisma.ItemPlanningSelect
export type ItemPlanningRow = Prisma.ItemPlanningGetPayload<{ select: typeof ITEM_PLANNING_COLUMNS }>

export const FIRM_COLUMNS = {
  id: true,
  itemId: true,
  itemColourId: true,
  action: true,
  suggestedUom: true,
  supplierId: true,
  firmQuantity: true,
  firmBaseQuantity: true,
  firmDate: true,
  firmSupplierId: true,
  firmedAt: true,
  firmedById: true,
} as const satisfies Prisma.MaterialRequirementSelect

export interface PlanInputs {
  readonly input: PlanInput
  readonly demand: DemandRead
  readonly items: readonly ItemRow[]
  readonly purchases: readonly PurchaseRead[]
  readonly reservations: readonly PlanReservation[]
  readonly firmSupply: readonly FirmSupply[]
  readonly itemPlanning: readonly ItemPlanningRow[]
  readonly sources: readonly SourceFacts[]
  /** Material ids with a safety stock at the site and no demand in this plan. */
  readonly safetyOnlyItemIds: readonly string[]
  readonly supplierLeadTimes: ReadonlyMap<string, number | null>
}

const quantity = (value: { toString(): string }): string => {
  const [whole, fraction = ''] = value.toString().split('.')
  return `${whole}.${(fraction + '0000').slice(0, 4)}`
}

/** The firm OPEN lines of a run: the planned orders the next run carries. */
export async function readFirmSupply(db: Reader, runId: string | null): Promise<FirmSupply[]> {
  if (runId === null) return []
  const rows = await db.materialRequirement.findMany({ where: { runId, decision: 'OPEN', firmedAt: { not: null } }, select: FIRM_COLUMNS, orderBy: { seq: 'asc' } })
  return rows.map((row) => ({
    requirementId: row.id,
    itemId: row.itemId,
    itemColourId: row.itemColourId,
    action: row.action,
    quantity: quantity(row.firmQuantity!),
    uom: row.suggestedUom,
    baseQuantity: quantity(row.firmBaseQuantity!),
    date: dayOf(row.firmDate!),
    supplierId: row.firmSupplierId,
    firmedAt: row.firmedAt!,
    firmedById: row.firmedById,
  }))
}

/** The site's ACTIVE reservations of the materials, with whether their work order or order is still open. */
export async function readReservations(db: Reader, siteId: string, itemIds: readonly string[]): Promise<PlanReservation[]> {
  if (itemIds.length === 0) return []
  const rows = await db.reservation.findMany({ where: { siteId, status: 'ACTIVE', itemId: { in: [...itemIds] } }, select: RESERVATION_COLUMNS, orderBy: { id: 'asc' } })
  const demands = await readDemands(db, rows, { withOrders: true })
  return rows.map((row) => ({
    id: row.id,
    itemId: row.itemId,
    itemColourId: row.itemColourId,
    lotId: row.lotId,
    hideId: row.hideId,
    open: new Dec(row.quantity.toString()).minus(row.issuedQuantity.toString()).toFixed(4),
    workOrderId: row.workOrderId,
    salesOrderLineId: row.salesOrderLineId,
    demandOpen: demandOpen(row, demands),
  }))
}

/** The latest DONE run of the site (the one a new run supersedes and whose firm lines it carries). */
export const latestDoneRun = (db: Reader, siteId: string) =>
  db.planningRun.findFirst({ where: { siteId, status: 'DONE' }, select: { id: true, finishedAt: true, startedAt: true }, orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }] })

/** Everything the plan of a site reads, as of `runDate`; `firmFromRunId`: the run whose firm lines are carried. */
export async function readPlanInputs(db: Reader, site: SiteRow, runDate: BusinessDate, firmFromRunId: string | null): Promise<PlanInputs> {
  const demand = await readDemand(db, site)
  const firmSupply = await readFirmSupply(db, firmFromRunId)
  const demandItemIds = [...new Set(demand.revisions.flatMap((revision) => revision.lines.map((line) => line.itemId)))]
  const itemPlanning = await db.itemPlanning.findMany({ where: { siteId: site.id }, select: ITEM_PLANNING_COLUMNS, orderBy: { id: 'asc' } })
  const safetyOnlyItemIds = [...new Set(itemPlanning.filter((row) => row.safetyStock !== null && row.safetyStock.gt(0) && !demandItemIds.includes(row.itemId)).map((row) => row.itemId))].sort()
  const itemIds = [...new Set([...demandItemIds, ...firmSupply.map((firm) => firm.itemId), ...safetyOnlyItemIds])].sort()
  const items = itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: ITEM_COLUMNS })
  const workOrders = await readWorkOrders(db, site.id, demand.orderLines.map((line) => line.orderLineId))
  const stock = await readStock(db, site.id, itemIds)
  const lots = await readLots(db, stock.flatMap((entry) => (entry.lotId ? [entry.lotId] : [])))
  const purchases = await readPurchases(db, site.id, itemIds)
  const reservations = await readReservations(db, site.id, itemIds)
  const sources = await activeSourcesOf(db, itemIds)
  const bomSupplierIds = demand.revisions.flatMap((revision) => revision.lines.map((line) => line.supplierId))
  const candidateIds = [...bomSupplierIds, ...itemPlanning.map((row) => row.supplierId), ...sources.map((source) => source.partyId)]
  const supplyRulesOf = await readSupplyRules(db, items, candidateIds)
  const partyIds = [...new Set(candidateIds.filter((value): value is string => value !== null))]
  const parties = partyIds.length === 0 ? [] : await db.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, leadTimeDays: true } })
  const supplierLeadTimes = new Map(parties.map((party) => [party.id, party.leadTimeDays]))
  const input: PlanInput = {
    runDate,
    orderLines: demand.orderLines,
    revisions: demand.revisions,
    items: items.map(planItemOf),
    workOrderCells: workOrders.cells,
    workOrderIssues: workOrders.issues,
    stock,
    lots: lots.map(lotFactsOf),
    purchases,
    supplyRulesOf,
    reservations,
    firmSupply,
    buying: buyingOf({ companyId: site.companyId, items, itemPlanning, sources, supplierLeadTimes }),
  }
  return { input, demand, items, purchases, reservations, firmSupply, itemPlanning, sources, safetyOnlyItemIds, supplierLeadTimes }
}

/**
 * The run's choice of make or buy, supplier and suggestion (B-W2a-10's order, so the plan grid and the purchase order
 * line agree): the site's item parameters' source (MAKE or BUY) over the item's sourcing; a buy goes to the site's
 * preferred supplier, else the best approved source, else W1's (the BOM lines' or the item's default); it is rounded to
 * that supplier's source (its unit, minimum and steps) when there is one, else to W1's terms of the item.
 */
export function buyingOf(facts: {
  readonly companyId: string
  readonly items: readonly ItemRow[]
  readonly itemPlanning: readonly ItemPlanningRow[]
  readonly sources: readonly SourceFacts[]
  readonly supplierLeadTimes: ReadonlyMap<string, number | null>
}): BuyingRule {
  const itemOf = new Map(facts.items.map((item) => [item.id, item]))
  return ({ item, itemColourId, action, supplierId, quantity }) => {
    const row = itemPlanningFor(facts.itemPlanning.filter((entry) => entry.itemId === item.id), itemColourId)
    const chosenAction: RequirementAction = row?.source === 'MAKE' ? 'MAKE' : row?.source === 'BUY' ? 'BUY' : action
    if (chosenAction === 'MAKE') return { action: 'MAKE', supplierId: null, suggestion: null }
    const need = { companyId: facts.companyId, itemId: item.id, itemColourId }
    const supplier = row?.supplierId ?? sourceFor(facts.sources, need)?.partyId ?? supplierId
    const source = supplier ? sourceFor(facts.sources, need, supplier) : null
    const stored = itemOf.get(item.id)
    const units = stored ? unitsOf(stored) : item.units
    const usable = source && unitsBoughtIn(units, source.purchaseUom) ? source : null
    const suggestion = usable ? buyFromSource(quantity, units, usable, supplier ? (facts.supplierLeadTimes.get(supplier) ?? null) : null) : null
    return { action: 'BUY', supplierId: supplier, suggestion }
  }
}

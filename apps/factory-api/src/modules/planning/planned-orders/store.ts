import type { Prisma } from '@nexus/factory-db'
import type { ExplodeRevision } from '@nexus/factory-domain/product/bom-structure/explode'
import type { EffectFacts, OptionEffectKind } from '@nexus/factory-domain/product/options/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { GarmentSource } from '@nexus/factory-domain/planning/planned-orders/explosion'
import type { Garments } from '@nexus/factory-domain/planning/planned-orders/multilevel'
import { itemPlanningFor } from '@nexus/factory-domain/planning/settings/items'
import { readExplosion, type ExplosionRead } from '../../product/bom/explode'
import type { DemandRead, Reader, SiteRow } from '../store'

/**
 * What the planned orders read (B-W2b-293), in one client, one query after another.
 *
 *   garments     per order line of the plan: its revision with every sub-assembly below it (THE multi-level reader,
 *                product/bom/explode `readExplosion`), the option values chosen on the line (SalesOrderLineOption) and their
 *                BOM effects (OptionEffect BOM_ADD, BOM_REPLACE, BOM_REMOVE; no price is read), the site's phantom
 *                components (ItemPlanning.phantom), the colourways' codes; with every material they name (so the run reads
 *                their stock, purchase lines and sources) and the supplier of every line below the revision's own
 *   planned      the site's planned work orders (PlannedWorkOrder) the run moves on, keeps or removes
 */

const BOM_EFFECTS = ['BOM_ADD', 'BOM_REPLACE', 'BOM_REMOVE'] as const
const text = (value: { toString(): string } | null): string | null => (value === null ? null : decimalText(value.toString()))

/** The explosions of the plan's order lines (one per revision), and what the run must read for them. */
export interface GarmentRead {
  readonly garments: Garments
  /** Every material the explosions and the effects name. */
  readonly itemIds: readonly string[]
  /** The supplier of each line below a revision's own lines (sub-assemblies), by line id. */
  readonly lineSuppliers: ReadonlyMap<string, string | null>
}

/** The garments of the demand's order lines (null when no line has a revision to explode). */
export async function readGarments(db: Reader, site: SiteRow, demand: DemandRead): Promise<GarmentRead | null> {
  const revisionIds = [...new Set(demand.orderLines.flatMap((line) => (line.revisionId ? [line.revisionId] : [])))].sort()
  if (revisionIds.length === 0) return null
  const reads = new Map<string, ExplosionRead>()
  for (const revisionId of revisionIds) {
    const read = await readExplosion(db, revisionId)
    if (read) reads.set(revisionId, read)
  }
  // The options chosen on the lines, and the BOM effects of those values.
  const lineIds = demand.orderLines.map((line) => line.orderLineId)
  const options = lineIds.length === 0 ? [] : await db.salesOrderLineOption.findMany({ where: { lineId: { in: lineIds } }, select: { lineId: true, valueId: true }, orderBy: [{ lineId: 'asc' }, { id: 'asc' }] })
  const chosenOf = new Map<string, Set<string>>()
  for (const option of options) chosenOf.set(option.lineId, new Set([...(chosenOf.get(option.lineId) ?? []), option.valueId]))
  const valueIds = [...new Set(options.map((option) => option.valueId))]
  const effectRows =
    valueIds.length === 0
      ? []
      : await db.optionEffect.findMany({
          where: { valueId: { in: valueIds }, kind: { in: [...BOM_EFFECTS] } },
          select: { id: true, valueId: true, kind: true, itemId: true, itemColourId: true, targetItemId: true, qty: true, uom: true, sizeQuantities: true, section: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
  const effects: EffectFacts[] = effectRows.map((row) => ({
    id: row.id,
    valueId: row.valueId,
    kind: row.kind as OptionEffectKind,
    itemId: row.itemId,
    itemColourId: row.itemColourId,
    targetItemId: row.targetItemId,
    qty: text(row.qty),
    uom: row.uom,
    sizeQuantities: row.sizeQuantities !== null && typeof row.sizeQuantities === 'object' && !Array.isArray(row.sizeQuantities) ? (row.sizeQuantities as Record<string, string>) : null,
    section: row.section,
    operationId: null,
    minutes: null,
    priceDelta: null,
    currency: null,
    pricePct: null,
    note: null,
  }))
  // The materials effects put in that no explosion names (their units).
  const named = new Set<string>()
  for (const read of reads.values()) for (const itemId of read.materials.keys()) named.add(itemId)
  const effectItems = [...new Set(effects.flatMap((effect) => (effect.itemId && !named.has(effect.itemId) ? [effect.itemId] : [])))]
  const extra = effectItems.length === 0 ? [] : await db.item.findMany({ where: { id: { in: effectItems } }, select: { id: true, code: true, baseUom: true, purchaseUom: true, purchaseFactor: true, consumptionUom: true, consumptionFactor: true } })
  const extraUnits = new Map(
    extra.map((item) => [item.id, { code: item.code, units: { baseUom: item.baseUom, purchaseUom: item.purchaseUom, purchaseFactor: decimalText(item.purchaseFactor.toString()), consumptionUom: item.consumptionUom, consumptionFactor: decimalText(item.consumptionFactor.toString()) } }]),
  )
  // The site's phantom components (PLN-079).
  const phantomRows = await db.itemPlanning.findMany({ where: { siteId: site.id, phantom: true }, select: { itemId: true, itemColourId: true }, orderBy: { id: 'asc' } })
  const allPlanning = phantomRows.length === 0 ? [] : await db.itemPlanning.findMany({ where: { siteId: site.id, itemId: { in: [...new Set(phantomRows.map((row) => row.itemId))] } }, select: { itemId: true, itemColourId: true, phantom: true }, orderBy: { id: 'asc' } })
  const isPhantom = (itemId: string, itemColourId: string | null): boolean => itemPlanningFor(allPlanning.filter((row) => row.itemId === itemId), itemColourId)?.phantom === true
  const colourwayIds = [...new Set(demand.orderLines.map((line) => line.colourwayId))]
  const colourways = colourwayIds.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true } })
  const codeOfColourway = new Map(colourways.map((row) => [row.id, row.code]))
  // The suppliers of the lines below each revision's own (the sub-assemblies' lines).
  const deeper = [...reads.entries()].flatMap(([revisionId, read]) => [...read.revisions.values()].filter((revision) => revision.revisionId !== revisionId).flatMap((revision) => revision.lines.map((line) => line.id)))
  const supplierRows = deeper.length === 0 ? [] : await db.bomLine.findMany({ where: { id: { in: [...new Set(deeper)] } }, select: { id: true, supplierId: true } })
  const lineSuppliers = new Map(supplierRows.map((row) => [row.id, row.supplierId]))

  const sources = new Map<string, GarmentSource>()
  const sourceFor = (orderLineId: string, revisionId: string): GarmentSource | null => {
    const read = reads.get(revisionId)
    if (!read) return null
    const chosen = chosenOf.get(orderLineId) ?? new Set<string>()
    const key = `${revisionId}|${[...chosen].sort().join(',')}`
    const known = sources.get(key)
    if (known) return known
    const source: GarmentSource = {
      top: read.top as ExplodeRevision,
      revisions: read.revisions,
      unitsOf: (itemId) => read.materials.get(itemId)?.units ?? extraUnits.get(itemId)?.units,
      codeOf: (itemId) => read.materials.get(itemId)?.code ?? extraUnits.get(itemId)?.code ?? '?',
      chosen,
      effects: effects.filter((effect) => chosen.has(effect.valueId)),
      isPhantom,
    }
    sources.set(key, source)
    return source
  }
  const revisionOf = new Map(demand.orderLines.map((line) => [line.orderLineId, line.revisionId]))
  const itemIds = new Set<string>([...named, ...effectItems])
  return {
    garments: {
      sourceOf: (orderLineId) => {
        const revisionId = revisionOf.get(orderLineId)
        return revisionId ? sourceFor(orderLineId, revisionId) : null
      },
      colourwayCodeOf: (colourwayId) => codeOfColourway.get(colourwayId) ?? '',
    },
    itemIds: [...itemIds].sort(),
    lineSuppliers,
  }
}

// ---- the planned orders of a site -------------------------------------------------------------------------------------

export const PLANNED_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  runId: true,
  kind: true,
  styleId: true,
  colourwayId: true,
  styleRevisionId: true,
  sizes: true,
  quantity: true,
  sizeGroup: true,
  startDate: true,
  dueDate: true,
  demand: true,
  lineId: true,
  partyId: true,
  operationSeqs: true,
  kitDueAt: true,
  firm: true,
  firmedAt: true,
  firmedById: true,
  protectedFields: true,
  protectedById: true,
  protectedAt: true,
  status: true,
  workOrderId: true,
  subcontractOrderId: true,
  convertedAt: true,
  convertedById: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.PlannedWorkOrderSelect
export type PlannedRow = Prisma.PlannedWorkOrderGetPayload<{ select: typeof PLANNED_COLUMNS }>

/** The site's planned orders still PLANNED (the run's to move on, keep or remove), oldest first. */
export const readOpenPlanned = (db: Reader, siteId: string): Promise<PlannedRow[]> =>
  db.plannedWorkOrder.findMany({ where: { siteId, status: 'PLANNED' }, select: PLANNED_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

export const readPlanned = (db: Reader, id: string): Promise<PlannedRow | null> => db.plannedWorkOrder.findUnique({ where: { id }, select: PLANNED_COLUMNS })

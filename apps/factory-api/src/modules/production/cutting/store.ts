import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { partOf, type CutPiece, type PlannedPart } from '@nexus/factory-domain/production/cutting/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'

/**
 * The cutting log's reads (B-W1-40): a work order as the cutting table sees it, its cells, the parts of its hide-cut
 * materials (its frozen WorkOrderMaterial rows of HIDE-tracked items, with each BOM line's place), its live cut log
 * entries and their pieces, and a hide: its lot, what the ledger says the work order holds of it (ISSUE and RETURN moves
 * that name it), what was cut of it, what else of it is anywhere. Every read names its columns (the floor reads Item
 * without its standard cost and ProductionSettings never), selects no relation (inside a command's transaction the
 * queries run one after another on its one connection), and runs as the caller: row-level security keeps a floor
 * device to its own site.
 */

export type Reader = FactoryClient | CommandTx

const dec = (value: { toString(): string } | null | undefined): Decimal => (value === null || value === undefined ? ZERO : new Dec(value.toString()))
const byId = <Row extends { id: string }>(rows: readonly Row[]): Map<string, Row> => new Map(rows.map((row) => [row.id, row]))
const ids = (values: Iterable<string | null | undefined>): string[] => [...new Set([...values].filter((value): value is string => typeof value === 'string'))]

export const CUT_HEADER = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  batchNumber: true,
  status: true,
  kind: true,
  styleId: true,
  dueDate: true,
  priority: true,
  version: true,
} as const satisfies Prisma.WorkOrderSelect
export type CutHeader = Prisma.WorkOrderGetPayload<{ select: typeof CUT_HEADER }>

export async function readHeader(db: Reader, workOrderId: string): Promise<CutHeader | null> {
  if (!isUuid(workOrderId)) return null
  return db.workOrder.findUnique({ where: { id: workOrderId }, select: CUT_HEADER })
}

// ---- cells and their parts ----------------------------------------------------------------------------------------------------

export interface CellRow {
  readonly id: string
  readonly colourwayId: string
  readonly colourwayCode: string
  readonly size: string
  readonly quantity: number
}

/** The work order's cells, by colourway code and the style's size order. */
export async function readCells(db: Reader, workOrderId: string, styleId: string): Promise<CellRow[]> {
  const cells = await db.workOrderSize.findMany({ where: { workOrderId }, select: { id: true, colourwayId: true, size: true, quantity: true } })
  const colourways = byId(await db.colourway.findMany({ where: { id: { in: ids(cells.map((cell) => cell.colourwayId)) } }, select: { id: true, code: true } }))
  const style = await db.style.findUnique({ where: { id: styleId }, select: { sizes: true } })
  const sizes = style?.sizes ?? []
  const order = (size: string) => (sizes.indexOf(size) < 0 ? sizes.length : sizes.indexOf(size))
  return cells
    .map((cell) => ({ id: cell.id, colourwayId: cell.colourwayId, colourwayCode: colourways.get(cell.colourwayId)?.code ?? '', size: cell.size, quantity: cell.quantity }))
    .sort((a, b) => (a.colourwayCode < b.colourwayCode ? -1 : a.colourwayCode > b.colourwayCode ? 1 : order(a.size) - order(b.size)))
}

/** The parts cut from hides: the frozen materials of HIDE-tracked items, each with its BOM line's place (or the item's code). */
export async function readPlannedParts(db: Reader, workOrderId: string): Promise<PlannedPart[]> {
  const rows = await db.workOrderMaterial.findMany({ where: { workOrderId }, select: { bomLineId: true, itemId: true, itemColourId: true, workOrderSizeId: true, baseQuantity: true } })
  if (rows.length === 0) return []
  const items = byId(await db.item.findMany({ where: { id: { in: ids(rows.map((row) => row.itemId)) }, tracking: 'HIDE' }, select: { id: true, code: true } }))
  const lines = byId(await db.bomLine.findMany({ where: { id: { in: ids(rows.map((row) => row.bomLineId)) } }, select: { id: true, placement: true } }))
  return rows.flatMap((row) => {
    const item = items.get(row.itemId)
    if (!item) return []
    return [{ cellId: row.workOrderSizeId, itemId: row.itemId, itemColourId: row.itemColourId, part: partOf(lines.get(row.bomLineId)?.placement, item.code), baseQuantity: row.baseQuantity.toString() }]
  })
}

// ---- the cut log --------------------------------------------------------------------------------------------------------------

export const ENTRY_COLUMNS = {
  id: true,
  siteId: true,
  workOrderId: true,
  lotId: true,
  hideId: true,
  uom: true,
  areaUsed: true,
  baseAreaUsed: true,
  remnantArea: true,
  baseRemnantArea: true,
  reversalOfId: true,
  note: true,
  workerId: true,
  stationId: true,
  deviceId: true,
  clientEventId: true,
  deviceTime: true,
  serverTime: true,
  createdById: true,
} as const satisfies Prisma.CutLogSelect
export type EntryRow = Prisma.CutLogGetPayload<{ select: typeof ENTRY_COLUMNS }>

export async function readEntry(db: Reader, cutLogId: string): Promise<EntryRow | null> {
  if (!isUuid(cutLogId)) return null
  return db.cutLog.findUnique({ where: { id: cutLogId }, select: ENTRY_COLUMNS })
}

/** Every entry of the work order (or of some hides of it), oldest first, with the ids of the entries that are reversed. */
export async function readEntries(db: Reader, workOrderId: string, hideIds?: readonly string[]): Promise<{ entries: EntryRow[]; reversed: Set<string> }> {
  const entries = await db.cutLog.findMany({ where: { workOrderId, ...(hideIds ? { hideId: { in: [...hideIds] } } : {}) }, select: ENTRY_COLUMNS, orderBy: { id: 'asc' } })
  return { entries, reversed: new Set(entries.flatMap((entry) => (entry.reversalOfId ? [entry.reversalOfId] : []))) }
}

/** The live entries: neither a reversal nor reversed. */
export const liveOf = ({ entries, reversed }: { entries: EntryRow[]; reversed: Set<string> }): EntryRow[] => entries.filter((entry) => entry.reversalOfId === null && !reversed.has(entry.id))

/** The pieces of these entries. */
export async function readPieces(db: Reader, cutLogIds: readonly string[]): Promise<CutPiece[]> {
  if (cutLogIds.length === 0) return []
  const rows = await db.cutLogPiece.findMany({ where: { cutLogId: { in: [...cutLogIds] } }, select: { cutLogId: true, workOrderSizeId: true, part: true, pieces: true }, orderBy: { id: 'asc' } })
  return rows.map((row) => ({ cutLogId: row.cutLogId, cellId: row.workOrderSizeId, part: row.part, pieces: row.pieces }))
}

/** The pieces of the work order's live entries. */
export async function readLivePieces(db: Reader, workOrderId: string): Promise<CutPiece[]> {
  return readPieces(db, liveOf(await readEntries(db, workOrderId)).map((entry) => entry.id))
}

/** The ACTIVE bundles that carry an entry's pieces (B-W1-41), by code. */
export async function readBundlesOf(db: Reader, cutLogId: string): Promise<string[]> {
  const rows = await db.bundle.findMany({ where: { cutLogIds: { has: cutLogId }, status: 'ACTIVE' }, select: { code: true }, orderBy: { code: 'asc' } })
  return rows.map((row) => row.code)
}

/** The device's newest entry at the site (a reversal included: an undo is the device's last action too); serverTime orders rows. */
export async function latestEntryOf(db: Reader, siteId: string, deviceId: string): Promise<string | null> {
  const row = await db.cutLog.findFirst({ where: { siteId, deviceId }, orderBy: [{ serverTime: 'desc' }, { id: 'desc' }], select: { id: true } })
  return row?.id ?? null
}

/**
 * The hide's newest live entry for the work order (serverTime orders rows): the closing entry of a Hide done that used
 * nothing more (the last cut took what was left), named on the used-up hide (Hide.closingCutLogId).
 */
export async function lastLiveEntryOf(db: Reader, siteId: string, workOrderId: string, hideId: string): Promise<string | null> {
  const row = await db.cutLog.findFirst({
    where: { siteId, workOrderId, hideId, reversalOfId: null, reversals: { none: {} } },
    orderBy: [{ serverTime: 'desc' }, { id: 'desc' }],
    select: { id: true },
  })
  return row?.id ?? null
}

// ---- a hide ----------------------------------------------------------------------------------------------------------------------

export const HIDE_COLUMNS = {
  id: true,
  siteId: true,
  lotId: true,
  itemId: true,
  code: true,
  supplierCode: true,
  area: true,
  areaUom: true,
  baseArea: true,
  grade: true,
  shade: true,
  thicknessMm: true,
  defects: true,
  state: true,
  closingCutLogId: true,
  version: true,
} as const satisfies Prisma.HideSelect
export type HideRow = Prisma.HideGetPayload<{ select: typeof HIDE_COLUMNS }>

export async function readHideByCode(db: Reader, code: string): Promise<HideRow | null> {
  return db.hide.findFirst({ where: { code: code.trim() }, select: HIDE_COLUMNS })
}

export async function readHideById(db: Reader, hideId: string): Promise<HideRow | null> {
  if (!isUuid(hideId)) return null
  return db.hide.findUnique({ where: { id: hideId }, select: HIDE_COLUMNS })
}

export const LOT_COLUMNS = {
  id: true,
  siteId: true,
  itemId: true,
  itemColourId: true,
  code: true,
  supplierLotRef: true,
  dyeBatch: true,
  shade: true,
  qualityStatus: true,
  requiresCrViTest: true,
  crViStatus: true,
} as const satisfies Prisma.LotSelect
export type LotRow = Prisma.LotGetPayload<{ select: typeof LOT_COLUMNS }>

export async function readLot(db: Reader, lotId: string): Promise<LotRow | null> {
  return db.lot.findUnique({ where: { id: lotId }, select: LOT_COLUMNS })
}

/** The item's units and code (never its standard cost: the floor may not read it). */
export const ITEM_COLUMNS = { id: true, code: true, name: true, baseUom: true, tracking: true, purchaseUom: true, purchaseFactor: true, consumptionUom: true, consumptionFactor: true } as const satisfies Prisma.ItemSelect
export type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_COLUMNS }>

export async function readItem(db: Reader, itemId: string): Promise<ItemRow | null> {
  return db.item.findUnique({ where: { id: itemId }, select: ITEM_COLUMNS })
}

export const unitsOf = (item: ItemRow) => ({
  baseUom: item.baseUom,
  purchaseUom: item.purchaseUom,
  purchaseFactor: item.purchaseFactor.toString(),
  consumptionUom: item.consumptionUom,
  consumptionFactor: item.consumptionFactor.toString(),
})

/** Per hide: issued to the work order (ISSUE out, less its reversals) and returned from it (RETURN in, less its reversals). */
export async function readHideLedger(db: Reader, siteId: string, workOrderId: string, hideIds: readonly string[]): Promise<Map<string, { issued: Decimal; returned: Decimal; at: Decimal }>> {
  const result = new Map<string, { issued: Decimal; returned: Decimal; at: Decimal }>()
  if (hideIds.length === 0) return result
  const where = { siteId, workOrderId, hideId: { in: [...hideIds] }, reason: { in: ['ISSUE', 'RETURN'] as ('ISSUE' | 'RETURN')[] } }
  const out = await db.stockMove.groupBy({ by: ['hideId', 'reason'], where: { ...where, fromLocationId: { not: null }, toLocationId: null }, _sum: { baseQuantity: true } })
  const back = await db.stockMove.groupBy({ by: ['hideId', 'reason'], where: { ...where, fromLocationId: null, toLocationId: { not: null } }, _sum: { baseQuantity: true } })
  for (const hideId of hideIds) result.set(hideId, { issued: ZERO, returned: ZERO, at: ZERO })
  const entry = (hideId: string | null) => (hideId ? result.get(hideId) : undefined)
  for (const row of out) {
    const facts = entry(row.hideId)
    if (!facts) continue
    // Out of a location to the work order: an issue, or the reversal of a return.
    if (row.reason === 'ISSUE') facts.issued = facts.issued.plus(dec(row._sum.baseQuantity))
    else facts.returned = facts.returned.minus(dec(row._sum.baseQuantity))
  }
  for (const row of back) {
    const facts = entry(row.hideId)
    if (!facts) continue
    // From the work order into a location: a return, or the reversal of an issue.
    if (row.reason === 'RETURN') facts.returned = facts.returned.plus(dec(row._sum.baseQuantity))
    else facts.issued = facts.issued.minus(dec(row._sum.baseQuantity))
  }
  for (const facts of result.values()) facts.at = facts.issued.minus(facts.returned)
  return result
}

/** What was cut of these hides for the work order: the cut log net of reversals (base unit), per hide. */
export async function readCutTotals(db: Reader, siteId: string, workOrderId: string, hideIds: readonly string[]): Promise<Map<string, Decimal>> {
  const totals = new Map<string, Decimal>(hideIds.map((hideId) => [hideId, ZERO]))
  if (hideIds.length === 0) return totals
  const where = { siteId, workOrderId, hideId: { in: [...hideIds] } }
  const made = await db.cutLog.groupBy({ by: ['hideId'], where: { ...where, reversalOfId: null }, _sum: { baseAreaUsed: true } })
  const undone = await db.cutLog.groupBy({ by: ['hideId'], where: { ...where, reversalOfId: { not: null } }, _sum: { baseAreaUsed: true } })
  for (const row of made) totals.set(row.hideId, (totals.get(row.hideId) ?? ZERO).plus(dec(row._sum.baseAreaUsed)))
  for (const row of undone) totals.set(row.hideId, (totals.get(row.hideId) ?? ZERO).minus(dec(row._sum.baseAreaUsed)))
  return totals
}

/** What the work orders of the site hold of a hide, and what was cut of it for each (base unit). */
export async function readHideAtWorkOrders(db: Reader, siteId: string, hideId: string): Promise<Map<string, { at: Decimal; cut: Decimal }>> {
  const where = { siteId, hideId, workOrderId: { not: null }, reason: { in: ['ISSUE', 'RETURN'] as ('ISSUE' | 'RETURN')[] } }
  const out = await db.stockMove.groupBy({ by: ['workOrderId'], where: { ...where, fromLocationId: { not: null }, toLocationId: null }, _sum: { baseQuantity: true } })
  const back = await db.stockMove.groupBy({ by: ['workOrderId'], where: { ...where, fromLocationId: null, toLocationId: { not: null } }, _sum: { baseQuantity: true } })
  const made = await db.cutLog.groupBy({ by: ['workOrderId'], where: { siteId, hideId, reversalOfId: null }, _sum: { baseAreaUsed: true } })
  const undone = await db.cutLog.groupBy({ by: ['workOrderId'], where: { siteId, hideId, reversalOfId: { not: null } }, _sum: { baseAreaUsed: true } })
  const result = new Map<string, { at: Decimal; cut: Decimal }>()
  const of = (workOrderId: string) => result.get(workOrderId) ?? (result.set(workOrderId, { at: ZERO, cut: ZERO }), result.get(workOrderId)!)
  for (const row of out) if (row.workOrderId) of(row.workOrderId).at = of(row.workOrderId).at.plus(dec(row._sum.baseQuantity))
  for (const row of back) if (row.workOrderId) of(row.workOrderId).at = of(row.workOrderId).at.minus(dec(row._sum.baseQuantity))
  for (const row of made) of(row.workOrderId).cut = of(row.workOrderId).cut.plus(dec(row._sum.baseAreaUsed))
  for (const row of undone) of(row.workOrderId).cut = of(row.workOrderId).cut.minus(dec(row._sum.baseAreaUsed))
  return result
}

/** The hide's balances above 0 at the site's locations. */
export async function readHideOnHand(db: Reader, siteId: string, hideId: string): Promise<{ locationId: string; onHand: Decimal }[]> {
  const into = await db.stockMove.groupBy({ by: ['toLocationId'], where: { siteId, hideId, toLocationId: { not: null } }, _sum: { baseQuantity: true } })
  const outOf = await db.stockMove.groupBy({ by: ['fromLocationId'], where: { siteId, hideId, fromLocationId: { not: null } }, _sum: { baseQuantity: true } })
  const balances = new Map<string, Decimal>()
  for (const row of into) balances.set(row.toLocationId!, (balances.get(row.toLocationId!) ?? ZERO).plus(dec(row._sum.baseQuantity)))
  for (const row of outOf) balances.set(row.fromLocationId!, (balances.get(row.fromLocationId!) ?? ZERO).minus(dec(row._sum.baseQuantity)))
  return [...balances.entries()].filter(([, onHand]) => onHand.gt(0)).map(([locationId, onHand]) => ({ locationId, onHand }))
}

/** What else of the hide is anywhere, beside this work order: on hand at the site, and not yet cut at another work order. */
export async function readElsewhere(db: Reader, siteId: string, hideId: string, workOrderId: string): Promise<Decimal> {
  const onHand = (await readHideOnHand(db, siteId, hideId)).reduce((sum, row) => sum.plus(row.onHand), ZERO)
  let others = ZERO
  for (const [id, facts] of await readHideAtWorkOrders(db, siteId, hideId)) if (id !== workOrderId) others = others.plus(Dec.max(ZERO, facts.at.minus(facts.cut)))
  return onHand.plus(others)
}

export async function readLocations(db: Reader, locationIds: readonly string[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  return byId(locationIds.length === 0 ? [] : await db.location.findMany({ where: { id: { in: [...locationIds] } }, select: { id: true, code: true, name: true } }))
}

export async function readStations(db: Reader, stationIds: readonly string[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  return byId(stationIds.length === 0 ? [] : await db.station.findMany({ where: { id: { in: [...stationIds] } }, select: { id: true, code: true, name: true } }))
}

/** The device's station (a cutting table), if it has one. */
export async function deviceStationOf(db: Reader, deviceId: string): Promise<string | null> {
  const device = await db.device.findUnique({ where: { id: deviceId }, select: { stationId: true } })
  return device?.stationId ?? null
}

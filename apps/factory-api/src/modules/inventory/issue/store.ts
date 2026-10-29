import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { balancesFromSums, type Balance } from '@nexus/factory-domain/inventory/ledger/moves'
import type { AtWorkOrder, PickColour, PickHide, PickItem, PickLot, PickMaterial, PickStock } from '@nexus/factory-domain/inventory/issue/pick-list'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'

/**
 * The picking reads (B-W1-39): a work order as the pick list sees it, its planned materials (WorkOrderMaterial, one per
 * BOM line × cell), what the ledger says it holds (ISSUE and RETURN moves that name it), the site's stock per location,
 * lots, hides and what was cut of them. Every read names its columns (the floor reads Item without its standard cost,
 * and ProductionSettings never), selects no relation (inside a command's transaction the queries run one after another
 * on its one connection), and runs as the caller: row-level security keeps a floor device to its own site.
 */

export type Reader = FactoryClient | CommandTx

const dec = (value: { toString(): string } | null | undefined): Decimal => (value === null || value === undefined ? ZERO : new Dec(value.toString()))
const byId = <Row extends { id: string }>(rows: readonly Row[]): Map<string, Row> => new Map(rows.map((row) => [row.id, row]))
const ids = (values: Iterable<string | null | undefined>): string[] => [...new Set([...values].filter((value): value is string => typeof value === 'string'))]

export const PICK_HEADER = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  batchNumber: true,
  status: true,
  styleId: true,
  dueDate: true,
  priority: true,
  startedAt: true,
  version: true,
} as const satisfies Prisma.WorkOrderSelect
export type PickHeader = Prisma.WorkOrderGetPayload<{ select: typeof PICK_HEADER }>

export async function readPickHeader(db: Reader, workOrderId: string): Promise<PickHeader | null> {
  if (!isUuid(workOrderId)) return null
  return db.workOrder.findUnique({ where: { id: workOrderId }, select: PICK_HEADER })
}

/**
 * The work order's issue lock (a transaction advisory lock): issues, returns, undos and reversals of one work order take
 * turns, so what it still needs is read and used by one of them at a time. Taken first, before the hide-cut and stock
 * locks (the same order everywhere: no deadlock).
 */
export async function lockWorkOrderIssues(tx: CommandTx, tenantId: string, workOrderId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.work-order-issue', ${tenantId}::uuid, ${workOrderId}::uuid), 0))`
}

/** The …_production_guards trigger's own lock per hide (CutLog): a return or reversal of a hide waits for its cuts. */
export async function lockHideCuts(tx: CommandTx, tenantId: string, siteId: string, hideId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.hide-cut', ${tenantId}::uuid, ${siteId}::uuid, ${hideId}::uuid), 0))`
}

export const STYLE_COLUMNS = { id: true, code: true, name: true, sizes: true } as const satisfies Prisma.StyleSelect
export type StyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_COLUMNS }>

/** The planned materials with their BOM line's place and their cell (colourway, size, order). */
export async function readPickMaterials(db: Reader, workOrderId: string, style: StyleRow): Promise<PickMaterial[]> {
  const rows = await db.workOrderMaterial.findMany({
    where: { workOrderId },
    select: { id: true, bomLineId: true, itemId: true, itemColourId: true, workOrderSizeId: true, baseQuantity: true },
  })
  if (rows.length === 0) return []
  const lines = byId(await db.bomLine.findMany({ where: { id: { in: ids(rows.map((row) => row.bomLineId)) } }, select: { id: true, seq: true, placement: true } }))
  const cells = await db.workOrderSize.findMany({ where: { workOrderId }, select: { id: true, colourwayId: true, size: true } })
  const colourways = byId(await db.colourway.findMany({ where: { id: { in: ids(cells.map((cell) => cell.colourwayId)) } }, select: { id: true, code: true } }))
  const sizeOrder = (size: string) => {
    const index = style.sizes.indexOf(size)
    return index < 0 ? style.sizes.length : index
  }
  const ordered = [...cells].sort((a, b) => {
    const ca = colourways.get(a.colourwayId)?.code ?? ''
    const cb = colourways.get(b.colourwayId)?.code ?? ''
    return ca < cb ? -1 : ca > cb ? 1 : sizeOrder(a.size) - sizeOrder(b.size)
  })
  const cellOf = new Map(ordered.map((cell, index) => [cell.id, { order: index, colourwayCode: colourways.get(cell.colourwayId)?.code ?? '', size: cell.size }]))
  return rows.map((row) => {
    const cell = cellOf.get(row.workOrderSizeId)
    const line = lines.get(row.bomLineId)
    return {
      id: row.id,
      bomLineId: row.bomLineId,
      bomSeq: line?.seq ?? 0,
      placement: line?.placement ?? null,
      itemId: row.itemId,
      itemColourId: row.itemColourId,
      workOrderSizeId: row.workOrderSizeId,
      cellOrder: cell?.order ?? 0,
      colourwayCode: cell?.colourwayCode ?? '',
      size: cell?.size ?? '',
      baseQuantity: row.baseQuantity.toString(),
    }
  })
}

/** What the work order holds per stock key: moves out of a location naming it, less moves into one (returns, reversals). */
export async function readAtWorkOrder(db: Reader, siteId: string, workOrderId: string, where: Prisma.StockMoveWhereInput = {}): Promise<AtWorkOrder[]> {
  const by = ['itemId', 'itemColourId', 'lotId', 'hideId'] as const
  const base = { ...where, siteId, workOrderId }
  const out = await db.stockMove.groupBy({ by: [...by], where: { ...base, fromLocationId: { not: null }, toLocationId: null }, _sum: { baseQuantity: true } })
  const back = await db.stockMove.groupBy({ by: [...by], where: { ...base, fromLocationId: null, toLocationId: { not: null } }, _sum: { baseQuantity: true } })
  const net = new Map<string, { itemId: string; itemColourId: string | null; lotId: string | null; hideId: string | null; quantity: Decimal }>()
  const add = (row: (typeof out)[number], sign: 1 | -1) => {
    const key = [row.itemId, row.itemColourId ?? '-', row.lotId ?? '-', row.hideId ?? '-'].join('|')
    const entry = net.get(key) ?? { itemId: row.itemId, itemColourId: row.itemColourId, lotId: row.lotId, hideId: row.hideId, quantity: ZERO }
    entry.quantity = entry.quantity.plus(sign === 1 ? dec(row._sum.baseQuantity) : dec(row._sum.baseQuantity).negated())
    net.set(key, entry)
  }
  for (const row of out) add(row, 1)
  for (const row of back) add(row, -1)
  return [...net.values()].map((entry) => ({ ...entry, quantity: entry.quantity.toFixed(4) }))
}

/** What was cut of these hides for the work order (its cut log, net of reversals), per hide. */
export async function readCuts(db: Reader, siteId: string, workOrderId: string, hideIds: readonly string[]): Promise<Map<string, string>> {
  const cuts = new Map<string, string>()
  if (hideIds.length === 0) return cuts
  const where = { siteId, workOrderId, hideId: { in: [...hideIds] } }
  const made = await db.cutLog.groupBy({ by: ['hideId'], where: { ...where, reversalOfId: null }, _sum: { baseAreaUsed: true } })
  const undone = await db.cutLog.groupBy({ by: ['hideId'], where: { ...where, reversalOfId: { not: null } }, _sum: { baseAreaUsed: true } })
  for (const row of made) cuts.set(row.hideId, dec(row._sum.baseAreaUsed).toFixed(4))
  for (const row of undone) cuts.set(row.hideId, dec(cuts.get(row.hideId)).minus(dec(row._sum.baseAreaUsed)).toFixed(4))
  return cuts
}

/** The site's balances above 0 of these items (or of one stock key), per location. */
export async function readSiteStock(
  db: Reader,
  siteId: string,
  filter: { readonly itemIds: readonly string[]; readonly itemColourId?: string | null; readonly lotId?: string | null; readonly hideId?: string | null },
): Promise<Balance[]> {
  if (filter.itemIds.length === 0) return []
  const where: Prisma.StockMoveWhereInput = {
    siteId,
    itemId: { in: [...filter.itemIds] },
    ...(filter.itemColourId !== undefined ? { itemColourId: filter.itemColourId } : {}),
    ...(filter.lotId !== undefined ? { lotId: filter.lotId } : {}),
    ...(filter.hideId !== undefined ? { hideId: filter.hideId } : {}),
  }
  const by = ['siteId', 'itemId', 'itemColourId', 'lotId', 'hideId'] as const
  const into = await db.stockMove.groupBy({ by: ['toLocationId', ...by], where: { ...where, toLocationId: { not: null } }, _sum: { baseQuantity: true } })
  const outOf = await db.stockMove.groupBy({ by: ['fromLocationId', ...by], where: { ...where, fromLocationId: { not: null } }, _sum: { baseQuantity: true } })
  const sum = (row: { siteId: string; itemId: string; itemColourId: string | null; lotId: string | null; hideId: string | null; _sum: { baseQuantity: Prisma.Decimal | null } }, locationId: string) => ({
    siteId: row.siteId,
    itemId: row.itemId,
    itemColourId: row.itemColourId,
    lotId: row.lotId,
    hideId: row.hideId,
    locationId,
    quantity: dec(row._sum.baseQuantity).toString(),
  })
  return balancesFromSums(
    into.map((row) => sum(row, row.toLocationId!)),
    outOf.map((row) => sum(row, row.fromLocationId!)),
  ).filter((balance) => balance.onHand.gt(0))
}

export const ITEM_COLUMNS = { id: true, code: true, name: true, baseUom: true, tracking: true, purchaseUom: true, purchaseFactor: true, consumptionUom: true, consumptionFactor: true } as const satisfies Prisma.ItemSelect
export type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_COLUMNS }>

export const itemUnitsOf = (item: ItemRow) => ({
  baseUom: item.baseUom,
  purchaseUom: item.purchaseUom,
  purchaseFactor: item.purchaseFactor.toString(),
  consumptionUom: item.consumptionUom,
  consumptionFactor: item.consumptionFactor.toString(),
})

export async function readItems(db: Reader, itemIds: readonly string[]): Promise<Map<string, ItemRow>> {
  return byId(itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: [...itemIds] } }, select: ITEM_COLUMNS }))
}

export const LOT_COLUMNS = {
  id: true,
  siteId: true,
  itemId: true,
  itemColourId: true,
  code: true,
  qualityStatus: true,
  requiresCrViTest: true,
  crViStatus: true,
  receivedAt: true,
  dyeBatch: true,
} as const satisfies Prisma.LotSelect
export type LotRow = Prisma.LotGetPayload<{ select: typeof LOT_COLUMNS }>

export async function readLots(db: Reader, lotIds: readonly string[]): Promise<Map<string, LotRow>> {
  return byId(lotIds.length === 0 ? [] : await db.lot.findMany({ where: { id: { in: [...lotIds] } }, select: LOT_COLUMNS }))
}

export const pickLotOf = (lot: LotRow): PickLot => ({
  id: lot.id,
  code: lot.code,
  qualityStatus: lot.qualityStatus,
  requiresCrViTest: lot.requiresCrViTest,
  crViStatus: lot.crViStatus,
  receivedAt: lot.receivedAt ? toUtcIso(lot.receivedAt) : null,
  dyeBatch: lot.dyeBatch,
})

export const HIDE_COLUMNS = { id: true, siteId: true, lotId: true, itemId: true, code: true, state: true, grade: true, version: true } as const satisfies Prisma.HideSelect
export type HideRow = Prisma.HideGetPayload<{ select: typeof HIDE_COLUMNS }>

export async function readHides(db: Reader, hideIds: readonly string[]): Promise<Map<string, HideRow>> {
  return byId(hideIds.length === 0 ? [] : await db.hide.findMany({ where: { id: { in: [...hideIds] } }, select: HIDE_COLUMNS }))
}

export const pickHideOf = (hide: HideRow): PickHide => ({ id: hide.id, code: hide.code, state: hide.state, grade: hide.grade })

export async function readColours(db: Reader, colourIds: readonly string[]): Promise<Map<string, PickColour>> {
  return byId(colourIds.length === 0 ? [] : await db.itemColour.findMany({ where: { id: { in: [...colourIds] } }, select: { id: true, code: true, name: true } }))
}

export async function readLocations(db: Reader, locationIds: readonly string[]): Promise<Map<string, { id: string; code: string; name: string; siteId: string; status: string }>> {
  return byId(locationIds.length === 0 ? [] : await db.location.findMany({ where: { id: { in: [...locationIds] } }, select: { id: true, code: true, name: true, siteId: true, status: true } }))
}

export const pickItemOf = (item: ItemRow): PickItem => ({ id: item.id, code: item.code, name: item.name, baseUom: item.baseUom, tracking: item.tracking })

/** The balances as the pick list reads them, with each location's code. */
export function pickStockOf(balances: readonly Balance[], locations: ReadonlyMap<string, { code: string }>): PickStock[] {
  return balances.map((balance) => ({
    locationId: balance.locationId,
    locationCode: locations.get(balance.locationId)?.code ?? '',
    itemId: balance.itemId,
    itemColourId: balance.itemColourId,
    lotId: balance.lotId,
    hideId: balance.hideId,
    onHand: balance.onHand.toFixed(4),
  }))
}

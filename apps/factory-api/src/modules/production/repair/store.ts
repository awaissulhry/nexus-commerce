import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { CommandTx } from '../../../core/command'

/**
 * The repair station's and second quality's reads and locks (B-W2b-126; MES-132, MES-133): a rework with its repair
 * columns, its row lock, the rows its views name (work order, cell, bundle, operations, stations), the downgrades and their
 * stock moves. Every read names its columns, selects no relation and runs as the caller (a floor device: its own site, by
 * row-level security).
 */

export type Reader = FactoryClient | CommandTx

export const REPAIR_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  workOrderId: true,
  workOrderSizeId: true,
  bundleId: true,
  sourceScanId: true,
  foundAtOperationId: true,
  reworkAtOperationId: true,
  quantity: true,
  reasonCode: true,
  description: true,
  status: true,
  goodQuantity: true,
  scrapQuantity: true,
  startedAt: true,
  doneAt: true,
  repairInAt: true,
  repairStationId: true,
  repairOutAt: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.ReworkOrderSelect
export type RepairRow = Prisma.ReworkOrderGetPayload<{ select: typeof REPAIR_COLUMNS }>

export async function readRepair(db: Reader, reworkId: string): Promise<RepairRow | null> {
  if (!isUuid(reworkId)) return null
  return db.reworkOrder.findUnique({ where: { id: reworkId }, select: REPAIR_COLUMNS })
}

/** The rework row locked FOR UPDATE inside a scan's command, then read again. */
export async function lockRepair(tx: CommandTx, reworkId: string): Promise<RepairRow | null> {
  if (!isUuid(reworkId)) return null
  await tx.$queryRaw`SELECT "id" FROM "ReworkOrder" WHERE "id" = ${reworkId}::uuid FOR UPDATE`
  return readRepair(tx, reworkId)
}

/** The work order as the repair reads it. */
export async function readOrder(db: Reader, workOrderId: string) {
  if (!isUuid(workOrderId)) return null
  return db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, companyId: true, siteId: true, number: true, status: true, holdReason: true, styleId: true, dueDate: true, rush: true } })
}

/** The device's station with its work centre (null: a tablet of no station). */
export async function deviceStationOf(db: Reader, deviceId: string): Promise<{ readonly id: string; readonly code: string; readonly name: string; readonly workCentreId: string } | null> {
  const device = await db.device.findUnique({ where: { id: deviceId }, select: { stationId: true } })
  if (!device?.stationId) return null
  return db.station.findUnique({ where: { id: device.stationId }, select: { id: true, code: true, name: true, workCentreId: true } })
}

const unique = (values: readonly (string | null | undefined)[]) => [...new Set(values.filter((value): value is string => typeof value === 'string'))]

/** The rows a list of repairs names: work orders with their style, cells, bundles, operations (with their work centre), stations, reasons. */
export async function repairFacts(db: Reader, rows: readonly RepairRow[]) {
  const orders = new Map(
    (await db.workOrder.findMany({ where: { id: { in: unique(rows.map((row) => row.workOrderId)) } }, select: { id: true, number: true, status: true, holdReason: true, dueDate: true, rush: true, styleId: true } })).map((row) => [row.id, row]),
  )
  const styles = new Map((await db.style.findMany({ where: { id: { in: unique([...orders.values()].map((order) => order.styleId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const cells = await db.workOrderSize.findMany({ where: { id: { in: unique(rows.map((row) => row.workOrderSizeId)) } }, select: { id: true, colourwayId: true, size: true } })
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: unique(cells.map((cell) => cell.colourwayId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const cellOf = new Map(cells.map((cell) => [cell.id, { id: cell.id, colourwayCode: colourways.get(cell.colourwayId) ?? '', size: cell.size }]))
  const bundles = new Map((await db.bundle.findMany({ where: { id: { in: unique(rows.map((row) => row.bundleId)) } }, select: { id: true, code: true, part: true } })).map((row) => [row.id, row]))
  const operations = new Map(
    (await db.workOrderOperation.findMany({ where: { id: { in: unique(rows.flatMap((row) => [row.foundAtOperationId, row.reworkAtOperationId])) } }, select: { id: true, seq: true, code: true, name: true, workCentreId: true } })).map((row) => [row.id, row]),
  )
  const stations = new Map((await db.station.findMany({ where: { id: { in: unique(rows.map((row) => row.repairStationId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const reasons = new Map((await db.scrapReason.findMany({ where: { kind: 'REWORK' }, select: { code: true, labelIt: true, labelEn: true } })).map((row) => [row.code, row]))
  return { orders, styles, cellOf, bundles, operations, stations, reasons }
}

// ---- second quality ------------------------------------------------------------------------------------------------------------

export const DOWNGRADE_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  workOrderId: true,
  workOrderSizeId: true,
  bundleId: true,
  reworkOrderId: true,
  sourceScanId: true,
  quantity: true,
  reasonCode: true,
  note: true,
  secondQualityItemId: true,
  variantId: true,
  voidedAt: true,
  voidedById: true,
  voidReason: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.GarmentDowngradeSelect
export type DowngradeRow = Prisma.GarmentDowngradeGetPayload<{ select: typeof DOWNGRADE_COLUMNS }>

export async function readDowngrade(db: Reader, downgradeId: string): Promise<DowngradeRow | null> {
  if (!isUuid(downgradeId)) return null
  return db.garmentDowngrade.findUnique({ where: { id: downgradeId }, select: DOWNGRADE_COLUMNS })
}

export async function lockDowngrade(tx: CommandTx, downgradeId: string): Promise<DowngradeRow | null> {
  if (!isUuid(downgradeId)) return null
  await tx.$queryRaw`SELECT "id" FROM "GarmentDowngrade" WHERE "id" = ${downgradeId}::uuid FOR UPDATE`
  return readDowngrade(tx, downgradeId)
}

/** The downgrades of a scan's scrap or a rework's scrap (any state: the reader leaves the withdrawn ones out). */
export async function downgradesOfSource(db: Reader, source: { readonly sourceScanId?: string | null; readonly reworkOrderId?: string | null }) {
  if (source.sourceScanId) return db.garmentDowngrade.findMany({ where: { sourceScanId: source.sourceScanId }, select: { sourceScanId: true, reworkOrderId: true, quantity: true, voidedAt: true } })
  if (source.reworkOrderId) return db.garmentDowngrade.findMany({ where: { reworkOrderId: source.reworkOrderId, sourceScanId: null }, select: { sourceScanId: true, reworkOrderId: true, quantity: true, voidedAt: true } })
  return []
}

/** The stock moves of downgrades, by their keys (`production.downgrade:<id>:1` and `…:withdraw`). */
export async function downgradeMoves(db: Reader, downgradeIds: readonly string[]) {
  if (downgradeIds.length === 0) return []
  return db.stockMove.findMany({
    where: { OR: downgradeIds.map((id) => ({ idempotencyKey: { startsWith: `production.downgrade:${id}:` } })) },
    select: { id: true, idempotencyKey: true, itemId: true, toLocationId: true, fromLocationId: true, quantity: true, uom: true, baseQuantity: true, reversalOfId: true, siteId: true, workOrderId: true, reference: true, lotId: true, hideId: true, itemColourId: true },
  })
}

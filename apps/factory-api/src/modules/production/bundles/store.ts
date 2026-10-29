import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { SCAN_TYPES } from '@nexus/factory-domain/numbering/scan-id'
import { scannedBundleRefusal, type BundleRefusal } from '@nexus/factory-domain/production/bundles/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The bundles' reads and locks (B-W1-41): a work order as the bundles see it, its operations, its bundles, a bundle by
 * its ticket's code (the current one or a replaced one), the scans that name bundles, the tenant's highest ticket code,
 * and the advisory locks of a cell's bundles and of the tenant's ticket codes. Every read names its columns, selects no
 * relation (inside a command's transaction the queries run one after another on its one connection) and runs as the
 * caller: row-level security keeps a floor device to its own site.
 */

export type Reader = FactoryClient | CommandTx

export const BUNDLE_HEADER = {
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
} as const satisfies Prisma.WorkOrderSelect
export type BundleHeader = Prisma.WorkOrderGetPayload<{ select: typeof BUNDLE_HEADER }>

export async function readHeader(db: Reader, workOrderId: string): Promise<BundleHeader | null> {
  if (!isUuid(workOrderId)) return null
  return db.workOrder.findUnique({ where: { id: workOrderId }, select: BUNDLE_HEADER })
}

export const BUNDLE_COLUMNS = {
  id: true,
  siteId: true,
  workOrderId: true,
  workOrderSizeId: true,
  code: true,
  replacedCodes: true,
  quantity: true,
  part: true,
  cutLogIds: true,
  status: true,
  voidedAt: true,
  voidReason: true,
  deviceId: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.BundleSelect
export type BundleRow = Prisma.BundleGetPayload<{ select: typeof BUNDLE_COLUMNS }>

/** The work order's bundles (ACTIVE and VOID), oldest first. */
export async function readBundles(db: Reader, workOrderId: string): Promise<BundleRow[]> {
  return db.bundle.findMany({ where: { workOrderId }, select: BUNDLE_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
}

export async function readBundle(db: Reader, bundleId: string): Promise<BundleRow | null> {
  if (!isUuid(bundleId)) return null
  return db.bundle.findUnique({ where: { id: bundleId }, select: BUNDLE_COLUMNS })
}

/**
 * The bundle row locked FOR UPDATE inside a reprint's or void's command, before its state is read: two writes to one
 * bundle take turns, and a scan that locked it FOR SHARE first (lockBundleForScan) is waited for.
 */
export async function lockBundle(tx: CommandTx, bundleId: string): Promise<BundleRow | null> {
  if (!isUuid(bundleId)) return null
  await tx.$queryRaw`SELECT "id" FROM "Bundle" WHERE "id" = ${bundleId}::uuid FOR UPDATE`
  return readBundle(tx, bundleId)
}

/** The bundle a ticket's code names: its current code, or one of its replaced ones (an old ticket). */
export async function readBundleByCode(db: Reader, code: string): Promise<BundleRow | null> {
  return (await db.bundle.findFirst({ where: { code }, select: BUNDLE_COLUMNS })) ?? db.bundle.findFirst({ where: { replacedCodes: { has: code } }, select: BUNDLE_COLUMNS })
}

export interface CellLabel {
  readonly id: string
  readonly colourwayId: string
  readonly colourwayCode: string
  readonly colourwayName: string
  readonly size: string
  readonly quantity: number
}

/** The work order's cells with their colourway's code and name. */
export async function readCellLabels(db: Reader, workOrderId: string): Promise<Map<string, CellLabel>> {
  const cells = await db.workOrderSize.findMany({ where: { workOrderId }, select: { id: true, colourwayId: true, size: true, quantity: true } })
  const colourways = new Map(
    (await db.colourway.findMany({ where: { id: { in: [...new Set(cells.map((cell) => cell.colourwayId))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]),
  )
  return new Map(
    cells.map((cell) => [cell.id, { id: cell.id, colourwayId: cell.colourwayId, colourwayCode: colourways.get(cell.colourwayId)?.code ?? '', colourwayName: colourways.get(cell.colourwayId)?.name ?? '', size: cell.size, quantity: cell.quantity }]),
  )
}

/** The station of the floor device (null: a roaming tablet). */
export async function deviceStationOf(db: Reader, deviceId: string): Promise<string | null> {
  const device = await db.device.findUnique({ where: { id: deviceId }, select: { stationId: true } })
  return device?.stationId ?? null
}

/** The work order's operations in routing order (the ticket's list, the scan card's ticks). */
export async function readOperations(db: Reader, workOrderId: string) {
  return db.workOrderOperation.findMany({ where: { workOrderId }, select: { id: true, seq: true, code: true, name: true, scanRequired: true }, orderBy: { seq: 'asc' } })
}

/** The scans that name these bundles, oldest first (any kind: an undone report is still a scan of the bundle). */
export async function readScans(db: Reader, bundleIds: readonly string[]) {
  if (bundleIds.length === 0) return []
  return db.operationScan.findMany({
    where: { bundleId: { in: [...bundleIds] } },
    select: { id: true, bundleId: true, workOrderOperationId: true, kind: true, correctsId: true, stationId: true, serverTime: true },
    orderBy: [{ serverTime: 'asc' }, { id: 'asc' }],
  })
}
export type ScanRow = Awaited<ReturnType<typeof readScans>>[number]

/** How many scans name the bundle. */
export async function countScans(db: Reader, bundleId: string): Promise<number> {
  return db.operationScan.count({ where: { bundleId } })
}

/** The print jobs of these bundles' tickets, newest first. */
export async function readTicketJobs(db: Reader, bundleIds: readonly string[]) {
  if (bundleIds.length === 0) return []
  return db.printJob.findMany({
    where: { recordType: 'Bundle', recordId: { in: [...bundleIds] } },
    select: { id: true, recordId: true, printerId: true, scanId: true, status: true, lastError: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  })
}

// ---- locks ---------------------------------------------------------------------------------------------------------------------

/**
 * The cells' bundle locks, in id order: one request at a time reads a cell's bundles and makes new ones, so two tablets
 * never bundle the same garments twice. Taken after the work order's issue lock (B-W1-39/40: a cut's undo or correction,
 * and the work order's complete, close and cancel, take that one first).
 */
export async function lockCells(tx: CommandTx, tenantId: string, siteId: string, cellIds: readonly string[]): Promise<void> {
  for (const cellId of [...new Set(cellIds)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.bundle-cell', ${tenantId}::uuid, ${siteId}::uuid, ${cellId}::uuid), 0))`
  }
}

/** The tenant's ticket-code lock: the next codes (after the highest one) are read and taken by one write at a time. Taken last. */
export async function lockBundleCodes(tx: CommandTx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.bundle-code', ${tenantId}::uuid), 0))`
}

/**
 * The highest ticket code the reader sees among the tenant's BUNDLE codes (`BN-<tag>-…`), or null. A ticket's code is
 * never reused: the highest reference ever given is always some bundle's current code (a reprint takes a higher one,
 * and a void bundle keeps its code), so the current codes are enough. The office and the tenant's system context see
 * every site's bundles; a floor device sees its own site's only (see codes.ts).
 */
export async function highestBundleCode(db: Reader, tag: string): Promise<string | null> {
  const prefix = `${SCAN_TYPES.BUNDLE}-${tag}-%`
  const [row] = await db.$queryRaw<{ code: string }[]>`SELECT "code" FROM "Bundle" WHERE "code" LIKE ${prefix} ORDER BY length("code") DESC, "code" DESC LIMIT 1`
  return row?.code ?? null
}

// ---- the scan's lock (B-W1-42) -------------------------------------------------------------------------------------------------

export interface ScannedBundle {
  readonly bundle: { readonly id: string; readonly code: string; readonly status: 'ACTIVE' | 'VOID'; readonly quantity: number; readonly replacedCodes: string[]; readonly workOrderId: string; readonly siteId: string }
  /** Why a scan of `scanned` may not take it (REPLACED, VOIDED), or null. */
  readonly refusal: BundleRefusal | null
}

/**
 * For B-W1-42's scan command, INSIDE its transaction and before it inserts the OperationScan: the bundle row locked FOR
 * SHARE and its status read again. A void (this module) updates the row, so a scan and a void of one bundle take turns:
 * a scan that locks first is seen by the void (refused: SCANNED); a void that commits first is seen here (VOIDED). The
 * …_production_guards scan trigger reads the bundle without a row lock, so this lock is the API's part of the rule
 * "a bundle is voided only before any scan names it". `scanned`: the code the device read (an old ticket is REPLACED).
 * Null: no such bundle the caller may see.
 */
export async function lockBundleForScan(tx: CommandTx, bundleId: string, scanned?: string): Promise<ScannedBundle | null> {
  if (!isUuid(bundleId)) return null
  const [row] = await tx.$queryRaw<ScannedBundle['bundle'][]>`
    SELECT "id", "code", "status"::text AS "status", "quantity", "replacedCodes", "workOrderId", "siteId"
      FROM "Bundle" WHERE "id" = ${bundleId}::uuid FOR SHARE`
  if (!row) return null
  return { bundle: row, refusal: scannedBundleRefusal(row, scanned ?? row.code) }
}

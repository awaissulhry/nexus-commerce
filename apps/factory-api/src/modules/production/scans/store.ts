import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { WorkCentreKind } from '@nexus/factory-domain/product/routing/operations'
import type { ScanFact, ScanOperation } from '@nexus/factory-domain/production/scans/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The operation scans' reads and locks (B-W1-42): a work order as the scans see it, its frozen operations with their
 * work centre's kind, the scans of a bundle or a work order, a device's scan by its client scan id, a device's newest
 * scan, stations and their lines, and the locks a scan write takes. Every read names its columns (a floor read of a
 * Worker never asks for its hidden userId), selects no relation (inside a command's transaction the queries run one
 * after another on its one connection) and runs as the caller: row-level security keeps a floor device to its own site.
 *
 * Lock order of every scan write (no deadlock): the work order's issue lock in SHARED mode (scanWorkOrderLock: scans of
 * one work order run side by side, but wait for an issue, a cut, a bundle make or a status move of it in flight, and
 * such a move waits for them) → the bundle's row FOR SHARE (bundles' lockBundleForScan: a void waits, and is refused)
 * → the bundle's scan lock (lockBundleScans: one scan write per bundle at a time, so the caps read under it hold) →
 * the trigger's own lock per bundle and operation.
 */

export type Reader = FactoryClient | CommandTx

export const SCAN_HEADER = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  batchNumber: true,
  status: true,
  kind: true,
  styleId: true,
} as const satisfies Prisma.WorkOrderSelect
export type ScanHeader = Prisma.WorkOrderGetPayload<{ select: typeof SCAN_HEADER }>

export async function readHeader(db: Reader, workOrderId: string): Promise<ScanHeader | null> {
  if (!isUuid(workOrderId)) return null
  return db.workOrder.findUnique({ where: { id: workOrderId }, select: SCAN_HEADER })
}

/** The site's time zone (its wall clock for the floor's words). */
export async function siteTimeZone(db: Reader, siteId: string): Promise<string> {
  return (await db.site.findUnique({ where: { id: siteId }, select: { timezone: true } }))?.timezone ?? 'Europe/Rome'
}

export interface OperationRow extends ScanOperation {
  readonly workCentreId: string
}

/** The work order's frozen operations in routing order, each with its work centre's kind. */
export async function readOperations(db: Reader, workOrderId: string): Promise<OperationRow[]> {
  const rows = await db.workOrderOperation.findMany({ where: { workOrderId }, select: { id: true, seq: true, code: true, name: true, scanRequired: true, workCentreId: true }, orderBy: { seq: 'asc' } })
  const centres = new Map((await db.workCentre.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.workCentreId))] } }, select: { id: true, kind: true } })).map((row) => [row.id, row.kind as WorkCentreKind]))
  return rows.map((row) => ({ ...row, workCentreKind: centres.get(row.workCentreId) ?? 'SEWING' }))
}

export const SCAN_COLUMNS = {
  id: true,
  siteId: true,
  workOrderId: true,
  workOrderOperationId: true,
  bundleId: true,
  kind: true,
  correctsId: true,
  goodQuantity: true,
  scrapQuantity: true,
  reworkQuantity: true,
  scrapReason: true,
  reason: true,
  approvedById: true,
  workerId: true,
  stationId: true,
  deviceId: true,
  clientScanId: true,
  deviceTime: true,
  serverTime: true,
  createdById: true,
  // B-W2b-10: an outside operation's REPORT names the subcontract receipt line that brought the bundle back.
  subcontractReceiptLineId: true,
} as const satisfies Prisma.OperationScanSelect
export type ScanRow = Prisma.OperationScanGetPayload<{ select: typeof SCAN_COLUMNS }> & ScanFact

const ORDER = [{ serverTime: 'asc' }, { id: 'asc' }] as const satisfies Prisma.OperationScanOrderByWithRelationInput[]

/** Every scan of the bundle, oldest first. */
export async function readBundleScans(db: Reader, bundleId: string): Promise<ScanRow[]> {
  return (await db.operationScan.findMany({ where: { bundleId }, select: SCAN_COLUMNS, orderBy: [...ORDER] })) as ScanRow[]
}

/** Every scan of the work order, oldest first. */
export async function readWorkOrderScans(db: Reader, workOrderId: string): Promise<ScanRow[]> {
  return (await db.operationScan.findMany({ where: { workOrderId }, select: SCAN_COLUMNS, orderBy: [...ORDER] })) as ScanRow[]
}

export async function readScan(db: Reader, scanId: string): Promise<ScanRow | null> {
  if (!isUuid(scanId)) return null
  return (await db.operationScan.findUnique({ where: { id: scanId }, select: SCAN_COLUMNS })) as ScanRow | null
}

/** The scan a device recorded under its client scan id (the unique key), or null. */
export async function readScanByClient(db: Reader, deviceId: string, clientScanId: string): Promise<ScanRow | null> {
  return (await db.operationScan.findFirst({ where: { deviceId, clientScanId }, select: SCAN_COLUMNS })) as ScanRow | null
}

/** The newest scan the device wrote (by server time, then id), or null: "the next action" ends an undo. */
export async function latestOnDevice(db: Reader, deviceId: string): Promise<string | null> {
  const row = await db.operationScan.findFirst({ where: { deviceId }, select: { id: true }, orderBy: [{ serverTime: 'desc' }, { id: 'desc' }] })
  return row?.id ?? null
}

/** The scans of these workers (WORKER site) or this station (STATION site) since an instant, newest first. */
export async function readOwnScans(db: Reader, where: { readonly siteId: string; readonly workerId?: string; readonly stationId?: string; readonly since: Date }, take = 100): Promise<ScanRow[]> {
  const subject = where.workerId ? { workerId: where.workerId } : { stationId: where.stationId!, workerId: null }
  return (await db.operationScan.findMany({ where: { siteId: where.siteId, ...subject, serverTime: { gte: where.since } }, select: SCAN_COLUMNS, orderBy: [{ serverTime: 'desc' }, { id: 'desc' }], take })) as ScanRow[]
}

export interface StationRow {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly lineId: string | null
  readonly kind: WorkCentreKind
}

/** Stations by id, with their work centre's kind and line. */
export async function readStations(db: Reader, stationIds: readonly (string | null)[]): Promise<Map<string, StationRow>> {
  const ids = [...new Set(stationIds.filter((value): value is string => value !== null))]
  if (ids.length === 0) return new Map()
  const stations = await db.station.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, lineId: true, workCentreId: true } })
  const kinds = new Map((await db.workCentre.findMany({ where: { id: { in: [...new Set(stations.map((row) => row.workCentreId))] } }, select: { id: true, kind: true } })).map((row) => [row.id, row.kind as WorkCentreKind]))
  return new Map(stations.map((row) => [row.id, { id: row.id, code: row.code, name: row.name, lineId: row.lineId, kind: kinds.get(row.workCentreId) ?? 'SEWING' }]))
}

/** The lines of a site, by id. */
export async function readLines(db: Reader, siteId: string): Promise<Map<string, { id: string; code: string; name: string }>> {
  return new Map((await db.line.findMany({ where: { siteId }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
}

/** The station of the floor device (null: a tablet that moves around the site). */
export async function deviceStationOf(db: Reader, deviceId: string): Promise<string | null> {
  const device = await db.device.findUnique({ where: { id: deviceId }, select: { stationId: true } })
  return device?.stationId ?? null
}

/** Workers' display names (office reads: inside one record only). */
export async function workerNames(db: Reader, workerIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(workerIds.filter((value): value is string => value !== null))]
  if (ids.length === 0) return new Map()
  return new Map((await db.worker.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

/** The office users these workers also are (Worker.userId; office reads only: the floor role cannot see the column). */
export async function workerUsers(db: Reader, workerIds: readonly (string | null)[]): Promise<Set<string>> {
  const ids = [...new Set(workerIds.filter((value): value is string => value !== null))]
  if (ids.length === 0) return new Set()
  return new Set((await db.worker.findMany({ where: { id: { in: ids } }, select: { userId: true } })).flatMap((row) => (row.userId ? [row.userId] : [])))
}

/** The bundles of a work order (ACTIVE and VOID) with their cell and part. */
export async function readWorkOrderBundles(db: Reader, workOrderId: string) {
  return db.bundle.findMany({ where: { workOrderId }, select: { id: true, code: true, workOrderSizeId: true, part: true, quantity: true, status: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
}

/** The work order's cells with their colourway code. */
export async function readCells(db: Reader, workOrderId: string) {
  const cells = await db.workOrderSize.findMany({ where: { workOrderId }, select: { id: true, colourwayId: true, size: true, quantity: true }, orderBy: [{ colourwayId: 'asc' }, { size: 'asc' }] })
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(cells.map((cell) => cell.colourwayId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  return cells.map((cell) => ({ id: cell.id, colourwayCode: colourways.get(cell.colourwayId) ?? '', size: cell.size, quantity: cell.quantity }))
}

// ---- locks ---------------------------------------------------------------------------------------------------------------------

/**
 * The work order's issue lock (modules/inventory/issue lockWorkOrderIssues' key) taken in SHARED mode: scans of one work
 * order do not wait for each other, but a complete, close or cancel of it (and an issue, cut or bundle make, which take
 * it exclusively) waits for the scans in flight, and they for it: no scan lands on a work order that moved on.
 */
export async function scanWorkOrderLock(tx: CommandTx, tenantId: string, workOrderId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(concat_ws('|', 'factory.work-order-issue', ${tenantId}::uuid, ${workOrderId}::uuid), 0))`
}

/** One scan write (report, undo, correction) per bundle at a time: what its operations passed is read and used by one of them. */
export async function lockBundleScans(tx: CommandTx, tenantId: string, siteId: string, bundleId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.scan-bundle', ${tenantId}::uuid, ${siteId}::uuid, ${bundleId}::uuid), 0))`
}

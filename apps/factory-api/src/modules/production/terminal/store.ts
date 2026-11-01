import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { TERMINAL_LIMITS, type TimingRow } from '@nexus/factory-domain/production/terminal/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The timing rows' reads (B-W2b-40): every OperationScan row of a bundle at an operation (any kind: a REPORT closes a
 * stretch too), the open work of a person or a station, the members a team's scans name, the workers' employees. Every
 * read names its columns, selects no relation (inside a command's transaction the queries run one after another on its
 * one connection) and runs as the caller: row-level security keeps a floor device to its own site. The locks are the
 * scans' (modules/production/scans/store.ts): the work order's issue lock shared → the bundle FOR SHARE → the bundle's
 * scan lock → the timing trigger's own lock per bundle and operation.
 */

export type Reader = FactoryClient | CommandTx

export const TIMING_COLUMNS = {
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
  pauseReasonCode: true,
  reason: true,
  workerId: true,
  stationId: true,
  deviceId: true,
  clientScanId: true,
  deviceTime: true,
  serverTime: true,
} as const satisfies Prisma.OperationScanSelect
export type TimingScanRow = Prisma.OperationScanGetPayload<{ select: typeof TIMING_COLUMNS }> & TimingRow

const ORDER = [{ serverTime: 'asc' }, { id: 'asc' }] as const satisfies Prisma.OperationScanOrderByWithRelationInput[]

/** Every row of the bundle at the operation, oldest first (any kind). */
export async function readOperationRows(db: Reader, bundleId: string, workOrderOperationId: string): Promise<TimingScanRow[]> {
  return (await db.operationScan.findMany({ where: { bundleId, workOrderOperationId }, select: TIMING_COLUMNS, orderBy: [...ORDER] })) as TimingScanRow[]
}

/** Every row of these bundles, oldest first (any kind). */
export async function readBundlesRows(db: Reader, bundleIds: readonly string[]): Promise<TimingScanRow[]> {
  if (bundleIds.length === 0) return []
  return (await db.operationScan.findMany({ where: { bundleId: { in: [...bundleIds] } }, select: TIMING_COLUMNS, orderBy: [...ORDER] })) as TimingScanRow[]
}

/** Every row of the work order, oldest first (any kind). */
export async function readWorkOrderRows(db: Reader, workOrderId: string): Promise<TimingScanRow[]> {
  return (await db.operationScan.findMany({ where: { workOrderId }, select: TIMING_COLUMNS, orderBy: [...ORDER] })) as TimingScanRow[]
}

/** The row a device sent under its client scan id (the unique key), or null. */
export async function readByClient(db: Reader, deviceId: string, clientScanId: string): Promise<TimingScanRow | null> {
  return (await db.operationScan.findFirst({ where: { deviceId, clientScanId }, select: TIMING_COLUMNS })) as TimingScanRow | null
}

export async function readRow(db: Reader, scanId: string): Promise<TimingScanRow | null> {
  if (!isUuid(scanId)) return null
  return (await db.operationScan.findUnique({ where: { id: scanId }, select: TIMING_COLUMNS })) as TimingScanRow | null
}

export interface OpenPlace {
  readonly bundleId: string
  readonly workOrderOperationId: string
  readonly workOrderId: string
}

/**
 * The bundles at operations where the subject (a worker; else a station and no worker) opened or went on with work
 * lately (a START, RESUME or PAUSE of theirs in the look-back window): the candidates of their open work, each checked
 * against all its rows by the caller (the stretch may have been closed since).
 */
export async function openCandidates(db: Reader, where: { readonly siteId: string; readonly workerId: string | null; readonly stationId: string | null; readonly now: Date }): Promise<OpenPlace[]> {
  if (!where.workerId && !where.stationId) return []
  const since = new Date(where.now.getTime() - TERMINAL_LIMITS.openLookBackDays * 86_400_000)
  const subject = where.workerId ? { workerId: where.workerId } : { workerId: null, stationId: where.stationId! }
  const rows = await db.operationScan.findMany({
    where: { siteId: where.siteId, ...subject, kind: { in: ['START', 'RESUME', 'PAUSE'] }, serverTime: { gte: since } },
    select: { bundleId: true, workOrderOperationId: true, workOrderId: true },
    distinct: ['bundleId', 'workOrderOperationId'],
  })
  return rows
}

/** The workers each scan names as a team's members (OperationScanMember), by scan id. */
export async function readMembers(db: Reader, scanIds: readonly string[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(scanIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.operationScanMember.findMany({ where: { scanId: { in: ids } }, select: { scanId: true, workerId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const out = new Map<string, string[]>()
  for (const row of rows) out.set(row.scanId, [...(out.get(row.scanId) ?? []), row.workerId])
  return out
}

/** The workers' employees (Worker.employeeId; null while it has none): every row naming a worker names the person too. */
export async function employeesOf(db: Reader, workerIds: readonly string[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(workerIds)]
  if (ids.length === 0) return new Map()
  return new Map((await db.worker.findMany({ where: { id: { in: ids } }, select: { id: true, employeeId: true } })).map((row) => [row.id, row.employeeId]))
}

/** The bundles' codes, by id. */
export async function bundleCodes(db: Reader, bundleIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(bundleIds)]
  if (ids.length === 0) return new Map()
  return new Map((await db.bundle.findMany({ where: { id: { in: ids } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
}

/** The work orders' numbers, by id. */
export async function workOrderNumbers(db: Reader, workOrderIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(workOrderIds)]
  if (ids.length === 0) return new Map()
  return new Map((await db.workOrder.findMany({ where: { id: { in: ids } }, select: { id: true, number: true } })).map((row) => [row.id, row.number]))
}

/** Operations by id (seq, code, name). */
export async function operationsById(db: Reader, operationIds: readonly string[]): Promise<Map<string, { id: string; seq: number; code: string; name: string }>> {
  const ids = [...new Set(operationIds)]
  if (ids.length === 0) return new Map()
  return new Map((await db.workOrderOperation.findMany({ where: { id: { in: ids } }, select: { id: true, seq: true, code: true, name: true } })).map((row) => [row.id, row]))
}

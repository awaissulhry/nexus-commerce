import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Prisma } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'
import { dayOf, SITE_COLUMNS, type Reader, type SiteRow } from '../../planning/store'

/**
 * The rows dispatch reads (B-W2b-49): a day's DispatchAssignment rows, the site's stations and lines, and the lock of a
 * site's day. Every select names its columns.
 */

export { dayOf, type Reader }

/** A BusinessDate as a `@db.Date` column. */
export const dayColumn = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)

export async function siteRowOf(db: Reader, siteId: string): Promise<SiteRow | null> {
  return isUuid(siteId) ? db.site.findUnique({ where: { id: siteId }, select: SITE_COLUMNS }) : null
}

export const ASSIGNMENT_SELECT = {
  id: true,
  siteId: true,
  workDate: true,
  lineId: true,
  stationId: true,
  workOrderId: true,
  workOrderOperationId: true,
  bundleIds: true,
  workerId: true,
  employeeId: true,
  sequence: true,
  overrideReason: true,
  overrideById: true,
  note: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.DispatchAssignmentSelect
export type AssignmentRow = Prisma.DispatchAssignmentGetPayload<{ select: typeof ASSIGNMENT_SELECT }>

/** The site's rows of a day, in lane order. */
export function assignmentsOf(db: Reader, siteId: string, day: BusinessDate): Promise<AssignmentRow[]> {
  return db.dispatchAssignment.findMany({ where: { siteId, workDate: dayColumn(day) }, select: ASSIGNMENT_SELECT, orderBy: [{ sequence: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }] })
}

export async function assignmentRow(db: Reader, assignmentId: string): Promise<AssignmentRow | null> {
  return isUuid(assignmentId) ? db.dispatchAssignment.findUnique({ where: { id: assignmentId }, select: ASSIGNMENT_SELECT }) : null
}

/** Every write of a site's day waits for the one before it: the rows are read again after this. */
export async function lockDay(tx: CommandTx, tenantId: string, siteId: string, day: BusinessDate): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.dispatch', ${tenantId}::uuid::text, ${siteId}::uuid::text, ${day}::text), 0))`
}

export const STATION_SELECT = { id: true, companyId: true, siteId: true, code: true, name: true, lineId: true, workCentreId: true, status: true } as const satisfies Prisma.StationSelect
export type StationRow = Prisma.StationGetPayload<{ select: typeof STATION_SELECT }>

export function activeStationsOf(db: Reader, siteId: string): Promise<StationRow[]> {
  return db.station.findMany({ where: { siteId, status: 'ACTIVE' }, select: STATION_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
}

export async function stationOf(db: Reader, stationId: string): Promise<StationRow | null> {
  return isUuid(stationId) ? db.station.findUnique({ where: { id: stationId }, select: STATION_SELECT }) : null
}

export const LINE_SELECT = { id: true, companyId: true, siteId: true, code: true, name: true, status: true } as const satisfies Prisma.LineSelect
export type LineRow = Prisma.LineGetPayload<{ select: typeof LINE_SELECT }>

export function activeLinesOf(db: Reader, siteId: string): Promise<LineRow[]> {
  return db.line.findMany({ where: { siteId, status: 'ACTIVE' }, select: LINE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
}

export async function lineRowOf(db: Reader, lineId: string): Promise<LineRow | null> {
  return isUuid(lineId) ? db.line.findUnique({ where: { id: lineId }, select: LINE_SELECT }) : null
}

export const OPERATION_SELECT = {
  id: true,
  siteId: true,
  workOrderId: true,
  seq: true,
  code: true,
  name: true,
  workCentreId: true,
  standardMinutes: true,
  workOrder: { select: { id: true, companyId: true, siteId: true, number: true, status: true } },
} as const satisfies Prisma.WorkOrderOperationSelect
export type OperationRow = Prisma.WorkOrderOperationGetPayload<{ select: typeof OPERATION_SELECT }>

export async function operationOf(db: Reader, operationId: string): Promise<OperationRow | null> {
  return isUuid(operationId) ? db.workOrderOperation.findUnique({ where: { id: operationId }, select: OPERATION_SELECT }) : null
}

export const WORKER_SELECT = { id: true, siteId: true, displayName: true, status: true, employeeId: true } as const satisfies Prisma.WorkerSelect
export type WorkerRow = Prisma.WorkerGetPayload<{ select: typeof WORKER_SELECT }>

export async function workerOf(db: Reader, workerId: string): Promise<WorkerRow | null> {
  return isUuid(workerId) ? db.worker.findUnique({ where: { id: workerId }, select: WORKER_SELECT }) : null
}

/** Floor names of the workers named, by id (the only name a board or a paper shows). */
export async function workerNames(db: Reader, ids: Iterable<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  const rows = await db.worker.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(rows.map((row) => [row.id, row.displayName]))
}

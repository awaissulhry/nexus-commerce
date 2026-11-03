import type { Prisma } from '@nexus/factory-db'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { FirstPieceRow, InProcessKind, InProcessOutcome, InProcessStatus } from '@nexus/factory-domain/quality/inprocess/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The reads of in-process checks (B-W2b-99), in the caller's scope: the office as itself (row-level security by its grants),
 * a floor device at its own site, the tenant's system view where the floor may not read (the legal gate, a worker's
 * employee). Every row of a list is per line and operation: `workerId`/`employeeId` leave this file only through
 * modules/people/privacy/worker-gate.ts, inside one record.
 */

export type Reader = CommandTx

export const CHECK_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  kind: true,
  status: true,
  outcome: true,
  lineId: true,
  workOrderId: true,
  bundleId: true,
  workOrderOperationId: true,
  planVersionId: true,
  aqlProfileId: true,
  codeLetter: true,
  pieces: true,
  defectivePieces: true,
  defects: true,
  defectCodeId: true,
  inspectorWorkerId: true,
  inspectorUserId: true,
  workerId: true,
  decidedAt: true,
  signatureSha256: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.InProcessCheckSelect
export type CheckRow = Prisma.InProcessCheckGetPayload<{ select: typeof CHECK_COLUMNS }>

export const kindOf = (row: Pick<CheckRow, 'kind'>): InProcessKind => row.kind as InProcessKind
export const statusOf = (row: Pick<CheckRow, 'status'>): InProcessStatus => row.status as InProcessStatus
export const outcomeOf = (row: Pick<CheckRow, 'outcome'>): InProcessOutcome | null => (row.outcome as InProcessOutcome | null) ?? null

export async function readCheck(db: Pick<Reader, 'inProcessCheck'>, checkId: string): Promise<CheckRow | null> {
  if (!isUuid(checkId)) return null
  return db.inProcessCheck.findUnique({ where: { id: checkId }, select: CHECK_COLUMNS })
}

export const RESULT_COLUMNS = { id: true, planCheckId: true, sampleIndex: true, outcome: true, value: true, note: true, recordedAt: true, version: true } as const satisfies Prisma.InspectionCheckResultSelect
export type ResultRow = Prisma.InspectionCheckResultGetPayload<{ select: typeof RESULT_COLUMNS }>

export const readResults = (db: Pick<Reader, 'inspectionCheckResult'>, checkId: string): Promise<ResultRow[]> =>
  db.inspectionCheckResult.findMany({ where: { inProcessCheckId: checkId }, select: RESULT_COLUMNS, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] })

/** A work order as a check needs it: its company, site, line, style and number. */
export const WORK_ORDER_COLUMNS = { id: true, companyId: true, siteId: true, number: true, status: true, styleId: true, lineId: true } as const satisfies Prisma.WorkOrderSelect
export type WorkOrderRow = Prisma.WorkOrderGetPayload<{ select: typeof WORK_ORDER_COLUMNS }>

export async function readWorkOrder(db: Pick<Reader, 'workOrder'>, workOrderId: string): Promise<WorkOrderRow | null> {
  if (!isUuid(workOrderId)) return null
  return db.workOrder.findUnique({ where: { id: workOrderId }, select: WORK_ORDER_COLUMNS })
}

export const OPERATION_COLUMNS = { id: true, workOrderId: true, seq: true, code: true, name: true, operationId: true, workCentreId: true } as const satisfies Prisma.WorkOrderOperationSelect
export type OperationRow = Prisma.WorkOrderOperationGetPayload<{ select: typeof OPERATION_COLUMNS }>

export const readOperationsOf = (db: Pick<Reader, 'workOrderOperation'>, workOrderIds: readonly string[]): Promise<OperationRow[]> =>
  workOrderIds.length === 0 ? Promise.resolve([]) : db.workOrderOperation.findMany({ where: { workOrderId: { in: [...new Set(workOrderIds)] } }, select: OPERATION_COLUMNS, orderBy: [{ workOrderId: 'asc' }, { seq: 'asc' }] })

export const LINE_COLUMNS = { id: true, companyId: true, siteId: true, code: true, name: true } as const satisfies Prisma.LineSelect
export type LineRow = Prisma.LineGetPayload<{ select: typeof LINE_COLUMNS }>

export async function readLine(db: Pick<Reader, 'line'>, lineId: string): Promise<LineRow | null> {
  if (!isUuid(lineId)) return null
  return db.line.findUnique({ where: { id: lineId }, select: LINE_COLUMNS })
}

/** The work order's first-piece checks (the hold's rows), oldest first. */
export async function firstPieceRows(db: Pick<Reader, 'inProcessCheck'>, workOrderId: string): Promise<(FirstPieceRow & { readonly decidedAt: Date | null })[]> {
  const rows = await db.inProcessCheck.findMany({
    where: { workOrderId, kind: 'FIRST_PIECE' },
    select: { id: true, status: true, outcome: true, bundleId: true, workOrderOperationId: true, createdAt: true, decidedAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return rows.map((row) => ({ ...row, status: row.status as InProcessStatus, outcome: (row.outcome as InProcessOutcome | null) ?? null }))
}

/**
 * A first piece opened, decided or cancelled changes what the run's scans may do: it takes the work order's issue lock
 * EXCLUSIVE (every scan takes it shared: production/scans scanWorkOrderLock), so a scan in flight ends first and every
 * later scan reads the run's checks as this command leaves them.
 */
export async function lockRun(tx: Reader, tenantId: string, workOrderId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.work-order-issue', ${tenantId}::uuid, ${workOrderId}::uuid), 0))`
}

export const names = (rows: readonly { readonly id: string; readonly code: string }[]) => new Map(rows.map((row) => [row.id, row.code]))

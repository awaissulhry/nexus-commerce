import { ownVarianceProblems } from '@nexus/factory-domain/inventory/counts-depth/separation'
import type { CountRow, LineRow } from '../counts/store'
import { scannerUsersByLine, scansOf, separationFor, type Db } from './store'

/**
 * What the counts' own record and commands read of counts in depth (B-W2b-299), with no import of the approval engine (the
 * engine's kinds import the counts, so these stay below both): the count's request for a yes (kind COUNT_VARIANCE), the
 * counter-not-approver rule as the warehouse rules hold it (the switch, and the units a person scanned), and each line's
 * freeze and scans.
 */

export const VARIANCE_RECORD = 'StockCount'

export interface VarianceRequest {
  readonly taskId: string
  readonly status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'STALE'
  readonly approverRoleId: string | null
  readonly approverUserId: string | null
  readonly requestedById: string | null
}

/** The count's latest request for a yes (COUNT_VARIANCE), or null when no approval rule asked one. */
export async function varianceRequestOf(db: Db, countId: string): Promise<VarianceRequest | null> {
  const task = await db.approvalTask.findFirst({
    where: { kind: 'COUNT_VARIANCE', recordType: VARIANCE_RECORD, recordId: countId },
    orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, status: true, approverRoleId: true, approverUserId: true, requestedById: true },
  })
  return task ? { taskId: task.id, status: task.status as VarianceRequest['status'], approverRoleId: task.approverRoleId, approverUserId: task.approverUserId, requestedById: task.requestedById } : null
}

/** Who a pending request waits for, in words (the role's name, or the person's). */
export async function waitingWords(db: Db, request: VarianceRequest, number: string): Promise<string> {
  const role = request.approverRoleId ? await db.role.findUnique({ where: { id: request.approverRoleId }, select: { name: true } }) : null
  const person = request.approverUserId ? await db.user.findUnique({ where: { id: request.approverUserId }, select: { displayName: true } }) : null
  const who = role?.name ?? person?.displayName ?? 'the approver'
  return `Count ${number} waits for a yes in Approvals by ${who}: its differences are approved there.`
}

const facts = (line: LineRow) => ({
  expected: line.expectedQuantity.toString(),
  counted: line.countedQuantity === null ? null : line.countedQuantity.toString(),
  recountRequested: line.recountRequestedAt !== null,
  recount: line.recountQuantity === null ? null : line.recountQuantity.toString(),
})

/**
 * The counter never approves their own variance (SCM-229, SCM-293), as the company's switch says (on unless the warehouse
 * rules switched it off): who counted, recounted or scanned a unit of a line that differs. W2a's rule (typed counts) is the
 * same with the switch on; switched off, anyone who may approve does.
 */
export async function ownVarianceRefusals(db: Db, tenantId: string, count: Pick<CountRow, 'id' | 'companyId'>, lines: readonly LineRow[], approverId: string, approvalRequired: boolean) {
  const separation = await separationFor(db, tenantId, count.companyId)
  if (!separation.COUNTER_NOT_APPROVER.on || !approvalRequired) return []
  const scanners = await scannerUsersByLine(db, await scansOf(db, count.id))
  return ownVarianceProblems({
    switchOn: true,
    approvalRequired,
    approverId,
    lines: lines.map((line) => ({ ...facts(line), seq: line.seq, countedById: line.countedById, recountedById: line.recountedById, scannedByUserIds: scanners.get(line.id) ?? [] })),
  })
}

/** A frozen line holds its moves now: its count COUNTING, frozen, not counted or its asked recount not done. */
export const holdsMoves = (count: Pick<CountRow, 'status'>, line: Pick<LineRow, 'countedAt' | 'recountRequestedAt' | 'recountedAt'> & { readonly frozenAt: Date | null }): boolean =>
  count.status === 'COUNTING' && line.frozenAt !== null && (line.countedAt === null || (line.recountRequestedAt !== null && line.recountedAt === null))

/** Each line's freeze and its scans (both passes), for the counts' line views. */
export async function lineDepthOf(db: Db, count: Pick<CountRow, 'id' | 'status'>, lines: readonly (LineRow & { readonly frozenAt: Date | null })[]): Promise<Map<string, { frozen: boolean; scans: number }>> {
  if (lines.length === 0) return new Map()
  const grouped = await db.stockCountScan.groupBy({ by: ['lineId'], where: { countId: count.id, lineId: { in: lines.map((line) => line.id) } }, _count: { _all: true } })
  const scans = new Map(grouped.map((row) => [row.lineId, row._count._all]))
  return new Map(lines.map((line) => [line.id, { frozen: holdsMoves(count, line), scans: scans.get(line.id) ?? 0 }]))
}

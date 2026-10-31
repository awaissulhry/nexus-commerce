import type { Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { STEP_PLACE, type LeaverCaseStatus, type LeaverStepKind, type LeaverStepStatus } from '@nexus/factory-domain/people/leavers/rules'
import { dayOf, dayOrNull } from './access'

/**
 * A leaver case as the employee record and the leavers routes show it (B-W2b-26; MES-214): its steps in order, each with
 * where it is done (the web's link), who ticked it (an office user by name inside the one record, or the system).
 */

export const CASE_SELECT = {
  id: true,
  employeeId: true,
  lastWorkingDay: true,
  status: true,
  startedAt: true,
  startedById: true,
  closedAt: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  steps: {
    orderBy: { seq: 'asc' },
    select: { id: true, kind: true, seq: true, automatic: true, dueOn: true, status: true, doneAt: true, doneById: true, skipReason: true, recordType: true, recordId: true, version: true },
  },
} as const satisfies Prisma.LeaverCaseSelect

export type CaseRow = Prisma.LeaverCaseGetPayload<{ select: typeof CASE_SELECT }>

export function caseViewOf(row: CaseRow, names: ReadonlyMap<string, string>) {
  return {
    id: row.id,
    employeeId: row.employeeId,
    lastWorkingDay: dayOf(row.lastWorkingDay),
    status: row.status as LeaverCaseStatus,
    startedAt: toUtcIso(row.startedAt),
    startedBy: names.get(row.startedById) ?? null,
    closedAt: row.closedAt ? toUtcIso(row.closedAt) : null,
    cancelledAt: row.cancelledAt ? toUtcIso(row.cancelledAt) : null,
    cancelReason: row.cancelReason,
    steps: row.steps.map((step) => ({
      id: step.id,
      kind: step.kind as LeaverStepKind,
      seq: step.seq,
      automatic: step.automatic,
      dueOn: dayOrNull(step.dueOn),
      status: step.status as LeaverStepStatus,
      doneAt: step.doneAt ? toUtcIso(step.doneAt) : null,
      doneBy: step.status === 'OPEN' ? null : step.doneById ? { kind: 'USER' as const, name: names.get(step.doneById) ?? null } : { kind: 'SYSTEM' as const, name: null },
      skipReason: step.skipReason,
      place: STEP_PLACE[step.kind as LeaverStepKind],
      recordType: step.recordType,
      recordId: step.recordId,
      version: step.version,
    })),
    version: row.version,
  }
}

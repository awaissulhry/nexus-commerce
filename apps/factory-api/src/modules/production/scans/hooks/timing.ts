import { newId } from '@nexus/factory-domain/core/ids'
import { stretchesOf, type TimingSubject } from '@nexus/factory-domain/production/terminal/rules'
import type { CommandTools } from '../../../../core/command'
import { hasAcknowledgedNotice } from '../../settings/subject'
import { employeesOf, readMembers, readOperationRows } from '../../terminal/store'

/**
 * B-W2b-40 hook of the scans' report (modules/production/terminal; MES-094 team operation, Owner answer F3): what
 * scans.ts calls, in one named line after the REPORT row, inside the report's command.
 *
 * Finishing stays ONE tap: the REPORT needs no START and the database ends a running stretch with it. When the REPORT
 * closed a stretch of its own subject that ran as a team (its last START or RESUME named members), the REPORT names the
 * same team (OperationScanMember, each with their employee) — those of them who still have the worker notice in force
 * acknowledged; nobody else is named, and nothing here ever refuses the report.
 */
export async function timingAfterReportInCommand(tools: CommandTools, report: { readonly scanId: string; readonly siteId: string; readonly bundleId: string; readonly workOrderOperationId: string; readonly subject: TimingSubject; readonly createdById: string | null }): Promise<void> {
  if (report.subject.workerId === null) return
  const rows = await readOperationRows(tools.tx, report.bundleId, report.workOrderOperationId)
  if (!rows.some((row) => row.kind === 'START')) return
  const members = await readMembers(tools.tx, rows.filter((row) => row.kind === 'START' || row.kind === 'RESUME').map((row) => row.id))
  const closed = stretchesOf(rows, members).find((stretch) => stretch.closedBy?.scanId === report.scanId)
  if (!closed || closed.workerId !== report.subject.workerId) return
  const team = members.get(closed.runs.at(-1)?.openedBy ?? '') ?? []
  if (team.length < 2) return
  const named: string[] = []
  for (const workerId of team) if (await hasAcknowledgedNotice(tools.tx, report.siteId, workerId)) named.push(workerId)
  if (named.length < 2) return
  const employees = await employeesOf(tools.tx, named)
  await tools.tx.operationScanMember.createMany({ data: named.map((workerId) => ({ id: newId(), siteId: report.siteId, scanId: report.scanId, workerId, employeeId: employees.get(workerId) ?? null, createdById: report.createdById })) })
}

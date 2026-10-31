import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { QUALITY_INSPECTIONS_RECORD, QUALITY_INSPECTIONS_VIEW } from '@nexus/factory-domain/quality/final/permissions'
import { dueProblem, inspectionOverdue } from '@nexus/factory-domain/quality/final/rules'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeOf } from './access'
import { readInspection } from './store'

/**
 * By when an inspection is due (B-W2b-17; B-W2a-67's gap, design quality.inspections qi-grid inline "Due"; Inspection.dueAt,
 * W2b schema wave 2): POST /quality/inspections/due — ONE command sets (or clears) the due time of the open inspections
 * named (≤ 50, each at the version read), every one or none (409 `inspections/<i>` in words). Office only, with
 * quality.inspections.record over each inspection's company and site (a planning field: any inspector of the office,
 * not only the assignee); the …_followups_quality_money_w2b_guards trigger keeps the floor out and W1's guard freezes it
 * on a decided or cancelled inspection. An inspection already due then is left as it is. Audit per inspection; no event
 * of its own (the list reads it again on its next load; Today has no due rows yet).
 */

export const DUE_LIMIT = 50

/** Every refused inspection in words (409): no due time was changed. */
export class DueRefusedError extends ConflictError {
  override name = 'DueRefusedError'
  override readonly issues: readonly Issue[]
  constructor(issues: readonly Issue[]) {
    super(issues.length === 1 ? issues[0]!.message : `${issues.length} inspections cannot take the due time: none was changed.`)
    this.issues = issues
  }
}

export interface DueBody {
  readonly inspections: readonly { readonly id: string; readonly version: number }[]
  readonly dueAt: string | null
}

export async function setInspectionsDue(caller: CommandCaller, body: DueBody, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  if (body.inspections.length === 0 || body.inspections.length > DUE_LIMIT) throw new ValidationError(`Name 1 to ${DUE_LIMIT} inspections.`, [{ path: 'body/inspections', message: `1 to ${DUE_LIMIT}.` }])
  if (new Set(body.inspections.map((entry) => entry.id)).size !== body.inspections.length) throw new ValidationError('Name each inspection once.', [{ path: 'body/inspections', message: 'Name each inspection once.' }])
  const dueAt = body.dueAt === null ? null : new Date(body.dueAt)
  const { result } = await command(caller, { name: 'quality.inspection.due', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const problem = dueProblem(dueAt, now)
    if (problem) throw new ValidationError(problem.message, [{ ...problem, path: `body/${problem.path}` }])
    const problems: Issue[] = []
    const out: { id: string; version: number; dueAt: string | null; overdue: boolean }[] = []
    const order = [...body.inspections.entries()].sort((a, b) => (a[1].id < b[1].id ? -1 : 1))
    for (const [index, entry] of order) {
      await tx.$queryRaw`SELECT "id" FROM "Inspection" WHERE "id" = ${entry.id}::uuid FOR UPDATE`
      const row = await readInspection(tx, entry.id)
      if (!row || !can(actorOf(context), QUALITY_INSPECTIONS_VIEW, { companyId: row.companyId, siteId: row.siteId })) throw new NotFoundError('Inspection not found.')
      if (!can(actorOf(context), QUALITY_INSPECTIONS_RECORD, { companyId: row.companyId, siteId: row.siteId })) throw new ForbiddenError("Setting by when an inspection is due needs quality.inspections.record over its company and site.")
      if (row.version !== entry.version) throw new StaleVersionError('Inspection', row.id, row.version, entry.version)
      const label = row.number ?? row.id.slice(0, 8)
      if (row.status !== 'OPEN') {
        problems.push({ path: `inspections/${index}`, message: `${label} is ${row.status.toLowerCase()}: only an open inspection has a due time.` })
        continue
      }
      if ((row.dueAt?.getTime() ?? null) === (dueAt?.getTime() ?? null)) {
        out.push({ id: row.id, version: row.version, dueAt: row.dueAt ? toUtcIso(row.dueAt) : null, overdue: inspectionOverdue(row, now) })
        continue
      }
      const updated = await tx.inspection.update({ where: { id: row.id }, data: { dueAt, version: { increment: 1 }, updatedAt: now }, select: { id: true, version: true, status: true, dueAt: true } })
      tools.audit({ action: 'quality.inspection.due', recordType: 'Inspection', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { dueAt: row.dueAt ? toUtcIso(row.dueAt) : null }, after: { dueAt: dueAt ? toUtcIso(dueAt) : null } })
      out.push({ id: updated.id, version: updated.version, dueAt: updated.dueAt ? toUtcIso(updated.dueAt) : null, overdue: inspectionOverdue(updated, now) })
    }
    if (problems.length > 0) throw new DueRefusedError(problems)
    return out
  })
  const byId = new Map(result.map((entry) => [entry.id, entry]))
  return { inspections: body.inspections.map((entry) => byId.get(entry.id)!) }
}

import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { countProblem } from '@nexus/factory-domain/quality/final/plan'
import { dueProblem } from '@nexus/factory-domain/quality/final/rules'
import { QUALITY_INPROCESS_RECORD, QUALITY_INPROCESS_VIEW } from '@nexus/factory-domain/quality/inprocess/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { assertOn, checkerOf, officeOf, postedBy, refuse } from './access'
import { assertOpen, changedEvent, checkFor, lockCheck } from './checks'
import { readCheck } from './store'
import { checkViewOf } from './views'

/**
 * B-W2b-213 (W2b schema wave 24/33; B-W2b-99's gaps): the units of an in-process check's AQL sample inspected, and by
 * when it is due. One command() each, with its audit row and `in_process_check.changed` (COUNTED, DUE).
 *
 *   POST  /quality/inprocess/checks/:checkId/count   { version, inspected } | { version, add }: office and the line's
 *                                                    tablet, quality.inprocess.record, while OPEN, on a check with an
 *                                                    AQL sample (InProcessCheck.sampleSize, frozen when it opened); the
 *                                                    database keeps 0..sample and freezes the sample and the profile once
 *                                                    a unit is counted.
 *   PATCH /quality/inprocess/checks/:checkId/due     { version, dueAt | null }: the office only (a rule's due hours set it
 *                                                    when it opens; the floor never sets or moves it: the database).
 */

const invalid = (message: string, problems: readonly Issue[]) => new ValidationError(message, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))

export interface CountBody {
  readonly version: number
  readonly inspected?: number | undefined
  readonly add?: number | undefined
}

export async function countCheck(caller: CommandCaller, checkId: string, body: CountBody, idempotencyKey: string | undefined) {
  const context = checkerOf(caller)
  const row = await checkFor(caller, context, checkId)
  assertOpen(row)
  if ((body.inspected === undefined) === (body.add === undefined)) throw invalid('Give the units inspected, or how many to add.', [{ path: 'inspected', message: 'Give `inspected` (the count) or `add` (units to add), one of the two.' }])
  if (row.sampleSize === null) refuse({ code: 'NO_SAMPLE', message: 'This check has no AQL sample: there is nothing to count.', fix: 'Record what you found when you decide it.' })
  const { result } = await command(caller, { name: 'quality.inprocess.count', idempotencyKey, input: { checkId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const current = await lockCheck(tx, row.id, body.version)
    const was = current.inspectedCount ?? 0
    const inspected = body.inspected ?? was + (body.add ?? 0)
    const problem = countProblem(inspected, current.sampleSize!)
    if (problem) throw invalid(problem.message, [problem])
    await tx.inProcessCheck.update({ where: { id: current.id }, data: { inspectedCount: inspected, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ recordType: 'InProcessCheck', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { inspected: current.inspectedCount }, after: { inspected, sampleSize: current.sampleSize, by: postedBy(context) } })
    changedEvent(tools, (await readCheck(tx, current.id))!, 'COUNTED')
    return { id: current.id }
  })
  return { check: await checkViewOf(caller, result.id) }
}

export interface DueBody {
  readonly version: number
  readonly dueAt: string | null
}

export async function setCheckDue(caller: CommandCaller, checkId: string, body: DueBody, idempotencyKey: string | undefined) {
  const context = officeOf(caller)
  const row = await checkFor(caller, context, checkId)
  assertOn(context, QUALITY_INPROCESS_VIEW, QUALITY_INPROCESS_RECORD, row, 'Check')
  assertOpen(row)
  const dueAt = body.dueAt === null ? null : new Date(body.dueAt)
  const { result } = await command(caller, { name: 'quality.inprocess.due', idempotencyKey, input: { checkId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const problem = dueProblem(dueAt, now)
    if (problem) throw invalid(problem.message.replace('The inspection', 'The check'), [{ ...problem, message: problem.message.replace('The inspection', 'The check') }])
    const current = await lockCheck(tx, row.id, body.version)
    if ((current.dueAt?.getTime() ?? null) === (dueAt?.getTime() ?? null)) return { id: current.id }
    await tx.inProcessCheck.update({ where: { id: current.id }, data: { dueAt, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'quality.inprocess.due', recordType: 'InProcessCheck', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { dueAt: current.dueAt ? toUtcIso(current.dueAt) : null }, after: { dueAt: dueAt ? toUtcIso(dueAt) : null } })
    changedEvent(tools, (await readCheck(tx, current.id))!, 'DUE')
    return { id: current.id }
  })
  return { check: await checkViewOf(caller, result.id) }
}

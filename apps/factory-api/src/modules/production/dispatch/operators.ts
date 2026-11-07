import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { LEVEL_LABELS } from '@nexus/factory-domain/people/skills/rules'
import { PRODUCTION_DISPATCH_MANAGE } from '@nexus/factory-domain/production/dispatch/permissions'
import { DISPATCH_LIMITS, DISPATCH_REFUSALS } from '@nexus/factory-domain/production/dispatch/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import type { SkillRequirement } from '@nexus/factory-domain/people/skills/qualification'
import { qualificationCheck } from '../../people/skills/check'
import { scanSubjectFor } from '../settings/subject'
import { contextOf, knownSite, may, readerOf, refuse } from './access'
import { attendanceOfDay } from './facts'
import { assignmentRow, lineRowOf, operationOf, stationOf, type LineRow, type Reader } from './store'

/**
 * Who can take this work (B-W2b-49; MES-023; design production.dispatch "Assign operator": "Combobox of people clocked in,
 * with their skill level for this operation; no output numbers"; floor.supervisor "Reassign"): GET
 * /production/dispatch/operators?siteId&date&stationId|lineId&workOrderOperationId|assignmentId (office and the team leader's
 * floor device, production.dispatch.manage).
 *
 * With the site's ATTENDANCE gate in force, today, the people clocked in; else everybody active, with no word about who is
 * in. Each with what THE check says (people/skills/check.ts) about this operation at this station. Nothing else about a
 * person: no minutes, no output, no rank; one list for one choice, never a report (Statuto dei Lavoratori art. 4).
 */

export interface OperatorsQuery {
  readonly siteId?: string | undefined
  readonly date?: BusinessDate | undefined
  readonly stationId?: string | undefined
  readonly lineId?: string | undefined
  readonly workOrderOperationId?: string | undefined
  readonly assignmentId?: string | undefined
}

export async function dispatchOperators(caller: CommandCaller, query: OperatorsQuery) {
  const context = contextOf(caller)
  const now = serverClock.now()
  const reader = readerOf(caller, context)
  const siteId = context.audience === 'floor' ? context.siteId : query.siteId
  if (!siteId) throw new ValidationError('Name the site.', [{ path: 'querystring/siteId', message: 'Give the site.' }])
  const site = await knownSite(caller, context, siteId, PRODUCTION_DISPATCH_MANAGE)
  const facts = await reader.withClient(async (db: Reader) => {
    const row = query.assignmentId ? await assignmentRow(db, query.assignmentId) : null
    if (query.assignmentId && (!row || row.siteId !== site.id)) throw new NotFoundError('Assignment not found.')
    const stationId = query.stationId ?? row?.stationId ?? null
    const station = stationId ? await stationOf(db, stationId) : null
    if (stationId && (!station || station.siteId !== site.id)) throw new NotFoundError('Station not found.')
    const operationId = query.workOrderOperationId ?? row?.workOrderOperationId ?? null
    const operation = operationId ? await operationOf(db, operationId) : null
    if (operationId && (!operation || operation.siteId !== site.id)) throw new NotFoundError('Work order operation not found.')
    if (!station && !operation) throw new ValidationError('Name the work: a station, an operation or an assignment.', [{ path: 'querystring/stationId', message: 'Give a station, an operation or an assignment.' }])
    const day = query.date ?? businessDate(now, site.timezone)
    const subject = await scanSubjectFor(db, site.id)
    if (subject !== 'WORKER') refuse(DISPATCH_REFUSALS.SITE_NAMES_NO_WORKERS)
    const lineId = query.lineId ?? station?.lineId ?? row?.lineId ?? null
    const line: LineRow | null = lineId ? await lineRowOf(db, lineId) : null
    const today = businessDate(now, site.timezone)
    const attendance = await attendanceOfDay(db, { site, day, today, now, rows: [] }, new Map())
    const workers = await db.worker.findMany({ where: { siteId: site.id, status: 'ACTIVE' }, select: { id: true, displayName: true, employeeId: true }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }] })
    const homes = await db.employee.findMany({ where: { id: { in: workers.flatMap((worker) => (worker.employeeId ? [worker.employeeId] : [])) } }, select: { id: true, homeLineId: true } })
    return { station, operation, day, today, line, attendance, workers, homeOf: new Map(homes.map((home) => [home.id, home.homeLineId])) }
  })
  const clockedOnly = facts.attendance.open && facts.day === facts.today
  const listed = facts.workers
    .map((worker) => {
      const clocked = worker.employeeId ? facts.attendance.clockedIn.get(worker.employeeId) : undefined
      const onLine = facts.line !== null && worker.employeeId !== null && (clocked?.lineId === facts.line.id || facts.homeOf.get(worker.employeeId) === facts.line.id)
      return { worker, clocked, onLine }
    })
    .filter((entry) => (clockedOnly ? entry.clocked !== undefined : true))
    .sort((a, b) => Number(b.onLine) - Number(a.onLine))
  const shown = listed.slice(0, DISPATCH_LIMITS.operatorsListed)
  // In the caller's own scope: the check reads what the floor may read, in floor names.
  const operators = await caller.withClient(async (db: Reader) => {
    const out = []
    for (const { worker, clocked, onLine } of shown) {
      const check = await qualificationCheck(db, { workerId: worker.id, workOrderOperationId: facts.operation?.id ?? null, stationId: facts.station?.id ?? null }, { names: 'DISPLAY', now })
      const skill = check.requirements.find((requirement): requirement is SkillRequirement => requirement.kind === 'OPERATION')
      const level = skill ? skill.level : null
      out.push({
        workerId: worker.id,
        name: worker.displayName,
        level,
        levelLabel: level ? LEVEL_LABELS[level] : null,
        trainee: check.trainee,
        clockedIn: clockedOnly ? true : null,
        onBreak: clockedOnly ? (clocked?.onBreak ?? false) : null,
        onThisLine: onLine,
        decision: check.decision,
        overridable: check.overridable,
        words: check.decision === 'ALLOW' ? null : check.message,
      })
    }
    return out
  })
  const mayManage = may(context, PRODUCTION_DISPATCH_MANAGE, { companyId: site.companyId, siteId: site.id })
  return {
    siteId: site.id,
    day: facts.day,
    asOf: toUtcIso(now),
    attendance: { open: facts.attendance.open, words: facts.attendance.words },
    clockedOnly,
    operators,
    complete: listed.length === shown.length,
    mayManage,
  }
}

import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { PEOPLE_ATTENDANCE_SETTINGS } from '@nexus/factory-domain/people/attendance/permissions'
import { settingsProblems, workedExample, type AttendanceSettings } from '@nexus/factory-domain/people/attendance/rules'
import { PEOPLE_ATTENDANCE_VIEW } from '@nexus/factory-domain/people/clock/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeOf } from '../employees/access'
import type { SaveSettingsBody } from './contract'
import { settingsOf, type Client } from './store'

/**
 * People settings › Rounding, tolerance and grace (B-W2b-37; MES-225, MES-227; design people.settings "Rounding,
 * tolerance and grace"): how clock events become hours for a company, with the worked example under the values.
 * Settings, not a person's data: no legal gate. people.attendance.view (or .settings) reads; people.attendance.settings
 * writes, with the version read (a company without People settings has none yet: version null creates the row; the
 * privacy columns keep their defaults and stay B-W2b-27's). A change counts from the next computation of each day: an
 * approved day keeps its figures until it is reopened.
 *
 *   GET /people/attendance/settings?companyId   the six values and the worked example
 *   PUT /people/attendance/settings             all six, the version read
 */

const ATTENDANCE_COLUMNS = ['earlyClockInFromShiftStart', 'lateGraceMinutes', 'overtimeUnitMinutes', 'roundingMinutes', 'autoClockOutAfterMinutes', 'fixedBreaks'] as const

async function companyFor(db: Client, context: OfficeContext, companyId: string, write: boolean): Promise<string> {
  const company = isUuid(companyId) ? await db.company.findUnique({ where: { id: companyId }, select: { id: true } }) : null
  const actor = actorOf(context)
  if (!company || !(can(actor, PEOPLE_ATTENDANCE_VIEW, { companyId }) || can(actor, PEOPLE_ATTENDANCE_SETTINGS, { companyId }))) throw new NotFoundError('Company not found.')
  if (write && !can(actor, PEOPLE_ATTENDANCE_SETTINGS, { companyId })) throw new ForbiddenError('The rounding and grace rules are kept by a role with people.attendance.settings.')
  return company.id
}

const answerOf = (companyId: string, version: number | null, settings: AttendanceSettings) => ({ companyId, version, ...settings, example: workedExample(settings) })

export async function readSettings(caller: CommandCaller, query: { companyId: string }) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const companyId = await companyFor(db, context, query.companyId, false)
    const { settings, version } = await settingsOf(db, companyId)
    return answerOf(companyId, version, settings)
  })
}

export async function saveSettings(caller: CommandCaller, body: SaveSettingsBody, key?: string) {
  const context = officeOf(caller)
  const problems = settingsProblems(body)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
  await caller.withClient((db) => companyFor(db, context, body.companyId, true))
  const next: AttendanceSettings = {
    earlyClockInFromShiftStart: body.earlyClockInFromShiftStart,
    lateGraceMinutes: body.lateGraceMinutes,
    overtimeUnitMinutes: body.overtimeUnitMinutes,
    roundingMinutes: body.roundingMinutes,
    autoClockOutAfterMinutes: body.autoClockOutAfterMinutes,
    fixedBreaks: body.fixedBreaks,
  }
  const { result } = await command(caller, { name: 'people.changeAttendanceSettings', idempotencyKey: key, input: body }, async (tools) => {
    const { settings: before, version } = await settingsOf(tools.tx, body.companyId)
    if (version !== body.version) throw new ConflictError(version === null ? 'This company has no People settings yet: send version null.' : `The People settings changed since you read them (version ${version}, not ${String(body.version)}): read them again.`)
    let newVersion: number
    if (version === null) {
      await tools.tx.peopleSettings.create({ data: { id: body.companyId, companyId: body.companyId, ...next, createdById: context.actorId }, select: { id: true } })
      newVersion = 1
    } else {
      const row = await tools.tx.peopleSettings.update({ where: { id: body.companyId }, data: { ...next, version: { increment: 1 } }, select: { version: true } })
      newVersion = row.version
    }
    const changed = ATTENDANCE_COLUMNS.filter((column) => before[column] !== next[column])
    tools.audit({ recordType: 'PeopleSettings', recordId: body.companyId, companyId: body.companyId, before, after: { ...next, changed } })
    tools.emit({ type: 'people_settings.attendance_changed', subject: body.companyId, companyId: body.companyId, payload: { companyId: body.companyId, version: newVersion } })
    return answerOf(body.companyId, newVersion, next)
  })
  return result
}

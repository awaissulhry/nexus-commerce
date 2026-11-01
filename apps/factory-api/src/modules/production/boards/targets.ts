import { dayOf } from '@nexus/factory-domain/calendars/working-time'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { hourSpan, hourStateOf, shiftAt, workingMinutesByHour } from '@nexus/factory-domain/production/boards/hourly'
import { PRODUCTION_BOARDS_REASON, PRODUCTION_BOARDS_TARGETS, PRODUCTION_BOARDS_VIEW } from '@nexus/factory-domain/production/boards/permissions'
import { BOARD_REFUSALS, hourLabel, isPastDay, shortReasonRefusal, SHORT_REASON_LIST, targetDraftProblems, targetPlan, type TargetDraft } from '@nexus/factory-domain/production/boards/targets'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { ownerKey, workingCalendarsFor } from '../../../platform/calendars/service'
import { assertMay, contextOf, knownLine, may, officeOf, readerOf, refuse } from './access'
import { hourView, lineDays, shiftView } from './facts'
import { dayColumn, isoDay, siteRow, siteView, targetRow, targetsOf, type LineRow } from './store'

/**
 * A line's hourly targets and the reason of a short hour (B-W2b-50; MES-084, MES-161; design production.floor "Hour by
 * hour" with its popover "Why was 10:00–11:00 short?"; andon.prisma LineTarget):
 *
 *   GET  /production/boards/targets?lineId&date        the line's day as the office fills it (production.boards.view):
 *                                                      every hour with working time in the line's calendar or a target,
 *                                                      each with its target (id, pieces, version) and whether a reason
 *                                                      was given; a past day is read only
 *   PUT  /production/boards/targets                    set, change or remove hours of one day (production.boards.targets;
 *                                                      office): ONE command, one audit row per target, one event
 *   POST /production/boards/targets/:targetId/reason   the reason for a short hour (production.boards.reason; office and
 *                                                      the team leader's floor device at its site): a code of the
 *                                                      DOWNTIME reason list and words; the hour is over and ended below
 *                                                      its target; a reason given before is replaced (its audit row stays)
 *
 * A target is a LINE's pieces an hour, never a person's (Owner answer F2). Writes take the line-day lock
 * `factory.line-targets|tenant|line|day` (two offices filling the same day, or a reason given while the day changes, wait
 * for each other). The floor writes only the reason columns (the database's LineTarget guard refuses more).
 */

/** The site's day of a date (default today), and today. */
function daysOf(timeZone: string, date: BusinessDate | undefined, now: Date): { day: BusinessDate; today: BusinessDate } {
  const today = businessDate(now, timeZone)
  return { day: date ?? today, today }
}

async function lockLineDay(tx: CommandTx, tenantId: string, lineId: string, day: BusinessDate): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.line-targets', ${tenantId}::uuid::text, ${lineId}::uuid::text, ${day}::text), 0))`
}

/** GET /production/boards/targets. */
export async function lineTargets(caller: CommandCaller, query: { readonly lineId: string; readonly date?: BusinessDate | undefined }) {
  const context = officeOf(caller)
  const line = await knownLine(caller, context, query.lineId, PRODUCTION_BOARDS_VIEW)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const site = (await siteRow(db, line.siteId))!
    const { day, today } = daysOf(site.timezone, query.date, now)
    const targets = await targetsOf(db, [line.id], day)
    const calendar = (await workingCalendarsFor(db, [{ scope: 'LINE', id: line.id }], { from: day, to: day })).get(ownerKey({ scope: 'LINE', id: line.id }))?.calendar
    const shifts = calendar ? dayOf(calendar, day).shifts : []
    const minutes = workingMinutesByHour(day, site.timezone, shifts.flatMap((shift) => shift.working))
    const hours = [...new Set([...minutes.keys(), ...targets.map((target) => target.hour)])].sort((a, b) => a - b)
    const past = isPastDay(day, today)
    return {
      line: { id: line.id, code: line.code, name: line.name },
      site: siteView(site),
      day,
      today,
      past,
      shift: shiftView(day === today ? shiftAt(shifts, now) : null),
      hours: hours.map((hour) => {
        const target = targets.find((row) => row.hour === hour) ?? null
        return {
          hour,
          label: hourLabel(hour),
          workingMinutes: minutes.get(hour) ?? 0,
          target: target ? { id: target.id, targetPieces: target.targetPieces, version: target.version } : null,
          reasonGiven: target !== null && target.shortReasonAt !== null,
        }
      }),
      total: targets.length ? targets.reduce((sum, target) => sum + target.targetPieces, 0) : null,
      canSet: !past && may(context, PRODUCTION_BOARDS_TARGETS, { companyId: line.companyId, siteId: line.siteId }),
    }
  })
}

export interface SetTargetsBody {
  readonly lineId: string
  readonly date: BusinessDate
  readonly hours: readonly TargetDraft[]
}

/** PUT /production/boards/targets. */
export async function setTargets(caller: CommandCaller, body: SetTargetsBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const line = await knownLine(caller, context, body.lineId, PRODUCTION_BOARDS_VIEW)
  if (!may(context, PRODUCTION_BOARDS_TARGETS, { companyId: line.companyId, siteId: line.siteId })) throw new ForbiddenError("A line's hourly targets are set with production.boards.targets.")
  if (line.status !== 'ACTIVE') refuse(BOARD_REFUSALS.NOT_LINE_OF_SITE)
  const problems = targetDraftProblems(body.hours)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The targets have problems.', problems.map((issue) => ({ ...issue, path: `body/${issue.path}` })))
  const { result, replayed } = await command(caller, { name: 'production.setLineTargets', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const site = (await siteRow(tx, line.siteId))!
    if (isPastDay(body.date, businessDate(now, site.timezone))) refuse(BOARD_REFUSALS.PAST_DAY)
    await lockLineDay(tx, context.tenantId, line.id, body.date)
    const stored = await targetsOf(tx, [line.id], body.date)
    const plan = targetPlan(
      stored.map((row) => ({ id: row.id, hour: row.hour, targetPieces: row.targetPieces, version: row.version, reasonGiven: row.shortReasonAt !== null })),
      body.hours,
    )
    if (plan.stale) refuse({ code: 'STALE', message: `The target of ${hourLabel(plan.stale.hour)} changed since you read it (version ${plan.stale.stored}, not ${plan.stale.sent}).`, fix: 'Read the day again.' })
    if (plan.refusal) refuse(plan.refusal.refusal, hourLabel(plan.refusal.hour))
    const scope = { companyId: line.companyId, siteId: line.siteId }
    for (const entry of plan.create) {
      const id = newId()
      await tx.lineTarget.create({ data: { id, siteId: line.siteId, lineId: line.id, workDate: dayColumn(body.date), hour: entry.hour, targetPieces: entry.targetPieces, createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
      tools.audit({ recordType: 'LineTarget', recordId: id, ...scope, after: { lineId: line.id, workDate: body.date, hour: entry.hour, targetPieces: entry.targetPieces } })
    }
    for (const entry of plan.change) {
      const { count } = await tx.lineTarget.updateMany({ where: { id: entry.target.id, version: entry.target.version }, data: { targetPieces: entry.targetPieces, version: { increment: 1 }, updatedAt: now } })
      if (count !== 1) refuse({ code: 'STALE', message: `The target of ${hourLabel(entry.target.hour)} changed while saving.`, fix: 'Read the day again.' })
      tools.audit({ recordType: 'LineTarget', recordId: entry.target.id, ...scope, before: { targetPieces: entry.target.targetPieces }, after: { targetPieces: entry.targetPieces } })
    }
    for (const target of plan.remove) {
      const { count } = await tx.lineTarget.deleteMany({ where: { id: target.id, version: target.version, shortReasonAt: null } })
      if (count !== 1) refuse({ code: 'STALE', message: `The target of ${hourLabel(target.hour)} changed while saving.`, fix: 'Read the day again.' })
      tools.audit({ action: 'production.removeLineTarget', recordType: 'LineTarget', recordId: target.id, ...scope, before: { lineId: line.id, workDate: body.date, hour: target.hour, targetPieces: target.targetPieces } })
    }
    const set = [...plan.create.map((entry) => entry.hour), ...plan.change.map((entry) => entry.target.hour)].sort((a, b) => a - b)
    const removed = plan.remove.map((target) => target.hour).sort((a, b) => a - b)
    if (set.length === 0 && removed.length === 0) {
      // Nothing changed: the command still records what was asked (every command leaves an audit row).
      tools.audit({ recordType: 'Line', recordId: line.id, ...scope, after: { workDate: body.date, unchanged: plan.unchanged } })
    } else {
      tools.emit({ type: 'line_targets.changed', subject: line.id, ...scope, payload: { lineId: line.id, workDate: body.date, set, removed } })
    }
    const after = await targetsOf(tx, [line.id], body.date)
    return {
      line: { id: line.id, code: line.code, name: line.name },
      day: body.date,
      set,
      removed,
      unchanged: [...plan.unchanged],
      total: after.length ? after.reduce((sum, target) => sum + target.targetPieces, 0) : null,
    }
  })
  return { ...result, replayed }
}

export interface ReasonBody {
  readonly reasonCode: string
  readonly note?: string | undefined
  readonly version: number
}

/** POST /production/boards/targets/:targetId/reason (office and floor). */
export async function giveReason(caller: CommandCaller, targetId: string, body: ReasonBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  const known = await caller.withClient((db) => targetRow(db, targetId))
  if (!known) throw new NotFoundError('Target not found.')
  const line = (await knownLine(caller, context, known.lineId, PRODUCTION_BOARDS_VIEW)) as LineRow
  assertMay(context, PRODUCTION_BOARDS_REASON, { companyId: line.companyId, siteId: line.siteId }, 'Target')
  const code = body.reasonCode.trim().toUpperCase()
  const note = body.note && body.note.trim() !== '' ? body.note.trim() : null
  const day = isoDay(known.workDate)
  const now = serverClock.now()
  // The hour's output is the board's own count (the daily report's standing scans), read as the boards read it.
  const facts = await readerOf(caller, context).withClient(async (db) => {
    const site = (await siteRow(db, line.siteId))!
    const days = await lineDays(db, site, [line], day, now)
    return { site, day: days.days[0]!, reasons: days.reasons }
  })
  const row = facts.day.rows.find((entry) => entry.hour === known.hour)
  const done = row?.done ?? 0
  const span = hourSpan(day, known.hour, facts.site.timezone)
  const listed = facts.reasons.get(code)
  const refusal = shortReasonRefusal({ over: hourStateOf(span, now) === 'OVER', done, targetPieces: known.targetPieces, code: listed ? { active: listed.active, needsDetail: listed.needsDetail } : null, note })
  if (refusal) refuse(refusal, hourLabel(known.hour))

  const by = context.audience === 'floor' ? 'FLOOR' : 'OFFICE'
  const { result, replayed } = await command(
    caller,
    { name: 'production.giveShortHourReason', idempotencyKey, input: { targetId, ...body }, record: { type: 'LineTarget', id: targetId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now: at } = tools
      await lockLineDay(tx, context.tenantId, line.id, day)
      const current = (await targetRow(tx, targetId))!
      if (current.targetPieces !== known.targetPieces) refuse({ code: 'STALE', message: `The target of ${hourLabel(known.hour)} changed since you read it.`, fix: 'Read the hour again.' })
      const listedNow = await tx.reasonCode.findFirst({ where: { list: SHORT_REASON_LIST, code, active: true }, select: { id: true } })
      if (!listedNow) refuse(BOARD_REFUSALS.CODE_NOT_LISTED)
      await tx.lineTarget.updateMany({ where: { id: targetId }, data: { shortReasonCode: code, shortNote: note, shortReasonAt: at, shortReasonById: context.actorId, updatedAt: at } })
      tools.audit({
        recordType: 'LineTarget',
        recordId: targetId,
        companyId: line.companyId,
        siteId: line.siteId,
        before: { shortReasonCode: current.shortReasonCode, shortNote: current.shortNote },
        after: { shortReasonCode: code, shortNote: note, done, targetPieces: current.targetPieces },
      })
      tools.emit({ type: 'line_target.reason_given', subject: targetId, companyId: line.companyId, siteId: line.siteId, payload: { targetId, lineId: line.id, workDate: day, hour: known.hour, reasonCode: code, by } })
      return { version: tools.record!.version }
    },
  )
  const answer = await readerOf(caller, context).withClient(async (db) => {
    const days = await lineDays(db, facts.site, [line], day, serverClock.now())
    return hourView(days.days[0]!.rows.find((entry) => entry.hour === known.hour)!, days.reasons)
  })
  return { targetId, version: result.version, hour: answer, replayed }
}

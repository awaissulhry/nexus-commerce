import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PEOPLE_ATTENDANCE_VIEW } from '@nexus/factory-domain/people/clock/permissions'
import { blockingChecks, type LimitCheck } from '@nexus/factory-domain/people/limits/checks'
import { PEOPLE_OVERTIME_REVIEW } from '@nexus/factory-domain/people/overtime/permissions'
import { ENTRY_HOLD_WORDS, entryHolds, overtimeReasonProblems, yearOfDay, type EntryHold, type EntryStatus, type OvertimeClass } from '@nexus/factory-domain/people/overtime/rules'
import { TOO_FEW_WORDS, groupShown } from '@nexus/factory-domain/people/privacy/groups'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { assertVersion, dateOf, dayOf, may, officeOf, problemsError, refuse } from '../employees/access'
import { userNames } from '../employees/employees'
import { ownEmployeeId, rangeOf, requireAttendance, siteFor } from '../attendance/access'
import { lockPerson } from '../attendance/compute'
import { dayOfPerson, fullName, monthClosed, personOf, type Client } from '../attendance/store'
import { limitFacts, type LimitFacts } from '../limits/worked'
import { assertPersonDecides } from '../privacy/decide'
import { minimumGroupSizeFor, refusePersonKeys } from '../privacy/groups'
import { peopleFacts, type PlannedPerson } from '../shifts/planner'
import type { EntriesQuery, EntryCountsQuery } from './contract'
import { ENTRY_SELECT, type EntryRow } from './store'
import { emitEntry } from './sync'
import { timesheetCovering } from './timesheets'

/**
 * Overtime to approve (B-W2b-42; MES-229; design people.attendance "Overtime to approve", pop-up "Reject overtime"; D.Lgs.
 * 66/2003 art. 5), office only, behind the site's ATTENDANCE gate. Overtime is paid only after a person approved it.
 *
 *   GET  /people/overtime/entries                  the entries of a site and range: date, class, state, from a planned
 *                                                  request or not, a tone per limit; never a name or one person's minutes
 *                                                  (Owner answer W1); a person key is refused in words
 *   GET  /people/overtime/counts                   the tile "Overtime waiting approval", for groups of the minimum size
 *   GET  /people/overtime/entries/:entryId         one record: the person, the minutes, the planned request, the limits in
 *                                                  words, the decision, what holds it
 *   POST /people/overtime/entries/:entryId/approve approve (the day approved first; a limit that blocks needs a reason)
 *   POST /people/overtime/entries/:entryId/reject  reject, with the reason
 *   POST /people/overtime/entries/:entryId/reopen  take a decision back, with the reason
 *
 * Every decision names the person who made it (`assertPersonDecides`: OVERTIME_DECISION), never about their own overtime.
 * A BLOCK limit holds the approval with the reason in words; the hours were worked, so a person may still approve them by
 * saying why (`overrideReason`, kept on the audit row): worked time is never left unpaid by a setting.
 */

const READ = [PEOPLE_ATTENDANCE_VIEW] as const

const currentMember = (today: BusinessDate) => ({ since: { lte: dateOf(today) }, OR: [{ until: null }, { until: { gte: dateOf(today) } }] })

function selectionWhere(siteId: string, range: { from: BusinessDate; to: BusinessDate; today: BusinessDate }, filters: { teamId?: string | undefined; lineId?: string | undefined }): Prisma.OvertimeEntryWhereInput {
  const people: Prisma.EmployeeWhereInput[] = []
  if (filters.teamId) people.push({ teamMemberships: { some: { teamId: filters.teamId, ...currentMember(range.today) } } })
  if (filters.lineId) people.push({ homeLineId: filters.lineId })
  return { siteId, date: { gte: dateOf(range.from), lte: dateOf(range.to) }, ...(people.length > 0 ? { employee: { AND: people } } : {}) }
}

/** The cap is checked on the year's approved overtime with this entry in it. */
const capMinutes = (facts: LimitFacts, row: Pick<EntryRow, 'employeeId' | 'date' | 'minutes' | 'status'>): number => {
  const date = dayOf(row.date)
  const { approvedMinutes } = facts.overtimeOf(row.employeeId, yearOfDay(date))
  return approvedMinutes + (row.status === 'APPROVED' ? 0 : row.minutes)
}

// ---- the list ----------------------------------------------------------------------------------------------------------

export async function listEntries(caller: CommandCaller, query: EntriesQuery) {
  const context = officeOf(caller)
  refusePersonKeys({ filters: query.employeeId !== undefined ? ['employeeId'] : [], groupBy: query.groupBy ? [query.groupBy] : [] })
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, READ)
    await requireAttendance(db, site.id)
    const range = rangeOf(query, site.timezone)
    const limit = query.limit ?? 100
    const where: Prisma.OvertimeEntryWhereInput = {
      ...selectionWhere(site.id, range, query),
      ...(query.status ? { status: query.status } : {}),
      ...(query.class ? { kind: query.class } : {}),
      ...(query.planned ? { requestId: query.planned === 'true' ? { not: null } : null } : {}),
    }
    const cursor = query.cursor ? /^(\d{4}-\d{2}-\d{2})\|([0-9a-f-]{36})$/.exec(query.cursor) : null
    if (query.cursor && !cursor) throw new ValidationError('The cursor is not one this list gave.', [{ path: 'querystring/cursor', message: 'Use nextCursor as given.' }])
    const after: Prisma.OvertimeEntryWhereInput = cursor ? { OR: [{ date: { lt: dateOf(cursor[1]!) } }, { date: dateOf(cursor[1]!), id: { lt: cursor[2]! } }] } : {}
    const rows = await db.overtimeEntry.findMany({ where: { AND: [where, after] }, select: ENTRY_SELECT, orderBy: [{ date: 'desc' }, { id: 'desc' }], take: limit + 1 })
    const page = rows.slice(0, limit)
    const ids = [...new Set(page.map((row) => row.employeeId))]
    const people = ids.length === 0 ? [] : await peopleFacts(db, { id: { in: ids } })
    const byId = new Map(people.map((person) => [person.id, person]))
    const teams = ids.length === 0 ? [] : await db.teamMember.findMany({ where: { employeeId: { in: ids }, ...currentMember(range.today) }, select: { employeeId: true, teamId: true }, orderBy: [{ since: 'desc' }] })
    const teamOf = new Map<string, string>()
    for (const row of teams) if (!teamOf.has(row.employeeId)) teamOf.set(row.employeeId, row.teamId)
    const dates = page.map((row) => dayOf(row.date)).sort()
    const facts = page.length === 0 ? null : await limitFacts(db, people, { from: dates[0]!, to: dates.at(-1)! }, serverClock.now())
    const last = page.at(-1)
    return {
      siteId: site.id,
      from: range.from,
      to: range.to,
      entries: page.map((row) => {
        const person = byId.get(row.employeeId)
        const checks = facts && person ? facts.checksOf(person, dayOf(row.date), capMinutes(facts, row)) : []
        return {
          id: row.id,
          date: dayOf(row.date),
          siteId: row.siteId,
          teamId: teamOf.get(row.employeeId) ?? null,
          lineId: person?.homeLineId ?? null,
          class: row.kind as OvertimeClass,
          status: row.status as EntryStatus,
          requestId: row.requestId,
          checks: checks.map((check) => ({ rule: check.rule, state: check.state, level: check.level })),
          version: row.version,
        }
      }),
      nextCursor: rows.length > limit && last ? `${dayOf(last.date)}|${last.id}` : null,
      words: ["Overtime shows its state only: one person's overtime (the name, the minutes) opens one at a time (Statuto dei Lavoratori art. 4)."],
    }
  })
}

/** The tile: what waits, for groups of the company's minimum size or more (ANA-075). */
export async function entryCounts(caller: CommandCaller, query: EntryCountsQuery) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, READ)
    await requireAttendance(db, site.id)
    const range = rangeOf(query, site.timezone)
    const minimum = await minimumGroupSizeFor(db, site.companyId)
    const people = await db.employee.count({
      where: {
        AND: [
          { siteId: site.id, startDate: { lte: dateOf(range.to) }, OR: [{ endDate: null }, { endDate: { gte: dateOf(range.from) } }] },
          query.teamId ? { teamMemberships: { some: { teamId: query.teamId, ...currentMember(range.today) } } } : {},
          query.lineId ? { homeLineId: query.lineId } : {},
        ],
      },
    })
    if (!groupShown(people, minimum)) return { siteId: site.id, from: range.from, to: range.to, people: null, tooFew: true, words: TOO_FEW_WORDS, tiles: { waitingEntries: null, waitingMinutes: null, notPlanned: null } }
    const waiting: Prisma.OvertimeEntryWhereInput = { AND: [selectionWhere(site.id, range, query), { status: 'PENDING' }] }
    const sum = await db.overtimeEntry.aggregate({ where: waiting, _count: { _all: true }, _sum: { minutes: true } })
    const notPlanned = await db.overtimeEntry.count({ where: { AND: [waiting, { requestId: null }] } })
    return { siteId: site.id, from: range.from, to: range.to, people, tooFew: false, words: null, tiles: { waitingEntries: sum._count._all, waitingMinutes: sum._sum.minutes ?? 0, notPlanned } }
  })
}

// ---- one entry ---------------------------------------------------------------------------------------------------------

async function entryHead(db: Client, entryId: string) {
  return isUuid(entryId) ? db.overtimeEntry.findUnique({ where: { id: entryId }, select: ENTRY_SELECT }) : null
}

const iso = (value: Date | null): string | null => (value ? toUtcIso(value) : null)

/** The checks of an entry as they stand (the person's work around its day; the cap with it in). */
async function checksOfEntry(db: Client, row: EntryRow, person: PlannedPerson, now: Date): Promise<LimitCheck[]> {
  const date = dayOf(row.date)
  const facts = await limitFacts(db, [person], { from: date, to: date }, now)
  return facts.checksOf(person, date, capMinutes(facts, row))
}

async function holdsOf(db: Client, context: OfficeContext, row: EntryRow): Promise<EntryHold[]> {
  const date = dayOf(row.date)
  const day = await dayOfPerson(db, row.employeeId, date)
  return entryHolds({ status: row.status as EntryStatus, dayStatus: day?.status ?? null, own: (await ownEmployeeId(db, context)) === row.employeeId, monthClosed: await monthClosed(db, row.companyId, date) })
}

/** One entry as its record shows it (read with the caller's client, the gate checked before). */
async function recordOf(db: Client, context: OfficeContext, entryId: string) {
  const row = await db.overtimeEntry.findUnique({ where: { id: entryId }, select: ENTRY_SELECT })
  if (!row) throw new NotFoundError('Overtime not found.')
  const person = await personOf(db, row.employeeId)
  const [planned] = await peopleFacts(db, { id: row.employeeId })
  if (!person || !planned) throw new NotFoundError('Overtime not found.')
  const date = dayOf(row.date)
  const day = await dayOfPerson(db, row.employeeId, date)
  const request = row.requestId ? await db.overtimeRequest.findUnique({ where: { id: row.requestId }, select: { id: true, date: true, minutes: true, status: true } }) : null
  const checks = await checksOfEntry(db, row, planned, serverClock.now())
  const holds = await holdsOf(db, context, row)
  const names = await userNames(db, [row.approvedById, row.rejectedById])
  const place = { companyId: row.companyId, siteId: row.siteId }
  const closed = holds.includes('MONTH_CLOSED')
  const own = holds.includes('OWN_OVERTIME')
  const covered = await timesheetCovering(db, row.employeeId, date)
  const decides = may(context, PEOPLE_OVERTIME_REVIEW, place)
  const pendingAndHeld = holds.filter((hold) => hold !== 'NOT_PENDING')
  return {
    id: row.id,
    date,
    siteId: row.siteId,
    companyId: row.companyId,
    class: row.kind as OvertimeClass,
    minutes: row.minutes,
    status: row.status as EntryStatus,
    version: row.version,
    person: { employeeId: person.id, name: fullName(person), displayName: person.displayName, employeeCode: person.employeeCode },
    day: day ? { id: day.id, status: day.status, overtimeMinutes: day.overtimeMinutes, nightMinutes: day.nightMinutes, holidayMinutes: day.holidayMinutes, manual: day.manual } : null,
    request: request ? { id: request.id, date: dayOf(request.date), minutes: request.minutes, status: request.status } : null,
    /** Worked beyond what the person agreed to (a planned request): for the person who decides to see. */
    beyondRequestMinutes: request ? Math.max(0, row.minutes - request.minutes) : null,
    decision: { approvedAt: iso(row.approvedAt), approvedBy: row.approvedById ? (names.get(row.approvedById) ?? null) : null, rejectedAt: iso(row.rejectedAt), rejectedBy: row.rejectedById ? (names.get(row.rejectedById) ?? null) : null, rejectReason: row.rejectReason },
    checks: checks.map((check) => ({ ...check, values: { ...check.values } })),
    holds: holds.map((code) => ({ code, words: ENTRY_HOLD_WORDS[code] })),
    actions: {
      approve: holds.length === 0 && decides,
      reject: holds.length === 0 && decides,
      reopen: row.status !== 'PENDING' && !closed && !own && covered === null && decides,
    },
    words: [...(request ? [] : ['Nobody planned this overtime: no planned request names it.']), ...pendingAndHeld.map((code) => ENTRY_HOLD_WORDS[code])],
  }
}

/** GET /people/overtime/entries/:entryId: one record (the gate first). */
export async function entryDetail(caller: CommandCaller, entryId: string) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const head = await entryHead(db, entryId)
    if (!head || !may(context, PEOPLE_ATTENDANCE_VIEW, { companyId: head.companyId, siteId: head.siteId })) throw new NotFoundError('Overtime not found.')
    await requireAttendance(db, head.siteId)
    return recordOf(db, context, head.id)
  })
}

// ---- decisions ---------------------------------------------------------------------------------------------------------

/** The entry for a decision: the caller reads it and decides (403 in words), the gate on. */
async function entryForDecision(db: Client, context: OfficeContext, entryId: string): Promise<EntryRow> {
  const head = await entryHead(db, entryId)
  if (!head || !may(context, PEOPLE_ATTENDANCE_VIEW, { companyId: head.companyId, siteId: head.siteId })) throw new NotFoundError('Overtime not found.')
  if (!may(context, PEOPLE_OVERTIME_REVIEW, { companyId: head.companyId, siteId: head.siteId })) throw new DomainError('forbidden', 'Overtime is approved or rejected by a role with people.overtime.review.')
  await requireAttendance(db, head.siteId)
  return head
}

/** The entry as it stands in the command: the person's lock, the gate again (switched off since the read refuses), the version. */
async function entryInCommand(tools: CommandTools, context: OfficeContext, head: EntryRow, version: number): Promise<EntryRow> {
  await lockPerson(tools.tx, context.tenantId, head.employeeId)
  await requireAttendance(tools.tx, head.siteId)
  const row = await tools.tx.overtimeEntry.findUnique({ where: { id: head.id }, select: ENTRY_SELECT })
  if (!row) throw new NotFoundError('Overtime not found.')
  assertVersion('overtime entry', row.version, version)
  return row
}

const held = (holds: readonly EntryHold[]): void => {
  if (holds.length > 0) refuse('HELD', holds.map((code) => ENTRY_HOLD_WORDS[code]).join(' '), undefined, holds.map((code) => ({ path: `holds/${code}`, message: ENTRY_HOLD_WORDS[code] })))
}

/** A planned request whose overtime was all decided is DONE (its lock, then the row). */
async function settleRequest(tools: CommandTools, tx: CommandTx, tenantId: string, requestId: string | null): Promise<void> {
  if (!requestId) return
  await tx.$executeRaw`SELECT "factory_time_lock"('factory.time.overtime-request', ${tenantId}::uuid, ${requestId}::uuid)`
  const request = await tx.overtimeRequest.findUnique({ where: { id: requestId }, select: { id: true, companyId: true, siteId: true, lineId: true, date: true, status: true } })
  if (!request || request.status !== 'APPROVED') return
  if ((await tx.overtimeEntry.count({ where: { requestId, status: 'PENDING' } })) > 0) return
  await tx.overtimeRequest.update({ where: { id: requestId }, data: { status: 'DONE', doneAt: tools.now, version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
  const asked = await tx.overtimeAgreement.count({ where: { requestId } })
  const agreed = await tx.overtimeAgreement.count({ where: { requestId, answer: 'AGREED' } })
  tools.audit({ action: 'people.overtimeDone', recordType: 'OvertimeRequest', recordId: requestId, companyId: request.companyId, siteId: request.siteId, before: { status: 'APPROVED' }, after: { status: 'DONE' } })
  tools.emit({ type: 'overtime_request.changed', subject: requestId, companyId: request.companyId, siteId: request.siteId, payload: { requestId, lineId: request.lineId, date: dayOf(request.date), change: 'DONE', asked, agreed } })
}

/** POST /people/overtime/entries/:entryId/approve. */
export async function approveEntry(caller: CommandCaller, entryId: string, body: { readonly version: number; readonly overrideReason?: string | undefined }, key?: string) {
  const context = officeOf(caller)
  const head = await caller.withClient((db) => entryForDecision(db, context, entryId))
  if (body.overrideReason !== undefined) {
    const problems = overtimeReasonProblems(body.overrideReason, 'overrideReason')
    if (problems.length > 0) throw problemsError(problems, 'Say why it stands.')
  }
  await command(caller, { name: 'people.approveOvertimeEntry', idempotencyKey: key, input: { entryId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const actorId = assertPersonDecides(tools.context, 'OVERTIME_DECISION')
    const row = await entryInCommand(tools, context, head, body.version)
    held(await holdsOf(tx, context, row))
    const [person] = await peopleFacts(tx, { id: row.employeeId })
    if (!person) throw new NotFoundError('Overtime not found.')
    const checks = await checksOfEntry(tx, row, person, now)
    const blocked = blockingChecks(checks)
    if (blocked.length > 0 && body.overrideReason === undefined) {
      refuse('LIMIT_BLOCKED', `This overtime breaks a working-time limit People settings hold: ${blocked[0]!.words}. The hours were worked: say why it stands to approve it.`, undefined, blocked.map((check) => ({ path: `limits/${check.rule}`, message: check.words })))
    }
    await tx.overtimeEntry.update({ where: { id: row.id }, data: { status: 'APPROVED', approvedAt: now, approvedById: actorId, version: { increment: 1 } }, select: { id: true } })
    tools.audit({
      recordType: 'OvertimeEntry',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before: { status: row.status },
      after: { status: 'APPROVED', employeeId: row.employeeId, date: dayOf(row.date), kind: row.kind, minutes: row.minutes, checks: checks.map((check) => ({ rule: check.rule, state: check.state, level: check.level })) },
      ...(blocked.length > 0 ? { reason: body.overrideReason!.trim() } : {}),
    })
    emitEntry(tools, { ...row, kind: row.kind as OvertimeClass }, 'APPROVED', 'APPROVED')
    await settleRequest(tools, tx, context.tenantId, row.requestId)
    return { entryId: row.id }
  })
  return caller.withClient((db) => recordOf(db, context, head.id))
}

/** POST /people/overtime/entries/:entryId/reject: not paid; the reason is required. */
export async function rejectEntry(caller: CommandCaller, entryId: string, body: { readonly version: number; readonly reason: string }, key?: string) {
  const context = officeOf(caller)
  const head = await caller.withClient((db) => entryForDecision(db, context, entryId))
  const problems = overtimeReasonProblems(body.reason, 'reason')
  if (problems.length > 0) throw problemsError(problems, 'Say why it is rejected.')
  await command(caller, { name: 'people.rejectOvertimeEntry', idempotencyKey: key, input: { entryId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const actorId = assertPersonDecides(tools.context, 'OVERTIME_DECISION')
    const row = await entryInCommand(tools, context, head, body.version)
    held(await holdsOf(tx, context, row))
    const reason = body.reason.trim()
    await tx.overtimeEntry.update({ where: { id: row.id }, data: { status: 'REJECTED', rejectedAt: now, rejectedById: actorId, rejectReason: reason, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'OvertimeEntry', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'REJECTED', employeeId: row.employeeId, date: dayOf(row.date), kind: row.kind, minutes: row.minutes }, reason })
    emitEntry(tools, { ...row, kind: row.kind as OvertimeClass }, 'REJECTED', 'REJECTED')
    await settleRequest(tools, tx, context.tenantId, row.requestId)
    return { entryId: row.id }
  })
  return caller.withClient((db) => recordOf(db, context, head.id))
}

/** POST /people/overtime/entries/:entryId/reopen: a decision taken back, with the reason (refused under an approved timesheet). */
export async function reopenEntry(caller: CommandCaller, entryId: string, body: { readonly version: number; readonly reason: string }, key?: string) {
  const context = officeOf(caller)
  const head = await caller.withClient((db) => entryForDecision(db, context, entryId))
  const problems = overtimeReasonProblems(body.reason, 'reason')
  if (problems.length > 0) throw problemsError(problems, 'Say why it is taken back.')
  await command(caller, { name: 'people.reopenOvertimeEntry', idempotencyKey: key, input: { entryId, ...body } }, async (tools) => {
    const { tx } = tools
    assertPersonDecides(tools.context, 'OVERTIME_DECISION')
    const row = await entryInCommand(tools, context, head, body.version)
    const date = dayOf(row.date)
    if (row.status === 'PENDING') refuse('NOT_DECIDED', 'This overtime has not been decided: there is nothing to take back.')
    if ((await ownEmployeeId(tx, context)) === row.employeeId) refuse('OWN_OVERTIME', ENTRY_HOLD_WORDS.OWN_OVERTIME)
    if (await monthClosed(tx, row.companyId, date)) refuse('MONTH_CLOSED', ENTRY_HOLD_WORDS.MONTH_CLOSED)
    if ((await timesheetCovering(tx, row.employeeId, date)) !== null) refuse('TIMESHEET_APPROVED', 'A timesheet approved by the lead or HR covers this day: send it back first.')
    const reason = body.reason.trim()
    await tx.overtimeEntry.update({ where: { id: row.id }, data: { status: 'PENDING', approvedAt: null, approvedById: null, rejectedAt: null, rejectedById: null, rejectReason: null, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'OvertimeEntry', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { status: row.status }, after: { status: 'PENDING', employeeId: row.employeeId, date }, reason })
    emitEntry(tools, { ...row, kind: row.kind as OvertimeClass }, 'PENDING', 'REOPENED')
    return { entryId: row.id }
  })
  return caller.withClient((db) => recordOf(db, context, head.id))
}

import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { daysFrom, eachDay, isoWeekday, plusDays } from '@nexus/factory-domain/calendars/dates'
import type { Pattern } from '@nexus/factory-domain/calendars/patterns'
import { daysOf } from '@nexus/factory-domain/calendars/working-time'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { BUSINESS_TIME_ZONE, type BusinessDate } from '@nexus/factory-domain/core/time'
import { LIMIT_KINDS, type LimitRules } from '@nexus/factory-domain/people/shifts/limits'
import { PEOPLE_SHIFTS_MANAGE, PEOPLE_SHIFTS_TEAM, PEOPLE_SHIFTS_VIEW } from '@nexus/factory-domain/people/shifts/permissions'
import {
  cellWords,
  choicesOf,
  overtimeStageOf,
  sameCell,
  SHIFT_LIMITS,
  shiftFromPattern,
  windowProblems,
  type CellSource,
  type CellValue,
} from '@nexus/factory-domain/people/shifts/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { ownerKey, workingCalendarsFor } from '../../../platform/calendars/service'
import { actorIdOf, dateOf, may, officeOf, refuse, scopeOf, todayOf } from '../employees/access'
import { absencesFor, ATTENDANCE_CLOSED_WORDS, type Absences } from './attendance'
import { blocking, rosterCheck, type WarningOut } from './checks'
import type { AssignBody, CopyBody, ShiftSet } from './contract'
import { employmentIssue, fullName, peopleFacts, planningFor, type PlannedCell, type PlannedOvertime, type PlannedPerson, type Planning } from './planner'

/**
 * The roster sheet (B-W2b-32; MES-218; design people.shifts "Range and people", "Roster", pop-ups "Assign shifts", "Copy
 * last week", "Why this warning"), office only. people.shifts.view reads; a write needs people.shifts.manage over the
 * person (every roster in reach) or people.shifts.team for a person in a team the caller leads (design: "Leads edit their
 * team; others read"), checked per person with can() against their company and site.
 *
 *   GET  /people/shifts/roster                       a site's (or every site's in reach) people × days: each cell's
 *                                                    roster row or default shift, the planned overtime, the absences (behind
 *                                                    the ATTENDANCE gate), the warnings in words; the calendar's days, the
 *                                                    limits in force, the shift choices, people per shift per line and day
 *   POST /people/shifts/roster/cells                 autosave of one or more cells (a fill), each with the version read
 *   POST /people/shifts/roster/assign[/preview]      one shift (or a day off, or back to the default) for many people over
 *                                                    a range; the preview is the ReviewChangesModal
 *   POST /people/shifts/roster/copy-week[/preview]   last week's cells onto a week (conflicts with absences listed)
 *   POST /people/shifts/roster/publish               the DRAFT cells of a range become the roster the workers read
 *
 * A new or changed cell is a DRAFT; a published cell changed again stays published (the worker sees it at once); clearing
 * a cell returns the day to the default shift. A NEW warning whose rule blocks (People settings) holds the write (409
 * `refusal/LIMIT_BLOCKED`, the rule in words); a warning shows. No shift after a leaver's last working day, nor outside
 * the employment; nothing in a month whose attendance is closed. Each write is one command with an Idempotency-Key,
 * one audit row per person and the events shift.assigned / roster.published.
 *
 * Statuto dei Lavoratori art. 4 (Owner answers W1, F2): names appear inside the sheet; no figure about one person's work,
 * no filter or group by person. The footer is a headcount of the plan per line and shift.
 */

type Client = FactoryClient | CommandTx
type Value = CellValue | null

const VIEW_WORDS = 'You read this roster; planning it needs people.shifts.manage, or people.shifts.team for the teams you lead.'

function rangeIssue(from: BusinessDate, to: BusinessDate, where: 'querystring' | 'body'): void {
  if (to < from) throw new ValidationError('The range ends before it starts.', [{ path: `${where}/to`, message: 'On or after the start.' }])
  if (daysFrom(from, to) + 1 > SHIFT_LIMITS.rangeDays) throw new ValidationError(`A range covers at most ${SHIFT_LIMITS.rangeDays} days.`, [{ path: `${where}/to`, message: `At most ${SHIFT_LIMITS.rangeDays} days after the start.` }])
}

// ---- who may plan whom -------------------------------------------------------------------------------------------------

/** The people of the teams the caller leads today (their account's employee record is the team's lead). */
async function ledPeople(client: Client, context: OfficeContext, today: BusinessDate): Promise<Set<string>> {
  const me = await client.employee.findMany({ where: { userId: context.actorId, status: 'ACTIVE' }, select: { id: true } })
  if (me.length === 0) return new Set()
  const current = { since: { lte: dateOf(today) }, OR: [{ until: null }, { until: { gte: dateOf(today) } }] }
  const led = await client.teamMember.findMany({ where: { employeeId: { in: me.map((row) => row.id) }, isLead: true, ...current }, select: { teamId: true } })
  if (led.length === 0) return new Set()
  const members = await client.teamMember.findMany({ where: { teamId: { in: led.map((row) => row.teamId) }, ...current }, select: { employeeId: true } })
  return new Set(members.map((row) => row.employeeId))
}

/** Whether the caller may plan a person's roster: every roster in reach, or a team they lead. */
async function editRights(client: Client, context: OfficeContext, today: BusinessDate): Promise<(person: PlannedPerson) => boolean> {
  const led = await ledPeople(client, context, today)
  return (person) => may(context, PEOPLE_SHIFTS_MANAGE, person) || (may(context, PEOPLE_SHIFTS_TEAM, person) && led.has(person.id))
}

// ---- the people of a selection ----------------------------------------------------------------------------------------

interface Selection {
  readonly siteId?: string | undefined
  readonly lineId?: string | undefined
  readonly teamId?: string | undefined
  readonly employeeIds?: readonly string[] | undefined
  readonly from: BusinessDate
  readonly to: BusinessDate
}

/** The people a roster shows: employed some day of the range, at the sites in reach, by site, line, team or ids. */
async function selectPeople(client: Client, context: OfficeContext, selection: Selection, today: BusinessDate): Promise<PlannedPerson[]> {
  const current = { since: { lte: dateOf(today) }, OR: [{ until: null }, { until: { gte: dateOf(today) } }] }
  const where: Prisma.EmployeeWhereInput = {
    AND: [
      scopeOf(context, PEOPLE_SHIFTS_VIEW) as Prisma.EmployeeWhereInput,
      { startDate: { lte: dateOf(selection.to) }, OR: [{ endDate: null }, { endDate: { gte: dateOf(selection.from) } }] },
      selection.siteId ? { siteId: selection.siteId } : {},
      selection.lineId ? { OR: [{ homeLineId: selection.lineId }, { teamMemberships: { some: { ...current, team: { lineId: selection.lineId } } } }] } : {},
      selection.teamId ? { teamMemberships: { some: { ...current, teamId: selection.teamId } } } : {},
      selection.employeeIds ? { id: { in: [...selection.employeeIds] } } : {},
    ],
  }
  const people = await peopleFacts(client, where, SHIFT_LIMITS.rosterPeople + 1)
  if (people.length > SHIFT_LIMITS.rosterPeople) throw new ValidationError(`More than ${SHIFT_LIMITS.rosterPeople} people: narrow the roster by site, line or team.`, [{ path: 'querystring/siteId', message: 'Narrow by site, line or team.' }])
  return people
}

interface TeamOf {
  readonly team: { readonly id: string; readonly code: string; readonly name: string; readonly lineId: string | null }
  readonly isLead: boolean
}

async function teamsOf(client: Client, ids: readonly string[], today: BusinessDate): Promise<Map<string, TeamOf>> {
  if (ids.length === 0) return new Map()
  const rows = await client.teamMember.findMany({
    where: { employeeId: { in: [...ids] }, since: { lte: dateOf(today) }, OR: [{ until: null }, { until: { gte: dateOf(today) } }] },
    select: { employeeId: true, isLead: true, team: { select: { id: true, code: true, name: true, lineId: true } } },
    orderBy: [{ since: 'desc' }],
  })
  const out = new Map<string, TeamOf>()
  for (const row of rows) if (!out.has(row.employeeId)) out.set(row.employeeId, { team: row.team, isLead: row.isLead })
  return out
}

// ---- views -------------------------------------------------------------------------------------------------------------

export const valueView = (value: Value) => (value === null ? null : value.kind === 'OFF' ? { kind: 'OFF' as const, shift: null, patternId: null } : { kind: 'WORK' as const, shift: { ...value.shift }, patternId: value.patternId })

/** Agreed answers per request (the stage a cell shows). */
async function agreedCounts(client: Client, planning: Planning): Promise<Map<string, number>> {
  const ids = [...new Set([...planning.overtime.values()].flat().map((ask) => ask.requestId))]
  if (ids.length === 0) return new Map()
  const rows = await client.overtimeAgreement.groupBy({ by: ['requestId'], where: { requestId: { in: ids }, answer: 'AGREED' }, _count: { _all: true } })
  return new Map(rows.map((row) => [row.requestId, row._count._all]))
}

export function cellView(cell: PlannedCell, facts: { readonly overtime: readonly PlannedOvertime[]; readonly agreed: ReadonlyMap<string, number>; readonly absences: Absences; readonly employeeId: string; readonly warnings: readonly WarningOut[] }) {
  return {
    date: cell.date,
    source: cell.source,
    value: valueView(cell.value),
    issue: cell.issue,
    entry: cell.entry ? { id: cell.entry.id, status: cell.entry.status, version: cell.entry.version, note: cell.entry.note } : null,
    fallback: valueView(cell.fallback.value),
    open: cell.open,
    overtime: facts.overtime
      .filter((ask) => ask.date === cell.date)
      .map((ask) => ({ requestId: ask.requestId, agreementId: ask.agreementId, startMinute: ask.startMinute, minutes: ask.minutes, stage: overtimeStageOf(ask.status, facts.agreed.get(ask.requestId) ?? 0), answer: ask.answer })),
    absence: facts.absences.byPerson.get(facts.employeeId)?.get(cell.date) ?? null,
    warnings: facts.warnings.filter((warning) => warning.date === cell.date).map((warning) => ({ ...warning, values: { ...warning.values } })),
  }
}

const ruleView = (rules: LimitRules) =>
  LIMIT_KINDS.map((kind) => {
    const rule = rules[kind]
    return { kind, limitMinutes: rule.limitMinutes, breakMinutes: rule.breakMinutes, referenceMonths: rule.referenceMonths, action: rule.action, source: rule.source, legalReference: rule.legalReference, scope: rule.scope }
  })

/** The shift choices of the companies' patterns (ACTIVE, tenant-wide or of the company). */
async function choicesFor(client: Client, companyIds: readonly string[]) {
  const rows = await client.shiftPattern.findMany({
    where: { status: 'ACTIVE', OR: [{ companyId: null }, { companyId: { in: [...companyIds] } }] },
    select: { id: true, code: true, name: true, segments: { select: { weekday: true, kind: true, label: true, startMinute: true, endMinute: true } } },
    orderBy: { code: 'asc' },
  })
  return choicesOf(rows.map((row) => ({ id: row.id, code: row.code, name: row.name, segments: row.segments as Pattern['segments'] })))
}

// ---- the roster read ---------------------------------------------------------------------------------------------------

export interface RosterQuery {
  readonly siteId?: string | undefined
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly lineId?: string | undefined
  readonly teamId?: string | undefined
}

/** GET /people/shifts/roster. */
export async function readRoster(caller: CommandCaller, query: RosterQuery, now: Date = new Date()) {
  const context = officeOf(caller)
  rangeIssue(query.from, query.to, 'querystring')
  const today = todayOf(now)
  return caller.withClient(async (client) => {
    if (query.siteId) {
      const site = await client.site.findUnique({ where: { id: query.siteId }, select: { companyId: true } })
      if (!site || !may(context, PEOPLE_SHIFTS_VIEW, { companyId: site.companyId, siteId: query.siteId })) throw new NotFoundError('Site not found.')
    }
    const people = await selectPeople(client, context, query, today)
    const ids = people.map((person) => person.id)
    const teams = await teamsOf(client, ids, today)
    const check = await rosterCheck(client, people, { from: query.from, to: query.to })
    const absences = await absencesFor(client, people, { from: query.from, to: query.to })
    const agreed = await agreedCounts(client, check.planning)
    const canEdit = await editRights(client, context, today)
    const siteIds = [...new Set([...(query.siteId ? [query.siteId] : []), ...people.map((person) => person.siteId)])]
    const sites = siteIds.length === 0 ? [] : await client.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, code: true, name: true, companyId: true, timezone: true }, orderBy: { code: 'asc' } })
    const lineIds = [...new Set([...people.map((person) => person.homeLineId), ...[...teams.values()].map((entry) => entry.team.lineId)].filter((value): value is string => value !== null))]
    const lines = new Map((lineIds.length === 0 ? [] : await client.line.findMany({ where: { id: { in: lineIds } }, select: { id: true, code: true, name: true } })).map((line) => [line.id, line]))
    const patternIds = [...new Set(people.map((person) => person.defaultShiftPatternId).filter((value): value is string => value !== null))]
    const patterns = new Map((patternIds.length === 0 ? [] : await client.shiftPattern.findMany({ where: { id: { in: patternIds } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
    const calendars = await workingCalendarsFor(client, sites.map((site) => ({ scope: 'SITE' as const, id: site.id })), { from: query.from, to: query.to })
    const choices = await choicesFor(client, [...new Set(sites.map((site) => site.companyId))])
    const siteRef = new Map(sites.map((site) => [site.id, { id: site.id, code: site.code, name: site.name }]))
    const dates = eachDay(query.from, query.to)

    const rows = people.map((person) => {
      const team = teams.get(person.id) ?? null
      const lineId = team?.team.lineId ?? person.homeLineId
      const days = check.planning.cells.get(person.id)!
      const facts = { overtime: check.planning.overtime.get(person.id) ?? [], agreed, absences, employeeId: person.id, warnings: check.warnings.get(person.id) ?? [] }
      return {
        employeeId: person.id,
        name: fullName(person),
        displayName: person.displayName,
        site: siteRef.get(person.siteId) ?? { id: person.siteId, code: '', name: '' },
        line: lineId ? (lines.get(lineId) ?? null) : null,
        team: team ? { id: team.team.id, code: team.team.code, name: team.team.name } : null,
        isLead: team?.isLead ?? false,
        defaultPattern: person.defaultShiftPatternId ? (patterns.get(person.defaultShiftPatternId) ?? null) : null,
        lastWorkingDay: person.lastWorkingDay,
        canEdit: canEdit(person),
        cells: dates.map((date) => cellView(days.get(date)!, facts)),
      }
    })
    rows.sort((a, b) => a.site.code.localeCompare(b.site.code) || (a.line?.code ?? '~').localeCompare(b.line?.code ?? '~') || (a.team?.code ?? '~').localeCompare(b.team?.code ?? '~') || a.name.localeCompare(b.name))

    const footer = new Map<string, { siteId: string; lineId: string | null; date: string; shifts: Map<string, { label: string | null; startMinute: number; endMinute: number; people: number }>; off: number; none: number }>()
    for (const row of rows) {
      for (const cell of row.cells) {
        const key = `${row.site.id}|${row.line?.id ?? ''}|${cell.date}`
        const entry = footer.get(key) ?? { siteId: row.site.id, lineId: row.line?.id ?? null, date: cell.date, shifts: new Map(), off: 0, none: 0 }
        if (cell.value?.kind === 'WORK') {
          const shift = cell.value.shift
          const shiftKey = `${shift.label ?? ''}|${shift.startMinute}|${shift.endMinute}`
          const found = entry.shifts.get(shiftKey) ?? { label: shift.label, startMinute: shift.startMinute, endMinute: shift.endMinute, people: 0 }
          found.people += 1
          entry.shifts.set(shiftKey, found)
        } else if (cell.value?.kind === 'OFF') entry.off += 1
        else entry.none += 1
        footer.set(key, entry)
      }
    }
    const editable = rows.filter((row) => row.canEdit).length
    return {
      from: query.from,
      to: query.to,
      today,
      sites: sites.map((site) => {
        const calendar = calendars.get(ownerKey({ scope: 'SITE', id: site.id }))?.calendar
        const shown = absences.shown.get(site.id) ?? false
        return {
          site: siteRef.get(site.id)!,
          timeZone: site.timezone || BUSINESS_TIME_ZONE,
          days: calendar ? daysOf(calendar, query.from, query.to).map((day) => ({ date: day.date, weekday: day.weekday, open: day.open, reason: day.reason, name: day.name })) : [],
          rules: ruleView(check.rules({ companyId: site.companyId, siteId: site.id })),
          absences: { shown, words: shown ? null : ATTENDANCE_CLOSED_WORDS },
        }
      }),
      choices: choices.map((choice) => ({ ...choice, weekdays: [...choice.weekdays] })),
      rows,
      footer: [...footer.values()].map((entry) => ({ ...entry, shifts: [...entry.shifts.values()].sort((a, b) => a.startMinute - b.startMinute) })),
      canEdit: rows.length > 0 && editable === rows.length ? ('ALL' as const) : editable > 0 ? ('TEAM' as const) : ('NONE' as const),
    }
  })
}

// ---- what a write sets ------------------------------------------------------------------------------------------------

/** The value a set gives a date (pattern shifts read from the patterns given); throws a 400 at `path` when it cannot. */
function valueOfSet(set: ShiftSet | null, date: BusinessDate, patterns: ReadonlyMap<string, Pattern>, path: string): Value {
  if (set === null) return null
  if (set.kind === 'OFF') return { kind: 'OFF' }
  if (set.patternId) {
    const pattern = patterns.get(set.patternId)
    if (!pattern) throw new ValidationError('That shift pattern is not one of this company (or it is archived).', [{ path: `${path}/patternId`, message: 'Pick a shift of an active pattern of the company.' }])
    const shift = shiftFromPattern(pattern, date, { label: set.label ?? null, startMinute: set.startMinute })
    if (!shift) throw new ValidationError(`Pattern ${pattern.code} has no shift "${set.label ?? 'without a name'}".`, [{ path: `${path}/label`, message: `Pattern ${pattern.code} has no such shift.` }])
    return { kind: 'WORK', patternId: pattern.id, shift }
  }
  if (set.startMinute === undefined || set.endMinute === undefined) throw new ValidationError('A shift typed by hand has its start and end.', [{ path: `${path}/startMinute`, message: 'Required without a pattern.' }])
  const shift = { label: set.label ?? null, startMinute: set.startMinute, endMinute: set.endMinute, breakMinutes: set.breakMinutes ?? 0 }
  const problems = windowProblems(shift)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.map((problem) => ({ ...problem, path: `${path}/${problem.path}` })))
  return { kind: 'WORK', patternId: null, shift }
}

/** The ACTIVE patterns a person of these companies may take a shift from (tenant-wide or the company's). */
async function usablePatterns(client: Client, ids: readonly string[], companyIds: readonly string[]): Promise<Map<string, Pattern & { readonly companyId: string | null }>> {
  if (ids.length === 0) return new Map()
  const rows = await client.shiftPattern.findMany({
    where: { id: { in: [...ids] }, status: 'ACTIVE', OR: [{ companyId: null }, { companyId: { in: [...companyIds] } }] },
    select: { id: true, code: true, name: true, companyId: true, segments: { select: { weekday: true, kind: true, label: true, startMinute: true, endMinute: true } } },
  })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name, companyId: row.companyId, segments: row.segments as Pattern['segments'] }]))
}

const patternOf = (patterns: ReadonlyMap<string, Pattern & { readonly companyId: string | null }>, person: PlannedPerson) =>
  new Map([...patterns].filter(([, pattern]) => pattern.companyId === null || pattern.companyId === person.companyId))

// ---- the shared writer ------------------------------------------------------------------------------------------------

interface Change {
  readonly person: PlannedPerson
  readonly date: BusinessDate
  /** The new value; null: back to the default shift (the row removed). */
  readonly value: Value
  readonly note?: string | null | undefined
  /** The row version the write was read at (null: no row), when the write sends one. */
  readonly version?: number | null
  /** Its place in the body, for the issue paths. */
  readonly path?: string
}

/** Each person's roster writes take turns (a fill and an assignment of the same person queue). */
async function lockPeople(tx: CommandTx, tenantId: string, ids: Iterable<string>): Promise<void> {
  for (const id of [...new Set(ids)].sort()) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.people.roster', ${tenantId}::uuid, ${id}::uuid), 0))`
}

/** A month whose attendance is closed takes no roster change (its LUL calendar is out): 409 in words before the database's refusal. */
async function refuseClosedMonths(tx: CommandTx, changes: readonly Change[]): Promise<void> {
  const months = new Map<string, { companyId: string; month: string }>()
  for (const change of changes) months.set(`${change.person.companyId}|${change.date.slice(0, 7)}`, { companyId: change.person.companyId, month: `${change.date.slice(0, 7)}-01` })
  if (months.size === 0) return
  const closed = await tx.attendanceMonthClose.findMany({ where: { status: 'CLOSED', OR: [...months.values()].map((entry) => ({ companyId: entry.companyId, month: dateOf(entry.month) })) }, select: { month: true } })
  if (closed.length > 0) refuse('MONTH_CLOSED', `The attendance of ${closed.map((row) => row.month.toISOString().slice(0, 7)).join(', ')} is closed (its LUL calendar is out): its roster no longer changes.`)
}

const rowData = (value: Extract<CellValue, { kind: 'WORK' }> | { kind: 'OFF' }) =>
  value.kind === 'WORK'
    ? { kind: 'WORK' as const, shiftPatternId: value.patternId, shiftLabel: value.shift.label, startMinute: value.shift.startMinute, endMinute: value.shift.endMinute, breakMinutes: value.shift.breakMinutes }
    : { kind: 'OFF' as const, shiftPatternId: null, shiftLabel: null, startMinute: null, endMinute: null, breakMinutes: 0 }

interface Applied {
  readonly written: number
  readonly people: number
  /** The warnings of the people on the days written (after the write). */
  readonly warnings: number
}

/**
 * Writes the changes inside a command: the people locked, versions compared (when sent), the closed months refused, a new
 * blocking warning refused, then the rows inserted, updated or removed, one audit row per person, the events.
 */
async function applyChanges(tools: CommandTools, changes: readonly Change[], change: 'SET' | 'CLEARED' | 'ASSIGNED' | 'COPIED'): Promise<Applied> {
  const { tx, now } = tools
  const tenantId = (tools.context as { readonly tenantId: string }).tenantId
  const actorId = actorIdOf(tools.context)
  if (changes.length === 0) return { written: 0, people: 0, warnings: 0 }
  await lockPeople(tx, tenantId, changes.map((entry) => entry.person.id))
  await refuseClosedMonths(tx, changes)
  const rows = await tx.rosterEntry.findMany({
    where: { employeeId: { in: [...new Set(changes.map((entry) => entry.person.id))] }, date: { in: [...new Set(changes.map((entry) => entry.date))].map(dateOf) } },
    select: { id: true, employeeId: true, date: true, kind: true, shiftPatternId: true, shiftLabel: true, startMinute: true, endMinute: true, breakMinutes: true, status: true, note: true, version: true },
  })
  const existing = new Map(rows.map((row) => [`${row.employeeId}|${row.date.toISOString().slice(0, 10)}`, row]))
  const stale: Issue[] = []
  for (const entry of changes) {
    if (entry.version === undefined) continue
    const row = existing.get(`${entry.person.id}|${entry.date}`)
    if ((row?.version ?? null) !== entry.version) stale.push({ path: entry.path ?? 'cells', message: row ? `Changed since you read it (version ${row.version}).` : 'Cleared since you read it.' })
  }
  if (stale.length > 0) throw new DomainError('conflict', 'Someone changed these cells since you read them: read the roster again.', stale)

  // The warnings with and without the write; a new one whose rule blocks holds it.
  const people = [...new Map(changes.map((entry) => [entry.person.id, entry.person])).values()]
  const overrides = new Map<string, Map<BusinessDate, Value>>()
  for (const entry of changes) overrides.set(entry.person.id, (overrides.get(entry.person.id) ?? new Map()).set(entry.date, entry.value))
  const dates = changes.map((entry) => entry.date).sort()
  const check = await rosterCheck(tx, people, { from: dates[0]!, to: plusDays(dates.at(-1)!, 1) }, { overrides, compare: true })
  const held = blocking(check.warnings.values())
  if (held.length > 0) {
    const names = new Map(people.map((person) => [person.id, fullName(person)]))
    const issues = [...check.warnings.entries()].flatMap(([employeeId, list]) => list.filter((warning) => warning.isNew && warning.level === 'BLOCK').map((warning) => ({ path: `limits/${employeeId}/${warning.date}`, message: `${names.get(employeeId)}: ${warning.words}` })))
    refuse('LIMIT_BLOCKED', `The plan breaks a working-time limit People settings hold: ${held[0]!.words}`, undefined, issues)
  }

  let written = 0
  const byPerson = new Map<string, { person: PlannedPerson; cells: { date: BusinessDate; before: string; after: string }[]; published: boolean }>()
  const publishedChanged = new Map<string, { employeeIds: Set<string>; dates: BusinessDate[] }>()
  for (const entry of changes) {
    const row = existing.get(`${entry.person.id}|${entry.date}`)
    const before = row ? cellWords(row.kind === 'OFF' ? { kind: 'OFF' } : { kind: 'WORK', patternId: row.shiftPatternId, shift: { label: row.shiftLabel, startMinute: row.startMinute!, endMinute: row.endMinute!, breakMinutes: row.breakMinutes } }) : 'default'
    let after: string
    if (entry.value === null) {
      if (!row) continue
      await tx.rosterEntry.delete({ where: { id: row.id }, select: { id: true } })
      after = 'default'
    } else {
      const data = rowData(entry.value)
      const note = entry.note === undefined ? undefined : entry.note === null || entry.note.trim() === '' ? null : entry.note.trim()
      if (row) {
        const same = row.kind === data.kind && row.shiftLabel === data.shiftLabel && row.startMinute === data.startMinute && row.endMinute === data.endMinute && row.breakMinutes === data.breakMinutes && row.shiftPatternId === data.shiftPatternId && (note === undefined || note === row.note)
        if (same) continue
        await tx.rosterEntry.update({
          where: { id: row.id },
          data: { ...data, ...(note === undefined ? {} : { note }), version: { increment: 1 }, updatedAt: now, ...(row.status === 'PUBLISHED' ? { publishedAt: now, publishedById: actorId } : {}) },
          select: { id: true },
        })
      } else {
        await tx.rosterEntry.create({
          data: { id: newId(), companyId: entry.person.companyId, siteId: entry.person.siteId, employeeId: entry.person.id, date: dateOf(entry.date), ...data, note: note ?? null, status: 'DRAFT', createdAt: now, updatedAt: now, createdById: actorId },
          select: { id: true },
        })
      }
      after = cellWords(entry.value)
    }
    written += 1
    const person = byPerson.get(entry.person.id) ?? { person: entry.person, cells: [], published: false }
    person.cells.push({ date: entry.date, before, after })
    byPerson.set(entry.person.id, person)
    if (row?.status === 'PUBLISHED') {
      const site = publishedChanged.get(entry.person.siteId) ?? { employeeIds: new Set<string>(), dates: [] }
      site.employeeIds.add(entry.person.id)
      site.dates.push(entry.date)
      publishedChanged.set(entry.person.siteId, site)
    }
  }
  const bySite = new Map<string, { companyId: string; employeeIds: string[]; dates: BusinessDate[]; cells: number }>()
  for (const { person, cells } of byPerson.values()) {
    tools.audit({ recordType: 'Employee', recordId: person.id, companyId: person.companyId, siteId: person.siteId, after: { roster: cells } })
    const site = bySite.get(person.siteId) ?? { companyId: person.companyId, employeeIds: [], dates: [], cells: 0 }
    site.employeeIds.push(person.id)
    site.dates.push(...cells.map((cell) => cell.date))
    site.cells += cells.length
    bySite.set(person.siteId, site)
  }
  for (const [siteId, site] of bySite) {
    const sorted = [...site.dates].sort()
    tools.emit({ type: 'shift.assigned', subject: siteId, companyId: site.companyId, siteId, payload: { siteId, employeeIds: site.employeeIds, from: sorted[0]!, to: sorted.at(-1)!, cells: site.cells, change } })
  }
  for (const [siteId, site] of publishedChanged) {
    const sorted = [...site.dates].sort()
    tools.emit({ type: 'roster.published', subject: siteId, companyId: bySite.get(siteId)?.companyId ?? null, siteId, payload: { siteId, employeeIds: [...site.employeeIds], from: sorted[0]!, to: sorted.at(-1)!, cells: site.dates.length, change } })
  }
  if (written === 0) tools.audit({ recordType: 'Employee', recordId: changes[0]!.person.id, companyId: changes[0]!.person.companyId, siteId: changes[0]!.person.siteId, after: { roster: [], unchanged: true } })
  const shown = new Set(dates)
  const warnings = [...check.warnings.values()].flat().filter((warning) => shown.has(warning.date)).length
  return { written, people: byPerson.size, warnings }
}

// ---- cells (autosave) -------------------------------------------------------------------------------------------------

export interface CellsBody {
  readonly cells: readonly { readonly employeeId: string; readonly date: BusinessDate; readonly version: number | null; readonly set: ShiftSet | null; readonly note?: string | null | undefined }[]
}

/** The people a write names, each readable by the caller (else 404) and plannable (else 403 in words). */
async function writablePeople(client: Client, context: OfficeContext, ids: readonly string[], today: BusinessDate): Promise<Map<string, PlannedPerson>> {
  const unique = [...new Set(ids)]
  const people = await peopleFacts(client, { AND: [scopeOf(context, PEOPLE_SHIFTS_VIEW) as Prisma.EmployeeWhereInput, { id: { in: unique } }] })
  if (people.length !== unique.length) throw new NotFoundError('Employee not found.')
  const canEdit = await editRights(client, context, today)
  const refused = people.filter((person) => !canEdit(person))
  if (refused.length > 0) throw new ForbiddenError(`${VIEW_WORDS} (${refused.map(fullName).join(', ')})`)
  return new Map(people.map((person) => [person.id, person]))
}

/** POST /people/shifts/roster/cells: one or more cells (an autosave, a fill across days), all or none. */
export async function writeCells(caller: CommandCaller, body: CellsBody, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const seen = new Set<string>()
  body.cells.forEach((cell, index) => {
    const key = `${cell.employeeId}|${cell.date}`
    if (seen.has(key)) throw new ValidationError('A cell is named twice.', [{ path: `body/cells/${index}`, message: 'Each person and day once.' }])
    seen.add(key)
  })
  const today = todayOf(now)
  const { result } = await command(caller, { name: 'people.setRosterCells', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const people = await writablePeople(tx, context, body.cells.map((cell) => cell.employeeId), today)
    const patterns = await usablePatterns(tx, body.cells.flatMap((cell) => (cell.set?.kind === 'WORK' && cell.set.patternId ? [cell.set.patternId] : [])), [...new Set([...people.values()].map((person) => person.companyId))])
    const changes: Change[] = body.cells.map((cell, index) => {
      const person = people.get(cell.employeeId)!
      const path = `body/cells/${index}`
      const value = valueOfSet(cell.set, cell.date, patternOf(patterns, person), `${path}/set`)
      const issue = employmentIssue(person, cell.date)
      if (issue && value !== null && value.kind === 'WORK') {
        refuse(issue, issue === 'NOT_EMPLOYED' ? `${fullName(person)} does not work for the company on ${cell.date}.` : `${fullName(person)} is leaving: their last working day is ${person.lastWorkingDay}, no shift after it.`, `cells/${index}`)
      }
      return { person, date: cell.date, value, note: cell.note, version: cell.version, path }
    })
    const applied = await applyChanges(tools, changes, changes.every((entry) => entry.value === null) ? 'CLEARED' : 'SET')
    // The cells as they are now, for the sheet.
    const dates = body.cells.map((cell) => cell.date).sort()
    const changedPeople = [...people.values()]
    const check = await rosterCheck(tx, changedPeople, { from: dates[0]!, to: dates.at(-1)! })
    const absences = await absencesFor(tx, changedPeople, { from: dates[0]!, to: dates.at(-1)! })
    const agreed = await agreedCounts(tx, check.planning)
    return {
      cells: body.cells.map((cell) => {
        const person = people.get(cell.employeeId)!
        const facts = { overtime: check.planning.overtime.get(person.id) ?? [], agreed, absences, employeeId: person.id, warnings: check.warnings.get(person.id) ?? [] }
        return { employeeId: person.id, name: fullName(person), date: cell.date, cell: cellView(check.planning.cells.get(person.id)!.get(cell.date)!, facts) }
      }),
      warnings: applied.warnings,
    }
  })
  return result
}

// ---- assign and copy: plans with a preview ---------------------------------------------------------------------------

interface Plan {
  readonly changes: Change[]
  readonly skipped: { readonly person: PlannedPerson; readonly date: BusinessDate; readonly why: 'NOT_EMPLOYED' | 'AFTER_LAST_DAY' | 'CLOSED' | 'ABSENT' | 'NO_EDIT' }[]
  readonly before: Map<string, Map<BusinessDate, PlannedCell>>
  readonly absencesShown: boolean
}

function cellAfter(change: Change, before: PlannedCell): { value: Value; source: CellSource } {
  if (change.value === null) return { value: before.fallback.value, source: before.fallback.value === null ? 'NONE' : 'DEFAULT' }
  return { value: change.value, source: 'ROSTER' }
}

async function previewOf(client: Client, plan: Plan) {
  const people = [...new Map(plan.changes.map((change) => [change.person.id, change.person])).values()]
  const overrides = new Map<string, Map<BusinessDate, Value>>()
  for (const change of plan.changes) overrides.set(change.person.id, (overrides.get(change.person.id) ?? new Map()).set(change.date, change.value))
  const dates = plan.changes.map((change) => change.date).sort()
  const check = dates.length === 0 ? null : await rosterCheck(client, people, { from: dates[0]!, to: plusDays(dates.at(-1)!, 1) }, { overrides, compare: true })
  const names = new Map(people.map((person) => [person.id, fullName(person)]))
  const warnings = check ? [...check.warnings.entries()].flatMap(([employeeId, list]) => list.filter((warning) => warning.isNew).map((warning) => ({ employeeId, name: names.get(employeeId)!, warning: { ...warning, values: { ...warning.values } } }))) : []
  return {
    changes: plan.changes.map((change) => {
      const before = plan.before.get(change.person.id)!.get(change.date)!
      const after = cellAfter(change, before)
      return { employeeId: change.person.id, name: fullName(change.person), date: change.date, from: valueView(before.value), fromSource: before.source, to: valueView(after.value), toSource: after.source }
    }),
    skipped: plan.skipped.map((entry) => ({ employeeId: entry.person.id, name: fullName(entry.person), date: entry.date, why: entry.why })),
    warnings,
    blocked: warnings.filter((entry) => entry.warning.level === 'BLOCK').length,
    people: new Set(plan.changes.map((change) => change.person.id)).size,
    absences: { shown: plan.absencesShown, words: plan.absencesShown ? null : ATTENDANCE_CLOSED_WORDS },
  }
}

async function assignPlan(client: Client, context: OfficeContext, body: AssignBody, today: BusinessDate): Promise<Plan> {
  rangeIssue(body.from, body.to, 'body')
  const unique = [...new Set(body.employeeIds)]
  const people = await peopleFacts(client, { AND: [scopeOf(context, PEOPLE_SHIFTS_VIEW) as Prisma.EmployeeWhereInput, { id: { in: unique } }] })
  if (people.length !== unique.length) throw new NotFoundError('Employee not found.')
  const canEdit = await editRights(client, context, today)
  const patterns = await usablePatterns(client, body.set?.kind === 'WORK' && body.set.patternId ? [body.set.patternId] : [], [...new Set(people.map((person) => person.companyId))])
  const window = { from: body.from, to: body.to }
  const before = await planningFor(client, people, window)
  const absences = await absencesFor(client, people, window)
  const weekdays = new Set(body.weekdays ?? [1, 2, 3, 4, 5, 6, 7])
  const skipClosed = body.skipClosedDays ?? true
  const changes: Change[] = []
  const skipped: Plan['skipped'] = []
  for (const person of people) {
    const days = before.cells.get(person.id)!
    for (const date of eachDay(body.from, body.to)) {
      if (!weekdays.has(isoWeekday(date))) continue
      const cell = days.get(date)!
      const value = valueOfSet(body.set, date, patternOf(patterns, person), 'body/set')
      if (value === null ? cell.entry === null : cell.source === 'ROSTER' && sameCell(cell.value, value)) continue
      if (!canEdit(person)) {
        skipped.push({ person, date, why: 'NO_EDIT' })
        continue
      }
      const issue = employmentIssue(person, date)
      if (issue && value !== null) {
        skipped.push({ person, date, why: issue })
        continue
      }
      if (value?.kind === 'WORK' && skipClosed && !cell.open) {
        skipped.push({ person, date, why: 'CLOSED' })
        continue
      }
      if (value?.kind === 'WORK' && absences.byPerson.get(person.id)?.has(date)) {
        skipped.push({ person, date, why: 'ABSENT' })
        continue
      }
      changes.push({ person, date, value })
    }
  }
  return { changes, skipped, before: before.cells as Map<string, Map<BusinessDate, PlannedCell>>, absencesShown: people.every((person) => absences.shown.get(person.siteId) === true) }
}

/** POST /people/shifts/roster/assign/preview: the cells that would change (ReviewChangesModal), the days left and the new warnings. */
export async function previewAssign(caller: CommandCaller, body: AssignBody, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => previewOf(client, await assignPlan(client, context, body, todayOf(now))))
}

/** POST /people/shifts/roster/assign: the preview's changes, in one command. */
export async function applyAssign(caller: CommandCaller, body: AssignBody, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const { result } = await command(caller, { name: 'people.assignShifts', idempotencyKey, input: body }, async (tools) => {
    const plan = await assignPlan(tools.tx, context, body, todayOf(now))
    const refused = plan.skipped.filter((entry) => entry.why === 'NO_EDIT')
    if (refused.length > 0) throw new ForbiddenError(`${VIEW_WORDS} (${[...new Set(refused.map((entry) => fullName(entry.person)))].join(', ')})`)
    const applied = await applyChanges(tools, plan.changes, 'ASSIGNED')
    return { changed: applied.written, people: applied.people, skipped: plan.skipped.length, warnings: applied.warnings }
  })
  return result
}

async function copyPlan(client: Client, context: OfficeContext, body: CopyBody, today: BusinessDate): Promise<Plan> {
  if (isoWeekday(body.week) !== 1) throw new ValidationError('A week starts on a Monday.', [{ path: 'body/week', message: 'Pick the Monday of the week to fill.' }])
  const site = await client.site.findUnique({ where: { id: body.siteId }, select: { companyId: true } })
  if (!site || !may(context, PEOPLE_SHIFTS_VIEW, { companyId: site.companyId, siteId: body.siteId })) throw new NotFoundError('Site not found.')
  const source = { from: plusDays(body.week, -7), to: plusDays(body.week, -1) }
  const window = { from: source.from, to: plusDays(body.week, 6) }
  const people = await selectPeople(client, context, { siteId: body.siteId, lineId: body.lineId, teamId: body.teamId, employeeIds: body.employeeIds, from: window.from, to: window.to }, today)
  const canEdit = await editRights(client, context, today)
  const before = await planningFor(client, people, window)
  const absences = await absencesFor(client, people, { from: body.week, to: window.to })
  // A copied shift keeps its pattern only while the pattern may still be used (an archived one: the window, typed).
  const patternIds = [...new Set([...before.cells.values()].flatMap((days) => [...days.values()].flatMap((cell) => (cell.source === 'ROSTER' && cell.value?.kind === 'WORK' && cell.value.patternId ? [cell.value.patternId] : []))))]
  const usable = await usablePatterns(client, patternIds, [...new Set(people.map((person) => person.companyId))])
  const changes: Change[] = []
  const skipped: Plan['skipped'] = []
  for (const person of people) {
    const days = before.cells.get(person.id)!
    for (let offset = 0; offset < 7; offset++) {
      const from = days.get(plusDays(source.from, offset))!
      const date = plusDays(body.week, offset)
      const target = days.get(date)!
      let value: Value = from.source === 'ROSTER' ? from.value : null
      if (value?.kind === 'WORK' && value.patternId) {
        const pattern = usable.get(value.patternId)
        if (!pattern || (pattern.companyId !== null && pattern.companyId !== person.companyId)) value = { ...value, patternId: null }
      }
      if (value === null ? target.entry === null : target.source === 'ROSTER' && sameCell(target.value, value)) continue
      if (!canEdit(person)) {
        skipped.push({ person, date, why: 'NO_EDIT' })
        continue
      }
      const issue = employmentIssue(person, date)
      if (issue && value !== null) {
        skipped.push({ person, date, why: issue })
        continue
      }
      if (value?.kind === 'WORK' && !target.open) {
        skipped.push({ person, date, why: 'CLOSED' })
        continue
      }
      if (value?.kind === 'WORK' && absences.byPerson.get(person.id)?.has(date)) {
        skipped.push({ person, date, why: 'ABSENT' })
        continue
      }
      changes.push({ person, date, value })
    }
  }
  return { changes, skipped, before: before.cells as Map<string, Map<BusinessDate, PlannedCell>>, absencesShown: absences.shown.get(body.siteId) === true }
}

/** POST /people/shifts/roster/copy-week/preview. */
export async function previewCopyWeek(caller: CommandCaller, body: CopyBody, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => previewOf(client, await copyPlan(client, context, body, todayOf(now))))
}

/** POST /people/shifts/roster/copy-week: last week's cells onto the week, in one command (the people the caller may plan). */
export async function applyCopyWeek(caller: CommandCaller, body: CopyBody, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  const { result } = await command(caller, { name: 'people.copyRosterWeek', idempotencyKey, input: body }, async (tools) => {
    const plan = await copyPlan(tools.tx, context, body, todayOf(now))
    if (plan.changes.length === 0 && plan.skipped.some((entry) => entry.why === 'NO_EDIT')) throw new ForbiddenError(VIEW_WORDS)
    const applied = await applyChanges(tools, plan.changes, 'COPIED')
    return { changed: applied.written, people: applied.people, skipped: plan.skipped.length, warnings: applied.warnings }
  })
  return result
}

// ---- publish ----------------------------------------------------------------------------------------------------------

export interface PublishBody extends Selection {
  readonly siteId: string
}

/** POST /people/shifts/roster/publish: the DRAFT cells of a range (of the people the caller may plan) become the roster the workers read. */
export async function publishRoster(caller: CommandCaller, body: PublishBody, idempotencyKey?: string, now: Date = new Date()) {
  const context = officeOf(caller)
  rangeIssue(body.from, body.to, 'body')
  const today = todayOf(now)
  const { result } = await command(caller, { name: 'people.publishRoster', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const tenantId = (tools.context as { readonly tenantId: string }).tenantId
    const site = await tx.site.findUnique({ where: { id: body.siteId }, select: { companyId: true } })
    if (!site || !may(context, PEOPLE_SHIFTS_VIEW, { companyId: site.companyId, siteId: body.siteId })) throw new NotFoundError('Site not found.')
    const selected = await selectPeople(tx, context, body, today)
    const canEdit = await editRights(tx, context, today)
    const people = selected.filter(canEdit)
    if (people.length === 0) throw new ForbiddenError(VIEW_WORDS)
    await lockPeople(tx, tenantId, people.map((person) => person.id))
    const drafts = await tx.rosterEntry.findMany({
      where: { employeeId: { in: people.map((person) => person.id) }, status: 'DRAFT', date: { gte: dateOf(body.from), lte: dateOf(body.to) } },
      select: { id: true, employeeId: true, date: true },
      orderBy: [{ date: 'asc' }],
    })
    const check = await rosterCheck(tx, people, { from: body.from, to: body.to })
    const draftDays = new Set(drafts.map((row) => `${row.employeeId}|${row.date.toISOString().slice(0, 10)}`))
    const held = [...check.warnings.entries()].flatMap(([employeeId, list]) => list.filter((warning) => warning.level === 'BLOCK' && draftDays.has(`${employeeId}|${warning.date}`)).map((warning) => ({ employeeId, warning })))
    if (held.length > 0) {
      const names = new Map(people.map((person) => [person.id, fullName(person)]))
      refuse('LIMIT_BLOCKED', `The roster breaks a working-time limit People settings hold: ${held[0]!.warning.words}`, undefined, held.map(({ employeeId, warning }) => ({ path: `limits/${employeeId}/${warning.date}`, message: `${names.get(employeeId)}: ${warning.words}` })))
    }
    const actorId = actorIdOf(tools.context)
    if (drafts.length > 0) {
      await tx.rosterEntry.updateMany({ where: { id: { in: drafts.map((row) => row.id) } }, data: { status: 'PUBLISHED', publishedAt: tools.now, publishedById: actorId, version: { increment: 1 }, updatedAt: tools.now } })
    }
    const byPerson = new Map<string, BusinessDate[]>()
    for (const row of drafts) byPerson.set(row.employeeId, [...(byPerson.get(row.employeeId) ?? []), row.date.toISOString().slice(0, 10)])
    for (const person of people) {
      const dates = byPerson.get(person.id)
      if (dates) tools.audit({ recordType: 'Employee', recordId: person.id, companyId: person.companyId, siteId: person.siteId, after: { published: dates } })
    }
    if (drafts.length === 0) tools.audit({ recordType: 'Site', recordId: body.siteId, companyId: site.companyId, siteId: body.siteId, after: { published: [], from: body.from, to: body.to } })
    else {
      const dates = drafts.map((row) => row.date.toISOString().slice(0, 10))
      tools.emit({ type: 'roster.published', subject: body.siteId, companyId: site.companyId, siteId: body.siteId, payload: { siteId: body.siteId, employeeIds: [...byPerson.keys()], from: dates[0]!, to: dates.at(-1)!, cells: drafts.length, change: 'PUBLISHED' } })
    }
    const warnings = [...check.warnings.values()].flat().length
    return { published: drafts.length, people: byPerson.size, warnings }
  })
  return result
}

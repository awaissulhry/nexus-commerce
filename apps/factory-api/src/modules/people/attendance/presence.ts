import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { PEOPLE_ATTENDANCE_ROLLCALL } from '@nexus/factory-domain/people/attendance/permissions'
import { presenceOf, ROLL_CALL_WORDS, type PersonIn } from '@nexus/factory-domain/people/attendance/presence'
import { CLOCK_RULES, standingOf } from '@nexus/factory-domain/people/clock/rules'
import { PEOPLE_ATTENDANCE_VIEW } from '@nexus/factory-domain/people/clock/permissions'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { officeOf } from '../employees/access'
import { minimumGroupSizeFor } from '../privacy/groups'
import { requireAttendance, siteFor } from './access'
import { EVENT_SELECT, factOf, fullName, type Client, type EventRow, type SiteRow } from './store'

/**
 * Who is in now (B-W2b-37; MES-233; design people.attendance "Who is in now", new tab "Roll call"), office only, behind
 * the site's ATTENDANCE gate.
 *
 *   GET  /people/attendance/who-is-in   counts per site, area and line (people.attendance.view or the roll call's
 *                                       permission); a group under the company's minimum size shows no count (ANA-075)
 *   POST /people/attendance/roll-call   the names of the people clocked in now, by area and line, for an evacuation
 *                                       (D.Lgs. 81/2008 art. 43); people.attendance.rollcall; every opening is recorded
 *                                       (audit people.attendance.rollCall: who, which site, how many)
 *
 * A person is in when their latest counted clock event at the site (the last 36 hours) leaves them in or on a break and
 * the clock-in is younger than 13 hours (B-W2b-33's `standingOf`). Their line: a running loan's, else their home line
 * (when it is at this site), else the line of the tablet they clocked in on.
 */

interface InNow extends PersonIn {
  readonly name: string
}

/** The people in now at a site, with their line and area (optionally only a team's or a line's). */
export async function presenceAt(db: Client, site: SiteRow, now: Date, filters: { readonly teamId?: string | undefined; readonly lineId?: string | undefined } = {}): Promise<InNow[]> {
  const since = new Date(now.getTime() - CLOCK_RULES.readBackHours * 3_600_000)
  const rows = await db.clockEvent.findMany({ where: { siteId: site.id, occurredAt: { gte: since, lte: now } }, select: EVENT_SELECT, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })
  const byPerson = new Map<string, EventRow[]>()
  for (const row of rows) byPerson.set(row.employeeId, [...(byPerson.get(row.employeeId) ?? []), row])
  const inside: { employeeId: string; onBreak: boolean; openEvent: EventRow | null }[] = []
  for (const [employeeId, events] of byPerson) {
    const standing = standingOf(events.map(factOf), now)
    if (standing.state === 'OUT') continue
    inside.push({ employeeId, onBreak: standing.state === 'ON_BREAK', openEvent: events.find((event) => event.id === standing.openEventId) ?? null })
  }
  if (inside.length === 0) return []
  const ids = inside.map((entry) => entry.employeeId)
  const people = await db.employee.findMany({ where: { id: { in: ids } }, select: { id: true, siteId: true, homeLineId: true, firstName: true, lastName: true } })
  const loans = await db.lineLoan.findMany({ where: { employeeId: { in: ids }, siteId: site.id, startsAt: { lte: now }, endsAt: { gt: now } }, select: { employeeId: true, toLineId: true } })
  const devices = [...new Set(inside.map((entry) => entry.openEvent?.deviceId).filter((id): id is string => typeof id === 'string'))]
  const deviceLines = devices.length === 0 ? [] : await db.device.findMany({ where: { id: { in: devices } }, select: { id: true, lineId: true } })
  const lines = await db.line.findMany({ where: { siteId: site.id }, select: { id: true, areaId: true } })
  const areaOf = new Map(lines.map((line) => [line.id, line.areaId]))
  const personOf = new Map(people.map((person) => [person.id, person]))
  const loanOf = new Map(loans.map((loan) => [loan.employeeId, loan.toLineId]))
  const deviceLineOf = new Map(deviceLines.map((device) => [device.id, device.lineId]))
  let teamPeople: Set<string> | null = null
  if (filters.teamId) {
    const today = new Date(`${businessDate(now, site.timezone)}T00:00:00.000Z`)
    const members = await db.teamMember.findMany({ where: { teamId: filters.teamId, since: { lte: today }, OR: [{ until: null }, { until: { gte: today } }] }, select: { employeeId: true } })
    teamPeople = new Set(members.map((row) => row.employeeId))
  }
  return inside
    .map((entry) => {
      const person = personOf.get(entry.employeeId)
      const home = person && person.siteId === site.id ? person.homeLineId : null
      const deviceLine = entry.openEvent?.deviceId ? (deviceLineOf.get(entry.openEvent.deviceId) ?? null) : null
      const lineId = loanOf.get(entry.employeeId) ?? home ?? deviceLine ?? null
      return { employeeId: entry.employeeId, lineId, areaId: lineId ? (areaOf.get(lineId) ?? null) : null, onBreak: entry.onBreak, name: person ? fullName(person) : '—' }
    })
    .filter((entry) => (filters.lineId ? entry.lineId === filters.lineId : true) && (teamPeople ? teamPeople.has(entry.employeeId) : true))
}

async function placeNames(db: Client, siteId: string) {
  const lines = await db.line.findMany({ where: { siteId }, select: { id: true, code: true, name: true, areaId: true } })
  const areas = await db.orgArea.findMany({ where: { siteId }, select: { id: true, code: true, name: true } })
  return { lines: new Map(lines.map((line) => [line.id, { code: line.code, name: line.name, areaId: line.areaId }])), areas: new Map(areas.map((area) => [area.id, { code: area.code, name: area.name }])) }
}

/** GET /people/attendance/who-is-in: counts per site, area and line (small groups hidden). */
export async function whoIsIn(caller: CommandCaller, query: { readonly siteId: string }) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const site = await siteFor(db, context, query.siteId, [PEOPLE_ATTENDANCE_VIEW, PEOPLE_ATTENDANCE_ROLLCALL])
    await requireAttendance(db, site.id)
    const now = serverClock.now()
    const people = await presenceAt(db, site, now)
    const presence = presenceOf(people, await placeNames(db, site.id), await minimumGroupSizeFor(db, site.companyId))
    return { siteId: site.id, asOf: toUtcIso(now), people: presence.people, tooFew: presence.tooFew, areas: presence.areas, words: presence.words }
  })
}

/** POST /people/attendance/roll-call: the names of the people in now, recorded as one opening (who, which site, how many). */
export async function rollCall(caller: CommandCaller, body: { readonly siteId: string }, key?: string) {
  const context = officeOf(caller)
  const site = await caller.withClient((db) => siteFor(db, context, body.siteId, [PEOPLE_ATTENDANCE_ROLLCALL]))
  const { result } = await command(caller, { name: 'people.attendanceRollCall', idempotencyKey: key, input: body }, async (tools) => {
    await requireAttendance(tools.tx, site.id)
    const people = await presenceAt(tools.tx, site, tools.now)
    const names = await placeNames(tools.tx, site.id)
    const groups = new Map<string, { areaId: string | null; areaName: string | null; lineId: string | null; lineName: string | null; people: { employeeId: string; name: string; onBreak: boolean }[] }>()
    for (const person of [...people].sort((a, b) => a.name.localeCompare(b.name))) {
      const key = `${person.areaId ?? ''}|${person.lineId ?? ''}`
      const group = groups.get(key) ?? { areaId: person.areaId, areaName: person.areaId ? (names.areas.get(person.areaId)?.name ?? null) : null, lineId: person.lineId, lineName: person.lineId ? (names.lines.get(person.lineId)?.name ?? null) : null, people: [] }
      group.people.push({ employeeId: person.employeeId, name: person.name, onBreak: person.onBreak })
      groups.set(key, group)
    }
    tools.audit({ action: 'people.attendanceRollCall', recordType: 'Site', recordId: site.id, companyId: site.companyId, siteId: site.id, after: { people: people.length, purpose: 'EVACUATION' } })
    return { siteId: site.id, asOf: toUtcIso(tools.now), people: people.length, groups: [...groups.values()].sort((a, b) => (a.areaName ?? '~').localeCompare(b.areaName ?? '~') || (a.lineName ?? '~').localeCompare(b.lineName ?? '~')), words: ROLL_CALL_WORDS }
  })
  return result
}

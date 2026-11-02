import { localInstant, plusDays } from '@nexus/factory-domain/calendars/dates'
import { dayOf as calendarDayOf, OutsideWindowError, workingMinutesBetween, type WorkingCalendar, type WorkingShift } from '@nexus/factory-domain/calendars/working-time'
import { gateClosedWords } from '@nexus/factory-domain/people/privacy/gate'
import { lineLoad, plannedWhy, presenceOf, needsReassign, PRESENCE_WORDS, type LineLoad, type PresenceState } from '@nexus/factory-domain/production/dispatch/load'
import { assignmentKindOf } from '@nexus/factory-domain/production/dispatch/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { ownerKey, workingCalendarsFor } from '../../../platform/calendars/service'
import { presenceAt } from '../../people/attendance/presence'
import { legalGateFor } from '../../people/privacy/gate'
import { minimumGroupSizeFor } from '../../people/privacy/groups'
import { peopleFacts, planningFor } from '../../people/shifts/planner'
import { effectiveOf, readLanes, type LaneFacts } from '../../planning/settings/lanes'
import { readSettings } from '../../planning/settings/store'
import { type DispatchWorld } from './world'
import type { LineRow, Reader } from './store'

/**
 * What a site's day has to work with (B-W2b-49; MES-028, MES-031): each line's working minutes and planned people, who is
 * in, and where each person assigned stands. Read with the office's client or the system view (the floor reads neither the
 * calendars and planning settings nor the roster); no permission is checked here.
 *
 * Who is in comes from the clock (B-W2b-37's `presenceAt`, keyed by the person: a clock-out HR typed in has no worker id)
 * and only where the site's ATTENDANCE gate is in force; with the gate off nothing of it is read at all. The planned shift
 * comes from THE planner of People › Shifts, published rows only.
 */

export interface LineMinutes {
  readonly line: LineRow
  /** Working minutes left of the day (the whole day for a later day, none for one that is over). */
  readonly workingMinutes: number
  readonly shiftBegun: boolean
  readonly shifts: readonly WorkingShift[]
  readonly firstShiftAt: Date | null
  readonly efficiencyPct: string
  readonly plannedPeople: number
}

function minutesBetween(calendar: WorkingCalendar, from: Date, to: Date): number {
  if (to.getTime() <= from.getTime()) return 0
  try {
    return workingMinutesBetween(calendar, from, to)
  } catch (error) {
    if (error instanceof OutsideWindowError) return 0
    throw error
  }
}

export async function lineMinutesOf(db: Reader, world: Pick<DispatchWorld, 'site' | 'day' | 'now' | 'start' | 'end'>, lines: readonly LineRow[]): Promise<Map<string, LineMinutes>> {
  const { site, day, now, start, end } = world
  const out = new Map<string, LineMinutes>()
  if (lines.length === 0) return out
  const settings = await readSettings(db, site.id)
  const lanes = new Map<string, LaneFacts>((await readLanes(db, site.id)).lines.map((lane) => [lane.id, lane]))
  const calendars = await workingCalendarsFor(db, lines.map((line) => ({ scope: 'LINE' as const, id: line.id })), { from: plusDays(day, -1), to: plusDays(day, 1) })
  for (const line of lines) {
    const calendar = calendars.get(ownerKey({ scope: 'LINE', id: line.id }))?.calendar ?? null
    const lane = lanes.get(line.id)
    const effective = lane ? effectiveOf(lane, settings) : { efficiencyPct: '100', people: 0 }
    const shifts = calendar ? calendarDayOf(calendar, day).shifts : []
    const from = now.getTime() > start.getTime() ? now : start
    out.set(line.id, {
      line,
      workingMinutes: calendar ? minutesBetween(calendar, from, end) : 0,
      shiftBegun: calendar ? minutesBetween(calendar, start, now) > 0 : false,
      shifts,
      firstShiftAt: shifts[0]?.start ?? null,
      efficiencyPct: effective.efficiencyPct,
      plannedPeople: effective.people,
    })
  }
  return out
}

export interface PersonStanding {
  readonly state: PresenceState
  readonly reassign: boolean
  readonly words: string | null
}

export interface AttendanceOfDay {
  readonly open: boolean
  /** Why nothing of the clock shows; null: it does. */
  readonly words: string | null
  /** People in per line; empty with the gate closed or on another day. */
  readonly inByLine: ReadonlyMap<string, number>
  /** People in now (a person, not a worker: a worker with no record is not here). */
  readonly clockedIn: ReadonlyMap<string, { readonly onBreak: boolean; readonly lineId: string | null }>
  readonly standingOf: (employeeId: string | null, lineId: string | null) => PersonStanding
}

const UNKNOWN: PersonStanding = { state: 'UNKNOWN', reassign: false, words: null }

export async function attendanceOfDay(db: Reader, world: Pick<DispatchWorld, 'site' | 'day' | 'today' | 'now' | 'rows'>, minutes: ReadonlyMap<string, LineMinutes>): Promise<AttendanceOfDay> {
  const { site, day, today, now, rows } = world
  const gate = await legalGateFor(db, site.id, 'ATTENDANCE', now)
  if (!gate.open) return { open: false, words: gateClosedWords('ATTENDANCE'), inByLine: new Map(), clockedIn: new Map(), standingOf: () => UNKNOWN }
  if (day !== today) return { open: true, words: null, inByLine: new Map(), clockedIn: new Map(), standingOf: () => UNKNOWN }
  const inside = await presenceAt(db, site, now)
  const inByLine = new Map<string, number>()
  const clockedIn = new Map(inside.map((person) => [person.employeeId, { onBreak: person.onBreak, lineId: person.lineId }]))
  for (const person of inside) if (person.lineId) inByLine.set(person.lineId, (inByLine.get(person.lineId) ?? 0) + 1)
  const employeeIds = [...new Set(rows.flatMap((row) => (row.employeeId ? [row.employeeId] : [])))]
  const people = employeeIds.length > 0 ? await peopleFacts(db, { id: { in: employeeIds } }) : []
  const planning = await planningFor(db, people, { from: day, to: day }, { publishedOnly: true })
  const standingOf = (employeeId: string | null, lineId: string | null): PersonStanding => {
    const cell = employeeId ? planning.cells.get(employeeId)?.get(day) : undefined
    const value = cell?.value ?? null
    const clocked = employeeId ? clockedIn.get(employeeId) : undefined
    const state = presenceOf({
      attendanceOpen: true,
      isToday: true,
      hasRecord: employeeId !== null,
      clocked: clocked ? (clocked.onBreak ? 'ON_BREAK' : 'IN') : null,
      planned: value === null ? null : value.kind === 'OFF' ? { kind: 'OFF' } : { kind: 'WORK', startsAt: localInstant(day, value.shift.startMinute, site.timezone) },
      lineStartsAt: lineId ? (minutes.get(lineId)?.firstShiftAt ?? null) : null,
      now,
    })
    return { state, reassign: needsReassign(state), words: PRESENCE_WORDS[state] }
  }
  return { open: true, words: null, inByLine, clockedIn, standingOf }
}

/** Each line's load of the day: its cards' queued minutes against the minutes it has. */
export async function lineLoads(db: Reader, world: DispatchWorld, minutes: ReadonlyMap<string, LineMinutes>, attendance: AttendanceOfDay): Promise<Map<string, LineLoad>> {
  const minimumGroup = await minimumGroupSizeFor(db, world.site.companyId)
  const lineOfStation = new Map(world.stations.map((station) => [station.id, station.lineId]))
  const out = new Map<string, LineLoad>()
  for (const [lineId, line] of minutes) {
    const cards = world.cards.filter((card) => card.counted && (card.stationId ? lineOfStation.get(card.stationId) === lineId : card.lineId === lineId))
    const queued = cards.reduce((sum, card) => sum.plus(card.minutes), new Dec(0))
    const clockedIn = attendance.inByLine.get(lineId) ?? 0
    const why = plannedWhy({ attendanceOpen: attendance.open, isToday: world.day === world.today, shiftBegun: line.shiftBegun, clockedIn, minimumGroup })
    const operators = world.rows.filter((row) => row.employeeId !== null && (row.stationId ? lineOfStation.get(row.stationId) === lineId : row.lineId === lineId))
    const distinct = new Map(operators.map((row) => [row.employeeId!, row]))
    const notIn = [...distinct.values()].filter((row) => attendance.standingOf(row.employeeId, lineId).reassign).length
    out.set(lineId, lineLoad({ queued, workingMinutes: line.workingMinutes, efficiencyPct: line.efficiencyPct, plannedPeople: line.plannedPeople, clockedIn: why === null ? clockedIn : null, why, operators: distinct.size, notIn, minimumGroup }))
  }
  return out
}

/** A station's day operators: the STATION_OPERATOR rows, in lane order. */
export const stationOperators = (world: Pick<DispatchWorld, 'rows'>, stationId: string) => world.rows.filter((row) => row.stationId === stationId && assignmentKindOf(row) === 'STATION_OPERATOR')

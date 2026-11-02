import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { BUSINESS_TIME_ZONE, businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { limitChecks, workOfDays, type LimitCheck, type WorkedDay } from '@nexus/factory-domain/people/limits/checks'
import { weeklyAverageWindowStart, type LimitRules, type PlannedWork } from '@nexus/factory-domain/people/shifts/limits'
import { dateOf, dayOf } from '../employees/access'
import type { Client } from '../attendance/store'
import { rulesFor, type Place } from '../shifts/checks'
import { planningFor, workOf, type PlannedPerson } from '../shifts/planner'

/**
 * What the working-time limits say about the time people worked (B-W2b-42; MES-229, MES-232): ONE read for the overtime
 * checks and for the warnings. The attendance days up to today are the work (B-W2b-32's limit engine reads them as it
 * reads a plan); the published roster counts from tomorrow, so a rest that the next shift would break shows before it
 * happens. Attendance data: the callers hold the site's ATTENDANCE gate open (`legalGateFor`) and the person's reach, and
 * a list shows the tone only. Every read goes by the person's record, so an event entered by hand (no worker) counts.
 */

export interface YearOvertime {
  readonly approvedMinutes: number
  readonly pendingMinutes: number
}

export interface LimitFacts {
  readonly today: BusinessDate
  rules(person: PlannedPerson): LimitRules
  /** The person's latest attendance day read (what a list row opens: it names no person). */
  latestDayOf(employeeId: string): string | null
  /** The person's overtime of a year, approved and waiting (rejected overtime is not paid: it counts for neither). */
  overtimeOf(employeeId: string, year: string): YearOvertime
  /** The person's checks on a day, the cap on `overtimeMinutes`. */
  checksOf(person: PlannedPerson, date: BusinessDate, overtimeMinutes: number): LimitCheck[]
}

const DAY_COLUMNS = { id: true, employeeId: true, date: true, firstInAt: true, lastOutAt: true, presentMinutes: true, breakMinutes: true } as const

/** The facts of `people` for the days `from` … `to` (one read of each table: a list asks once for its whole page). */
export async function limitFacts(client: Client, people: readonly PlannedPerson[], range: { readonly from: BusinessDate; readonly to: BusinessDate }, now: Date): Promise<LimitFacts> {
  const rulesAt = await rulesFor(client)
  const rulesOf = (person: Place) => rulesAt(person)
  const today = businessDate(now)
  const ids = people.map((person) => person.id)
  let start = plusDays(range.from, -1)
  for (const person of people) {
    const first = weeklyAverageWindowStart(range.from, rulesOf(person).WEEKLY_AVERAGE)
    if (first < start) start = first
  }
  const end = range.to > today ? range.to : today
  const days = ids.length === 0 ? [] : await client.attendanceDay.findMany({ where: { employeeId: { in: ids }, date: { gte: dateOf(start), lte: dateOf(end) } }, select: DAY_COLUMNS, orderBy: [{ date: 'asc' }] })
  const worked = new Map<string, WorkedDay[]>()
  const latest = new Map<string, string>()
  for (const row of days) {
    worked.set(row.employeeId, [...(worked.get(row.employeeId) ?? []), { ...row, date: dayOf(row.date) }])
    latest.set(row.employeeId, row.id)
  }
  // What is planned from today on: only the plan the workers were told.
  const planning = ids.length === 0 ? null : await planningFor(client, people, { from: today, to: plusDays(today, 1) }, { publishedOnly: true })
  const firstYear = range.from.slice(0, 4)
  const lastYear = end.slice(0, 4)
  const entries = ids.length === 0 ? [] : await client.overtimeEntry.findMany({ where: { employeeId: { in: ids }, date: { gte: dateOf(`${firstYear}-01-01`), lte: dateOf(`${lastYear}-12-31`) }, status: { in: ['APPROVED', 'PENDING'] } }, select: { employeeId: true, date: true, minutes: true, status: true } })
  const overtime = new Map<string, { approvedMinutes: number; pendingMinutes: number }>()
  for (const row of entries) {
    const key = `${row.employeeId}|${dayOf(row.date).slice(0, 4)}`
    const sum = overtime.get(key) ?? { approvedMinutes: 0, pendingMinutes: 0 }
    if (row.status === 'APPROVED') sum.approvedMinutes += row.minutes
    else sum.pendingMinutes += row.minutes
    overtime.set(key, sum)
  }
  const workOfPerson = (person: PlannedPerson): { work: PlannedWork[]; workedDates: Set<BusinessDate> } => {
    const done = workOfDays(worked.get(person.id) ?? [])
    const workedDates = new Set(done.map((item) => item.date))
    const ahead = planning ? workOf(planning, person).filter((item) => item.date > today || (item.date === today && !workedDates.has(today))) : []
    return { work: [...done, ...ahead], workedDates }
  }
  return {
    today,
    rules: rulesOf,
    latestDayOf: (employeeId) => latest.get(employeeId) ?? null,
    overtimeOf: (employeeId, year) => overtime.get(`${employeeId}|${year}`) ?? { approvedMinutes: 0, pendingMinutes: 0 },
    checksOf: (person, date, overtimeMinutes) => limitChecks({ date, timeZone: planning?.timeZones.get(person.siteId) ?? BUSINESS_TIME_ZONE, employedFrom: person.startDate, rules: rulesOf(person), ...workOfPerson(person), overtimeMinutes }),
  }
}

import type { FactoryClient } from '@nexus/factory-db'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import type { CommandTx } from '../../../core/command'
import { dateOf, dayOf } from '../employees/access'
import { legalGateFor } from '../privacy/gate'

/**
 * THE ONE place People › Shifts reads attendance data (B-W2b-32): the absences recorded in Attendance (AbsenceEntry,
 * B-W2b-37's), which the roster shows read only on a cell and which "Copy last week" and "Assign" list as conflicts.
 * Everything else this module reads is planning (who is planned on which shift, the overtime asked and agreed), not a
 * record of what a person did (Statuto dei Lavoratori art. 4 c.2 governs the tools that record attendance).
 *
 * Behind the site's ATTENDANCE legal gate (GATE-LABOUR; W2b plan §11: every per-person attendance read goes through one
 * gate, B-W2b-27's `legalGateFor` in modules/people/privacy/gate.ts): while it is closed no absence is read and the roster
 * says so in words; it opens when the worker notice and the impact assessment are on record and the Owner switches the
 * purpose on.
 *
 * Data minimisation (GDPR arts. 5(1)(c), 9): a cell shows that the person is absent and for how long; the code only for a
 * holiday or a permit (planning needs it: "Ferie", "ROL"). A sickness, an injury, a law 104 leave or any other reason
 * shows as "absent" with no code: a roster is read by every lead of the site.
 */

type Client = FactoryClient | CommandTx

export const ATTENDANCE_CLOSED_WORDS =
  'Absences from Attendance are not shown: attendance data is switched off at this site until the worker notice and the impact assessment are on record and the Owner switches it on (Statuto dei Lavoratori art. 4 c.2-3; GDPR art. 35).'

/** The categories whose code a roster may show (planning facts, no health data). */
const SHOWN_CATEGORIES: ReadonlySet<string> = new Set(['HOLIDAY', 'PERMIT'])

/** The site's ATTENDANCE gate is open (B-W2b-27's one gate). */
async function attendanceGateOpen(client: Client, siteId: string): Promise<boolean> {
  return (await legalGateFor(client, siteId, 'ATTENDANCE')).open
}

export interface AbsenceShown {
  /** HOLIDAY or PERMIT with its code; ABSENT for any other reason (no code). */
  readonly kind: 'HOLIDAY' | 'PERMIT' | 'ABSENT'
  readonly code: string | null
  readonly minutes: number
}

export interface Absences {
  /** Per site: whether absences were read (the gate is open). */
  readonly shown: ReadonlyMap<string, boolean>
  /** Per person and day. */
  readonly byPerson: ReadonlyMap<string, ReadonlyMap<BusinessDate, AbsenceShown>>
}

/** The absences of the people (each of `siteId`) from `from` to `to`, at the sites whose ATTENDANCE gate is open. */
export async function absencesFor(client: Client, people: readonly { readonly id: string; readonly siteId: string }[], window: { readonly from: BusinessDate; readonly to: BusinessDate }): Promise<Absences> {
  const shown = new Map<string, boolean>()
  for (const siteId of new Set(people.map((person) => person.siteId))) shown.set(siteId, await attendanceGateOpen(client, siteId))
  const readable = people.filter((person) => shown.get(person.siteId) === true).map((person) => person.id)
  const byPerson = new Map<string, Map<BusinessDate, AbsenceShown>>()
  if (readable.length === 0) return { shown, byPerson }
  const rows = await client.absenceEntry.findMany({
    where: { employeeId: { in: readable }, date: { gte: dateOf(window.from), lte: dateOf(window.to) } },
    select: { employeeId: true, date: true, minutes: true, code: { select: { code: true, category: true } } },
  })
  for (const row of rows) {
    const days = byPerson.get(row.employeeId) ?? new Map<BusinessDate, AbsenceShown>()
    const date = dayOf(row.date)
    const before = days.get(date)
    const kind = SHOWN_CATEGORIES.has(row.code.category) ? (row.code.category as 'HOLIDAY' | 'PERMIT') : 'ABSENT'
    // Two codes on one day: the minutes add up; the day shows ABSENT unless both are the same shown code.
    days.set(date, before ? { kind: before.kind === kind && before.code === row.code.code ? kind : 'ABSENT', code: before.kind === kind && before.code === row.code.code ? before.code : null, minutes: before.minutes + row.minutes } : { kind, code: kind === 'ABSENT' ? null : row.code.code, minutes: row.minutes })
    byPerson.set(row.employeeId, days)
  }
  return { shown, byPerson }
}

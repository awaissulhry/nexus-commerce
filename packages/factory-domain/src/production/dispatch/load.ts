import { Dec, type Decimal } from '../../tax/decimal'

/**
 * Today's load against available minutes and who is not in yet (B-W2b-49; MES-031, MES-028; design production.dispatch
 * "Load against minutes": "Queued 2,410 min · available 2,160 min · 250 min over", floor.supervisor "Stations"), pure.
 *
 *   queued     the standard minutes of the line's cards still to do (released work only: held and draft work books nothing)
 *   available  people × the line's working minutes left in the day (its calendar, breaks out) × the line's planned
 *              efficiency. The people are those clocked in on the line where the site's ATTENDANCE basis is in force, it is
 *              today and the shift has begun; otherwise, or when fewer are in than the company's minimum group size
 *              (ANA-075: no count, no minutes that would give it away), the line's planned people.
 *
 * Per line only: never per person (Statuto dei Lavoratori art. 4). The efficiency is the line's planned figure, never a
 * person's. A person's state is a word for one assignment, never why they are away (GDPR art. 9).
 */

export const LOAD_SOURCES = ['CLOCKED_IN', 'PLANNED'] as const
export type LoadSource = (typeof LOAD_SOURCES)[number]

export const LOAD_STATES = ['OVER', 'FITS', 'NOTHING_AVAILABLE'] as const

export const PLANNED_WHY = ['ATTENDANCE_OFF', 'TOO_FEW', 'BEFORE_THE_SHIFT', 'NOT_TODAY'] as const
export type PlannedWhy = (typeof PLANNED_WHY)[number]

const PLANNED_WORDS: Readonly<Record<PlannedWhy, string>> = Object.freeze({
  ATTENDANCE_OFF: 'Planned people: clock-in is not switched on at this site.',
  TOO_FEW: 'Planned people: too few are in on this line to show a count.',
  BEFORE_THE_SHIFT: 'Planned people: the shift has not begun.',
  NOT_TODAY: 'Planned people: a day that has not come.',
})

export interface LineLoadFacts {
  /** Standard minutes still to do, as decimal text. */
  readonly queued: Decimal | string
  /** The line's working minutes left in the day (the whole day for a later day). */
  readonly workingMinutes: number
  readonly efficiencyPct: string
  readonly plannedPeople: number
  /** People in on the line; null: not known here (see `why`). */
  readonly clockedIn: number | null
  readonly why: PlannedWhy | null
  /** Assigned operators of the line that day, and those not in. */
  readonly operators: number
  readonly notIn: number
  readonly minimumGroup: number
}

export interface LineLoad {
  readonly queuedMinutes: number
  readonly availableMinutes: number
  readonly overMinutes: number
  readonly spareMinutes: number
  readonly state: (typeof LOAD_STATES)[number]
  readonly source: LoadSource
  /** People counted (null: under the minimum group size, or nobody planned). */
  readonly people: number | null
  readonly efficiencyPct: string
  /** Assigned operators not in, once they are a group big enough to show. */
  readonly absent: number | null
  readonly words: string
  readonly sourceWords: string | null
}

const minutes = (value: number): string => `${value.toLocaleString('en-GB')} min`

/** Whole minutes (half up, the decimals' own rounding). */
const wholeMinutes = (value: Decimal): number => Number(value.toFixed(0))

/** The sum of standard minutes kept as decimal text, to the tenth the cards show. */
export const sumMinutes = (values: readonly string[]): string => values.reduce((sum, value) => sum.plus(value), new Dec(0)).toFixed(1)

export function lineLoad(facts: LineLoadFacts): LineLoad {
  const queuedMinutes = wholeMinutes(new Dec(facts.queued.toString()))
  const fromClock = facts.clockedIn !== null && facts.why === null
  const people = fromClock ? facts.clockedIn! : facts.plannedPeople
  const availableMinutes = wholeMinutes(new Dec(people).times(facts.workingMinutes).times(facts.efficiencyPct).div(100))
  const overMinutes = Math.max(0, queuedMinutes - availableMinutes)
  const spareMinutes = Math.max(0, availableMinutes - queuedMinutes)
  const ending = overMinutes > 0 ? `${minutes(overMinutes)} over` : `${minutes(spareMinutes)} spare`
  return {
    queuedMinutes,
    availableMinutes,
    overMinutes,
    spareMinutes,
    state: availableMinutes === 0 && queuedMinutes > 0 ? 'NOTHING_AVAILABLE' : overMinutes > 0 ? 'OVER' : 'FITS',
    source: fromClock ? 'CLOCKED_IN' : 'PLANNED',
    people: fromClock ? facts.clockedIn : facts.why === 'TOO_FEW' ? null : facts.plannedPeople,
    efficiencyPct: facts.efficiencyPct,
    absent: facts.operators >= facts.minimumGroup ? facts.notIn : null,
    words: `Queued ${minutes(queuedMinutes)} · available ${minutes(availableMinutes)} · ${ending}`,
    sourceWords: facts.why ? PLANNED_WORDS[facts.why] : null,
  }
}

/** Why a line's available minutes do not come from the clock today (null: they do). */
export function plannedWhy(facts: { readonly attendanceOpen: boolean; readonly isToday: boolean; readonly shiftBegun: boolean; readonly clockedIn: number; readonly minimumGroup: number }): PlannedWhy | null {
  if (!facts.attendanceOpen) return 'ATTENDANCE_OFF'
  if (!facts.isToday) return 'NOT_TODAY'
  if (!facts.shiftBegun && facts.clockedIn === 0) return 'BEFORE_THE_SHIFT'
  if (facts.clockedIn > 0 && facts.clockedIn < facts.minimumGroup) return 'TOO_FEW'
  return null
}

// ---- absence-aware dispatch (MES-028) -----------------------------------------------------------------------------------

export const PRESENCE_STATES = ['IN', 'ON_BREAK', 'NOT_IN', 'LATER', 'OFF', 'UNKNOWN'] as const
export type PresenceState = (typeof PRESENCE_STATES)[number]

export interface PresenceFacts {
  readonly attendanceOpen: boolean
  readonly isToday: boolean
  /** No person record: no clock to read. */
  readonly hasRecord: boolean
  readonly clocked: 'IN' | 'ON_BREAK' | null
  /** Their planned shift today (published roster, else the default): when it starts, OFF, or nothing known. */
  readonly planned: { readonly kind: 'WORK'; readonly startsAt: Date } | { readonly kind: 'OFF' } | null
  /** The start of the line's first shift today, when nothing is planned for them. */
  readonly lineStartsAt: Date | null
  readonly now: Date
}

/** Where someone assigned stands: the clock first, then their planned shift. */
export function presenceOf(facts: PresenceFacts): PresenceState {
  if (!facts.attendanceOpen || !facts.isToday || !facts.hasRecord) return 'UNKNOWN'
  if (facts.clocked) return facts.clocked
  if (facts.planned?.kind === 'OFF') return 'OFF'
  const startsAt = facts.planned?.kind === 'WORK' ? facts.planned.startsAt : facts.lineStartsAt
  if (startsAt && startsAt.getTime() > facts.now.getTime()) return 'LATER'
  return 'NOT_IN'
}

/** Work assigned to them is flagged and offered for reassignment. */
export const needsReassign = (state: PresenceState): boolean => state === 'NOT_IN' || state === 'OFF'

export const PRESENCE_WORDS: Readonly<Record<PresenceState, string | null>> = Object.freeze({
  IN: null,
  ON_BREAK: null,
  NOT_IN: 'Not clocked in: reassign this work.',
  OFF: 'Not on shift today: reassign this work.',
  LATER: 'Starts later today.',
  UNKNOWN: null,
})

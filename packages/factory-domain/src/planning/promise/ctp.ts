import { daysFrom, plusDays } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'
import { Dec, type Decimal } from '../../tax/decimal'

/**
 * Capable to promise, lite (B-W2b-301; PLN-169; design planning.promise › calc "base lead time 15 days + queue at today's
 * load 6 days + leather to buy 14 days = 35 days → 4 Dec"), pure: when can garments be ready, from the material's arrival
 * and the board's free capacity.
 *
 *   lanes     the site's lines and work centres, each day's available standard minutes (people × working minutes ×
 *             efficiency, THE calendars service through B-W2a-16's capacity world) and what released work already books
 *             there (B-W2a-34's board: its slots, else the due date), plus the booked minutes that are past due or have no
 *             day (they wait first, from today: the queue)
 *   steps     the routing of the revision, in its order: an in-house step books its standard minutes × garments on the
 *             lane that does it and finishes first (a line that does its kind of work, else a work centre of the kind);
 *             a step at a workshop takes its transit days (1 day when none is set), as the board counts it
 *   walk      from the day the material is there, each step consumes the free minutes of its lane day by day, after the
 *             step before it; the day its last minute fits is its finish
 *
 * The bridge splits the days from today to the finish: material (today → the material's day), base lead time (the same
 * walk on an empty plant) and queue (what today's load adds). Days are calendar days; dates are the site's days.
 *
 * B-W2b-F44 (Owner 2026-11-13, option A): today counts only the minutes still left from now (minutesLeftToday), and a garment
 * still to make is promised for the next working day at the earliest, never for today (makeDayOf).
 */

export const CTP_HORIZON_DAYS = 182

export const PROMISE_PROBLEM_CODES = ['NO_LANE', 'NO_CAPACITY', 'BEYOND_HORIZON', 'NO_ROUTING'] as const
export type PromiseProblemCode = (typeof PROMISE_PROBLEM_CODES)[number]

export interface PromiseProblem {
  readonly code: PromiseProblemCode
  readonly words: string
}

export interface CtpDay {
  readonly date: BusinessDate
  /** Standard minutes the lane can do that day (0 when closed). */
  readonly available: Decimal
  /** Standard minutes released work books there that day. */
  readonly booked: Decimal
}

export interface CtpLane {
  readonly key: string
  readonly kind: 'LINE' | 'WORK_CENTRE'
  readonly id: string
  readonly code: string
  readonly name: string
  /** Consecutive days from today (empty: no calendar, no capacity known). */
  readonly days: readonly CtpDay[]
  /** Booked minutes past due or with no day: they wait first, from today. */
  readonly backlog: Decimal
}

export interface CtpStep {
  readonly seq: number
  readonly name: string
  /** At a workshop (a routing step with a supplier): its transit days. */
  readonly outside: boolean
  readonly transitDays: number | null
  /** The lanes that may do it, in the order to prefer on a tie. */
  readonly laneKeys: readonly string[]
  /** Standard minutes × garments. */
  readonly minutes: Decimal
}

/** Free standard minutes per lane and day. */
export type FreeMap = Map<string, Map<BusinessDate, Decimal>>

const ZERO = new Dec(0)
const positive = (value: Decimal): Decimal => (value.gt(0) ? value : ZERO)

/**
 * Each lane's free minutes after today's load: available − booked; a day booked beyond what it can do takes the rest from
 * the days before it (the work is due then, so it is done earlier), what is left before today joins the backlog, and the
 * backlog takes the earliest free minutes from today.
 */
export function freeAfterLoad(lanes: readonly CtpLane[]): FreeMap {
  const out: FreeMap = new Map()
  for (const lane of lanes) {
    const free = lane.days.map((day) => day.available.minus(day.booked))
    let carry = ZERO
    for (let index = free.length - 1; index >= 0; index--) {
      const left = free[index]!.minus(carry)
      if (left.lt(0)) {
        carry = left.negated()
        free[index] = ZERO
      } else {
        carry = ZERO
        free[index] = left
      }
    }
    let backlog = lane.backlog.plus(carry)
    const days = new Map<BusinessDate, Decimal>()
    lane.days.forEach((day, index) => {
      let value = positive(free[index]!)
      if (backlog.gt(0) && value.gt(0)) {
        const taken = backlog.lt(value) ? backlog : value
        value = value.minus(taken)
        backlog = backlog.minus(taken)
      }
      days.set(day.date, value)
    })
    out.set(lane.key, days)
  }
  return out
}

/** Each lane's minutes on an empty plant (nothing booked): the base lead time's walk. */
export function freeWhenEmpty(lanes: readonly CtpLane[]): FreeMap {
  return new Map(lanes.map((lane) => [lane.key, new Map(lane.days.map((day) => [day.date, positive(day.available)]))]))
}

/** A copy to walk without changing the original. */
export const copyFree = (free: FreeMap): FreeMap => new Map([...free.entries()].map(([key, days]) => [key, new Map(days)]))

export interface StepTimes {
  readonly seq: number
  readonly name: string
  readonly outside: boolean
  readonly laneKey: string | null
  readonly start: BusinessDate
  readonly finish: BusinessDate
}

export interface Walk {
  /** The day the last step finishes; null: it does not fit before the horizon (or a step has no lane with capacity). */
  readonly finish: BusinessDate | null
  readonly steps: readonly StepTimes[]
  readonly problems: readonly PromiseProblem[]
}

/** When `need` minutes fit on one lane from `from` on: the first day with free minutes and the finish day; null: never. */
function fit(days: Map<BusinessDate, Decimal>, from: BusinessDate, need: Decimal): { start: BusinessDate; finish: BusinessDate; takes: [BusinessDate, Decimal][] } | null {
  let left = need
  let start: BusinessDate | null = null
  const takes: [BusinessDate, Decimal][] = []
  const ordered = [...days.keys()].filter((date) => date >= from).sort()
  for (const date of ordered) {
    const free = days.get(date)!
    if (!free.gt(0)) continue
    start ??= date
    const taken = left.lt(free) ? left : free
    takes.push([date, taken])
    left = left.minus(taken)
    if (!left.gt(0)) return { start, finish: date, takes }
  }
  return null
}

/**
 * Walks the steps from `start`, each after the one before it, consuming the free minutes of the lane it finishes first on
 * (the map is changed: pass a copy to look without booking).
 */
export function walkSteps(steps: readonly CtpStep[], free: FreeMap, start: BusinessDate, lanes: ReadonlyMap<string, Pick<CtpLane, 'code' | 'name'>>): Walk {
  const problems: PromiseProblem[] = []
  const times: StepTimes[] = []
  let cursor = start
  for (const step of [...steps].sort((a, b) => a.seq - b.seq)) {
    if (step.outside) {
      const finish = plusDays(cursor, Math.max(0, step.transitDays ?? 1))
      times.push({ seq: step.seq, name: step.name, outside: true, laneKey: null, start: cursor, finish })
      cursor = finish
      continue
    }
    if (!step.minutes.gt(0)) {
      times.push({ seq: step.seq, name: step.name, outside: false, laneKey: null, start: cursor, finish: cursor })
      continue
    }
    const candidates = step.laneKeys.filter((key) => free.has(key))
    if (candidates.length === 0) {
      problems.push({ code: 'NO_LANE', words: `No line or work centre of the site does step ${step.seq} ${step.name}: it is not counted.` })
      continue
    }
    let best: { key: string; start: BusinessDate; finish: BusinessDate; takes: [BusinessDate, Decimal][] } | null = null
    for (const key of candidates) {
      const found = fit(free.get(key)!, cursor, step.minutes)
      if (found && (best === null || found.finish < best.finish)) best = { key, ...found }
    }
    if (!best) {
      const known = candidates.some((key) => free.get(key)!.size > 0)
      problems.push(
        known
          ? { code: 'BEYOND_HORIZON', words: `Step ${step.seq} ${step.name} does not fit on ${candidates.map((key) => lanes.get(key)?.code ?? key).join(', ')} within ${CTP_HORIZON_DAYS} days.` }
          : { code: 'NO_CAPACITY', words: `${candidates.map((key) => lanes.get(key)?.code ?? key).join(', ')} has no working days on its calendar: step ${step.seq} ${step.name} cannot be placed.` },
      )
      return { finish: null, steps: times, problems }
    }
    const days = free.get(best.key)!
    for (const [date, taken] of best.takes) days.set(date, days.get(date)!.minus(taken))
    times.push({ seq: step.seq, name: step.name, outside: false, laneKey: best.key, start: best.start, finish: best.finish })
    cursor = best.finish
  }
  return { finish: cursor, steps: times, problems }
}

export interface Bridge {
  /** Today → the day the material is there. */
  readonly materialDays: number
  /** The material's day → the finish on an empty plant (the base lead time). */
  readonly baseDays: number
  /** What today's load adds (the queue). */
  readonly queueDays: number
  readonly spanDays: number
  readonly materialDate: BusinessDate
  readonly finish: BusinessDate
}

/** The bridge of a date (every part 0 or more; the queue takes what the empty walk does not explain). */
export function bridgeOf(today: BusinessDate, materialDate: BusinessDate, emptyFinish: BusinessDate, finish: BusinessDate): Bridge {
  const start = materialDate < today ? today : materialDate
  const spanDays = Math.max(0, daysFrom(today, finish))
  const materialDays = Math.min(spanDays, Math.max(0, daysFrom(today, start)))
  const baseDays = Math.min(spanDays - materialDays, Math.max(0, daysFrom(start, emptyFinish)))
  return { materialDays, baseDays, queueDays: spanDays - materialDays - baseDays, spanDays, materialDate: start, finish }
}

// ---- B-W2b-F44 (Owner 2026-11-13, option A): a garment still to make is never promised for today ----------------------------

/**
 * B-W2b-F44: the first day a garment still to make can be promised: the walk's finish, never before `firstMakeDay` (the
 * first working day after today on the site's calendar, from THE calendars service). Applied to the real walk and to the
 * empty plant's walk alike, so the bridge still adds up: the days the rule adds are base lead time, the queue stays what
 * today's load adds beyond them. Stock already made and free is never walked (atp's stockDateFor) and may be promised today.
 */
export const makeDayOf = (finish: BusinessDate, firstMakeDay: BusinessDate): BusinessDate => (finish < firstMakeDay ? firstMakeDay : finish)

/**
 * B-W2b-F44: today's working minutes on a lane are only those still left from now (the calendars service's working minutes
 * from now to the end of the site's day), never more than the day's own; unknown (no calendar loaded that far): the day's.
 * Later days count in full.
 */
export function minutesLeftToday(dayMinutes: number | null, leftFromNow: number | null): number {
  const day = Math.max(0, dayMinutes ?? 0)
  return leftFromNow === null ? day : Math.max(0, Math.min(day, leftFromNow))
}

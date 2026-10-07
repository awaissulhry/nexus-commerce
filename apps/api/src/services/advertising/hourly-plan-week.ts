/**
 * ADS AUTONOMY W4-1 — an hourly bid plan's week in numbers, pure (no reads): what Claude's ad-hourly-plans shows and what
 * set-hourly-bid-plan's preview compares, from the plan's windows and baseline and the values of its rank targets.
 *
 *   hour      which target governs (day, hour): the engine's own rule (rank-controller.ts resolveActiveTargetKey — the
 *             first window covering the hour that names a target, else the baseline; `endHour` is exclusive), never a
 *             copy of it. A target's values are the engine's spec with a campaign's overrides applied by the caller
 *             (ad-rank-defend.job.ts applyTargetOverrides), so a summary and the engine read the same numbers.
 *   day       per day: a 24-letter line (a letter per target, `.` no target, `?` a target that no longer exists), hours
 *             at the Min-bid floor, hours per target, unplanned hours, the highest placement % outside the floor and the
 *             highest base bid an hour sets.
 *   raises    what a new week (or new values) adds to spend against the old, hour by hour: an hour that leaves the
 *             floor, a higher placement %, a higher base bid, an hour that comes under a target that sets either.
 *   next 24h  the target changes from now, hour by hour, in the plan's own time zone (Intl).
 *
 * Money (a floor, a base bid, a CPC ceiling) is in minor units of the campaigns' own currency, never converted.
 */
import { resolveActiveTargetKey, type ScheduleWindow } from './rank-controller.js'

/** Sunday first, as the engine counts days (0 = Sunday). */
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
/** The order a person reads a week in: Monday first. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const

/** What one rank target does to a campaign's bids in an hour, as the engine reads it. */
export interface TargetValues {
  key: string
  name: string
  /** A Min-bid hour (or a base bid that floors): every bid at the floor, the campaign stays live. */
  floor: boolean
  /** The floor a Min-bid hour holds; null = the engine's own 2 cents. */
  floorBidCents: number | null
  /** The placement % the hour holds (the highest lane of a blend). */
  placementPct: number
  /** 'absolute' sets the ad groups' base bid to `bidValueCents`; null / 'hold' leaves it. */
  bidMode: string | null
  bidValueCents: number | null
  maxCpcCents: number | null
}

/** The fields of an engine spec this module reads (RankTargetSpec, after a campaign's overrides). */
export interface SpecLike {
  key: string
  pause?: boolean | null
  floorBidCents?: number | null
  biasPct?: number | null
  lanes?: Array<{ biasPct?: number | null }> | null
  bidMode?: string | null
  bidValueCents?: number | null
  maxCpcCents?: number | null
}

/** A target's values from the engine's spec (pure). */
export function targetValuesOf(spec: SpecLike, name: string): TargetValues {
  const lanes = Array.isArray(spec.lanes) ? spec.lanes : []
  const placementPct = Math.max(0, Math.min(900, Math.max(spec.biasPct ?? 0, ...lanes.map((l) => l?.biasPct ?? 0))))
  const mode = spec.bidMode ?? null
  return {
    key: spec.key,
    name,
    floor: spec.pause === true || mode === 'suppress',
    floorBidCents: spec.floorBidCents ?? null,
    placementPct,
    bidMode: mode,
    bidValueCents: mode === 'absolute' ? spec.bidValueCents ?? null : null,
    maxCpcCents: spec.maxCpcCents ?? null,
  }
}

export interface WeekPlan {
  windows: unknown
  defaultTargetKey: string | null
}

const windowsOf = (w: unknown): ScheduleWindow[] => (Array.isArray(w) ? (w as ScheduleWindow[]) : [])

/** What governs one hour: the target's key (null: no target) and its values (null: none, or a target that is gone). */
export function hourOf(plan: WeekPlan, targets: ReadonlyMap<string, TargetValues>, day: number, hour: number): { key: string | null; values: TargetValues | null } {
  const key = resolveActiveTargetKey(windowsOf(plan.windows), plan.defaultTargetKey, day, hour)
  return { key, values: key ? targets.get(key) ?? null : null }
}

export interface DaySummary {
  day: (typeof DAY_NAMES)[number]
  /** One letter per hour, 00–23 (the legend names each letter's target); `.` no target, `?` a target that is gone. */
  hours: string
  hoursAtFloor: number
  hoursUnplanned: number
  /** Hours per target key. */
  hoursByTarget: Record<string, number>
  /** The highest placement % an hour outside the floor holds (0: none). */
  highestPlacementPct: number
  /** The highest base bid an hour sets (null: no hour sets one). */
  highestBaseBidCents: number | null
}

export interface WeekSummary {
  days: DaySummary[]
  /** Letter → target key (and its name). */
  legend: Record<string, string>
  totals: { hoursAtFloor: number; hoursUnplanned: number; hoursPlanned: number; highestPlacementPct: number; highestBaseBidCents: number | null }
  /** Target keys the week names that no longer exist (their hours hold nothing). */
  missingTargets: string[]
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/**
 * The week, day by day (Monday first). Pure. `letterOf`: a letter map shared with another week's summary, so two weeks
 * shown side by side (a preview's from → to) name the same target with the same letter; the legend names every letter
 * the map holds.
 */
export function weekSummary(plan: WeekPlan, targets: ReadonlyMap<string, TargetValues>, letterOf: Map<string, string> = new Map()): WeekSummary {
  const legend: Record<string, string> = {}
  const missing = new Set<string>()
  const days: DaySummary[] = []
  const totals = { hoursAtFloor: 0, hoursUnplanned: 0, hoursPlanned: 0, highestPlacementPct: 0, highestBaseBidCents: null as number | null }
  for (const day of WEEK_ORDER) {
    const d: DaySummary = { day: DAY_NAMES[day], hours: '', hoursAtFloor: 0, hoursUnplanned: 0, hoursByTarget: {}, highestPlacementPct: 0, highestBaseBidCents: null }
    for (let hour = 0; hour < 24; hour++) {
      const { key, values } = hourOf(plan, targets, day, hour)
      if (!key) { d.hours += '.'; d.hoursUnplanned++; continue }
      d.hoursByTarget[key] = (d.hoursByTarget[key] ?? 0) + 1
      if (!values) { d.hours += '?'; missing.add(key); continue }
      if (!letterOf.has(key)) letterOf.set(key, LETTERS[letterOf.size] ?? '*')
      d.hours += letterOf.get(key)
      if (values.floor) d.hoursAtFloor++
      else d.highestPlacementPct = Math.max(d.highestPlacementPct, values.placementPct)
      if (values.bidValueCents != null) d.highestBaseBidCents = Math.max(d.highestBaseBidCents ?? 0, values.bidValueCents)
    }
    totals.hoursAtFloor += d.hoursAtFloor
    totals.hoursUnplanned += d.hoursUnplanned
    totals.highestPlacementPct = Math.max(totals.highestPlacementPct, d.highestPlacementPct)
    if (d.highestBaseBidCents != null) totals.highestBaseBidCents = Math.max(totals.highestBaseBidCents ?? 0, d.highestBaseBidCents)
    days.push(d)
  }
  totals.hoursPlanned = 168 - totals.hoursUnplanned
  for (const [key, letter] of letterOf) {
    const name = targets.get(key)?.name
    legend[letter] = name && name !== key ? `${key} (${name})` : key
  }
  return { days, legend, totals, missingTargets: [...missing].sort() }
}

/** One day as a preview line shows it (no letters: the numbers a person compares). */
export function dayLine(d: DaySummary) {
  return { hoursAtFloor: d.hoursAtFloor, hoursUnplanned: d.hoursUnplanned, hoursByTarget: d.hoursByTarget, highestPlacementPct: d.highestPlacementPct, highestBaseBidCents: d.highestBaseBidCents }
}

/** What a change adds to spend, hour by hour (each count is hours of the week). */
export interface WeekRaise {
  /** Hours that leave the Min-bid floor (to another target, or to none: the floor is given back). */
  leaveFloor: number
  /** Hours that hold a higher placement %. */
  higherPlacement: number
  /** Hours that set a higher base bid (or one where none was set). */
  higherBaseBid: number
  /** Hours that had no target and now hold a placement % or a base bid. */
  newlyPlanned: number
  /** Hours whose target changed at all. */
  changed: number
  /** Hours that go to the floor (a cut). */
  toFloor: number
}

/** Does going from one hour's values to another's add spend, and how. Pure. */
export function hourRaise(from: TargetValues | null, to: TargetValues | null): Array<keyof Omit<WeekRaise, 'changed' | 'toFloor'>> {
  const out: Array<keyof Omit<WeekRaise, 'changed' | 'toFloor'>> = []
  if (from?.floor) {
    // Leaving the floor gives the bids back (to none, or to a target that holds them).
    if (!to?.floor) out.push('leaveFloor')
    else if ((to.floorBidCents ?? 2) > (from.floorBidCents ?? 2)) out.push('higherBaseBid')
    return out
  }
  if (!to || to.floor) return out
  if (!from) {
    if (to.placementPct > 0 || to.bidValueCents != null) out.push('newlyPlanned')
    return out
  }
  if (to.placementPct > from.placementPct) out.push('higherPlacement')
  if (to.bidValueCents != null && (from.bidValueCents == null || to.bidValueCents > from.bidValueCents)) out.push('higherBaseBid')
  return out
}

/** The hours a new week (or new target values) adds spend in, against the old. Pure. */
export function weekRaise(
  before: WeekPlan, beforeTargets: ReadonlyMap<string, TargetValues>,
  after: WeekPlan, afterTargets: ReadonlyMap<string, TargetValues>,
): WeekRaise {
  const out: WeekRaise = { leaveFloor: 0, higherPlacement: 0, higherBaseBid: 0, newlyPlanned: 0, changed: 0, toFloor: 0 }
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const a = hourOf(before, beforeTargets, day, hour)
      const b = hourOf(after, afterTargets, day, hour)
      if (a.key !== b.key || JSON.stringify(a.values) !== JSON.stringify(b.values)) out.changed++
      if (!a.values?.floor && b.values?.floor) out.toFloor++
      for (const why of hourRaise(a.values, b.values)) out[why]++
    }
  }
  return out
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** The raises of a week change in words (empty: it adds nothing). */
export function raiseWords(r: WeekRaise): string[] {
  return [
    r.leaveFloor ? `${plural(r.leaveFloor, 'hour')} a week leave the Min-bid floor` : '',
    r.higherPlacement ? `${plural(r.higherPlacement, 'hour')} a week hold a higher placement %` : '',
    r.higherBaseBid ? `${plural(r.higherBaseBid, 'hour')} a week set a higher base bid or floor` : '',
    r.newlyPlanned ? `${plural(r.newlyPlanned, 'hour')} a week come under a target that sets a placement % or a base bid` : '',
  ].filter(Boolean)
}

/** Does the week hold anything that adds spend when a campaign joins it (a placement %, or a base bid, in some hour)? */
export function weekAddsSpend(summary: WeekSummary): boolean {
  return summary.days.some((d) => d.highestPlacementPct > 0 || d.highestBaseBidCents != null)
}

// ── The next 24 hours ─────────────────────────────────────────────────────────────────────────────

/** (day, hour) of an instant in a time zone, as the engine resolves it. */
export function dayHourIn(tz: string, at: Date): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(at)
  const wk = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const day = (DAY_NAMES as readonly string[]).indexOf(wk)
  let hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24
  if (Number.isNaN(hour)) hour = 0
  return { day: day < 0 ? 0 : day, hour }
}

/**
 * The next 24 hours from the start of the current hour, as the target changes: the first line is what holds now, each
 * further line an hour where the target changes. Pure apart from Intl (the plan's own time zone).
 */
export function next24(plan: WeekPlan, targets: ReadonlyMap<string, TargetValues>, tz: string, now: Date = new Date()): Array<{ at: string; local: string; targetKey: string | null; floor: boolean }> {
  const start = new Date(now)
  start.setUTCMinutes(0, 0, 0)
  const out: Array<{ at: string; local: string; targetKey: string | null; floor: boolean }> = []
  let last: string | null | undefined
  for (let i = 0; i < 24; i++) {
    const at = new Date(start.getTime() + i * 3_600_000)
    const { day, hour } = dayHourIn(tz, at)
    const { key, values } = hourOf(plan, targets, day, hour)
    if (i > 0 && key === last) continue
    last = key
    out.push({ at: at.toISOString(), local: `${DAY_NAMES[day]} ${String(hour).padStart(2, '0')}:00`, targetKey: key, floor: values?.floor === true })
  }
  return out
}

// ── Painting ──────────────────────────────────────────────────────────────────────────────────────

/** A window as the plan stores it: whole hours, `endHour` exclusive, days 0 (Sunday) – 6. */
export interface PaintWindow { days: number[]; startHour: number; endHour: number; targetKey: string }

/**
 * Set the hours of the given days only: those days leave every window they were in (a window over other days keeps
 * them), then the painted windows come first (the first window covering an hour wins). Pure.
 */
export function paintDays(existing: unknown, days: readonly number[], painted: readonly PaintWindow[]): ScheduleWindow[] {
  const cleared = new Set(days)
  const kept: ScheduleWindow[] = []
  for (const w of windowsOf(existing)) {
    if (!w || typeof w !== 'object') continue
    const wDays = w.days && w.days.length ? w.days : [0, 1, 2, 3, 4, 5, 6]
    const left = wDays.filter((d) => !cleared.has(d))
    if (!left.length) continue
    kept.push(left.length === wDays.length && w.days?.length ? w : { ...w, days: left })
  }
  return [...painted.map((w) => ({ days: [...w.days].sort((a, b) => a - b), startHour: w.startHour, endHour: w.endHour, targetKey: w.targetKey })), ...kept]
}

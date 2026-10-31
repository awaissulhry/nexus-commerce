import { isApiError } from '../../../lib/api/errors'
import { formatNumber } from '../../../lib/i18n/format'
import { INTL_LOCALE, type Locale } from '../../../lib/i18n/locales'
import type { Translate } from '../../../lib/i18n/messages'
import { csvOf } from '../../_shared/buying/model'
import { CAPACITY_BUCKETS, LANE_KINDS, type Capacity, type CapacityBucket, type CapacityCell, type CapacityLane, type LaneKind } from './api'

/**
 * Planning › Capacity & load (SCR-123; design planning.capacity, a report), pure: the address (site, period, bucket, the
 * tile pressed, the open cell), the tiles and the lanes each one filters to (so a tile's number and the table agree),
 * the bucket heads, how a capacity is made said from its numbers (people × working minutes × efficiency × days, the
 * closed days, the days with no shift), the order J / K walk the cells in, the links to the board, and the CSV. Per
 * line and work centre only: no person, no money.
 */

export const NAMESPACE = 'planning-capacity'
export const TILE_IDS = ['over', 'free', 'most'] as const
export type CapacityTile = (typeof TILE_IDS)[number]

export interface CapacityControls {
  site: string | null
  /** The period's first and last day (`YYYY-MM-DD`); null: the API's default (today and four weeks on). */
  from: string | null
  to: string | null
  bucket: CapacityBucket
  /** The tile pressed: it filters the lanes. */
  tile: CapacityTile | null
  /** The open cell (`<LINE|WORK_CENTRE>:<lane id>:<bucket key>`). */
  cell: string | null
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

export function controlsOf(params: { get(name: string): string | null } | null | undefined): CapacityControls {
  const bucket = params?.get('bucket') ?? ''
  const tile = params?.get('tile') ?? ''
  const day = (name: string) => {
    const value = params?.get(name) ?? ''
    return DAY.test(value) ? value : null
  }
  return {
    site: params?.get('site') ?? null,
    from: day('from'),
    to: day('to'),
    bucket: (CAPACITY_BUCKETS as readonly string[]).includes(bucket) ? (bucket as CapacityBucket) : 'WEEK',
    tile: (TILE_IDS as readonly string[]).includes(tile) ? (tile as CapacityTile) : null,
    cell: params?.get('cell') ?? null,
  }
}

export function queryOf(controls: CapacityControls): string {
  const query = new URLSearchParams()
  if (controls.site) query.set('site', controls.site)
  if (controls.from) query.set('from', controls.from)
  if (controls.to) query.set('to', controls.to)
  if (controls.bucket !== 'WEEK') query.set('bucket', controls.bucket)
  if (controls.tile) query.set('tile', controls.tile)
  if (controls.cell) query.set('cell', controls.cell)
  return query.toString()
}

/** Whole days from one calendar day to another (positive: `to` is later). */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)

export const plusDays = (day: string, days: number): string => {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** The longest period the API answers (B-W2a-16: a two-year horizon fits). */
export const MAX_PERIOD_DAYS = 735

/** Why the period cannot be read (a key of the catalogue), or null. */
export function periodProblem(controls: Pick<CapacityControls, 'from' | 'to'>): string | null {
  if (!controls.from || !controls.to) return null
  if (controls.to < controls.from) return 'period.backwards'
  if (daysBetween(controls.from, controls.to) > MAX_PERIOD_DAYS) return 'period.tooLong'
  return null
}

/** A new first day keeps the period's length (four weeks when none was set); a last day before it moves with it. */
export function withFrom(controls: CapacityControls, from: string, shown: { from: string; to: string } | null): Pick<CapacityControls, 'from' | 'to'> {
  const length = shown ? daysBetween(shown.from, shown.to) : 28
  const to = controls.to && controls.to >= from ? controls.to : plusDays(from, Math.max(0, length))
  return { from, to }
}

// ---- cells ---------------------------------------------------------------------------------------------------------------

export const cellKeyOf = (lane: { kind: LaneKind; id: string }, bucketKey: string): string => `${lane.kind}:${lane.id}:${bucketKey}`

export function parseCellKey(key: string | null): { kind: LaneKind; laneId: string; bucketKey: string } | null {
  if (!key) return null
  const [kind, laneId, ...rest] = key.split(':')
  if (!kind || !laneId || rest.length === 0 || !(LANE_KINDS as readonly string[]).includes(kind)) return null
  return { kind: kind as LaneKind, laneId, bucketKey: rest.join(':') }
}

export function cellAt(capacity: Capacity, key: string | null): { lane: CapacityLane; cell: CapacityCell } | null {
  const parsed = parseCellKey(key)
  if (!parsed) return null
  const lane = capacity.lanes.find((entry) => entry.kind === parsed.kind && entry.id === parsed.laneId)
  const cell = lane?.cells.find((entry) => entry.key === parsed.bucketKey)
  return lane && cell ? { lane, cell } : null
}

/** J / K walk the cells lane by lane, bucket by bucket, of the lanes shown. */
export const cellOrder = (lanes: readonly CapacityLane[]): string[] => lanes.flatMap((lane) => lane.cells.map((cell) => cellKeyOf(lane, cell.key)))

// ---- tiles -----------------------------------------------------------------------------------------------------------

const pct = (value: string | null): number | null => (value === null ? null : Number(value))

/** The lane's cell that holds today (the tiles speak of this week). */
export const todayCell = (lane: CapacityLane, today: string): CapacityCell | null => lane.cells.find((cell) => cell.from <= today && today <= cell.to) ?? null

/** The lanes a tile shows: over 100 % this week, with free minutes in the period, or the most loaded lane. */
export function lanesOf(capacity: Capacity, tile: CapacityTile | null): CapacityLane[] {
  switch (tile) {
    case 'over':
      return capacity.lanes.filter((lane) => (pct(todayCell(lane, capacity.today)?.loadPct ?? null) ?? 0) > 100)
    case 'free':
      return capacity.lanes.filter((lane) => Number(lane.overall.availableMinutes) > Number(lane.overall.bookedMinutes))
    case 'most': {
      const most = capacity.tiles.mostLoadedThisWeek
      return most ? capacity.lanes.filter((lane) => lane.kind === most.kind && lane.id === most.id) : []
    }
    default:
      return [...capacity.lanes]
  }
}

// ---- words -------------------------------------------------------------------------------------------------------------

export interface Words {
  t: Translate
  locale: Locale
}

export const minutesText = (value: number | string, locale: Locale): string => formatNumber(Number(value), locale, { maximumFractionDigits: 1 })
const percentText = (value: number | string, locale: Locale): string => formatNumber(Number(value), locale, { maximumFractionDigits: 2 })

export function dayWords(date: string, locale: Locale, withWeekday = false): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', day: 'numeric', month: 'short', ...(withWeekday ? { weekday: 'short' } : {}) }).format(new Date(Date.UTC(year, month - 1, day)))
}

/** A bucket's head: "Week 47 · 16–22 Nov", "Mon 16 Nov", "Nov 2026" (a cut bucket says its days). */
export function bucketLabel(bucket: { key: string; kind: string; from: string; to: string }, words: Words): string {
  const { t, locale } = words
  if (bucket.kind === 'DAY') return dayWords(bucket.from, locale, true)
  if (bucket.kind === 'MONTH') {
    const [year, month] = bucket.from.split('-').map(Number) as [number, number]
    return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', month: 'short', year: 'numeric' }).format(new Date(Date.UTC(year, month - 1, 15)))
  }
  const week = /W(\d{2})$/.exec(bucket.key)?.[1]
  return t('bucket.week', { week: week ? String(Number(week)) : '—', range: rangeWords(bucket.from, bucket.to, locale) })
}

/** Two days as a short range: "16–22 Nov", "30 Nov–6 Dec" (one month said once). */
export function rangeWords(from: string, to: string, locale: Locale): string {
  if (from === to) return dayWords(from, locale)
  if (from.slice(0, 7) === to.slice(0, 7)) {
    const [year, month] = to.split('-').map(Number) as [number, number]
    const tail = new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', month: 'short' }).format(new Date(Date.UTC(year, month - 1, 15)))
    return `${Number(from.slice(8, 10))}–${Number(to.slice(8, 10))} ${tail}`
  }
  return `${dayWords(from, locale)}–${dayWords(to, locale)}`
}

/** The cell's title in the DetailModal: "Line 2 · week 46". */
export function cellTitle(lane: CapacityLane, bucket: { key: string; kind: string; from: string; to: string }, words: Words): string {
  return words.t('cell.title', { lane: lane.name, bucket: bucketLabel(bucket, words) })
}

/**
 * "How this capacity is made" (design pop:how): "8 people × 450 min × 85% efficiency × 5 days = 15,300 min", the closed
 * days with their names, the weekdays the shift pattern has no shift on, and what is booked (on the board, or at the
 * due date). From the cell's numbers; the API's English sentence is never drawn.
 */
export function howWords(lane: CapacityLane, cell: CapacityCell, words: Words): string[] {
  const { t, locale } = words
  const lines: string[] = []
  const available = Number(cell.availableMinutes)
  const unit = lane.kind === 'LINE' ? 'people' : 'stations'
  if (cell.workingDays === 0) lines.push(t('how.noDays'))
  else if (cell.people === 0) lines.push(t(lane.kind === 'LINE' ? 'how.noPeople' : 'how.noStations'))
  else if (cell.minutesPerDay !== null)
    lines.push(t(`how.formula.${unit}`, { count: cell.people, people: String(cell.people), minutes: minutesText(cell.minutesPerDay, locale), efficiency: percentText(cell.efficiencyPct, locale), days: String(cell.workingDays), available: minutesText(available, locale) }))
  else lines.push(t(`how.formulaVaried.${unit}`, { count: cell.people, people: String(cell.people), minutes: minutesText(cell.workingMinutes, locale), efficiency: percentText(cell.efficiencyPct, locale), days: String(cell.workingDays), available: minutesText(available, locale) }))
  if (cell.closedDays.length > 0) lines.push(t('how.closed', { days: cell.closedDays.map((day) => `${dayWords(day.date, locale)} (${day.name || t(`how.closedReason.${day.reason}`)})`).join(', ') }))
  if (cell.noShiftDays.length > 0) lines.push(t('how.noShift', { days: cell.noShiftDays.map((day) => dayWords(day, locale, true)).join(', ') }))
  lines.push(t(`how.efficiency.${lane.efficiencySource}`, { efficiency: percentText(lane.efficiencyPct, locale) }))
  lines.push(t(`how.people.${lane.kind}.${lane.peopleSource}`, { count: lane.people, people: String(lane.people) }))
  const booked = Number(cell.bookedMinutes)
  const onBoard = Number(cell.scheduledMinutes)
  if (booked > 0) lines.push(onBoard >= booked ? t('how.bookedBoard', { booked: minutesText(booked, locale) }) : t('how.bookedDue', { booked: minutesText(booked, locale), board: minutesText(onBoard, locale), due: minutesText(booked - onBoard, locale) }))
  else lines.push(t('how.nothingBooked'))
  return lines
}

/** The row end: the efficiency used, the people (or stations) and the shift pattern; `full` says where each comes from. */
export function laneEnd(lane: CapacityLane, words: Words): { efficiency: string; people: string; pattern: string; full: string } {
  const { t, locale } = words
  const efficiency = percentText(lane.efficiencyPct, locale)
  const people = String(lane.people)
  const pattern = lane.pattern.source === 'DEFAULT' ? t('lane.patternDefault') : t('lane.pattern', { name: lane.pattern.name })
  return {
    efficiency: t('lane.efficiencyShort', { efficiency }),
    people: t(`lane.peopleShort.${lane.kind}`, { count: lane.people, people }),
    pattern,
    full: [
      t('lane.efficiency', { efficiency, source: t(`lane.source.${lane.efficiencySource}`) }),
      t(`lane.people.${lane.kind}`, { count: lane.people, people, source: t(`lane.peopleSource.${lane.peopleSource}`) }),
      pattern,
    ].join(' · '),
  }
}

/** Under the lane's name: what is open but in no bucket (past due, no due date) and what waits on hold. */
export function laneNotes(lane: CapacityLane, words: Words): string[] {
  const { t, locale } = words
  const notes: string[] = []
  const pastDue = Number(lane.unplaced.pastDueMinutes)
  const undated = Number(lane.unplaced.undatedMinutes)
  if (pastDue > 0) notes.push(t('lane.pastDue', { minutes: minutesText(pastDue, locale) }))
  if (undated > 0) notes.push(t('lane.undated', { minutes: minutesText(undated, locale) }))
  if (lane.heldWorkOrders > 0) notes.push(t('lane.held', { count: lane.heldWorkOrders }))
  return notes
}

// ---- links -------------------------------------------------------------------------------------------------------------

/** The planning board filtered to lanes (design tab:board: a window of its own), from a day. */
export function boardHref(prefix: string, siteId: string | null, lanes: readonly { kind: LaneKind; id: string }[], from?: string | null): string {
  const query = new URLSearchParams()
  if (siteId) query.set('site', siteId)
  if (lanes.length > 0) query.set('lane', lanes.map((lane) => `${lane.kind}:${lane.id}`).join(','))
  if (from) query.set('from', from)
  return `${prefix}/planning/board?${query.toString()}`
}

/** A lane's calendar in Planning settings (the "link to the calendar" of the how popover). */
export const calendarHref = (prefix: string, siteId: string | null, calendarId: string): string => `${prefix}/planning/settings?${siteId ? `site=${encodeURIComponent(siteId)}&` : ''}tab=calendars&cal=${encodeURIComponent(calendarId)}`

// ---- refusals and CSV --------------------------------------------------------------------------------------------------

export function readProblemOf(error: unknown): string {
  if (!isApiError(error)) return 'error.failed'
  if (error.kind === 'forbidden' || error.kind === 'step_up') return 'error.forbidden'
  if (error.kind === 'unavailable') return 'error.offline'
  if (error.kind === 'invalid') return 'error.period'
  if (error.kind === 'not_found') return 'error.gone'
  return 'error.failed'
}

/** The lanes shown as a CSV: one row per lane and bucket (available, booked, load), then the row end. */
export function csvOfLanes(capacity: Capacity, lanes: readonly CapacityLane[], words: Words): string {
  const { t } = words
  const header = ['lane', 'kind', 'bucket', 'from', 'to', 'available', 'booked', 'load', 'efficiency', 'people'].map((column) => t(`csv.${column}`))
  const rows = lanes.flatMap((lane) =>
    lane.cells.map((cell) => {
      const bucket = capacity.buckets.find((entry) => entry.key === cell.key) ?? { key: cell.key, kind: capacity.bucket, from: cell.from, to: cell.to }
      return [lane.code, t(`kind.${lane.kind}`), bucketLabel(bucket, words), cell.from, cell.to, cell.availableMinutes, cell.bookedMinutes, cell.loadPct ?? '', lane.efficiencyPct, lane.people]
    }),
  )
  return csvOf(header, rows)
}

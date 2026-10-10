/**
 * WeekHourGrid — the pure model (ads brain page D1, 2026-10-10). No React, no DOM: tested in Node.
 *
 * Named `weekHourModel`, not `weekHourGrid`: a name that differs from `WeekHourGrid.tsx` only by case resolves to the
 * wrong file on a case-insensitive disk (macOS) — `./WeekHourGrid` found the `.ts` model first.
 *
 * Two coordinate spaces, kept apart on purpose:
 *  - the ADDRESS `{ day, hour }`: day 0..6 with 0 = Sunday, hour 0..23 — what an hourly plan and a lock store
 *    (`d<0-6>h<0-23>`, in the market's time zone). The caller's `cells` are indexed by it: `cells[day][hour]`.
 *  - the POSITION `{ dayIndex, hour }`: dayIndex is the place in `dayOrder` (Monday first by default). Selection,
 *    keys and drawing work here, so a rectangle on screen is a rectangle in the model in either orientation.
 *
 * On its side (a phone): rows are hours and columns are days. The arrow keys follow the SCREEN; Home/End (first and
 * last hour) and PageUp/PageDown (previous and next day) keep their meaning in both orientations.
 */

export const WEEK_DAYS = 7
export const DAY_HOURS = 24
/** At most six brushes: the keys 1–6 pick them. */
export const WEEK_HOUR_MAX_BRUSHES = 6
/** Below this container width (px) the week turns on its side: 7 columns of days fit a 390 px phone. */
export const WEEK_HOUR_SIDE_BELOW = 640
/** Monday first; the address keeps 0 = Sunday. */
export const MONDAY_FIRST: readonly number[] = [1, 2, 3, 4, 5, 6, 0]
/** Research shading: step 0 is a measured zero, 1..5 the ramp. A null is NO DATA and has no step. */
export const HEAT_STEPS = 6

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

export type WeekHourMode = 'view' | 'paint' | 'lock'
export type WeekHourOrientation = 'week' | 'side'
export type WeekHourTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent'

export interface WeekHourBrush {
  id: string
  label: string
  tone: WeekHourTone
  description?: string
  /** One or two letters drawn in the cell, so a brush never rests on colour alone. Default: the label's first letter. */
  mark?: string
}

export interface WeekHourCell {
  /** The plan's value in this hour (a brush id); null = no value set (base). */
  brush: string | null
  /** The Owner's lock: the brain never writes this hour, and Paint skips it. */
  locked?: boolean
  /** Research shading; null = NO DATA (hatched), never drawn as 0. Undefined = no research shown. */
  heat?: number | null
  /** The brush before a proposed change: drawn as a change mark, read out as "was …". */
  before?: string | null
}

export interface WeekHourAddress { day: number; hour: number }
export interface WeekHourPos { dayIndex: number; hour: number }
export interface WeekHourRect { dayFrom: number; dayTo: number; hourFrom: number; hourTo: number }

/* ── addresses and words ───────────────────────────────────────────────────────────────────────────────────────── */

/** The lock / plan address: `d2h20` = Tuesday 20:00. */
export const weekHourKey = (day: number, hour: number): string => `d${day}h${hour}`

export function parseWeekHourKey(key: string): WeekHourAddress | null {
  const m = /^d([0-6])h(\d{1,2})$/.exec(key)
  if (!m) return null
  const hour = Number(m[2])
  return hour < DAY_HOURS ? { day: Number(m[1]), hour } : null
}

export const dayName = (day: number): string => DAY_NAMES[day] ?? `Day ${day}`
export const dayShort = (day: number): string => dayName(day).slice(0, 3)
export const hourText = (hour: number): string => `${String(hour).padStart(2, '0')}:00`
export const hourShort = (hour: number): string => String(hour).padStart(2, '0')

export const addressOf = (pos: WeekHourPos, dayOrder: readonly number[] = MONDAY_FIRST): WeekHourAddress => ({
  day: dayOrder[pos.dayIndex] ?? pos.dayIndex,
  hour: pos.hour,
})

export const posOf = (addr: WeekHourAddress, dayOrder: readonly number[] = MONDAY_FIRST): WeekHourPos => ({
  dayIndex: Math.max(0, dayOrder.indexOf(addr.day)),
  hour: addr.hour,
})

/** A missing row or hour reads as an empty hour, never as a crash: the caller's array may be short while it loads. */
export const cellAt = (cells: readonly (readonly WeekHourCell[])[], day: number, hour: number): WeekHourCell =>
  cells[day]?.[hour] ?? { brush: null }

/* ── orientation ───────────────────────────────────────────────────────────────────────────────────────────────── */

export const orientationFor = (width: number): WeekHourOrientation => (width > 0 && width < WEEK_HOUR_SIDE_BELOW ? 'side' : 'week')

/** Rows × columns on screen. */
export const visualSize = (o: WeekHourOrientation) => (o === 'week' ? { rows: WEEK_DAYS, cols: DAY_HOURS } : { rows: DAY_HOURS, cols: WEEK_DAYS })

export const toVisual = (pos: WeekHourPos, o: WeekHourOrientation) =>
  o === 'week' ? { row: pos.dayIndex, col: pos.hour } : { row: pos.hour, col: pos.dayIndex }

export const fromVisual = (row: number, col: number, o: WeekHourOrientation): WeekHourPos =>
  o === 'week' ? { dayIndex: row, hour: col } : { dayIndex: col, hour: row }

/* ── selection ─────────────────────────────────────────────────────────────────────────────────────────────────── */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
export const clampPos = (p: WeekHourPos): WeekHourPos => ({ dayIndex: clamp(p.dayIndex, 0, WEEK_DAYS - 1), hour: clamp(p.hour, 0, DAY_HOURS - 1) })

export const rectOf = (a: WeekHourPos, b: WeekHourPos): WeekHourRect => ({
  dayFrom: Math.min(a.dayIndex, b.dayIndex),
  dayTo: Math.max(a.dayIndex, b.dayIndex),
  hourFrom: Math.min(a.hour, b.hour),
  hourTo: Math.max(a.hour, b.hour),
})
export const dayRect = (dayIndex: number): WeekHourRect => ({ dayFrom: dayIndex, dayTo: dayIndex, hourFrom: 0, hourTo: DAY_HOURS - 1 })
export const hourRect = (hour: number): WeekHourRect => ({ dayFrom: 0, dayTo: WEEK_DAYS - 1, hourFrom: hour, hourTo: hour })
export const weekRect = (): WeekHourRect => ({ dayFrom: 0, dayTo: WEEK_DAYS - 1, hourFrom: 0, hourTo: DAY_HOURS - 1 })

export const inRect = (p: WeekHourPos, r: WeekHourRect): boolean =>
  p.dayIndex >= r.dayFrom && p.dayIndex <= r.dayTo && p.hour >= r.hourFrom && p.hour <= r.hourTo

export const rectSize = (r: WeekHourRect): number => (r.dayTo - r.dayFrom + 1) * (r.hourTo - r.hourFrom + 1)

/** The hours of a rectangle as addresses, in screen order (day by day, then hour by hour). */
export function rectAddresses(r: WeekHourRect, dayOrder: readonly number[] = MONDAY_FIRST): WeekHourAddress[] {
  const out: WeekHourAddress[] = []
  for (let d = r.dayFrom; d <= r.dayTo; d++) for (let h = r.hourFrom; h <= r.hourTo; h++) out.push(addressOf({ dayIndex: d, hour: h }, dayOrder))
  return out
}

/* ── the key reducer ───────────────────────────────────────────────────────────────────────────────────────────── */

/** `anchor` null = nothing selected beyond the focused hour. The selection is always rect(anchor ?? focus, focus). */
export interface WeekHourCursor { focus: WeekHourPos; anchor: WeekHourPos | null }

export const selectionOf = (c: WeekHourCursor): WeekHourRect => rectOf(c.anchor ?? c.focus, c.focus)

export interface WeekHourKeyInput { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }
export type WeekHourKeyEffect = { kind: 'apply' } | { kind: 'brush'; index: number } | { kind: 'clear' }
export interface WeekHourKeyResult {
  cursor: WeekHourCursor
  effect: WeekHourKeyEffect | null
  /** false = the grid leaves the key alone (no preventDefault): Tab, an Escape with nothing selected (a drawer closes). */
  handled: boolean
}

const ARROWS: Record<string, { row: number; col: number }> = {
  ArrowUp: { row: -1, col: 0 },
  ArrowDown: { row: 1, col: 0 },
  ArrowLeft: { row: 0, col: -1 },
  ArrowRight: { row: 0, col: 1 },
}

export function weekHourKeyReducer(
  cursor: WeekHourCursor,
  input: WeekHourKeyInput,
  opts: { orientation: WeekHourOrientation; brushCount: number },
): WeekHourKeyResult {
  const { key, shiftKey = false } = input
  const command = !!(input.ctrlKey || input.metaKey)
  const same = { cursor, effect: null, handled: false }
  if (input.altKey) return same

  const moveTo = (next: WeekHourPos): WeekHourKeyResult => ({
    cursor: { focus: clampPos(next), anchor: shiftKey ? (cursor.anchor ?? cursor.focus) : null },
    effect: null,
    handled: true,
  })
  const f = cursor.focus

  const arrow = ARROWS[key]
  if (arrow) {
    if (command) return same
    const v = toVisual(f, opts.orientation)
    return moveTo(fromVisual(v.row + arrow.row, v.col + arrow.col, opts.orientation))
  }
  switch (key) {
    case 'Home':
      return moveTo(command ? { dayIndex: 0, hour: 0 } : { dayIndex: f.dayIndex, hour: 0 })
    case 'End':
      return moveTo(command ? { dayIndex: WEEK_DAYS - 1, hour: DAY_HOURS - 1 } : { dayIndex: f.dayIndex, hour: DAY_HOURS - 1 })
    case 'PageUp':
      return command ? same : moveTo({ dayIndex: f.dayIndex - 1, hour: f.hour })
    case 'PageDown':
      return command ? same : moveTo({ dayIndex: f.dayIndex + 1, hour: f.hour })
    case ' ':
    case 'Spacebar':
    case 'Enter':
      return command ? same : { cursor, effect: { kind: 'apply' }, handled: true }
    case 'Escape':
      return cursor.anchor ? { cursor: { focus: f, anchor: null }, effect: { kind: 'clear' }, handled: true } : same
    case 'a':
    case 'A':
      return command && !shiftKey
        ? { cursor: { anchor: { dayIndex: 0, hour: 0 }, focus: { dayIndex: WEEK_DAYS - 1, hour: DAY_HOURS - 1 } }, effect: null, handled: true }
        : same
  }
  if (/^[1-6]$/.test(key) && !command && !shiftKey) {
    const index = Number(key) - 1
    if (index < Math.min(opts.brushCount, WEEK_HOUR_MAX_BRUSHES)) return { cursor, effect: { kind: 'brush', index }, handled: true }
  }
  return same
}

/* ── what an edit does ─────────────────────────────────────────────────────────────────────────────────────────── */

/** Paint never writes a locked hour: those are skipped and counted, so the page can say so. */
export function paintPlan(cells: readonly (readonly WeekHourCell[])[], hours: readonly WeekHourAddress[]) {
  const open = hours.filter((a) => !cellAt(cells, a.day, a.hour).locked)
  return { hours: open, skipped: hours.length - open.length }
}

/** One flip for the whole selection: all locked → unlock them; otherwise lock the ones that are not. */
export function lockPlan(cells: readonly (readonly WeekHourCell[])[], hours: readonly WeekHourAddress[]) {
  const allLocked = hours.length > 0 && hours.every((a) => cellAt(cells, a.day, a.hour).locked)
  const locked = !allLocked
  return { locked, hours: hours.filter((a) => !!cellAt(cells, a.day, a.hour).locked !== locked) }
}

const hoursWord = (n: number) => `${n} ${n === 1 ? 'hour' : 'hours'}`

export function paintAnnouncement(brushLabel: string, painted: number, skipped: number): string {
  if (painted === 0) return skipped > 0 ? `${skipped === 1 ? 'That hour is' : `All ${skipped} hours are`} locked; unlock first to paint.` : 'Nothing to paint.'
  const kept = skipped > 0 ? `; ${hoursWord(skipped)} locked, kept` : ''
  return `${brushLabel} applied to ${hoursWord(painted)}${kept}.`
}

export const lockAnnouncement = (changed: number, locked: boolean): string =>
  changed === 0 ? 'Nothing changed.' : `${hoursWord(changed)} ${locked ? 'locked' : 'unlocked'}.`

/* ── research shading ──────────────────────────────────────────────────────────────────────────────────────────── */

/** The largest measured value; nulls are left out so one missing hour cannot flatten the ramp. */
export function heatMax(cells: readonly (readonly WeekHourCell[])[]): number {
  let max = 0
  for (const row of cells) for (const c of row ?? []) if (typeof c?.heat === 'number' && Number.isFinite(c.heat) && c.heat > max) max = c.heat
  return max
}

/** null / undefined → null (NO DATA, hatched); a measured 0 (or below) → 0; else 1..5 by its share of the max. */
export function heatStep(value: number | null | undefined, max: number): number | null {
  if (value == null || !Number.isFinite(value)) return null
  if (value <= 0 || max <= 0) return 0
  return clamp(Math.ceil((value / max) * (HEAT_STEPS - 1)), 1, HEAT_STEPS - 1)
}

/* ── the words of a cell ───────────────────────────────────────────────────────────────────────────────────────── */

export interface WeekHourWordsContext {
  brushes: readonly WeekHourBrush[]
  /** The word for an hour with no value. Default "Base". */
  baseLabel?: string
  formatHeat?: (v: number | null) => string
  heatLabel?: string
}

export function brushLabel(id: string | null | undefined, ctx: WeekHourWordsContext): string {
  if (id == null) return ctx.baseLabel ?? 'Base'
  return ctx.brushes.find((b) => b.id === id)?.label ?? id
}

export const brushMark = (b: WeekHourBrush): string => (b.mark ?? b.label.trim().charAt(0)).slice(0, 2)

export const isChanged = (c: WeekHourCell): boolean => c.before !== undefined && (c.before ?? null) !== (c.brush ?? null)

export function heatWords(v: number | null, ctx: Pick<WeekHourWordsContext, 'formatHeat' | 'heatLabel'>): string {
  if (ctx.formatHeat) return ctx.formatHeat(v)
  if (v == null) return 'no data'
  return ctx.heatLabel ? `${ctx.heatLabel} ${v}` : String(v)
}

/** "Tuesday 20:00", "Push", "locked", "was Base", "9 orders" — the cell's name and the detail line are both built from it. */
export function weekHourCellParts(addr: WeekHourAddress, cell: WeekHourCell, ctx: WeekHourWordsContext): string[] {
  const parts = [`${dayName(addr.day)} ${hourText(addr.hour)}`, brushLabel(cell.brush, ctx)]
  if (cell.locked) parts.push('locked')
  if (isChanged(cell)) parts.push(`was ${brushLabel(cell.before, ctx)}`)
  if (cell.heat !== undefined) parts.push(heatWords(cell.heat, ctx))
  return parts
}

export const weekHourCellName = (addr: WeekHourAddress, cell: WeekHourCell, ctx: WeekHourWordsContext): string =>
  weekHourCellParts(addr, cell, ctx).join(', ')

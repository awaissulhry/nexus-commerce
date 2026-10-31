/**
 * DayStrip's rules (B-W2b-28, design part DayStrip): one person's or one machine's day as a horizontal bar — the shift
 * window, clocked spans and breaks, clock events, overlays (scan minutes, machine status), anomaly marks — and the same
 * day as text, line by line, for a screen reader (and on screen when asked).
 *
 * - **Window**: the part of the day drawn (`from`–`to`, e.g. 06:00–22:00, or across midnight for a night shift). Spans
 *   are clipped to it; a span wholly outside is not drawn but still listed in the text.
 * - **Ticks** on whole hours in the site's zone, every `stepHours` (the zone's minute at the window start decides where
 *   the first one falls, so a half-hour zone and a DST change stay on whole hours).
 * - **Text**: the shift first, then every span, event, overlay span and anomaly in time order (anomalies without a time
 *   last), each a sentence in the page's words.
 */

export type DayMoment = string | number

export type DaySegmentKind = 'work' | 'break' | 'absence' | 'overtime' | 'idle'
export type DayEventKind = 'in' | 'out' | 'auto-out' | 'manual' | 'forgot-badge' | 'other'
export type DayTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

export interface DaySegment {
  id: string
  from: DayMoment
  to: DayMoment
  kind: DaySegmentKind
  /** Words after the kind ("from the badge reader"). */
  label?: string
}

export interface DayEvent {
  id: string
  at: DayMoment
  kind: DayEventKind
  label?: string
  /** Marked for a check (a forgot-badge PIN, a manual entry). */
  flagged?: boolean
}

export interface DayOverlaySpan {
  id: string
  from: DayMoment
  to: DayMoment
  label: string
  tone?: DayTone
}

export interface DayOverlay {
  id: string
  /** The row's name ("Scan minutes", "Machine status"). */
  name: string
  spans: readonly DayOverlaySpan[]
}

export interface DayAnomaly {
  id: string
  /** When, if it has a moment (a missing clock-out has none). */
  at?: DayMoment
  label: string
}

/** An ISO instant or epoch ms as epoch ms; NaN when it is neither. */
export function dayMs(m: DayMoment): number {
  return typeof m === 'number' ? m : Date.parse(m)
}

export interface DayWindow {
  from: number
  to: number
}

/** Where a moment sits in the window, 0–100 (clamped). */
export function dayPct(w: DayWindow, t: number): number {
  if (!(w.to > w.from) || !Number.isFinite(t)) return 0
  return Math.min(100, Math.max(0, ((t - w.from) / (w.to - w.from)) * 100))
}

/** A span's left and width in %, clipped to the window; null when it is outside it or not a span. */
export function daySpan(w: DayWindow, from: number, to: number): { left: number; width: number } | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from || to <= w.from || from >= w.to) return null
  const left = dayPct(w, from)
  return { left, width: dayPct(w, to) - left }
}

const HOUR = 3_600_000
const MINUTE = 60_000

/**
 * The moments of the hour ticks: whole hours in the site's zone, every `stepHours`. `zoneMinute(ms)` is the minute of
 * the hour in that zone (with seconds as a fraction), so the first tick is the next whole hour after `from`.
 */
export function dayTicks(w: DayWindow, stepHours: number, zoneMinute: (ms: number) => number): number[] {
  if (!(w.to > w.from) || !(stepHours > 0)) return []
  const minute = zoneMinute(w.from)
  const first = minute === 0 ? w.from : w.from + (60 - minute) * MINUTE
  const out: number[] = []
  for (let t = first; t <= w.to; t += stepHours * HOUR) out.push(t)
  return out
}

export interface DayWords {
  kinds: Record<DaySegmentKind, string>
  events: Record<DayEventKind, string>
  /** "Shift 08:00–17:00". */
  shift: (from: string, to: string) => string
  /** "Worked 08:02–12:00". */
  span: (what: string, from: string, to: string) => string
  /** "Clock-in at 08:02". */
  at: (what: string, time: string) => string
  /** Added to a flagged event. */
  flagged: string
  /** Before an anomaly's words. */
  anomaly: string
}

export interface DayDay {
  shift?: { from: DayMoment; to: DayMoment; label?: string }
  segments?: readonly DaySegment[]
  events?: readonly DayEvent[]
  overlays?: readonly DayOverlay[]
  anomalies?: readonly DayAnomaly[]
}

const join = (...parts: (string | undefined | false)[]) => parts.filter((p): p is string => !!p && p.trim() !== '').join(' — ')

/** The day as sentences, the shift first, then everything in time order, anomalies without a time last. */
export function dayStripLines(day: DayDay, words: DayWords, time: (ms: number) => string): string[] {
  const timed: { t: number; text: string }[] = []
  for (const s of day.segments ?? []) timed.push({ t: dayMs(s.from), text: join(words.span(words.kinds[s.kind], time(dayMs(s.from)), time(dayMs(s.to))), s.label) })
  for (const e of day.events ?? []) timed.push({ t: dayMs(e.at), text: join(words.at(words.events[e.kind], time(dayMs(e.at))), e.label, e.flagged && words.flagged) })
  for (const o of day.overlays ?? []) for (const s of o.spans) timed.push({ t: dayMs(s.from), text: `${o.name}: ${words.span(s.label, time(dayMs(s.from)), time(dayMs(s.to)))}` })
  const untimed: string[] = []
  for (const a of day.anomalies ?? []) {
    if (a.at !== undefined && Number.isFinite(dayMs(a.at))) timed.push({ t: dayMs(a.at), text: `${words.anomaly}: ${words.at(a.label, time(dayMs(a.at)))}` })
    else untimed.push(`${words.anomaly}: ${a.label}`)
  }
  timed.sort((a, b) => a.t - b.t)
  const head = day.shift ? [join(words.shift(time(dayMs(day.shift.from)), time(dayMs(day.shift.to))), day.shift.label)] : []
  return [...head, ...timed.map((x) => x.text), ...untimed]
}

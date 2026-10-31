/**
 * DueCell's rules (B-W2b-28, design part DueCell): a due date read as a tone and words — training expiry, a statutory
 * check, a visit, a job — and sorted by urgency, not by date alone.
 *
 * - **Tones**: `overdue` (the date passed), `soon` (within `soonDays`, default 30, today included), `valid` (later),
 *   `needed` (required, nothing on record yet), `done`, `none` (no date and nothing required).
 * - **Days** count calendar days between two dates (`YYYY-MM-DD`, or the date part of an ISO instant), with no clock and
 *   no time zone in the sum: the app passes `today` as the SITE's date (the browser's local date by default).
 * - **Urgency order** (ascending = most urgent first): overdue (most days late first), needed, soon (soonest first),
 *   valid (soonest first), done, none. `dueComparator` gives AG Grid's `comparator` that order.
 */

export type DueTone = 'overdue' | 'needed' | 'soon' | 'valid' | 'done' | 'none'

export interface DueValue {
  /** The due date: `YYYY-MM-DD` or an ISO instant (its date part is used). */
  due?: string | null
  /** `needed`: required and missing; `done`: done (a job, a visit). Wins over the date. */
  state?: 'needed' | 'done' | null
  /** When it was done. */
  doneOn?: string | null
}

/** A cell's value: a date string, a `DueValue`, or nothing. */
export type DueInput = DueValue | string | null | undefined

export interface DueOptions {
  /** The site's date today (`YYYY-MM-DD`). Default: the browser's local date. */
  today?: string
  /** Days ahead that count as soon. Default 30. */
  soonDays?: number
}

export interface DueStatus {
  tone: DueTone
  /** Days from today to the due date (negative: late); null without a date. */
  days: number | null
}

const DAY = 86_400_000

/** A calendar date as a day number; null when it is not a date. */
export function dueDay(value: string | null | undefined): number | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim())
  if (!m) return null
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(t)
  // 2026-02-30 is not a date.
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) return null
  return Math.round(t / DAY)
}

/** The browser's local date as `YYYY-MM-DD`. */
export function localToday(now: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

/** Any cell value as a `DueValue`. */
export function dueValueOf(input: unknown): DueValue {
  if (typeof input === 'string') return { due: input }
  if (input && typeof input === 'object') return input as DueValue
  return {}
}

export function dueStatus(input: unknown, { today = localToday(), soonDays = 30 }: DueOptions = {}): DueStatus {
  const v = dueValueOf(input)
  if (v.state === 'done') return { tone: 'done', days: null }
  const due = dueDay(v.due)
  const now = dueDay(today)
  if (due === null || now === null) return { tone: v.state === 'needed' ? 'needed' : 'none', days: null }
  const days = due - now
  if (days < 0) return { tone: 'overdue', days }
  return { tone: days <= soonDays ? 'soon' : 'valid', days }
}

const GROUP: Record<DueTone, number> = { overdue: 0, needed: 1, soon: 2, valid: 3, done: 4, none: 5 }

/** A number that sorts by urgency (smaller = more urgent). */
export function dueRank(status: DueStatus): number {
  const days = status.days === null ? 0 : Math.max(-4_000_000, Math.min(4_000_000, status.days))
  return GROUP[status.tone] * 10_000_000 + days + 5_000_000
}

/** AG Grid's `comparator` for a due column: most urgent first when ascending. */
export function dueComparator(options: DueOptions = {}): (a: unknown, b: unknown) => number {
  return (a, b) => dueRank(dueStatus(a, options)) - dueRank(dueStatus(b, options))
}

/**
 * Reviews › Requests › Timing — the two editable tables and the send-hour picture, pure:
 *   - "First try by product type" (`/api/review-timing-defaults`): rows in order (the first match from the top wins),
 *     moved, added, removed; the PUT body; what changed; why Save is held.
 *   - "Send hour by weekday" (`/api/review-send-windows`): a market's own seven days, or the global default it uses;
 *     the PUT body; what changed.
 *   - The heatmap (`/api/review-send-windows/conversion`): weekday × hour shaded by review rate, the hour we send
 *     outlined, each cell's words; the parts of the day; the small-sample words.
 * Tested in timingModel.vitest.test.ts.
 */
import type { RuleItem } from '../../rules/_rules/rulesModel'

export interface TimingDefault { id?: string; pattern: string; label: string; delayDays: number; sortOrder: number; isActive: boolean }
export interface SendWindow { marketplace: string; dayOfWeek: number; hourLocal: number; dayRank: number; isActive: boolean }
/**
 * One weekday × hour: every request sent then (`sent`), the ones a review can follow (`measured`, the rate's base) and
 * those a review followed. An older answer has no `measured`: then every sent request counted.
 */
export interface ConversionCell { dayOfWeek: number; hour: number; sent: number; measured?: number; converted: number }
export interface ConversionReport {
  windowDays: number; marketplace: string | null; totalSent: number; totalMeasured?: number; totalConverted: number; hasReviews: boolean
  /** "Not measurable: …" when no review can follow these requests; why some are left out; null when all count. */
  words?: string | null
  cells: ConversionCell[]
}

const measuredOf = (c: Pick<ConversionCell, 'sent' | 'measured'>) => c.measured ?? c.sent

export const GLOBAL_MARKET = '*'
export const TIMING_MARKETS = [
  { value: GLOBAL_MARKET, label: 'Global default' },
  { value: 'IT', label: 'Italy' },
  { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' },
  { value: 'ES', label: 'Spain' },
  { value: 'UK', label: 'United Kingdom' },
]

/** Monday first; `dow` is the API's day (0 = Sunday). */
export const WEEKDAYS = [
  { dow: 1, short: 'Mon', long: 'Monday' },
  { dow: 2, short: 'Tue', long: 'Tuesday' },
  { dow: 3, short: 'Wed', long: 'Wednesday' },
  { dow: 4, short: 'Thu', long: 'Thursday' },
  { dow: 5, short: 'Fri', long: 'Friday' },
  { dow: 6, short: 'Sat', long: 'Saturday' },
  { dow: 0, short: 'Sun', long: 'Sunday' },
] as const

/** The API's last resort when no row matches (review-timing.service.ts `DEFAULT_DELAY_DAYS`). */
export const BUILT_IN_DEFAULT_DAYS = 12
export const DELAY_MIN = 1
export const DELAY_MAX = 60
/** Below this many requests in 90 days, the send-hour numbers say so. */
export const SMALL_SAMPLE = 200

export const hourWords = (h: number) => `${String(h).padStart(2, '0')}:00`
export const marketLabel = (code: string) => TIMING_MARKETS.find((m) => m.value === code)?.label ?? code

// ── First try by product type ───────────────────────────────────────────────────────────────────────────────────

export interface TypeRow { key: string; pattern: string; label: string; delayDays: number; isActive: boolean }

export function rowsFromDefaults(items: readonly TimingDefault[]): TypeRow[] {
  return [...items]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((i) => ({ key: `p:${i.pattern}`, pattern: i.pattern, label: i.label, delayDays: i.delayDays, isActive: i.isActive }))
}

/** Up (-1) or down (+1); the edges stay. */
export function moveRow(rows: readonly TypeRow[], index: number, dir: -1 | 1): TypeRow[] {
  const to = index + dir
  if (index < 0 || index >= rows.length || to < 0 || to >= rows.length) return [...rows]
  const next = [...rows]
  ;[next[index], next[to]] = [next[to], next[index]]
  return next
}

let newRows = 0
export function addRow(rows: readonly TypeRow[]): TypeRow[] {
  newRows += 1
  return [...rows, { key: `new:${newRows}`, pattern: '', label: '', delayDays: 14, isActive: true }]
}

export function removeRow(rows: readonly TypeRow[], key: string): TypeRow[] {
  return rows.filter((r) => r.key !== key)
}

export function updateRow(rows: readonly TypeRow[], key: string, patch: Partial<Omit<TypeRow, 'key'>>): TypeRow[] {
  return rows.map((r) => (r.key === key ? { ...r, ...patch } : r))
}

/** What PUT /review-timing-defaults saves: the list in its order (sortOrder 10, 20, …), words in lower case. */
export function defaultsBody(rows: readonly TypeRow[]): { items: Omit<TimingDefault, 'id'>[] } {
  return {
    items: rows.map((r, i) => {
      const pattern = r.pattern.trim().toLowerCase()
      return {
        pattern,
        label: r.label.trim() || pattern,
        delayDays: Math.max(DELAY_MIN, Math.min(DELAY_MAX, Math.round(r.delayDays) || DELAY_MIN)),
        sortOrder: (i + 1) * 10,
        isActive: r.isActive,
      }
    }),
  }
}

/** How many rows a save changes (added, removed, edited or moved). */
export function defaultsChanges(initial: readonly TypeRow[], rows: readonly TypeRow[]): number {
  const before = new Map(defaultsBody(initial).items.map((i) => [i.pattern, i]))
  const after = defaultsBody(rows).items
  let n = 0
  for (const item of after) {
    const was = before.get(item.pattern)
    if (!was || JSON.stringify(was) !== JSON.stringify(item)) n += 1
  }
  const kept = new Set(after.map((i) => i.pattern))
  for (const pattern of before.keys()) if (!kept.has(pattern)) n += 1
  return n
}

/** Why the table cannot be saved, or null. */
export function defaultsHeld(rows: readonly TypeRow[]): string | null {
  const seen = new Set<string>()
  for (let i = 0; i < rows.length; i += 1) {
    const p = rows[i].pattern.trim().toLowerCase()
    if (!p) return `Row ${i + 1} needs the word it matches.`
    if (seen.has(p)) return `“${p}” is in the table twice — keep one row.`
    seen.add(p)
  }
  return null
}

/** Which rules use the table (the ones without their own first day). */
export function usedByWords(rules: readonly Pick<RuleItem, 'name' | 'sendDelayDays' | 'isActive'>[]): string {
  const users = rules.filter((r) => r.sendDelayDays == null)
  if (users.length === 0) return 'No rule uses this table now: every rule sets its own first day.'
  const names = users.map((r) => `${r.name}${r.isActive ? '' : ' (off)'}`)
  const shown = names.slice(0, 3).join(', ')
  return `Used by ${users.length} ${users.length === 1 ? 'rule' : 'rules'} that ${users.length === 1 ? 'does' : 'do'} not set ${users.length === 1 ? 'its' : 'their'} own first day: ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ''}.`
}

// ── Send hour by weekday ────────────────────────────────────────────────────────────────────────────────────────

export interface WindowRow { dayOfWeek: number; hourLocal: number; dayRank: number; isActive: boolean }

/** A market's seven days, Monday first: its own rows, or the global default's (`own` false). */
export function windowsFor(all: readonly SendWindow[], market: string): { own: boolean; rows: WindowRow[] } {
  const ownRows = all.filter((w) => w.marketplace === market)
  const source = ownRows.length ? ownRows : all.filter((w) => w.marketplace === GLOBAL_MARKET)
  const rows = WEEKDAYS.map(({ dow }) => {
    const w = source.find((x) => x.dayOfWeek === dow)
    return w ? { dayOfWeek: dow, hourLocal: w.hourLocal, dayRank: w.dayRank, isActive: w.isActive } : { dayOfWeek: dow, hourLocal: 10, dayRank: 4, isActive: true }
  })
  return { own: ownRows.length > 0, rows }
}

export function windowsBody(market: string, rows: readonly WindowRow[]) {
  return { marketplace: market, windows: rows.map((r) => ({ dayOfWeek: r.dayOfWeek, hourLocal: r.hourLocal, dayRank: r.dayRank, isActive: r.isActive })) }
}

/** Days that differ from what was read. */
export function windowsChanges(initial: readonly WindowRow[], rows: readonly WindowRow[]): number {
  return rows.filter((r) => {
    const was = initial.find((i) => i.dayOfWeek === r.dayOfWeek)
    return !was || was.hourLocal !== r.hourLocal || was.dayRank !== r.dayRank || was.isActive !== r.isActive
  }).length
}

// ── The heatmap ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface HeatView {
  data: (number | null)[][]
  rowLabels: string[]
  colLabels: string[]
  colTitles: string[]
  marked: Set<string>
  cellWords: (row: number, col: number, value: number | null) => string
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`

/** Weekday × hour (Monday first), shaded by review rate; null where nothing was sent; the send hour outlined. */
export function heatView(report: ConversionReport | null, rows: readonly WindowRow[]): HeatView {
  const cells = new Map((report?.cells ?? []).map((c) => [`${c.dayOfWeek}:${c.hour}`, c]))
  const data = WEEKDAYS.map(({ dow }) => Array.from({ length: 24 }, (_, h) => {
    const c = cells.get(`${dow}:${h}`)
    return c && measuredOf(c) > 0 ? c.converted / measuredOf(c) : null
  }))
  const marked = new Set<string>()
  WEEKDAYS.forEach(({ dow }, r) => {
    const w = rows.find((x) => x.dayOfWeek === dow)
    if (w?.isActive) marked.add(`${r}:${w.hourLocal}`)
  })
  return {
    data,
    rowLabels: WEEKDAYS.map((d) => d.short),
    colLabels: Array.from({ length: 24 }, (_, h) => (h % 3 === 0 ? String(h).padStart(2, '0') : '')),
    colTitles: Array.from({ length: 24 }, (_, h) => hourWords(h)),
    marked,
    cellWords: (r, col) => {
      const day = WEEKDAYS[r]
      const c = day ? cells.get(`${day.dow}:${col}`) : undefined
      const head = `${day?.short ?? ''} ${hourWords(col)}`
      const body = !c || c.sent === 0
        ? 'none sent'
        : measuredOf(c) === 0
          ? `${c.sent} sent · review rate not measurable`
          : `${c.sent} sent · ${c.converted} ${c.converted === 1 ? 'review' : 'reviews'} after · ${pct(c.converted / measuredOf(c))}`
      return `${head} · ${body}${marked.has(`${r}:${col}`) ? ' · we send at this hour' : ''}`
    },
  }
}

const PARTS = [
  { label: 'Morning · 6–12', from: 6, to: 12 },
  { label: 'Afternoon · 12–18', from: 12, to: 18 },
  { label: 'Evening · 18–22', from: 18, to: 22 },
  { label: 'Night · 22–6', from: 22, to: 30 },
]

/**
 * Sent, reviews after and the rate per part of the day. Every request sent counts in "Sent"; the rate is over the ones a
 * review can follow — "Not measurable" when there are none, never "0.0%" (live audit A02).
 */
export function dayParts(report: ConversionReport | null): { label: string; sent: number; reviews: number; rate: string }[] {
  return PARTS.map((p) => {
    let sent = 0
    let measured = 0
    let reviews = 0
    for (const c of report?.cells ?? []) {
      const h = c.hour < 6 ? c.hour + 24 : c.hour
      if (h >= p.from && h < p.to) {
        sent += c.sent
        measured += measuredOf(c)
        reviews += c.converted
      }
    }
    return { label: p.label, sent, reviews, rate: measured > 0 ? pct(reviews / measured) : sent > 0 ? 'Not measurable' : 'not sent' }
  })
}

/** No request of the period can be followed by a review: the rate is not measurable (the API's words say why). */
export function rateNotMeasurableHere(report: ConversionReport | null): boolean {
  return !!report && report.totalSent > 0 && (report.totalMeasured ?? report.totalSent) === 0
}

/** The note under the numbers: how many requests, and how much the differences can be trusted. */
export function sampleWords(report: ConversionReport | null): string {
  const total = report?.totalSent ?? 0
  const head = `${total.toLocaleString('en-IE')} ${total === 1 ? 'request' : 'requests'} in ${report?.windowDays ?? 90} days.`
  if (rateNotMeasurableHere(report)) return `${head} ${report?.words ?? 'Not measurable: no review that could follow these requests is in Nexus yet.'}`
  const trust = (report?.totalMeasured ?? total) < SMALL_SAMPLE ? 'Too few to compare hours yet: the differences can be luck.' : 'Differences under 1 point can be luck.'
  const left = report?.words ? ` ${report.words}` : ''
  return `${head} ${trust}${left} Amazon does not say who wrote a review, so rates are estimates.`
}

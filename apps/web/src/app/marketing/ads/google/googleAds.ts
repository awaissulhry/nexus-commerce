/**
 * Google Ads step 1a, W2 — the pure half of /marketing/ads/google (and its campaign window).
 *
 * The rules this file exists to keep, each with a test (`googleAds.vitest.test.ts`):
 *  - `googlePageState` decides what the page may show. Only `ok` — and a failed read that still has an earlier good
 *    read, shown with that read's newest day — may show a number, a chart or a grid. Every other state is words and
 *    one way forward.
 *  - A day Nexus has not read is "not read": never a 0, never a point at 0 on a chart, never part of a total.
 *  - Money is in MINOR units of the account's own currency, printed with that currency's own decimals (EUR 2, JPY 0)
 *    and never converted.
 *  - Ratios come from the sums (cost ÷ clicks, value ÷ cost, …) and are "—" when the denominator is 0.
 *  - Google's own vocabulary: cost, conversions, conversion value, return on ad spend. Never the Amazon words for
 *    sales-side numbers, and nothing that claims Nexus changes Google Ads.
 */
import type { GridColumn } from '../campaigns/_grid/AdsDataGrid'
import type {
  GoogleAccount,
  GoogleCampaign,
  GoogleCampaignChanges,
  GoogleChange,
  GoogleDay,
  GoogleMetrics,
  GoogleOverview,
  GoogleSyncAnswer,
} from '@/lib/google-ads/contract'

export const NOT_READ = 'Not read'
const DASH = '—'

// ─── Dates ──────────────────────────────────────────────────────────────

/** A local calendar day (the date picker's midnights) as YYYY-MM-DD — never through UTC, which shifts it a day. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const asUtcDay = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`)

/** Month names written out here, not by the runtime's locale data (which says "Sept" in one version and "Sep" in another). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const dayWords = (d: Date, year: 'full' | 'short' | 'none') =>
  `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year === 'full' ? ` ${d.getUTCFullYear()}` : year === 'short' ? ` ${String(d.getUTCFullYear()).slice(2)}` : ''}`

/** "2026-10-13" → "13 Oct 2026". A calendar day, so no time zone moves it. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return DASH
  const d = asUtcDay(iso)
  return Number.isNaN(d.getTime()) ? iso : dayWords(d, 'full')
}

/** "13 Oct" (or "13 Oct 26" when the window crosses a year) — the chart's day labels. */
export function shortDay(iso: string, withYear = false): string {
  const d = asUtcDay(iso)
  return Number.isNaN(d.getTime()) ? iso : dayWords(d, withYear ? 'short' : 'none')
}

/** "14 Sep – 13 Oct 2026". */
export function formatWindow(from: string, to: string): string {
  if (from === to) return formatDay(from)
  const a = asUtcDay(from)
  const b = asUtcDay(to)
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return `${from} – ${to}`
  return `${dayWords(a, a.getUTCFullYear() === b.getUTCFullYear() ? 'none' : 'full')} – ${dayWords(b, 'full')}`
}

/** A moment (a read time) in the viewer's zone: "13 Oct 2026, 08:25". `timeZone` is for tests. */
export function formatMoment(iso: string | null | undefined, timeZone?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', ...(timeZone ? { timeZone } : {}) })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>
  return `${Number(parts.day)} ${MONTHS[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}:${parts.minute}`
}

/**
 * The days that have no numbers, as short ranges: ["2026-10-03","2026-10-04","2026-10-05","2026-10-09"] →
 * "3 Oct – 5 Oct 2026, 9 Oct 2026". More than `max` ranges end in "and N more".
 */
export function missingDaysText(days: string[], max = 4): string {
  const sorted = [...new Set(days)].sort()
  const ranges: Array<[string, string]> = []
  for (const day of sorted) {
    const last = ranges[ranges.length - 1]
    if (last && asUtcDay(day).getTime() - asUtcDay(last[1]).getTime() === 86_400_000) last[1] = day
    else ranges.push([day, day])
  }
  const shown = ranges.slice(0, max).map(([a, b]) => formatWindow(a, b))
  const more = ranges.length - shown.length
  return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
}

// ─── Money and numbers ──────────────────────────────────────────────────

/** The currency's own number of decimals (ISO 4217): EUR 2, JPY 0, KWD 3. Unknown → 2. */
export function currencyExponent(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** Minor units → a major-unit number in the same currency (no conversion). */
export function toMajor(minor: number, currency: string): number {
  return minor / 10 ** currencyExponent(currency)
}

/** A major-unit number (a chart value) back to minor units of the same currency. */
export function toMinor(major: number, currency: string): number {
  return Math.round(major * 10 ** currencyExponent(currency))
}

/** Minor units of `currency` → "€1,234.56" / "¥1,235". Missing (not read, or hidden for this role) → "—". */
export function formatMoney(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor == null || !Number.isFinite(minor) || !currency) return DASH
  const exp = currencyExponent(currency)
  try {
    return new Intl.NumberFormat('en-IE', { style: 'currency', currency, minimumFractionDigits: exp, maximumFractionDigits: exp }).format(minor / 10 ** exp)
  } catch {
    return `${(minor / 10 ** exp).toFixed(exp)} ${currency}`
  }
}

export function formatInt(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? DASH : Math.round(n).toLocaleString('en-IE')
}

/** Google counts part-conversions (data-driven attribution), so two decimals. */
export function formatConversions(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? DASH : n.toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** A fraction → "3.21%". */
export function formatRate(f: number | null | undefined): string {
  return f == null || !Number.isFinite(f) ? DASH : `${(f * 100).toFixed(2)}%`
}

/** Return on ad spend, value ÷ cost → "4.12". */
export function formatRoas(r: number | null | undefined): string {
  return r == null || !Number.isFinite(r) ? DASH : r.toFixed(2)
}

// ─── Sums and ratios ────────────────────────────────────────────────────

export interface Sums {
  impressions: number
  clicks: number
  /** Null when the money is not there (hidden for this role). */
  spendCents: number | null
  conversions: number
  conversionValueCents: number | null
}

export interface Ratios {
  ctr: number | null
  avgCpcCents: number | null
  roas: number | null
  costPerConversionCents: number | null
}

const money = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Add up what was read. `null` entries (not read) are left out; all null → null (nothing to add up). */
export function sumMetrics(list: Array<GoogleMetrics | null | undefined>): Sums | null {
  const read = list.filter((m): m is GoogleMetrics => m != null)
  if (read.length === 0) return null
  const spends = read.map((m) => money(m.spendCents))
  const values = read.map((m) => money(m.conversionValueCents))
  return {
    impressions: read.reduce((a, m) => a + (m.impressions ?? 0), 0),
    clicks: read.reduce((a, m) => a + (m.clicks ?? 0), 0),
    spendCents: spends.some((v) => v == null) ? null : (spends as number[]).reduce((a, v) => a + v, 0),
    conversions: read.reduce((a, m) => a + (m.conversions ?? 0), 0),
    conversionValueCents: values.some((v) => v == null) ? null : (values as number[]).reduce((a, v) => a + v, 0),
  }
}

/** The four ratios, from the sums. Null when the denominator is 0 or the money is missing. */
export function ratiosOf(s: Pick<Sums, 'impressions' | 'clicks' | 'spendCents' | 'conversions' | 'conversionValueCents'> | null): Ratios {
  if (!s) return { ctr: null, avgCpcCents: null, roas: null, costPerConversionCents: null }
  return {
    ctr: s.impressions > 0 ? s.clicks / s.impressions : null,
    avgCpcCents: s.spendCents != null && s.clicks > 0 ? s.spendCents / s.clicks : null,
    roas: s.spendCents != null && s.conversionValueCents != null && s.spendCents > 0 ? s.conversionValueCents / s.spendCents : null,
    costPerConversionCents: s.spendCents != null && s.conversions > 0 ? s.spendCents / s.conversions : null,
  }
}

/** One campaign's (or one total's) numbers, with its ratios worked out from its own sums. */
export function metricsView(m: GoogleMetrics | null | undefined): (Sums & Ratios) | null {
  const s = sumMetrics([m])
  return s ? { ...s, ...ratiosOf(s) } : null
}

// ─── The nine metric columns (every Google grid) ───────────────────────

/** A number a grid may sort on, or null (a blank sinks in both directions). */
export const sortable = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : v)

/** The nine metric columns, in Google Ads' own order: money first, then the traffic. */
export const METRIC_COLUMN_KEYS = ['cost', 'value', 'roas', 'conversions', 'cpa', 'clicks', 'impressions', 'ctr', 'cpc'] as const
export type MetricColumnKey = (typeof METRIC_COLUMN_KEYS)[number]

/**
 * The nine metric columns every Google grid uses (campaigns, ad groups, keywords, search terms, products, asset groups) —
 * one definition, so a label, a tip or a total is exactly the same on every grid. `get` reads a row's numbers; null =
 * Nexus read no day of it ("—", never 0, left out of the totals). Each ratio is worked out from the row's own sums, and
 * the totals row from the sums of the rows shown.
 */
export function metricColumns<T>(get: (row: T) => GoogleMetrics | null | undefined, currency: string | null): GridColumn<T>[] {
  const m = (r: T) => metricsView(get(r))
  const total = (vr: T[]) => {
    const s = sumMetrics(vr.map(get))
    return s ? { ...s, ...ratiosOf(s) } : null
  }
  const byKey: Record<MetricColumnKey, GridColumn<T>> = {
    cost: { key: 'cost', label: 'Cost', sortValue: (r) => sortable(m(r)?.spendCents), render: (r) => formatMoney(m(r)?.spendCents, currency), total: (vr) => formatMoney(total(vr)?.spendCents, currency) },
    value: { key: 'value', label: 'Conversion value', sortValue: (r) => sortable(m(r)?.conversionValueCents), render: (r) => formatMoney(m(r)?.conversionValueCents, currency), total: (vr) => formatMoney(total(vr)?.conversionValueCents, currency) },
    roas: { key: 'roas', label: 'Return on ad spend', tip: 'Conversion value ÷ cost.', sortValue: (r) => sortable(m(r)?.roas), render: (r) => formatRoas(m(r)?.roas), total: (vr) => formatRoas(total(vr)?.roas) },
    conversions: { key: 'conversions', label: 'Conversions', tip: 'As Google counts them; Google counts part-conversions.', sortValue: (r) => sortable(m(r)?.conversions), render: (r) => formatConversions(m(r)?.conversions), total: (vr) => formatConversions(total(vr)?.conversions) },
    cpa: { key: 'cpa', label: 'Cost per conversion', tip: 'Cost ÷ conversions.', sortValue: (r) => sortable(m(r)?.costPerConversionCents), render: (r) => formatMoney(m(r)?.costPerConversionCents, currency), total: (vr) => formatMoney(total(vr)?.costPerConversionCents, currency) },
    clicks: { key: 'clicks', label: 'Clicks', sortValue: (r) => sortable(m(r)?.clicks), render: (r) => formatInt(m(r)?.clicks), total: (vr) => formatInt(total(vr)?.clicks) },
    impressions: { key: 'impressions', label: 'Impressions', sortValue: (r) => sortable(m(r)?.impressions), render: (r) => formatInt(m(r)?.impressions), total: (vr) => formatInt(total(vr)?.impressions) },
    ctr: { key: 'ctr', label: 'Click rate', tip: 'Clicks ÷ impressions.', sortValue: (r) => sortable(m(r)?.ctr), render: (r) => formatRate(m(r)?.ctr), total: (vr) => formatRate(total(vr)?.ctr) },
    cpc: { key: 'cpc', label: 'Avg. cost per click', tip: 'Cost ÷ clicks.', sortValue: (r) => sortable(m(r)?.avgCpcCents), render: (r) => formatMoney(m(r)?.avgCpcCents, currency), total: (vr) => formatMoney(total(vr)?.avgCpcCents, currency) },
  }
  return METRIC_COLUMN_KEYS.map((key) => byKey[key])
}

// ─── The page's state ───────────────────────────────────────────────────

export type PageKind =
  | 'loading'
  | 'load_error'
  | 'not_connected'
  | 'sign_in_needed'
  | 'permission_missing'
  | 'choose_account'
  | 'first_read_pending'
  | 'read_failed'
  | 'ok'

export interface PageView {
  kind: PageKind
  /** The account the page is about, when there is one. */
  account: GoogleAccount | null
  /** Words for a state without numbers (null for `ok`). */
  title: string | null
  text: string | null
  /** One way forward, if any. */
  action: { label: string; href: string } | null
  /** May the page show numbers, the chart and the grid? */
  showData: boolean
  /** A banner above the numbers (a failed read that still shows the last good one). */
  banner: { tone: 'danger' | 'warning' | 'info'; title: string; text: string } | null
  /** May "Read now" be offered? (Only once an account is chosen and signed in.) */
  canReadNow: boolean
}

const SETTINGS_HREF = '/settings/channels/google'
const CONNECT_HREF = '/settings/channels?tab=connect'

function accountName(account: GoogleAccount): string {
  return account.ads?.name?.trim() || 'the chosen Google Ads account'
}

function readTimes(account: GoogleAccount, timeZone?: string): string {
  const last = formatMoment(account.read.lastReadAt, timeZone)
  const next = formatMoment(account.read.nextReadAt, timeZone)
  return `Last read: ${last ?? 'not yet'}. Next read: ${next ?? 'not planned'}.`
}

/**
 * What the page shows, from the overview (R1) and how loading it went. `account` picks among several Google sign-ins
 * (step 1 has one); it falls back to the overview's own account, then the first.
 */
export function googlePageState(input: {
  loading: boolean
  error: string | null
  overview: GoogleOverview | null
  /** For tests: the zone the read times are written in. */
  timeZone?: string
}): PageView {
  const base: PageView = { kind: 'loading', account: null, title: null, text: null, action: null, showData: false, banner: null, canReadNow: false }
  const { overview } = input
  if (!overview) {
    if (input.error) return { ...base, kind: 'load_error', title: 'Google Ads numbers could not be loaded', text: input.error }
    return base
  }
  const account = overview.account ?? overview.accounts[0] ?? null
  if (!account) {
    return {
      ...base,
      kind: 'not_connected',
      title: 'Google Ads is not connected',
      text: 'Connect Google in Settings › Channels, then choose the Google Ads account Nexus reads. Nexus only reads it; it changes nothing in Google Ads.',
      action: { label: 'Connect Google', href: CONNECT_HREF },
    }
  }
  const name = accountName(account)
  switch (account.state) {
    case 'sign_in_needed':
      return {
        ...base, kind: 'sign_in_needed', account,
        title: 'Google needs a new sign-in',
        text: `Nexus cannot read ${name} until someone signs in with Google again. Reconnect in Settings › Channels › Google.`,
        action: { label: 'Open Google settings', href: SETTINGS_HREF },
      }
    case 'permission_missing':
      return {
        ...base, kind: 'permission_missing', account,
        title: 'Google did not give Nexus access to Google Ads',
        text: "Reconnect in Settings › Channels › Google and tick every box on Google's screen.",
        action: { label: 'Open Google settings', href: SETTINGS_HREF },
      }
    case 'choose_account':
      return {
        ...base, kind: 'choose_account', account,
        title: 'Choose the Google Ads account Nexus reads',
        text: 'Google is connected, but no Google Ads account is chosen yet. Nexus reads nothing until one is.',
        action: { label: 'Choose accounts', href: SETTINGS_HREF },
      }
    case 'first_read_pending':
      return {
        ...base, kind: 'first_read_pending', account, canReadNow: true,
        title: `Nexus has not finished reading ${name} yet.`,
        text: `Campaigns appear when it does. ${readTimes(account, input.timeZone)}`,
      }
    case 'read_failed': {
      const error = account.read.lastError?.trim() || 'Google did not say why.'
      if (account.read.lastDataDay) {
        return {
          ...base, kind: 'read_failed', account, canReadNow: true, showData: true,
          banner: {
            tone: 'danger',
            title: 'The last read from Google failed',
            text: `${error} The numbers below are from the last good read; its newest day is ${formatDay(account.read.lastDataDay)}. ${readTimes(account, input.timeZone)}`,
          },
        }
      }
      return {
        ...base, kind: 'read_failed', account, canReadNow: true,
        title: `Nexus could not read ${name}`,
        text: `${error} ${readTimes(account, input.timeZone)}`,
        action: { label: 'Open Google settings', href: SETTINGS_HREF },
      }
    }
    case 'ok':
    default:
      return { ...base, kind: 'ok', account, showData: true, canReadNow: true }
  }
}

// ─── Above the numbers ─────────────────────────────────────────────────

/** "Read from Google … · newest day … · days in Europe/Rome · 14 Sep – 13 Oct 2026" (the read time is drawn by AsOf). */
export function dataLine(o: GoogleOverview, account: GoogleAccount | null): string[] {
  const parts: string[] = []
  const newest = account?.read.lastDataDay
  if (newest) parts.push(`newest day ${formatDay(newest)}`)
  if (o.timeZone) parts.push(`days in ${o.timeZone}`)
  parts.push(`showing ${formatWindow(o.window.from, o.window.to)}`)
  if (o.currency) parts.push(`amounts in ${o.currency}, as Google reports them`)
  return parts
}

/** The banner for days with no numbers in the window, or null when every day was read. */
export function coverageNote(o: Pick<GoogleOverview, 'coverage'>): string | null {
  const missing = o.coverage.missingDays
  if (!missing.length) return null
  return `No Google numbers for ${missingDaysText(missing)}; totals leave ${missing.length === 1 ? 'it' : 'them'} out.`
}

/** How many shown days Google may still change (late conversions). */
export function provisionalDays(days: Array<Pick<GoogleDay, 'date' | 'provisional' | 'read'>>, provisionalFrom: string | null): number {
  return days.filter((d) => d.read && (d.provisional || (provisionalFrom != null && d.date >= provisionalFrom))).length
}

export function provisionalNote(count: number): string | null {
  if (count <= 0) return null
  return count === 1
    ? 'The last day can still change: Google adds late conversions.'
    : `The last ${count} days can still change: Google adds late conversions.`
}

// ─── Tiles ─────────────────────────────────────────────────────────────

export interface Tile {
  key: 'cost' | 'value' | 'roas' | 'conversions' | 'clicks' | 'impressions'
  label: string
  value: string
  hint?: string
  /** Change against the previous window, only when Nexus read all of it and all of this one (`comparedWindow`). */
  delta?: { text: string; good: boolean }
}

/**
 * The window the tiles compare with, or null. Only when Nexus read every day of BOTH windows: totals that leave days
 * out, set against full ones, would make up a change. The server sends `previous` only then; this holds the page to it.
 */
export function comparedWindow(o: Pick<GoogleOverview, 'previous' | 'coverage'>): GoogleOverview['previous'] {
  if (!o.previous) return null
  return o.coverage.daysInWindow > 0 && o.coverage.daysRead === o.coverage.daysInWindow && o.coverage.missingDays.length === 0 ? o.previous : null
}

function change(current: number | null, previous: number | null, goodUp: boolean): Tile['delta'] {
  if (current == null || previous == null || previous === 0) return undefined
  const pct = (current - previous) / Math.abs(previous)
  if (!Number.isFinite(pct)) return undefined
  const up = pct >= 0
  return { text: `${up ? '▲' : '▼'} ${Math.abs(pct * 100).toFixed(1)}%`, good: up === goodUp }
}

/** The six tiles: cost, conversion value, return on ad spend, conversions, clicks, impressions. */
export function metricTiles(o: Pick<GoogleOverview, 'totals' | 'previous' | 'currency' | 'coverage'>): Tile[] {
  const now = metricsView(o.totals)
  const before = metricsView(comparedWindow(o))
  const ccy = o.currency
  const hidden = now != null && now.spendCents == null ? 'Hidden for your role' : undefined
  return [
    { key: 'cost', label: 'Cost', value: formatMoney(now?.spendCents, ccy), hint: hidden, delta: change(now?.spendCents ?? null, before?.spendCents ?? null, false) },
    { key: 'value', label: 'Conversion value', value: formatMoney(now?.conversionValueCents, ccy), hint: hidden ?? 'As Google counts it', delta: change(now?.conversionValueCents ?? null, before?.conversionValueCents ?? null, true) },
    { key: 'roas', label: 'Return on ad spend', value: formatRoas(now?.roas), hint: 'Conversion value ÷ cost', delta: change(now?.roas ?? null, before?.roas ?? null, true) },
    { key: 'conversions', label: 'Conversions', value: formatConversions(now?.conversions), hint: 'Google counts part-conversions', delta: change(now?.conversions ?? null, before?.conversions ?? null, true) },
    { key: 'clicks', label: 'Clicks', value: formatInt(now?.clicks), delta: change(now?.clicks ?? null, before?.clicks ?? null, true) },
    { key: 'impressions', label: 'Impressions', value: formatInt(now?.impressions), delta: change(now?.impressions ?? null, before?.impressions ?? null, true) },
  ]
}

// ─── Chart ─────────────────────────────────────────────────────────────

/**
 * Points for the daily chart, in MAJOR units of the account currency. A day not read carries only its label: the
 * line breaks there instead of dropping to 0.
 */
export function chartPoints(days: GoogleDay[], currency: string | null): Array<Record<string, number | string>> {
  const years = new Set(days.map((d) => d.date.slice(0, 4)))
  return days.map((d) => {
    const point: Record<string, number | string> = { day: shortDay(d.date, years.size > 1) }
    if (d.read && currency) {
      if (typeof d.spendCents === 'number') point.cost = toMajor(d.spendCents, currency)
      if (typeof d.conversionValueCents === 'number') point.value = toMajor(d.conversionValueCents, currency)
    }
    return point
  })
}

/** Whether the chart can draw any money line at all (money hidden for this role, or nothing read → no chart). */
export function chartHasMoney(days: GoogleDay[]): boolean {
  return days.some((d) => d.read && (typeof d.spendCents === 'number' || typeof d.conversionValueCents === 'number'))
}

// ─── Campaign words ────────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = {
  SEARCH: 'Search',
  SHOPPING: 'Shopping',
  PERFORMANCE_MAX: 'Performance Max',
  DISPLAY: 'Display',
  VIDEO: 'Video',
  DEMAND_GEN: 'Demand Gen',
}

/** Google's type in words; "—" when it is not known (UNKNOWN: a campaign whose settings Nexus has not read), never "Other". */
export function campaignTypeLabel(type: string | null | undefined): string {
  if (type?.toUpperCase() === 'UNKNOWN') return DASH
  return (type && TYPE_LABEL[type.toUpperCase()]) || 'Other'
}

export const TYPE_FILTER_OPTIONS = [...Object.values(TYPE_LABEL), 'Other'].map((label) => ({ value: label, label }))

const STATUS_LABEL: Record<string, string> = { ENABLED: 'Enabled', PAUSED: 'Paused', REMOVED: 'Removed' }

/** The status Google gave, or "Not read yet" when Nexus has the campaign's numbers but has not read its settings. */
export function campaignStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Not read yet'
  return STATUS_LABEL[status] ?? sentence(status)
}

/** Why a campaign's status (and its other settings) are not known yet, or null when they are. */
export function campaignStatusHint(status: string | null | undefined): string | null {
  return status ? null : 'Nexus has this campaign\'s numbers but has not read its settings from Google yet. The next daily read reads them.'
}

/**
 * When Nexus read this campaign's settings; "Not read yet" when it never did (never a time it did not read them) — a
 * campaign seen only in the numbers, whether new (no status) or removed before Nexus first read the account.
 */
export function settingsReadText(c: Pick<GoogleCampaign, 'status' | 'settingsReadAt'>, timeZone?: string): string {
  if (!c.status || !c.settingsReadAt) return 'Not read yet'
  return formatMoment(c.settingsReadAt, timeZone) ?? DASH
}

export const STATUS_FILTER_OPTIONS = Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label }))

/**
 * The campaign grid's columns after the campaign name, in Google Ads' own order: money first (what a campaign cost and
 * what it brought in), then the traffic, then the settings. At 1440 px Campaign … Conversions fit without a sideways
 * scroll.
 */
export const CAMPAIGN_COLUMN_ORDER = ['status', 'type', 'cost', 'value', 'roas', 'conversions', 'cpa', 'clicks', 'impressions', 'ctr', 'cpc', 'budget', 'bidding'] as const
export type CampaignColumnKey = (typeof CAMPAIGN_COLUMN_ORDER)[number]

const SERVING: Record<string, string | null> = {
  SERVING: 'Serving',
  ENDED: 'Ended',
  PENDING: 'Not started',
  SUSPENDED: 'Suspended',
  NONE: null,
  UNSPECIFIED: null,
  UNKNOWN: null,
}

const PRIMARY: Record<string, string | null> = {
  ELIGIBLE: 'Eligible',
  LIMITED: 'Limited',
  NOT_ELIGIBLE: 'Not eligible',
  LEARNING: 'Learning',
  MISCONFIGURED: 'Set-up incomplete',
  PENDING: 'Not started',
  ENDED: 'Ended',
  PAUSED: null,
  REMOVED: null,
  UNSPECIFIED: null,
  UNKNOWN: null,
}

/** "MAXIMIZE_CONVERSION_VALUE" → "Maximize conversion value". */
function sentence(code: string): string {
  const words = code.toLowerCase().split('_').filter(Boolean).join(' ')
  return words ? words[0]!.toUpperCase() + words.slice(1) : code
}

/** What Google says about serving, in words, or null when it adds nothing to the status. */
export function servingText(c: Pick<GoogleCampaign, 'status' | 'servingStatus' | 'primaryStatus'>): string | null {
  if (c.status === 'REMOVED') return null
  const primary = c.primaryStatus ? (c.primaryStatus in PRIMARY ? PRIMARY[c.primaryStatus] : sentence(c.primaryStatus)) : null
  if (primary) return primary
  if (c.status === 'PAUSED') return null
  const serving = c.servingStatus ? (c.servingStatus in SERVING ? SERVING[c.servingStatus] : sentence(c.servingStatus)) : null
  return serving ?? null
}

const BIDDING: Record<string, string> = {
  MAXIMIZE_CONVERSIONS: 'Maximize conversions',
  MAXIMIZE_CONVERSION_VALUE: 'Maximize conversion value',
  TARGET_CPA: 'Target cost per conversion',
  TARGET_ROAS: 'Target return on ad spend',
  TARGET_SPEND: 'Maximize clicks',
  MANUAL_CPC: 'Manual cost per click',
  ENHANCED_CPC: 'Enhanced cost per click',
  TARGET_IMPRESSION_SHARE: 'Target impression share',
  MANUAL_CPM: 'Manual cost per thousand impressions',
  MANUAL_CPV: 'Manual cost per view',
  TARGET_CPM: 'Target cost per thousand impressions',
  COMMISSION: 'Commission',
}

export function biddingLabel(strategy: string | null | undefined): string {
  if (!strategy) return DASH
  return BIDDING[strategy.toUpperCase()] ?? sentence(strategy)
}

/** "€50.00 a day" / "€50.00 a day (shared)" / "—". */
export function budgetText(c: Pick<GoogleCampaign, 'dailyBudgetCents' | 'budgetShared'>, currency: string | null): string {
  if (c.dailyBudgetCents == null) return DASH
  const amount = formatMoney(c.dailyBudgetCents, currency)
  if (amount === DASH) return DASH
  return `${amount} a day${c.budgetShared ? ' (shared)' : ''}`
}

// ─── The campaign window: days and changes ─────────────────────────────

export interface DayRow {
  id: string
  cells: [day: string, state: string, impressions: string, clicks: string, cost: string, conversions: string, value: string]
}

export const DAY_COLUMNS = ['Day', 'Read', 'Impressions', 'Clicks', 'Cost', 'Conversions', 'Conversion value'] as const

/** The day table, newest first. A day not read says so and shows no number. */
export function dayRows(days: GoogleDay[], currency: string | null): DayRow[] {
  return [...days].sort((a, b) => (a.date < b.date ? 1 : -1)).map((d) => ({
    id: d.date,
    cells: d.read
      ? [formatDay(d.date), d.provisional ? 'Can still change' : 'Read', formatInt(d.impressions), formatInt(d.clicks), formatMoney(d.spendCents, currency), formatConversions(d.conversions), formatMoney(d.conversionValueCents, currency)]
      : [formatDay(d.date), NOT_READ, DASH, DASH, DASH, DASH, DASH],
  }))
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi

/** Defence in depth: the contract carries no e-mail, and the page never shows one even if a summary did. */
export function withoutEmails(text: string): string {
  return text.replace(EMAIL, 'a person')
}

export interface ChangeRow {
  id: string
  cells: [when: string, who: string, what: string]
}

export const CHANGE_COLUMNS = ['When', 'Made in', 'What changed'] as const

/** Google's change history, newest first: when, where it was made (in words), and what changed. */
export function changeRows(items: GoogleChange[], timeZone?: string): ChangeRow[] {
  return [...items]
    .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1))
    .map((c, i) => ({
      id: `${c.changedAt}:${i}`,
      cells: [formatMoment(c.changedAt, timeZone) ?? c.changedAt, withoutEmails(c.sourceText), withoutEmails(c.summary)],
    }))
}

/**
 * The line under "Changes in the last 30 days": the span Nexus read, from where it starts to where reading stopped —
 * never "since", which would claim every change up to now. `timeZone` is for tests.
 */
export function changesNote(span: Pick<GoogleCampaignChanges, 'coveredFrom' | 'coveredThrough'>, count: number, timeZone?: string): string {
  const from = formatMoment(span.coveredFrom, timeZone)
  const through = formatMoment(span.coveredThrough, timeZone)
  if (!through) return 'Nexus has not read this campaign’s change history from Google yet.'
  if (!from) return `Nexus last read this campaign’s change history up to ${through}: it has read none of the last 30 days.`
  if (count === 0) return `No changes between ${from} and ${through}, the span Nexus has read. Google keeps 30 days; Nexus keeps what it has read.`
  return `Changes read from ${from} to ${through}, as Google records them. Google keeps 30 days; Nexus keeps what it has read.`
}

// ─── Read now ──────────────────────────────────────────────────────────

/** What "Read now" did, said plainly. */
export function readNowNote(result: GoogleSyncAnswer | { error: string }): { tone: 'success' | 'info' | 'danger'; text: string } {
  if ('error' in result) return { tone: 'danger', text: `Nexus could not ask for a new read: ${result.error}` }
  if (result.queued) return { tone: 'success', text: 'Nexus has asked Google for a new read. The numbers here change when it finishes; refresh the page in a few minutes.' }
  return { tone: 'info', text: result.reason ? `Nexus did not start a new read: ${result.reason}` : 'Nexus did not start a new read.' }
}

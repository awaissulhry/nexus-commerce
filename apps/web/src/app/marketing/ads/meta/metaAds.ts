/**
 * Meta ads step 2 — the pure half of /marketing/ads/meta (and its campaign window).
 *
 * The rules this file exists to keep, each with a test (`metaAds.vitest.test.ts`):
 *  - `metaPageState` decides what the page may show. Only `ok` — and a failed read that still has an earlier good read,
 *    shown with that read's newest day — may show a number, a chart or a grid. Every other state is words and one way
 *    forward (Settings › Channels › Meta).
 *  - A day Nexus has not read is "Not read": never a 0, never a point at 0 on a chart, never part of a total.
 *  - Money is in MINOR units of the ad account's own currency, printed with that currency's decimals, never converted;
 *    money a person may not see is "—" (hidden for the role), never 0.
 *  - Ratios come from the sums and are "—" when the denominator is 0.
 *  - Meta's own words: amount spent, purchases, purchase value, return on ad spend — Meta's count with each ad set's
 *    attribution, never Nexus's orders; nothing that claims Nexus changes Meta.
 * The day and money formatting is the Google page's own (googleAds.ts): one rule for both channels.
 */
import type { MetaAdsAdRow, MetaAdsAdSetRow, MetaAdsCampaignRow, MetaAdsDay, MetaAdsMetrics, MetaAdsOverview, MetaConnection, MetaSyncAnswer } from '@/lib/meta-ads/contract'
import { formatDay, formatInt, formatMoment, formatMoney, formatRate, formatRoas, formatWindow, missingDaysText, shortDay, toMajor } from '../google/googleAds'

export { formatDay, formatInt, formatMoment, formatMoney, formatRate, formatRoas, formatWindow }
export { toMinor, ymd } from '../google/googleAds'

const NOT_READ = 'Not read'
const DASH = '—'

// ─── Sums and ratios ────────────────────────────────────────────────────

export interface Sums {
  impressions: number
  clicks: number
  linkClicks: number
  /** Null when the money is not there (hidden for this role). */
  spendCents: number | null
  purchases: number
  purchaseValueCents: number | null
}

export interface Ratios {
  ctr: number | null
  cpcCents: number | null
  cpmCents: number | null
  roas: number | null
  costPerPurchaseCents: number | null
}

const money = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Add up what was read. `null` entries (not read) are left out; all null → null. */
export function sumMetrics(list: Array<MetaAdsMetrics | null | undefined>): Sums | null {
  const read = list.filter((m): m is MetaAdsMetrics => m != null)
  if (read.length === 0) return null
  const spends = read.map((m) => money(m.spendCents))
  const values = read.map((m) => money(m.purchaseValueCents))
  return {
    impressions: read.reduce((a, m) => a + (m.impressions ?? 0), 0),
    clicks: read.reduce((a, m) => a + (m.clicks ?? 0), 0),
    linkClicks: read.reduce((a, m) => a + (m.linkClicks ?? 0), 0),
    spendCents: spends.some((v) => v == null) ? null : (spends as number[]).reduce((a, v) => a + v, 0),
    purchases: read.reduce((a, m) => a + (m.purchases ?? 0), 0),
    purchaseValueCents: values.some((v) => v == null) ? null : (values as number[]).reduce((a, v) => a + v, 0),
  }
}

/** The ratios, from the sums. Null when the denominator is 0 or the money is missing. */
export function ratiosOf(s: Sums | null): Ratios {
  if (!s) return { ctr: null, cpcCents: null, cpmCents: null, roas: null, costPerPurchaseCents: null }
  return {
    ctr: s.impressions > 0 ? s.clicks / s.impressions : null,
    cpcCents: s.spendCents != null && s.clicks > 0 ? s.spendCents / s.clicks : null,
    cpmCents: s.spendCents != null && s.impressions > 0 ? (s.spendCents * 1000) / s.impressions : null,
    roas: s.spendCents != null && s.purchaseValueCents != null && s.spendCents > 0 ? s.purchaseValueCents / s.spendCents : null,
    costPerPurchaseCents: s.spendCents != null && s.purchases > 0 ? s.spendCents / s.purchases : null,
  }
}

/** One row's (or one total's) numbers, with its ratios worked out from its own sums. */
export function metricsView(m: MetaAdsMetrics | null | undefined): (Sums & Ratios) | null {
  const s = sumMetrics([m])
  return s ? { ...s, ...ratiosOf(s) } : null
}

/** Meta counts whole purchases. */
export function formatPurchases(n: number | null | undefined): string {
  return n == null || !Number.isFinite(n) ? DASH : Number.isInteger(n) ? n.toLocaleString('en-IE') : n.toLocaleString('en-IE', { maximumFractionDigits: 2 })
}

// ─── The page's state ───────────────────────────────────────────────────

export type PageKind =
  | 'loading' | 'load_error' | 'not_connected' | 'sign_in_needed' | 'token_problem' | 'permission_missing'
  | 'choose_account' | 'first_read_pending' | 'read_failed' | 'ok'

export interface PageView {
  kind: PageKind
  connection: MetaConnection | null
  title: string | null
  text: string | null
  action: { label: string; href: string } | null
  /** May the page show numbers, the chart and the grids? */
  showData: boolean
  /** A banner above the numbers (a failed read that still shows the last good one, a token about to expire). */
  banner: { tone: 'danger' | 'warning' | 'info'; title: string; text: string } | null
  /** May "Read now" be offered? (Only once an ad account is chosen and the token works.) */
  canReadNow: boolean
}

const SETTINGS_HREF = '/settings/channels/meta'
const DAY_MS = 86_400_000

function accountName(c: MetaConnection): string {
  return c.adAccount?.name?.trim() || 'the chosen Meta ad account'
}

function readTimes(c: MetaConnection, timeZone?: string): string {
  const last = formatMoment(c.read.lastReadAt, timeZone)
  const next = formatMoment(c.read.nextReadAt, timeZone)
  return `Last read: ${last ?? 'not yet'}. Next read: ${next ?? 'not planned'}.`
}

/** The token's expiry, in words for a banner, when it is 14 days away or less (Nexus could not renew it); else null. */
export function tokenExpiryBanner(c: MetaConnection, now: number = Date.now()): PageView['banner'] {
  const at = c.token.expiresAt ? Date.parse(c.token.expiresAt) : NaN
  if (!Number.isFinite(at) || at - now > 14 * DAY_MS) return null
  return {
    tone: 'warning',
    title: `The Meta token expires on ${formatDay(c.token.expiresAt)}`,
    text: 'Nexus could not renew it yet. Make a new system-user token in Meta Business settings and enter it in Settings › Channels › Meta before then, or Nexus stops reading Meta.',
  }
}

/** What the page shows, from the overview and how loading it went. */
export function metaPageState(input: { loading: boolean; error: string | null; overview: MetaAdsOverview | null; timeZone?: string; now?: number }): PageView {
  const base: PageView = { kind: 'loading', connection: null, title: null, text: null, action: null, showData: false, banner: null, canReadNow: false }
  const { overview } = input
  if (!overview) {
    if (input.error) return { ...base, kind: 'load_error', title: 'Meta numbers could not be loaded', text: input.error }
    return base
  }
  const c = overview.connection ?? overview.connections[0] ?? null
  const settings = { label: 'Open Meta settings', href: SETTINGS_HREF }
  if (!c) {
    return {
      ...base, kind: 'not_connected', title: 'Meta is not connected',
      text: 'Connect Meta in Settings › Channels with your Meta app id, app secret and a system-user token, then choose the ad account Nexus reads. Nexus only reads it; it changes nothing in Meta.',
      action: { label: 'Connect Meta', href: SETTINGS_HREF },
    }
  }
  const name = accountName(c)
  switch (c.state) {
    case 'sign_in_needed':
      return { ...base, kind: 'sign_in_needed', connection: c, title: 'Meta needs a new token', text: c.stateText, action: settings }
    case 'token_problem':
      return { ...base, kind: 'token_problem', connection: c, title: 'The Meta token does not work', text: c.stateText, action: settings }
    case 'permission_missing':
      return { ...base, kind: 'permission_missing', connection: c, title: 'The Meta token lacks a permission', text: c.stateText, action: settings }
    case 'choose_account':
      return {
        ...base, kind: 'choose_account', connection: c, title: 'Choose the Meta ad account Nexus reads',
        text: 'Meta is connected, but no ad account is chosen yet. Nexus reads nothing until one is.', action: { label: 'Choose the ad account', href: SETTINGS_HREF },
      }
    case 'first_read_pending':
      return { ...base, kind: 'first_read_pending', connection: c, canReadNow: true, title: `Nexus has not finished reading ${name} yet.`, text: `Campaigns appear when it does. ${readTimes(c, input.timeZone)}` }
    case 'read_failed': {
      const error = c.read.lastError?.trim() || 'Meta did not say why.'
      if (c.read.lastDataDay) {
        return {
          ...base, kind: 'read_failed', connection: c, canReadNow: true, showData: true,
          banner: { tone: 'danger', title: 'The last read from Meta failed', text: `${error} The numbers below are from the last good read; its newest day is ${formatDay(c.read.lastDataDay)}. ${readTimes(c, input.timeZone)}` },
        }
      }
      return { ...base, kind: 'read_failed', connection: c, canReadNow: true, title: `Nexus could not read ${name}`, text: `${error} ${readTimes(c, input.timeZone)}`, action: settings }
    }
    case 'ok':
    default:
      return { ...base, kind: 'ok', connection: c, showData: true, canReadNow: true, banner: tokenExpiryBanner(c, input.now) }
  }
}

// ─── Above the numbers ─────────────────────────────────────────────────

/** "newest day … · days in Europe/Rome · showing … · amounts in EUR" (the read time is drawn by AsOf). */
export function dataLine(o: MetaAdsOverview, c: MetaConnection | null): string[] {
  const parts: string[] = []
  if (c?.read.lastDataDay) parts.push(`newest day ${formatDay(c.read.lastDataDay)}`)
  if (o.timeZone) parts.push(`days in ${o.timeZone}`)
  parts.push(`showing ${formatWindow(o.window.from, o.window.to)}`)
  if (o.currency) parts.push(`amounts in ${o.currency}, as Meta reports them`)
  return parts
}

/** The ad account in words: its status, the spending limit and what was spent toward it. */
export function accountLine(o: Pick<MetaAdsOverview, 'account' | 'currency'>): string[] {
  const a = o.account
  if (!a) return []
  const parts: string[] = []
  parts.push(`Status: ${a.statusText ?? 'not read yet'}`)
  if (a.spendCapCents === null) parts.push('no account spending limit')
  else if (typeof a.spendCapCents === 'number') parts.push(`spending limit ${formatMoney(a.spendCapCents, o.currency)}, ${formatMoney(a.amountSpentCents, o.currency)} spent toward it`)
  return parts
}

export function coverageNote(o: Pick<MetaAdsOverview, 'coverage'>): string | null {
  const missing = o.coverage.missingDays
  if (!missing.length) return null
  return `No Meta numbers for ${missingDaysText(missing)}; totals leave ${missing.length === 1 ? 'it' : 'them'} out.`
}

export function provisionalDays(days: Array<Pick<MetaAdsDay, 'date' | 'provisional' | 'read'>>, provisionalFrom: string | null): number {
  return days.filter((d) => d.read && (d.provisional || (provisionalFrom != null && d.date >= provisionalFrom))).length
}

export function provisionalNote(count: number): string | null {
  if (count <= 0) return null
  return count === 1
    ? 'The last day can still change: Meta attributes purchases up to its attribution window later.'
    : `The last ${count} days can still change: Meta attributes purchases up to its attribution window later.`
}

// ─── Tiles ─────────────────────────────────────────────────────────────

export interface Tile {
  key: 'spend' | 'value' | 'roas' | 'purchases' | 'clicks' | 'impressions'
  label: string
  value: string
  hint?: string
  delta?: { text: string; good: boolean }
}

/** The window the tiles compare with, only when Nexus read every day of BOTH windows. */
export function comparedWindow(o: Pick<MetaAdsOverview, 'previous' | 'coverage'>): MetaAdsOverview['previous'] {
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

export function metricTiles(o: Pick<MetaAdsOverview, 'totals' | 'previous' | 'currency' | 'coverage'>): Tile[] {
  const now = metricsView(o.totals)
  const before = metricsView(comparedWindow(o))
  const ccy = o.currency
  const hidden = now != null && now.spendCents == null ? 'Hidden for your role' : undefined
  return [
    { key: 'spend', label: 'Amount spent', value: formatMoney(now?.spendCents, ccy), hint: hidden, delta: change(now?.spendCents ?? null, before?.spendCents ?? null, false) },
    { key: 'value', label: 'Purchase value', value: formatMoney(now?.purchaseValueCents, ccy), hint: hidden ?? 'As Meta attributes it', delta: change(now?.purchaseValueCents ?? null, before?.purchaseValueCents ?? null, true) },
    { key: 'roas', label: 'Return on ad spend', value: formatRoas(now?.roas), hint: 'Purchase value ÷ amount spent', delta: change(now?.roas ?? null, before?.roas ?? null, true) },
    { key: 'purchases', label: 'Purchases', value: formatPurchases(now?.purchases), hint: "Meta's count, with each ad set's attribution", delta: change(now?.purchases ?? null, before?.purchases ?? null, true) },
    { key: 'clicks', label: 'Clicks', value: formatInt(now?.clicks), delta: change(now?.clicks ?? null, before?.clicks ?? null, true) },
    { key: 'impressions', label: 'Impressions', value: formatInt(now?.impressions), delta: change(now?.impressions ?? null, before?.impressions ?? null, true) },
  ]
}

// ─── Chart ─────────────────────────────────────────────────────────────

/** Points in MAJOR units of the account currency; a day not read carries only its label (the line breaks there). */
export function chartPoints(days: MetaAdsDay[], currency: string | null): Array<Record<string, number | string>> {
  const years = new Set(days.map((d) => d.date.slice(0, 4)))
  return days.map((d) => {
    const point: Record<string, number | string> = { day: shortDay(d.date, years.size > 1) }
    if (d.read && currency) {
      if (typeof d.spendCents === 'number') point.spend = toMajor(d.spendCents, currency)
      if (typeof d.purchaseValueCents === 'number') point.value = toMajor(d.purchaseValueCents, currency)
    }
    return point
  })
}

export function chartHasMoney(days: MetaAdsDay[]): boolean {
  return days.some((d) => d.read && (typeof d.spendCents === 'number' || typeof d.purchaseValueCents === 'number'))
}

// ─── Words ─────────────────────────────────────────────────────────────

/** "OUTCOME_SALES" → "Outcome sales". */
function sentence(code: string): string {
  const words = code.toLowerCase().split('_').filter(Boolean).join(' ')
  return words ? words[0]!.toUpperCase() + words.slice(1) : code
}

const STATUS: Record<string, string> = { ACTIVE: 'Active', PAUSED: 'Paused', ARCHIVED: 'Archived', DELETED: 'Deleted' }

/** The status Meta gave, "Deleted" when Meta no longer returns it, "Not read yet" when Nexus never read the settings. */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return 'Not read yet'
  return STATUS[status.toUpperCase()] ?? sentence(status)
}

const EFFECTIVE: Record<string, string | null> = {
  ACTIVE: null, PAUSED: null, ARCHIVED: null, DELETED: null,
  CAMPAIGN_PAUSED: 'Campaign paused', ADSET_PAUSED: 'Ad set paused', IN_PROCESS: 'Being processed', WITH_ISSUES: 'With issues',
  PENDING_REVIEW: 'In review', DISAPPROVED: 'Rejected', PREAPPROVED: 'Pre-approved', PENDING_BILLING_INFO: 'Payment details needed',
}

/** What Meta's effective status adds to the status, in words, or null. */
export function effectiveText(status: string | null | undefined, effective: string | null | undefined): string | null {
  if (!effective || effective === status) return null
  return effective in EFFECTIVE ? EFFECTIVE[effective]! : sentence(effective)
}

const OBJECTIVE: Record<string, string> = {
  OUTCOME_SALES: 'Sales', OUTCOME_TRAFFIC: 'Traffic', OUTCOME_AWARENESS: 'Awareness', OUTCOME_ENGAGEMENT: 'Engagement',
  OUTCOME_LEADS: 'Leads', OUTCOME_APP_PROMOTION: 'App promotion',
}

export function objectiveLabel(objective: string | null | undefined): string {
  if (!objective) return DASH
  return OBJECTIVE[objective.toUpperCase()] ?? sentence(objective)
}

const BID: Record<string, string> = {
  LOWEST_COST_WITHOUT_CAP: 'Highest volume', LOWEST_COST_WITH_BID_CAP: 'Bid cap', COST_CAP: 'Cost per result goal',
  LOWEST_COST_WITH_MIN_ROAS: 'ROAS goal',
}

export function bidStrategyLabel(strategy: string | null | undefined): string {
  if (!strategy) return DASH
  return BID[strategy.toUpperCase()] ?? sentence(strategy)
}

/** "€50.00 a day" / "€500.00 in total" / "On the ad sets" (the budget sits on the ad sets) / "—" (hidden). */
export function budgetText(r: Pick<MetaAdsCampaignRow, 'dailyBudgetCents' | 'lifetimeBudgetCents'>, currency: string | null, onAdSetsText = 'On the ad sets'): string {
  const hidden = !('dailyBudgetCents' in r) && !('lifetimeBudgetCents' in r)
  if (hidden) return DASH
  if (typeof r.dailyBudgetCents === 'number') return `${formatMoney(r.dailyBudgetCents, currency)} a day`
  if (typeof r.lifetimeBudgetCents === 'number') return `${formatMoney(r.lifetimeBudgetCents, currency)} in total`
  return onAdSetsText
}

export const STATUS_FILTER_OPTIONS = Object.entries(STATUS).map(([value, label]) => ({ value, label }))

/** A creative's words for the ads grid: its title, else its body's start, else its name. */
export function creativeText(r: Pick<MetaAdsAdRow, 'creative'>): string {
  const c = r.creative
  const pick = c?.title?.trim() || c?.body?.trim() || c?.name?.trim() || ''
  return pick ? (pick.length > 90 ? `${pick.slice(0, 89)}…` : pick) : DASH
}

/** An ad set's optimisation goal in words. */
export function goalLabel(r: Pick<MetaAdsAdSetRow, 'optimizationGoal'>): string {
  return r.optimizationGoal ? sentence(r.optimizationGoal) : DASH
}

// ─── The campaign window: days ─────────────────────────────────────────

export interface DayRow {
  id: string
  cells: [day: string, state: string, impressions: string, clicks: string, spend: string, purchases: string, value: string]
}

export const DAY_COLUMNS = ['Day', 'Read', 'Impressions', 'Clicks', 'Amount spent', 'Purchases', 'Purchase value'] as const

/** The day table, newest first. A day not read says so and shows no number. */
export function dayRows(days: MetaAdsDay[], currency: string | null): DayRow[] {
  return [...days].sort((a, b) => (a.date < b.date ? 1 : -1)).map((d) => ({
    id: d.date,
    cells: d.read
      ? [formatDay(d.date), d.provisional ? 'Can still change' : 'Read', formatInt(d.impressions), formatInt(d.clicks), formatMoney(d.spendCents, currency), formatPurchases(d.purchases), formatMoney(d.purchaseValueCents, currency)]
      : [formatDay(d.date), NOT_READ, DASH, DASH, DASH, DASH, DASH],
  }))
}

// ─── Read now ──────────────────────────────────────────────────────────

export function readNowNote(result: MetaSyncAnswer | { error: string }): { tone: 'success' | 'info' | 'danger'; text: string } {
  if ('error' in result) return { tone: 'danger', text: `Nexus could not ask for a new read: ${result.error}` }
  if (result.queued) return { tone: 'success', text: 'Nexus has asked Meta for a new read. The numbers here change when it finishes; refresh the page in a few minutes.' }
  return { tone: 'info', text: result.reason ? `Nexus did not start a new read: ${result.reason}` : 'Nexus did not start a new read.' }
}

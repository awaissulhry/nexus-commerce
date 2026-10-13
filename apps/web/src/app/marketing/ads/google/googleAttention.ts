/**
 * Google Ads step 1b — the pure half of the page's new parts: the tabs (`?view=`), "Needs a look" (R14 alerts), "Google
 * acts on its own" (R12), Google's recommendations (R13) and disapprovals (R15). JSX-free, so the node-only suite tests
 * every sentence (`googleAttention.vitest.test.ts`). The search terms and their brand split are the grain grid's
 * (`GoogleSearchTermsGrid`, `googleGrains.ts`).
 *
 * The rules this file keeps:
 *  - Not read is "Not read yet", never "Off", never 0. A flag Google does not have for a campaign type is "—".
 *  - An alert's words are the server's `title` and `body` (they carry no amount); the page adds at most one line from
 *    `numbers`, money through `formatMoney` — and none when the role may not see ad spend (`numbers` is then absent).
 *  - Where "Open" goes is decided here, from the alert's kind and campaign (PLAN-1B M4), not from the server's `href`.
 *  - Google's estimates are never added up: two recommendations can promise the same conversions.
 *  - Words that name Google's own states ("Paused" among them) live here, not in the .tsx files: the write-control guard
 *    reads those for the verbs a write control would carry.
 */
import type { Tone } from '@/design-system/primitives'
import type {
  GoogleActsOnItsOwn,
  GoogleAdIssue,
  GoogleAlert,
  GoogleAlertKind,
  GoogleAlerts,
  GoogleAutoApply,
  GoogleCampaignAutomation,
  GoogleImpact,
  GoogleOutsideChange,
  GoogleProductIssue,
  GoogleRead,
} from '@/lib/google-ads/contract'
import { formatConversions, formatDay, formatInt, formatMoment, formatMoney, formatRate, formatRoas, withoutEmails } from './googleAds'
// The words the campaign window uses for the same things (flags, who made a change, a read that did not finish): one
// definition, so the page and the window say exactly the same.
import { flagWord, flagsOnCount, lastTryText, whoText, type ActsFlagKey, type Word } from './googleGrains'

const DASH = '—'
export const NOT_READ_YET = 'Not read yet'

/** "AREA_OF_INTEREST_ONLY" → "Area of interest only"; words that already read as words stay as they are. */
export function codeWords(code: string | null | undefined): string {
  if (!code) return DASH
  if (!/^[A-Z0-9_]+$/.test(code)) return code
  const words = code.toLowerCase().split('_').filter(Boolean).join(' ')
  return words ? words[0]!.toUpperCase() + words.slice(1) : code
}

const plural = (n: number, one: string, many = `${one}s`) => `${formatInt(n)} ${n === 1 ? one : many}`

// ─── The tabs (?view=) ──────────────────────────────────────────────────

export const GOOGLE_VIEWS = ['campaigns', 'search-terms', 'products', 'disapprovals', 'on-its-own', 'recommendations'] as const
export type GoogleView = (typeof GOOGLE_VIEWS)[number]

export const VIEW_LABEL: Record<GoogleView, string> = {
  campaigns: 'Campaigns',
  'search-terms': 'Search terms',
  products: 'Products',
  disapprovals: 'Disapprovals',
  'on-its-own': 'Google acts on its own',
  recommendations: 'Google’s recommendations',
}

/** The tab an address names; anything else (none, an old or a mistyped value) is Campaigns. */
export function viewOf(raw: string | null | undefined): GoogleView {
  return (GOOGLE_VIEWS as readonly string[]).includes(raw ?? '') ? (raw as GoogleView) : 'campaigns'
}

/** The `?view=` value of a tab; Campaigns writes none (the page's own address). */
export function viewParam(view: GoogleView): string | null {
  return view === 'campaigns' ? null : view
}

/** The page's query with this tab chosen; every other parameter is kept, in its order. Without '?'. */
export function viewSearch(search: string | URLSearchParams, view: GoogleView): string {
  const out = new URLSearchParams(search)
  const v = viewParam(view)
  if (v) out.set('view', v)
  else out.delete('view')
  return out.toString()
}

/** The tab bar: a count only when it is known (null = unknown, never 0). */
export function viewTabs(counts: Partial<Record<GoogleView, number | null>> = {}): Array<{ id: GoogleView; label: string; count: number | null }> {
  return GOOGLE_VIEWS.map((id) => ({ id, label: VIEW_LABEL[id], count: counts[id] ?? null }))
}

// ─── Read states ────────────────────────────────────────────────────────

export interface ReadNote {
  tone: 'info' | 'warning' | 'danger'
  title: string
  text: string
}

/**
 * What to say about one part Nexus reads from Google (`what` = "Google's recommendations"), or null when its last read
 * went well. Never read → "Not read yet" and when the next daily read is; a failed or put-off read says why (the
 * campaign window's words, `lastTryText`), and, when an earlier read is on screen, which one.
 */
export function readNote(read: GoogleRead | null | undefined, what: string, nextReadAt: string | null, timeZone?: string): ReadNote | null {
  const why = lastTryText(read)
  const tone: ReadNote['tone'] = read?.lastStatus === 'FAILED' ? 'warning' : 'info'
  if (!read?.readAt) {
    const next = formatMoment(nextReadAt, timeZone)
    return { tone, title: NOT_READ_YET, text: `Nexus has not read ${what} from Google yet. It reads them in the next daily read${next ? ` (next: ${next})` : ''}.${why ? ` ${why}` : ''}` }
  }
  if (!why) return null
  return { tone, title: `The last read of ${what} did not finish`, text: `${why} This shows the read of ${formatMoment(read.readAt, timeZone) ?? DASH}.` }
}

// ─── Needs a look (R14) ─────────────────────────────────────────────────

/** The checks, in words, for "Not checked yet: …". */
export const ALERT_KIND_TEXT: Record<GoogleAlertKind, string> = {
  spend_pace: 'Cost against the daily budget',
  month_pace: 'Cost against the month',
  zero_conversions: 'Cost without conversions',
  tracking_stopped: 'Conversion tracking',
  ads_disapproved: 'Disapproved ads',
  products_not_eligible: 'Products Google will not show',
  ads_limited: 'Limited ads',
  auto_apply_on: 'Auto-apply',
  changed_by_google: 'Changes made by Google',
  settings_changed: 'Changed settings',
  moved_to_ai_max: 'Moved to AI Max',
}

export const SEVERITY_TEXT: Record<GoogleAlert['severity'], string> = { danger: 'Act now', warn: 'Check', info: 'Note' }

export function alertTone(severity: GoogleAlert['severity']): Tone {
  return severity === 'danger' ? 'danger' : severity === 'warn' ? 'warning' : 'info'
}

const SEVERITY_RANK: Record<GoogleAlert['severity'], number> = { danger: 0, warn: 1, info: 2 }

/** Most urgent first; within a severity, the newest first. */
export function sortAlerts(items: GoogleAlert[]): GoogleAlert[] {
  return [...items].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.since ?? '').localeCompare(a.since ?? ''))
}

export type AlertTarget =
  | { kind: 'campaign'; campaignId: string; tab: 'overview' }
  | { kind: 'view'; view: GoogleView }

/**
 * Where an alert's "Open" goes (PLAN-1B M4). Pace and conversion alerts open their campaign (Overview), or the campaigns
 * when the alert is about the whole account; policy alerts open Disapprovals; what Google did by itself opens "Google
 * acts on its own".
 */
export function alertTarget(a: Pick<GoogleAlert, 'kind' | 'campaignId'>): AlertTarget {
  switch (a.kind) {
    case 'spend_pace':
    case 'month_pace':
    case 'zero_conversions':
    case 'tracking_stopped':
      return a.campaignId ? { kind: 'campaign', campaignId: a.campaignId, tab: 'overview' } : { kind: 'view', view: 'campaigns' }
    case 'ads_disapproved':
    case 'products_not_eligible':
    case 'ads_limited':
      return { kind: 'view', view: 'disapprovals' }
    case 'auto_apply_on':
    case 'changed_by_google':
    case 'settings_changed':
    case 'moved_to_ai_max':
    default:
      return { kind: 'view', view: 'on-its-own' }
  }
}

/** The words for a number the server sends with an alert. Money keys end in `Cents`. */
const NUMBER_LABEL: Record<string, string> = {
  spendCents: 'Cost',
  dailyBudgetCents: 'Daily budget',
  monthBudgetCents: 'Budget for the month',
  monthSpendCents: 'Cost this month',
  limitCents: 'Limit',
  conversionValueCents: 'Conversion value',
  costPerConversionCents: 'Cost per conversion',
  clicks: 'Clicks',
  impressions: 'Impressions',
  conversions: 'Conversions',
  priorConversions: 'Conversions before',
  ratio: 'Times the budget',
  roas: 'Return on ad spend',
  ctr: 'Click rate',
  days: 'Days',
}

/** "monthToDateSpendCents" → "Month to date spend". */
function keyWords(key: string): string {
  const words = key.replace(/Cents$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return words ? words[0]!.toUpperCase() + words.slice(1) : key
}

function numberText(key: string, v: number, currency: string | null): string {
  if (key.endsWith('Cents')) return formatMoney(v, currency)
  if (key === 'conversions' || key === 'priorConversions') return formatConversions(v)
  if (key === 'roas') return formatRoas(v)
  if (key === 'ctr') return formatRate(v)
  if (key === 'ratio') return `${v.toFixed(1)}×`
  return Number.isInteger(v) ? formatInt(v) : v.toLocaleString('en-IE', { maximumFractionDigits: 2 })
}

/**
 * The one line of numbers under an alert: "Cost €95.00 · Daily budget €50.00". Null when the server sent none — which
 * is also what it does for a role that may not see ad spend (the numbers are stripped whole). A number not read (null)
 * is left out, never shown as 0; money without a currency is left out too.
 */
export function alertNumbersLine(numbers: Record<string, number | null> | null | undefined, currency: string | null): string | null {
  if (!numbers) return null
  const parts: string[] = []
  for (const [key, v] of Object.entries(numbers)) {
    if (v == null || !Number.isFinite(v)) continue
    if (key.endsWith('Cents') && !currency) continue
    parts.push(`${NUMBER_LABEL[key] ?? keyWords(key)} ${numberText(key, v, currency)}`)
  }
  return parts.length ? parts.join(' · ') : null
}

/** "Since 12 Oct 2026" for an alert, or null. */
export function alertSinceText(since: string | null | undefined): string | null {
  if (!since) return null
  return `Since ${formatDay(since)}`
}

export interface AlertsSummary {
  /** "No alerts" only when every check ran; otherwise null. */
  allClear: string | null
  /** The checks that did not run, with the server's reason. */
  notChecked: string[]
  /** "Checked 13 Oct 2026, 08:31, over what Nexus has read." */
  checked: string
}

/** The words around the alerts: all clear only when every check ran, and which did not. */
export function alertsSummary(a: GoogleAlerts, timeZone?: string): AlertsSummary {
  const at = formatMoment(a.checkedAt, timeZone)
  const seen = new Set<GoogleAlertKind>()
  const notChecked: string[] = []
  for (const n of a.notChecked) {
    if (seen.has(n.kind)) continue
    seen.add(n.kind)
    notChecked.push(`${ALERT_KIND_TEXT[n.kind] ?? codeWords(n.kind)}: ${n.reason.trim() || 'not read yet.'}`)
  }
  const allClear = a.items.length === 0 && notChecked.length === 0
    ? `No alerts. Nexus ran every check over what it has read${at ? `, at ${at}` : ''}.`
    : null
  return { allClear, notChecked, checked: at ? `Checked ${at}, over what Nexus has read.` : 'Checked over what Nexus has read.' }
}

/** How many alerts the card shows before "Show all". */
export const ALERTS_SHOWN = 4

// ─── Google acts on its own (R12) ───────────────────────────────────────

export const ACTS_INTRO = 'Google can change your campaigns without asking. This shows where it can, and what it changed.'
export const AUTO_APPLY_TEXT = 'Google applies these kinds of its recommendations by itself. You switch them off in Google Ads, under Recommendations › Auto-apply.'
export const AUTO_APPLY_NONE = 'Auto-apply is off for every kind.'
export const WIDENING_TEXT = 'When one of these is on, Google may show your ads for searches, pages or text you did not choose.'
export const CHANGES_OUTSIDE_TEXT = 'Nexus makes no changes in Google Ads yet, so every change here was made outside Nexus: by Google itself or by people in Google Ads.'
export const EDITOR_NOTE = 'Changes made in Google Ads Editor do not show here: Google’s change history does not report them.'

/**
 * One widening setting of one campaign, in the campaign window's words (On / Off / "—" / Not read yet). A campaign whose
 * settings Nexus has not read is "Not read yet" in every column, whatever the row carries.
 */
export function wideningCell(c: GoogleCampaignAutomation, key: ActsFlagKey): Word {
  return flagWord(c.flagsReadAt ? c[key] : null)
}

/** How many widening settings are on for a campaign; null when its settings are not read. */
export function wideningOn(c: GoogleCampaignAutomation): number | null {
  return c.flagsReadAt ? flagsOnCount(c) : null
}

/** The campaigns the widening grid lists: every one Google still has (a removed campaign shows nothing). */
export function wideningCampaigns(list: GoogleCampaignAutomation[]): GoogleCampaignAutomation[] {
  return list.filter((c) => c.status !== 'REMOVED')
}

/** "On in 3" for the totals row of a widening column; "—" when no campaign shown has it read. */
export function wideningTotal(rows: GoogleCampaignAutomation[], key: ActsFlagKey): string {
  const read = rows.filter((c) => c.flagsReadAt && c[key] != null)
  if (!read.length) return DASH
  return `On in ${formatInt(read.filter((c) => c[key] === 'on').length)}`
}

export interface AutoApplyRow {
  id: string
  kind: string
  on: boolean
  state: string
  since: string | null
  changedAt: string | null
}

/** Auto-apply, one row per kind: the ones that are on first. */
export function autoApplyRows(a: GoogleActsOnItsOwn['autoApply']): AutoApplyRow[] {
  if (!a) return []
  const row = (x: GoogleAutoApply, on: boolean): AutoApplyRow => ({ id: `${on ? 'on' : 'off'}:${x.type}`, kind: x.typeText || codeWords(x.type), on, state: on ? 'On' : 'Paused', since: x.since, changedAt: x.changedAt })
  return [...a.enabled.map((x) => row(x, true)), ...a.paused.map((x) => row(x, false))]
}

/** The line over the changes outside Nexus: the span read, and when the list shows only the newest ones. */
export function outsideChangesNote(o: GoogleActsOnItsOwn['outsideChanges'], timeZone?: string): string {
  const from = formatMoment(o.coveredFrom, timeZone)
  const through = formatMoment(o.coveredThrough, timeZone)
  if (!through) return 'Nexus has not read the change history from Google yet.'
  if (!from) return `Nexus last read the change history up to ${through}: it has read none of the last 30 days.`
  const total = o.bySource.reduce((n, s) => n + s.count, 0)
  const span = `Changes read from ${from} to ${through}, as Google records them. Google keeps 30 days.`
  return total > o.items.length ? `${span} The list shows the newest ${formatInt(o.items.length)} of ${formatInt(total)}.` : span
}

export interface ChangeRowView {
  id: string
  when: string
  at: string
  campaign: string
  who: string
  madeIn: string
  what: string
  watched: boolean
}

/** The changes outside Nexus, newest first; never an e-mail. */
export function outsideChangeRows(items: GoogleOutsideChange[], timeZone?: string): ChangeRowView[] {
  return [...items]
    .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1))
    .map((c, i) => ({
      id: `${c.changedAt}:${i}`,
      when: formatMoment(c.changedAt, timeZone) ?? c.changedAt,
      at: c.changedAt,
      campaign: c.campaignName?.trim() || (c.campaignId || c.externalCampaignId ? 'Unnamed campaign' : 'The account'),
      who: whoText(c.who),
      madeIn: withoutEmails(c.sourceText),
      what: withoutEmails(c.summary),
      watched: c.watched,
    }))
}

export interface ActsSummary {
  autoApply: { text: string; tone: Tone }
  widening: { text: string; tone: Tone }
  changes: { text: string; tone: Tone; count: number | null }
}

/** The card's three lines: auto-apply, widening settings and changes by Google — each "Not read yet" until read. */
export function actsSummary(a: GoogleActsOnItsOwn): ActsSummary {
  const n = a.autoApply?.enabled.length ?? 0
  const autoApply = !a.autoApply
    ? { text: NOT_READ_YET, tone: 'neutral' as Tone }
    : n > 0
      ? { text: `On for ${plural(n, 'kind')} of recommendation`, tone: 'warning' as Tone }
      : { text: 'Off for every kind', tone: 'success' as Tone }

  const listed = wideningCampaigns(a.campaigns)
  const read = listed.filter((c) => c.flagsReadAt)
  const on = read.filter((c) => (wideningOn(c) ?? 0) > 0).length
  const unread = listed.length - read.length
  const widening = !read.length
    ? { text: listed.length ? NOT_READ_YET : 'No campaigns', tone: 'neutral' as Tone }
    : { text: `On in ${formatInt(on)} of ${plural(read.length, 'campaign')}${unread ? `; ${formatInt(unread)} not read yet` : ''}`, tone: (on > 0 ? 'warning' : 'success') as Tone }

  const o = a.outsideChanges
  let changes: ActsSummary['changes']
  if (!o.coveredThrough) changes = { text: NOT_READ_YET, tone: 'neutral', count: null }
  else {
    const google = o.bySource.filter((s) => s.source === 'google_automatic').reduce((t, s) => t + s.count, 0)
    const total = o.bySource.reduce((t, s) => t + s.count, 0)
    changes = { text: `${formatInt(google)} by Google itself, of ${plural(total, 'change')} outside Nexus`, tone: google > 0 ? 'warning' : 'neutral', count: google }
  }
  return { autoApply, widening, changes }
}

// ─── Google's recommendations (R13) ─────────────────────────────────────

/** The line over the recommendations: when they were read, and that Nexus applies none. */
export function recommendationsNote(read: GoogleRead, timeZone?: string): string {
  const at = formatMoment(read.readAt, timeZone)
  return `Google’s suggestions${at ? `, read ${at}` : ''}. Nexus applies none of them; to apply or dismiss one, use Google Ads. They can be out of date within a day.`
}

export const RECOMMENDATIONS_NO_TOTAL = 'Google’s estimates are not added up: two suggestions can promise the same extra conversions.'

/** What Google expects a recommendation to add (potential − base), or null when Google gave no estimate for it. */
export function impactExtra(impact: { base: GoogleImpact; potential: GoogleImpact } | null | undefined, key: keyof GoogleImpact): number | null {
  const base = impact?.base?.[key]
  const potential = impact?.potential?.[key]
  if (base == null || potential == null || !Number.isFinite(base) || !Number.isFinite(potential)) return null
  return potential - base
}

/** "+1.50" / "−2.00" / "—": a signed estimate, for numbers that are not money. */
export function signedText(v: number | null, format: (n: number) => string): string {
  if (v == null) return DASH
  if (v === 0) return format(0)
  return `${v > 0 ? '+' : '−'}${format(Math.abs(v))}`
}

export function autoAppliedText(autoApplied: boolean): { text: string; tone: Tone } {
  return autoApplied ? { text: 'Yes, by auto-apply', tone: 'warning' } : { text: 'No', tone: 'neutral' }
}

// ─── Disapprovals (R15) ─────────────────────────────────────────────────

const AD_STATUS: Record<GoogleAdIssue['status'], { text: string; tone: Tone }> = {
  DISAPPROVED: { text: 'Disapproved', tone: 'danger' },
  APPROVED_LIMITED: { text: 'Limited', tone: 'warning' },
  AREA_OF_INTEREST_ONLY: { text: 'Area of interest only', tone: 'warning' },
}

export function adIssueStatus(status: GoogleAdIssue['status']): { text: string; tone: Tone } {
  return AD_STATUS[status] ?? { text: codeWords(status), tone: 'warning' }
}

const PRODUCT_STATUS: Record<GoogleProductIssue['status'] | 'no_issue', { text: string; tone: Tone }> = {
  not_eligible: { text: 'Not eligible', tone: 'danger' },
  limited: { text: 'Limited', tone: 'warning' },
  no_issue: { text: 'No issue', tone: 'success' },
}

export function productIssueStatus(status: GoogleProductIssue['status'] | 'no_issue' | null): { text: string; tone: Tone } {
  if (!status) return { text: NOT_READ_YET, tone: 'neutral' }
  return PRODUCT_STATUS[status] ?? { text: codeWords(status), tone: 'warning' }
}

/** Google's policy reasons in words, joined. */
export function reasonsText(reasons: string[]): string {
  return reasons.length ? reasons.map(codeWords).join(' · ') : DASH
}

export const DISAPPROVALS_INTRO = 'Ads and products Google will not show, or shows only in part. Fix them in Google Ads or Merchant Center; Nexus changes nothing there.'
export const DISAPPROVALS_TRUNCATED = 'Google reported more than this page lists. Each list shows the first 500.'

/**
 * Reviews › Insights › Alerts — the page's words and rules (build spec §3.4 + ruling 7, the Alerts board): the status
 * filter in the address, the tiles, an alert's lines and its actions, the bulk bar (Acknowledge N · Resolve N ·
 * Suggest fixes, at most 5) that counts what it changes and names why it holds, and the toast after a change in the
 * server's count. Mirrors the API's own rules (`review-alerts.service.ts` `decisionHeld`, `bulkAlerts`), so a button
 * says before the press what the server would answer. Pure, tested in alertsModel.vitest.test.ts.
 */
import { inboxHref } from '../../_lib/reviewsLinks'
import type { InsightsScope } from '../_shared/insightsScope'

// ── The API's answer ────────────────────────────────────────────────

export const ALERT_STATUSES = ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'] as const
export type AlertStatus = (typeof ALERT_STATUSES)[number]

export interface AlertItem {
  id: string
  status: AlertStatus
  theme: { key: string; label: string }
  product: { id: string; sku: string; name: string } | null
  market: string
  channels: string[]
  where: string
  from: number | null
  to: number | null
  multiplier: number | null
  basis: string
  count: number
  phrases: string[]
  detectedAt: string
  newToday: boolean
  acknowledged: { by: string; at: string | null } | null
  resolved: { by: string | null; at: string } | null
  fixes: { open: number; sent: number; applied: number; dismissed: number }
}

export interface AlertsAnswer {
  items: AlertItem[]
  count: number
  counts: { open: number; acknowledged: number; resolved: number }
  timeToResolve: { days: number | null; change: number | null }
  check: { lastRunAt: string | null; lastStatus: string | null; nextRunAt: string | null; schedule: string }
}

// ── The status filter (`?status=`) ──────────────────────────────────

/** Open by default; `ALL` shows every alert (open, acknowledged, resolved in the last 30 days). */
export type AlertFilter = AlertStatus | 'ALL'

export function parseAlertFilter(raw: string | null | undefined): AlertFilter {
  const value = (raw ?? '').trim().toUpperCase()
  if (value === 'ALL') return 'ALL'
  return (ALERT_STATUSES as readonly string[]).includes(value) ? (value as AlertStatus) : 'OPEN'
}

/** The address value: Open is the default and leaves it out. */
export function alertFilterParam(filter: AlertFilter): string | null {
  return filter === 'OPEN' ? null : filter
}

/** What the API reads for a filter (`ALL` reads every status). */
export function alertApiStatus(filter: AlertFilter): string | null {
  return filter === 'ALL' ? null : filter
}

/** A tile press: that status, or every alert when it is the one already shown. */
export function toggleFilter(current: AlertFilter, pressed: AlertStatus): AlertFilter {
  return current === pressed ? 'ALL' : pressed
}

export const STATUS_WORDS: Record<AlertStatus, { word: string; tone: 'danger' | 'warning' | 'success' }> = {
  OPEN: { word: 'Open', tone: 'danger' },
  ACKNOWLEDGED: { word: 'Acknowledged', tone: 'warning' },
  RESOLVED: { word: 'Resolved', tone: 'success' },
}

/** The chip under the filters when a status is picked; none for every alert. */
export function filterChip(filter: AlertFilter): { label: string; removeLabel: string } | null {
  if (filter === 'ALL') return null
  const word = STATUS_WORDS[filter].word
  return { label: `Status: ${word}`, removeLabel: `Remove: ${word} only — show every alert` }
}

/** "No open alerts" … for the empty list. */
export function emptyTitle(filter: AlertFilter): string {
  if (filter === 'OPEN') return 'No open alerts'
  if (filter === 'ACKNOWLEDGED') return 'No acknowledged alerts'
  if (filter === 'RESOLVED') return 'No alerts resolved in the last 30 days'
  return 'No alerts'
}

/** "3 open alerts", "1 alert". */
export function shownWords(n: number, filter: AlertFilter): string {
  const what = filter === 'ALL' ? 'alert' : `${STATUS_WORDS[filter].word.toLowerCase()} alert`
  return `${n.toLocaleString('en-IE')} ${what}${n === 1 ? '' : 's'}`
}

// ── Time words ──────────────────────────────────────────────────────

/** "17 min ago", "3 h ago", "2 days ago". */
export function agoWords(iso: string | null | undefined, now: number): string {
  if (!iso) return 'never'
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

/** "10:17" (the business's local clock: the browser's). */
export function clockWords(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

// ── Tiles ───────────────────────────────────────────────────────────

export interface AlertTile {
  status: AlertStatus
  label: string
  value: string
  hint: string
  accent: string
}

export function alertTiles(answer: AlertsAnswer): AlertTile[] {
  const newToday = answer.items.filter((a) => a.newToday && a.status === 'OPEN').length
  return [
    { status: 'OPEN', label: 'Open', value: String(answer.counts.open), hint: newToday ? `${newToday} new today` : 'nobody is on them yet', accent: 'var(--nds-danger)' },
    { status: 'ACKNOWLEDGED', label: 'Acknowledged', value: String(answer.counts.acknowledged), hint: 'someone is on it', accent: 'var(--nds-warning)' },
    { status: 'RESOLVED', label: 'Resolved', value: String(answer.counts.resolved), hint: 'last 30 days', accent: 'var(--nds-success)' },
  ]
}

/** "4 days" with "−2 days" (faster is good news); none → "—". */
export function timeToResolveWords(t: AlertsAnswer['timeToResolve']): { value: string; delta: { value: string; positive: boolean } | null } {
  const days = (n: number) => `${Math.abs(n) % 1 === 0 ? Math.abs(n) : Math.abs(n).toFixed(1)} ${Math.abs(n) === 1 ? 'day' : 'days'}`
  if (t.days == null) return { value: '—', delta: null }
  return { value: days(t.days), delta: t.change == null || t.change === 0 ? null : { value: `${t.change < 0 ? '−' : '+'}${days(t.change)}`, positive: t.change < 0 } }
}

/** The live pill: "Checked 17 min ago" (or why it is not checking). */
export function checkWords(check: AlertsAnswer['check'], now: number): { tone: 'success' | 'danger' | 'neutral'; words: string } {
  if (!check.lastRunAt) return { tone: 'neutral', words: 'Not checked yet' }
  const failed = (check.lastStatus ?? '').toUpperCase() === 'FAILED' || (check.lastStatus ?? '').toUpperCase() === 'ERROR'
  return { tone: failed ? 'danger' : 'success', words: `${failed ? 'Last check failed' : 'Checked'} ${agoWords(check.lastRunAt, now)}` }
}

// ── One alert ───────────────────────────────────────────────────────

/** "Fit & sizing comes up 3× as often". */
export function alertTitle(a: Pick<AlertItem, 'theme' | 'multiplier'>): string {
  const times = a.multiplier == null ? 'more often' : `${a.multiplier % 1 === 0 ? a.multiplier : a.multiplier.toFixed(1)}× as often`
  return `${a.theme.label} comes up ${times}`
}

/** "8% → 18% of reviews (9 of 50 reviews in 7 days)". */
export function riseWords(a: Pick<AlertItem, 'from' | 'to' | 'basis'>): string {
  const pct = (n: number | null) => (n == null ? '—' : `${n}%`)
  return `${pct(a.from)} → ${pct(a.to)} of reviews (${a.basis})`
}

/** "Acknowledged by Teammate A · 3 h ago", "Resolved by Teammate B · 2 days ago"; open → null. */
export function whoWords(a: Pick<AlertItem, 'status' | 'acknowledged' | 'resolved'>, now: number): string | null {
  if (a.status === 'RESOLVED' && a.resolved) return `Resolved${a.resolved.by ? ` by ${a.resolved.by}` : ''} · ${agoWords(a.resolved.at, now)}`
  if (a.acknowledged) return `Acknowledged by ${a.acknowledged.by}${a.acknowledged.at ? ` · ${agoWords(a.acknowledged.at, now)}` : ''}`
  return null
}

const liveFixes = (a: Pick<AlertItem, 'fixes'>) => a.fixes.open + a.fixes.sent + a.fixes.applied

/** "2 fixes in Fixes", "1 fix sent for approval"; none → null. */
export function fixWords(a: Pick<AlertItem, 'fixes'>): string | null {
  const n = liveFixes(a)
  if (n === 0) return null
  if (a.fixes.open === 0 && a.fixes.sent > 0 && a.fixes.applied === 0) return `${a.fixes.sent} ${a.fixes.sent === 1 ? 'fix' : 'fixes'} sent for approval`
  return `${n} ${n === 1 ? 'fix' : 'fixes'} in Fixes`
}

/** Which of an alert's own buttons show (the API refuses the rest with the same reasons). */
export function alertActions(a: Pick<AlertItem, 'status' | 'fixes'>): { acknowledge: boolean; resolve: boolean; reopen: boolean; suggest: boolean } {
  return {
    acknowledge: a.status === 'OPEN',
    resolve: a.status !== 'RESOLVED',
    reopen: a.status !== 'OPEN',
    suggest: a.status !== 'RESOLVED' && liveFixes(a) === 0,
  }
}

/** "See the 9 reviews": the Inbox on the alert's theme, market, product (its SKU) and the last 7 days. */
export function alertReviewsHref(a: Pick<AlertItem, 'theme' | 'market' | 'product' | 'channels'>, scope: Pick<InsightsScope, 'channel'>): string {
  return inboxHref({
    theme: a.theme.key,
    market: a.market,
    channel: a.channels.length === 1 ? a.channels[0] : scope.channel,
    q: a.product?.sku ?? null,
    period: '7d',
  })
}

// ── The bulk bar (ruling 7) ─────────────────────────────────────────

export type AlertBulkAction = 'acknowledge' | 'resolve' | 'suggest'
export const SUGGEST_MAX = 5
export const MANAGE_ALERTS = "You need 'Manage reviews' to act on alerts."

export interface BulkPlan {
  apply: string[]
  held: Array<{ id: string; words: string }>
}

/** Why one alert cannot take a bulk action (the API's words); null = it can. */
export function bulkHeldFor(a: Pick<AlertItem, 'status' | 'fixes'>, action: AlertBulkAction): string | null {
  if (action === 'acknowledge') {
    if (a.status === 'ACKNOWLEDGED') return 'Already acknowledged.'
    if (a.status === 'RESOLVED') return 'Already resolved: reopen it first.'
    return null
  }
  if (action === 'resolve') return a.status === 'RESOLVED' ? 'Already resolved.' : null
  if (a.status === 'RESOLVED') return 'Resolved: reopen it to ask for fixes.'
  if (liveFixes(a) > 0) return 'It has fixes already: they are on the Fixes page.'
  return null
}

export function bulkPlan(selected: readonly AlertItem[], action: AlertBulkAction): BulkPlan {
  const plan: BulkPlan = { apply: [], held: [] }
  for (const a of selected) {
    const why = bulkHeldFor(a, action)
    if (why) plan.held.push({ id: a.id, words: why })
    else plan.apply.push(a.id)
  }
  return plan
}

const VERB: Record<AlertBulkAction, string> = { acknowledge: 'Acknowledge', resolve: 'Resolve', suggest: 'Suggest fixes' }

/** The bulk button's label: "Acknowledge 3" — the alerts it changes, not the ones ticked. */
export function bulkLabel(action: AlertBulkAction, plan: BulkPlan): string {
  if (action === 'suggest') return plan.apply.length > 0 ? `Suggest fixes for ${plan.apply.length}` : VERB.suggest
  return plan.apply.length > 0 ? `${VERB[action]} ${plan.apply.length}` : VERB[action]
}

/** Why a bulk button is held (null = it can run): the permission, more than 5 to suggest for, or none it applies to. */
export function bulkHeld(canManage: boolean, action: AlertBulkAction, selectedCount: number, plan: BulkPlan): string | null {
  if (!canManage) return MANAGE_ALERTS
  if (action === 'suggest' && plan.apply.length > SUGGEST_MAX) return `Suggest fixes works on up to ${SUGGEST_MAX} alerts at a time: untick ${plan.apply.length - SUGGEST_MAX}.`
  if (plan.apply.length > 0) return null
  if (selectedCount === 0) return 'Tick at least one alert.'
  if (action === 'acknowledge') return 'Every ticked alert is already acknowledged or resolved.'
  if (action === 'resolve') return 'Every ticked alert is already resolved.'
  return 'No ticked alert can ask for fixes: each is resolved or has fixes already.'
}

/** The toast after a bulk change, in the server's count: "2 alerts acknowledged · 1 left out: Already acknowledged." */
export function bulkResultWords(action: AlertBulkAction, changed: number, held: ReadonlyArray<{ words: string }>, fixes?: number): string {
  const n = `${changed} ${changed === 1 ? 'alert' : 'alerts'}`
  const done = action === 'acknowledge' ? `${n} acknowledged` : action === 'resolve' ? `${n} resolved` : `${fixes ?? 0} ${fixes === 1 ? 'fix' : 'fixes'} suggested for ${n}`
  if (held.length === 0) return done
  const reasons = [...new Set(held.map((h) => h.words))]
  return `${done} · ${held.length} left out: ${reasons.join(' ')}`
}

/** The toast after one alert's own button. */
export function decisionWords(decision: 'ACKNOWLEDGED' | 'RESOLVED' | 'REOPEN', a: Pick<AlertItem, 'theme' | 'where'>): string {
  const what = `${a.theme.label} · ${a.where}`
  if (decision === 'ACKNOWLEDGED') return `Acknowledged: ${what}. Others see that you are on it.`
  if (decision === 'RESOLVED') return `Resolved: ${what}. If the share stays high for 7 more days, a new alert opens.`
  return `Reopened: ${what}.`
}

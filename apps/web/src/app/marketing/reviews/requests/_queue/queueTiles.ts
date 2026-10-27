/**
 * Reviews › Requests › Queue — the words around the grid: the tiles (Scheduled … Skipped filter the grid; Review rate
 * is an estimate and filters nothing), each status in words and its tone, the removable chips of the filters that are
 * on, and the count line. Pure; tested in queueTiles.vitest.test.ts.
 */
import type { Tone } from '@/design-system/primitives'
import { COUNTRY_NAMES } from '@/app/_shared/app-nav'
import { NOT_MEASURABLE, channelMarketWords, productTypeWords, rateNotMeasurable } from '../../_lib/reviewWords'
import type { QueueFacets, QueueStatus, QueueTiles } from './queueDatasource'
import { DEFAULT_QUEUE_PERIOD, type QueueFilterKey, type QueuePeriod, type QueueQuery } from './queueQuery'

export const STATUS_WORDS: Record<QueueStatus, string> = {
  SCHEDULED: 'Scheduled',
  DUE: 'Due now',
  RETRYING: 'Retrying',
  SENT: 'Sent',
  FAILED: 'Failed',
  SKIPPED: 'Skipped',
  SUPPRESSED: 'Blocked',
}

export const STATUS_TONES: Record<QueueStatus, Tone> = {
  SCHEDULED: 'neutral',
  DUE: 'info',
  RETRYING: 'warning',
  SENT: 'success',
  FAILED: 'danger',
  SKIPPED: 'neutral',
  SUPPRESSED: 'neutral',
}

/** The status filter's options, in the tiles' order. */
export const STATUS_OPTIONS: { value: QueueStatus; label: string }[] = [
  { value: 'SCHEDULED', label: 'Scheduled' },
  { value: 'DUE', label: 'Due now' },
  { value: 'RETRYING', label: 'Retrying' },
  { value: 'SENT', label: 'Sent' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'SKIPPED', label: 'Skipped (every request not asked, blocked ones too)' },
  { value: 'SUPPRESSED', label: 'Blocked (a return, a refund, the do-not-email list)' },
]

export function statusWords(status: QueueStatus): string {
  return STATUS_WORDS[status] ?? status
}

const count = (n: number) => n.toLocaleString('en-IE')

/** "IT" → "Italy"; an unknown code as it is. */
export function marketName(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] ?? code
}

/** 0.074 → "7.4%"; none → "—". */
export function rateText(rate: number | null | undefined): string {
  return rate == null || !Number.isFinite(rate) ? '—' : `${(rate * 100).toFixed(1)}%`
}

/** 0.006 → "+0.6"; -0.012 → "−1.2"; none or 0.0 → null. Points, not percent. */
export function pointsDelta(delta: number | null | undefined): { value: string; positive: boolean } | null {
  if (delta == null || !Number.isFinite(delta)) return null
  const points = Math.round(delta * 1000) / 10
  if (points === 0) return null
  return { value: `${points > 0 ? '+' : '−'}${Math.abs(points).toFixed(1)}`, positive: points > 0 }
}

export interface QueueTileView {
  key: QueueStatus | 'rate'
  label: string
  value: string
  hint: string
  /** The status it filters; none for Review rate. */
  status: QueueStatus | null
  active: boolean
  accent?: string
  delta?: { value: string; positive: boolean }
}

/** The six status tiles (filters) and the review rate (an estimate) of the page's period. */
export function queueTileViews(tiles: QueueTiles, active: QueueStatus | null, period: QueuePeriod = DEFAULT_QUEUE_PERIOD): QueueTileView[] {
  const tile = (status: QueueStatus, value: number, hint: string, accent?: string): QueueTileView => ({
    key: status,
    label: STATUS_WORDS[status],
    value: count(value),
    hint,
    status,
    active: active === status,
    accent,
  })
  const rate = pointsDelta(tiles.rateDelta)
  return [
    tile('SCHEDULED', tiles.scheduled, 'waiting for their first try'),
    tile('DUE', tiles.dueNow, 'go at the next run', 'var(--nds-info)'),
    tile('RETRYING', tiles.retrying, 'tried again on their own', 'var(--nds-warning)'),
    tile('SENT', tiles.sent, PERIOD_WORDS[period], 'var(--nds-success)'),
    tile('FAILED', tiles.failed, 'no try left', 'var(--nds-danger)'),
    tile('SKIPPED', tiles.skipped, 'not asked, with the reason'),
    {
      key: 'rate',
      label: 'Review rate',
      value: rateNotMeasurable(tiles.reviewRate, tiles.rateWords) ? NOT_MEASURABLE : rateText(tiles.reviewRate),
      hint: tiles.rateWords ?? (tiles.reviewRate == null ? 'nothing sent in this period' : `${PERIOD_WORDS[period]}, estimate`),
      status: null,
      active: false,
      ...(rate ? { delta: rate } : {}),
    },
  ]
}

export interface FilterChip {
  key: QueueFilterKey | 'q' | 'period'
  words: string
  removeLabel: string
}

const PERIOD_WORDS: Record<QueuePeriod, string> = { '7d': 'last 7 days', '30d': 'last 30 days', '90d': 'last 90 days', '12m': 'last 12 months', all: 'all time' }

/** "last 90 days", "all time". */
export function queuePeriodWords(period: QueuePeriod): string {
  return PERIOD_WORDS[period]
}

/** The filters that are on, as removable chips. A rule or reason not in the facets shows by its key. */
export function filterChips(q: QueueQuery, facets: QueueFacets | null): FilterChip[] {
  const chips: FilterChip[] = []
  if (q.status) chips.push({ key: 'status', words: `Status: ${STATUS_WORDS[q.status]}`, removeLabel: 'Show every status' })
  if (q.channel) chips.push({ key: 'channel', words: `Channel: ${channelMarketWords(q.channel)}`, removeLabel: 'Show every channel' })
  if (q.market) chips.push({ key: 'market', words: `Market: ${marketName(q.market)}`, removeLabel: 'Show every market' })
  if (q.rule) {
    const name = q.rule === 'none' ? 'No rule' : facets?.rules.find((r) => r.id === q.rule)?.name ?? 'a rule'
    chips.push({ key: 'rule', words: `Rule: ${name}`, removeLabel: 'Show requests of every rule' })
  }
  if (q.productType) chips.push({ key: 'productType', words: `Product type: ${productTypeWords(q.productType)}`, removeLabel: 'Show every product type' })
  if (q.reason) {
    const words = facets?.reasons.find((r) => r.key === q.reason)?.words ?? q.reason
    chips.push({ key: 'reason', words: `Reason: ${words}`, removeLabel: 'Show every reason' })
  }
  if (q.q.trim()) chips.push({ key: 'q', words: `Search: “${q.q.trim()}”`, removeLabel: 'Clear the search' })
  if (q.period !== DEFAULT_QUEUE_PERIOD) {
    chips.push({ key: 'period', words: `Period: ${PERIOD_WORDS[q.period]} and upcoming`, removeLabel: 'Show the last 30 days' })
  }
  return chips
}

/** "1,461 requests · last 30 days and upcoming" (with a filter: "37 requests match"). */
export function countWords(total: number, filtered: boolean, period: QueuePeriod = DEFAULT_QUEUE_PERIOD): string {
  const n = `${count(total)} ${total === 1 ? 'request' : 'requests'}`
  return filtered ? `${n} match` : `${n} · ${PERIOD_WORDS[period]} and upcoming`
}

/** The failures banner's two lines from the API's sentence ("6 requests failed…: 4 emails bounced · …"). */
export function failuresLines(words: string): { title: string; detail: string | null } {
  const at = words.indexOf(': ')
  return at < 0 ? { title: words, detail: null } : { title: words.slice(0, at), detail: words.slice(at + 2) }
}

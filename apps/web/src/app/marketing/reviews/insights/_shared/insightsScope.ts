/**
 * Reviews › Insights — the scope the five Insights pages share (build spec §3.4): which channel and market, and which
 * period (7 days · 30 days · 90 days · 12 months). It lives in the address (`?channel=AMAZON&market=DE&period=90d`), so
 * a link, a reload or a new tab shows the same thing, and a link from one Insights page to another keeps it. The words
 * match the API's (`review-spotlight.service.ts` `scopeLabel`, `review-insights-math.ts` `parseInsightScope`): an
 * unknown channel or market means "all", never an error page.
 *
 * Pure (no React), tested in insightsScope.vitest.test.ts.
 */
import { channelLabel } from '@/app/listings/_readiness/marketChips'
import { COUNTRY_NAMES } from '@/app/_shared/app-nav'
import type { LinkParams } from '../../_lib/reviewsLinks'

export const INSIGHTS_PERIODS = ['7d', '30d', '90d', '12m'] as const
export type InsightsPeriod = (typeof INSIGHTS_PERIODS)[number]
/** The period a page shows when the address names none; it then leaves `period` out of the address. */
export const DEFAULT_INSIGHTS_PERIOD: InsightsPeriod = '30d'

export const INSIGHTS_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] as const

export interface InsightsScope {
  /** 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ETSY', or null for every channel. */
  channel: string | null
  /** A market code ('DE'), or null for every market. */
  market: string | null
  period: InsightsPeriod
}

export const ALL_SCOPE: InsightsScope = { channel: null, market: null, period: DEFAULT_INSIGHTS_PERIOD }

const PERIOD_WORDS: Record<InsightsPeriod, { short: string; label: string; before: string }> = {
  '7d': { short: '7 days', label: 'last 7 days', before: 'the 7 days before' },
  '30d': { short: '30 days', label: 'last 30 days', before: 'the 30 days before' },
  '90d': { short: '90 days', label: 'last 90 days', before: 'the 90 days before' },
  '12m': { short: '12 months', label: 'last 12 months', before: 'the 12 months before' },
}

/** The period control's choices, in order. */
export const PERIOD_OPTIONS = INSIGHTS_PERIODS.map((p) => ({ value: p, label: PERIOD_WORDS[p].short }))

/** "last 30 days" (in a sentence), "30 days" (on a control), "the 30 days before" (what a change compares with). */
export function periodWords(period: InsightsPeriod): { short: string; label: string; before: string } {
  return PERIOD_WORDS[period]
}

/** A period from the address; anything else (missing, misspelt, `all`) is 30 days: Insights compare with the period before. */
export function parseInsightsPeriod(raw: string | null | undefined): InsightsPeriod {
  const value = (raw ?? '').trim().toLowerCase()
  return (INSIGHTS_PERIODS as readonly string[]).includes(value) ? (value as InsightsPeriod) : DEFAULT_INSIGHTS_PERIOD
}

function cleanChannel(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toUpperCase()
  return (INSIGHTS_CHANNELS as readonly string[]).includes(value) ? value : null
}

function cleanMarket(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim().toUpperCase()
  if (!/^[A-Z]{2,8}$/.test(value) || value === 'ALL') return null
  return value === 'GB' ? 'UK' : value
}

/** The scope from an address (`?channel&market&period`; `marketplace` is read as the market too). */
export function parseInsightsScope(search: string | URLSearchParams): InsightsScope {
  const p = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search
  return {
    channel: cleanChannel(p.get('channel')),
    market: cleanMarket(p.get('market') ?? p.get('marketplace')),
    period: parseInsightsPeriod(p.get('period')),
  }
}

/** The scope's part of an address: the default period and "all" are left out. */
export function scopeAddressParams(scope: InsightsScope): LinkParams {
  return { channel: scope.channel, market: scope.market, period: scope.period === DEFAULT_INSIGHTS_PERIOD ? null : scope.period }
}

/** The scope as the API reads it (the period always named, so a cached answer is never the wrong period's). */
export function scopeApiParams(scope: InsightsScope): LinkParams {
  return { channel: scope.channel, market: scope.market, period: scope.period }
}

/**
 * A page's address: the scope first, then the page's own values (`sort`, `status`, `product` …). Empty values are left
 * out; the answer starts with `?`, or is '' when nothing is set.
 */
export function insightsSearch(scope: InsightsScope, page: LinkParams = {}): string {
  const q = new URLSearchParams()
  for (const [key, value] of Object.entries({ ...scopeAddressParams(scope), ...page })) {
    if (value == null || value === '' || value === false) continue
    if (Array.isArray(value)) {
      if (value.length) q.set(key, value.join(','))
    } else q.set(key, value === true ? '1' : String(value))
  }
  const text = q.toString()
  return text ? `?${text}` : ''
}

// ── The channel-and-market picker ──────────────────────────────────

/** The picker's value for a channel and market: "AMAZON|DE", "EBAY|", "|" (everything). */
export function scopeKey(scope: { channel: string | null; market: string | null }): string {
  return `${scope.channel ?? ''}|${scope.market ?? ''}`
}

/** The channel and market of a picker value; anything unknown is "all". */
export function scopeFromKey(key: string): { channel: string | null; market: string | null } {
  const [channel = '', market = ''] = key.split('|')
  return { channel: cleanChannel(channel), market: cleanMarket(market) }
}

/** A market in words ("Germany"); an unknown code as it is. */
export function marketName(code: string): string {
  return COUNTRY_NAMES[code] ?? code
}

/** "All channels and markets", "Amazon — all markets", "Amazon Germany", "Shopify", "Every channel in Germany". */
export function scopeLabel(scope: { channel: string | null; market: string | null }): string {
  const { channel, market } = scope
  if (!channel) return market ? `Every channel in ${marketName(market)}` : 'All channels and markets'
  if (market) return `${channelLabel(channel)} ${marketName(market)}`
  return channel === 'AMAZON' || channel === 'EBAY' ? `${channelLabel(channel)} — all markets` : channelLabel(channel)
}

/** One choice of a scope picker, as the API lists it (`GET /api/reviews/spotlight/scopes`). */
export interface ScopeChoice {
  channel: string | null
  marketplace: string | null
  label?: string
  /** Brief only: "Brief from 26 Oct", "No brief yet", "Too few reviews (13)". */
  note?: string
}

export interface ScopeOption {
  value: string
  label: string
  note?: string
}

const CHANNEL_ORDER = ['', ...INSIGHTS_CHANNELS]

/**
 * The picker's choices: "All channels and markets" first, then per channel its "all markets" and each market with
 * reviews (the API's list), and always the scope on screen (a link may name one with no reviews yet). `notes` keeps the
 * API's note per choice (the Brief's "Brief from 26 Oct").
 */
export function scopeOptions(choices: readonly ScopeChoice[], current: { channel: string | null; market: string | null }, opts: { notes?: boolean } = {}): ScopeOption[] {
  const byKey = new Map<string, ScopeOption>()
  const add = (channel: string | null, market: string | null, note?: string) => {
    const clean = { channel: cleanChannel(channel), market: cleanMarket(market) }
    if (channel && !clean.channel) return
    const value = scopeKey(clean)
    if (byKey.has(value)) return
    byKey.set(value, { value, label: scopeLabel(clean), ...(opts.notes && note ? { note } : {}) })
  }
  add(null, null, choices.find((c) => !c.channel && !c.marketplace)?.note)
  for (const c of choices) add(c.channel, c.marketplace, c.note)
  add(current.channel, current.market)
  const rank = (o: ScopeOption) => {
    const { channel, market } = scopeFromKey(o.value)
    return [CHANNEL_ORDER.indexOf(channel ?? ''), market ? 1 : 0] as const
  }
  return [...byKey.values()].sort((a, b) => {
    const [ca, ma] = rank(a)
    const [cb, mb] = rank(b)
    return ca - cb || ma - mb || a.label.localeCompare(b.label)
  })
}

/** "Amazon Germany · last 90 days" — what a page shows, for its subtitle. */
export function scopeWords(scope: InsightsScope): string {
  return `${scopeLabel(scope)} · ${periodWords(scope.period).label}`
}

/** Whether Amazon's weekly topics can be part of this scope (they never cover Amazon.nl, and no other channel has them). */
export function amazonTopicsInScope(scope: { channel: string | null; market: string | null }): boolean {
  if (scope.channel && scope.channel !== 'AMAZON') return false
  return !scope.market || ['UK', 'DE', 'FR', 'IT', 'ES'].includes(scope.market)
}

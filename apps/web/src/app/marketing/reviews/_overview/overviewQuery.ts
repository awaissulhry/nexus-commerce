/**
 * Reviews Overview — what the page shows, kept in the address so a reload or a shared link shows the same thing:
 * the period (`?period=7d`; 30 days is the default and leaves the address), the "Needs you" filter a tile set
 * (`?show=reply|requests|alerts`), the rating bar pressed (`?stars=1`), and a channel and market scope
 * (`?channel=EBAY&market=IT`, from a link). Read once on mount, written back with `history.replaceState`. Pure, tested in
 * overviewQuery.vitest.test.ts.
 */
import type { Period } from '../_lib/reviewsPeriod'

/** The periods the Overview offers (All time is the Inbox's; a link with it opens on the default). */
export const OVERVIEW_PERIODS = ['7d', '30d', '90d', '12m'] as const satisfies readonly Period[]
export type OverviewPeriod = (typeof OVERVIEW_PERIODS)[number]
export const DEFAULT_OVERVIEW_PERIOD: OverviewPeriod = '30d'

/** The filter tiles: they narrow "Needs you". */
export type NeedsFilter = 'reply' | 'requests' | 'alerts'
export const NEEDS_FILTERS: readonly NeedsFilter[] = ['reply', 'requests', 'alerts']

export type StarsFilter = 1 | 2 | 3 | 4 | 5

export interface OverviewQuery {
  period: OverviewPeriod
  show: NeedsFilter | null
  stars: StarsFilter | null
  channel: string | null
  market: string | null
}

export const EMPTY_OVERVIEW_QUERY: OverviewQuery = { period: DEFAULT_OVERVIEW_PERIOD, show: null, stars: null, channel: null, market: null }

const CODE = /^[A-Z_]{2,20}$/

function code(raw: string | null): string | null {
  const value = raw?.trim().toUpperCase() ?? ''
  return value && value !== 'ALL' && CODE.test(value) ? value : null
}

export function parseOverviewQuery(search: string | URLSearchParams): OverviewQuery {
  const p = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search
  const period = p.get('period')?.trim().toLowerCase() ?? ''
  const show = p.get('show')?.trim().toLowerCase() ?? ''
  const stars = Number(p.get('stars'))
  return {
    period: (OVERVIEW_PERIODS as readonly string[]).includes(period) ? (period as OverviewPeriod) : DEFAULT_OVERVIEW_PERIOD,
    show: (NEEDS_FILTERS as readonly string[]).includes(show) ? (show as NeedsFilter) : null,
    stars: Number.isInteger(stars) && stars >= 1 && stars <= 5 ? (stars as StarsFilter) : null,
    channel: code(p.get('channel')),
    market: code(p.get('market')),
  }
}

/** The query string for `q` ('' when everything is the default), in a fixed order. */
export function serializeOverviewQuery(q: OverviewQuery): string {
  const p = new URLSearchParams()
  if (q.period !== DEFAULT_OVERVIEW_PERIOD) p.set('period', q.period)
  if (q.show) p.set('show', q.show)
  if (q.stars) p.set('stars', String(q.stars))
  if (q.channel) p.set('channel', q.channel)
  if (q.market) p.set('market', q.market)
  const text = p.toString()
  return text ? `?${text}` : ''
}

/** A new period clears the pressed rating bar: its count belonged to the old period. */
export function withPeriod(q: OverviewQuery, period: string): OverviewQuery {
  const next = (OVERVIEW_PERIODS as readonly string[]).includes(period) ? (period as OverviewPeriod) : q.period
  return next === q.period ? q : { ...q, period: next, stars: null }
}

/** Pressing a filter tile turns its filter on; pressing it again (or the chip's ×) turns it off. */
export function toggleShow(q: OverviewQuery, show: NeedsFilter | null): OverviewQuery {
  return { ...q, show: show == null || q.show === show ? null : show }
}

export function withStars(q: OverviewQuery, stars: StarsFilter | null): OverviewQuery {
  return { ...q, stars }
}

/** Leave the channel and market scope a link brought. */
export function withoutScope(q: OverviewQuery): OverviewQuery {
  return { ...q, channel: null, market: null }
}

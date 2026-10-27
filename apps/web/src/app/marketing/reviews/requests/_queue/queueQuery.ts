/**
 * Reviews › Requests › Queue — the page's address, read once on mount and written back with `replaceState` on every
 * change: the filters (status, channel, market, rule, product type, reason, search), the period of the rows (a link from
 * the Overview or a channel page keeps its own period; 30 days by default), the sort, the page, the results period and
 * the request open in the pop-up. `?inserts=1` and `?preview=1` (links from elsewhere, and the redirects of
 * the old Package inserts and e-mail test pages) open their window once and are never written back. Pure; tested in
 * queueQuery.vitest.test.ts.
 */
import type { LinkParams } from '../../_lib/reviewsLinks'
import type { QueueStatus } from './queueDatasource'

export const QUEUE_STATUSES: readonly QueueStatus[] = ['SCHEDULED', 'DUE', 'RETRYING', 'SENT', 'FAILED', 'SKIPPED', 'SUPPRESSED']
export const QUEUE_PAGE_SIZES = [50, 100, 200] as const
export const DEFAULT_QUEUE_PAGE_SIZE = 50
export const QUEUE_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
export const QUEUE_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'BE', 'PL', 'SE', 'IE'] as const

export type ResultsPeriod = '7d' | '30d' | '90d'
export const RESULTS_PERIODS: readonly ResultsPeriod[] = ['7d', '30d', '90d']

/** The rows' period (GET /api/review-queue `period`): what changed in it, plus everything still waiting. */
export type QueuePeriod = '7d' | '30d' | '90d' | '12m' | 'all'
export const QUEUE_PERIODS: readonly QueuePeriod[] = ['7d', '30d', '90d', '12m', 'all']
export const DEFAULT_QUEUE_PERIOD: QueuePeriod = '30d'

/** The API's sort fields, by grid column. */
export const QUEUE_SORT_FIELDS = {
  next: 'nextTry',
  delivered: 'deliveredAt',
  tries: 'tries',
} as const
export type QueueSortColumn = keyof typeof QUEUE_SORT_FIELDS
export interface QueueSort { column: QueueSortColumn; dir: 'asc' | 'desc' }

export interface QueueQuery {
  status: QueueStatus | null
  channel: string | null
  market: string | null
  rule: string | null
  productType: string | null
  reason: string | null
  q: string
  period: QueuePeriod
  sort: QueueSort | null
  page: number
  pageSize: number
  results: ResultsPeriod
  /** The request open in the pop-up. */
  request: string | null
}

export const EMPTY_QUEUE_QUERY: QueueQuery = {
  status: null,
  channel: null,
  market: null,
  rule: null,
  productType: null,
  reason: null,
  q: '',
  period: DEFAULT_QUEUE_PERIOD,
  sort: null,
  page: 1,
  pageSize: DEFAULT_QUEUE_PAGE_SIZE,
  results: '30d',
  request: null,
}

/** Windows a link asks the page to open once. */
export interface QueueFlags {
  inserts: boolean
  preview: boolean
}

const text = (v: string | null) => (v ?? '').trim()
const upperOrNull = (v: string | null) => text(v).toUpperCase() || null
const isFlag = (v: string | null) => v === '1' || v === 'true'

function parseSort(raw: string | null): QueueSort | null {
  const [column, dir] = text(raw).split(':')
  if (!(column in QUEUE_SORT_FIELDS)) return null
  return { column: column as QueueSortColumn, dir: dir === 'asc' ? 'asc' : 'desc' }
}

/** The address → the query and the windows to open. Unknown values fall back to "everything". */
export function parseQueueQuery(search: string): { query: QueueQuery; flags: QueueFlags } {
  const p = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const status = upperOrNull(p.get('status'))
  const pageSize = Number(p.get('pageSize'))
  const results = text(p.get('results')) as ResultsPeriod
  const period = text(p.get('period')).toLowerCase() as QueuePeriod
  const query: QueueQuery = {
    status: status && (QUEUE_STATUSES as readonly string[]).includes(status) ? (status as QueueStatus) : null,
    channel: upperOrNull(p.get('channel')),
    market: upperOrNull(p.get('market')),
    rule: text(p.get('rule')) || null,
    productType: text(p.get('productType')) || null,
    reason: text(p.get('reason')) || null,
    q: text(p.get('q')).slice(0, 100),
    period: QUEUE_PERIODS.includes(period) ? period : DEFAULT_QUEUE_PERIOD,
    sort: parseSort(p.get('sort')),
    page: Math.max(1, Math.floor(Number(p.get('page')) || 1)),
    pageSize: (QUEUE_PAGE_SIZES as readonly number[]).includes(pageSize) ? pageSize : DEFAULT_QUEUE_PAGE_SIZE,
    results: RESULTS_PERIODS.includes(results) ? results : '30d',
    request: text(p.get('request')) || null,
  }
  return { query, flags: { inserts: isFlag(p.get('inserts')), preview: isFlag(p.get('preview')) } }
}

/** The query → the address ("" or "?…"), defaults left out. The open-once flags are never written. */
export function serializeQueueQuery(q: QueueQuery): string {
  const p = new URLSearchParams()
  if (q.status) p.set('status', q.status)
  if (q.channel) p.set('channel', q.channel)
  if (q.market) p.set('market', q.market)
  if (q.rule) p.set('rule', q.rule)
  if (q.productType) p.set('productType', q.productType)
  if (q.reason) p.set('reason', q.reason)
  if (q.q.trim()) p.set('q', q.q.trim())
  if (q.period !== DEFAULT_QUEUE_PERIOD) p.set('period', q.period)
  if (q.sort) p.set('sort', `${q.sort.column}:${q.sort.dir}`)
  if (q.page > 1) p.set('page', String(q.page))
  if (q.pageSize !== DEFAULT_QUEUE_PAGE_SIZE) p.set('pageSize', String(q.pageSize))
  if (q.results !== '30d') p.set('results', q.results)
  if (q.request) p.set('request', q.request)
  const s = p.toString()
  return s ? `?${s}` : ''
}

/** What `GET /api/review-queue` is asked: the rows' period (30 days by default) and everything still waiting. */
export function queueApiParams(q: QueueQuery): LinkParams {
  return {
    status: q.status,
    channel: q.channel,
    market: q.market,
    rule: q.rule,
    productType: q.productType,
    reason: q.reason,
    q: q.q.trim() || null,
    sort: q.sort ? `${QUEUE_SORT_FIELDS[q.sort.column]}:${q.sort.dir}` : null,
    page: q.page,
    pageSize: q.pageSize,
    period: q.period,
  }
}

export type QueueFilterKey = 'status' | 'channel' | 'market' | 'rule' | 'productType' | 'reason'

/** One filter set (or cleared with null / ""); back to page 1. */
export function withFilter(q: QueueQuery, key: QueueFilterKey, value: string | null): QueueQuery {
  const v = value && value.trim() ? value.trim() : null
  if (key === 'status') {
    const s = v ? v.toUpperCase() : null
    return { ...q, status: s && (QUEUE_STATUSES as readonly string[]).includes(s) ? (s as QueueStatus) : null, page: 1 }
  }
  return { ...q, [key]: key === 'channel' || key === 'market' ? v?.toUpperCase() ?? null : v, page: 1 }
}

/** A tile press: its status, or none when it is the status already shown. */
export function toggleStatus(q: QueueQuery, status: QueueStatus): QueueQuery {
  return { ...q, status: q.status === status ? null : status, page: 1 }
}

/** The rows' period (a period chip's ×: back to 30 days); back to page 1. */
export function withPeriod(q: QueueQuery, period: QueuePeriod): QueueQuery {
  return { ...q, period: QUEUE_PERIODS.includes(period) ? period : DEFAULT_QUEUE_PERIOD, page: 1 }
}

/** The search box. */
export function withSearch(q: QueueQuery, text: string): QueueQuery {
  return { ...q, q: text.slice(0, 100), page: 1 }
}

/** Every filter and the search off, the rows' period back to 30 days; sort, page size and the results period kept. */
export function clearFilters(q: QueueQuery): QueueQuery {
  return { ...q, status: null, channel: null, market: null, rule: null, productType: null, reason: null, q: '', period: DEFAULT_QUEUE_PERIOD, page: 1 }
}

/** How many filters are on (the filter bar's Clear). The search and a period other than 30 days count. */
export function activeFilterCount(q: QueueQuery): number {
  return [q.status, q.channel, q.market, q.rule, q.productType, q.reason, q.q.trim() || null, q.period !== DEFAULT_QUEUE_PERIOD || null].filter(Boolean).length
}

/** A header click: the column's sort, or none for a column the server cannot sort by. */
export function withSort(q: QueueQuery, column: string | null, dir: 'asc' | 'desc' | null): QueueQuery {
  if (!column || !dir || !(column in QUEUE_SORT_FIELDS)) return { ...q, sort: null, page: 1 }
  return { ...q, sort: { column: column as QueueSortColumn, dir }, page: 1 }
}

export function withPage(q: QueueQuery, page: number): QueueQuery {
  return { ...q, page: Math.max(1, Math.floor(page)) }
}

export function withPageSize(q: QueueQuery, size: number): QueueQuery {
  return { ...q, pageSize: (QUEUE_PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_QUEUE_PAGE_SIZE, page: 1 }
}

/** Pages for the pager (at least one). */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)))
}

/** The key a read of this query is cached under (the request pop-up and the results period do not change the rows). */
export function queueReadKey(q: QueueQuery): string {
  return serializeQueueQuery({ ...q, request: null, results: '30d' })
}

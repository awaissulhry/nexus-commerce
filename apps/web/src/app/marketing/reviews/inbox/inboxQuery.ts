/**
 * Reviews › Inbox — what the page shows, kept in the address so a reload or a shared link shows the same thing: the tab
 * (`?kind=product|seller`), the period (`?period=7d`; 30 days is the default and leaves the address; `all` = All time),
 * the status tile (`?status=OVERDUE`), "Needs a reply" (`?reply=needed`: only the reviews someone can answer that wait for it —
 * the number on the rail and sub-sidebar badges and the Overview tile, which link here with it and `period=all`), every Filters field (`channel`, `market`, `stars`, `mood`, `theme`, `owner`,
 * `family` — comma lists; `owner=none` = nobody; "Has photos" = `?photos=1`), the search (`?q=`), the order (`?sort=rating:asc`) and the pager
 * (`?page=2&pageSize=100`). Two one-time flags are read on mount and then left out of the address: `?import=1` opens
 * the Import window, `?review=<id>` opens that review's pop-up (and stays while it is open).
 *
 * The same names as the API (`GET /api/reviews/inbox`), so `inboxApiParams` hands the query on as it is. Pure, tested
 * in inboxQuery.vitest.test.ts. Read once with `parseInboxQuery`, written back with `history.replaceState`.
 */
import type { LinkParams } from '../_lib/reviewsLinks'

export const INBOX_PATH = '/marketing/reviews/inbox'

export const INBOX_KINDS = ['all', 'product', 'seller'] as const
export type InboxKind = (typeof INBOX_KINDS)[number]

/** 12 months is not on the Inbox's own control, but a link from the Overview may carry it. */
export const INBOX_PERIODS = ['7d', '30d', '90d', '12m', 'all'] as const
export type InboxPeriod = (typeof INBOX_PERIODS)[number]
export const DEFAULT_INBOX_PERIOD: InboxPeriod = '30d'
/** The periods on the header's control. */
export const INBOX_PERIOD_CHOICES: readonly InboxPeriod[] = ['7d', '30d', '90d', 'all']

export const INBOX_STATUSES = ['NEW', 'IN_PROGRESS', 'RESPONDED', 'RESOLVED', 'IGNORED', 'OVERDUE'] as const
export type InboxStatus = (typeof INBOX_STATUSES)[number]

export const INBOX_MOODS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'] as const

export const INBOX_SORTS = ['postedAt:desc', 'postedAt:asc', 'rating:asc', 'rating:desc'] as const
export type InboxSort = (typeof INBOX_SORTS)[number]
export const DEFAULT_INBOX_SORT: InboxSort = 'postedAt:desc'

export const INBOX_PAGE_SIZES = [50, 100, 200] as const
export type InboxPageSize = (typeof INBOX_PAGE_SIZES)[number]
export const DEFAULT_INBOX_PAGE_SIZE: InboxPageSize = 50

/** `owner=none`: nobody is assigned (the API's word). */
export const NO_OWNER = 'none'

export interface InboxQuery {
  kind: InboxKind
  period: InboxPeriod
  statuses: InboxStatus[]
  channels: string[]
  markets: string[]
  stars: number[]
  moods: string[]
  themes: string[]
  owners: string[]
  families: string[]
  /** `reply=needed`: only the reviews that need a reply (the API's one rule: answerable, not imported, open). */
  needsReply: boolean
  /** `product=<id>`: one product's reviews (and its variants'), from an alert's "See the reviews". */
  product: string | null
  /** "Has photos" (PR G): only reviews with the buyer's photos. */
  photos: boolean
  q: string
  sort: InboxSort
  page: number
  pageSize: InboxPageSize
}

/** The Filters fields, in the order the bar shows them. */
export const FILTER_KEYS = ['channels', 'markets', 'stars', 'moods', 'themes', 'statuses', 'owners', 'families'] as const
export type InboxFilterKey = (typeof FILTER_KEYS)[number]

export const EMPTY_INBOX_QUERY: InboxQuery = {
  kind: 'all',
  period: DEFAULT_INBOX_PERIOD,
  statuses: [],
  channels: [],
  markets: [],
  stars: [],
  moods: [],
  themes: [],
  owners: [],
  families: [],
  needsReply: false,
  product: null,
  photos: false,
  q: '',
  sort: DEFAULT_INBOX_SORT,
  page: 1,
  pageSize: DEFAULT_INBOX_PAGE_SIZE,
}

export interface InboxAddress {
  query: InboxQuery
  /** `?import=1`: open the Import window once. */
  openImport: boolean
  /** `?review=<id>`: open that review's pop-up. */
  review: string | null
}

const CODE = /^[A-Z_]{2,20}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/

function list(raw: string | null): string[] {
  return [...new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean))]
}

function codes(raw: string | null, allowed?: readonly string[]): string[] {
  return list(raw)
    .map((s) => s.toUpperCase())
    .filter((s) => s !== 'ALL' && CODE.test(s) && (!allowed || allowed.includes(s)))
    .filter((s, i, all) => all.indexOf(s) === i)
}

/** "7", "7d", "30d", "90d", "12m", "all" → a period; anything else (missing, misspelt) is the default. */
export function parseInboxPeriod(raw: string | null | undefined): InboxPeriod {
  const value = (raw ?? '').trim().toLowerCase()
  if ((INBOX_PERIODS as readonly string[]).includes(value)) return value as InboxPeriod
  if (/^(7|30|90)$/.test(value)) return `${value}d` as InboxPeriod
  return DEFAULT_INBOX_PERIOD
}

function positiveInt(raw: string | null, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/** The address → the query and the one-time flags. Unknown values are dropped, never guessed. */
export function parseInboxQuery(search: string | URLSearchParams): InboxAddress {
  const p = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search
  const kind = (p.get('kind') ?? '').trim().toLowerCase()
  const sort = (p.get('sort') ?? '').trim()
  const pageSize = Number(p.get('pageSize'))
  const stars = list(p.get('stars')).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 5)
  const review = (p.get('review') ?? '').trim()
  const importFlag = (p.get('import') ?? '').trim().toLowerCase()
  const photosFlag = (p.get('photos') ?? '').trim().toLowerCase()
  return {
    query: {
      kind: (INBOX_KINDS as readonly string[]).includes(kind) ? (kind as InboxKind) : 'all',
      period: parseInboxPeriod(p.get('period')),
      statuses: codes(p.get('status'), INBOX_STATUSES) as InboxStatus[],
      channels: codes(p.get('channel')),
      markets: codes(p.get('market')),
      stars: [...new Set(stars)].sort((a, b) => a - b),
      moods: codes(p.get('mood'), INBOX_MOODS),
      themes: codes(p.get('theme')),
      owners: list(p.get('owner')).filter((o) => o.length <= 120),
      families: list(p.get('family')).filter((f) => ID.test(f)),
      needsReply: (p.get('reply') ?? '').trim().toLowerCase() === 'needed',
      product: ID.test((p.get('product') ?? '').trim()) ? (p.get('product') ?? '').trim() : null,
      photos: photosFlag === '1' || photosFlag === 'true',
      q: (p.get('q') ?? '').trim().slice(0, 200),
      sort: (INBOX_SORTS as readonly string[]).includes(sort) ? (sort as InboxSort) : DEFAULT_INBOX_SORT,
      page: positiveInt(p.get('page'), 1),
      pageSize: (INBOX_PAGE_SIZES as readonly number[]).includes(pageSize) ? (pageSize as InboxPageSize) : DEFAULT_INBOX_PAGE_SIZE,
    },
    openImport: importFlag === '1' || importFlag === 'true',
    review: ID.test(review) ? review : null,
  }
}

/** The query string for `q` ('' when everything is the default), in a fixed order. `review` keeps an open pop-up. */
export function serializeInboxQuery(q: InboxQuery, open: { review?: string | null } = {}): string {
  const p = new URLSearchParams()
  if (q.kind !== 'all') p.set('kind', q.kind)
  if (q.period !== DEFAULT_INBOX_PERIOD) p.set('period', q.period)
  if (q.statuses.length) p.set('status', q.statuses.join(','))
  if (q.channels.length) p.set('channel', q.channels.join(','))
  if (q.markets.length) p.set('market', q.markets.join(','))
  if (q.stars.length) p.set('stars', q.stars.join(','))
  if (q.moods.length) p.set('mood', q.moods.join(','))
  if (q.themes.length) p.set('theme', q.themes.join(','))
  if (q.owners.length) p.set('owner', q.owners.join(','))
  if (q.families.length) p.set('family', q.families.join(','))
  if (q.needsReply) p.set('reply', 'needed')
  if (q.product) p.set('product', q.product)
  if (q.photos) p.set('photos', '1')
  if (q.q) p.set('q', q.q)
  if (q.sort !== DEFAULT_INBOX_SORT) p.set('sort', q.sort)
  if (q.page > 1) p.set('page', String(q.page))
  if (q.pageSize !== DEFAULT_INBOX_PAGE_SIZE) p.set('pageSize', String(q.pageSize))
  if (open.review) p.set('review', open.review)
  const text = p.toString()
  return text ? `?${text}` : ''
}

/** The API's period, as it is: the API counts 12 months as calendar months, as the Overview does. */
export function apiPeriod(period: InboxPeriod): string {
  return period
}

/** `GET /api/reviews/inbox`'s parameters for one page of this query (the grid's sort wins when it has one). */
export function inboxApiParams(q: InboxQuery, page: number = q.page, sort: InboxSort = q.sort): LinkParams {
  return {
    kind: q.kind === 'all' ? null : q.kind,
    period: apiPeriod(q.period),
    status: q.statuses,
    channel: q.channels,
    market: q.markets,
    stars: q.stars,
    mood: q.moods,
    theme: q.themes,
    owner: q.owners,
    family: q.families,
    reply: q.needsReply ? 'needed' : null,
    product: q.product,
    photos: q.photos ? '1' : null,
    q: q.q || null,
    sort,
    page,
    pageSize: q.pageSize,
  }
}

/** A link to the Inbox with some filters (inside the Inbox: "other fit & sizing reviews"). Workspace-free. */
export function inboxPageHref(partial: Partial<InboxQuery> = {}): string {
  return `${INBOX_PATH}${serializeInboxQuery({ ...EMPTY_INBOX_QUERY, ...partial })}`
}

/** Everything that changes which rows show (not the page): a change starts again from page 1. */
export function querySignature(q: InboxQuery): string {
  const { page: _page, ...rest } = q
  return JSON.stringify(rest)
}

export function withKind(q: InboxQuery, kind: string): InboxQuery {
  const next = (INBOX_KINDS as readonly string[]).includes(kind) ? (kind as InboxKind) : q.kind
  return next === q.kind ? q : { ...q, kind: next, page: 1 }
}

export function withPeriod(q: InboxQuery, period: string): InboxQuery {
  const next = (INBOX_PERIODS as readonly string[]).includes(period) ? (period as InboxPeriod) : q.period
  return next === q.period ? q : { ...q, period: next, page: 1 }
}

/** A status tile: pressing it shows only that status; pressing it again (or the chip's ×) shows every status. */
export function toggleStatusTile(q: InboxQuery, status: InboxStatus | null): InboxQuery {
  const only = status != null && !(q.statuses.length === 1 && q.statuses[0] === status)
  return { ...q, statuses: only ? [status] : [], page: 1 }
}

/** The tile that is lit: the one status shown alone, else none. */
export function litTile(q: InboxQuery): InboxStatus | null {
  return q.statuses.length === 1 ? q.statuses[0] : null
}

/** One Filters field set to `values` (validated like the address). */
export function withFilter(q: InboxQuery, key: InboxFilterKey, values: readonly (string | number)[]): InboxQuery {
  const text = values.map(String).join(',')
  const parsed = parseInboxQuery(new URLSearchParams({
    [({ statuses: 'status', channels: 'channel', markets: 'market', stars: 'stars', moods: 'mood', themes: 'theme', owners: 'owner', families: 'family' } as const)[key]]: text,
  })).query
  return { ...q, [key]: parsed[key], page: 1 }
}

/** One value out of a Filters field (a chip's ×). */
export function withoutValue(q: InboxQuery, key: InboxFilterKey, value: string | number): InboxQuery {
  const current = q[key] as readonly (string | number)[]
  return { ...q, [key]: current.filter((v) => String(v) !== String(value)), page: 1 }
}

/** "Has photos" on or off. */
export function withPhotos(q: InboxQuery, on: boolean): InboxQuery {
  return on === q.photos ? q : { ...q, photos: on, page: 1 }
}

export function withSearch(q: InboxQuery, text: string): InboxQuery {
  const next = text.trim().slice(0, 200)
  return next === q.q ? q : { ...q, q: next, page: 1 }
}

export function withSort(q: InboxQuery, sort: string): InboxQuery {
  const next = (INBOX_SORTS as readonly string[]).includes(sort) ? (sort as InboxSort) : DEFAULT_INBOX_SORT
  return next === q.sort ? q : { ...q, sort: next, page: 1 }
}

export function withPage(q: InboxQuery, page: number, pageSize: number = q.pageSize): InboxQuery {
  const size = (INBOX_PAGE_SIZES as readonly number[]).includes(pageSize) ? (pageSize as InboxPageSize) : q.pageSize
  if (size !== q.pageSize) return { ...q, pageSize: size, page: 1 }
  const next = Number.isInteger(page) && page > 0 ? page : 1
  return next === q.page ? q : { ...q, page: next }
}

/** "Clear" (and "Clear all filters"): every filter, the search and the period go; the tab and the order stay. */
export function clearFilters(q: InboxQuery): InboxQuery {
  return { ...q, statuses: [], channels: [], markets: [], stars: [], moods: [], themes: [], owners: [], families: [], needsReply: false, product: null, photos: false, q: '', period: 'all', page: 1 }
}

/** One product's reviews, or every product (its chip's ×). */
export function withProduct(q: InboxQuery, product: string | null): InboxQuery {
  return q.product === product ? q : { ...q, product, page: 1 }
}

/** "Needs a reply" on or off (its chip's ×). */
export function withNeedsReply(q: InboxQuery, on: boolean): InboxQuery {
  return q.needsReply === on ? q : { ...q, needsReply: on, page: 1 }
}

/** How many Filters fields are on (the bar's "3 on"; the status tile counts as the Status field; "Has photos" is one). */
export function activeFilterCount(q: InboxQuery): number {
  return FILTER_KEYS.filter((key) => (q[key] as readonly unknown[]).length > 0).length + (q.photos ? 1 : 0)
}

/** Any filter, the search or a period narrows the rows: an empty answer is "nothing matches", not "no reviews". */
export function isFiltered(q: InboxQuery): boolean {
  return activeFilterCount(q) > 0 || q.q !== '' || q.period !== 'all' || q.needsReply || q.product != null
}

/** The grid's sort (its header click) as the API's: Received → postedAt, Stars → rating; none → the query's own. */
export function sortFromGrid(model: readonly { colId: string; sort: 'asc' | 'desc' }[], fallback: InboxSort): InboxSort {
  const first = model[0]
  if (!first) return fallback
  if (first.colId === 'received') return `postedAt:${first.sort}` as InboxSort
  if (first.colId === 'stars') return `rating:${first.sort}` as InboxSort
  return fallback
}

/** The grid's sort model for a query's order (what AG shows as sorted). */
export function gridSortOf(sort: InboxSort): { colId: string; sort: 'asc' | 'desc' } {
  const [field, dir] = sort.split(':') as ['postedAt' | 'rating', 'asc' | 'desc']
  return { colId: field === 'rating' ? 'stars' : 'received', sort: dir }
}


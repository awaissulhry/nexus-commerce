/**
 * Sheet publish parity, step 4 (docs/sheet-publish-parity/PLAN.md, item 4) — one publish history over every source.
 *
 * Sources (`publication-history/registry.ts`) each answer for their own rows; this core merges them newest first with
 * ONE keyset cursor, so a page never repeats or skips a run however many sources share a timestamp:
 *   order = startedAt DESC, then the source's fixed rank ASC, then the source's own id DESC.
 * Every source is asked for one row more than a page; the union then holds the next page's first row too, which is how
 * the core knows another page exists.
 *
 * Visibility: everything here runs in the request's business (row-level security), for anyone with the permission —
 * not only the person who sent a run. Reviews that were never sent are not runs and never appear.
 *
 * `coverage` names every source, so a history that does not (yet) show the old flat-file uploads says so instead of
 * looking complete (Owner D1 = A).
 */
import { HISTORY_RECENT_DAYS, HISTORY_SOURCES, HISTORY_STATES, HISTORY_WHAT, type HistoryCoverage, type HistoryPage, type HistoryQuery, type HistoryRun,
  type HistoryRunDetail, type HistorySource, type HistoryState, type HistoryTotals, type HistoryWhat } from '@nexus/shared/publication-history'
import prisma from '../../db.js'
import { HISTORY_ADAPTERS } from './publication-history/registry.js'
import { userNames } from './publication-history/users.js'
import { answersWhat, emptyTotals, type HistoryCursor, type HistoryFilters, type HistorySourceRow, type HistorySourceTotals, type PublicationHistoryAdapter } from './publication-history/types.js'

export const DEFAULT_PAGE = 50
export const MAX_PAGE = 100

const NOT_YET: Record<HistorySource, string> = {
  studio: 'Product sheet publishes are not shown yet.',
  'listing-action': 'Selling changes (pause, resume, end, relist, delete) are not shown here yet.',
  'amazon-flat-file': 'Uploads from the old Amazon flat file are not shown here yet.',
  'ebay-flat-file': 'Pushes from the old eBay flat file are not shown here yet.',
  photos: 'Photo publishes are not shown here yet.',
}

export class PublicationHistoryError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'invalid_history_query') { super(message) }
}

export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify([cursor.at, cursor.rank, cursor.id]), 'utf8').toString('base64url')
}

export function decodeCursor(value: string): HistoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (Array.isArray(parsed) && parsed.length === 3 && Number.isFinite(parsed[0]) && Number.isInteger(parsed[1]) && typeof parsed[2] === 'string' && parsed[2])
      return { at: parsed[0], rank: parsed[1], id: parsed[2] }
  } catch { /* fall through */ }
  throw new PublicationHistoryError('This page link is no longer valid. Start from the first page.')
}

const list = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]).flatMap(item => String(item).split(',')).map(item => item.trim()).filter(Boolean)

function time(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const ms = Date.parse(String(value))
  if (!Number.isFinite(ms)) throw new PublicationHistoryError(`"${name}" must be a date and time.`)
  return ms
}

/** The family (parent) of a product, so a history asked for any member shows the whole family's runs. */
export async function familyOf(productId: string): Promise<string> {
  const product = await prisma.product.findFirst({ where: { id: productId }, select: { id: true, parentId: true } })
  if (!product) throw new PublicationHistoryError('This product does not exist in this business.', 404, 'not_found')
  return product.parentId ?? product.id
}

/** Raw query values (from a URL) to the normalised filters, page size and sources. Throws a 400 on a wrong value. */
export async function parseHistoryQuery(raw: Record<string, unknown>): Promise<{ filters: HistoryFilters; sources: HistorySource[]; limit: number; cursor: HistoryCursor | null }> {
  const states = list(raw.state)
  const badState = states.find(state => !(HISTORY_STATES as readonly string[]).includes(state))
  if (badState) throw new PublicationHistoryError(`Unknown state "${badState}". Use ${HISTORY_STATES.join(', ')}.`)
  const sources = list(raw.source)
  const badSource = sources.find(source => !(HISTORY_SOURCES as readonly string[]).includes(source))
  if (badSource) throw new PublicationHistoryError(`Unknown source "${badSource}". Use ${HISTORY_SOURCES.join(', ')}.`)
  const what = list(raw.what)
  const badWhat = what.find(group => !(HISTORY_WHAT as readonly string[]).includes(group))
  if (badWhat) throw new PublicationHistoryError(`Unknown "what" value "${badWhat}". Use ${HISTORY_WHAT.join(', ')}.`)
  const limitRaw = raw.limit === undefined || raw.limit === '' ? DEFAULT_PAGE : Number(raw.limit)
  if (!Number.isInteger(limitRaw) || limitRaw < 1) throw new PublicationHistoryError('"limit" must be a whole number of at least 1.')
  const from = time(raw.from, 'from')
  const to = time(raw.to, 'to')
  if (from !== undefined && to !== undefined && from > to) throw new PublicationHistoryError('"from" must not be after "to".')
  const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
  const checkedRaw = text(raw.checked)
  if (checkedRaw !== undefined && checkedRaw !== 'true' && checkedRaw !== 'false') throw new PublicationHistoryError('"checked" must be true or false.')
  const productId = text(raw.productId)
  const filters: HistoryFilters = {
    channel: text(raw.channel)?.toUpperCase(),
    marketplace: text(raw.marketplace ?? raw.market)?.toUpperCase(),
    accountId: text(raw.accountId),
    states: states as HistoryState[],
    familyId: productId ? await familyOf(productId) : undefined,
    userId: text(raw.userId),
    from, to,
    q: text(raw.q)?.slice(0, 200),
    ...(checkedRaw !== undefined ? { checked: checkedRaw === 'true' } : {}),
    ...(what.length ? { what: [...new Set(what)] as HistoryWhat[] } : {}),
  }
  return {
    filters,
    sources: sources.length ? sources as HistorySource[] : [...HISTORY_SOURCES],
    limit: Math.min(limitRaw, MAX_PAGE),
    cursor: text(raw.cursor) ? decodeCursor(text(raw.cursor)!) : null,
  }
}

/** Newest first: sortAt DESC, rank ASC, then each source's own order (already id DESC, kept as returned). */
function merge(batches: Array<{ adapter: PublicationHistoryAdapter; rows: HistorySourceRow[] }>) {
  return batches.flatMap(({ adapter, rows }) => rows.map((row, index) => ({ row, rank: adapter.rank, index })))
    .sort((a, b) => b.row.sortAt - a.row.sortAt || a.rank - b.rank || a.index - b.index)
}

async function withNames(rows: HistorySourceRow[]): Promise<HistoryRun[]> {
  const names = await userNames(rows.flatMap(row => [row.userId, row.checkedByUserId]))
  return rows.map(({ sortAt: _sortAt, localId: _localId, checkedByUserId, ...run }) => ({
    ...run,
    userName: run.userId ? names.get(run.userId) ?? null : null,
    checkedBy: checkedByUserId ? names.get(checkedByUserId) ?? null : null,
  }))
}

export async function coverageOf(adapters: PublicationHistoryAdapter[] = HISTORY_ADAPTERS): Promise<HistoryCoverage[]> {
  const known = await Promise.all(adapters.map(adapter => adapter.coverage()))
  return HISTORY_SOURCES.map(source => known.find(item => item.source === source)
    ?? { source, included: false, since: null, note: NOT_YET[source] })
}

export async function listPublicationHistory(query: { filters: HistoryFilters; sources: HistorySource[]; limit: number; cursor: HistoryCursor | null },
  options: { adapters?: PublicationHistoryAdapter[]; now?: Date } = {}): Promise<HistoryPage> {
  const adapters = (options.adapters ?? HISTORY_ADAPTERS).filter(adapter => query.sources.includes(adapter.source) && answersWhat(adapter, query.filters))
  const now = options.now ?? new Date()
  const ask = query.limit + 1
  const batches = await Promise.all(adapters.map(async adapter => ({ adapter, rows: await adapter.list({ filters: query.filters, cursor: query.cursor, limit: ask, now }) })))
  const merged = merge(batches)
  const page = merged.slice(0, query.limit)
  const last = page[page.length - 1]
  const [runs, coverage] = await Promise.all([withNames(page.map(item => item.row)), coverageOf(options.adapters ?? HISTORY_ADAPTERS)])
  return {
    runs,
    nextCursor: merged.length > query.limit && last ? encodeCursor({ at: last.row.sortAt, rank: last.rank, id: last.row.localId }) : null,
    coverage,
  }
}

const DAY_MS = 24 * 60 * 60_000
/** A count fallback for a source without `count`: page its list to the end (every state). */
const FALLBACK_PAGE = 500

async function sourceTotals(adapter: PublicationHistoryAdapter, filters: HistoryFilters, now: Date, doneSince: number): Promise<HistorySourceTotals> {
  if (adapter.count) return adapter.count({ filters, now, doneSince })
  const totals = emptyTotals()
  let cursor: HistoryCursor | null = null
  for (;;) {
    const rows = await adapter.list({ filters, cursor, limit: FALLBACK_PAGE, now })
    for (const row of rows) {
      totals.byState[row.state] += 1
      if (row.checkedAt) totals.checked += 1
      if ((row.state === 'succeeded' || row.state === 'partial' || row.state === 'failed') && row.sortAt >= doneSince) totals.done += 1
    }
    if (rows.length < FALLBACK_PAGE) return totals
    const last = rows[rows.length - 1]
    cursor = { at: last.sortAt, rank: adapter.rank, id: last.localId }
  }
}

/**
 * Exact counts for the same filters as `listPublicationHistory` — every state (the query's `state` and `checked` are
 * ignored), no paging. Each number equals the length of the list its filter tile opens (see `HistoryTotals`).
 */
export async function countPublicationHistory(query: { filters: HistoryFilters; sources: HistorySource[] },
  options: { adapters?: PublicationHistoryAdapter[]; now?: Date } = {}): Promise<HistoryTotals> {
  const adapters = (options.adapters ?? HISTORY_ADAPTERS).filter(adapter => query.sources.includes(adapter.source) && answersWhat(adapter, query.filters))
  const now = options.now ?? new Date()
  const doneSince = now.getTime() - HISTORY_RECENT_DAYS * DAY_MS
  const filters: HistoryFilters = { ...query.filters, states: [], checked: undefined }
  const parts = await Promise.all(adapters.map(adapter => sourceTotals(adapter, filters, now, doneSince)))
  const byState = Object.fromEntries(HISTORY_STATES.map(state => [state, parts.reduce((sum, part) => sum + part.byState[state], 0)])) as Record<HistoryState, number>
  const checked = parts.reduce((sum, part) => sum + part.checked, 0)
  return {
    total: HISTORY_STATES.reduce((sum, state) => sum + byState[state], 0),
    byState,
    needsAttention: byState.failed + byState.partial + byState.needs_check - checked,
    inProgress: byState.in_progress,
    doneLast7Days: parts.reduce((sum, part) => sum + part.done, 0),
    recentSince: new Date(doneSince).toISOString(),
    checked,
  }
}

/** A run id names its source: `<source>:<id>` for every source but the product sheet, whose runs keep their own id. */
export function sourceOfRunId(runId: string, adapters: PublicationHistoryAdapter[] = HISTORY_ADAPTERS): { adapter: PublicationHistoryAdapter; localId: string } {
  const colon = runId.indexOf(':')
  const prefix = colon > 0 ? runId.slice(0, colon) : null
  const source: HistorySource = prefix && (HISTORY_SOURCES as readonly string[]).includes(prefix) ? prefix as HistorySource : 'studio'
  const localId = source === 'studio' ? runId : runId.slice(colon + 1)
  const adapter = adapters.find(item => item.source === source)
  if (!adapter || !localId) throw new PublicationHistoryError('This publish was not found.', 404, 'not_found')
  return { adapter, localId }
}

export async function publicationRunDetail(runId: string, options: { adapters?: PublicationHistoryAdapter[]; now?: Date } = {}): Promise<HistoryRunDetail> {
  const { adapter, localId } = sourceOfRunId(runId, options.adapters)
  const detail = await adapter.detail(localId, options.now ?? new Date())
  if (!detail) throw new PublicationHistoryError('This publish was not found.', 404, 'not_found')
  return detail
}

export async function publicationRunRequest(runId: string, listingId: string, options: { adapters?: PublicationHistoryAdapter[] } = {}) {
  const { adapter, localId } = sourceOfRunId(runId, options.adapters)
  const found = adapter.request ? await adapter.request(localId, listingId) : null
  if (!found) throw new PublicationHistoryError('No request is kept for this listing in this publish.', 404, 'not_found')
  return { runId, listingId, ...found }
}

'use client'

/**
 * Publish history — the LIST's data (sheet publish parity, step 4; docs/sheet-publish-parity/PLAN.md, item 4).
 *
 * One list for two places: a product's publishes (the studio's Activity tab) and the business's publishes
 * (/listings/publish-status). The scope decides what is read; the filters, the paging and the live refresh are the
 * same. The pure rules (query, merge, view) are exported so the tests read the same code the page runs.
 *
 * Paging is the API's keyset cursor, appended page by page ("Show more"). Nothing sorts on the client: the server
 * orders newest first, and a client sort would only sort the part that happens to be loaded.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HistoryCoverage, HistoryPage, HistoryRun, HistorySource, HistoryState, HistoryTotals } from '@nexus/shared/publication-history'
import { useInvalidationChannel, type InvalidationEvent } from '@/lib/sync/invalidation-channel'
import { accountDisplayName, channelDisplayName } from '@/design-system/lib'
import { historyRequest } from './runActions'

export type PublishRunsScope = { scope: 'business' } | { scope: 'product'; productId: string }

export const PAGE_SIZE = 50
/** How often a list with a run still in progress looks again, while the tab is visible. Events usually come first. */
export const IN_PROGRESS_POLL_MS = 15_000

export type StartedPreset = 'any' | 'today' | '7d' | '30d' | '90d' | 'custom'

export interface RunFilters {
  states: HistoryState[]
  channel: string
  marketplace: string
  accountId: string
  sources: HistorySource[]
  started: StartedPreset
  /** Only read when `started === 'custom'`. Whole days, in the viewer's zone. */
  range: { start: Date; end: Date } | null
  /**
   * ISO. The server's own start of "the last 7 days" (`HistoryTotals.recentSince`), captured when the "Done in the last
   * 7 days" tile is pressed, so that tile's list uses exactly the window its count used — not this browser's clock.
   * Only read when `started === '7d'`; absent = this browser's now − 7 days.
   */
  since?: string
  by: 'anyone' | 'me'
  q: string
}

export const EMPTY_FILTERS: RunFilters = {
  states: [], channel: '', marketplace: '', accountId: '', sources: [], started: 'any', range: null, by: 'anyone', q: '',
}

/** How many filters differ from the empty set (the panel's Clear button and the "no match" wording read it). */
export function activeFilterCount(f: RunFilters): number {
  return [f.states.length > 0, !!f.channel, !!f.marketplace, !!f.accountId, f.sources.length > 0, f.started !== 'any',
    f.by === 'me', !!f.q.trim()].filter(Boolean).length
}

/** One filter that is on, as a removable token: its words, and what removing it resets. */
export interface FilterToken { key: 'states' | 'channel' | 'marketplace' | 'accountId' | 'sources' | 'started' | 'by' | 'q'; label: string; clear: Partial<RunFilters> }

/** How each filter's value reads. The page passes the same option lists its controls show. */
export interface FilterTokenWords {
  state: (state: HistoryState) => string
  channel: (value: string) => string
  market: (value: string) => string
  account: (value: string) => string
  source: (source: HistorySource) => string
  started: (preset: StartedPreset, range: RunFilters['range']) => string
}

/**
 * The filters that are on, in the panel's order, each removable on its own. With the panel folded these tokens are
 * what tells the reader why the list is narrower than everything — a folded panel must never hide an active filter.
 */
export function activeFilterTokens(f: RunFilters, words: FilterTokenWords): FilterToken[] {
  const tokens: FilterToken[] = []
  if (f.states.length) tokens.push({ key: 'states', label: `Result: ${f.states.map(words.state).join(', ')}`, clear: { states: [] } })
  if (f.channel) tokens.push({ key: 'channel', label: `Channel: ${words.channel(f.channel)}`, clear: { channel: '', marketplace: '', accountId: '' } })
  if (f.marketplace) tokens.push({ key: 'marketplace', label: `Market: ${words.market(f.marketplace)}`, clear: { marketplace: '' } })
  if (f.accountId) tokens.push({ key: 'accountId', label: `Account: ${words.account(f.accountId)}`, clear: { accountId: '' } })
  if (f.sources.length) tokens.push({ key: 'sources', label: `Source: ${f.sources.map(words.source).join(', ')}`, clear: { sources: [] } })
  if (f.started !== 'any') tokens.push({ key: 'started', label: `Started: ${words.started(f.started, f.range)}`, clear: { started: 'any', range: null, since: undefined } })
  if (f.by === 'me') tokens.push({ key: 'by', label: 'By: Me', clear: { by: 'anyone' } })
  const q = f.q.trim()
  if (q) tokens.push({ key: 'q', label: `Search: “${q}”`, clear: { q: '' } })
  return tokens
}

const DAY = 86_400_000
const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d }
const endOfDay = (d: Date) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x }

/** The `from` / `to` a "Started" choice means at `now`. */
export function startedWindow(f: Pick<RunFilters, 'started' | 'range' | 'since'>, now: number): { from?: string; to?: string } {
  switch (f.started) {
    case 'today': return { from: startOfDay(now).toISOString() }
    case '7d': return { from: f.since ?? new Date(now - 7 * DAY).toISOString() }
    case '30d': return { from: new Date(now - 30 * DAY).toISOString() }
    case '90d': return { from: new Date(now - 90 * DAY).toISOString() }
    case 'custom':
      return f.range ? { from: startOfDay(f.range.start.getTime()).toISOString(), to: endOfDay(f.range.end).toISOString() } : {}
    default: return {}
  }
}

/** The list request: `/api/publications?…` (business) or `/api/products/:id/publications?…` (the product's family). */
export function historyPath(scope: PublishRunsScope, f: RunFilters, opts: { cursor?: string | null; limit?: number; now: number }): string {
  const params = new URLSearchParams()
  if (f.states.length) params.set('state', f.states.join(','))
  if (f.sources.length) params.set('source', f.sources.join(','))
  if (f.channel) params.set('channel', f.channel)
  if (f.marketplace) params.set('marketplace', f.marketplace)
  if (f.accountId) params.set('accountId', f.accountId)
  if (f.by === 'me') params.set('by', 'me')
  const q = f.q.trim()
  if (q) params.set('q', q)
  const { from, to } = startedWindow(f, opts.now)
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  // The attention tile's list leaves out runs a person marked as checked — on the server, so paging stays exact.
  if (attentionOnly(f)) params.set('checked', 'false')
  params.set('limit', String(opts.limit ?? PAGE_SIZE))
  if (opts.cursor) params.set('cursor', opts.cursor)
  const base = scope.scope === 'product' ? `/api/products/${encodeURIComponent(scope.productId)}/publications` : '/api/publications'
  return `${base}?${params.toString()}`
}

/** A further page joins the end. A run already shown (it moved while paging) keeps its first place. */
export function appendPage(current: readonly HistoryRun[], next: readonly HistoryRun[]): HistoryRun[] {
  const seen = new Set(current.map(run => run.id))
  return [...current, ...next.filter(run => !seen.has(run.id))]
}

/**
 * A fresh first page over what is loaded: a run already shown is replaced IN PLACE (its status moved), a run not
 * shown yet goes on top in the server's order (it is newer). Rows below the first page stay, so the reader keeps their
 * place, and an open drawer keeps its run.
 */
export function mergeFresh(current: readonly HistoryRun[], fresh: readonly HistoryRun[]): HistoryRun[] {
  const byId = new Map(fresh.map(run => [run.id, run]))
  const known = new Set(current.map(run => run.id))
  const added = fresh.filter(run => !known.has(run.id))
  return [...added, ...current.map(run => byId.get(run.id) ?? run)]
}

export type ListView = 'loading' | 'error' | 'empty' | 'no-match' | 'rows'

/**
 * What the list area shows. A failed read is an error, never an empty list — an empty list would say "nothing was
 * published", which the page does not know.
 */
export function listView(s: { loaded: boolean; error: string | null; rows: number; filtered: boolean }): ListView {
  if (s.error && s.rows === 0) return 'error'
  if (!s.loaded) return 'loading'
  if (s.rows === 0) return s.filtered ? 'no-match' : 'empty'
  return 'rows'
}

/** Runs that finished since the last look: a run that was in progress and is now not. Each is announced once. */
export function newlyFinished(before: readonly HistoryRun[], after: readonly HistoryRun[]): HistoryRun[] {
  const wasRunning = new Set(before.filter(run => run.state === 'in_progress').map(run => run.id))
  return after.filter(run => wasRunning.has(run.id) && run.state !== 'in_progress')
}

/** Does a `publication.status_changed` concern this list? A business list: always. A product list: its family. */
export function eventConcerns(scope: PublishRunsScope, event: Pick<InvalidationEvent, 'meta'>, rows: readonly HistoryRun[]): boolean {
  if (scope.scope === 'business') return true
  const family = typeof event.meta?.productId === 'string' ? event.meta.productId : null
  if (!family) return true
  return family === scope.productId || rows.some(run => run.productId === family)
}

export interface PublishRunsState {
  rows: HistoryRun[]
  coverage: HistoryCoverage[]
  /** The first page has answered at least once. */
  loaded: boolean
  /** A further page is being read. */
  loadingMore: boolean
  /** The last read's failure, in plain words; null once a read succeeds. */
  error: string | null
  hasMore: boolean
  /** Runs that finished since the previous refresh (for the live region). */
  finished: HistoryRun[]
  loadMore: () => void
  /** From the top: the rows are read again (after an error). */
  reload: () => void
  /** Quietly, in place: the first page is merged over what is shown (a run changed in its drawer). */
  refresh: () => void
}

/** A failed read in plain words: a dropped connection is not the server's message. */
export function readErrorText(err: unknown, fallback: string): string {
  if (err instanceof TypeError) return 'The server could not be reached. Check the connection and try again.'
  return err instanceof Error && err.message ? err.message : fallback
}

/** The list for one scope and one set of filters. Re-reads from the top when either changes. */
export function usePublishRuns(scope: PublishRunsScope, filters: RunFilters): PublishRunsState {
  const [rows, setRows] = useState<HistoryRun[]>([])
  const [coverage, setCoverage] = useState<HistoryCoverage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [finished, setFinished] = useState<HistoryRun[]>([])
  const rowsRef = useRef(rows); rowsRef.current = rows
  const scopeKey = scope.scope === 'product' ? `product:${scope.productId}` : 'business'
  const filtersKey = JSON.stringify(filters)
  // The request a refresh repeats; rebuilt only when the scope or the filters change.
  const pathFor = useCallback((next: string | null, now: number) => historyPath(scope, filters, { cursor: next, now }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the keys stand for scope and filters
    [scopeKey, filtersKey])
  const generation = useRef(0)

  // From the top: the scope or the filters changed, or the reader asked to try again.
  const [reloadTick, setReloadTick] = useState(0)
  useEffect(() => {
    const gen = ++generation.current
    const controller = new AbortController()
    setLoaded(false); setError(null); setRows([]); setCursor(null); setFinished([])
    historyRequest<HistoryPage>(pathFor(null, Date.now()), { signal: controller.signal })
      .then(page => {
        if (gen !== generation.current) return
        setRows(page.runs); setCoverage(page.coverage); setCursor(page.nextCursor); setLoaded(true)
      })
      .catch(err => {
        if (controller.signal.aborted || gen !== generation.current) return
        setError(readErrorText(err, 'Publish history could not be loaded.')); setLoaded(true)
      })
    return () => controller.abort()
  }, [pathFor, reloadTick])

  const loadMore = useCallback(() => {
    if (!cursor || loadingMore) return
    const gen = generation.current
    setLoadingMore(true)
    historyRequest<HistoryPage>(pathFor(cursor, Date.now()))
      .then(page => {
        if (gen !== generation.current) return
        setRows(prior => appendPage(prior, page.runs)); setCursor(page.nextCursor); setError(null)
      })
      .catch(err => { if (gen === generation.current) setError(readErrorText(err, 'More publishes could not be loaded.')) })
      .finally(() => { if (gen === generation.current) setLoadingMore(false) })
  }, [cursor, loadingMore, pathFor])

  // A quiet refresh of the first page, merged in place: keeps the reader's scroll, paging and open drawer.
  const refreshing = useRef(false)
  const refresh = useCallback(() => {
    if (refreshing.current) return
    refreshing.current = true
    const gen = generation.current
    historyRequest<HistoryPage>(pathFor(null, Date.now()))
      .then(page => {
        if (gen !== generation.current) return
        const before = rowsRef.current
        const after = mergeFresh(before, page.runs)
        setRows(after); setCoverage(page.coverage)
        const done = newlyFinished(before, after)
        if (done.length) setFinished(done)
      })
      .catch(() => { /* a background refresh that fails leaves the shown rows as they were; the next event retries */ })
      .finally(() => { refreshing.current = false })
  }, [pathFor])

  useInvalidationChannel('publication.status_changed', event => {
    if (eventConcerns(scope, event, rowsRef.current)) refresh()
  })

  // While a shown run is still in progress, look again every 15 s — only while the tab is visible.
  const anyRunning = useMemo(() => rows.some(run => run.state === 'in_progress'), [rows])
  useEffect(() => {
    if (!anyRunning) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh()
    }, IN_PROGRESS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [anyRunning, refresh])

  const reload = useCallback(() => setReloadTick(n => n + 1), [])
  return { rows, coverage, loaded, loadingMore, error, hasMore: !!cursor, finished, loadMore, reload, refresh }
}

// ── The filter tiles ─────────────────────────────────────────────────────────────────────────────────────────────

export type TileKey = 'attention' | 'progress' | 'done'

export interface RunTile {
  key: TileKey
  label: string
  hint: string
  states: HistoryState[]
  started: StartedPreset
  accent: string
}

export const RUN_TILES: readonly RunTile[] = [
  { key: 'attention', label: 'Needs attention', hint: 'failed, partly failed or result unknown, not yet checked', states: ['failed', 'partial', 'needs_check'], started: 'any', accent: 'var(--nds-danger)' },
  { key: 'progress', label: 'In progress', hint: 'the channel is still working', states: ['in_progress'], started: 'any', accent: 'var(--nds-info)' },
  { key: 'done', label: 'Done in the last 7 days', hint: 'finished with a result', states: ['succeeded', 'partial', 'failed'], started: '7d', accent: 'var(--nds-success)' },
]

/** A tile reads as pressed when the filters say exactly what the tile says (and the started window matches). */
export function tileActive(tile: RunTile, f: Pick<RunFilters, 'states' | 'started'>): boolean {
  return f.started === tile.started && f.states.length === tile.states.length && tile.states.every(state => f.states.includes(state))
}

/** Pressing a tile applies its states and window; pressing the pressed tile clears them. Other filters stay. */
export function applyTile(tile: RunTile, f: RunFilters, recentSince?: string | null): RunFilters {
  return tileActive(tile, f)
    ? { ...f, states: [], started: 'any', range: null, since: undefined }
    : { ...f, states: [...tile.states], started: tile.started, range: null, since: tile.started === '7d' && recentSince ? recentSince : undefined }
}

/**
 * A run a person marked as checked (D3) keeps its `needs_check` state — Nexus never invents its result — but nobody
 * has to look at it again, so it does not "need attention". The attention tile asks the server for `checked=false`
 * (see `historyPath`), and its count is the server's `needsAttention`, so the number and the rows agree.
 */
export function attentionOnly(f: Pick<RunFilters, 'states' | 'started'>): boolean {
  return tileActive(RUN_TILES.find(tile => tile.key === 'attention')!, f)
}

/**
 * The exact counts the tiles show: `…/publications/counts` with the page's OTHER filters (channel, market, account,
 * source, person, search), because pressing a tile keeps those. The tile's own result and time window are the
 * server's: `needsAttention` (checked runs left out), `inProgress`, `doneLast7Days`.
 */
export function countsPath(scope: PublishRunsScope, f: RunFilters, now: number): string {
  const [base, query] = historyPath(scope, { ...f, states: [], started: 'any', range: null }, { now }).split('?')
  const params = new URLSearchParams(query)
  params.delete('limit')
  const rest = params.toString()
  return `${base}/counts${rest ? `?${rest}` : ''}`
}

/** A tile's number from the server's totals. */
export function tileCount(totals: Pick<HistoryTotals, 'needsAttention' | 'inProgress' | 'doneLast7Days'>, key: TileKey): string {
  const n = key === 'attention' ? totals.needsAttention : key === 'progress' ? totals.inProgress : totals.doneLast7Days
  return n.toLocaleString('en-GB')
}

/** One exact count read for the three tiles, refreshed with the list and on every publish event. */
export interface RunTileCounts extends Record<TileKey, string | null> {
  /** The server's start of "the last 7 days"; the done tile's list uses it. null until read. */
  recentSince: string | null
}

export function useRunTileCounts(scope: PublishRunsScope, filters: RunFilters, refreshKey: unknown): RunTileCounts {
  const [counts, setCounts] = useState<RunTileCounts>({ attention: null, progress: null, done: null, recentSince: null })
  const scopeKey = scope.scope === 'product' ? `product:${scope.productId}` : 'business'
  // Only the filters the tiles keep change the counts; a tile press (result, time) does not re-read them.
  const otherKey = JSON.stringify({ ...filters, states: [], started: 'any', range: null, since: undefined })
  const [tick, setTick] = useState(0)
  useInvalidationChannel('publication.status_changed', () => setTick(n => n + 1))
  useEffect(() => {
    const controller = new AbortController()
    historyRequest<HistoryTotals>(countsPath(scope, filters, Date.now()), { signal: controller.signal })
      .then(totals => setCounts({ attention: tileCount(totals, 'attention'), progress: tileCount(totals, 'progress'), done: tileCount(totals, 'done'), recentSince: totals.recentSince }))
      .catch(() => { if (!controller.signal.aborted) setCounts({ attention: '—', progress: '—', done: '—', recentSince: null }) })
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scopeKey and otherKey stand for scope and filters
  }, [scopeKey, otherKey, tick, refreshKey])
  return counts
}

// ── The filter choices ───────────────────────────────────────────────────────────────────────────────────────────

export interface RunFilterOptions {
  channels: Array<{ value: string; label: string }>
  /** The chosen channel's markets (every channel's when none is chosen), by code. */
  markets: Array<{ value: string; label: string }>
  accounts: Array<{ value: string; label: string; channel: string }>
}

interface AccountRow { id: string; channel: string; label: string; labelSource?: string; labelIsPlaceholder?: boolean }
interface MarketRow { channel: string; code: string; name: string }

/** Selling channels only: the advertising connection publishes nothing. */
const PUBLISHING_CHANNEL = (channel: string) => channel !== 'AMAZON_ADS'

/** The choices, from the business's own accounts and markets. Pure, so the tests read the same rule. */
export function filterOptionsFrom(accounts: readonly AccountRow[], markets: readonly MarketRow[], channel: string): RunFilterOptions {
  const selling = accounts.filter(a => PUBLISHING_CHANNEL(a.channel))
  const channels = [...new Set(selling.map(a => a.channel))].sort()
    .map(value => ({ value, label: channelDisplayName(value) }))
  const codes = new Map<string, string>()
  for (const m of markets) {
    if (!PUBLISHING_CHANNEL(m.channel) || (channel && m.channel !== channel) || codes.has(m.code)) continue
    codes.set(m.code, m.code === 'GLOBAL' ? 'Global (one store)' : `${m.code} · ${m.name}`)
  }
  return {
    channels,
    markets: [...codes].sort(([a], [b]) => a.localeCompare(b)).map(([value, label]) => ({ value, label })),
    accounts: selling.map(a => ({ value: a.id, channel: a.channel, label: `${channelDisplayName(a.channel)} · ${accountDisplayName(a)}` })),
  }
}

export function useRunFilterOptions(channel: string): RunFilterOptions {
  const [accounts, setAccounts] = useState<AccountRow[]>([])
  const [markets, setMarkets] = useState<MarketRow[]>([])
  useEffect(() => {
    const controller = new AbortController()
    historyRequest<{ accounts?: AccountRow[] }>('/api/accounts', { signal: controller.signal })
      .then(d => setAccounts(Array.isArray(d.accounts) ? d.accounts : []))
      .catch(() => { /* no list: the Account filter offers "All accounts" only */ })
    historyRequest<MarketRow[]>('/api/marketplaces', { signal: controller.signal })
      .then(d => setMarkets(Array.isArray(d) ? d : []))
      .catch(() => { /* no list: the Market filter offers "All markets" only */ })
    return () => controller.abort()
  }, [])
  return useMemo(() => filterOptionsFrom(accounts, markets, channel), [accounts, markets, channel])
}

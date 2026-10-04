'use client'

/**
 * Publish history — the LIST (sheet publish parity, step 4; docs/sheet-publish-parity/PLAN.md, item 4).
 *
 * One component for both places, chosen by `scope`: a product's publishes (the studio's Activity tab, the drawer
 * docked beside the list) and the business's publishes (/listings/publish-status, the drawer as a dialog). The scope
 * decides the columns and the words; nothing else is passed in.
 *
 * Grid choice: the DS `DataGrid` with the API's keyset cursor appended page by page ("Show more"), not AG's
 * server-side row model. Filters and order are the server's; the list never sorts on the client (that would sort only
 * the loaded part); and the server-side model would need its own data source for a list that is read 50 rows at a
 * time and refreshed in place by events.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Search, SlidersHorizontal } from 'lucide-react'
import type { HistoryRun, HistorySource, HistoryState } from '@nexus/shared/publication-history'
import { AsOf, Banner, DateRangePicker, EmptyState, Listbox, MetricStrip, MultiSelect, type ListboxOption, type Metric } from '@/design-system/components'
import { FilterField, FilterPanel, GridToolbar } from '@/design-system/patterns'
import { Button, FilterChip, Input, Skeleton, TokenChip, ToolbarButton } from '@/design-system/primitives'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { PublishStatusPill } from '@/design-system/grid'
import { DOCK_WIDTH, PublishRunDrawer } from './PublishRunDrawer'
import { parseHistoryDeepLink, runChangeLabel, runDestination, runStatusMeta, SOURCE_LABEL } from './runActions'
import {
  accountLine, byText, checkedLine, durationText, finishedAnnouncement, productText, resultsText, rowAriaLabel, runColumnKeys,
  type RunColumnKey,
} from './runColumns'
import {
  EMPTY_FILTERS, PAGE_SIZE, RUN_TILES, activeFilterCount, activeFilterTokens, applyTile, listView, tileActive, usePublishRuns,
  useRunFilterOptions, useRunTileCounts, type FilterToken, type PublishRunsScope, type RunFilters, type StartedPreset,
} from './usePublishRuns'
import styles from './publishRuns.module.css'

export type PublishRunsProps = PublishRunsScope

const NARROW_PX = 640
/** Below this the DS dock is the whole working area (components.css `.nds-drawer-dock` @media 719px): no room to keep. */
const DOCK_FULL_WIDTH_BELOW = 720
/** Air between the list's right edge and the docked panel. */
const DOCK_GAP = 16

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${NARROW_PX - 1}px)`)
    const update = () => setNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return narrow
}

const STATE_OPTIONS: ReadonlyArray<{ value: HistoryState; label: string }> = [
  { value: 'in_progress', label: 'In progress' },
  { value: 'succeeded', label: 'Accepted or verified' },
  { value: 'partial', label: 'Partly failed' },
  { value: 'failed', label: 'Failed' },
  { value: 'needs_check', label: 'Result unknown' },
]

const STARTED_OPTIONS: ReadonlyArray<{ value: StartedPreset; label: string }> = [
  { value: 'any', label: 'Any time' },
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'custom', label: 'Choose dates…' },
]

const SOURCE_OPTIONS = (Object.keys(SOURCE_LABEL) as HistorySource[]).map(value => ({ value, label: SOURCE_LABEL[value] }))

const COPY = {
  business: {
    ariaLabel: 'Publish history of this business',
    emptyTitle: 'No publishes yet',
    emptyText: 'Each publish from Nexus — the product sheet, the old flat-file pages and photo uploads — appears here with its result.',
  },
  product: {
    ariaLabel: 'Publish history of this product',
    emptyTitle: 'No publishes yet',
    emptyText: 'Each time you publish this product, the result for every variation appears here.',
  },
} as const

const QUERY_DELAY_MS = 300

const DAY_WORDS = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const startedWords = (preset: StartedPreset, range: RunFilters['range']) => preset === 'custom' && range
  ? `${DAY_WORDS.format(range.start)} – ${DAY_WORDS.format(range.end)}`
  : STARTED_OPTIONS.find(o => o.value === preset)?.label ?? preset

/**
 * Room for the docked detail. The DS dock is a fixed slide-over (layout-v2 §5) that covers what lies under it; the
 * studio sheet accepts that on purpose, but a LIST whose open row must stay in view does not. So while a run is docked
 * the list keeps the panel's width free on its right and reflows into the rest, as if the two sat in one flex row.
 * Measured, not assumed: the room already right of the list (page padding) is subtracted.
 */
function useDockReserve(docked: boolean) {
  const ref = useRef<HTMLDivElement>(null)
  const [reserve, setReserve] = useState(0)
  useLayoutEffect(() => {
    if (!docked) { setReserve(0); return }
    const measure = () => {
      const root = ref.current
      if (!root || window.innerWidth < DOCK_FULL_WIDTH_BELOW) { setReserve(0); return }
      const roomRight = window.innerWidth - root.getBoundingClientRect().right
      setReserve(Math.max(0, Math.round(DOCK_WIDTH + DOCK_GAP - roomRight)))
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [docked])
  return { ref, reserve }
}

/** The run in the URL (`?run=<id>`), written with every other key kept — the studio's own keys stay. */
function writeRunParam(runId: string | null) {
  const url = new URL(window.location.href)
  if (runId) url.searchParams.set('run', runId)
  else { url.searchParams.delete('run'); url.searchParams.delete('sku') }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

export function PublishRuns(props: PublishRunsProps) {
  const scope: PublishRunsScope = props.scope === 'product' ? { scope: 'product', productId: props.productId } : { scope: 'business' }
  const copy = COPY[scope.scope]
  const narrow = useNarrow()

  const [filters, setFilters] = useState<RunFilters>(EMPTY_FILTERS)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  // The search box answers at once; the list follows 300 ms after the last key.
  const [query, setQuery] = useState('')
  useEffect(() => {
    const timer = window.setTimeout(() => setFilters(f => (f.q === query ? f : { ...f, q: query })), QUERY_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [query])

  const list = usePublishRuns(scope, filters)
  const rows = list.rows
  const tiles = useRunTileCounts(scope, filters, list.finished)
  const options = useRunFilterOptions(filters.channel)

  // ── The drawer ──────────────────────────────────────────────────────────────────────────────────────────────
  const [openRunId, setOpenRunId] = useState<string | null>(null)
  const dock = useDockReserve(scope.scope === 'product' && openRunId != null)
  const returnFocus = useRef<HTMLElement | null>(null)
  useEffect(() => { setOpenRunId(parseHistoryDeepLink(window.location.search).run) }, [])
  const openRun = useCallback((runId: string) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpenRunId(runId)
    writeRunParam(runId)
  }, [])
  const closeRun = useCallback(() => {
    setOpenRunId(null)
    writeRunParam(null)
    // Back to the row the reader came from (AG keeps the cell focusable while the row is rendered).
    const target = returnFocus.current
    returnFocus.current = null
    if (target && target.isConnected) window.requestAnimationFrame(() => target.focus())
  }, [])

  // ── One polite sentence per run that finished while the list was open ──────────────────────────────────────
  const [announcement, setAnnouncement] = useState('')
  const announced = useRef(new Set<string>())
  useEffect(() => {
    const fresh = list.finished.filter(run => !announced.current.has(run.id))
    if (!fresh.length) return
    for (const run of fresh) announced.current.add(run.id)
    setAnnouncement(fresh.map(finishedAnnouncement).join(' '))
  }, [list.finished])

  // ── Columns ─────────────────────────────────────────────────────────────────────────────────────────────────
  const columns = useMemo<Array<Column<HistoryRun>>>(() => {
    const all: Record<RunColumnKey, Column<HistoryRun>> = {
      status: {
        key: 'status', label: 'Status', sticky: !narrow, width: narrow ? 128 : 190, prefsLocked: true,
        render: run => {
          const checked = checkedLine(run)
          return (
            <span className={styles.status}>
              <PublishStatusPill meta={runStatusMeta(run)} />
              {checked && <span className={styles.sub}>{checked}</span>}
            </span>
          )
        },
      },
      started: { key: 'started', label: 'Started', width: narrow ? 104 : 140, render: run => <AsOf at={run.startedAt} kind="event" /> },
      product: {
        key: 'product', label: 'Product', width: 260,
        render: run => {
          const p = productText(run)
          return (
            <span className={styles.stack}>
              <span className={styles.sku}>{p.sku}</span>
              {p.title && <span className={styles.sub} title={p.title}>{p.title}</span>}
            </span>
          )
        },
      },
      destination: {
        key: 'destination', label: 'Destination', width: narrow ? 140 : 200,
        render: run => {
          const account = accountLine(run)
          return (
            <span className={styles.stack}>
              <span>{runDestination(run)}</span>
              {account && <span className={styles.sub} title={account}>{account}</span>}
            </span>
          )
        },
      },
      change: { key: 'change', label: 'Change', width: 150, render: run => runChangeLabel(run) },
      results: { key: 'results', label: 'Results', width: 220, render: run => <span className={styles.results}>{resultsText(run.counts)}</span> },
      source: { key: 'source', label: 'Source', width: 190, render: run => SOURCE_LABEL[run.source] },
      by: { key: 'by', label: 'By', width: 150, render: run => (run.userName ? byText(run) : <span className={styles.muted}>{byText(run)}</span>) },
      duration: { key: 'duration', label: 'Duration', width: 110, numeric: true, render: run => durationText(run) || <span className={styles.muted}>—</span> },
      reference: {
        key: 'reference', label: 'Channel reference', width: 220, defaultHidden: true,
        render: run => (run.reference ? <span className={styles.sku}>{run.reference}</span> : <span className={styles.muted}>—</span>),
      },
    }
    return runColumnKeys(scope.scope, narrow ? 'phone' : 'desktop').map(key => all[key])
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scope.scope is the only part of scope the columns read
  }, [scope.scope, narrow])

  // ── Filters ─────────────────────────────────────────────────────────────────────────────────────────────────
  const activeCount = activeFilterCount(filters)
  const filtered = activeCount > 0
  const set = (patch: Partial<RunFilters>) => setFilters(f => ({ ...f, ...patch }))
  const clearFilters = () => { setFilters(EMPTY_FILTERS); setQuery('') }
  const removeToken = (token: FilterToken) => {
    set(token.clear)
    if (token.key === 'q') setQuery('')
  }

  const metrics: Metric[] = RUN_TILES.map(tile => ({
    label: tile.label,
    value: tiles[tile.key] ?? '—',
    hint: tile.hint,
    accent: tile.accent,
    active: tileActive(tile, filters),
    onClick: () => setFilters(f => applyTile(tile, f, tiles.recentSince)),
  }))

  const channelOptions: ListboxOption[] = [{ value: '', label: 'All channels' }, ...options.channels]
  const marketOptions: ListboxOption[] = [{ value: '', label: 'All markets' }, ...options.markets]
  const accountOptions: ListboxOption[] = [{ value: '', label: 'All accounts' }, ...options.accounts.filter(a => !filters.channel || a.channel === filters.channel)]
  const today = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d }, [])
  const optionLabel = (opts: ReadonlyArray<{ value: string; label: string }>, value: string) => opts.find(o => o.value === value)?.label ?? value
  const tokens = activeFilterTokens(filters, {
    state: state => optionLabel(STATE_OPTIONS, state),
    channel: value => optionLabel(options.channels, value),
    market: value => optionLabel(options.markets, value),
    account: value => optionLabel(options.accounts, value),
    source: source => SOURCE_LABEL[source],
    started: startedWords,
  })

  const view = listView({ loaded: list.loaded, error: list.error, rows: rows.length, filtered })
  const countText = rows.length === 0
    ? null
    : list.hasMore
      ? <>Showing the newest <b>{rows.length}</b> {filtered ? 'matching publishes' : 'publishes'}</>
      : <>All <b>{rows.length}</b> {filtered ? 'matching ' : ''}{rows.length === 1 ? 'publish' : 'publishes'} shown</>

  const missing = list.coverage.filter(c => !c.included || c.note)
  const search = (
    <Input size="sm" type="search" aria-label="Search publishes" placeholder="SKU, title or reference" className={styles.search}
      leadingIcon={<Search size={14} aria-hidden />} value={query} onChange={e => setQuery(e.target.value)} />
  )

  return (
    <div
      ref={dock.ref}
      className={dock.reserve ? `${styles.runs} ${styles.docked}` : styles.runs}
      style={dock.reserve ? ({ '--runs-dock-reserve': `${dock.reserve}px` } as CSSProperties) : undefined}
    >
      {missing.length > 0 && (
        <Banner tone="neutral" title="Some publishes are not in this list">
          <ul className={styles.notes}>
            {missing.map(c => <li key={c.source}>{SOURCE_LABEL[c.source]}: {c.note ?? 'not included yet.'}</li>)}
          </ul>
        </Banner>
      )}

      {/* A phone gets the same three filters as one row of chips: three full tiles filled the first screen. */}
      {narrow ? (
        <div className={styles.tileChips} role="group" aria-label="Quick filters">
          {RUN_TILES.map(tile => (
            <FilterChip key={tile.key} size="md" pressed={tileActive(tile, filters)} count={tiles[tile.key] ?? '—'}
              onClick={() => setFilters(f => applyTile(tile, f, tiles.recentSince))}>
              {tile.label}
            </FilterChip>
          ))}
        </div>
      ) : (
        <MetricStrip metrics={metrics} />
      )}

      {/* Folded by default: the tiles above carry the common filters, and an open panel pushed the list below the
          fold. Whatever is on shows as a token above the list, so folding never hides a filter. */}
      <FilterPanel title={activeCount ? `Filters · ${activeCount} on` : 'Filters'} defaultOpen={false} onReset={clearFilters} resetLabel="Clear" resetDisabled={!filtered}>
        <FilterField label="Result">
          <MultiSelect ariaLabel="Result" size="sm" options={STATE_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
            value={filters.states} onChange={next => set({ states: next as HistoryState[] })} />
        </FilterField>
        <FilterField label="Channel">
          <Listbox size="sm" ariaLabel="Channel" options={channelOptions} value={filters.channel}
            onChange={value => set({ channel: value, marketplace: '', accountId: '' })} />
        </FilterField>
        <FilterField label="Market">
          <Listbox size="sm" ariaLabel="Market" options={marketOptions} value={filters.marketplace} onChange={value => set({ marketplace: value })} />
        </FilterField>
        <FilterField label="Account">
          <Listbox size="sm" ariaLabel="Account" options={accountOptions} value={filters.accountId} onChange={value => set({ accountId: value })} />
        </FilterField>
        <FilterField label="Source">
          <MultiSelect ariaLabel="Source" size="sm" options={SOURCE_OPTIONS} value={filters.sources}
            onChange={next => set({ sources: next as HistorySource[] })} />
        </FilterField>
        <FilterField label="By">
          <Listbox size="sm" ariaLabel="Published by" value={filters.by}
            options={[{ value: 'anyone', label: 'Anyone' }, { value: 'me', label: 'Me' }]}
            onChange={value => set({ by: value === 'me' ? 'me' : 'anyone' })} />
        </FilterField>
        <FilterField label="Started">
          <Listbox size="sm" ariaLabel="Started" options={STARTED_OPTIONS.map(o => ({ value: o.value, label: o.label }))} value={filters.started}
            onChange={value => set({ started: value as StartedPreset, range: value === 'custom' ? filters.range ?? { start: today, end: today } : null, since: undefined })} />
        </FilterField>
        {filters.started === 'custom' && (
          <FilterField label="Dates" wide>
            <DateRangePicker value={filters.range ?? { start: today, end: today }} onChange={range => set({ range })} />
          </FilterField>
        )}
      </FilterPanel>

      <div className="nds-gridcard">
        {tokens.length > 0 && (
          <div className={styles.tokens} role="group" aria-label="Filters on">
            {tokens.map(token => (
              <TokenChip key={token.key} onRemove={() => removeToken(token)} removeLabel={`Remove the filter ${token.label}`}>
                {token.label}
              </TokenChip>
            ))}
            <Button size="sm" variant="ghost" onClick={clearFilters}>Clear all</Button>
          </div>
        )}
        {narrow && <div className={styles.searchRow}>{search}</div>}
        <GridToolbar
          count={countText}
          right={narrow ? undefined : (
            <>
              {search}
              {view === 'rows' && (
                <ToolbarButton icon={<SlidersHorizontal size={15} aria-hidden />} label="Customise columns" variant="boxed" size="sm"
                  onClick={() => setCustomizeOpen(true)} />
              )}
            </>
          )}
        />
        {view === 'loading' && (
          <div className={styles.loading} aria-busy="true" aria-label="Loading publish history">
            {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={20} />)}
          </div>
        )}
        {view === 'error' && (
          <div className={styles.pad}>
            <Banner tone="danger" title="Publish history could not be loaded." action={<Button size="sm" onClick={list.reload}>Try again</Button>}>
              {list.error}
            </Banner>
          </div>
        )}
        {view === 'empty' && <EmptyState title={copy.emptyTitle} description={copy.emptyText} />}
        {view === 'no-match' && (
          <EmptyState title="No publishes match these filters." action={<Button size="sm" onClick={clearFilters}>Clear filters</Button>} />
        )}
        {view === 'rows' && (
          <DataGrid<HistoryRun>
            ariaLabel={copy.ariaLabel}
            columns={columns}
            rows={rows}
            rowKey={run => run.id}
            size="sm"
            keyboardScroll
            customizable={!narrow}
            storageKey={`nexus:publish-runs:${scope.scope}`}
            customizeOpen={customizeOpen}
            onCustomizeOpenChange={setCustomizeOpen}
            customizeTitle="Customise columns"
            rowClassName={run => (run.id === openRunId ? `${styles.row} ${styles.open}` : styles.row)}
            rowProps={run => ({
              'aria-label': rowAriaLabel(run),
              title: 'Open this publish',
              onClick: () => openRun(run.id),
              onKeyDown: (event: ReactKeyboardEvent<HTMLTableRowElement>) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                openRun(run.id)
              },
            })}
          />
        )}
      </div>

      {view === 'rows' && list.error && (
        <Banner tone="danger" title="More publishes could not be loaded." action={<Button size="sm" onClick={list.loadMore}>Try again</Button>}>
          {list.error}
        </Banner>
      )}
      {view === 'rows' && list.hasMore && !list.error && (
        <div className={styles.more}>
          <Button onClick={list.loadMore} disabled={list.loadingMore}>{list.loadingMore ? 'Loading…' : `Show ${PAGE_SIZE} more`}</Button>
        </div>
      )}

      <div role="status" aria-live="polite" className="nds-vh">{announcement}</div>

      <PublishRunDrawer
        runId={openRunId}
        mode={scope.scope === 'business' ? 'modal' : 'dock'}
        onClose={closeRun}
        onRunChanged={list.refresh}
      />
    </div>
  )
}

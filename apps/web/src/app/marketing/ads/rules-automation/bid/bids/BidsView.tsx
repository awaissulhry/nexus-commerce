'use client'

/**
 * Bid page (lane BIDS, 2026-10-10) — the Bids view: every live keyword and target bid with the ONE thing that sets it
 * (`GET /api/advertising/bids`). Owner chips with counts filter it, a search narrows it, Views and Customise keep its
 * columns, a row opens the keyword's detail (why this bid · history with Undo · what if · goal; change the bid; lock or
 * unlock the campaign's bids). Every change goes through the DS review first.
 *
 * Change bid (Owner 2026-10-12): the selected keywords — or one keyword's detail — in one dialog: Set to · Raise · Lower,
 * by an amount or a percent, with an optional limit; its table follows every key (`adjustModel.ts`, `useBidReview`).
 *
 * Keyword Auto (KEYWORD-AUTO.md):
 *   Auto       a switch per keyword (Manual = a person's hold with no end; Auto = handed back) — drawn only where an
 *              engine runs some keyword in scope, like Goal; Brain bid only where the Brain sets some bid
 *   Suggested  Amazon's suggested bid per ad group, read lazily for the rows on screen; Apply per row or for the selected
 *              rows (one review, Undo through the change feed)
 *   Goal       the keyword's own target ACoS and max (its detail's Goal tab), saved in the brain's settings
 *   Live       the cursor every 5 s while a change is on its way, 60 s otherwise, paused in a hidden tab; the rows are read
 *              again only when it moved — in place, so the selection, the sort and the open detail stay
 *
 * Mounted by the Bid page's [Rules | Bids] switch (lane RULES):
 *   <BidsView market={market} viewSwitch={switch} show={tile} onTotals={setBidTotals} />
 * The page's tiles above it show its totals (`onTotals`, after each read) and narrow it (`show`), so a tile and the table
 * never disagree (M1).
 *
 * Every write is held, with the reason, on a bid whose market Nexus only reads (`useWriteBlockOf`, use audit A1). The
 * search lives in the address (`?q=`, as on the Rules view). The person's columns stay theirs: a reload keeps them, and a
 * column that leaves (a market without it) comes back as it was left (`_shared/columnChoices.ts`, A3); while the rows are
 * read the table keeps the columns it had for this scope (design audit S10).
 *
 * A row's detail is the DS `DetailModal` with its address: `?bid=<targetId>&tab=why|history|whatif|goal` — opening it is
 * a step in the history (Back closes it), a tab and ▲ / ▼ replace it; a copied address opens it. Esc closes it and the
 * focus goes back to the row's cell (the one on show after ▲ / ▼). A review opens ABOVE it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PencilLine, Search, SlidersHorizontal, Sparkles } from 'lucide-react'
import { Button, FilterChip, Input } from '@/design-system/primitives'
import { Banner } from '@/design-system/components'
import { GridToolbar, PreferencesModal, ReviewChangesModal, type PreferencesValue } from '@/design-system/patterns'
import {
  AG_SELECTION_COL, GRID_PAGE_SIZES, columnStateToPrefs, gridSelection, GridCard, GridLoadingOverlay, GridNoRowsOverlay, GridPager, GridSearchSlot, GridToolbarFold,
  GridSelectionActions, GridViewsMenu, NexusGrid, prefsToColumnState, useGridState,
  type GridApi, type GridReadyEvent, type GridStateKey, type NexusGridProps, type PrefsBridgeOptions,
} from '@/design-system/grid'
import { usePermission } from '@/lib/auth/AuthProvider'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { useWriteBlockOf } from '../../../_shell/WriteBlocked'
import { useColumnChoices } from '../_shared/columnChoices'
import { readBids, type BidsScope } from './bidsApi'
import { bidColumns, bidColumnSpecs, NO_COLUMN_FEATURES, OwnerIcon, type BidColumnFeatures, type BidsCellContext, type BidsCellHandlers } from './bidsColumns'
import {
  autoHeld, bidsTotalsOf, countWords, emptyWords, gridRowOf, inScopeOf, isBidFiltered, NO_BID_FILTER, otherWriters, ownerChips, rowMatches, showMatches,
  type BidFilter, type BidGridRow, type BidsAnswer, type BidsShow, type BidsTotals, type OwnerFilter,
} from './bidsModel'
import { BidDetail, isBidTab, type BidPanelTab } from './BidDetail'
import { inFlight, inFlightSince } from './liveModel'
import { changeHeld } from './adjustModel'
import { applyHeld, applyLabel, applyPlan, suggestedCellOf } from './suggestedModel'
import { useBidReview } from './useBidReview'
import { useBidsLive, useSuggested } from './useBidsLive'
import styles from './bids.module.css'
// The toolbar's lead, count, search and right group: the Rules view's own rules, so the two toolbars line up (audit M3).
import page from '../bid.module.css'

export interface BidsViewProps extends BidsScope {
  /** The page's [Rules | Bids] switch, drawn at the start of this view's toolbar. */
  viewSwitch?: ReactNode
  /** Bumped by the page's Refresh: the bids are read again. */
  refreshKey?: number
  /** A tile's filter: bids changed in 7 d · bids two writers write ("Two writers"). Unset = all. */
  show?: BidsShow
  /** Called after each read with the view's totals (never narrowed by its own filters), for the page's tiles. */
  onTotals?: (totals: BidsTotals) => void
}

/* ── stable grid options (GDS decision 12) ───────────────────────────────────────────────── */

const ROW_ID: NonNullable<NexusGridProps<BidGridRow>['getRowId']> = (p) => p.data.targetId
const LOADING_PARAMS = { rows: 8 }
const PAGE_SIZE = 100
/** Below the smallest page size the pager does nothing: it is not drawn. */
const PAGER_FROM = GRID_PAGE_SIZES[0]
const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility', 'columnPinning', 'sort']
const NO_CHOICES: number[] = []
const NO_SORT_OPTIONS: Array<{ value: string; label: string }> = []
const NO_PAGE_STATE = (): Record<string, never> => ({})
const IGNORE_PAGE_STATE = () => {}
/** The cells that answer Enter themselves (a link, a list, a switch, Apply): Enter there never opens the detail. */
const OWN_KEY_COLUMNS = new Set(['portfolio', 'campaign', 'adGroup', 'auto', 'suggested'])
const SELECTION = gridSelection<BidGridRow>({ selectAll: 'filtered' }) as NexusGridProps<BidGridRow>['rowSelection']

/** Below 640 px: the phone layout (as the Control Room and the Approvals page). */
function usePhone(): boolean {
  const [phone, setPhone] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)')
    const update = () => setPhone(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return phone
}

/** The columns a scope needed last time (Auto · Goal · Brain bid), so its table keeps them while its rows are read (S10). */
const inScopeKey = (scopeKey: string) => `nexus.bid.inScope.${scopeKey}`
function readInScope(scopeKey: string): BidColumnFeatures | null {
  try {
    const v = JSON.parse(window.localStorage.getItem(inScopeKey(scopeKey)) ?? 'null') as Partial<BidColumnFeatures> | null
    return v && typeof v === 'object' ? { engine: v.engine === true, brain: v.brain === true } : null
  } catch {
    return null
  }
}
function writeInScope(scopeKey: string, v: BidColumnFeatures): void {
  try { window.localStorage.setItem(inScopeKey(scopeKey), JSON.stringify(v)) } catch { /* the next visit reads it again */ }
}

export function BidsView({ market = null, productId = null, campaignId = null, adGroupId = null, viewSwitch, refreshKey, show, onTotals }: BidsViewProps) {
  // The server's own gates (permissions-manifest.ts): a bid, a lock and an Undo · a bulk bid and a keyword's mode · a goal.
  const canEdit = usePermission('ads.campaigns.manage')
  const canBids = usePermission('ads.bids.edit')
  const canAutomation = usePermission('ads.automation.manage')
  const canGoal = canEdit && canAutomation
  const phone = usePhone()
  const scopeKey = `${market ?? ''}|${productId ?? ''}|${campaignId ?? ''}|${adGroupId ?? ''}`

  const router = useRouter()
  const params = useSearchParams()
  const [answer, setAnswer] = useState<BidsAnswer | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reading, setReading] = useState(true)
  const [filter, setFilter] = useState<BidFilter>(() => ({ ...NO_BID_FILTER, search: params.get('q') ?? '' }))
  const [version, setVersion] = useState(0)

  // The search lives in the address too (as on the Rules view: Rules → Bids → Rules keeps it; a link can carry it).
  useEffect(() => {
    const t = window.setTimeout(() => {
      const q = new URLSearchParams(window.location.search)
      const want = filter.search.trim() ? filter.search : null
      if ((q.get('q') ?? null) === want) return
      if (want) q.set('q', want); else q.delete('q')
      const s = q.toString()
      router.replace(s ? `?${s}` : '?', { scroll: false })
    }, 250)
    return () => window.clearTimeout(t)
  }, [filter.search]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── the detail's address: ?bid=<targetId>&tab=<tab> ──
  const openId = params.get('bid')
  const tabParam = params.get('tab')
  const openTab: BidPanelTab = isBidTab(tabParam) ? tabParam : 'why'
  /** This view pushed the detail's address: closing it steps Back, so Back never opens it again. */
  const pushed = useRef(false)
  /** The row whose cell opened the detail (its focus comes back there); null when the address opened it. */
  const openerId = useRef<string | null>(null)
  const address = useCallback((patch: Record<string, string | null>, mode: 'push' | 'replace') => {
    const next = new URLSearchParams(window.location.search)
    for (const [k, v] of Object.entries(patch)) { if (v == null) next.delete(k); else next.set(k, v) }
    const q = next.toString()
    if (mode === 'push') router.push(q ? `?${q}` : '?', { scroll: false })
    else router.replace(q ? `?${q}` : '?', { scroll: false })
  }, [router])
  /** A row's detail, on a tab (a row opens on Why; the Brain's chip asks for Why; the Goal cell for Goal). */
  const openDetail = useCallback((targetId: string, tab: BidPanelTab = 'why') => {
    openerId.current = targetId
    const already = new URLSearchParams(window.location.search).has('bid')
    if (!already) pushed.current = true
    address({ bid: targetId, tab }, already ? 'replace' : 'push')
  }, [address])
  const setOpenTab = useCallback((tab: BidPanelTab) => address({ tab }, 'replace'), [address])
  const goTo = useCallback((targetId: string) => address({ bid: targetId }, 'replace'), [address])
  const closeDetail = useCallback(() => {
    if (pushed.current) { pushed.current = false; router.back() } else address({ bid: null, tab: null }, 'replace')
  }, [address, router])
  // Leaving the Bids view (the page's switch to Rules) takes the detail's address with it: no `?bid=` left behind.
  useEffect(() => () => {
    const q = new URLSearchParams(window.location.search)
    if (q.has('bid') && q.get('view') !== 'bids') {
      q.delete('bid')
      if (isBidTab(q.get('tab')) && !q.has('rule')) q.delete('tab')
      const s = q.toString()
      window.history.replaceState(window.history.state, '', s ? `?${s}` : window.location.pathname)
    }
  }, [])

  // ── the read ──
  const scopeRef = useRef<BidsScope>({ market, productId, campaignId, adGroupId })
  scopeRef.current = { market, productId, campaignId, adGroupId }
  const load = useCallback(async () => {
    setReading(true)
    try {
      const next = await readBids(scopeRef.current)
      setAnswer(next)
      setErr(null)
      return next
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setReading(false)
    }
  }, [])
  useEffect(() => { setAnswer(null); setErr(null); void load() }, [scopeKey, refreshKey, load])
  const reload = useCallback(() => { setErr(null); void load() }, [load])
  const after = useCallback(async () => { await load(); setVersion((n) => n + 1) }, [load])

  // The page's tiles: the view's own totals after every read (a ref, so a new callback never reads again).
  const onTotalsRef = useRef(onTotals)
  onTotalsRef.current = onTotals
  const totals = useMemo(() => (answer ? bidsTotalsOf(answer) : null), [answer])
  useEffect(() => { if (totals) onTotalsRef.current?.(totals) }, [totals])

  // ── which columns the rows in scope need (never one that could only say "—"); while they are read, last time's ──
  // Read before the grid is made, so its first columns are the scope's own (its saved order and picks apply whole).
  const [remembered, setRemembered] = useState<BidColumnFeatures | null>(() => (typeof window === 'undefined' ? null : readInScope(scopeKey)))
  const firstScope = useRef(scopeKey)
  useEffect(() => { if (scopeKey !== firstScope.current) { firstScope.current = scopeKey; setRemembered(readInScope(scopeKey)) } }, [scopeKey])
  const answered = useMemo(() => (answer ? inScopeOf(answer.rows) : null), [answer])
  useEffect(() => { if (answered) writeInScope(scopeKey, answered) }, [answered]) // eslint-disable-line react-hooks/exhaustive-deps
  const inScope = answered ?? remembered ?? NO_COLUMN_FEATURES

  // ── rows; a write to a market Nexus only reads is held on the row, with the reason (A1) ──
  const blockOf = useWriteBlockOf()
  const base = useMemo(() => (answer?.rows ?? []).map((r) => ({ ...gridRowOf(r, market), writeBlock: blockOf([market, r.market]) })), [answer, market, blockOf])
  const filteredBase = useMemo(() => base.filter((r) => showMatches(r, show) && rowMatches(r, filter)), [base, show, filter])

  // ▲ / ▼ and the rows on screen: the table's rows in the order shown now (filtered, sorted — every page).
  const [order, setOrder] = useState<string[]>([])
  const apiRef = useRef<GridApi<BidGridRow> | null>(null)
  const [pager, setPager] = useState({ page: 1, pageCount: 1 })
  const [pageSize, setPageSize] = useState(PAGE_SIZE)

  // Amazon's suggested bids, for the ad groups of the rows on this page (and the open row's).
  const byIdBase = useMemo(() => new Map(base.map((r) => [r.targetId, r])), [base])
  const onScreenGroups = useMemo(() => {
    const ids = order.length ? order.slice((pager.page - 1) * pageSize, pager.page * pageSize) : filteredBase.slice(0, pageSize).map((r) => r.targetId)
    const groups = ids.map((id) => byIdBase.get(id)?.adGroup.id).filter((g): g is string => !!g)
    const open = openId ? byIdBase.get(openId)?.adGroup.id : undefined
    return [...new Set(open ? [open, ...groups] : groups)]
  }, [order, pager.page, pageSize, filteredBase, byIdBase, openId])
  const suggested = useSuggested({ adGroupIds: onScreenGroups, enabled: !!answer, resetKey: scopeKey })
  const features = useMemo<BidColumnFeatures>(() => ({ engine: inScope.engine, brain: inScope.brain }), [inScope.engine, inScope.brain])
  const cellOf = useCallback((row: BidGridRow) => suggestedCellOf(suggested.states.get(row.adGroup.id), row.targetId), [suggested.states, suggested.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const all = useMemo(
    () => base.map((r) => ({ ...r, suggested: cellOf(r), autoLock: r.writeBlock ?? autoHeld(r, canBids) })),
    [base, cellOf, canBids],
  )
  const byId = useMemo(() => new Map(all.map((r) => [r.targetId, r])), [all])
  const shown = useMemo(() => all.filter((r) => showMatches(r, show) && rowMatches(r, filter)), [all, show, filter])
  const openRef = useRef<BidGridRow | null>(null)
  const openRow = openId ? byId.get(openId) ?? (openRef.current?.targetId === openId ? openRef.current : null) : null
  openRef.current = openRow

  // ── live ──
  useBidsLive({
    scope: scopeRef.current, scopeKey, enabled: !!answer && !err, inFlight: inFlight(answer?.rows ?? [], null),
    inFlightSince: (firstSeen) => inFlightSince(answer?.rows ?? [], firstSeen), onMoved: () => void load(),
  })

  const chips = useMemo(() => ownerChips(answer?.totals ?? null, filter.owner), [answer, filter.owner])
  const filtered = isBidFiltered(filter) || !!show
  const clear = useCallback(() => setFilter(NO_BID_FILTER), [])
  /** Nothing to show because the read failed: no table words, no chips, no pager — the read's own message. */
  const failed = !!err && !answer
  const loading = !answer && !err

  /* ── grid ───────────────────────────────────────────────────────────────────────────────── */

  const columnDefs = useMemo(() => bidColumns(phone, features), [phone, features])
  const specs = useMemo(() => bidColumnSpecs(features), [features])
  const bridge = useMemo<PrefsBridgeOptions>(() => ({ columns: specs.map((c) => ({ key: c.key, locked: c.locked })) }), [specs])
  const preferenceSpecs = useMemo(() => specs.map((c) => ({ key: c.key, label: c.label, locked: c.locked })), [specs])
  const defaultPrefs = useMemo<PreferencesValue>(() => ({
    visibleColumns: specs.filter((c) => !c.hidden).map((c) => c.key),
    lockedColumns: [],
    stickyFirstColumn: true,
    stickyLastColumn: false,
    pageSize: 0,
    sortBy: '',
    sortDir: 'asc',
  }), [specs])
  const gridState = useGridState<Record<string, never>>({
    surface: 'ads-bid-bids',
    baseUrl: getBackendUrl(),
    getPageState: NO_PAGE_STATE,
    applyPageState: IGNORE_PAGE_STATE,
    persistKeys: PERSIST_KEYS,
  })
  const bindState = useRef(gridState.bind)
  bindState.current = gridState.bind
  const bindChoices = useColumnChoices('ads-bid-bids', gridState.initialState)
  const onGridReady = useCallback((e: GridReadyEvent<BidGridRow>) => {
    apiRef.current = e.api
    bindState.current(e.api)
    bindChoices(e.api as unknown as GridApi)
  }, [bindChoices])
  const onPaginationChanged = useCallback((e: { api: GridApi<BidGridRow> }) => {
    setPager({ page: e.api.paginationGetCurrentPage() + 1, pageCount: Math.max(1, e.api.paginationGetTotalPages()) })
  }, [])
  const onPage = useCallback((n: number) => apiRef.current?.paginationGoToPage(n - 1), [])
  const onPageSize = useCallback((n: number) => { setPageSize(n); apiRef.current?.paginationGoToPage(0) }, [])
  const onModelUpdated = useCallback((e: { api: GridApi<BidGridRow> }) => {
    const ids: string[] = []
    e.api.forEachNodeAfterFilterAndSort((n) => { if (n.data) ids.push(n.data.targetId) })
    setOrder((cur) => (cur.length === ids.length && cur.every((id, i) => id === ids[i]) ? cur : ids))
  }, [])

  // Bulk: the selected rows (row checkboxes only for a person who may send bids). Ticks on the phone too (audit R20).
  const selectable = canBids
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const onSelectionChanged = useCallback<NonNullable<NexusGridProps<BidGridRow>['onSelectionChanged']>>((e) => setSelectedIds(e.api.getSelectedRows().map((r) => r.targetId)), [])
  const selected = useMemo(() => selectedIds.flatMap((id) => byId.get(id) ?? []), [selectedIds, byId])
  // What the bulk Apply would send: held with the reason when nothing of the selection can go (audit R7) — a bid in a
  // market Nexus only reads is left out with that reason (A1).
  const bulkPlan = useMemo(() => applyPlan(selected, cellOf), [selected, cellOf])

  /* ── the review (every change), above the detail when one is open ─────────────────────────── */

  const { review, ask, save, undoSaved, close } = useBidReview({ market, canGoal, cellOf, after, onSetGoal: (row) => openDetail(row.targetId, 'goal') })

  const onRowClicked = useCallback<NonNullable<NexusGridProps<BidGridRow>['onRowClicked']>>((e) => {
    const target = (e.event?.target ?? null) as HTMLElement | null
    if (target?.closest?.('a, button, [role="dialog"], [role="switch"], .ag-selection-checkbox')) return
    if (!e.data) return
    openDetail(e.data.targetId, target?.closest?.('[col-id="goal"]') ? 'goal' : 'why')
  }, [openDetail])
  const onCellKeyDown = useCallback<NonNullable<NexusGridProps<BidGridRow>['onCellKeyDown']>>((e) => {
    const key = e.event as KeyboardEvent | null | undefined
    if (key?.key !== 'Enter' || !e.data) return
    const target = key.target as HTMLElement | null
    if (target?.closest?.('a, button, input, [role="dialog"]')) return
    const col = 'column' in e ? e.column.getColId() : null
    // A cell that answers Enter itself (a link, a list, a switch, Apply); an owner with a page or a list.
    if (col && OWN_KEY_COLUMNS.has(col)) {
      if (col !== 'suggested' || target?.querySelector?.('[data-cell-action]')) return
    }
    if (col === 'owner' && (e.data.ownerHref || e.data.ownerWhy || otherWriters(e.data.owner).length)) return
    if (col?.startsWith('ag-Grid')) return
    openDetail(e.data.targetId, col === 'goal' ? 'goal' : 'why')
  }, [openDetail])
  // The cells' handlers (AG's context: one ref for the grid's life, so the columns never change).
  const cellHandlers = useRef<BidsCellHandlers>({ openWhy: () => {} })
  cellHandlers.current = {
    openWhy: (id) => openDetail(id, 'why'),
    apply: canBids ? (row) => void ask({ kind: 'apply', row, rows: [row] }) : undefined,
    onSwitch: canBids ? (row, next) => { if (!row.autoLock) void ask({ kind: 'mode', row, next: next ? 'AUTO' : 'MANUAL' }) } : undefined,
  }
  const cellContext = cellHandlers as BidsCellContext

  /** A row's keyword cell, brought into view and focused (its page first): where the focus goes when the detail closes. */
  const cellFor = useCallback((targetId: string): HTMLElement | null => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return null
    const node = api.getRowNode(targetId)
    if (!node || node.rowIndex == null) return null
    const page = Math.floor(node.rowIndex / api.paginationGetPageSize())
    if (api.paginationGetCurrentPage() !== page) api.paginationGoToPage(page)
    api.ensureIndexVisible(node.rowIndex)
    api.setFocusedCell(node.rowIndex, 'keyword')
    return document.querySelector<HTMLElement>(`.ag-row[row-id="${CSS.escape(targetId)}"] .ag-cell[col-id="keyword"]`)
  }, [])
  // Esc: back to the cell that opened it — or, after ▲ / ▼ or from the address, to the cell of the row on show.
  const detailFocus = useCallback(() => (openId && openId !== openerId.current ? cellFor(openId) : null), [openId, cellFor])

  const noRowsParams = useMemo(() => {
    if (failed) return { title: 'Bids not read', message: err ?? '', action: { label: 'Try again', onClick: reload } }
    const words = emptyWords(show, isBidFiltered(filter), all.length > 0)
    return { title: words.title, message: '', action: words.clear ? { label: 'Clear filters', onClick: clear } : undefined }
  }, [failed, err, reload, show, filter, all.length, clear])

  /* ── Customise, Reset (the toolbar and every header's ⋮ menu) ────────────────────────────── */

  const [prefsOpen, setPrefsOpen] = useState(false)
  const [prefs, setPrefs] = useState<PreferencesValue>(defaultPrefs)
  const openCustomise = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    setPrefs((current) => columnStateToPrefs(api.getColumnState().filter((c) => c.colId !== AG_SELECTION_COL), current, bridge))
    setPrefsOpen(true)
  }, [bridge])
  const applyPrefs = useCallback((next: PreferencesValue) => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    api.applyColumnState({ state: prefsToColumnState(next, bridge), applyOrder: true })
    setPrefs(next)
  }, [bridge])
  const resetColumns = useCallback(() => { apiRef.current?.resetColumnState(); setPrefs(defaultPrefs) }, [defaultPrefs])
  const columnDialog = useMemo(() => (phone ? undefined : { customise: openCustomise, reset: resetColumns }), [phone, openCustomise, resetColumns])

  /* ── render ─────────────────────────────────────────────────────────────────────────────── */

  const total = answer?.totals.bids ?? 0
  const setOwner = (key: OwnerFilter) => setFilter((f) => ({ ...f, owner: f.owner === key && key !== 'ALL' ? 'ALL' : key }))
  const countText = failed ? 'Not read' : answer ? countWords(shown.length, total, filtered) : 'Reading…'
  const activeChip = chips.find((c) => c.key === filter.owner && c.key !== 'ALL')?.label
  const pagerShown = !!answer && !failed && shown.length > PAGER_FROM
  const bulk = selectable && selected.length > 0

  return (
    <div className={styles.stack}>
      {/* A re-read that failed over rows already shown: the rows stay, the banner says so. With no rows, the table says it. */}
      {err && answer && (
        <Banner tone="danger" title="Bids not read" action={<Button size="sm" variant="secondary" onClick={reload}>Try again</Button>}>
          {err}
        </Banner>
      )}

      <GridCard
        toolbar={bulk ? (
          <GridToolbar count={<span className={page.lead}>{viewSwitch}<span className={page.count}>Selected <b>{selected.length}</b></span></span>}>
            <GridSelectionActions>
              <Button size="sm" variant="secondary" heldReason={changeHeld(selected, canBids)} onClick={() => void ask({ kind: 'adjust', row: selected[0], rows: selected })}>
                <PencilLine size={14} aria-hidden /> Change bid…
              </Button>
              <Button size="sm" variant="secondary" heldReason={applyHeld(bulkPlan)} onClick={() => void ask({ kind: 'apply', row: selected[0], rows: selected })}>
                <Sparkles size={14} aria-hidden /> {bulkPlan.send.length ? `${applyLabel(bulkPlan.send.length)}…` : 'Apply suggested'}
              </Button>
              <Button size="sm" variant="link" onClick={() => apiRef.current?.deselectAll()}>Clear</Button>
            </GridSelectionActions>
          </GridToolbar>
        ) : (
          <GridToolbar
            count={(
              <span className={page.lead}>
                {viewSwitch}
                <span className={page.count}>{countText}</span>
              </span>
            )}
            right={!phone ? (
              <span className={page.toolbarRight}>
                <GridViewsMenu views={gridState} />
                <Button size="sm" variant="secondary" onClick={openCustomise}>
                  <SlidersHorizontal size={14} aria-hidden /> Customise
                </Button>
              </span>
            ) : undefined}
          >
            <GridSearchSlot>
              <Input
                size="sm"
                type="search"
                aria-label="Search bids"
                placeholder="Search"
                fieldClassName={page.searchField}
                leadingIcon={<Search size={14} aria-hidden />}
                value={filter.search}
                onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value }))}
              />
            </GridSearchSlot>
            {/* The owner chips stay on one line; when the toolbar runs out of room they fold into one "Who sets it" button
                (the DS fold, M4: they wrapped 3 + 2 at 1024 and pushed the toolbar to 93 px). A phone always folds them. */}
            {chips.length > 0 && (
              <GridToolbarFold label="Who sets it" activeLabel={activeChip} mode={phone ? 'always' : 'overflow'}>
              <span className={styles.chips} role="group" aria-label="Who sets it">
                {chips.map((c) => (
                  <FilterChip
                    key={c.key}
                    pressed={filter.owner === c.key}
                    count={c.count}
                    title={c.name === c.label ? undefined : c.name}
                    aria-label={c.name === c.label ? undefined : `${c.name}, ${c.count}`}
                    onClick={() => setOwner(c.key)}
                  >
                    {c.key === 'ALL' ? c.label : <span className={styles.inline}><OwnerIcon kind={c.key} />{c.label}</span>}
                  </FilterChip>
                ))}
              </span>
              </GridToolbarFold>
            )}
          </GridToolbar>
        )}
        footer={pagerShown ? <GridPager page={pager.page} pageCount={pager.pageCount} pageSize={pageSize} onPage={onPage} onPageSize={onPageSize} /> : undefined}
      >
        <NexusGrid<BidGridRow>
          domLayout="autoHeight"
          suppressCellFocus={false}
          rowData={failed ? [] : shown}
          getRowId={ROW_ID}
          columnDefs={columnDefs}
          rowSelection={selectable ? SELECTION : undefined}
          initialState={gridState.initialState}
          columnDialog={columnDialog}
          context={cellContext}
          loading={loading || (reading && failed)}
          loadingOverlayComponent={GridLoadingOverlay}
          loadingOverlayComponentParams={LOADING_PARAMS}
          noRowsOverlayComponent={GridNoRowsOverlay}
          noRowsOverlayComponentParams={noRowsParams}
          pagination
          paginationPageSize={pageSize}
          paginationPageSizeSelector={false}
          suppressPaginationPanel
          onGridReady={onGridReady}
          onPaginationChanged={onPaginationChanged}
          onRowClicked={onRowClicked}
          onCellKeyDown={onCellKeyDown}
          onModelUpdated={onModelUpdated}
          onSelectionChanged={onSelectionChanged}
        />
      </GridCard>

      {answer?.totals.truncated && (
        <Banner tone="warning" title={`Showing the ${total.toLocaleString('en-IE')} highest bids`}>
          Pick a market, a campaign or a product to see the rest.
        </Banner>
      )}

      {openId && (
        <BidDetail
          row={openRow}
          missing={!!answer && !openRow}
          loading={!answer && !err}
          onRetry={reload}
          tab={openTab}
          onTab={setOpenTab}
          nav={openRow && order.includes(openRow.targetId) ? { ids: order, current: openRow.targetId, onGo: goTo, noun: 'keyword' } : undefined}
          market={market}
          canEdit={canEdit}
          canBids={canBids}
          canGoal={canGoal}
          version={version}
          onAsk={(a) => void ask(a)}
          onClose={closeDetail}
          returnFocusTo={detailFocus}
        />
      )}

      {review && (
        <ReviewChangesModal
          open
          onClose={close}
          changes={review.changes}
          state={review.state}
          title={review.title}
          summary={review.state.phase === 'done' ? review.doneNote : review.summary}
          lead={review.lead}
          leadHeld={review.leadHeld}
          problems={review.problems}
          saveLabel={review.saveLabel}
          doneVerb={review.doneVerb}
          ackLabel={review.ackLabel}
          onSave={() => void save()}
          onRetry={() => void ask(review.ask)}
          onUndo={review.state.phase === 'done' && review.undo ? () => void undoSaved() : undefined}
          undoing={review.undoing}
        />
      )}

      {prefsOpen && (
        <PreferencesModal
          open={prefsOpen}
          onClose={() => setPrefsOpen(false)}
          value={prefs}
          onConfirm={applyPrefs}
          allColumns={preferenceSpecs}
          defaultVisible={defaultPrefs.visibleColumns}
          pageSizeChoices={NO_CHOICES}
          sortFieldOptions={NO_SORT_OPTIONS}
          showSticky={false}
          title="Customise columns"
        />
      )}
    </div>
  )
}

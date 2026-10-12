'use client'

/**
 * Keyword Harvest page — the Sources view (2026-10-11, lane HRULES): every ad group of the market that feeds search terms
 * to harvest (auto, broad, phrase, product targets), with the harvest rules that read it and what it gave in 30 days.
 * It replaces the old Ad Group View: market-filtered, working tick boxes, real links.
 *
 * The /products recipe: one card (toolbar, table, pager), tick boxes with header select-page and "Select all N" (every
 * row that matches), a bulk bar while rows are ticked — Assign rule… · Detach rule… · Turn off · Turn on — and the same verbs
 * in each row's ⋯ menu. Each opens one review (the DS `ReviewChangesModal`: Now → New, a counted button) and ends in
 * Done with Undo. Nothing here writes to Amazon: rules and pauses are Nexus settings.
 *
 * The page frame (header, view switch, tiles) is the page's (lane TERMS): this view reads `show` (the tile that filters)
 * and reports its numbers and tiles through `onTotals` after each read — the same predicates as the filter.
 * Address: `?show=` (the page's) · `?sq=` the search.
 *
 * The page's filter bar (2026-10-12): the sources are read for the market and kept here when they sit among its picks
 * (`placeInReach`) — the table, its count, the tiles, "Select all" and Export follow; nothing shows while its lists are read.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Download, Pause, Play, Search, SlidersHorizontal, Unlink, Workflow } from 'lucide-react'
import { Button, Input, Skeleton } from '@/design-system/primitives'
import { Banner, Field, Listbox, Modal, useNarrow, useToast } from '@/design-system/components'
import { GridToolbar, PreferencesModal, ReviewChangesModal, type PreferencesValue, type ReviewChange, type ReviewResult, type ReviewState } from '@/design-system/patterns'
import {
  GRID_PAGE_SIZES, GridCard, GridPager, GridSearchSlot, GridSelectionActions, GridViewsMenu, columnStateToPrefs, exportGridCsv, prefsToColumnState, useGridState,
  type GridApi, type GridReadyEvent, type GridStateKey, type NexusGridProps, type PrefsBridgeOptions,
} from '@/design-system/grid'
import { usePermission } from '@/lib/auth/AuthProvider'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { emitAdsChange, useAdsSync } from '../../_shared/adsBus'
import { FILTER_EMPTY, placeInReach } from '../../_shared/scopeFilter/scopeFilterModel'
import type { ScopeView } from '../../_shared/scopeFilter/useScopeFilter'
import { plural, readError } from '../../bid/rules/bidRulesModel'
import { assignSources, detachSources, pauseSources, readHarvestSources, resumeSources } from '../_shared/harvestApi'
import type { HarvestSourceRow, HarvestSourcesAnswer, Ref } from '../_shared/types'
import {
  EVERY_RULE, SOURCES_WINDOW_DAYS, assignChanges, assignOptions, detachChanges, detachOptions, detachPlan, isSourcesShow, pauseChanges, pauseHeld, sourcesViewTotals, visibleSources,
  type HarvestSourcesShow, type HarvestSourcesViewTotals, type PickRule, type RuleReach,
} from './sourcesModel'
import { readPickRules } from './sourcesApi'
import { latestRead } from '../rules/latestRead'
import { SOURCE_PREFERENCE_COLUMNS, SourcesTable, type SourceGridRow, type SourcesHandlers, type SourcesHandlersRef } from './SourcesTable'
import styles from '../../bid/bid.module.css'

const PAGE_SIZE = 50
const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility', 'sort']
const BRIDGE: PrefsBridgeOptions = { columns: SOURCE_PREFERENCE_COLUMNS.map((c) => ({ key: c.key, locked: c.locked })) }
const PREF_SPECS = SOURCE_PREFERENCE_COLUMNS.map((c) => ({ key: c.key, label: c.label, locked: c.locked }))
const DEFAULT_PREFS: PreferencesValue = {
  visibleColumns: SOURCE_PREFERENCE_COLUMNS.map((c) => c.key), lockedColumns: [], stickyFirstColumn: true, stickyLastColumn: true,
  pageSize: 0, sortBy: '', sortDir: 'asc',
}
const NO_CHOICES: number[] = []
const NO_SORT: Array<{ value: string; label: string }> = []

interface PageState { show: HarvestSourcesShow | null }

type Task =
  | { kind: 'assign'; rule: Ref; rows: HarvestSourceRow[] }
  | { kind: 'detach'; ruleId: string; rows: HarvestSourceRow[] }
  | { kind: 'pause' | 'resume'; rows: HarvestSourceRow[] }

/** The rule picker before an Assign or a Detach review: one list, then "Review N". */
type Pick = { kind: 'assign' | 'detach'; rows: HarvestSourceRow[] }

export interface HarvestSourcesViewProps {
  market: string
  show?: string | null
  onTotals?: (t: HarvestSourcesViewTotals) => void
  /** Optional: the page's view switch, drawn at the start of the toolbar. */
  viewSwitch?: ReactNode
  /** The page's filter bar: only the sources among its picks show (and count). */
  scope?: ScopeView
}

export function HarvestSourcesView({ market, show: showProp, onTotals, viewSwitch, scope }: HarvestSourcesViewProps) {
  const params = useSearchParams()
  const router = useRouter()
  const phone = useNarrow()
  const { toast } = useToast()
  const canAutomation = usePermission('ads.automation.manage')
  const held = canAutomation ? null : 'Needs the ads automation permission'

  const setQuery = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search)
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v) }
    const q = next.toString()
    router.replace(q ? `?${q}` : '?', { scroll: false })
  }, [router])

  // ── the reads ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const [answerRead, setAnswer] = useState<HarvestSourcesAnswer | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [rules, setRules] = useState<PickRule[]>([])
  const [paused, setPaused] = useState(false)
  // The Sources read needs one market: "all" reads none and says so. Only the newest read shows: one that lands after a
  // newer read began (another market's, or an older one) is dropped (release review RS5).
  const oneMarket = market && market !== 'all' ? market : null
  const [beginRead] = useState(latestRead)
  const load = useCallback(async () => {
    const current = beginRead()
    if (!oneMarket) { setAnswer(null); setErr(null); return null }
    const pick = readPickRules(oneMarket).then((r) => { if (current()) setRules(r) }, () => { if (current()) setRules([]) })
    try {
      const a = await readHarvestSources(oneMarket)
      if (!current()) return null
      setAnswer(a); setErr(null)
      await pick
      return a
    } catch (e) { if (current()) setErr((e as Error).message); return null }
  }, [oneMarket, beginRead])
  useEffect(() => { setAnswer(null); void load() }, [load])
  // The sources the page's filter bar reaches (none while its lists are read): every number below counts these.
  const pending = !!scope?.pending
  const scopeReach = scope?.reach ?? null
  const answer = useMemo(() => (answerRead && !pending ? { ...answerRead, rows: answerRead.rows.filter((r) => placeInReach(r, scopeReach)) } : null), [answerRead, pending, scopeReach])
  useAdsSync(['ads.rule.changed'], () => { void load() }, paused)

  const reach = useMemo(() => new Map<string, RuleReach | null>(rules.map((r) => [r.id, r.reach])), [rules])
  const [search, setSearch] = useState(() => params.get('sq') ?? '')
  useEffect(() => {
    const t = window.setTimeout(() => { if ((params.get('sq') ?? '') !== search) setQuery({ sq: search.trim() ? search : null }) }, 250)
    return () => window.clearTimeout(t)
  }, [search]) // eslint-disable-line react-hooks/exhaustive-deps
  const raw = showProp ?? params.get('show')
  const show: HarvestSourcesShow | null = isSourcesShow(raw) ? raw : null
  const rows = useMemo(() => answer?.rows ?? [], [answer])
  const shown = useMemo(() => visibleSources(rows, show, search), [rows, show, search])
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])

  const onTotalsRef = useRef(onTotals)
  onTotalsRef.current = onTotals
  /** The counts' window: the read's own (HCORE S9), else the default. */
  const windowDays = answer?.windowDays ?? SOURCES_WINDOW_DAYS
  useEffect(() => { if (answer) onTotalsRef.current?.(sourcesViewTotals(answer.rows, windowDays)) }, [answer, windowDays])
  // The "Last N d" header reads the window from the grid's context: say it again when a read changes it.
  useEffect(() => { const api = apiRef.current; if (api && !api.isDestroyed()) api.refreshHeader() }, [windowDays])

  // ── tasks ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const [pick, setPick] = useState<Pick | null>(null)
  const [pickValue, setPickValue] = useState('')
  const [task, setTask] = useState<Task | null>(null)
  const [review, setReview] = useState<ReviewState>({ phase: 'ready' })
  const [frozen, setFrozen] = useState<ReviewChange[] | null>(null)
  const [undoBack, setUndoBack] = useState<null | (() => Promise<Record<string, ReviewResult>>)>(null)
  const [undoing, setUndoing] = useState(false)
  useEffect(() => { setPaused(!!task || !!pick) }, [task, pick])

  const apiRef = useRef<GridApi<SourceGridRow> | null>(null)
  /** Where the focus goes back after a review: the control that opened it, else the first row's cell. */
  const opener = useRef<HTMLElement | null>(null)
  const remember = () => { const el = document.activeElement; opener.current = el instanceof HTMLElement && el !== document.body ? el : null }
  const backTarget = useCallback((): HTMLElement | null => {
    if (opener.current?.isConnected && !opener.current.closest('[inert]')) return opener.current
    return document.querySelector<HTMLElement>('.ag-row [col-id="adGroup"]')
  }, [])

  const begin = useCallback((t: Task) => { setFrozen(null); setUndoBack(null); setReview({ phase: 'ready' }); setTask(t) }, [])
  const startPick = useCallback((kind: 'assign' | 'detach', list: HarvestSourceRow[]) => { remember(); setPickValue(''); setPick({ kind, rows: list }) }, [])
  const startPause = useCallback((list: HarvestSourceRow[], pause: boolean) => { remember(); begin({ kind: pause ? 'pause' : 'resume', rows: list }) }, [begin])

  const handlers = useRef<SourcesHandlers>({ market, windowDays: SOURCES_WINDOW_DAYS, held, assign: () => {}, detach: () => {}, pause: () => {} })
  handlers.current = {
    market, windowDays, held,
    assign: (r) => startPick('assign', [r]),
    detach: (r) => startPick('detach', [r]),
    pause: (r, p) => startPause([r], p),
  }
  const context = handlers as SourcesHandlersRef
  const gridRows = useMemo<SourceGridRow[]>(() => shown.map((r) => ({ id: r.id, row: r, h: handlers })), [shown])

  const reviewChanges: ReviewChange[] = useMemo(() => {
    if (!task) return []
    if (frozen) return frozen
    if (task.kind === 'assign') return assignChanges(task.rows, task.rule)
    if (task.kind === 'detach') return detachChanges(task.rows, task.ruleId, reach)
    return pauseChanges(task.rows, task.kind === 'pause')
  }, [task, frozen, reach])

  const after = useCallback(async () => { emitAdsChange('ads.rule.changed'); await load() }, [load])

  const save = useCallback(async () => {
    if (!task) return
    const list = reviewChanges
    const ids = list.map((c) => c.id)
    const results: Record<string, ReviewResult> = {}
    setFrozen(list)
    setReview({ phase: 'saving', done: 0 })
    if (task.kind === 'assign') {
      const out = await assignSources(task.rule.id, ids)
      // The server counts what it changed: none changed = it reads them already.
      for (const id of ids) results[id] = out.ok && out.data.ok ? { ok: true, words: out.data.changed > 0 ? 'Assigned' : 'Already assigned' } : { ok: false, words: out.ok ? out.data.error ?? 'Not assigned' : out.words }
      if (out.ok && out.data.ok) {
        const ruleId = task.rule.id
        setUndoBack(() => async () => {
          const back = await detachSources(ids, ruleId)
          const r = back.ok ? back.data.results.find((x) => x.id === ruleId) : null
          return Object.fromEntries(ids.map((id) => [id, r?.ok ? { ok: true, words: 'Undone: detached' } : { ok: false, words: back.ok ? r?.error ?? 'Not undone' : back.words, verb: 'undone' }]))
        })
      }
    } else if (task.kind === 'detach') {
      const plan = detachPlan(task.rows, task.ruleId, reach)
      const done = new Map<string, string[]>()
      let i = 0
      for (const [ruleId, groupIds] of plan) {
        const out = await detachSources(groupIds, ruleId)
        const r = out.ok ? out.data.results.find((x) => x.id === ruleId) : null
        for (const id of groupIds) {
          const prev = results[id]
          const now: ReviewResult = r?.ok ? { ok: true, words: r.changed > 0 ? 'Detached' : 'Not read by it' } : { ok: false, words: out.ok ? r?.error ?? 'Not detached' : out.words }
          results[id] = prev && !prev.ok ? prev : now
        }
        if (r?.ok) done.set(ruleId, groupIds)
        setReview({ phase: 'saving', done: ++i })
      }
      if (done.size) {
        setUndoBack(() => async () => {
          const back: Record<string, ReviewResult> = {}
          for (const [ruleId, groupIds] of done) {
            const out = await assignSources(ruleId, groupIds)
            for (const id of groupIds) back[id] = out.ok && out.data.ok ? { ok: true, words: 'Undone: assigned' } : { ok: false, words: out.ok ? out.data.error ?? 'Not undone' : out.words, verb: 'undone' }
          }
          return back
        })
      }
    } else if (task.kind === 'pause') {
      const out = await pauseSources(ids, 'paused on the Keyword Harvest page')
      for (const id of ids) {
        results[id] = !out.ok ? { ok: false, words: out.words }
          : out.data.paused.includes(id) ? { ok: true, words: 'Off' }
            : out.data.already.includes(id) ? { ok: true, words: 'Already off' } : { ok: false, words: 'Not found in this business' }
      }
      const pausedNow = out.ok ? out.data.paused : []
      if (pausedNow.length) {
        setUndoBack(() => async () => {
          const back = await resumeSources(pausedNow)
          const ok = back.ok && back.data.resumed === pausedNow.length
          return Object.fromEntries(pausedNow.map((id) => [id, ok ? { ok: true, words: 'Undone: on' } : { ok: false, words: back.ok ? `${back.data.resumed} of ${pausedNow.length} back on` : back.words, verb: 'undone' }]))
        })
      }
    } else {
      const out = await resumeSources(ids)
      const all = out.ok && out.data.resumed === ids.length
      for (const id of ids) results[id] = all ? { ok: true, words: 'On' } : { ok: false, words: out.ok ? `${out.data.resumed} of ${ids.length} turned on: read again` : out.words }
      if (out.ok && out.data.resumed > 0) {
        setUndoBack(() => async () => {
          const back = await pauseSources(ids, 'undo of a resume on the Keyword Harvest page')
          return Object.fromEntries(ids.map((id) => [id, back.ok && (back.data.paused.includes(id) || back.data.already.includes(id)) ? { ok: true, words: 'Undone: off' } : { ok: false, words: back.ok ? 'Not undone' : back.words, verb: 'undone' }]))
        })
      }
    }
    setReview({ phase: 'done', results })
    apiRef.current?.deselectAll()
    await after()
  }, [task, reviewChanges, reach, after])

  const undoDone = useCallback(async () => {
    if (!undoBack || undoing) return
    setUndoing(true)
    const back = await undoBack()
    setUndoing(false); setUndoBack(null)
    setReview((r) => (r.phase === 'done' ? { phase: 'done', results: { ...r.results, ...back } } : r))
    await after()
  }, [undoBack, undoing, after])
  const closeTask = useCallback(() => { setTask(null); setFrozen(null); setUndoBack(null); setReview({ phase: 'ready' }) }, [])

  // ── the grid ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const selected = useMemo(() => selectedIds.flatMap((id) => byId.get(id) ?? []), [selectedIds, byId])
  const [pageSize, setPageSize] = useState(PAGE_SIZE)
  const [pager, setPager] = useState({ page: 1, pageCount: 1 })
  const pageState = useRef<PageState>({ show })
  pageState.current = { show }
  const restoringLastUsed = useRef(false)
  const views = useGridState<PageState>({
    surface: 'ads-harvest-sources',
    // Land on the scope's default view even when it answers after the grid is up (grid audit F7).
    landOnLateDefault: true,
    baseUrl: getBackendUrl(),
    getPageState: () => pageState.current,
    applyPageState: (pg) => { if (!restoringLastUsed.current) setQuery({ show: isSourcesShow(pg?.show) ? pg.show : null }) },
    persistKeys: PERSIST_KEYS,
  })
  const bindViews = useRef(views.bind)
  bindViews.current = views.bind
  const markDirty = views.markDirty
  useEffect(() => { markDirty() }, [markDirty, show])
  const onGridReady = useCallback((e: GridReadyEvent<SourceGridRow>) => {
    apiRef.current = e.api
    restoringLastUsed.current = true
    bindViews.current(e.api)
    restoringLastUsed.current = false
  }, [])
  /** Every row of the page on screen is ticked: then (and only then) offer "Select all N that match" — Terms' rule (S1). */
  const [pageTicked, setPageTicked] = useState(false)
  const readPageTicked = useCallback((api: GridApi<SourceGridRow>) => {
    const size = api.paginationGetPageSize()
    const start = api.paginationGetCurrentPage() * size
    let i = 0, onPage = 0, ticked = 0
    api.forEachNodeAfterFilterAndSort((n) => { if (i >= start && i < start + size && n.data) { onPage++; if (n.isSelected()) ticked++ } i++ })
    setPageTicked(onPage > 0 && ticked === onPage)
  }, [])
  const onPaginationChanged = useCallback((e: { api: GridApi<SourceGridRow> }) => {
    setPager({ page: e.api.paginationGetCurrentPage() + 1, pageCount: Math.max(1, e.api.paginationGetTotalPages()) })
    readPageTicked(e.api)
  }, [readPageTicked])
  const onSelectionChanged = useCallback<NonNullable<NexusGridProps<SourceGridRow>['onSelectionChanged']>>((e) => { setSelectedIds(e.api.getSelectedRows().map((r) => r.id)); readPageTicked(e.api) }, [readPageTicked])
  const onPage = useCallback((n: number) => apiRef.current?.paginationGoToPage(n - 1), [])
  const onPageSize = useCallback((n: number) => { setPageSize(n); apiRef.current?.paginationGoToPage(0) }, [])

  const [prefsOpen, setPrefsOpen] = useState(false)
  const [prefs, setPrefs] = useState<PreferencesValue>(DEFAULT_PREFS)
  const openCustomise = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    setPrefs((cur) => columnStateToPrefs(api.getColumnState(), cur, BRIDGE))
    setPrefsOpen(true)
  }, [])
  const applyPrefs = useCallback((next: PreferencesValue) => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    api.applyColumnState({ state: prefsToColumnState(next, BRIDGE), applyOrder: true })
    setPrefs(next)
  }, [])
  const resetColumns = useCallback(() => { apiRef.current?.resetColumnState(); setPrefs(DEFAULT_PREFS) }, [])
  const columnDialog = useMemo(() => ({ customise: openCustomise, reset: resetColumns }), [openCustomise, resetColumns])
  const filtered = !!show || search.trim() !== ''
  const exportCsv = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    try {
      const out = exportGridCsv(api, `harvest-sources-${oneMarket ?? 'all'}`, { narrowed: filtered })
      toast(`Exported ${plural(out.rows, 'ad group')}`, 'success')
    } catch (e) { toast((e as Error).message, 'danger') }
  }, [oneMarket, filtered, toast])
  const clearFilters = useCallback(() => { setSearch(''); setQuery({ show: null, sq: null }) }, [setQuery])
  const scopeActive = !!scope?.active
  const clearScope = scope?.clear
  const noRowsParams = useMemo(() => (!answer && err
    ? { title: 'Sources not read', message: readError(err) ?? '', action: { label: 'Try again', onClick: () => void load() } }
    : filtered
      ? { title: 'No ad group matches', message: '', action: { label: 'Clear filters', onClick: clearFilters } }
      : scopeActive && clearScope && !!answerRead?.rows.length
        ? { title: FILTER_EMPTY.title, message: '', action: { label: FILTER_EMPTY.clear, onClick: () => clearScope() } }
        : { title: 'No ad group finds search terms here', message: '' }),
  [answer, answerRead, err, load, filtered, clearFilters, scopeActive, clearScope])

  // ── the picker ────────────────────────────────────────────────────────────────────────────────────────────────────
  const pickOptions = useMemo(() => (!pick ? [] : pick.kind === 'assign' ? assignOptions(rules) : detachOptions(pick.rows, reach)), [pick, rules, reach])
  const pickTargets = useMemo(() => {
    if (!pick || !pickValue) return 0
    if (pick.kind === 'assign') return pick.rows.filter((r) => !r.rules.some((x) => x.id === pickValue)).length
    return detachChanges(pick.rows, pickValue, reach).length
  }, [pick, pickValue, reach])
  const pickHeld = !pickValue ? 'Pick a rule' : pickTargets === 0 ? (pick?.kind === 'assign' ? 'These ad groups have this rule already' : 'None of these ad groups has it') : null
  const reviewPick = () => {
    if (!pick || pickHeld) return
    const rule = rules.find((r) => r.id === pickValue)
    setPick(null)
    if (pick.kind === 'assign') begin({ kind: 'assign', rule: { id: pickValue, name: rule?.name ?? pickValue }, rows: pick.rows })
    else begin({ kind: 'detach', ruleId: pickValue, rows: pick.rows })
  }

  // ── the page ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const total = rows.length
  const countText = !oneMarket ? 'Pick a market'
    : !answer ? (err ? 'Not read' : 'Reading…')
      : filtered ? <><b>{shown.length}</b> of <b>{total}</b></>
        : <><b>{total}</b> {total === 1 ? 'ad group' : 'ad groups'}</>
  const scopeStays = task?.kind === 'detach' ? task.rows.filter((r) => r.rules.some((x) => reach.get(x.id) !== 'mapping' && (task.ruleId === EVERY_RULE || x.id === task.ruleId))).length : 0
  const TITLE: Record<Task['kind'], string> = { assign: 'Assign a rule', detach: 'Detach a rule', pause: 'Harvest from here: off', resume: 'Harvest from here: on' }
  const DONE_VERB: Record<Task['kind'], string> = { assign: 'assigned', detach: 'detached', pause: 'turned off', resume: 'turned on' }
  const n = reviewChanges.length
  const SAVE: Record<Task['kind'], string> = {
    assign: `Assign to ${plural(n, 'ad group')}`, detach: `Detach from ${plural(n, 'ad group')}`,
    pause: `Turn off ${plural(n, 'ad group')}`, resume: `Turn on ${plural(n, 'ad group')}`,
  }
  const summary = !task ? null
    : review.phase === 'done' ? null
    : task.kind === 'pause' ? 'Nexus only · until you turn it back on'
      : task.kind === 'detach' && scopeStays ? `${plural(scopeStays, 'ad group')} keep a rule that reaches them by its scope: change its scope in the rule`
        : 'Nexus only · nothing goes to Amazon'
  const allMatch = shown.length

  if (!oneMarket) {
    return (
      <div className={styles.stack}>
        <Banner tone="info" title="Pick one market to see its sources" />
      </div>
    )
  }

  return (
    <div className={styles.stack}>
      {err && answer && <Banner tone="danger" title="Sources not read" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{readError(err)}</Banner>}
      <GridCard
        toolbar={selected.length > 0 ? (
          <GridToolbar count={<span className={styles.line}>{viewSwitch}<span className={styles.count}>{selected.length === allMatch && allMatch > pageSize ? `All ${allMatch} selected` : <>Selected <b>{selected.length}</b> {selected.length === 1 ? 'ad group' : 'ad groups'}</>}</span></span>}>
            <GridSelectionActions>
              <Button size="sm" variant="primary" heldReason={held} onClick={() => startPick('assign', selected)}><Workflow size={14} aria-hidden /> Assign rule…</Button>
              <Button size="sm" variant="secondary" heldReason={held ?? (selected.some((r) => r.rules.length) ? null : 'None of these has a rule')} onClick={() => startPick('detach', selected)}><Unlink size={14} aria-hidden /> Detach rule…</Button>
              <Button size="sm" variant="secondary" heldReason={held ?? pauseHeld(selected, true)} onClick={() => startPause(selected, true)}><Pause size={14} aria-hidden /> Turn off</Button>
              <Button size="sm" variant="secondary" heldReason={held ?? pauseHeld(selected, false)} onClick={() => startPause(selected, false)}><Play size={14} aria-hidden /> Turn on</Button>
              {pageTicked && selected.length < allMatch && (
                <Button size="sm" variant="link" onClick={() => apiRef.current?.selectAll('filtered')}>Select all {allMatch}</Button>
              )}
              <Button size="sm" variant="link" onClick={() => apiRef.current?.deselectAll()}>Clear</Button>
            </GridSelectionActions>
          </GridToolbar>
        ) : (
          <GridToolbar
            count={<span className={styles.line}>{viewSwitch}<span className={styles.count} aria-live="polite">{countText}</span></span>}
            right={(
              <span className={styles.toolbarRight}>
                <GridViewsMenu views={views} />
                {!phone && <Button size="sm" variant="secondary" onClick={openCustomise}><SlidersHorizontal size={14} aria-hidden /> Customise</Button>}
                {!phone && <Button size="sm" variant="secondary" heldReason={answer && rows.length ? null : 'Nothing to export'} onClick={exportCsv}><Download size={14} aria-hidden /> Export</Button>}
              </span>
            )}
          >
            <GridSearchSlot>
              <Input size="sm" type="search" aria-label="Search sources" placeholder="Search" leadingIcon={<Search size={14} aria-hidden />} value={search} onChange={(e) => setSearch(e.target.value)} />
            </GridSearchSlot>
          </GridToolbar>
        )}
        footer={answer && shown.length > pageSize ? <GridPager page={pager.page} pageCount={pager.pageCount} pageSize={pageSize} pageSizes={GRID_PAGE_SIZES} onPage={onPage} onPageSize={onPageSize} /> : undefined}
      >
        {!answer && !err ? (
          <div className={styles.gridSkeleton} role="status" aria-label="Reading the sources">
            <Skeleton height={14} /><Skeleton height={14} /><Skeleton height={14} /><Skeleton height={14} />
          </div>
        ) : (
          <SourcesTable
            rows={gridRows}
            context={context}
            phone={phone}
            selectable={!phone && !held}
            pageSize={pageSize}
            noRowsParams={noRowsParams}
            initialState={views.initialState}
            columnDialog={columnDialog}
            onGridReady={onGridReady}
            onPaginationChanged={onPaginationChanged}
            onSelectionChanged={onSelectionChanged}
          />
        )}
      </GridCard>

      {pick && (
        <Modal
          open
          size="sm"
          title={pick.kind === 'assign' ? 'Assign a rule' : 'Detach a rule'}
          subtitle={plural(pick.rows.length, 'ad group')}
          onClose={() => setPick(null)}
          returnFocusTo={backTarget}
          footer={(
            <>
              <span className="grow" />
              <Button onClick={() => setPick(null)}>Cancel</Button>
              <Button variant="primary" heldReason={pickHeld} onClick={reviewPick}>{pickTargets ? `Review ${plural(pickTargets, 'ad group')}` : 'Review'}</Button>
            </>
          )}
        >
          <Field label="Rule">
            <Listbox
              ariaLabel="Rule"
              placeholder={pickOptions.length ? 'Pick a rule…' : 'No harvest rule'}
              options={pickOptions}
              value={pickValue}
              onChange={setPickValue}
            />
          </Field>
        </Modal>
      )}

      {task && (reviewChanges.length > 0 || review.phase !== 'ready') && (
        <ReviewChangesModal
          open
          changes={reviewChanges}
          state={review}
          title={TITLE[task.kind]}
          summary={summary}
          doneVerb={DONE_VERB[task.kind]}
          saveLabel={SAVE[task.kind]}
          returnFocusTo={backTarget}
          onSave={() => void save()}
          onClose={closeTask}
          onUndo={undoBack ? () => void undoDone() : undefined}
          undoing={undoing}
          onDone={closeTask}
        />
      )}

      {prefsOpen && (
        <PreferencesModal
          open={prefsOpen}
          onClose={() => setPrefsOpen(false)}
          value={prefs}
          onConfirm={applyPrefs}
          allColumns={PREF_SPECS}
          defaultVisible={DEFAULT_PREFS.visibleColumns}
          pageSizeChoices={NO_CHOICES}
          sortFieldOptions={NO_SORT}
          showSticky={false}
          title="Customise columns"
        />
      )}
    </div>
  )
}

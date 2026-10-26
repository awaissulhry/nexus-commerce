'use client'

/**
 * Negative Targeting page — the Rules view (2026-10-11, lane NRVIEW): every rule that stops waste — pauses our keywords
 * (and keeps them paused) or adds negatives for shoppers' search terms — in ONE table, the Brain and Harvest first (read
 * only: their own pages own them). Built like the Bid page's Rules view (`bid/rules/RulesView.tsx`): nothing writes on a
 * click. A mode pick fills a draft ("Review N changes…"); archive, unarchive, an Undo, a decision on waiting asks, an edit
 * of a rule's fields and a new rule each open the DS `ReviewChangesModal` — one table Now → New, a counted Save, Done
 * with Undo.
 *
 * New rule and Edit (Owner 2026-10-11, wave 4): the OLD rule builder, its negative-targeting type, exactly as it was, as
 * a full page — with its one extra section, "Stop waste — may run alone". Opening it is a step in the history: Back
 * closes it, a refresh keeps it. A rule made in another builder (a Bid rule that pauses) opens that builder.
 *
 * URL: `?rule=<id>&tab=<tab>` the open detail (open = push, Prev / Next and tabs = replace: `useDetailParam`) ·
 * `?archived=1` · `?q=` the search · the builder: `?builder=new` (a new rule), `?ruleId=<id>` (edit a rule here),
 * `?builder=<slug>&ruleId=<id>` (a rule made in another builder).
 *
 * Focus (audit M10): every review, the builder and the detail give the focus back to what opened
 * them — the control in the detail, the row's cell, or the toolbar button.
 *
 * The redesign (2026-10-26, BRIEF D5, D7, D8, D15, D16): the same grid card as the Wasting view —
 *   toolbar   [Wasting | Stopped | Words | Rules] · "4 rules" · Search · Archived      New rule · density · Customise · Views
 *             · status (the right side one group: on a narrow card it takes the next line, right-aligned)
 *   ticked    "2 ticked" · Mode… · Archive… (Unarchive… in the Archived list) · Clear; the density and New rule step aside
 *   grid      two-line rows at the remembered density; the pager under it, always; under the card one note in the
 *             columns' own words
 *   export    the page header's Export ▾ (This view as CSV · Ticked rows as CSV): this view hands its items up
 *   phone     the same columns scrolling sideways, no ticks; the search on its own line
 * The rule builder page stays exactly as it was (Owner 2026-10-11).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { AlertCircle, Archive, ArchiveRestore, Plus, Search, SearchX, SlidersHorizontal } from 'lucide-react'
import { Button, Input, Pill } from '@/design-system/primitives'
import { Banner, EmptyState, EntityPath, Listbox, useNarrow, useToast, type EntityLinkComponent, type ListboxPanelOption, type MenuItemDef } from '@/design-system/components'
import {
  EditModeBar, GridToolbar, PreferencesModal, ReviewChangesModal,
  type DetailNav, type PreferencesValue, type ReviewChange, type ReviewResult, type ReviewState,
} from '@/design-system/patterns'
import {
  DEFAULT_GRID_DENSITY, downloadCsv, GRID_DENSITIES, GridCard, GridDensityProvider, GridDensityToggle, GridPager, GridSearchSlot, GridSelectionActions, GridViewsMenu,
  cellOf, columnStateToPrefs, displayedRowIds, exportGridCsv, gridCsvRows, gridCsvSourceFromApi, prefsToColumnState, useGridState,
  type GridApi, type GridDensityName, type GridReadyEvent, type GridStateKey, type NexusGridProps, type PrefsBridgeOptions,
} from '@/design-system/grid'
import { usePermission } from '@/lib/auth/AuthProvider'
import Link from '@/lib/workspaces/Link'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { useDetailParam } from '../../../_shared/useDetailParam'
import { emitAdsChange } from '../../_shared/adsBus'
import { FILTER_EMPTY, FILTER_HIDES_RULE, narrowRules } from '../../_shared/scopeFilter/scopeFilterModel'
import type { ScopeView } from '../../_shared/scopeFilter/useScopeFilter'
import { MODES, MODE_WORD, type BidMode } from '../../bid/rules/bidRulesModel'
import { fetchSuggestions, fetchUndoPreview } from '../../bid/rules/ruleApi'
import { useWasteReview } from '../waste/useWasteReview'
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, pagerWords, tickedCount } from '../waste/wasteModel'
import pageStyles from '../negatives.module.css'
import {
  archiveRule, fetchWasteRules, restoreSuggestion, saveModes, unarchiveRule, undoChange,
} from './wasteRulesApi'
import {
  archiveWords, changeFromTo, isFiltered, isPseudo, plural, readError, RULES_NOTE, visibleRows,
  type ArchiveAnswer, type WasteRuleChange, type WasteRuleRow, type WasteRulesAnswer,
} from './wasteRulesModel'
import {
  archivable, archiveLabel, archiveReviewChanges, modeConflicts, modeGroups, modeReviewChanges, modeUndoLabel, pickMode, pickModeFor,
  raiseAck, retidyModes, shownMode, unarchivable, unarchiveLabel, unarchiveReviewChanges, waitsOf, type ModeDraft,
} from './wasteRuleChanges'
import { RULE_PREFERENCE_COLUMNS, WasteRulesTable, type GridRow, type HandlersRef, type PanelTab, type RulesHandlers } from './WasteRulesTable'
import { RuleDetailPending, WasteRuleModal } from './WasteRuleModal'
import styles from './rules.module.css'

/** The shared rule builder's contract with this view: `ruleId` absent = a new rule; `onClose` / `onSaved` replace its own navigation. */
interface BuilderProps {
  slug: string
  ruleId?: string | null
  initialMarket?: string
  onClose?: () => void
  onSaved?: (id: string, kind: 'created' | 'updated') => void
}
/** The rule builder (lazy: ~94 KB), typed to the contract above. */
const RuleBuilder = dynamic<BuilderProps>(
  () => import('../../_shared/RuleBuilder').then((m) => m.RuleBuilder as unknown as ComponentType<BuilderProps>),
  { ssr: false },
)

const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility', 'sort']
const BRIDGE: PrefsBridgeOptions = { columns: RULE_PREFERENCE_COLUMNS.map((c) => ({ key: c.key, locked: c.locked })) }
const PREF_SPECS = RULE_PREFERENCE_COLUMNS.map((c) => ({ key: c.key, label: c.label, locked: c.locked }))
const DEFAULT_PREFS: PreferencesValue = {
  visibleColumns: RULE_PREFERENCE_COLUMNS.filter((c) => !c.hidden).map((c) => c.key),
  lockedColumns: [],
  stickyFirstColumn: true,
  stickyLastColumn: true,
  pageSize: 0,
  sortBy: '',
  sortDir: 'asc',
}
const NO_CHOICES: number[] = []
const NO_SORT: Array<{ value: string; label: string }> = []
/** What the views remember beside AG's own: the Archived list, the density (D5). */
interface PageState { archived: boolean; density?: GridDensityName }
const isDensity = (v: unknown): v is GridDensityName => (GRID_DENSITIES as readonly unknown[]).includes(v)
const SET_MODE_OPTIONS: ListboxPanelOption[] = MODES.map((m) => ({ value: m, label: MODE_WORD[m] }))
const PANEL_TABS: readonly PanelTab[] = ['overview', 'preview', 'history', 'waiting', 'settings']
const isPanelTab = (v: unknown): v is PanelTab => typeof v === 'string' && (PANEL_TABS as readonly string[]).includes(v)
const WorkspaceLink = Link as unknown as EntityLinkComponent

/** One change under review, and what Done's Undo puts back. */
type Task =
  | { kind: 'mode' }
  | { kind: 'archive'; rows: WasteRuleRow[] }
  | { kind: 'unarchive'; rows: WasteRuleRow[] }
  | { kind: 'undo'; row: WasteRuleRow; change: WasteRuleChange }

const TITLE: Record<Task['kind'], string | undefined> = { mode: undefined, archive: 'Archive', unarchive: 'Unarchive', undo: 'Undo a change' }
const DONE_VERB: Record<Task['kind'], string> = { mode: 'saved', archive: 'archived', unarchive: 'unarchived', undo: 'undone' }
/** The builder type this page makes and edits its rules in (the old builder, exactly as it was). */
const NEG_SLUG = 'negative-targeting'

/** The rules of one market, read once per market (and again after every save). */
function useWasteRules(market: string) {
  const [answer, setAnswer] = useState<WasteRulesAnswer | null>(null)
  const [err, setErr] = useState<string | null>(null)
  /** A read is on its way (the toolbar's "Updating…"). */
  const [reading, setReading] = useState(true)
  const seq = useRef(0)
  const load = useCallback(async (): Promise<WasteRulesAnswer | null> => {
    const mine = ++seq.current
    setReading(true)
    try {
      const a = await fetchWasteRules(market)
      if (mine === seq.current) { setAnswer(a); setErr(null); setReading(false) }
      return a
    } catch (e) {
      if (mine === seq.current) { setErr((e as Error).message); setReading(false) }
      return null
    }
  }, [market])
  useEffect(() => { setAnswer(null); setErr(null); void load() }, [load])
  return { answer, err, reading, load, put: setAnswer }
}

const FOCUSABLE = 'button:not([aria-hidden="true"]), [href], input, [tabindex]:not([tabindex="-1"])'
function focusable(el: Element | null): HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null
  return el.matches(FOCUSABLE) ? el : el.querySelector<HTMLElement>(FOCUSABLE)
}
/** A rule's cell in the table (the pinned Brain and Harvest rows too), or null when the table does not show it. */
function ruleCell(id: string | null | undefined, col = 'rule'): HTMLElement | null {
  if (!id) return null
  return document.querySelector<HTMLElement>(`.ag-row[row-id="${CSS.escape(id)}"] [col-id="${col}"]`)
}

export function WasteRulesView({ market, viewSwitch, scope, onExportItems }: {
  market: string
  /** The page's [Wasting | Stopped | Words | Rules] switch, at the start of the toolbar (optional: the page may show it above). */
  viewSwitch?: ReactNode
  /** The page's filter bar: only the rules that can act on its picks show (and count); the Brain and Harvest rows always. */
  scope?: ScopeView
  /** The redesign (D2): this view's items for the page header's Export ▾ (This view as CSV · Ticked rows as CSV); null
   *  when the view leaves. */
  onExportItems?: (items: MenuItemDef[] | null) => void
}) {
  const router = useRouter()
  const params = useSearchParams()
  const phone = useNarrow()
  const { toast } = useToast()
  const canCampaigns = usePermission('ads.campaigns.manage')
  const canAutomation = usePermission('ads.automation.manage')
  const modeHeld = canAutomation ? null : 'Needs the ads automation permission'
  const archiveHeld = modeHeld
  const undoHeld = canCampaigns ? null : 'Needs the ads campaigns permission'
  const decideHeld = undoHeld

  /** One address change; the rest of the query is kept (the page's view, market, …). */
  const setQuery = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search)
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v) }
    const q = next.toString()
    router.replace(q ? `?${q}` : '?', { scroll: false })
  }, [router])

  // The rules the page's filter bar reaches (the Brain and Harvest rows always; nothing while its lists are read): the
  // table and its counts count these.
  const read = useWasteRules(market)
  const { err, load, put, reading } = read
  const pending = !!scope?.pending
  const scopeReach = scope?.reach ?? null
  const answer = useMemo(() => (read.answer && !pending ? narrowRules(read.answer, scopeReach, isPseudo) : null), [read.answer, pending, scopeReach])
  const [draft, setDraft] = useState<ModeDraft>({})
  const [search, setSearch] = useState(() => params.get('q') ?? '')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [task, setTask] = useState<Task | null>(null)
  const [review, setReview] = useState<ReviewState>({ phase: 'ready' })
  const [problems, setProblems] = useState<string[]>([])
  const [undoing, setUndoing] = useState(false)
  const [undoBack, setUndoBack] = useState<null | (() => Promise<Record<string, ReviewResult>>)>(null)
  /** What Done's Undo does, in words (audit S5: never a bare "Undo"). */
  const [undoLabel, setUndoLabel] = useState<string>('Undo')
  const offerUndo = useCallback((label: string, fn: () => Promise<Record<string, ReviewResult>>) => { setUndoLabel(label); setUndoBack(() => fn) }, [])
  const [frozen, setFrozen] = useState<ReviewChange[] | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const detail = useDetailParam({ key: 'rule', tabKey: 'tab' })
  const panelId = detail.id
  const panelTab: PanelTab = isPanelTab(detail.tab) ? detail.tab : 'overview'
  const showArchived = params.get('archived') === '1'
  // The builder page: a new rule, an edit here, or a rule made in another builder (its own slug).
  const builderParam = params.get('builder')
  const builderRuleId = params.get('ruleId')
  const builder: { slug: string; ruleId: string | null } | null = builderParam === 'new' ? { slug: NEG_SLUG, ruleId: null }
    : builderParam ? { slug: builderParam, ruleId: builderRuleId }
      : builderRuleId ? { slug: NEG_SLUG, ruleId: builderRuleId }
        : null
  const builderKey = builder ? `${builder.slug}:${builder.ruleId ?? 'new'}` : null

  // The search lives in the address too (a link can carry it; switching views keeps it).
  useEffect(() => {
    const t = window.setTimeout(() => { if ((params.get('q') ?? '') !== search) setQuery({ q: search.trim() ? search : null }) }, 250)
    return () => window.clearTimeout(t)
  }, [search]) // eslint-disable-line react-hooks/exhaustive-deps

  const answerRef = useRef(answer)
  answerRef.current = answer
  const rows = useMemo(() => answer?.rules ?? [], [answer])
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])
  // A mode pick of a rule the filter (or the market) no longer shows leaves the draft: "Review N changes" counts only
  // what its review can show.
  useEffect(() => {
    if (!answer) return
    setDraft((d) => (Object.keys(d).every((id) => byId.has(id)) ? d : Object.fromEntries(Object.entries(d).filter(([id]) => byId.has(id)))))
  }, [answer, byId])
  const filter = { search, archived: showArchived }
  const shown = useMemo(() => visibleRows(rows, filter), [rows, search, showArchived]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── focus back (M10) ──────────────────────────────────────────────────────────────────────────────────────────────
  const apiRef = useRef<GridApi<GridRow> | null>(null)
  const focusBack = useRef<{ el: HTMLElement | null; fallback: () => HTMLElement | null } | null>(null)
  const cellFor = useCallback((id: string | null | undefined, col = 'rule'): HTMLElement | null => {
    const dom = ruleCell(id, col)
    if (dom) return dom
    const api = apiRef.current
    return api && id && !api.isDestroyed() ? cellOf(api as never, id, { colId: col }) : null
  }, [])
  const remember = useCallback((fallback: () => HTMLElement | null) => {
    const el = document.activeElement
    focusBack.current = { el: el instanceof HTMLElement && el !== document.body ? el : null, fallback }
  }, [])
  /** Where a review gives the focus back: the opener while it is still there, else its stand-in. */
  const backTarget = useCallback((): HTMLElement | null => {
    const b = focusBack.current
    if (!b) return null
    if (b.el?.isConnected && !b.el.closest('[inert]')) return b.el
    // Its stand-in; when that is gone too (an archived rule leaves the list), the table's first rule.
    return b.fallback() ?? document.querySelector<HTMLElement>('.ag-row [col-id="rule"]')
  }, [])
  const inPanel = (key: string) => () => focusable(document.querySelector(`[data-return="${CSS.escape(key)}"]`))
  const firstCell = () => cellFor(apiRef.current?.getDisplayedRowAtIndex(0)?.data?.id ?? shown.find(isPseudo)?.id ?? null)
  /** Audit S18: a mode review gives the focus back to the changed rule's Mode cell (the first one drafted). */
  const draftedCell = () => { const id = Object.keys(draftRef.current)[0] ?? draftFirst.current; return cellFor(id, 'mode') ?? firstCell() }

  // ── the grid ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const startArchive = useCallback((list: WasteRuleRow[], fallback: () => HTMLElement | null) => {
    remember(fallback)
    setProblems([]); setReview({ phase: 'ready' }); setUndoBack(null); setFrozen(null); setTask({ kind: 'archive', rows: archivable(list) })
  }, [remember])
  const startUnarchive = useCallback((list: WasteRuleRow[], fallback: () => HTMLElement | null) => {
    remember(fallback)
    setProblems([]); setReview({ phase: 'ready' }); setUndoBack(null); setFrozen(null); setTask({ kind: 'unarchive', rows: unarchivable(list) })
  }, [remember])

  const handlers = useRef<RulesHandlers>({ open: () => {}, archive: () => {}, unarchive: () => {}, archiveHeld: null, modeHeld: null, market })
  handlers.current = {
    onMode: modeHeld ? undefined : (g, next) => { if ((MODES as readonly string[]).includes(next)) setDraft((d) => pickMode(d, g.row, next as BidMode)) },
    open: (id, tab) => detail.open(id, tab ?? 'overview'),
    archive: (r) => startArchive([r], () => cellFor(r.id, 'actions')),
    unarchive: (r) => startUnarchive([r], () => cellFor(r.id, 'actions')),
    archiveHeld,
    modeHeld,
    market,
  }
  const context = handlers as HandlersRef

  const gridRows = useMemo<GridRow[]>(() => shown.filter((r) => !isPseudo(r)).map((r) => ({ id: r.id, row: r, mode: shownMode(r, draft), pending: !!draft[r.id], h: handlers })), [shown, draft])
  const pinned = useMemo<GridRow[]>(() => shown.filter(isPseudo).map((r) => ({ id: r.id, row: r, mode: r.mode, pending: false, h: handlers })), [shown])
  const selected = useMemo(() => selectedIds.flatMap((id) => byId.get(id) ?? []), [selectedIds, byId])

  // D5 — the density (Compact · Cozy · Spacious) is remembered with the layout, as on Listings.
  const [density, setDensity] = useState<GridDensityName>(DEFAULT_GRID_DENSITY)
  const pageState = useRef<PageState>({ archived: showArchived, density })
  pageState.current = { archived: showArchived, density }
  const restoringLastUsed = useRef(false)
  const views = useGridState<PageState>({
    surface: 'ads-neg-rules',
    // Land on the scope's default view even when it answers after the grid is up (grid audit F7).
    landOnLateDefault: true,
    baseUrl: getBackendUrl(),
    getPageState: () => pageState.current,
    applyPageState: (pg) => {
      if (pg && isDensity(pg.density)) setDensity(pg.density)
      if (!restoringLastUsed.current) setQuery({ archived: pg?.archived ? '1' : null })
    },
    persistKeys: PERSIST_KEYS,
  })
  const lastDensity = views.lastUsed?.page?.density
  useEffect(() => { if (isDensity(lastDensity)) setDensity(lastDensity) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const bindViews = useRef(views.bind)
  bindViews.current = views.bind
  const markDirty = views.markDirty
  useEffect(() => { markDirty() }, [markDirty, showArchived, density])

  // D7 — the pager (the grid pages the rules; the Brain and Harvest rows are pinned and not paged).
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE)
  const [pager, setPager] = useState({ page: 1, pageCount: 1 })
  const onPaginationChanged = useCallback<NonNullable<NexusGridProps<GridRow>['onPaginationChanged']>>((e) => {
    if (e.api.isDestroyed()) return
    const next = { page: e.api.paginationGetCurrentPage() + 1, pageCount: Math.max(1, e.api.paginationGetTotalPages()) }
    setPager((cur) => (cur.page === next.page && cur.pageCount === next.pageCount ? cur : next))
  }, [])
  const onPage = useCallback((n: number) => apiRef.current?.paginationGoToPage(n - 1), [])
  const onPageSize = useCallback((n: number) => { setPageSize(n); apiRef.current?.paginationGoToPage(0) }, [])

  const bindPhone = useRef(phone)
  bindPhone.current = phone
  const onGridReady = useCallback((e: GridReadyEvent<GridRow>) => {
    apiRef.current = e.api
    if (bindPhone.current) return
    restoringLastUsed.current = true
    bindViews.current(e.api)
    restoringLastUsed.current = false
  }, [])
  const onRowClicked = useCallback<NonNullable<NexusGridProps<GridRow>['onRowClicked']>>((e) => { if (e.data) detail.open(e.data.id, 'overview') }, [detail])
  const onCellKeyDown = useCallback<NonNullable<NexusGridProps<GridRow>['onCellKeyDown']>>((e) => {
    const key = e.event as KeyboardEvent | null | undefined
    if (key?.key !== 'Enter' || !e.data || !('column' in e)) return
    const col = e.column.getColId()
    if (col !== 'rule') return
    const target = key.target as HTMLElement | null
    if (target?.closest?.('button, a, input, [role="checkbox"]')) return
    detail.open(e.data.id, 'overview')
  }, [detail])
  const onSelectionChanged = useCallback<NonNullable<NexusGridProps<GridRow>['onSelectionChanged']>>((e) => setSelectedIds(e.api.getSelectedRows().map((r) => r.id)), [])

  // Customise: the DS dialog through the column-state bridge.
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
  const exportCsv = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    try {
      const out = exportGridCsv(api, 'negative-targeting-rules', { narrowed: search.trim() !== '' })
      toast(`${plural(out.rows, 'rule')} exported`, 'success')
    } catch (e) { toast(`Not exported: ${(e as Error).message}`, 'danger') }
  }, [search, toast])
  /** The ticked rules only: the same file, its rows kept to the ticks. */
  const exportTicked = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    try {
      const ticked = new Set(selectedIds)
      const source = gridCsvSourceFromApi(api, { suffix: 'selected' })
      const out = gridCsvRows({ ...source, rows: source.rows.filter((r) => ticked.has(r.key)) }, 'negative-targeting-rules')
      downloadCsv(out.fileName, out.csv)
      toast(`${plural(out.rows, 'rule')} exported`, 'success')
    } catch (e) { toast(`Not exported: ${(e as Error).message}`, 'danger') }
  }, [selectedIds, toast])

  // ── the builder page: opening it is a step in the history (Back closes it); closing goes back over it ──────────────
  const builderPushed = useRef(false)
  /** What the focus goes back to once the builder has gone (the opener's `data-return`), and a rule to open then. */
  const afterBuilder = useRef<{ focus: string | null; open: string | null }>({ focus: null, open: null })
  const openBuilder = useCallback((patch: Record<string, string>, fallback: string) => {
    const ret = (document.activeElement instanceof HTMLElement ? document.activeElement.closest('[data-return]') : null)?.getAttribute('data-return')
    afterBuilder.current = { focus: `[data-return="${CSS.escape(ret ?? fallback)}"]`, open: null }
    const next = new URLSearchParams(window.location.search)
    for (const k of ['builder', 'ruleId']) next.delete(k)
    for (const [k, v] of Object.entries(patch)) next.set(k, v)
    router.push(`?${next.toString()}`, { scroll: false })
    builderPushed.current = true
  }, [router])
  const openNew = useCallback(() => openBuilder({ builder: 'new' }, 'new'), [openBuilder])
  const openEdit = useCallback((id: string, slug: string) => openBuilder(slug === NEG_SLUG ? { ruleId: id } : { builder: slug, ruleId: id }, 'editall'), [openBuilder])
  /** Leave the builder: back over its step when this view pushed it, else (a refresh, a link) drop its keys. */
  const leaveBuilder = useCallback((opened: string | null) => {
    if (builderPushed.current) { builderPushed.current = false; router.back(); return }
    if (!afterBuilder.current.focus && !afterBuilder.current.open) afterBuilder.current.focus = opened ? '[data-return="editall"]' : '[data-return="new"]'
    setQuery({ builder: null, ruleId: null, ...(opened && !params.get('rule') ? { rule: opened, tab: 'overview' } : {}) })
  }, [router, setQuery, params])
  const clearFilters = useCallback(() => { setSearch(''); setQuery({ archived: null, q: null }) }, [setQuery])
  const filtered = isFiltered(filter)
  const scopeActive = !!scope?.active
  const clearScope = scope?.clear
  // M4: a failed read says so (and offers Try again), never "No rules yet". The States board: a DS EmptyState in the grid.
  const emptyState = useMemo(() => (!answer && err
    ? <EmptyState icon={<AlertCircle size={20} aria-hidden />} title="Rules not read" description={readError(err) ?? undefined} action={<Button size="sm" onClick={() => void load()}>Try again</Button>} />
    : filtered
      ? <EmptyState icon={<SearchX size={20} aria-hidden />} title={showArchived && !search.trim() ? 'No archived rules' : 'No rule matches'} action={<Button size="sm" onClick={clearFilters}>Clear filters</Button>} />
      : scopeActive && clearScope
        ? <EmptyState icon={<SearchX size={20} aria-hidden />} title={FILTER_EMPTY.title} action={<Button size="sm" onClick={() => clearScope()}>{FILTER_EMPTY.clear}</Button>} />
        : <EmptyState title="No stop-waste rules yet" action={archiveHeld ? undefined : <Button size="sm" onClick={openNew}>New rule</Button>} />),
  [answer, err, load, filtered, clearFilters, archiveHeld, openNew, showArchived, search, scopeActive, clearScope])

  // ── reviews ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const draftRef = useRef(draft)
  draftRef.current = draft
  const draftFirst = useRef<string | null>(null)
  const startModeReview = useCallback(async (fallback: () => HTMLElement | null) => {
    draftFirst.current = Object.keys(draftRef.current)[0] ?? null
    remember(fallback)
    setProblems([]); setUndoBack(null); setFrozen(null); setTask({ kind: 'mode' }); setReview({ phase: 'reading' })
    const before = new Map((answerRef.current?.rules ?? []).map((r) => [r.id, r]))
    try {
      const fresh = await fetchWasteRules(market)
      const freshById = new Map(fresh.rules.map((r) => [r.id, r]))
      const conflicts = modeConflicts(draftRef.current, before, freshById)
      put(fresh)
      setDraft((d) => retidyModes(d, freshById))
      setReview({ phase: 'ready', conflicts })
    } catch (e) { setReview({ phase: 'failed', error: (e as Error).message }) }
  }, [market, put, remember])

  const startUndo = useCallback(async (row: WasteRuleRow, change: WasteRuleChange) => {
    remember(inPanel(`undo:${change.id}`))
    setProblems([]); setUndoBack(null); setFrozen(null); setTask({ kind: 'undo', row, change }); setReview({ phase: 'reading' })
    if (!change.changeId) { setProblems([change.undoBlocked ?? 'This change has no undo']); setReview({ phase: 'ready' }); return }
    try {
      const p = await fetchUndoPreview(change.changeId)
      setProblems(p.eligible ? [] : [p.reason ?? 'This change cannot be undone'])
      setReview({ phase: 'ready' })
    } catch (e) { setReview({ phase: 'failed', error: (e as Error).message }) }
  }, [remember]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Close the review. */
  const closeTask = useCallback(() => {
    const t = task
    // A mode pick made in the detail is a question for this review only: Cancel (or Done) leaves no draft behind.
    if (t?.kind === 'mode' && panelId) setDraft((d) => { if (!(panelId in d)) return d; const n = { ...d }; delete n[panelId]; return n })
    setTask(null); setReview({ phase: 'ready' }); setUndoBack(null); setProblems([]); setFrozen(null)
  }, [task, panelId])

  const after = useCallback(async () => {
    emitAdsChange('ads.rule.changed')
    // The list first, then the open tab: a tab never reads a rule the list still shows as it was (an archived rule's
    // stored settings are gone).
    const fresh = await load()
    setReloadKey((k) => k + 1)
    if (fresh) setDraft((d) => retidyModes(d, new Map(fresh.rules.map((r) => [r.id, r]))))
  }, [load])

  /** Approve / Reject a rule's waiting asks: the page's ONE decide review (the Wasting record's), Undo included (audit M4). */
  const decide = useWasteReview({ market: market === 'all' ? null : market, after })

  const reviewChanges: ReviewChange[] = useMemo(() => {
    if (!task) return []
    if (frozen) return frozen
    if (task.kind === 'mode') return modeReviewChanges(draft, byId)
    if (task.kind === 'archive') return archiveReviewChanges(task.rows)
    if (task.kind === 'unarchive') return unarchiveReviewChanges(task.rows)
    if (task.kind === 'undo') {
      const c = task.change
      const ft = changeFromTo(c)
      return [{ id: c.id, where: <EntityPath items={[c.portfolio, c.campaign, c.adGroup]} linkAs={WorkspaceLink} label="Where" />, what: `${ft.what} · ${c.target?.name ?? task.row.name}`, now: ft.to, next: ft.from }]
    }
    return []
  }, [task, draft, byId, frozen])

  // A mode review that holds nothing any more (its picks were taken back by the re-read) closes itself.
  const reviewing = !!task && (review.phase !== 'ready' || reviewChanges.length > 0)
  useEffect(() => { if (task?.kind === 'mode' && review.phase === 'ready' && !reviewChanges.length) closeTask() }, [task, review.phase, reviewChanges.length, closeTask])

  const save = useCallback(async () => {
    if (!task) return
    const results: Record<string, ReviewResult> = {}
    const list = reviewChanges
    setFrozen(list)
    setReview({ phase: 'saving', done: 0 })
    let i = 0
    const tickSaved = () => setReview({ phase: 'saving', done: ++i })
    if (task.kind === 'mode') {
      const previous: Record<string, BidMode> = {}
      for (const g of modeGroups(draftRef.current)) {
        const out = await saveModes(g.ids, g.mode)
        for (const id of g.ids) {
          const r = out.ok ? out.results.find((x) => x.id === id) : null
          results[id] = out.ok ? (r?.ok ? { ok: true, words: 'Saved' } : { ok: false, words: r?.error ?? 'Not saved' }) : { ok: false, words: out.words }
          if (results[id].ok) { const row = byId.get(id); if (row) previous[id] = row.mode.set }
          tickSaved()
        }
      }
      setDraft((d) => { const n = { ...d }; for (const id of Object.keys(previous)) delete n[id]; return n })
      if (Object.keys(previous).length) {
        offerUndo(modeUndoLabel(previous), async () => {
          const back: Record<string, ReviewResult> = {}
          for (const g of modeGroups(previous)) {
            const out = await saveModes(g.ids, g.mode)
            for (const id of g.ids) {
              const r = out.ok ? out.results.find((x) => x.id === id) : null
              back[id] = out.ok && r?.ok ? { ok: true, words: `Undone: ${MODE_WORD[g.mode]}` } : { ok: false, words: out.ok ? r?.error ?? 'Not undone' : out.words, verb: 'undone' }
            }
          }
          return back
        })
      }
    } else if (task.kind === 'archive') {
      const done: WasteRuleRow[] = []
      // Its waiting asks expire with it: read them first, so Undo can bring them back (audit S7).
      const pendingIds = new Map<string, string[]>()
      if (task.rows.some((r) => r.waiting > 0)) {
        try {
          const pending = (await fetchSuggestions('pending', 'all')).items
          for (const r of task.rows) pendingIds.set(r.id, pending.filter((x) => x.ruleId === r.id).map((x) => x.id))
        } catch { /* unknown: Undo says the asks did not come back */ }
      }
      for (const r of task.rows) {
        const out = await archiveRule(r.id)
        results[r.id] = out.ok ? { ok: true, words: archiveWords(out.body as ArchiveAnswer) } : { ok: false, words: out.words }
        if (out.ok) done.push(r)
        tickSaved()
      }
      if (done.length) {
        offerUndo(`Undo: unarchive ${done.length}`, async () => {
          const back: Record<string, ReviewResult> = {}
          for (const r of done) {
            const un = await unarchiveRule(r.id)
            if (!un.ok) { back[r.id] = { ok: false, words: un.words, verb: 'undone' }; continue }
            let words = 'Undone: Off'
            if (r.mode.set !== 'OFF') {
              const m = await saveModes([r.id], r.mode.set)
              const res = m.ok ? m.results[0] : null
              words = m.ok && res?.ok ? `Undone: ${MODE_WORD[r.mode.set]}` : `Undone: Off (${MODE_WORD[r.mode.set]} refused: ${m.ok ? res?.error ?? 'refused' : m.words})`
            }
            // The asks that expired with it wait again; when they were not read, say so.
            if (r.waiting > 0) {
              const ids = pendingIds.get(r.id)
              if (!ids) words += ' · its asks did not come back'
              else {
                const outs = await Promise.all(ids.map((id) => restoreSuggestion(id)))
                const back2 = outs.filter((o) => o.ok).length
                words += back2 === ids.length ? ` · ${plural(back2, 'ask')} waiting again` : ` · ${back2} of ${plural(ids.length, 'ask')} waiting again`
              }
            }
            back[r.id] = { ok: true, words, verb: 'undone' }
          }
          return back
        })
      }
    } else if (task.kind === 'unarchive') {
      const done: WasteRuleRow[] = []
      for (const r of task.rows) {
        const out = await unarchiveRule(r.id)
        results[r.id] = out.ok ? { ok: true, words: 'Unarchived at Off', verb: 'unarchived' } : { ok: false, words: out.words }
        if (out.ok) done.push(r)
        tickSaved()
      }
      if (done.length) {
        offerUndo(`Undo: archive ${done.length} again`, async () => {
          const back: Record<string, ReviewResult> = {}
          for (const r of done) {
            const out = await archiveRule(r.id)
            back[r.id] = out.ok ? { ok: true, words: 'Undone: archived' } : { ok: false, words: out.words, verb: 'undone' }
          }
          return back
        })
      }
    } else if (task.kind === 'undo') {
      const out = task.change.changeId ? await undoChange(task.change.changeId) : { ok: false as const, words: 'This change has no undo' }
      results[task.change.id] = out.ok ? { ok: true, words: 'Undone' } : { ok: false, words: out.words, verb: 'undone' }
    }
    setReview({ phase: 'done', results })
    await after()
  }, [task, reviewChanges, byId, after, offerUndo])

  const undoDone = useCallback(async () => {
    if (!undoBack || undoing) return
    setUndoing(true)
    const back = await undoBack()
    setUndoing(false); setUndoBack(null)
    setReview((r) => (r.phase === 'done' ? { phase: 'done', results: { ...r.results, ...back } } : r))
    // Its button is gone: the focus goes to Done (never to the page behind; audit R5).
    requestAnimationFrame(() => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((b) => b.textContent?.trim() === 'Done')?.focus())
    await after()
  }, [undoBack, undoing, after])

  const reviewTitle = task ? TITLE[task.kind] : undefined
  const reviewSummary = !task ? null
    : task.kind === 'mode' ? 'From the next run'
      : task.kind === 'archive' ? 'Its runs and changes are kept'
        : null
  const saveLabel = !task ? undefined
    : task.kind === 'archive' ? archiveLabel(reviewChanges.length)
      : task.kind === 'unarchive' ? unarchiveLabel(reviewChanges.length)
        : task.kind === 'undo' ? 'Undo 1 change'
          : undefined
  const raises = reviewChanges.filter((c) => c.raise).length
  const ack = !raises ? undefined : raiseAck(raises)

  // ── the builder ───────────────────────────────────────────────────────────────────────────────────────────────────
  const builderClose = useCallback(() => {
    void load()
    leaveBuilder(builder?.ruleId ?? null)
  }, [load, leaveBuilder, builder?.ruleId])
  /**
   * Saved: the builder goes and the rule opens in its detail. A new rule's detail says "Rule created" with Undo (archive it
   * again) — in the detail, where it can be reached (audit S3: a toast's Undo sat under the detail's backdrop); "Saved"
   * is a toast.
   */
  const [created, setCreated] = useState<{ id: string; busy: boolean } | null>(null)
  const builderSaved = useCallback((id: string, kind: 'created' | 'updated') => {
    void after()
    afterBuilder.current = { focus: null, open: id }
    leaveBuilder(null)
    if (kind === 'created') setCreated({ id, busy: false })
    else toast('Saved', 'success')
  }, [after, leaveBuilder, toast])
  const undoCreate = useCallback(async () => {
    if (!created || created.busy) return
    setCreated({ ...created, busy: true })
    const out = await archiveRule(created.id)
    if (out.ok) { setCreated(null); toast('Undone: the rule is archived', 'neutral'); detail.close(); void after() } else { setCreated({ ...created, busy: false }); toast(`Not undone: ${out.words}`, 'danger') }
  }, [created, toast, detail, after])
  // Once the builder has gone (closed, saved, or Back): open the saved rule, else give the focus back to its opener.
  useEffect(() => {
    if (builderKey) return
    const next = afterBuilder.current
    afterBuilder.current = { focus: null, open: null }
    builderPushed.current = false
    if (next.open) { detail.open(next.open, 'overview'); return }
    if (!next.focus) return
    // Up to 3 s, as the Bid page does (audit R18): the detail may mount twice after Back, so once placed the focus is held
    // there while it would otherwise be lost (on the page, or a dialog that went); the first key or click ends it.
    const selector = next.focus
    const until = performance.now() + 3000
    let quit = false
    const stop = () => { quit = true }
    document.addEventListener('keydown', stop, { capture: true, once: true })
    document.addEventListener('pointerdown', stop, { capture: true, once: true })
    const lost = () => {
      const a = document.activeElement
      return !a || a === document.body || (a instanceof HTMLElement && (a.classList.contains('nds-modal') || !!a.closest('[inert]') || !a.isConnected))
    }
    let placed = false
    const attempt = () => {
      if (quit) return
      if (!placed || lost()) {
        const el = focusable(document.querySelector(selector))
        if (el && !el.closest('[inert]')) { el.focus(); placed = document.activeElement === el }
      }
      if (performance.now() < until) requestAnimationFrame(attempt)
      else { document.removeEventListener('keydown', stop, { capture: true }); document.removeEventListener('pointerdown', stop, { capture: true }) }
    }
    requestAnimationFrame(attempt)
  }, [builderKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── the detail ────────────────────────────────────────────────────────────────────────────────────────────────────
  /** The rows of the table in the order shown now: the Brain and Harvest first, then the grid's filter and sort. */
  const navIds = (): string[] => {
    const ids = pinned.map((g) => g.id)
    const api = apiRef.current
    if (api && !api.isDestroyed()) ids.push(...displayedRowIds(api as never))
    else ids.push(...gridRows.map((g) => g.id))
    return ids
  }
  const nav: DetailNav = { ids: panelId ? navIds() : [], current: panelId ?? '', noun: 'rule', onGo: (id) => detail.go(id) }

  // ── the page ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const t = answer?.totals
  const draftCount = Object.keys(draft).length
  const panelRow = panelId ? byId.get(panelId) ?? null : null
  const total = showArchived ? t?.archived ?? 0 : t?.rules ?? 0
  const searched = search.trim() !== ''
  // D5 — the count in the DS toolbar's form: "4 rules", "1 of 4" while searching, "2 ticked" while rules are ticked.
  const countText = !answer
    ? (err ? 'Not read' : 'Reading…')
    : selected.length ? tickedCount(selected.length).map((c) => <span key="n"><b>{c.n}</b>{c.words}</span>)
      : searched ? <><b>{gridRows.length}</b> of <b>{total}</b></>
        : <><b>{total}</b> {total === 1 ? 'rule' : 'rules'}</>

  /* ── the header's Export ▾ (D2): this view as CSV, the ticked rules as CSV ── */
  const exportItems = useMemo<MenuItemDef[]>(() => [
    gridRows.length
      ? { id: 'view', label: 'This view as CSV', onSelect: exportCsv }
      : { id: 'view', label: 'This view as CSV', disabled: true, description: 'Nothing to export' },
    selected.length
      ? { id: 'ticked', label: 'Ticked rows as CSV', onSelect: exportTicked }
      : { id: 'ticked', label: 'Ticked rows as CSV', disabled: true, description: 'No rows ticked' },
  ], [gridRows.length, exportCsv, selected.length, exportTicked])
  const onExportRef = useRef(onExportItems)
  onExportRef.current = onExportItems
  // Not while the builder page is open: nothing of the list is on screen then.
  useEffect(() => { onExportRef.current?.(builder ? null : exportItems) }, [exportItems, !!builder]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onExportRef.current?.(null), [])

  /* ── toolbar (D5, D15): the view switch · the count · the search · Archived | New rule · density · Customise · Views ·
     status; ticked: the bulk actions take the search's place, New rule and the density step aside ── */
  // New rule opens the shared rule builder PAGE, exactly as today.
  const newRule = selected.length ? null : <span data-return="new"><Button size="sm" variant="primary" heldReason={archiveHeld} onClick={openNew}><Plus size={14} aria-hidden /> New rule</Button></span>
  const status = <Pill tone={err ? 'danger' : 'success'} dot size="md">{err ? 'Not updating' : reading ? 'Updating…' : 'Up to date'}</Pill>
  const searchBox = (
    <GridSearchSlot>
      <Input size="sm" type="search" aria-label="Search rules" placeholder="Search" leadingIcon={<Search size={14} aria-hidden />} value={search} onChange={(e) => setSearch(e.target.value)} />
    </GridSearchSlot>
  )
  // A filter of the list (consistency #12): after the search.
  const archivedToggle = (
    <Button size="sm" aria-pressed={showArchived} onClick={() => setQuery({ archived: showArchived ? null : '1' })}>
      <Archive size={14} aria-hidden /> Archived{t ? ` ${t.archived}` : ''}
    </Button>
  )

  // The builder is a full page (Owner 2026-10-11): while it is open, nothing of the list is under it to reach by Tab.
  if (builder) {
    return (
      <RuleBuilder
        key={builderKey}
        slug={builder.slug}
        ruleId={builder.ruleId}
        initialMarket={market !== 'all' ? market : undefined}
        onClose={builderClose}
        onSaved={builderSaved}
      />
    )
  }

  return (
    <div className={styles.stack}>
      {/* A re-read that failed while an older answer is on screen says the numbers may be old; a first read that failed
          says so in the table (M4). */}
      {err && answer && <Banner tone="danger" title="Rules not read" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{readError(err)}</Banner>}
      {answer?.note && <Banner tone="info" title={answer.note} />}
      {t && t.otherMarkets > 0 && market !== 'all' && (
        <Banner tone="info" title={`${plural(t.otherMarkets, 'rule')} in other markets`} action={<Button size="sm" variant="secondary" onClick={() => setQuery({ market: null })}>Show all</Button>} />
      )}

      {draftCount > 0 && !modeHeld && (
        <EditModeBar count={draftCount} onDiscard={() => setDraft({})} onApply={() => void startModeReview(draftedCell)} applyLabel={`Review ${plural(draftCount, 'change')}…`} />
      )}

      <div className={pageStyles.cardWrap}>
        <GridCard
          toolbar={(
            <GridToolbar
              wrap
              right={phone ? (
                // A phone: the search (and Archived) take their own line under the bar (the card's narrow rule).
                <>{newRule}{status}{searchBox}{archivedToggle}</>
              ) : (
                // One group (the code's toolbarRight): on a narrow card it takes the next line, right-aligned.
                <span className={styles.toolbarRight}>
                  {newRule}
                  {/* The density steps aside while rules are ticked, as on Listings. */}
                  {!selected.length && <GridDensityToggle value={density} onChange={setDensity} />}
                  <Button size="sm" onClick={openCustomise}><SlidersHorizontal size={13} aria-hidden /> Customise</Button>
                  <GridViewsMenu views={views} />
                  {status}
                </span>
              )}
            >
              {viewSwitch}
              <span className="cnt">{countText}</span>
              {selected.length > 0 ? (
                <GridSelectionActions>
                  {showArchived ? (
                    <Button size="sm" heldReason={archiveHeld} onClick={() => startUnarchive(selected, firstCell)}><ArchiveRestore size={14} aria-hidden /> Unarchive…</Button>
                  ) : (
                    <>
                      {modeHeld
                        ? <Button size="sm" heldReason={modeHeld}>Mode…</Button>
                        : <Listbox size="sm" width={130} ariaLabel="Set the mode of the selected rules" placeholder="Mode…" options={SET_MODE_OPTIONS} value="" onChange={(v) => { if ((MODES as readonly string[]).includes(v)) setDraft((d) => pickModeFor(d, selected, v as BidMode)) }} />}
                      <Button size="sm" heldReason={archiveHeld} onClick={() => startArchive(selected, firstCell)}><Archive size={14} aria-hidden /> Archive…</Button>
                    </>
                  )}
                  <Button size="sm" variant="link" onClick={() => apiRef.current?.deselectAll()}>Clear</Button>
                </GridSelectionActions>
              ) : !phone && <>{searchBox}{archivedToggle}</>}
            </GridToolbar>
          )}
          // D7 — the pager is always there once the rules are read (never over a failed first read).
          footer={answer ? (
            <GridPager page={pager.page} pageCount={pager.pageCount} pageSize={pageSize} pageSizes={PAGE_SIZES}
              left={<span className={pageStyles.pagerWords}>{pagerWords(pager.page, pageSize, gridRows.length)}</span>}
              onPage={onPage} onPageSize={onPageSize} />
          ) : undefined}
        >
          <GridDensityProvider value={density}>
            <WasteRulesTable
              rows={gridRows}
              pinned={pinned}
              context={context}
              phone={phone}
              selectable={!phone && !(modeHeld && archiveHeld)}
              loading={!answer && !err}
              emptyState={emptyState}
              density={density}
              pageSize={pageSize}
              // A phone draws the same columns but never takes the desktop's saved widths and order (D16).
              initialState={phone ? undefined : views.initialState}
              columnDialog={phone ? undefined : columnDialog}
              onGridReady={onGridReady}
              onRowClicked={onRowClicked}
              onCellKeyDown={onCellKeyDown}
              onSelectionChanged={onSelectionChanged}
              onPaginationChanged={onPaginationChanged}
            />
          </GridDensityProvider>
        </GridCard>
        <p className={pageStyles.note}>{RULES_NOTE}</p>
      </div>

      {panelId && (panelRow ? (
        <WasteRuleModal
          row={panelRow}
          tab={panelTab}
          onTab={(tab) => detail.setTab(tab)}
          nav={nav}
          returnFocusTo={() => cellFor(panelId)}
          market={market}
          phone={phone}
          drafted={draft[panelRow.id] ?? null}
          modeHeld={modeHeld}
          archiveHeld={archiveHeld}
          undoHeld={undoHeld}
          decideHeld={decideHeld}
          reloadKey={reloadKey}
          onClose={() => { setCreated(null); detail.close() }}
          onMode={(next) => { setDraft((d) => pickMode(d, panelRow, next)); void startModeReview(inPanel('mode')) }}
          onArchive={() => startArchive([panelRow], inPanel('archive'))}
          onUnarchive={() => startUnarchive([panelRow], inPanel('archive'))}
          onUndo={(c) => void startUndo(panelRow, c)}
          onDecide={(kind, asks) => { remember(inPanel('decide')); decide.ask({ kind: 'decide', decide: kind, waits: waitsOf(asks) }) }}
          onEditBuilder={(slug) => openEdit(panelRow.id, slug)}
          created={created?.id === panelRow.id ? { undo: () => void undoCreate(), busy: created.busy } : null}
        />
      ) : (
        <RuleDetailPending
          loading={!answer && !err}
          error={answer ? (scopeActive ? FILTER_HIDES_RULE : 'This rule is not in this list: it may be in another market, or gone') : err ? 'Rules not read' : null}
          onRetry={() => (answer && scopeActive && clearScope ? clearScope() : answer && market !== 'all' ? setQuery({ market: null }) : void load())}
          onClose={detail.close}
          returnFocusTo={() => null}
        />
      ))}

      {task && reviewing && (
        <ReviewChangesModal
          open
          changes={reviewChanges}
          state={review}
          title={reviewTitle}
          summary={reviewSummary}
          problems={problems}
          ackLabel={ack}
          doneVerb={DONE_VERB[task.kind]}
          size={task.kind === 'undo' ? 'xl' : 'lg'}
          returnFocusTo={backTarget}
          saveLabel={saveLabel}
          onSave={() => void save()}
          onRetry={task.kind === 'mode' ? () => void startModeReview(draftedCell) : task.kind === 'undo' ? () => void startUndo(task.row, task.change) : undefined}
          onClose={() => closeTask()}
          doneActions={review.phase === 'done' && undoBack ? (
            <Button size="sm" variant="secondary" aria-busy={undoing || undefined} onClick={() => { if (!undoing) void undoDone() }}>{undoing ? 'Undoing…' : undoLabel}</Button>
          ) : undefined}
          onDone={() => closeTask()}
        />
      )}

      {decide.review && (
        <ReviewChangesModal
          open
          onClose={decide.close}
          title={decide.review.state.phase === 'done' ? undefined : decide.review.title}
          changes={decide.review.changes}
          state={decide.review.state}
          summary={decide.review.summary}
          problems={decide.review.problems}
          saveLabel={decide.review.saveLabel}
          doneVerb={decide.review.doneVerb}
          ackLabel={decide.review.ackLabel}
          onSave={() => void decide.save()}
          onRetry={decide.retry}
          doneActions={decide.review.state.phase === 'done' && (decide.review.undo || decide.review.noUndo) ? (
            <Button heldReason={decide.review.undo ? null : decide.review.noUndo} aria-busy={decide.review.undoing || undefined} onClick={() => { if (!decide.review?.undoing) void decide.undoSaved() }}>
              {decide.review.undoing ? 'Undoing…' : decide.review.undoLabel ?? 'Undo'}
            </Button>
          ) : undefined}
          returnFocusTo={backTarget}
          // The review's own size (useWasteReview): on a phone the full-screen sheet with each change a stacked card.
          size={decide.size}
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

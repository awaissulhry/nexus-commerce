'use client'

/**
 * Keyword Harvest page — the Rules view (2026-10-11, lane HRULES): the Bid page's Rules view for harvest rules. One table
 * (the brain first), tick boxes and a bulk bar (Mode · Archive / Restore), a centered detail per rule, and the ONE rule
 * editor (the bid builder, its Keyword Harvest type) for "+ New rule" and "Edit". Nothing writes on a click: a mode pick
 * fills a draft ("Review N changes…"); archive, restore, a decision on asks and the Undo of a harvest each open the DS
 * `ReviewChangesModal` — one table Now → New, a counted button, Done with Undo where the API has one.
 *
 * The page frame (header, view switch, tiles) is the page's (lane TERMS): this view reads `show` (the tile that filters)
 * and reports its numbers and tiles through `onTotals` after each read — the same predicates as the filter (audit M1).
 *
 * Address: `?rule=<id>&tab=<tab>` the open detail (Back closes it) · `?show=` the tile (the page's) · `?archived=1` ·
 * `?rq=` the search · `?builder=new` / `?ruleId=<id>` the rule editor.
 *
 * Focus (audit M10): a review, the editor and the detail give the focus back to what opened them — the control in the
 * detail, the row's cell, or the toolbar button.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { Archive, Download, Plus, Search, SlidersHorizontal } from 'lucide-react'
import { Button, Input, Skeleton } from '@/design-system/primitives'
import { Banner, Listbox, useToast, type ListboxPanelOption } from '@/design-system/components'
import {
  EditModeBar, GridToolbar, PreferencesModal, ReviewChangesModal, type DetailNav, type PreferencesValue, type ReviewChange, type ReviewResult, type ReviewState,
} from '@/design-system/patterns'
import {
  GridCard, GridSearchSlot, GridSelectionActions, GridViewsMenu, columnStateToPrefs, displayedRowIds, exportGridCsv, prefsToColumnState, useGridState,
  type GridApi, type GridReadyEvent, type GridStateKey, type NexusGridProps, type PrefsBridgeOptions,
} from '@/design-system/grid'
import { useNarrow } from '@/design-system/components/useNarrow'
import { usePermission } from '@/lib/auth/AuthProvider'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { emitAdsChange } from '../../_shared/adsBus'
import { useDetailParam } from '../../../_shared/useDetailParam'

import { MODES, MODE_WORD, archiveWords, isBrain, plural, readError, type ArchiveAnswer, type BidMode, type BidRuleRow } from '../../bid/rules/bidRulesModel'
import { FILTER_EMPTY, FILTER_HIDES_RULE, narrowRules } from '../../_shared/scopeFilter/scopeFilterModel'
import type { ScopeView } from '../../_shared/scopeFilter/useScopeFilter'
import {
  archivable, archiveLabel, archiveReviewChanges, modeConflicts, restoreLabel, restoreReviewChanges,
  type ModeDraft,
} from '../../bid/rules/ruleChanges'
import { RuleDetailPending } from '../../bid/rules/RulePanel'
import { archiveHarvestRule, readHarvestRules, unarchiveHarvestRule } from '../_shared/harvestApi'
import type { HistoryRow } from '../_shared/types'
import {
  autoCapWords, bulkModeOptions, harvestHeldStep, harvestRaiseAck, isFilteredView, isRulesShow, plainRefusal, rulesViewTotals, visibleHarvestRows,
  type HarvestRulesShow, type HarvestRulesViewTotals,
} from './harvestRulesModel'
import { archiveUndoResult, modeBase, harvestModeReviewChanges, modeable, pickHarvestMode, pickHarvestModeFor, retidyHarvestModes, shownHarvestMode, type ModeBefore } from './harvestRuleChanges'
import { restoreHarvestMode, saveHarvestMode, undoOneHarvest } from './harvestRulesApi'
import { EFFECT_DAYS, useHarvestRules } from './useHarvestRules'
import { HarvestRulePanel } from './HarvestRulePanel'
import {
  HARVEST_RULE_PREFERENCE_COLUMNS, HarvestRulesTable, type HarvestGridRow, type HarvestHandlersRef, type HarvestPanelTab, type HarvestRulesHandlers,
} from './HarvestRulesTable'
import styles from '../../bid/bid.module.css'

/** The one rule editor's contract (lane BUILDER): `ruleId` null = a new rule; `onClose` / `onSaved` replace its navigation. */
interface BuilderProps {
  slug: string
  ruleId?: string | null
  initialMarket?: string
  onClose?: () => void
  onSaved?: (id: string, kind: 'created' | 'updated') => void
}
const RuleBuilder = dynamic<BuilderProps>(
  () => import('../../_shared/RuleBuilder').then((m) => m.RuleBuilder as unknown as ComponentType<BuilderProps>),
  { ssr: false },
)
const BUILDER_SLUG = 'keyword-harvesting'

const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility', 'sort']
const BRIDGE: PrefsBridgeOptions = { columns: HARVEST_RULE_PREFERENCE_COLUMNS.map((c) => ({ key: c.key, locked: c.locked })) }
const PREF_SPECS = HARVEST_RULE_PREFERENCE_COLUMNS.map((c) => ({ key: c.key, label: c.label, locked: c.locked }))
const DEFAULT_PREFS: PreferencesValue = {
  visibleColumns: HARVEST_RULE_PREFERENCE_COLUMNS.filter((c) => !c.hidden).map((c) => c.key),
  lockedColumns: [],
  stickyFirstColumn: true,
  stickyLastColumn: true,
  pageSize: 0,
  sortBy: '',
  sortDir: 'asc',
}
const NO_CHOICES: number[] = []
const NO_SORT: Array<{ value: string; label: string }> = []
const UNDO_TOAST_MS = 10_000

interface PageState { show: HarvestRulesShow | null; archived: boolean }

/** One change under review; `fromDetail`: opened inside a rule's detail (the review stacks on it). */
type Task =
  | { kind: 'mode'; fromDetail: string | null }
  | { kind: 'archive' | 'restore'; rows: BidRuleRow[] }
  | { kind: 'undo'; row: BidRuleRow; harvest: HistoryRow }

const FOCUSABLE = 'button:not([aria-hidden="true"]), [href], input, [tabindex]:not([tabindex="-1"])'
function focusable(el: Element | null): HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null
  return el.matches(FOCUSABLE) ? el : el.querySelector<HTMLElement>(FOCUSABLE)
}
/** A rule's cell in the table (the brain's pinned row carries its id too), or null when the table does not show it. */
function ruleCell(id: string | null | undefined, col = 'rule'): HTMLElement | null {
  if (!id) return null
  return document.querySelector<HTMLElement>(`.ag-row[row-id="${CSS.escape(id)}"] [col-id="${col}"]`)
}

/** Why the bulk pick `step` is held for one of these rules (the same words as the cell's list), or null. */
function harvestHeldStepFor(rows: readonly BidRuleRow[], step: string): string | null {
  return rows.map((r) => harvestHeldStep(r, step)).find((x) => !!x) ?? null
}

export interface HarvestRulesViewProps {
  /** The page's market ('all' = every market). */
  market: string
  /** The tile that filters now (`?show=`, written by the page). */
  show?: string | null
  /** The view's numbers and tiles after each read. */
  onTotals?: (t: HarvestRulesViewTotals) => void
  /** Optional: the page's view switch, drawn at the start of the toolbar (the Bid page's place for it). */
  viewSwitch?: ReactNode
  /** The page's filter bar: only the rules that can act on its picks show (and count); the brain always. */
  scope?: ScopeView
}

export function HarvestRulesView({ market, show: showProp, onTotals, viewSwitch, scope }: HarvestRulesViewProps) {
  const params = useSearchParams()
  const router = useRouter()
  const phone = useNarrow()
  const { toast } = useToast()
  const canCampaigns = usePermission('ads.campaigns.manage')
  const canAutomation = usePermission('ads.automation.manage')
  const modeHeld = !canAutomation ? 'Needs the ads automation permission' : null
  const archiveHeld = canAutomation ? null : 'Needs the ads automation permission'
  const decideHeld = canCampaigns ? null : 'Needs the ads campaigns permission'

  /** One address change; the rest of the query is kept. */
  const setQuery = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(window.location.search)
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v) }
    const q = next.toString()
    router.replace(q ? `?${q}` : '?', { scroll: false })
  }, [router])

  // The rules the page's filter bar reaches (the brain always; nothing while its lists are read): the table, its counts and
  // the tiles count these.
  const read = useHarvestRules(market)
  const pending = !!scope?.pending
  const scopeReach = scope?.reach ?? null
  const narrowed = useMemo(() => (read.answer && !pending ? narrowRules(read.answer, scopeReach, isBrain) : null), [read.answer, pending, scopeReach])
  const data = { ...read, answer: narrowed }
  const { answer, err, load } = data
  const [draft, setDraft] = useState<ModeDraft>({})
  const [search, setSearch] = useState(() => params.get('rq') ?? '')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [task, setTask] = useState<Task | null>(null)
  const [review, setReview] = useState<ReviewState>({ phase: 'ready' })
  const [problems, setProblems] = useState<string[]>([])
  const [undoing, setUndoing] = useState(false)
  const [undoBack, setUndoBack] = useState<null | (() => Promise<Record<string, ReviewResult>>)>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [frozen, setFrozen] = useState<ReviewChange[] | null>(null)

  const show: HarvestRulesShow | null = isRulesShow(showProp ?? params.get('show')) ? (showProp ?? params.get('show')) as HarvestRulesShow : null
  const showArchived = params.get('archived') === '1'
  const detail = useDetailParam({ key: 'rule', tabKey: 'tab' })
  const panelId = detail.id
  const panelTab = (detail.tab ?? 'overview') as HarvestPanelTab
  const builderParam = params.get('builder')
  const builderEditId = params.get('ruleId')
  const builderKey = builderEditId ? `edit:${builderEditId}` : builderParam === 'new' ? 'new' : null

  // The search lives in the address too (a link can carry it).
  useEffect(() => {
    const t = window.setTimeout(() => { if ((params.get('rq') ?? '') !== search) setQuery({ rq: search.trim() ? search : null }) }, 250)
    return () => window.clearTimeout(t)
  }, [search]) // eslint-disable-line react-hooks/exhaustive-deps

  const answerRef = useRef(answer)
  answerRef.current = answer
  const setPaused = data.setPaused
  useEffect(() => { setPaused(!!task || !!builderKey) }, [setPaused, task, builderKey])

  const rows = useMemo(() => answer?.rules ?? [], [answer])
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])
  // A mode pick of a rule the filter (or the market) no longer shows leaves the draft: "Review N changes" counts only
  // what its review can show.
  useEffect(() => {
    if (!answer) return
    setDraft((d) => (Object.keys(d).every((id) => byId.has(id)) ? d : Object.fromEntries(Object.entries(d).filter(([id]) => byId.has(id)))))
  }, [answer, byId])
  const filter = { show, search, archived: showArchived }
  const shown = useMemo(() => visibleHarvestRows(rows, filter), [rows, show, search, showArchived]) // eslint-disable-line react-hooks/exhaustive-deps

  // The page's tiles: the same rows, the same predicates, after each read.
  const onTotalsRef = useRef(onTotals)
  onTotalsRef.current = onTotals
  useEffect(() => { if (answer) onTotalsRef.current?.(rulesViewTotals(answer.rules, answer.totals.otherMarkets)) }, [answer])

  // ── focus back (M10) ──────────────────────────────────────────────────────────────────────────────────────────────
  const apiRef = useRef<GridApi<HarvestGridRow> | null>(null)
  const focusBack = useRef<{ el: HTMLElement | null; fallback: () => HTMLElement | null } | null>(null)
  const remember = useCallback((fallback: () => HTMLElement | null) => {
    const el = document.activeElement
    focusBack.current = { el: el instanceof HTMLElement && el !== document.body ? el : null, fallback }
  }, [])
  /** Where a review gives the focus back: its opener while it is still there, else its stand-in. */
  const backTarget = useCallback((): HTMLElement | null => {
    const b = focusBack.current
    if (!b) return null
    if (b.el?.isConnected && !b.el.closest('[inert]')) return b.el
    return b.fallback()
  }, [])
  const restoreFocus = useCallback(() => {
    const b = focusBack.current
    focusBack.current = null
    if (!b) return
    let tries = 0
    const attempt = () => {
      if (document.querySelector('.nds-review')) { if (tries++ < 40) requestAnimationFrame(attempt); return }
      const target = b.el?.isConnected && !b.el.closest('[inert]') ? b.el : b.fallback()
      if (target) { target.focus(); if (document.activeElement === target) return }
      if (tries++ < 40) requestAnimationFrame(attempt)
    }
    requestAnimationFrame(attempt)
  }, [])
  const inDetail = (key: string) => () => focusable(document.querySelector(`[data-return="${CSS.escape(key)}"]`))
  const firstCell = () => { const id = apiRef.current?.getDisplayedRowAtIndex(0)?.data?.id; return ruleCell(id ?? null) }

  // ── the grid ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const startArchive = useCallback((list: BidRuleRow[], fallback: () => HTMLElement | null) => {
    remember(fallback)
    setProblems([]); setReview({ phase: 'ready' }); setUndoBack(null); setFrozen(null); setTask({ kind: 'archive', rows: archivable(list) })
  }, [remember])
  const startRestore = useCallback((list: BidRuleRow[], fallback: () => HTMLElement | null) => {
    remember(fallback)
    setProblems([]); setReview({ phase: 'ready' }); setUndoBack(null); setFrozen(null); setTask({ kind: 'restore', rows: list.filter((r) => r.archived && !isBrain(r)) })
  }, [remember])
  const openEditor = useCallback((id: string | null, fallback: () => HTMLElement | null) => {
    remember(fallback)
    // One address change (the detail's keys go with it: the editor replaces the detail).
    setQuery({ rule: null, tab: null, builder: id ? null : 'new', ruleId: id })
  }, [remember, setQuery])

  const handlers = useRef<HarvestRulesHandlers>({ open: () => {}, edit: () => {}, archive: () => {}, restore: () => {}, archiveHeld: null, market, effectDays: EFFECT_DAYS })
  handlers.current = {
    onMode: modeHeld ? undefined : (g, next) => { if ((MODES as readonly string[]).includes(next)) setDraft((d) => pickHarvestMode(d, g.row, next as BidMode)) },
    open: (id, tab = 'overview') => detail.open(id, tab),
    edit: (r) => openEditor(r.id, () => ruleCell(r.id, 'actions')),
    archive: (r) => startArchive([r], () => ruleCell(r.id, 'actions')),
    restore: (r) => startRestore([r], () => ruleCell(r.id, 'actions')),
    archiveHeld,
    market,
    effectDays: EFFECT_DAYS,
  }
  const context = handlers as HarvestHandlersRef

  const effects = data.effects
  const gridRows = useMemo<HarvestGridRow[]>(() => shown.filter((r) => !isBrain(r)).map((r) => ({ id: r.id, row: r, mode: shownHarvestMode(r, draft), pending: !!draft[r.id], effect: effects.get(r.id) ?? null, h: handlers })), [shown, draft, effects])
  const brainRow = useMemo<HarvestGridRow | null>(() => {
    const b = shown.find(isBrain)
    return b ? { id: b.id, row: b, mode: b.mode, pending: false, effect: effects.get('brain') ?? null, h: handlers } : null
  }, [shown, effects])
  const selected = useMemo(() => selectedIds.flatMap((id) => byId.get(id) ?? []), [selectedIds, byId])

  const pageState = useRef<PageState>({ show, archived: showArchived })
  pageState.current = { show, archived: showArchived }
  const restoringLastUsed = useRef(false)
  const views = useGridState<PageState>({
    surface: 'ads-harvest-rules',
    baseUrl: getBackendUrl(),
    getPageState: () => pageState.current,
    applyPageState: (pg) => { if (!restoringLastUsed.current) setQuery({ show: isRulesShow(pg?.show) ? pg.show : null, archived: pg?.archived ? '1' : null }) },
    persistKeys: PERSIST_KEYS,
  })
  const bindViews = useRef(views.bind)
  bindViews.current = views.bind
  const markDirty = views.markDirty
  useEffect(() => { markDirty() }, [markDirty, show, showArchived])

  const onGridReady = useCallback((e: GridReadyEvent<HarvestGridRow>) => {
    apiRef.current = e.api
    restoringLastUsed.current = true
    bindViews.current(e.api)
    restoringLastUsed.current = false
  }, [])
  const onRowClicked = useCallback<NonNullable<NexusGridProps<HarvestGridRow>['onRowClicked']>>((e) => { if (e.data) detail.open(e.data.id, 'overview') }, [detail])
  const onCellKeyDown = useCallback<NonNullable<NexusGridProps<HarvestGridRow>['onCellKeyDown']>>((e) => {
    const key = e.event as KeyboardEvent | null | undefined
    if (key?.key !== 'Enter' || !e.data || !('column' in e)) return
    const col = e.column.getColId()
    if (col === 'mode' || col === 'portfolios' || col === 'campaigns' || col === 'adGroups' || col === 'last7' || col.startsWith('ag-Grid') || col === 'actions') return
    const target = key.target as HTMLElement | null
    if (target?.closest?.('button, a, input, [role="checkbox"]')) return
    detail.open(e.data.id, 'overview')
  }, [detail])
  const onSelectionChanged = useCallback<NonNullable<NexusGridProps<HarvestGridRow>['onSelectionChanged']>>((e) => setSelectedIds(e.api.getSelectedRows().map((r) => r.id)), [])

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
      const out = exportGridCsv(api, 'harvest-rules', { narrowed: isFilteredView(filter) })
      toast(`Exported ${plural(out.rows, 'rule')}`, 'success')
    } catch (e) { toast((e as Error).message, 'danger') }
  }, [filter, toast]) // eslint-disable-line react-hooks/exhaustive-deps

  const openNew = useCallback(() => openEditor(null, () => focusable(document.querySelector('[data-return="new"]'))), [openEditor])
  const clearFilters = useCallback(() => { setSearch(''); setQuery({ show: null, archived: null, rq: null }) }, [setQuery])
  const filtered = isFilteredView(filter)
  // M4: a failed read says so (with Try again), never "No harvest rules yet".
  const scopeActive = !!scope?.active
  const clearScope = scope?.clear
  const noRowsParams = useMemo(() => (!answer && err
    ? { title: 'Rules not read', message: readError(err) ?? '', action: { label: 'Try again', onClick: () => void load() } }
    : filtered
      ? { title: 'No rule matches', message: '', action: { label: 'Clear filters', onClick: clearFilters } }
      : scopeActive && clearScope
        ? { title: FILTER_EMPTY.title, message: '', action: { label: FILTER_EMPTY.clear, onClick: () => clearScope() } }
        : { title: 'No harvest rules yet', message: '', action: archiveHeld ? undefined : { label: 'New rule', onClick: openNew } }),
  [answer, err, load, filtered, clearFilters, archiveHeld, openNew, scopeActive, clearScope])

  // ── reviews ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const draftRef = useRef(draft)
  draftRef.current = draft
  const startModeReview = useCallback(async (fromDetail: string | null) => {
    const first = Object.keys(draftRef.current)[0]
    remember(fromDetail ? inDetail('mode') : () => ruleCell(first ?? null, 'mode') ?? firstCell())
    setProblems([]); setUndoBack(null); setFrozen(null); setTask({ kind: 'mode', fromDetail }); setReview({ phase: 'reading' })
    const before = new Map((answerRef.current?.rules ?? []).map((r) => [r.id, r]))
    try {
      const fresh = await readHarvestRules(market)
      const freshById = new Map(fresh.rules.map((r) => [r.id, r]))
      const conflicts = modeConflicts(draftRef.current, before, freshById)
      data.put(fresh)
      setDraft((d) => retidyHarvestModes(d, freshById))
      setReview({ phase: 'ready', conflicts })
    } catch (e) { setReview({ phase: 'failed', error: (e as Error).message }) }
  }, [market, data, remember]) // eslint-disable-line react-hooks/exhaustive-deps

  const closeTask = useCallback(() => {
    const t = task
    // A mode pick made in the detail is a question for this review only: Cancel (or Done) leaves no draft behind.
    if (t?.kind === 'mode' && t.fromDetail) { const id = t.fromDetail; setDraft((d) => { if (!(id in d)) return d; const n = { ...d }; delete n[id]; return n }) }
    setTask(null); setReview({ phase: 'ready' }); setUndoBack(null); setProblems([]); setFrozen(null)
  }, [task])

  const after = useCallback(async () => {
    emitAdsChange('ads.rule.changed')
    setReloadKey((k) => k + 1)
    const fresh = await load()
    if (fresh) setDraft((d) => retidyHarvestModes(d, new Map(fresh.rules.map((r) => [r.id, r]))))
  }, [load])

  const capWords = autoCapWords(data.capPerDay) ?? 'Harvests by itself, inside its caps'
  const reviewChanges: ReviewChange[] = useMemo(() => {
    if (!task) return []
    if (frozen) return frozen
    if (task.kind === 'mode') return harvestModeReviewChanges(draft, byId, capWords)
    if (task.kind === 'archive') return archiveReviewChanges(task.rows)
    if (task.kind === 'restore') return restoreReviewChanges(task.rows)
    if (task.kind !== 'undo') return []
    const h = task.harvest
    return [{ id: h.harvestId, where: h.term, what: 'Harvest', now: 'Live', next: 'Undone', note: h.destination?.campaign?.name ?? 'Blocks lifted · keyword paused' }]
  }, [task, draft, byId, frozen, capWords])

  const reviewing = !!task && (review.phase !== 'ready' || reviewChanges.length > 0)
  useEffect(() => { if (task && review.phase === 'ready' && !reviewChanges.length && task.kind === 'mode') closeTask() }, [task, review.phase, reviewChanges.length, closeTask])

  const save = useCallback(async () => {
    if (!task) return
    const results: Record<string, ReviewResult> = {}
    const list = reviewChanges
    setFrozen(list)
    setReview({ phase: 'saving', done: 0 })
    let i = 0
    if (task.kind === 'mode') {
      // Undo sends the route's `before` back unchanged — level, belt and harvest Auto mark (RS4, delta review D1) — and says
      // what the rule does again: a rule set to Watch whose Manual made it ask is "Ask me" again.
      const previous: Record<string, { shown: BidMode; before: ModeBefore }> = {}
      for (const c of list) {
        const row = byId.get(c.id)
        const next = draftRef.current[c.id]
        if (!row || !next) continue
        const out = await saveHarvestMode(c.id, next)
        results[c.id] = out.ok ? { ok: true, words: 'Saved' } : { ok: false, words: plainRefusal(out.words) }
        // No `before` (an older server): no exact way back, so no Undo for it.
        if (out.ok && out.before) previous[c.id] = { shown: modeBase(row.mode), before: out.before }
        setReview({ phase: 'saving', done: ++i })
      }
      setDraft((d) => { const n = { ...d }; for (const id of Object.keys(previous)) delete n[id]; return n })
      if (Object.keys(previous).length) {
        setUndoBack(() => async () => {
          const back: Record<string, ReviewResult> = {}
          for (const [id, p] of Object.entries(previous)) {
            const out = await restoreHarvestMode(id, p.before)
            back[id] = out.ok ? { ok: true, words: `Undone: ${MODE_WORD[p.shown]}` } : { ok: false, words: plainRefusal(out.words), verb: 'undone' }
          }
          return back
        })
      }
    } else if (task.kind === 'archive' || task.kind === 'restore') {
      const archive = task.kind === 'archive'
      const done: BidRuleRow[] = []
      /** What each archived rule was (the archive answer's `before`, delta review D1): its Undo sends it back unchanged. */
      const wasOf = new Map<string, ModeBefore | null>()
      for (const r of task.rows) {
        const out = archive ? await archiveHarvestRule(r.id) : await unarchiveHarvestRule(r.id)
        results[r.id] = out.ok ? { ok: true, words: archive ? archiveWords(out.data as ArchiveAnswer) : 'Restored at Off' } : { ok: false, words: out.words }
        if (out.ok) { done.push(r); wasOf.set(r.id, (out.data as { before?: ModeBefore }).before ?? null) }
        setReview({ phase: 'saving', done: ++i })
      }
      if (done.length) {
        setUndoBack(() => async () => {
          const back: Record<string, ReviewResult> = {}
          for (const r of done) {
            if (archive) {
              // Unarchived at Off, then what it was sent back unchanged (mode, belt, mark). A refused mode says what really
              // happened — it is back, at Off — never "Undone: Auto".
              const out = await unarchiveHarvestRule(r.id)
              const was = wasOf.get(r.id) ?? null
              const atOff = (was?.mode ?? r.mode.set) === 'OFF'
              const level = out.ok && !atOff ? await restoreHarvestMode(r.id, was) : null
              back[r.id] = archiveUndoResult(out.ok ? { ok: true } : { ok: false, words: out.words }, level, atOff ? 'OFF' : modeBase(r.mode))
            } else {
              const out = await archiveHarvestRule(r.id)
              back[r.id] = out.ok ? { ok: true, words: 'Undone: archived' } : { ok: false, words: out.words, verb: 'undone' }
            }
          }
          return back
        })
      }
    } else if (task.kind === 'undo') {
      const out = await undoOneHarvest(task.harvest.harvestId)
      results[task.harvest.harvestId] = out.ok ? { ok: true, words: out.words ?? 'Undo asked' } : { ok: false, words: out.words }
    }
    setReview({ phase: 'done', results })
    // A bulk action used the selection (/products: the bar goes once it ran).
    if (task.kind === 'archive' || task.kind === 'restore' || (task.kind === 'mode' && !task.fromDetail)) apiRef.current?.deselectAll()
    await after()
  }, [task, reviewChanges, byId, after, market])

  const undoDone = useCallback(async () => {
    if (!undoBack || undoing) return
    setUndoing(true)
    const back = await undoBack()
    setUndoing(false); setUndoBack(null)
    setReview((r) => (r.phase === 'done' ? { phase: 'done', results: { ...r.results, ...back } } : r))
    await after()
  }, [undoBack, undoing, after])

  const TITLE: Record<Task['kind'], string | undefined> = { mode: undefined, archive: 'Archive', restore: 'Restore', undo: 'Undo a harvest' }
  const DONE_VERB: Record<Task['kind'], string> = { mode: 'saved', archive: 'archived', restore: 'restored', undo: 'asked' }
  const reviewSummary = task?.kind === 'mode' ? 'From the next run' : task?.kind === 'undo' ? 'One request, approved by you: lifts its blocks, then pauses the keyword' : null
  const saveLabel = !task ? undefined
    : task.kind === 'archive' ? archiveLabel(reviewChanges.length)
      : task.kind === 'restore' ? restoreLabel(reviewChanges.length)
        : task.kind === 'undo' ? 'Undo 1 harvest' : undefined
  const raises = reviewChanges.filter((c) => c.raise).length
  const ack = raises ? harvestRaiseAck(raises) : undefined

  // ── the editor ────────────────────────────────────────────────────────────────────────────────────────────────────
  const editorClose = useCallback(() => {
    const was = builderKey
    const editedId = was?.startsWith('edit:') ? was.slice(5) : null
    void load()
    // An edit goes back to its rule's detail; a new rule back to where it was opened.
    setQuery({ builder: null, ruleId: null, ...(editedId ? { rule: editedId, tab: 'overview' } : {}) })
    if (!editedId) restoreFocus()
    else focusBack.current = null
  }, [builderKey, load, setQuery, restoreFocus])
  const editorSaved = useCallback((id: string, kind: 'created' | 'updated') => {
    focusBack.current = null
    emitAdsChange('ads.rule.changed')
    void load()
    setQuery({ builder: null, ruleId: null, rule: id, tab: 'overview' })
    if (kind === 'created') {
      const undoCreate = async () => {
        const out = await archiveHarvestRule(id)
        if (out.ok) { toast('Undone: the rule is archived', 'neutral'); detail.close(); void after() } else toast(`Not undone: ${out.words}`, 'danger')
      }
      toast(<span className={styles.toastLine}>Rule created <Button size="xs" variant="link" onClick={() => void undoCreate()}>Undo</Button></span>, 'success', { duration: UNDO_TOAST_MS })
    } else toast('Saved', 'success')
  }, [load, setQuery, detail, toast, after])

  // ── the detail ────────────────────────────────────────────────────────────────────────────────────────────────────
  const navIds = (): string[] => {
    const api = apiRef.current
    const ids = api && !api.isDestroyed() ? displayedRowIds(api) : gridRows.map((g) => g.id)
    return brainRow ? [brainRow.id, ...ids] : ids
  }
  const nav: DetailNav = { ids: panelId ? navIds() : [], current: panelId ?? '', noun: 'rule', onGo: (id) => detail.go(id) }

  // ── the page ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const t = answer?.totals
  const draftCount = Object.keys(draft).length
  const panelRow = panelId ? byId.get(panelId) ?? null : null
  // The Bid page's convention (audit M6): the brain row shows but is not counted — "3 rules" = the tab badge = Rules on's base.
  const total = showArchived ? t?.archived ?? 0 : t?.rules ?? 0
  const searched = search.trim() !== '' || !!show
  const countText = !answer
    ? (err ? 'Not read' : 'Reading…')
    : searched ? <><b>{gridRows.length}</b> of <b>{total}</b></>
      : <><b>{total}</b> {total === 1 ? 'rule' : 'rules'}</>
  const modeTargets = modeable(selected)
  const selArchived = selected.filter((r) => r.archived)

  return (
    <div className={styles.stack}>
      {err && answer && <Banner tone="danger" title="Rules not read" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{readError(err)}</Banner>}


      {draftCount > 0 && !modeHeld && (
        <EditModeBar count={draftCount} onDiscard={() => setDraft({})} onApply={() => void startModeReview(null)} applyLabel={`Review ${plural(draftCount, 'change')}…`} />
      )}

      <GridCard
        toolbar={selected.length > 0 ? (
          <GridToolbar count={<span className={styles.line}>{viewSwitch}<span className={styles.count}>Selected <b>{selected.length}</b></span></span>}>
            <GridSelectionActions>
              {modeHeld || !modeTargets.length
                ? <Button size="sm" variant="secondary" heldReason={modeHeld ?? 'Archived rules have no mode: restore them first'}>Mode</Button>
                : <Listbox size="sm" width={130} ariaLabel="Set the mode of the selected rules" placeholder="Mode…" options={bulkModeOptions(modeTargets) as ListboxPanelOption[]} value="" onChange={(v) => { if ((MODES as readonly string[]).includes(v) && !harvestHeldStepFor(modeTargets, v)) setDraft((d) => pickHarvestModeFor(d, modeTargets, v as BidMode)) }} />}
              {showArchived
                ? <Button size="sm" variant="secondary" heldReason={archiveHeld ?? (selArchived.length ? null : 'None of these is archived')} onClick={() => startRestore(selArchived, firstCell)}><Archive size={14} aria-hidden /> Restore…</Button>
                : <Button size="sm" variant="secondary" heldReason={archiveHeld ?? (archivable(selected).length ? null : 'None of these can be archived')} onClick={() => startArchive(selected, firstCell)}><Archive size={14} aria-hidden /> Archive…</Button>}
              <Button size="sm" variant="link" onClick={() => apiRef.current?.deselectAll()}>Clear</Button>
            </GridSelectionActions>
          </GridToolbar>
        ) : (
          <GridToolbar
            count={<span className={styles.line}>{viewSwitch}<span className={styles.count} aria-live="polite">{countText}</span></span>}
            right={(
              <span className={styles.toolbarRight}>
                {/* Audit S19: no banner row — a small button, and only when this market has no rule of its own. */}
                {t && t.otherMarkets > 0 && market !== 'all' && t.rules === 0 && (
                  <Button size="sm" variant="secondary" onClick={() => setQuery({ market: null })}>+{plural(t.otherMarkets, 'rule')} in other markets</Button>
                )}
                {/* No archived rule: no button (NICE: "Archived 0"); while the archived list is shown it stays, to go back. */}
                {(showArchived || (t?.archived ?? 0) > 0) && (
                  <Button size="sm" variant="secondary" aria-pressed={showArchived} onClick={() => setQuery({ archived: showArchived ? null : '1' })}>
                    <Archive size={14} aria-hidden /> Archived{t ? ` ${t.archived}` : ''}
                  </Button>
                )}
                <GridViewsMenu views={views} />
                {!phone && <Button size="sm" variant="secondary" onClick={openCustomise}><SlidersHorizontal size={14} aria-hidden /> Customise</Button>}
                {!phone && <Button size="sm" variant="secondary" heldReason={answer ? null : 'Nothing read yet'} onClick={exportCsv}><Download size={14} aria-hidden /> Export</Button>}
                <span data-return="new"><Button size="sm" variant="primary" heldReason={archiveHeld} onClick={openNew}><Plus size={14} aria-hidden /> New rule</Button></span>
              </span>
            )}
          >
            <GridSearchSlot>
              <Input size="sm" type="search" aria-label="Search rules" placeholder="Search" leadingIcon={<Search size={14} aria-hidden />} value={search} onChange={(e) => setSearch(e.target.value)} />
            </GridSearchSlot>
          </GridToolbar>
        )}
      >
        {!answer && !err ? (
          <div className={styles.gridSkeleton} role="status" aria-label="Reading the rules">
            <Skeleton height={14} /><Skeleton height={14} /><Skeleton height={14} /><Skeleton height={14} />
          </div>
        ) : (
          <HarvestRulesTable
            rows={gridRows}
            brain={brainRow}
            context={context}
            phone={phone}
            selectable={!phone && (!modeHeld || !archiveHeld)}
            noRowsParams={noRowsParams}
            initialState={views.initialState}
            columnDialog={columnDialog}
            onGridReady={onGridReady}
            onRowClicked={onRowClicked}
            onCellKeyDown={onCellKeyDown}
            onSelectionChanged={onSelectionChanged}
          />
        )}
      </GridCard>

      {panelId && !builderKey && (panelRow ? (
        <HarvestRulePanel
          row={panelRow}
          tab={panelTab}
          onTab={(tab) => detail.setTab(tab)}
          nav={nav}
          returnFocusTo={() => ruleCell(panelId)}
          market={market}
          phone={phone}
          drafted={draft[panelRow.id] ?? null}
          modeHeld={modeHeld}
          archiveHeld={archiveHeld}
          decideHeld={decideHeld}
          capPerDay={data.capPerDay}
          effect={effects.get(isBrain(panelRow) ? 'brain' : panelRow.id) ?? null}
          effectDays={EFFECT_DAYS}
          reloadKey={reloadKey}
          onClose={detail.close}
          onMode={(next) => { setDraft((d) => pickHarvestMode(d, panelRow, next)); void startModeReview(panelRow.id) }}
          onArchive={() => startArchive([panelRow], inDetail('archive'))}
          onRestore={() => startRestore([panelRow], inDetail('archive'))}
          onEdit={() => openEditor(panelRow.id, () => ruleCell(panelRow.id))}
          onChanged={() => void after()}
          onUndo={(h) => { remember(inDetail(`undo:${h.harvestId}`)); setProblems([]); setUndoBack(null); setFrozen(null); setReview({ phase: 'ready' }); setTask({ kind: 'undo', row: panelRow, harvest: h }) }}
          brainMode={rows.find(isBrain)?.mode.set ?? null}
          onOpenBrain={() => detail.open('brain', 'overview')}
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
          title={TITLE[task.kind]}
          summary={reviewSummary}
          problems={problems}
          ackLabel={ack}
          doneVerb={DONE_VERB[task.kind]}
          returnFocusTo={backTarget}
          saveLabel={saveLabel}
          onSave={() => void save()}
          onRetry={task.kind === 'mode' ? () => void startModeReview(task.fromDetail) : undefined}
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

      {builderKey && (
        <RuleBuilder
          slug={BUILDER_SLUG}
          ruleId={builderEditId ?? null}
          initialMarket={market !== 'all' ? market : undefined}
          onClose={editorClose}
          onSaved={editorSaved}
        />
      )}
    </div>
  )
}

'use client'

/**
 * Bid page — the Rules view (2026-10-10): tiles that filter · one table (the brain first) · a side panel per rule · the
 * bid builder. Like the /products page and the Control Room Campaigns tab: nothing writes on a click. A mode pick fills a
 * draft ("Review N changes…"); archive, restore, an Undo, a run's roll back and a decision on a rule's asks each open the
 * DS `ReviewChangesModal` — one table Now → New, a counted Save, Done with Undo.
 *
 * ONE way to make and edit a bid rule (Owner 2026-10-10): the bid builder, mounted on this page — "+ New rule" opens it
 * empty (`?builder=new`), "Edit all" on a rule (`?ruleId=<id>`). A save opens the rule's panel, which says so at its top
 * ("Rule created" with Undo, which archives it again; "Saved") — never a toast, whose Undo sat under the detail's backdrop.
 *
 * URL: `?rule=<id>&tab=<tab>` the open panel · `?show=on|changed|waiting` a tile · `?archived=1` · `?q=` the search ·
 * `?builder=new` / `?ruleId=<id>` the builder (an old `?new=1` lands on `?builder=new`).
 *
 * A rule's detail is the DS `DetailModal` (polish round 2: no side drawer): opening it adds an address (Back closes it),
 * its tabs and Prev / Next replace it. A review opens ON TOP of the detail.
 *
 * Focus (audit M10): every review, the builder and the detail give the focus back to what opened them — the control in
 * the detail, the row's cell (the row now shown, after Prev / Next), or the toolbar button.
 *
 * A market Nexus only reads holds every write here — the mode, archive and restore, New rule and Edit all, approve and
 * reject, Undo and roll back — each with the reason (the shell's `useWriteBlock`, use audit A1): the page's market, or on
 * All markets the rule's own. The Brain's row is left out of a market where it decides nothing (C-UI 3).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { Archive, Plus, Search, SlidersHorizontal } from 'lucide-react'
import { Button, Input } from '@/design-system/primitives'
import { Banner, Listbox, useToast, type ListboxPanelOption } from '@/design-system/components'
import type { DetailNav } from '@/design-system/patterns'
import { EditModeBar, GridToolbar, PreferencesModal, ReviewChangesModal, StepUpModal, type PreferencesValue, type ReviewChange, type ReviewResult, type ReviewState } from '@/design-system/patterns'
import {
  GridCard, GridSearchSlot, GridSelectionActions, GridViewsMenu, columnStateToPrefs, prefsToColumnState, useGridState,
  type GridApi, type GridReadyEvent, type GridStateKey, type NexusGridProps, type PrefsBridgeOptions,
} from '@/design-system/grid'
import { usePermission } from '@/lib/auth/AuthProvider'
import { useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { emitAdsChange } from '../../_shared/adsBus'
import { FILTER_EMPTY, FILTER_HIDES_RULE } from '../../_shared/scopeFilter/scopeFilterModel'
import type { ScopeView } from '../../_shared/scopeFilter/useScopeFilter'
import { useWriteBlock, useWriteBlockOf } from '../../../_shell/WriteBlocked'
import { useColumnChoices } from '../_shared/columnChoices'
import { whenWords } from '../_shared/format'
import {
  MODES, MODE_WORD, archiveWords, brainAskWords, brainIdleHere, brainPickChange, fieldWord, changeFromTo, holdReason, isBrain, isFiltered, isRulesTile,
  plural, readError, visibleRows,
  type ArchiveAnswer, type BidMode, type BidRuleRow, type BrainPick, type RuleChange, type RulesFilter, type RulesTile,
} from './bidRulesModel'
import {
  archivable, archiveLabel, archiveReviewChanges, bulkModeOptions, modeConflicts, modeReviewChanges, pickMode, pickModeFor, raiseAck, restoreLabel,
  restoreReviewChanges, retidyModes, shownMode, type ModeDraft,
} from './ruleChanges'
import {
  archiveRule, askEnrollment, askUndoSupported, decideAsks, decideBrainRequest, fetchRules, fetchUndoPreview, restoreRule, rollbackRun,
  saveMode, unarchiveRule, undoAsks, undoChange, type BrainAsk,
} from './ruleApi'
import { runSummary, type RunRow } from './ruleSettings'
import type { BidRulesData } from './useBidRules'
import {
  approveChanges, approveLabel, decideResults, rejectChanges, rejectLabel, type WaitingAsk,
} from './waitingModel'
import { RuleDetailPending, RulePanel, type AnyTab } from './RulePanel'
import { RulesTable, rulePreferenceColumns, type GridRow, type HandlersRef, type PanelTab, type RulesHandlers } from './RulesTable'
import { followNotice, noticeWords, savedNotice, type SavedNotice } from './savedNotice'
import styles from '../bid.module.css'

/**
 * The bid builder's contract with this page (lane BUILDER): `ruleId` absent = a new rule; `onClose` and `onSaved` replace
 * its own navigation. Until those props land the builder reads `?ruleId=` itself and leaves by navigating to the tab —
 * this page notices the builder's address going and does the same follow-up (see `afterBuilder`).
 */
interface BuilderProps {
  slug: string
  ruleId?: string
  initialMarket?: string
  onClose?: () => void
  onSaved?: (id: string, kind: 'created' | 'updated') => void
}
/** The bid builder (lazy: ~94 KB), typed to the contract above. */
const RuleBuilder = dynamic<BuilderProps>(
  () => import('../../_shared/RuleBuilder').then((m) => m.RuleBuilder as unknown as ComponentType<BuilderProps>),
  { ssr: false },
)

const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility', 'sort']
/** Customise's columns, its bridge and its defaults, for one market or All markets (Market only on All). */
function prefsFor(allMarkets: boolean) {
  const cols = rulePreferenceColumns(allMarkets)
  const bridge: PrefsBridgeOptions = { columns: cols.map((c) => ({ key: c.key, locked: c.locked })) }
  const specs = cols.map((c) => ({ key: c.key, label: c.label, locked: c.locked }))
  const defaults: PreferencesValue = {
    visibleColumns: cols.filter((c) => !c.hidden).map((c) => c.key),
    lockedColumns: [],
    stickyFirstColumn: true,
    stickyLastColumn: true,
    pageSize: 0,
    sortBy: '',
    sortDir: 'asc',
  }
  return { bridge, specs, defaults }
}
const PREFS = { all: prefsFor(true), one: prefsFor(false) }
const NO_CHOICES: number[] = []
const NO_SORT: Array<{ value: string; label: string }> = []

interface PageState { show: RulesTile | null; archived: boolean }
/** The rule whose detail a task came from (the review stacks on it; a mode pick made there is that review's only). */
interface PanelState { id: string; tab: AnyTab }

/** One change under review, and what Done's Undo puts back. */
type Task =
  | { kind: 'mode'; back: PanelState | null }
  | { kind: 'archive'; rows: BidRuleRow[]; back: PanelState | null }
  | { kind: 'restore'; rows: BidRuleRow[]; back: PanelState | null }
  | { kind: 'undo'; row: BidRuleRow; change: RuleChange; back: PanelState | null }
  | { kind: 'rollback'; row: BidRuleRow; run: RunRow; back: PanelState | null }
  | { kind: 'approve' | 'reject'; row: BidRuleRow; asks: WaitingAsk[]; back: PanelState | null }
  | { kind: 'brain'; row: BidRuleRow; pick: BrainPick; back: PanelState | null }

/** A brain request's answer as a Done result; a request whose approve was refused waits — it is rejected, never left. */
async function brainResult(out: { ok: true; body: BrainAsk } | { ok: false; words: string }): Promise<ReviewResult> {
  if (!out.ok) return { ok: false, words: out.words }
  if (out.body.approve?.ok) return { ok: true, words: brainAskWords(out.body) }
  await decideBrainRequest(out.body.approvalId, 'reject')
  return { ok: false, words: out.body.approve?.error ?? 'Not approved' }
}

/** Where the focus goes back to when a review, the builder or a dialog closes and its opener is gone (M10). */
type FocusBack =
  | { kind: 'panel'; key: string }
  | { kind: 'cell'; rowId: string; col: string }
  | { kind: 'grid' }
  | { kind: 'selector'; selector: string }

const FOCUSABLE = 'button:not([aria-hidden="true"]), [href], input, [tabindex]:not([tabindex="-1"])'
/** The element itself when it takes focus, else its first focusable descendant. */
function focusable(el: Element | null): HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null
  return el.matches(FOCUSABLE) ? el : el.querySelector<HTMLElement>(FOCUSABLE)
}
function focusIn(el: Element | null): boolean {
  const target = focusable(el)
  if (!target) return false
  target.focus()
  return document.activeElement === target
}

/** A rule's cell in the table (the brain's pinned row carries its id too), or null when the table does not show it. */
function ruleCell(id: string | null | undefined, col = 'rule'): HTMLElement | null {
  if (!id) return null
  return document.querySelector<HTMLElement>(`.ag-row[row-id="${CSS.escape(id)}"] [col-id="${col}"]`)
}

function usePhone(): boolean {
  const [phone, setPhone] = useState(false)
  useEffect(() => {
    const q = window.matchMedia('(max-width: 639px)')
    const update = () => setPhone(q.matches)
    update()
    q.addEventListener('change', update)
    return () => q.removeEventListener('change', update)
  }, [])
  return phone
}

export function RulesView({ market, data, scope, viewSwitch, setQuery }: {
  market: string
  /** The page's one read of the bid rules (the tiles read it too), narrowed to its filter bar. */
  data: BidRulesData
  /** The page's filter bar: a table it empties says so, with Clear filter. */
  scope?: ScopeView
  /** The page's [Rules | Bids] switch, at the start of the toolbar. */
  viewSwitch: ReactNode
  /** One address change (the page keeps the rest of the query); `push` adds a history entry (opening a detail). */
  setQuery(patch: Record<string, string | null>, opts?: { push?: boolean }): void
}) {
  const params = useSearchParams()
  const phone = usePhone()
  const { toast } = useToast()
  const canCampaigns = usePermission('ads.campaigns.manage')
  const canAutomation = usePermission('ads.automation.manage')
  const canSecurity = usePermission('settings.security.manage')
  // The page's market Nexus only reads: every write is held with that reason; on All markets each rule's own market.
  const pageBlock = useWriteBlock([market])
  const blockOf = useWriteBlockOf()
  const modePerm = !canCampaigns ? 'Needs the ads campaigns permission' : !canAutomation ? 'Needs the ads automation permission' : null
  const modeHeld = modePerm ?? pageBlock
  const archiveHeld = canAutomation ? pageBlock : 'Needs the ads automation permission'
  const undoHeld = canCampaigns ? pageBlock : 'Needs the ads campaigns permission'
  const brainHeld = canAutomation ? pageBlock : 'Needs the ads automation permission'
  const allMarkets = market === 'all'
  const prefsSet = PREFS[allMarkets ? 'all' : 'one']

  const { answer, err, load } = data
  const [draft, setDraft] = useState<ModeDraft>({})
  const [search, setSearch] = useState(() => params.get('q') ?? '')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [task, setTask] = useState<Task | null>(null)
  const [review, setReview] = useState<ReviewState>({ phase: 'ready' })
  const [problems, setProblems] = useState<string[]>([])
  const [undoing, setUndoing] = useState(false)
  const [undoBack, setUndoBack] = useState<null | (() => Promise<Record<string, ReviewResult>>)>(null)
  const [reloadKey, setReloadKey] = useState(0)
  /** The lines under review, held from Save on: a saved pick leaves the draft, its line must stay on the Done screen. */
  const [frozen, setFrozen] = useState<ReviewChange[] | null>(null)
  /** The brain to Auto: the approver's authenticator code, asked on top of the review (the DS one code dialog). */
  const [stepUp, setStepUp] = useState<{ approvalId: string | null; busy: boolean; error: string | null } | null>(null)

  const tileParam = params.get('show')
  const tile: RulesTile | null = isRulesTile(tileParam) ? tileParam : null
  const showArchived = params.get('archived') === '1'
  const panelId = params.get('rule')
  const panelTab = (params.get('tab') ?? 'overview') as AnyTab
  const builderId = params.get('ruleId')
  const builderNew = params.get('builder') === 'new'
  const builderKey = builderId ? `edit:${builderId}` : builderNew ? 'new' : null

  // An old link to the New rule dialog lands on the builder (the dialog is gone: one way to make a rule).
  useEffect(() => { if (params.get('new') === '1') setQuery({ new: null, builder: 'new' }) }, [params, setQuery])

  // The search lives in the address too (Rules → Bids → Rules keeps it; a link can carry it).
  useEffect(() => {
    const t = window.setTimeout(() => { if ((params.get('q') ?? '') !== search) setQuery({ q: search.trim() ? search : null }) }, 250)
    return () => window.clearTimeout(t)
  }, [search]) // eslint-disable-line react-hooks/exhaustive-deps

  const answerRef = useRef(answer)
  answerRef.current = answer
  const setPaused = data.setPaused
  useEffect(() => { setPaused(!!task || !!builderKey) }, [setPaused, task, builderKey])

  // The Brain's row is left out where it decides nothing (C-UI 3); everything else is as read.
  const rows = useMemo(() => (answer?.rules ?? []).filter((r) => !brainIdleHere(r, market)), [answer, market])
  const byId = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows])
  // A mode pick of a rule the filter (or the market) no longer shows leaves the draft: "Review N changes" counts only
  // what its review can show.
  useEffect(() => {
    if (!answer) return
    setDraft((d) => (Object.keys(d).every((id) => byId.has(id)) ? d : Object.fromEntries(Object.entries(d).filter(([id]) => byId.has(id)))))
  }, [answer, byId])
  const filter: RulesFilter = { tile, search, archived: showArchived }
  const shown = useMemo(() => visibleRows(rows, filter), [rows, tile, search, showArchived]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── focus back (M10) ──────────────────────────────────────────────────────────────────────────────────────────────
  const apiRef = useRef<GridApi<GridRow> | null>(null)
  const focusBack = useRef<{ el: HTMLElement | null; then: FocusBack | null } | null>(null)
  const remember = useCallback((then: FocusBack | null) => {
    const el = document.activeElement
    focusBack.current = { el: el instanceof HTMLElement && el !== document.body ? el : null, then }
  }, [])
  const focusCell = useCallback((rowId: string | null, col: string): boolean => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return false
    if (rowId && isBrain({ id: rowId, kind: 'rule' })) { api.setFocusedCell(0, col, 'top'); return true }
    const node = rowId ? api.getRowNode(rowId) : api.getDisplayedRowAtIndex(0)
    if (!node || node.rowIndex == null) return false
    api.ensureNodeVisible(node)
    api.setFocusedCell(node.rowIndex, col)
    return true
  }, [])
  /** Where a review gives the focus back (its `returnFocusTo`, read when it closes): the opener while it is still there,
   *  else its stand-in — the control in the detail, the row's cell, the first row, a toolbar button. */
  const backTarget = useCallback((): HTMLElement | null => {
    const b = focusBack.current
    if (!b) return null
    if (b.el?.isConnected) return b.el
    const t = b.then
    if (t?.kind === 'panel') return focusable(document.querySelector(`[data-return="${CSS.escape(t.key)}"]`))
    if (t?.kind === 'cell') return ruleCell(t.rowId, t.col)
    if (t?.kind === 'grid') { const first = apiRef.current?.getDisplayedRowAtIndex(0)?.data?.id; return ruleCell(first ?? null) }
    if (t?.kind === 'selector') return focusable(document.querySelector(t.selector))
    return null
  }, [])
  /** After the builder has gone: the opener if it is still there, else its stand-in, as soon as it exists. */
  const restoreFocus = useCallback(() => {
    const b = focusBack.current
    focusBack.current = null
    if (!b) return
    // Up to 3 s: after the builder the rules are read again before the detail (and its "Edit all") is back, and the detail
    // may mount twice (audit R18). Once placed, the focus is held there while it would otherwise be lost (on the page or
    // the bare dialog); the first key or click ends it, so it never fights the person.
    const until = performance.now() + 3000
    const more = () => performance.now() < until
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
      // Wait for the review to be gone (its own focus return runs first); never steal focus from a dialog still open.
      if (document.querySelector('.nds-review')) { if (more()) requestAnimationFrame(attempt); return }
      if (placed && !lost()) { if (more()) requestAnimationFrame(attempt); return }
      let done = false
      if (b.el?.isConnected && !b.el.closest('[inert]')) { b.el.focus(); done = document.activeElement === b.el }
      const t = b.then
      if (!done && t?.kind === 'panel') done = focusIn(document.querySelector(`[data-return="${CSS.escape(t.key)}"]`))
      else if (!done && t?.kind === 'cell') done = focusCell(t.rowId, t.col)
      else if (!done && t?.kind === 'grid') done = focusCell(null, 'rule')
      else if (!done && t?.kind === 'selector') done = focusIn(document.querySelector(t.selector))
      placed = placed || done
      if (more()) requestAnimationFrame(attempt)
      else if (!placed && t?.kind === 'panel') focusIn(document.querySelector('[data-drawer-heading]'))
      if (!more()) { document.removeEventListener('keydown', stop, { capture: true }); document.removeEventListener('pointerdown', stop, { capture: true }) }
    }
    requestAnimationFrame(attempt)
  }, [focusCell])

  // ── the grid ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const handlers = useRef<RulesHandlers>({ open: () => {}, archive: () => {}, restore: () => {}, archiveHeld: null, market })
  // Opening a detail adds an address, so Back closes it; closing it goes back that step (no extra entry). Only one detail
  // is open at a time: a rule's clears a bid's.
  const router = useRouter()
  const pushed = useRef(false)
  const open = useCallback((id: string, tab: PanelTab | AnyTab = 'overview') => {
    const already = new URLSearchParams(window.location.search).has('rule')
    if (!already) pushed.current = true
    setQuery({ rule: id, tab, bid: null }, { push: !already })
  }, [setQuery])
  const startArchive = useCallback((list: BidRuleRow[], back: PanelState | null = null, then: FocusBack | null = null) => {
    remember(then ?? (back ? { kind: 'panel', key: 'archive' } : { kind: 'grid' }))
    setProblems([]); setReview({ phase: 'ready' }); setUndoBack(null); setFrozen(null); setTask({ kind: 'archive', rows: archivable(list), back })
  }, [remember])
  const startRestore = useCallback((list: BidRuleRow[], back: PanelState | null = null, then: FocusBack | null = null) => {
    remember(then ?? (back ? { kind: 'panel', key: 'archive' } : { kind: 'grid' }))
    setProblems([]); setReview({ phase: 'ready' }); setUndoBack(null); setFrozen(null); setTask({ kind: 'restore', rows: list.filter((r) => r.archived), back })
  }, [remember])
  handlers.current = {
    // Without the permission the Mode cell only shows; in a market Nexus only reads it shows its lock with the reason (the
    // row's `block`, A1) and takes no pick.
    onMode: modePerm ? undefined : (g, next) => { if (!g.block && (MODES as readonly string[]).includes(next)) setDraft((d) => pickMode(d, g.row, next as BidMode)) },
    open,
    archive: (r) => startArchive([r], null, { kind: 'cell', rowId: r.id, col: 'actions' }),
    restore: (r) => startRestore([r], null, { kind: 'cell', rowId: r.id, col: 'actions' }),
    archiveHeld,
    market,
  }
  const context = handlers as HandlersRef

  const gridRows = useMemo<GridRow[]>(
    () => shown.filter((r) => !isBrain(r)).map((r) => ({ id: r.id, row: r, mode: shownMode(r, draft), pending: !!draft[r.id], h: handlers, block: blockOf([market, r.market]) })),
    [shown, draft, blockOf, market],
  )
  const brainRow = useMemo<GridRow | null>(() => {
    const b = shown.find(isBrain)
    return b ? { id: b.id, row: b, mode: b.mode, pending: false, h: handlers, block: pageBlock } : null
  }, [shown, pageBlock])
  const selected = useMemo(() => selectedIds.flatMap((id) => byId.get(id) ?? []), [selectedIds, byId])

  const pageState = useRef<PageState>({ show: tile, archived: showArchived })
  pageState.current = { show: tile, archived: showArchived }
  const restoringLastUsed = useRef(false)
  const views = useGridState<PageState>({
    surface: 'ads-bid-rules',
    baseUrl: getBackendUrl(),
    getPageState: () => pageState.current,
    // The address wins on load (a tile or a link names what to show): only a NAMED view applies its filter.
    applyPageState: (pg) => { if (!restoringLastUsed.current) setQuery({ show: isRulesTile(pg?.show) ? pg.show : null, archived: pg?.archived ? '1' : null }) },
    persistKeys: PERSIST_KEYS,
  })
  const bindViews = useRef(views.bind)
  bindViews.current = views.bind
  const bindChoices = useColumnChoices('ads-bid-rules', views.initialState)
  const markDirty = views.markDirty
  useEffect(() => { markDirty() }, [markDirty, tile, showArchived])

  const onGridReady = useCallback((e: GridReadyEvent<GridRow>) => {
    apiRef.current = e.api
    restoringLastUsed.current = true
    bindViews.current(e.api)
    restoringLastUsed.current = false
    bindChoices(e.api as unknown as GridApi)
  }, [bindChoices])
  const onRowClicked = useCallback<NonNullable<NexusGridProps<GridRow>['onRowClicked']>>((e) => { if (e.data) open(e.data.id) }, [open])
  const onCellKeyDown = useCallback<NonNullable<NexusGridProps<GridRow>['onCellKeyDown']>>((e) => {
    const key = e.event as KeyboardEvent | null | undefined
    if (key?.key !== 'Enter' || !e.data || !('column' in e)) return
    const col = e.column.getColId()
    if (col === 'mode' || col === 'portfolios' || col === 'campaigns' || col === 'adGroups' || col === 'last7' || col.startsWith('ag-Grid') || col === 'actions') return
    const target = key.target as HTMLElement | null
    if (target?.closest?.('button, a, input, [role="checkbox"]')) return
    open(e.data.id)
  }, [open])
  const onSelectionChanged = useCallback<NonNullable<NexusGridProps<GridRow>['onSelectionChanged']>>((e) => setSelectedIds(e.api.getSelectedRows().map((r) => r.id)), [])

  // Customise: the DS dialog through the column-state bridge.
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [prefs, setPrefs] = useState<PreferencesValue>(prefsSet.defaults)
  const openCustomise = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    setPrefs((cur) => columnStateToPrefs(api.getColumnState(), cur, prefsSet.bridge))
    setPrefsOpen(true)
  }, [prefsSet])
  const applyPrefs = useCallback((next: PreferencesValue) => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    api.applyColumnState({ state: prefsToColumnState(next, prefsSet.bridge), applyOrder: true })
    setPrefs(next)
  }, [prefsSet])
  const resetColumns = useCallback(() => { apiRef.current?.resetColumnState(); setPrefs(prefsSet.defaults) }, [prefsSet])
  const columnDialog = useMemo(() => ({ customise: openCustomise, reset: resetColumns }), [openCustomise, resetColumns])

  const openNew = useCallback(() => { remember({ kind: 'selector', selector: '[data-return="new"]' }); setQuery({ builder: 'new', ruleId: null }) }, [remember, setQuery])
  const clearFilters = useCallback(() => { setSearch(''); setQuery({ show: null, archived: null, q: null }) }, [setQuery])
  const filtered = isFiltered(filter)
  const scopeActive = !!scope?.active
  const clearScope = scope?.clear
  // M4: a failed read says so (and offers Try again), never "No bid rules yet". No second New rule here: the toolbar has
  // it (C-UI 4).
  const noRowsParams = useMemo(() => (!answer && err
    ? { title: 'Rules not read', message: readError(err) ?? '', action: { label: 'Try again', onClick: () => void load() } }
    : filtered
      ? { title: 'No rule matches', message: '', action: { label: 'Clear filters', onClick: clearFilters } }
      : scopeActive && clearScope
        ? { title: FILTER_EMPTY.title, message: '', action: { label: FILTER_EMPTY.clear, onClick: () => clearScope() } }
        : { title: 'No bid rules yet', message: '' }),
  [answer, err, load, filtered, clearFilters, scopeActive, clearScope])

  // ── reviews ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const panelBack = (): PanelState | null => (panelId ? { id: panelId, tab: panelTab } : null)

  const draftRef = useRef(draft)
  draftRef.current = draft
  const startModeReview = useCallback(async (back: PanelState | null) => {
    const first = Object.keys(draftRef.current)[0]
    remember(back ? { kind: 'panel', key: 'mode' } : first ? { kind: 'cell', rowId: first, col: 'mode' } : { kind: 'grid' })
    setProblems([]); setUndoBack(null); setFrozen(null); setTask({ kind: 'mode', back }); setReview({ phase: 'reading' })
    const before = new Map((answerRef.current?.rules ?? []).map((r) => [r.id, r]))
    try {
      const fresh = await fetchRules(market)
      const freshById = new Map(fresh.rules.map((r) => [r.id, r]))
      const conflicts = modeConflicts(draftRef.current, before, freshById)
      data.put(fresh)
      setDraft((d) => retidyModes(d, freshById))
      setReview({ phase: 'ready', conflicts })
    } catch (e) { setReview({ phase: 'failed', error: (e as Error).message }) }
  }, [market, data, remember])

  const startUndo = useCallback(async (row: BidRuleRow, change: RuleChange, back: PanelState | null) => {
    remember(back ? { kind: 'panel', key: `undo:${change.id}` } : { kind: 'grid' })
    setProblems([]); setUndoBack(null); setFrozen(null); setTask({ kind: 'undo', row, change, back }); setReview({ phase: 'reading' })
    if (!change.changeId) { setProblems([change.undoBlocked ?? 'This change has no undo']); setReview({ phase: 'ready' }); return }
    try {
      const p = await fetchUndoPreview(change.changeId)
      setProblems(p.eligible ? [] : [p.reason ?? 'This change cannot be undone'])
      setReview({ phase: 'ready' })
    } catch (e) { setReview({ phase: 'failed', error: (e as Error).message }) }
  }, [remember])

  const closeTask = useCallback(() => {
    const t = task
    const back = t?.back ?? null
    // S19: a mode pick made in the detail is a question for this review only — Cancel (or Done) leaves no draft behind.
    if (t?.kind === 'mode' && back) setDraft((d) => { if (!(back.id in d)) return d; const n = { ...d }; delete n[back.id]; return n })
    // The review closes on top of the detail (still open): its own focus return lands on `backTarget`.
    setTask(null); setReview({ phase: 'ready' }); setUndoBack(null); setProblems([]); setFrozen(null)
  }, [task])

  const after = useCallback(async () => {
    emitAdsChange('ads.rule.changed')
    setReloadKey((k) => k + 1)
    const fresh = await load()
    if (fresh) setDraft((d) => retidyModes(d, new Map(fresh.rules.map((r) => [r.id, r]))))
  }, [load])

  const reviewChanges: ReviewChange[] = useMemo(() => {
    if (!task) return []
    if (frozen) return frozen
    if (task.kind === 'mode') return modeReviewChanges(draft, byId)
    if (task.kind === 'archive') return archiveReviewChanges(task.rows)
    if (task.kind === 'restore') return restoreReviewChanges(task.rows)
    if (task.kind === 'approve') return approveChanges(task.asks)
    if (task.kind === 'reject') return rejectChanges(task.asks)
    if (task.kind === 'undo') {
      const c = task.change
      const ft = changeFromTo(c, task.row.market ?? (market !== 'all' ? market : null))
      return [{ id: c.id, where: [c.target?.name, c.campaign?.name].filter(Boolean).join(' · ') || task.row.name, what: fieldWord(c.field), now: ft.to, next: ft.from }]
    }
    if (task.kind === 'brain') return [brainPickChange(task.pick)]
    if (task.kind === 'rollback') return [{ id: task.run.id, where: `${task.row.name} · ${whenWords(task.run.startedAt)}`, what: 'Run', now: runSummary(task.run), next: 'Reversed' }]
    return []
  }, [task, draft, byId, market, frozen])

  // A review that holds nothing any more (its picks were taken back by the re-read) closes itself.
  const reviewing = !!task && (review.phase !== 'ready' || reviewChanges.length > 0)
  useEffect(() => { if (task && review.phase === 'ready' && !reviewChanges.length && task.kind === 'mode') closeTask() }, [task, review.phase, reviewChanges.length, closeTask])

  /** Undo of a reject: the asks wait again (restore). */
  const undoRejects = useCallback(async (ids: string[]): Promise<Record<string, ReviewResult>> => {
    const out = await decideAsks(ids.map((id) => ({ id, kind: 'restore' as const })))
    const back: Record<string, ReviewResult> = {}
    for (const id of ids) {
      const r = out.ok ? out.results.find((x) => x.id === id) : null
      back[id] = r?.ok ? { ok: true, words: 'Undone: waiting again' } : { ok: false, words: out.ok ? r?.error ?? 'Not undone' : out.words, verb: 'undone' }
    }
    emitAdsChange('ads.suggestion.changed')
    return back
  }, [])
  /** Undo of approvals: the old bids back as the rule's undo (not a person's bid), and the asks wait again (audit R4). */
  const undoApprovals = useCallback(async (ruleId: string, ids: string[]): Promise<Record<string, ReviewResult>> => {
    const back = await undoAsks(ruleId, ids)
    emitAdsChange('ads.bid.changed')
    emitAdsChange('ads.suggestion.changed')
    return back
  }, [])

  const save = useCallback(async () => {
    if (!task) return
    // The brain to Auto is a new bid writer: the code first (the request is sent with it).
    if (task.kind === 'brain' && task.pick.to === 'AUTO') { setStepUp({ approvalId: null, busy: false, error: null }); return }
    const results: Record<string, ReviewResult> = {}
    const list = reviewChanges
    setFrozen(list)
    setReview({ phase: 'saving', done: 0 })
    let i = 0
    if (task.kind === 'mode') {
      const previous: Record<string, BidMode> = {}
      for (const c of list) {
        const row = byId.get(c.id)
        const next = draftRef.current[c.id]
        if (!row || !next) continue
        const out = await saveMode(c.id, next)
        results[c.id] = out.ok ? { ok: true, words: 'Saved' } : { ok: false, words: out.words }
        if (out.ok) previous[c.id] = row.mode.set
        setReview({ phase: 'saving', done: ++i })
      }
      setDraft((d) => { const n = { ...d }; for (const id of Object.keys(previous)) delete n[id]; return n })
      if (Object.keys(previous).length) {
        setUndoBack(() => async () => {
          const back: Record<string, ReviewResult> = {}
          for (const [id, mode] of Object.entries(previous)) {
            const out = await saveMode(id, mode)
            back[id] = out.ok ? { ok: true, words: `Undone: ${MODE_WORD[mode]}` } : { ok: false, words: out.words, verb: 'undone' }
          }
          return back
        })
      }
    } else if (task.kind === 'archive') {
      const done: BidRuleRow[] = []
      for (const r of task.rows) {
        const out = await archiveRule(r.id)
        results[r.id] = out.ok ? { ok: true, words: archiveWords(out.body as ArchiveAnswer) } : { ok: false, words: out.words }
        if (out.ok) done.push(r)
        setReview({ phase: 'saving', done: ++i })
      }
      if (done.length) {
        setUndoBack(() => async () => {
          const back: Record<string, ReviewResult> = {}
          for (const r of done) {
            const out = await restoreRule(r.id, r.mode.set)
            back[r.id] = out.ok ? { ok: true, words: `Undone: ${MODE_WORD[r.mode.set]}` } : { ok: false, words: out.words, verb: 'undone' }
          }
          return back
        })
      }
    } else if (task.kind === 'restore') {
      const done: BidRuleRow[] = []
      for (const r of task.rows) {
        const out = await unarchiveRule(r.id)
        results[r.id] = out.ok ? { ok: true, words: 'Restored at Off' } : { ok: false, words: out.words }
        if (out.ok) done.push(r)
        setReview({ phase: 'saving', done: ++i })
      }
      if (done.length) {
        setUndoBack(() => async () => {
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
    } else if (task.kind === 'approve' || task.kind === 'reject') {
      const kind = task.kind === 'approve' ? 'apply' as const : 'dismiss' as const
      const ids = task.asks.map((a) => a.id)
      const out = await decideAsks(ids.map((id) => ({ id, kind })))
      const gates = new Map(task.asks.map((a) => [a.id, a.gate]))
      Object.assign(results, out.ok ? decideResults(ids, out.results, kind, gates) : Object.fromEntries(ids.map((id) => [id, { ok: false, words: out.words }])))
      const decided = ids.filter((id) => results[id]?.ok)
      const ruleId = task.row.id
      // An approval's Undo only through the rule's own undo route; while the server has none, no Undo (audit R4).
      if (decided.length && (kind === 'dismiss' || await askUndoSupported(ruleId))) {
        setUndoBack(() => (kind === 'dismiss' ? () => undoRejects(decided) : () => undoApprovals(ruleId, decided)))
      }
      emitAdsChange('ads.suggestion.changed')
      if (kind === 'apply') emitAdsChange('ads.bid.changed')
    } else if (task.kind === 'brain') {
      // Back to Watch: a brake, asked and approved in one click (no code); going back to Auto would need it again.
      results[task.pick.id] = await brainResult(await askEnrollment(task.pick.id, 'shadow'))
    } else if (task.kind === 'rollback') {
      const out = await rollbackRun(task.run.id)
      results[task.run.id] = out.ok ? { ok: true, words: String(out.body) } : { ok: false, words: out.words }
    }
    setReview({ phase: 'done', results })
    await after()
  }, [task, reviewChanges, byId, after, undoRejects, undoApprovals])

  const undoDone = useCallback(async () => {
    if (!undoBack || undoing) return
    setUndoing(true)
    const back = await undoBack()
    setUndoing(false); setUndoBack(null)
    setReview((r) => (r.phase === 'done' ? { phase: 'done', results: { ...r.results, ...back } } : r))
    await after()
  }, [undoBack, undoing, after])

  /** The code dialog's answer: ask (or approve the waiting request) with the code; a refused code keeps the dialog. */
  const submitCode = useCallback(async (code: string) => {
    if (!task || task.kind !== 'brain' || !stepUp) return
    const pick = task.pick
    setStepUp({ ...stepUp, busy: true, error: null })
    let approved: { executeAfter?: string } | null = null
    if (stepUp.approvalId) {
      const out = await decideBrainRequest(stepUp.approvalId, 'approve', code)
      if (!out.ok) { setStepUp({ approvalId: stepUp.approvalId, busy: false, error: out.words }); return }
      approved = out
    } else {
      const out = await askEnrollment(pick.id, 'live', code)
      if (!out.ok) {
        setStepUp(null); setFrozen(reviewChanges)
        setReview({ phase: 'done', results: { [pick.id]: { ok: false, words: out.words } } })
        return
      }
      if (!out.body.approve?.ok) { setStepUp({ approvalId: out.body.approvalId, busy: false, error: out.body.approve?.error ?? 'Not approved' }); return }
      approved = out.body
    }
    setStepUp(null)
    setFrozen(reviewChanges)
    setReview({ phase: 'done', results: { [pick.id]: { ok: true, words: brainAskWords(approved) } } })
    setUndoBack(() => async () => {
      const r = await brainResult(await askEnrollment(pick.id, 'shadow'))
      return { [pick.id]: r.ok ? { ok: true, words: `Undone: ${MODE_WORD.WATCH}` } : { ...r, verb: 'undone' } }
    })
    await after()
  }, [task, stepUp, reviewChanges, after])
  /** Cancel the code: a request already waiting for it is rejected (never left behind); the review stays open. */
  const cancelCode = useCallback(async () => {
    const waiting = stepUp?.approvalId
    setStepUp(null)
    if (waiting) await decideBrainRequest(waiting, 'reject')
  }, [stepUp])

  const TITLE: Record<Task['kind'], string | undefined> = { mode: undefined, archive: 'Archive', restore: 'Restore', undo: 'Undo a change', rollback: 'Roll back a run', approve: 'Approve asks', reject: 'Reject asks', brain: 'Brain' }
  const reviewTitle = task ? TITLE[task.kind] : ''
  // §2: one line at most under the title — only a mode change says when it takes effect.
  const reviewSummary = task?.kind === 'mode' ? 'From the next run' : null
  const saveLabel = !task ? undefined
    : task.kind === 'archive' ? archiveLabel(reviewChanges.length)
      : task.kind === 'restore' ? restoreLabel(reviewChanges.length)
        : task.kind === 'undo' ? 'Undo 1 change'
          : task.kind === 'rollback' ? 'Roll back 1 run'
            : task.kind === 'approve' ? approveLabel(reviewChanges.length)
              : task.kind === 'reject' ? rejectLabel(reviewChanges.length)
                : task.kind === 'brain' ? (task.pick.to === 'AUTO' ? 'Approve with code' : 'Save 1 change') : undefined
  const raises = reviewChanges.filter((c) => c.raise).length
  /** What the Done line counts a result as when its words name no verb ("1 archived", "2 approved"). */
  const DONE_VERB: Record<Task['kind'], string> = { mode: 'saved', archive: 'archived', restore: 'restored', undo: 'undone', rollback: 'rolled back', approve: 'approved', reject: 'rejected', brain: 'approved' }
  const ack = !raises ? undefined : task?.kind === 'brain' ? 'I understand: the Brain becomes this campaign’s one bid writer' : raiseAck(raises)
  // Auto for a campaign: held by the server switch (the brain row's own reason) or the approver's permission.
  const brainRowNow = rows.find(isBrain)
  const brainAutoHeld = brainRowNow?.mode.autoLocked ? holdReason(brainRowNow.mode.autoLocked) : canSecurity ? null : 'Needs the security permission: Auto takes your authenticator code'

  // ── the builder ───────────────────────────────────────────────────────────────────────────────────────────────────
  const builderClosedHere = useRef(false)
  /** What the rule's detail says after a save ("Rule created" with Undo, or "Saved"): at its top, never a toast. */
  const [notice, setNotice] = useState<SavedNotice | null>(null)
  const noticeSeen = useRef(false)
  useEffect(() => {
    const f = followNotice(notice, noticeSeen.current, panelId)
    noticeSeen.current = f.seen
    if (!f.keep && notice) setNotice(null)
  }, [notice, panelId])
  const undoCreate = useCallback(async () => {
    if (!notice || notice.kind !== 'created' || notice.busy) return
    const id = notice.id
    setNotice({ ...notice, busy: true, error: null })
    const out = await archiveRule(id)
    if (!out.ok) { setNotice((n) => (n?.id === id ? { ...n, busy: false, error: out.words } : n)); return }
    setNotice(null)
    toast('Undone: the rule is archived', 'neutral')
    setQuery({ rule: null, tab: null })
    void after()
  }, [notice, toast, setQuery, after])
  /** The builder has gone: a save opens the rule (and says so), a close goes back where it was opened. */
  const afterBuilder = useCallback((was: string, saved: { id: string; kind: 'created' | 'updated' } | null) => {
    const editedId = was.startsWith('edit:') ? was.slice(5) : null
    void load()
    emitAdsChange('ads.rule.changed')
    if (saved) {
      focusBack.current = null
      setQuery({ builder: null, ruleId: null, new: null, rule: saved.id, tab: 'overview' })
      setNotice(savedNotice(saved.id, saved.kind))
      return
    }
    // Back to "Edit all" in the rule's detail — never to the builder's own control that held the focus (it is still on the
    // page for a moment, so `remember` would pick it and the focus fell to the dialog when it went; audit R18).
    if (editedId) { setQuery({ builder: null, ruleId: null, rule: editedId, tab: 'settings' }); focusBack.current = { el: null, then: { kind: 'panel', key: 'editall' } } }
    else {
      setQuery({ builder: null, ruleId: null })
      const b = focusBack.current
      if (b?.el && b.el.closest('.h10-rb')) focusBack.current = { el: null, then: b.then }
    }
    restoreFocus()
  }, [load, setQuery, restoreFocus])
  const prevBuilder = useRef(builderKey)
  useEffect(() => {
    const was = prevBuilder.current
    prevBuilder.current = builderKey
    if (!was || builderKey) return
    if (builderClosedHere.current) { builderClosedHere.current = false; return }
    // Today's builder leaves by navigating to the tab: the same follow-up as its onClose.
    afterBuilder(was, null)
  }, [builderKey, afterBuilder])
  const builderClose = useCallback(() => {
    if (!builderKey) return
    builderClosedHere.current = true
    afterBuilder(builderKey, null)
  }, [builderKey, afterBuilder])
  const builderSaved = useCallback((id: string, kind: 'created' | 'updated') => {
    if (!builderKey) return
    builderClosedHere.current = true
    afterBuilder(builderKey, { id, kind })
  }, [builderKey, afterBuilder])

  // ── the detail ────────────────────────────────────────────────────────────────────────────────────────────────────
  /** The rows of the table in the order shown now (the brain first, then the grid's filter and sort): Prev / Next. */
  const navIds = (): string[] => {
    const head: string[] = brainRow ? [brainRow.id] : []
    const ids = [...head]
    const api = apiRef.current
    if (api && !api.isDestroyed()) api.forEachNodeAfterFilterAndSort((n) => { if (n.data) ids.push(n.data.id) })
    // The grid has not taken the new read yet (a rule just made, audit R18): the read's own order, so "3 of 5" shows.
    if (!api || api.isDestroyed() || (panelId && !ids.includes(panelId))) return [...head, ...gridRows.map((g) => g.id)]
    return ids
  }
  const nav: DetailNav = { ids: panelId ? navIds() : [], current: panelId ?? '', noun: 'rule', onGo: (id) => setQuery({ rule: id }) }
  /** A tab's address: this page's query with the rule and the tab (a link tab replaces it). */
  const tabHref = (tab: AnyTab): string => {
    const q = new URLSearchParams(params.toString())
    if (panelId) q.set('rule', panelId)
    q.set('tab', tab)
    return `?${q.toString()}`
  }
  useEffect(() => { if (!panelId) pushed.current = false }, [panelId])
  const closeDetail = useCallback(() => {
    if (pushed.current) { pushed.current = false; router.back() } else setQuery({ rule: null, tab: null })
  }, [setQuery, router])

  // ── the page ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const t = answer?.totals
  const draftCount = Object.keys(draft).length
  const panelRow = panelId ? byId.get(panelId) ?? null : null
  const total = showArchived ? t?.archived ?? 0 : t?.rules ?? 0
  const searched = search.trim() !== '' || !!tile
  // S12: the Archived view counts archived rules (the pressed Archived button says which); a search or a tile says
  // "1 of 4" of the same set. Short words in one width, so the search box never moves (NICE).
  const countText = !answer
    ? (err ? 'Not read' : 'Reading…')
    : searched ? <><b>{gridRows.length}</b> of <b>{total}</b></>
      : <><b>{total}</b> {total === 1 ? 'rule' : 'rules'}</>
  const newButton = <Button size="sm" variant="primary" heldReason={archiveHeld} onClick={openNew}><Plus size={14} aria-hidden /> New rule</Button>
  // The selection's writes: held by the permission, the page's market, or a ticked rule's market Nexus only reads.
  const selBlock = selected.length ? blockOf([market, ...selected.map((r) => r.market)]) : null
  const bulkModeHeld = modeHeld ?? selBlock
  const bulkArchiveHeld = archiveHeld ?? selBlock
  const bulkModes: ListboxPanelOption[] = bulkModeOptions(selected)
  // The open rule's writes: its own market too (a rule in a market Nexus only reads, under All markets).
  const panelBlock = panelRow && !isBrain(panelRow) ? blockOf([market, panelRow.market]) : pageBlock

  return (
    <div className={styles.stack}>
      {/* A re-read that failed while an older answer is on screen: say the numbers may be old. A first read that failed
          says so in the table (M4). */}
      {err && answer && <Banner tone="danger" title="Rules not read" action={<Button size="sm" variant="secondary" onClick={() => void load()}>Try again</Button>}>{readError(err)}</Banner>}

      {t && t.otherMarkets > 0 && market !== 'all' && (
        <Banner tone="info" title={`${plural(t.otherMarkets, 'rule')} in other markets`} action={<Button size="sm" variant="secondary" onClick={() => setQuery({ market: null })}>Show all</Button>} />
      )}

      {draftCount > 0 && !modeHeld && (
        <EditModeBar count={draftCount} onDiscard={() => setDraft({})} onApply={() => void startModeReview(null)} applyLabel={`Review ${plural(draftCount, 'change')}…`} />
      )}

      <GridCard
        toolbar={selected.length > 0 ? (
          <GridToolbar count={<span className={styles.lead}>{viewSwitch}<span className={styles.count}>Selected <b>{selected.length}</b></span></span>}>
            <GridSelectionActions>
              {bulkModeHeld
                ? <Button size="sm" variant="secondary" heldReason={bulkModeHeld}>Mode…</Button>
                : <Listbox size="sm" width={130} ariaLabel="Set mode of the selected rules" placeholder="Mode…" options={bulkModes} value="" onChange={(v) => { if ((MODES as readonly string[]).includes(v)) setDraft((d) => pickModeFor(d, selected, v as BidMode)) }} />}
              <Button size="sm" variant="secondary" heldReason={bulkArchiveHeld} onClick={() => startArchive(selected)}><Archive size={14} aria-hidden /> Archive…</Button>
              <Button size="sm" variant="link" onClick={() => apiRef.current?.deselectAll()}>Clear</Button>
            </GridSelectionActions>
          </GridToolbar>
        ) : (
          <GridToolbar
            count={<span className={styles.lead}>{viewSwitch}<span className={styles.count} aria-live="polite">{countText}</span></span>}
            right={(
              <span className={styles.toolbarRight}>
                <Button size="sm" variant="secondary" aria-pressed={showArchived} onClick={() => setQuery({ archived: showArchived ? null : '1' })}>
                  <Archive size={14} aria-hidden /> Archived{t ? ` ${t.archived}` : ''}
                </Button>
                <GridViewsMenu views={views} />
                <Button size="sm" variant="secondary" onClick={openCustomise}><SlidersHorizontal size={14} aria-hidden /> Customise</Button>
                <span data-return="new">{newButton}</span>
              </span>
            )}
          >
            <GridSearchSlot>
              <Input size="sm" type="search" aria-label="Search rules" placeholder="Search" fieldClassName={styles.searchField} leadingIcon={<Search size={14} aria-hidden />} value={search} onChange={(e) => setSearch(e.target.value)} />
            </GridSearchSlot>
          </GridToolbar>
        )}
      >
        {/* The first read: the table's header with the loading lines under it, so loading looks like loaded (S10). */}
        <RulesTable
            rows={gridRows}
            brain={brainRow}
            context={context}
            phone={phone}
            allMarkets={allMarkets}
            loading={!answer && !err}
            selectable={!modeHeld || !archiveHeld}
            noRowsParams={noRowsParams}
            initialState={views.initialState}
            columnDialog={columnDialog}
            onGridReady={onGridReady}
            onRowClicked={onRowClicked}
            onCellKeyDown={onCellKeyDown}
            onSelectionChanged={onSelectionChanged}
          />
      </GridCard>

      {panelId && !builderKey && (panelRow ? (
        <RulePanel
          row={panelRow}
          tab={panelTab}
          onTab={(tab) => setQuery({ tab })}
          tabHref={tabHref}
          nav={nav}
          returnFocusTo={() => ruleCell(panelId)}
          market={market}
          phone={phone}
          drafted={draft[panelRow.id] ?? null}
          canMode={!(modeHeld ?? panelBlock)}
          modeHeld={modeHeld ?? panelBlock}
          archiveHeld={archiveHeld ?? panelBlock}
          editHeld={panelBlock}
          undoHeld={undoHeld ?? panelBlock}
          reloadKey={reloadKey}
          onClose={closeDetail}
          onMode={(next) => { setDraft((d) => pickMode(d, panelRow, next)); void startModeReview(panelBack()) }}
          onArchive={() => startArchive([panelRow], panelBack())}
          onRestore={() => startRestore([panelRow], panelBack())}
          onUndo={(c) => void startUndo(panelRow, c, panelBack())}
          onRollback={(run) => { remember({ kind: 'panel', key: 'runs' }); setProblems([]); setUndoBack(null); setFrozen(null); setReview({ phase: 'ready' }); setTask({ kind: 'rollback', row: panelRow, run, back: panelBack() }) }}
          onEditAll={() => { remember({ kind: 'panel', key: 'editall' }); setQuery({ rule: null, tab: null, builder: null, ruleId: panelRow.id }) }}
          decideHeld={undoHeld ?? panelBlock}
          onDecide={(kind, asks) => { remember({ kind: 'panel', key: 'decide' }); setProblems([]); setUndoBack(null); setFrozen(null); setReview({ phase: 'ready' }); setTask({ kind, row: panelRow, asks, back: panelBack() }) }}
          brainHeld={brainHeld}
          brainAutoHeld={brainAutoHeld}
          onBrainPick={(pick) => { remember({ kind: 'panel', key: `brain:${pick.id}` }); setProblems([]); setUndoBack(null); setFrozen(null); setReview({ phase: 'ready' }); setTask({ kind: 'brain', row: panelRow, pick, back: panelBack() }) }}
          notice={notice?.id === panelRow.id ? {
            words: noticeWords(notice), busy: notice.busy, onUndo: () => void undoCreate(),
            onDismiss: () => { setNotice(null); requestAnimationFrame(() => focusIn(document.querySelector('[data-drawer-heading]'))) },
          } : null}
        />
      ) : (
        <RuleDetailPending
          loading={!answer && !err}
          error={answer ? (scopeActive ? FILTER_HIDES_RULE : 'This rule is not in this list: it may be in another market, or gone') : err ? 'Rules not read' : null}
          onRetry={() => (answer && scopeActive && clearScope ? clearScope() : answer && market !== 'all' ? setQuery({ market: null }) : void load())}
          onClose={closeDetail}
          returnFocusTo={() => null}
        />
      ))}

      {task && reviewing && (
        <ReviewChangesModal
          open
          changes={reviewChanges}
          state={review}
          title={reviewTitle || undefined}
          summary={reviewSummary}
          problems={problems}
          ackLabel={ack}
          doneVerb={DONE_VERB[task.kind]}
          returnFocusTo={backTarget}
          saveLabel={saveLabel}
          onSave={() => void save()}
          onRetry={task.kind === 'mode' ? () => void startModeReview(task.back) : task.kind === 'undo' ? () => void startUndo(task.row, task.change, task.back) : undefined}
          onClose={closeTask}
          onUndo={undoBack ? () => void undoDone() : undefined}
          undoing={undoing}
          onDone={closeTask}
        />
      )}

      {task?.kind === 'brain' && stepUp && (
        <StepUpModal
          open
          title="Brain on Auto"
          sentence={`${task.pick.name}: the Brain becomes its one bid writer. Approving it takes the code from your authenticator app.`}
          busy={stepUp.busy}
          error={stepUp.error}
          confirmLabel="Approve"
          onSubmit={(code) => void submitCode(code)}
          onClose={() => void cancelCode()}
        />
      )}

      {prefsOpen && (
        <PreferencesModal
          open={prefsOpen}
          onClose={() => setPrefsOpen(false)}
          value={prefs}
          onConfirm={applyPrefs}
          allColumns={prefsSet.specs}
          defaultVisible={prefsSet.defaults.visibleColumns}
          pageSizeChoices={NO_CHOICES}
          sortFieldOptions={NO_SORT}
          showSticky={false}
          title="Customise columns"
        />
      )}

      {builderKey && (
        <RuleBuilder
          slug="bid"
          ruleId={builderId ?? undefined}
          initialMarket={market !== 'all' ? market : undefined}
          onClose={builderClose}
          onSaved={builderSaved}
        />
      )}
    </div>
  )
}

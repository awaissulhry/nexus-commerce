'use client'

/**
 * Reviews › Requests › Rules (`/marketing/reviews/requests/rules`, build spec §3.3b, PR C): the rules that decide which
 * delivered orders are asked for a review, when, and which are skipped. One rule decides each order: a rule for one
 * market wins over "all markets".
 *
 *   Header   New rule (the rule editor page), Import / Export (a JSON file), Seed defaults (asks first: it turns a rule on)
 *   Banners  a rule that matches no orders (no market, a channel Nexus does not ask, none in 30 days) → "Fix the rule"
 *   Tiles    rules on · A/B tests (running, from `GET /api/review-timing-tests?kind=AB`) · orders decided · sent · review
 *            rate (30 days, estimate)
 *   Grid     every rule (`GET /api/review-rules?withStats=1`), tick boxes and select-all; the bulk bar: Turn on, Turn off,
 *            Test run, Export, Delete…, Clear — what an action cannot change is counted and named (ruling 7). On is a
 *            switch (saved at once); Edit opens the editor; ⋯ Duplicate as A/B, Test run, Delete….
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Download, Plus, Power, PowerOff, Sparkles, SlidersHorizontal, TestTube2, Trash2, Upload } from 'lucide-react'
import { Banner, EmptyState, FileDropzone, MetricStrip, Modal, ToastProvider, useActionConfirm, useToast, type Metric } from '@/design-system/components'
import {
  GridCard,
  GridLoadingOverlay,
  GridNoRowsOverlay,
  GridSelectionActions,
  GridViewsMenu,
  NexusGrid,
  SelectionLabel,
  gridSelection,
  useGridState,
  type GridApi,
  type GridReadyEvent,
  type GridStateKey,
  type NexusGridProps,
} from '@/design-system/grid'
import { GridToolbar, PageHeader } from '@/design-system/patterns'
import { Button, Pill } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import Link from '@/lib/workspaces/Link'
import { usePathname, useRouter } from '@/lib/workspaces/navigation'
import { reviewsGet, reviewsSend } from '../../../_lib/reviewsFetch'
import { reviewsCrumbs } from '../../../_shell/reviews-crumbs'
import { ReviewsMenuButton } from '../../../_shell/ReviewsShell'
import { useGridCustomise } from '../../gridCustomise'
import { NEW_RULE_ID, rulePath } from '../../requestsPaths'
import { MANAGE_RULES, RULE_COLUMN_SPECS, rulesColumns, type RulesHandlers } from './rulesColumns'
import { abTile, type TimingTest, type TimingTestsAnswer } from '../../timing/_timing/timingTestsModel'
import {
  abMark,
  noMatchWarnings,
  rulesBulkHeld,
  rulesBulkLabel,
  rulesBulkPlan,
  rulesBulkResultWords,
  rulesTiles,
  type RuleItem,
  type RulesAnswer,
  type RulesBulkAction,
} from './rulesModel'
import { TestRunModal } from './TestRunModal'
import s from './rules.module.css'

/* ── stable grid options (GDS decision 12) ───────────────────────────────────────────────────── */
const ROW_ID: NonNullable<NexusGridProps<RuleItem>['getRowId']> = (p) => p.data.id
const SELECTION = gridSelection<RuleItem>({ selectAll: 'all' }) as NexusGridProps<RuleItem>['rowSelection']
const LOADING_PARAMS = { rows: 5 }
const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility', 'columnPinning', 'sort']
const NO_PAGE_STATE = (): Record<string, never> => ({})
const IGNORE_PAGE_STATE = () => {}
const MAX_WARNINGS = 3

interface BulkAnswer { changed: number; held: { id: string; words: string }[] }
interface ImportAnswer { created: number; updated: number; skipped: number; errors: string[] }

/** Save a JSON answer as a file. */
function saveJson(data: unknown, fileName: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function RulesClient() {
  return (
    <ToastProvider>
      <Rules />
    </ToastProvider>
  )
}

function Rules() {
  const pathname = usePathname() ?? '/marketing/reviews/requests/rules'
  const router = useRouter()
  const { status: authStatus, has } = useAuth()
  const canManage = authStatus !== 'authed' || has('reviews.manage')
  const { toast } = useToast()
  const confirm = useActionConfirm()

  // ── The rules ──
  const [answer, setAnswer] = useState<{ data: RulesAnswer | null; error: string | null; at: number } | null>(null)
  const [reading, setReading] = useState(false)
  const load = useCallback(async () => {
    setReading(true)
    const res = await reviewsGet<RulesAnswer>('/review-rules', { withStats: 1 })
    setReading(false)
    setAnswer((prev) => (res.error && prev?.data ? { ...prev, error: res.error } : { data: res.data, error: res.error, at: Date.now() }))
  }, [])
  useEffect(() => { void load() }, [load])
  // PR J — the A/B splits (the A/B tile and marks).
  const [abTests, setAbTests] = useState<{ tests: TimingTest[]; error: string | null } | null>(null)
  const loadAb = useCallback(async () => {
    const res = await reviewsGet<TimingTestsAnswer>('/review-timing-tests', { kind: 'AB' })
    setAbTests({ tests: res.data?.tests ?? [], error: res.error })
  }, [])
  useEffect(() => { void loadAb() }, [loadAb])
  useInvalidationChannel(['review.rule.changed'], () => { void load(); void loadAb() })

  const rules = useMemo(() => answer?.data?.items ?? [], [answer])
  const statsRead = !!answer?.data && !answer.data.statsError
  const failed = !!answer?.error && !answer.data

  // This tab's own listener (above) reads the rules again.
  const changed = useCallback(() => {
    emitInvalidation({ type: 'review.rule.changed' })
  }, [])

  // ── Single-rule actions ──
  const patchActive = useCallback(async (row: RuleItem, next: boolean) => {
    const res = await reviewsSend<RuleItem>('PATCH', `/review-rules/${encodeURIComponent(row.id)}`, { isActive: next })
    if (res.error) return toast(res.error, 'danger')
    toast(next ? `“${row.name}” is on — it asks buyers from the next run` : `“${row.name}” is off — it asks nobody new`, 'success')
    changed()
  }, [toast, changed])

  const duplicate = useCallback(async (row: RuleItem) => {
    const res = await reviewsSend<{ rule: { id: string; name: string } }>('POST', `/review-rules/${encodeURIComponent(row.id)}/duplicate`, undefined, { idempotent: true, what: 'copy' })
    if (res.error || !res.data) return toast(res.error ?? 'Nexus could not copy the rule.', 'danger')
    toast(`“${res.data.rule.name}” made (off) — change it, then turn it on`, 'success')
    changed()
  }, [toast, changed])

  const deleteConsequences = useCallback((list: readonly RuleItem[]) => {
    const inTest = list.some((r) => abMark(r, rules))
    return [
      'New orders go to the next rule that matches them (or to no rule)',
      'Requests these rules already queued still go out',
      ...(inTest ? ['An A/B test one of them is part of ends'] : []),
    ]
  }, [rules])

  const remove = useCallback(async (row: RuleItem) => {
    const ok = await confirm.ask({
      level: 'confirm',
      title: `Delete the rule “${row.name}”?`,
      confirmLabel: 'Delete rule',
      consequences: deleteConsequences([row]),
      sideEffects: ['A deleted rule cannot be restored. Export first to keep a copy.'],
    })
    if (!ok) return
    const res = await reviewsSend<unknown>('DELETE', `/review-rules/${encodeURIComponent(row.id)}`)
    if (res.error) return toast(res.error, 'danger')
    toast(`“${row.name}” deleted`, 'success')
    changed()
  }, [confirm, deleteConsequences, toast, changed])

  const [testRules, setTestRules] = useState<RuleItem[] | null>(null)

  // ── Grid ──
  const handlers = useRef<RulesHandlers>({ edit: () => {}, duplicate: () => {}, testRun: () => {}, remove: () => {}, rules: [], abTests: [], canManage: false })
  handlers.current = {
    onSwitch: canManage ? (row, next) => void patchActive(row, next) : undefined,
    edit: (row) => router.push(rulePath(row.id)),
    duplicate: (row) => void duplicate(row),
    testRun: (row) => setTestRules([row]),
    remove: (row) => void remove(row),
    rules,
    abTests: abTests?.tests ?? [],
    canManage,
  }
  const columnDefs = useMemo(() => rulesColumns(handlers), [])
  const apiRef = useRef<GridApi<RuleItem> | null>(null)
  // The A/B marks read the splits through the handlers: draw that column again when they arrive.
  useEffect(() => { apiRef.current?.refreshCells({ columns: ['ab'], force: true }) }, [abTests])
  const customise = useGridCustomise(apiRef, RULE_COLUMN_SPECS)
  const gridState = useGridState<Record<string, never>>({
    surface: 'reviews-requests-rules',
    baseUrl: getBackendUrl(),
    getPageState: NO_PAGE_STATE,
    applyPageState: IGNORE_PAGE_STATE,
    persistKeys: PERSIST_KEYS,
  })
  const bindState = useRef(gridState.bind)
  bindState.current = gridState.bind
  const onGridReady = useCallback((e: GridReadyEvent<RuleItem>) => {
    apiRef.current = e.api
    bindState.current(e.api)
  }, [])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const onSelectionChanged = useCallback<NonNullable<NexusGridProps<RuleItem>['onSelectionChanged']>>((e) => {
    setSelectedIds(e.api.getSelectedRows().map((r) => r.id))
  }, [])
  const selected = useMemo(() => rules.filter((r) => selectedIds.includes(r.id)), [rules, selectedIds])
  const clearSelection = useCallback(() => apiRef.current?.deselectAll(), [])
  const onRowDoubleClicked = useCallback<NonNullable<NexusGridProps<RuleItem>['onRowDoubleClicked']>>((e) => {
    const target = (e.event?.target ?? null) as HTMLElement | null
    if (target?.closest?.('a, button, [role="switch"], .ag-selection-checkbox, input')) return
    if (e.data) router.push(rulePath(e.data.id))
  }, [router])
  const noRowsParams = useMemo(() => ({ title: 'No request rules yet', message: 'Seed the defaults, or make a new rule.' }), [])

  // ── Header actions ──
  const exportRules = useCallback(async (ids?: readonly string[]) => {
    const res = await reviewsGet<unknown>('/review-rules/export', { ids: ids && ids.length ? ids : null })
    if (res.error) return toast(res.error, 'danger')
    saveJson(res.data, ids && ids.length ? `review-rules-${ids.length}.json` : 'review-rules.json')
    toast(ids && ids.length ? `${ids.length} ${ids.length === 1 ? 'rule' : 'rules'} exported` : 'Every rule exported', 'success')
  }, [toast])

  const seed = useCallback(async () => {
    const ok = await confirm.ask({
      level: 'confirm',
      title: 'Seed the default rule?',
      confirmLabel: 'Seed defaults',
      consequences: [
        'Adds a rule for every Amazon market — or turns the existing one on',
        'First try from the product-type table, inside day 7–25 after delivery; refunded orders and open returns are skipped',
        'It asks “How was it?” first, as the rules did until now',
        'The rule is on: delivered Amazon orders join the queue from the next run',
      ],
    })
    if (!ok) return
    const res = await reviewsSend<{ action: string; rule: { name: string } }>('POST', '/review-rules/seed-default?scope=AMAZON_GLOBAL', undefined, { idempotent: true, what: 'seed' })
    if (res.error || !res.data) return toast(res.error ?? 'Nexus could not seed the rule.', 'danger')
    toast(res.data.action === 'created' ? `“${res.data.rule.name}” added and on` : `“${res.data.rule.name}” is on`, 'success')
    changed()
  }, [confirm, toast, changed])

  const [importOpen, setImportOpen] = useState(false)
  const [importBusy, setImportBusy] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const importFile = useCallback(async (files: File[]) => {
    const file = files[0]
    if (!file) return
    setImportError(null)
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      setImportError('This file is not a rules file (it is not JSON). Export from this page to get one.')
      return
    }
    setImportBusy(true)
    const res = await reviewsSend<ImportAnswer>('POST', '/review-rules/import', parsed, { idempotent: true, what: 'import' })
    setImportBusy(false)
    if (res.error || !res.data) return setImportError(res.error ?? 'Nexus could not import the file.')
    toast(`Imported: ${res.data.created} new, ${res.data.updated} updated, ${res.data.skipped} skipped`, res.data.skipped ? 'warning' : 'success')
    setImportOpen(false)
    changed()
  }, [toast, changed])

  // ── Bulk bar ──
  const runBulk = useCallback(async (action: 'on' | 'off' | 'delete', ids: string[]) => {
    const res = await reviewsSend<BulkAnswer>('POST', '/review-rules/bulk', { ids, action }, { idempotent: true, what: 'change' })
    if (res.error || !res.data) return toast(res.error ?? 'Nexus could not do this.', 'danger')
    toast(rulesBulkResultWords(action, res.data.changed, res.data.held), res.data.changed ? 'success' : 'warning')
    clearSelection()
    changed()
  }, [toast, clearSelection, changed])

  const askBulk = useCallback(async (action: RulesBulkAction) => {
    const plan = rulesBulkPlan(selected, action)
    if (!plan.apply.length) return
    const chosen = selected.filter((r) => plan.apply.includes(r.id))
    if (action === 'test') return setTestRules(chosen)
    if (action === 'export') return void exportRules(plan.apply)
    const n = plan.apply.length
    const rulesWord = `${n} ${n === 1 ? 'rule' : 'rules'}`
    const leftOut = plan.held.map((h) => `Left out: ${h.words}`)
    const ok = await confirm.ask(action === 'delete'
      ? { level: 'confirm', title: `Delete ${rulesWord}?`, confirmLabel: `Delete ${rulesWord}`, consequences: [...deleteConsequences(chosen), ...leftOut], sideEffects: ['A deleted rule cannot be restored. Export first to keep a copy.'] }
      : action === 'on'
        ? { level: 'confirm', title: `Turn on ${rulesWord}?`, confirmLabel: `Turn on ${rulesWord}`, consequences: ['They ask buyers from the next run of the sender', ...leftOut] }
        : { level: 'confirm', title: `Turn off ${rulesWord}?`, confirmLabel: `Turn off ${rulesWord}`, consequences: ['They ask nobody new; requests they already queued still go out', ...leftOut] })
    if (ok) await runBulk(action, plan.apply)
  }, [selected, exportRules, confirm, deleteConsequences, runBulk])

  const bulkBar = (() => {
    if (!selected.length) return null
    const plans = {
      on: rulesBulkPlan(selected, 'on'),
      off: rulesBulkPlan(selected, 'off'),
      test: rulesBulkPlan(selected, 'test'),
      export: rulesBulkPlan(selected, 'export'),
      delete: rulesBulkPlan(selected, 'delete'),
    }
    const manageHeld = (plan: typeof plans.on, action: RulesBulkAction) => (!canManage ? MANAGE_RULES : rulesBulkHeld(plan, action))
    return (
      <GridSelectionActions>
        <Button size="sm" onClick={() => void askBulk('on')} heldReason={manageHeld(plans.on, 'on')}>
          <Power size={13} aria-hidden /> <SelectionLabel>{rulesBulkLabel('Turn on', plans.on)}</SelectionLabel>
        </Button>
        <Button size="sm" onClick={() => void askBulk('off')} heldReason={manageHeld(plans.off, 'off')}>
          <PowerOff size={13} aria-hidden /> <SelectionLabel>{rulesBulkLabel('Turn off', plans.off)}</SelectionLabel>
        </Button>
        <Button size="sm" onClick={() => void askBulk('test')}>
          <TestTube2 size={13} aria-hidden /> <SelectionLabel>Test run</SelectionLabel>
        </Button>
        <Button size="sm" onClick={() => void askBulk('export')}>
          <Download size={13} aria-hidden /> <SelectionLabel>Export</SelectionLabel>
        </Button>
        <Button size="sm" variant="danger-outline" onClick={() => void askBulk('delete')} heldReason={manageHeld(plans.delete, 'delete')}>
          <Trash2 size={13} aria-hidden /> <SelectionLabel>Delete…</SelectionLabel>
        </Button>
        <Button size="sm" variant="link" onClick={clearSelection}>Clear</Button>
      </GridSelectionActions>
    )
  })()

  // ── Tiles, warnings ──
  const tiles = rulesTiles(rules, statsRead)
  const abTileOf = abTile(abTests?.tests ?? [])
  const metrics: Metric[] = [
    { label: 'Rules on', value: `${tiles.on}`, hint: `of ${tiles.total}`, accent: tiles.on ? 'var(--nds-success)' : 'var(--nds-warning)' },
    abTests?.error && !abTests.tests.length
      ? { label: 'A/B tests', value: '—', hint: 'could not be read' }
      : { label: 'A/B tests', value: abTests ? abTileOf.value : '…', hint: abTests ? abTileOf.hint : 'reading…' },
    { label: 'Orders decided', value: tiles.matched30 == null ? '—' : tiles.matched30.toLocaleString('en-IE'), hint: 'by a rule, last 30 days' },
    { label: 'Sent', value: tiles.sent30 == null ? '—' : tiles.sent30.toLocaleString('en-IE'), hint: 'last 30 days' },
    { label: 'Review rate', value: tiles.rate30 == null ? '—' : `${(tiles.rate30 * 100).toFixed(1)}%`, hint: '30 days, estimate' },
  ]
  const warnings = noMatchWarnings(rules, statsRead)
  const noneOn = rules.length > 0 && tiles.on === 0

  const manageHeld = canManage ? null : MANAGE_RULES
  const subtitle = answer?.data ? `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'} · ${tiles.on} on · one rule decides each order` : 'Loading…'
  const actions = (
    <div className={s.actions}>
      <ReviewsMenuButton />
      <Button size="sm" onClick={() => { setImportError(null); setImportOpen(true) }} heldReason={manageHeld}>
        <Upload size={13} aria-hidden /> Import
      </Button>
      <Button size="sm" onClick={() => void exportRules()} heldReason={rules.length ? null : 'There is no rule to export yet.'}>
        <Download size={13} aria-hidden /> Export
      </Button>
      <Button size="sm" onClick={() => void seed()} heldReason={manageHeld}>
        <Sparkles size={13} aria-hidden /> Seed defaults
      </Button>
      {canManage ? (
        <Button asChild size="sm" variant="primary">
          <Link href={rulePath(NEW_RULE_ID)}><Plus size={13} aria-hidden /> New rule</Link>
        </Button>
      ) : (
        <Button size="sm" variant="primary" heldReason={MANAGE_RULES}><Plus size={13} aria-hidden /> New rule</Button>
      )}
    </div>
  )

  return (
    <div className={s.page}>
      <PageHeader eyebrow={reviewsCrumbs(pathname)} title="Rules" subtitle={subtitle} actions={actions} />

      {warnings.slice(0, MAX_WARNINGS).map((w) => (
        <Banner key={w.id} tone="warning" title={w.title} action={<Button asChild size="sm"><Link href={rulePath(w.id)}>Fix the rule</Link></Button>}>
          {w.detail}
        </Banner>
      ))}
      {warnings.length > MAX_WARNINGS && <p className={s.muted}>And {warnings.length - MAX_WARNINGS} more rules match no orders.</p>}
      {noneOn && (
        <Banner tone="warning" title="No rule is on — nobody is asked for a review">
          Delivered orders wait in no queue until a rule covers their channel and market. Turn a rule on, or seed the defaults.
        </Banner>
      )}
      {answer?.data?.statsError && <Banner tone="warning" title="The numbers of the last 30 days are missing">{answer.data.statsError}. The rules themselves are up to date.</Banner>}

      {answer?.data && <MetricStrip metrics={metrics} minTileWidth={150} />}

      {failed ? (
        <EmptyState icon={<AlertTriangle size={20} aria-hidden />} title="Couldn’t read the rules" description={answer?.error} action={<Button size="sm" onClick={() => void load()}>Try again</Button>} />
      ) : answer?.data && rules.length === 0 ? (
        <EmptyState
          title="No request rules yet"
          description="Start from the default: one rule for every Amazon market. You can change everything after."
          action={(
            <span className={s.actions}>
              <Button size="sm" onClick={() => void seed()} heldReason={manageHeld}><Sparkles size={13} aria-hidden /> Seed defaults</Button>
              {canManage && <Button asChild size="sm" variant="primary"><Link href={rulePath(NEW_RULE_ID)}><Plus size={13} aria-hidden /> New rule</Link></Button>}
            </span>
          )}
        />
      ) : (
        <GridCard
          toolbar={(
            <GridToolbar
              count={selected.length ? <>Selected <b>{selected.length}</b> of {rules.length}</> : answer?.data ? `${rules.length} ${rules.length === 1 ? 'rule' : 'rules'}` : 'Reading…'}
              right={(
                <>
                  <GridViewsMenu views={gridState} />
                  <Button size="sm" onClick={customise.openCustomise}><SlidersHorizontal size={13} aria-hidden /> Customise</Button>
                  <Pill tone={answer?.error ? 'danger' : 'success'} dot size="md">{answer?.error ? 'Not updating' : reading ? 'Updating…' : 'Up to date'}</Pill>
                </>
              )}
            >
              {bulkBar}
            </GridToolbar>
          )}
        >
          <NexusGrid<RuleItem>
            domLayout="autoHeight"
            rows="media"
            suppressCellFocus={false}
            rowData={rules}
            getRowId={ROW_ID}
            columnDefs={columnDefs}
            context={handlers}
            rowSelection={SELECTION}
            initialState={gridState.initialState}
            columnDialog={customise.columnDialog}
            loading={!answer}
            loadingOverlayComponent={GridLoadingOverlay}
            loadingOverlayComponentParams={LOADING_PARAMS}
            noRowsOverlayComponent={GridNoRowsOverlay}
            noRowsOverlayComponentParams={noRowsParams}
            onGridReady={onGridReady}
            onSelectionChanged={onSelectionChanged}
            onRowDoubleClicked={onRowDoubleClicked}
          />
        </GridCard>
      )}

      <p className={s.footnote}>
        One rule decides each order: a rule for one market wins over “all markets”. An A/B pair splits that market’s orders by order
        number. Etsy is not listed: Etsy asks its buyers for a review itself. A rule that is off still shows in a Test run, but never sends.
      </p>

      {importOpen && (
        <Modal open onClose={() => setImportOpen(false)} title="Import rules" size="md" footer={<Button onClick={() => setImportOpen(false)}>Close</Button>}>
          <div className={s.importBody}>
            <p className={s.muted}>
              A rules file from Export. A rule with the same name, channel and market is updated; any other is added. Imported rules
              keep their On or Off.
            </p>
            <FileDropzone accept=".json" maxBytes={1024 * 1024} onFiles={(files) => void importFile(files)} disabled={importBusy} hint="One .json file from Export, up to 1 MB" />
            {importBusy && <p className={s.muted}>Importing…</p>}
            {importError && <Banner tone="danger" title="Not imported">{importError}</Banner>}
          </div>
        </Modal>
      )}
      {testRules && <TestRunModal rules={testRules} onClose={() => setTestRules(null)} canManage={canManage} />}
      {customise.modal}
      {confirm.element}
    </div>
  )
}

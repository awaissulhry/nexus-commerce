'use client'

/**
 * Reviews › Requests › Queue (`/marketing/reviews/requests`, build spec §3.3a, PR C): every review request — waiting,
 * sent, failed or not asked — and the one sender that sends them.
 *
 *   Header   crumbs from the Reviews navigation; Package inserts and Preview email (also `?inserts=1` / `?preview=1`)
 *   Banner   sending on (next run, last run) or paused (who, when, why); Pause sending asks why; Run now lists what it
 *            sends first. A failures banner counts the failures of 7 days; "Show failed" filters the grid.
 *   Tiles    Scheduled · Due now · Retrying · Sent · Failed · Skipped filter the grid (a removable chip); Review rate is
 *            an estimate. The filter bar: channel, market, status, rule, product type, reason.
 *   Grid     one API page at a time (`GET /api/review-queue`); every row has a tick box, the header box ticks the page;
 *            the bulk bar: Snooze · Skip · Send now — rows an action cannot change are counted and named (ruling 7).
 *            A row (or Enter) opens the request pop-up; K / J walk the page.
 *   Results  "What requests brought" by market, product type and rule.
 *
 * Mutations: no optimistic rows — the call, then `emitInvalidation`, then a fresh read, then the server's count in a
 * toast. Nothing here sends without asking first; a sent request cannot be taken back.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BellRing, Mail, Package, Search, SkipForward, SlidersHorizontal } from 'lucide-react'
import { AsOf, Banner, EmptyState, Menu, MetricStrip, ToastProvider, useActionConfirm, useToast, type MenuItemDef, type Metric } from '@/design-system/components'
import {
  GridCard,
  GridLoadingOverlay,
  GridNoRowsOverlay,
  GridPager,
  GridSearchSlot,
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
import { FilterBar, GridToolbar, PageHeader, type FilterDimension } from '@/design-system/patterns'
import { Button, Input, Pill, TokenChip } from '@/design-system/primitives'
import { useAuth } from '@/lib/auth/AuthProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { usePathname, useRouter } from '@/lib/workspaces/navigation'
import { reviewsSend } from '../../_lib/reviewsFetch'
import { channelMarketWords } from '../../_lib/reviewWords'
import { reviewsCrumbs } from '../../_shell/reviews-crumbs'
import { ReviewsMenuButton } from '../../_shell/ReviewsShell'
import { useGridCustomise } from '../gridCustomise'
import { RULES_PATH } from '../requestsPaths'
import { EmailPreviewModal, AMAZON_EMAIL_WORDS } from './EmailPreviewModal'
import { InsertsModal } from './InsertsModal'
import { RequestDetailModal } from './RequestDetailModal'
import { ResultsCard } from './ResultsCard'
import { SendingBanner } from './SendingBanner'
import { QUEUE_COLUMN_SPECS, queueColumns } from './queueColumns'
import { readQueuePage, readSending, type QueueAnswer, type QueueRow, type QueueStatus, type SendingState } from './queueDatasource'
import { SNOOZE_CHOICES, bulkHeldReason, bulkLabel, bulkResultWords, leftOutLines, queueBulkPlan, type QueueBulkAction, type SnoozeDays } from './queueBulk'
import {
  EMPTY_QUEUE_QUERY,
  QUEUE_CHANNELS,
  QUEUE_MARKETS,
  QUEUE_PAGE_SIZES,
  activeFilterCount,
  clearFilters,
  pageCount,
  parseQueueQuery,
  queueApiParams,
  queueReadKey,
  serializeQueueQuery,
  toggleStatus,
  withFilter,
  withPage,
  withPageSize,
  withSearch,
  withSort,
  type QueueFilterKey,
  type QueueQuery,
  type ResultsPeriod,
} from './queueQuery'
import { STATUS_OPTIONS, countWords, failuresLines, filterChips, marketName, queueTileViews } from './queueTiles'
import { runResultWords, type RunResult } from './sendingModel'
import s from './queue.module.css'

const POLL_MS = 60_000
const SEARCH_DEBOUNCE_MS = 300
const MANAGE_REQUESTS = "You need 'Manage reviews' to change review requests."

/* ── stable grid options (GDS decision 12) ───────────────────────────────────────────────────── */
const ROW_ID: NonNullable<NexusGridProps<QueueRow>['getRowId']> = (p) => p.data.id
const SELECTION = gridSelection<QueueRow>({ selectAll: 'currentPage' }) as NexusGridProps<QueueRow>['rowSelection']
const LOADING_PARAMS = { rows: 8 }
const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility', 'columnPinning']
const NO_PAGE_STATE = (): Record<string, never> => ({})
const IGNORE_PAGE_STATE = () => {}
const ALL = { value: '', label: 'All' }

interface Loaded<T> { key: string; data: T | null; error: string | null; at: number }
interface BulkAnswer { changed: number; held: { id: string; words: string }[]; result?: RunResult }

export function QueueClient() {
  return (
    <ToastProvider>
      <Queue />
    </ToastProvider>
  )
}

function Queue() {
  const pathname = usePathname() ?? '/marketing/reviews/requests'
  const router = useRouter()
  const { status: authStatus, has } = useAuth()
  const canManage = authStatus !== 'authed' || has('reviews.manage')
  const { toast } = useToast()
  const confirm = useActionConfirm()

  // ── The address: read once, written back on every change ──
  const [query, setQueryState] = useState<QueueQuery | null>(null)
  const [insertsOpen, setInsertsOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  useEffect(() => {
    const { query: q, flags } = parseQueueQuery(window.location.search)
    setQueryState(q)
    if (flags.inserts) setInsertsOpen(true)
    if (flags.preview) setPreviewOpen(true)
  }, [])
  const setQuery = useCallback((update: (q: QueueQuery) => QueueQuery) => setQueryState((q) => update(q ?? EMPTY_QUEUE_QUERY)), [])
  useEffect(() => {
    if (!query) return
    const next = `${window.location.pathname}${serializeQueueQuery(query)}`
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState({}, '', next)
  }, [query])

  // ── The queue (one API page) ──
  const readKey = query ? queueReadKey(query) : null
  const [list, setList] = useState<Loaded<QueueAnswer> | null>(null)
  const [reading, setReading] = useState(false)
  const listAbort = useRef<AbortController | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query
  const loadList = useCallback(async () => {
    const q = queryRef.current
    if (!q) return
    const key = queueReadKey(q)
    listAbort.current?.abort()
    const controller = new AbortController()
    listAbort.current = controller
    setReading(true)
    try {
      const res = await readQueuePage(queueApiParams(q), controller.signal)
      if (controller.signal.aborted) return
      // A failed refresh keeps the rows it has (the pill says "Not updating"); with no rows the error shows.
      setList((prev) => (res.error && prev?.key === key && prev.data ? { ...prev, error: res.error } : { key, data: res.data, error: res.error, at: Date.now() }))
    } catch {
      return
    } finally {
      if (listAbort.current === controller) setReading(false)
    }
  }, [])
  useEffect(() => {
    if (!readKey) return
    void loadList()
  }, [readKey, loadList])
  useEffect(() => () => listAbort.current?.abort(), [])

  // ── Sending state ──
  const [sending, setSending] = useState<{ data: SendingState | null; error: string | null } | null>(null)
  const [sendingBusy, setSendingBusy] = useState(false)
  const loadSending = useCallback(async () => {
    const res = await readSending()
    setSending((prev) => (res.error && prev?.data ? { data: prev.data, error: res.error } : { data: res.data, error: res.error }))
  }, [])
  useEffect(() => { void loadSending() }, [loadSending])

  const refreshAll = useCallback(() => {
    void loadList()
    void loadSending()
  }, [loadList, loadSending])
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') refreshAll()
    }, POLL_MS)
    return () => window.clearInterval(id)
  }, [refreshAll])
  useInvalidationChannel(['review.request.updated', 'review.mailer.changed', 'review.rule.changed'], refreshAll)

  const current = list && list.key === readKey ? list : null
  const answer = current?.data ?? null
  const rows = useMemo(() => answer?.rows ?? [], [answer])
  const failed = !!current?.error && !answer

  // ── Search (debounced into the address) ──
  const [searchDraft, setSearchDraft] = useState('')
  const searchSeeded = useRef(false)
  useEffect(() => {
    if (query && !searchSeeded.current) {
      searchSeeded.current = true
      setSearchDraft(query.q)
    }
  }, [query])
  useEffect(() => {
    if (!searchSeeded.current) return
    const t = window.setTimeout(() => setQuery((q) => (q.q === searchDraft ? q : withSearch(q, searchDraft))), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [searchDraft, setQuery])

  // ── Grid ──
  const apiRef = useRef<GridApi<QueueRow> | null>(null)
  const columnDefs = useMemo(() => queueColumns(), [])
  const customise = useGridCustomise(apiRef, QUEUE_COLUMN_SPECS)
  const gridState = useGridState<Record<string, never>>({
    surface: 'reviews-requests-queue',
    baseUrl: getBackendUrl(),
    getPageState: NO_PAGE_STATE,
    applyPageState: IGNORE_PAGE_STATE,
    persistKeys: PERSIST_KEYS,
  })
  const bindState = useRef(gridState.bind)
  bindState.current = gridState.bind
  const onGridReady = useCallback((e: GridReadyEvent<QueueRow>) => {
    apiRef.current = e.api
    bindState.current(e.api)
    const sort = queryRef.current?.sort
    if (sort) e.api.applyColumnState({ state: [{ colId: sort.column, sort: sort.dir }], defaultState: { sort: null } })
  }, [])
  const onSortChanged = useCallback((e: { api: GridApi<QueueRow> }) => {
    const sorted = e.api.getColumnState().find((c) => c.sort)
    setQuery((q) => withSort(q, sorted?.colId ?? null, (sorted?.sort as 'asc' | 'desc' | null | undefined) ?? null))
  }, [setQuery])

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const onSelectionChanged = useCallback<NonNullable<NexusGridProps<QueueRow>['onSelectionChanged']>>((e) => {
    setSelectedIds(e.api.getSelectedRows().map((r) => r.id))
  }, [])
  const selected = useMemo(() => rows.filter((r) => selectedIds.includes(r.id)), [rows, selectedIds])
  const clearSelection = useCallback(() => apiRef.current?.deselectAll(), [])

  const openRequest = useCallback((id: string) => setQuery((q) => ({ ...q, request: id })), [setQuery])
  const onRowClicked = useCallback<NonNullable<NexusGridProps<QueueRow>['onRowClicked']>>((e) => {
    const target = (e.event?.target ?? null) as HTMLElement | null
    if (target?.closest?.('a, button, [role="dialog"], .ag-selection-checkbox, input')) return
    if (e.data) openRequest(e.data.id)
  }, [openRequest])
  const onCellKeyDown = useCallback<NonNullable<NexusGridProps<QueueRow>['onCellKeyDown']>>((e) => {
    const key = e.event as KeyboardEvent | null | undefined
    if (key?.key !== 'Enter' || !e.data) return
    const target = key.target as HTMLElement | null
    if (target?.closest?.('a, button, input')) return
    openRequest(e.data.id)
  }, [openRequest])

  const filtered = !!query && activeFilterCount(query) > 0
  const noRowsParams = useMemo(() => (
    filtered
      ? { title: 'No requests match these filters', message: 'Clear a filter or the search to see more.', action: { label: 'Clear filters', onClick: () => setQuery(clearFilters) } }
      : { title: 'No review requests yet', message: 'A request is added when a rule covers a delivered order’s channel and market.', action: { label: 'Open the rules', onClick: () => router.push(RULES_PATH) } }
  ), [filtered, setQuery, router])

  // ── Tiles, filters, chips ──
  const pressTile = useCallback((status: QueueStatus) => setQuery((q) => toggleStatus(q, status)), [setQuery])
  const metrics = useMemo<Metric[] | null>(() => {
    if (!answer) return null
    return queueTileViews(answer.tiles, query?.status ?? null).map((t) => (t.status
      ? { label: t.label, value: t.value, hint: t.hint, accent: t.accent, active: t.active, onClick: () => pressTile(t.status!) }
      : { label: t.label, value: t.value, hint: t.hint, ...(t.delta ? { delta: t.delta } : {}) }))
  }, [answer, query?.status, pressTile])

  const setFilter = useCallback((key: QueueFilterKey, value: string) => setQuery((q) => withFilter(q, key, value || null)), [setQuery])
  const facets = answer?.facets ?? null
  const dimensions = useMemo<FilterDimension[]>(() => {
    const q = query ?? EMPTY_QUEUE_QUERY
    return [
      { key: 'channel', label: 'Channel', kind: 'select', value: q.channel ?? '', onChange: (v) => setFilter('channel', v), options: [ALL, ...QUEUE_CHANNELS.map((c) => ({ value: c, label: channelMarketWords(c) }))] },
      { key: 'market', label: 'Market', kind: 'select', value: q.market ?? '', onChange: (v) => setFilter('market', v), options: [ALL, ...QUEUE_MARKETS.map((m) => ({ value: m, label: marketName(m) }))] },
      { key: 'status', label: 'Status', kind: 'select', value: q.status ?? '', onChange: (v) => setFilter('status', v), options: [ALL, ...STATUS_OPTIONS] },
      {
        key: 'rule', label: 'Rule', kind: 'select', value: q.rule ?? '', onChange: (v) => setFilter('rule', v),
        options: [ALL, ...(facets?.rules ?? []).map((r) => ({ value: r.id, label: `${r.name}${r.isActive ? '' : ' (off)'}` })), { value: 'none', label: 'No rule (default timing)' }],
      },
      { key: 'productType', label: 'Product type', kind: 'select', value: q.productType ?? '', onChange: (v) => setFilter('productType', v), options: [ALL, ...(facets?.productTypes ?? []).map((t) => ({ value: t, label: t }))] },
      { key: 'reason', label: 'Reason', kind: 'select', value: q.reason ?? '', onChange: (v) => setFilter('reason', v), options: [ALL, ...(facets?.reasons ?? []).map((r) => ({ value: r.key, label: r.words }))] },
    ]
  }, [query, facets, setFilter])
  const chips = useMemo(() => (query ? filterChips(query, facets) : []), [query, facets])
  const removeChip = useCallback((key: QueueFilterKey | 'q') => {
    if (key === 'q') {
      setSearchDraft('')
      setQuery((q) => withSearch(q, ''))
    } else setQuery((q) => withFilter(q, key, null))
  }, [setQuery])
  const clearAll = useCallback(() => {
    setSearchDraft('')
    setQuery(clearFilters)
  }, [setQuery])

  // ── Sending: pause, resume, run ──
  // The invalidation reaches this tab's own listener too: the queue and the banner read again once.
  const afterSending = useCallback((next?: SendingState | null) => {
    if (next) setSending({ data: next, error: null })
    emitInvalidation({ type: 'review.mailer.changed' })
  }, [])
  const pause = useCallback(async (reason: string) => {
    setSendingBusy(true)
    const res = await reviewsSend<{ sending: SendingState }>('POST', '/review-queue/pause', { reason }, { idempotent: true, what: 'pause' })
    setSendingBusy(false)
    if (res.error) {
      toast(res.error, 'danger')
      return false
    }
    toast('Sending is paused. Nothing goes out until someone resumes.', 'success')
    afterSending(res.data?.sending)
    return true
  }, [toast, afterSending])
  const resume = useCallback(async () => {
    setSendingBusy(true)
    const res = await reviewsSend<{ sending: SendingState }>('POST', '/review-queue/resume', {}, { idempotent: true, what: 'resume' })
    setSendingBusy(false)
    if (res.error) return toast(res.error, 'danger')
    toast('Sending is on again. Due requests go at the next run.', 'success')
    afterSending(res.data?.sending)
  }, [toast, afterSending])
  const run = useCallback(async () => {
    setSendingBusy(true)
    const res = await reviewsSend<{ result: RunResult }>('POST', '/review-queue/run', {}, { idempotent: true, what: 'run' })
    setSendingBusy(false)
    if (res.error) return toast(res.error, 'warning')
    toast(runResultWords(res.data?.result), 'success')
    afterSending()
  }, [toast, afterSending])

  // ── Bulk bar ──
  const now = useMemo(() => new Date(current?.at ?? 0), [current?.at])
  const runBulk = useCallback(async (action: QueueBulkAction, ids: string[], days?: SnoozeDays) => {
    const res = await reviewsSend<BulkAnswer>('POST', '/review-queue/bulk', { ids, action, days }, { idempotent: true, what: 'change' })
    if (res.error || !res.data) return toast(res.error ?? 'Nexus could not do this.', 'danger')
    toast(bulkResultWords(action, res.data.changed, res.data.held, days), res.data.changed > 0 ? 'success' : 'warning')
    clearSelection()
    emitInvalidation({ type: 'review.request.updated', meta: { count: res.data.changed } })
  }, [toast, clearSelection])

  const askBulk = useCallback(async (action: QueueBulkAction, days?: SnoozeDays) => {
    const plan = queueBulkPlan(selected, action, now, days)
    if (plan.apply.length === 0) return
    const n = plan.apply.length
    const requests = `${n} ${n === 1 ? 'request' : 'requests'}`
    const amazon = selected.filter((r) => plan.apply.includes(r.id) && r.channel === 'AMAZON').length
    if (action === 'snooze') return runBulk('snooze', plan.apply, days)
    const ok = await confirm.ask(action === 'skip'
      ? {
          level: 'confirm',
          title: `Skip ${requests}?`,
          confirmLabel: `Skip ${requests}`,
          consequences: [`${requests} will not be asked for a review`, ...leftOutLines(plan)],
          sideEffects: ['Allow again in a request’s pop-up puts it back, while Amazon’s window is still open'],
        }
      : {
          level: 'confirm',
          title: `Send ${requests} now?`,
          confirmLabel: `Send ${requests} now`,
          consequences: [
            ...(amazon ? [`Asks Amazon to send ${amazon} review ${amazon === 1 ? 'request' : 'requests'} now`] : []),
            ...(n - amazon ? [`Sends our email to ${n - amazon} ${n - amazon === 1 ? 'buyer' : 'buyers'} now`] : []),
            ...leftOutLines(plan),
            'A sent request cannot be taken back.',
          ],
          sideEffects: amazon ? ['If Amazon answers “too early”, Nexus tries again tomorrow'] : [],
        })
    if (ok) await runBulk(action, plan.apply, days)
  }, [selected, now, confirm, runBulk])

  const bulkActions = (() => {
    if (selected.length === 0) return null
    const skipPlan = queueBulkPlan(selected, 'skip', now)
    const sendPlan = queueBulkPlan(selected, 'send-now', now)
    const snoozeItems: MenuItemDef[] = SNOOZE_CHOICES.map((c) => {
      const plan = queueBulkPlan(selected, 'snooze', now, c.days)
      const held = bulkHeldReason(plan, 'snooze')
      return {
        id: `snooze-${c.days}`,
        label: bulkLabel(c.label, plan),
        disabled: !!held,
        description: held ?? (c.days === 7 ? 'Amazon’s day 30 still ends the request' : undefined),
        onSelect: held ? undefined : () => void askBulk('snooze', c.days),
      }
    })
    const snoozeAll = snoozeItems.every((i) => i.disabled)
    return (
      <GridSelectionActions>
        {!canManage || snoozeAll ? (
          <Button size="sm" heldReason={!canManage ? MANAGE_REQUESTS : bulkHeldReason(queueBulkPlan(selected, 'snooze', now, 1), 'snooze')}>
            <BellRing size={13} aria-hidden /> <SelectionLabel>Snooze</SelectionLabel>
          </Button>
        ) : (
          <Menu label={<><BellRing size={13} aria-hidden /> <SelectionLabel>Snooze</SelectionLabel></>} items={snoozeItems} triggerProps={{ 'aria-label': 'Snooze: move the next try by' }} />
        )}
        <Button size="sm" onClick={() => void askBulk('skip')} heldReason={!canManage ? MANAGE_REQUESTS : bulkHeldReason(skipPlan, 'skip')}>
          <SkipForward size={13} aria-hidden /> <SelectionLabel>{bulkLabel('Skip', skipPlan)}</SelectionLabel>
        </Button>
        <Button size="sm" variant="primary" onClick={() => void askBulk('send-now')} heldReason={!canManage ? MANAGE_REQUESTS : bulkHeldReason(sendPlan, 'send-now')}>
          <Mail size={13} aria-hidden /> <SelectionLabel>{bulkLabel('Send now', sendPlan)}</SelectionLabel>
        </Button>
        <Button size="sm" variant="link" onClick={clearSelection}>Clear</Button>
      </GridSelectionActions>
    )
  })()

  // ── Pager ──
  const total = answer?.total ?? 0
  const pager = query ? { page: query.page, pageCount: pageCount(total, query.pageSize) } : { page: 1, pageCount: 1 }
  const onPage = useCallback((page: number) => setQuery((q) => withPage(q, page)), [setQuery])
  const onPageSize = useCallback((size: number) => setQuery((q) => withPageSize(q, size)), [setQuery])

  // ── The request pop-up ──
  const openId = query?.request ?? null
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows])
  const closeRequest = useCallback(() => setQuery((q) => ({ ...q, request: null })), [setQuery])
  const focusRow = useCallback((): HTMLElement | null => {
    const id = queryRef.current?.request
    return id ? document.querySelector<HTMLElement>(`.ag-row[row-id="${CSS.escape(id)}"] .ag-cell[col-id="order"]`) : null
  }, [])

  const onResults = useCallback((period: ResultsPeriod) => setQuery((q) => ({ ...q, results: period })), [setQuery])

  const subtitle = (
    <>
      Asking buyers for a review after delivery · one request per order · checked {current ? <AsOf at={new Date(current.at).toISOString()} kind="event" /> : '…'}
    </>
  )
  const actions = (
    <div className={s.actions}>
      <ReviewsMenuButton />
      <Button size="sm" onClick={() => setInsertsOpen(true)}>
        <Package size={13} aria-hidden /> Package inserts
      </Button>
      <Button size="sm" onClick={() => setPreviewOpen(true)}>
        <Mail size={13} aria-hidden /> Preview email
      </Button>
    </div>
  )

  const failures = answer && answer.failures7d.count > 0 ? failuresLines(answer.failures7d.words) : null
  const liveWords = current?.error ? 'Not updating' : reading ? 'Updating…' : 'Up to date'

  return (
    <div className={s.page}>
      <PageHeader eyebrow={reviewsCrumbs(pathname)} title="Requests" subtitle={subtitle} actions={actions} />

      <SendingBanner
        sending={sending?.data ?? null}
        error={sending?.error ?? null}
        loading={!sending}
        canManage={canManage}
        busy={sendingBusy}
        onRetry={() => void loadSending()}
        onPause={pause}
        onResume={() => void resume()}
        onRun={() => void run()}
      />

      {failures && (
        <Banner
          tone="danger"
          title={failures.title}
          action={<Button size="sm" onClick={() => setQuery((q) => withFilter(q, 'status', 'FAILED'))}>Show failed</Button>}
        >
          {failures.detail}
        </Banner>
      )}

      {metrics ? <MetricStrip metrics={metrics} minTileWidth={140} className={s.tiles} /> : !failed && <div className={s.tileSkeleton} aria-hidden />}

      <FilterBar dimensions={dimensions} onClear={clearAll} activeCount={query ? activeFilterCount(query) : 0} />

      {chips.length > 0 && (
        <div className={s.chips} role="group" aria-label="Filters on">
          {chips.map((c) => (
            <TokenChip key={c.key} onRemove={() => removeChip(c.key)} removeLabel={c.removeLabel}>{c.words}</TokenChip>
          ))}
        </div>
      )}

      <GridCard
        toolbar={(
          <GridToolbar
            count={selected.length ? <>Selected <b>{selected.length}</b> of {rows.length} on this page</> : failed ? 'Not read' : answer ? countWords(total, filtered) : 'Reading…'}
            right={(
              <>
                <GridViewsMenu views={gridState} />
                <Button size="sm" onClick={customise.openCustomise}>
                  <SlidersHorizontal size={13} aria-hidden /> Customise
                </Button>
                <Pill tone={current?.error ? 'danger' : 'success'} dot size="md">{liveWords}</Pill>
              </>
            )}
          >
            {bulkActions ?? (
              <GridSearchSlot>
                <Input
                  size="sm"
                  type="search"
                  aria-label="Search order number, buyer name or SKU"
                  placeholder="Search order, buyer or SKU"
                  leadingIcon={<Search size={13} aria-hidden />}
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                />
              </GridSearchSlot>
            )}
          </GridToolbar>
        )}
        footer={answer && !failed ? (
          <GridPager page={pager.page} pageCount={pager.pageCount} pageSize={query?.pageSize ?? 50} pageSizes={QUEUE_PAGE_SIZES} onPage={onPage} onPageSize={onPageSize} />
        ) : undefined}
      >
        {failed ? (
          <EmptyState
            icon={<AlertTriangle size={20} aria-hidden />}
            title="Couldn’t read the review requests"
            description={current?.error}
            action={<Button size="sm" onClick={() => void loadList()}>Try again</Button>}
          />
        ) : (
          <NexusGrid<QueueRow>
            domLayout="autoHeight"
            rows="media"
            rowData={rows}
            getRowId={ROW_ID}
            columnDefs={columnDefs}
            rowSelection={SELECTION}
            initialState={gridState.initialState}
            columnDialog={customise.columnDialog}
            loading={!answer}
            loadingOverlayComponent={GridLoadingOverlay}
            loadingOverlayComponentParams={LOADING_PARAMS}
            noRowsOverlayComponent={GridNoRowsOverlay}
            noRowsOverlayComponentParams={noRowsParams}
            suppressMultiSort
            onGridReady={onGridReady}
            onSortChanged={onSortChanged}
            onSelectionChanged={onSelectionChanged}
            onRowClicked={onRowClicked}
            onCellKeyDown={onCellKeyDown}
          />
        )}
      </GridCard>

      <p className={s.footnote}>
        {AMAZON_EMAIL_WORDS} Its text is fixed — Nexus only picks the day, and a “too early” answer is tried again each day. eBay and
        Shopify buyers get our own email (<Button variant="link" inline onClick={() => setPreviewOpen(true)}>Preview email</Button>), also
        once per order. Ask every buyer the same way: asking only happy buyers, or sending unhappy buyers elsewhere, is not allowed.
      </p>

      {query && <ResultsCard period={query.results} onPeriod={onResults} />}

      {openId && (
        <RequestDetailModal
          id={openId}
          ids={rowIds}
          onGo={openRequest}
          onClose={closeRequest}
          canManage={canManage}
          returnFocusTo={focusRow}
        />
      )}
      {insertsOpen && <InsertsModal onClose={() => setInsertsOpen(false)} />}
      {previewOpen && <EmailPreviewModal onClose={() => setPreviewOpen(false)} canManage={canManage} sending={sending?.data ?? null} />}
      {customise.modal}
      {confirm.element}
    </div>
  )
}

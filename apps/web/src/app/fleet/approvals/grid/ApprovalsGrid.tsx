'use client'

/**
 * Approvals grid — the page (docs/approvals-grid/PLAN.md §2): one grid for every request, from Claude, the fleet or a
 * rule. Header · health strip · toolbar · the grid in a `GridCard` · the drawer · the Automate modal.
 *
 * Who owns what:
 * - `useApprovalQueue` reads the rows and the counts (one light pair of calls per tick);
 * - `useApprovalActions` makes every decision (row verbs, bulk, keys and the drawer all go through it);
 * - `queueColumns` draws the rows; `queueWords` holds every rule and word, tested;
 * - `ApprovalDrawer` (D2) and `AutomateModal` (E) are built against `contracts.ts`.
 *
 * `?item=<id>` opens that request's drawer at load (Claude's links use it), whether or not the row is on this page of
 * the list; closing the drawer takes `?item` out of the address.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { QueueRow, QueueShow } from '@nexus/shared/approval-queue'

import { getBackendUrl } from '@/lib/backend-url'
import { usePathname, useRouter, useSearchParams } from '@/lib/workspaces/navigation'
import { Button, Kbd, Skeleton, Textarea } from '@/design-system/primitives'
import { Banner, Field, Modal, ToastProvider } from '@/design-system/components'
import { PreferencesModal, type PreferencesValue } from '@/design-system/patterns'
import {
  AG_AUTO_COL,
  GridCard,
  GridLoadingOverlay,
  GridNoRowsOverlay,
  NexusGrid,
  columnStateToPrefs,
  gridSelection,
  prefsToColumnState,
  useGridShortcuts,
  useGridState,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type GridShortcut,
  type GridStateKey,
  type NexusGridProps,
  type PrefsBridgeOptions,
} from '@/design-system/grid'

import { FleetPageShell } from '../../_shell/FleetPageShell'
import { HowApprovalsWork } from '../HowApprovalsWork'
import { ApprovalDrawer } from './ApprovalDrawer'
import { AutomateModal } from './AutomateModal'
import type { AutomateResult } from './contracts'
import { rowName, useApprovalActions, type BulkPreview } from './approvalActions'
import { HealthStrip } from './HealthStrip'
import { GROUP_COLUMN, PREFERENCE_COLUMNS, queueColumns, type QueueGridHandlers } from './queueColumns'
import { QueueToolbar, type QueuePageState } from './QueueToolbar'
import { useApprovalQueue } from './useApprovalQueue'
import {
  PHONE_MAX_PX,
  TILE_SHOW,
  clockText,
  countText,
  emptyWords,
  isPending,
  isQueueGroup,
  isQueueShow,
  rowMatchesTile,
  type QueueGroup,
  type QueueTile,
} from './queueWords'

/* ── stable grid options (GDS decision 12: no inline objects or arrows on <NexusGrid>) ────── */

const ROW_ID: NonNullable<NexusGridProps<QueueRow>['getRowId']> = (p) => p.data.id
const AUTO_GROUP_COLUMN: ColDef<QueueRow> = { headerName: 'Group', minWidth: 240 }
const PERSIST_KEYS: readonly GridStateKey[] = ['columnSizing', 'columnOrder', 'columnVisibility', 'columnPinning', 'sort', 'rowGroup']
const LOADING_PARAMS = { rows: 6 }
const BRIDGE: PrefsBridgeOptions = { columns: PREFERENCE_COLUMNS.map((c) => ({ key: c.key, locked: c.locked })) }
const DEFAULT_PREFS: PreferencesValue = {
  visibleColumns: PREFERENCE_COLUMNS.map((c) => c.key),
  lockedColumns: [],
  stickyFirstColumn: false,
  stickyLastColumn: true,
  pageSize: 0,
  sortBy: '',
  sortDir: 'asc',
}
const PREFERENCE_SPECS = PREFERENCE_COLUMNS.map((c) => ({ key: c.key, label: c.label, locked: c.locked }))
const NO_CHOICES: number[] = []
const NO_SORT_OPTIONS: Array<{ value: string; label: string }> = []

/** The rows a person may tick: open requests that still wait for them. A group's box ticks its rows. */
const SELECTION = {
  ...gridSelection<QueueRow>({
    // The header box ticks what the search and the tile left on screen, not rows hidden by them.
    selectAll: 'filtered',
    isRowSelectable: (n) => !n.rowPinned && (n.group ? true : !!n.data && isPending(n.data.state)),
  }),
  groupSelects: 'filteredDescendants',
} as NexusGridProps<QueueRow>['rowSelection']

/** Below 640 px: the phone layout (PublishRuns' `useNarrow`). */
function usePhone(): boolean {
  const [phone, setPhone] = useState(false)
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${PHONE_MAX_PX}px)`)
    const update = () => setPhone(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return phone
}

/** The expiry numbers the "How it works" drawer prints, read once (the gate state is not polled here). */
function useExpiryWords(): { hours: number | null; maintenanceSeconds: number | null } {
  const [expiry, setExpiry] = useState<{ hours: number | null; maintenanceSeconds: number | null }>({ hours: null, maintenanceSeconds: null })
  useEffect(() => {
    let live = true
    fetch(`${getBackendUrl()}/api/agent/fleet/approvals/gate-state`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((g: { expiry?: { hours?: number; maintenanceSeconds?: number } } | null) => {
        if (live && g?.expiry) setExpiry({ hours: g.expiry.hours ?? null, maintenanceSeconds: g.expiry.maintenanceSeconds ?? null })
      })
      .catch(() => {
        /* the drawer has honest words for "not known" */
      })
    return () => {
      live = false
    }
  }, [])
  return expiry
}

export function ApprovalsGrid() {
  return (
    <ToastProvider>
      <ApprovalsGridPage />
    </ToastProvider>
  )
}

interface BulkState {
  decision: 'approve' | 'reject'
  rows: QueueRow[]
  preview: BulkPreview | null
  error: string | null
  reason: string
  running: boolean
}

function ApprovalsGridPage() {
  const phone = usePhone()
  const expiry = useExpiryWords()
  const [show, setShow] = useState<QueueShow>('open')
  const [group, setGroup] = useState<QueueGroup>('none')
  const [tile, setTile] = useState<QueueTile | null>(null)
  const [search, setSearch] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  const [automateRow, setAutomateRow] = useState<QueueRow | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulk, setBulk] = useState<BulkState | null>(null)
  const [gridApi, setGridApi] = useState<GridApi<QueueRow> | null>(null)
  const apiRef = useRef<GridApi<QueueRow> | null>(null)

  const queue = useApprovalQueue(show)
  const actions = useApprovalActions({ refresh: queue.refresh, openAutomate: setAutomateRow })
  const rowsById = useMemo(() => new Map(queue.rows.map((r) => [r.id, r])), [queue.rows])
  // The clock of the last read: "Oldest waiting" and the tile filters age with the list, not with every render.
  const now = useMemo(() => Date.now(), [queue.readKey, queue.counts])

  /* ── the drawer, and the `?item` deep link ─────────────────────────────────────────────── */

  const params = useSearchParams()
  const pathname = usePathname()
  const router = useRouter()
  const itemParam = params?.get('item') ?? null
  useEffect(() => {
    if (itemParam) setOpenId(itemParam)
  }, [itemParam])

  const openRow = useCallback((row: QueueRow) => setOpenId(row.id), [])
  const closeDrawer = useCallback(() => {
    setOpenId(null)
    if (!params?.get('item')) return
    const rest = new URLSearchParams(params.toString())
    rest.delete('item')
    const query = rest.toString()
    router.replace(`${pathname ?? '/fleet/approvals'}${query ? `?${query}` : ''}`, { scroll: false })
  }, [params, pathname, router])

  /* ── the grid ──────────────────────────────────────────────────────────────────────────── */

  const handlers = useRef<QueueGridHandlers>({ actions, open: openRow })
  handlers.current = { actions, open: openRow }
  const columnDefs = useMemo(() => queueColumns(handlers, phone), [phone])

  const rowData = useMemo(() => {
    if (!tile) return queue.rows
    const ctx = { oldestNeedsYouAt: queue.counts?.oldestNeedsYouAt ?? null, now }
    return queue.rows.filter((r) => rowMatchesTile(r, tile, ctx))
  }, [queue.rows, queue.counts, tile, now])

  const clearFilters = useCallback(() => {
    setTile(null)
    setSearch('')
  }, [])
  const filtered = !!tile || search.trim() !== ''
  const noRowsParams = useMemo(() => {
    const words = emptyWords(show, filtered)
    return filtered ? { ...words, action: { label: 'Clear filters', onClick: clearFilters } } : words
  }, [show, filtered, clearFilters])

  // Saved views and the last-used layout (surface `fleet-approvals`). The list shown (`show`) is restored only from a
  // NAMED view: the page always opens on Open, the requests that need a person.
  const pageState = useRef<QueuePageState>({ show, group })
  pageState.current = { show, group }
  const restoringLastUsed = useRef(false)
  const gridViews = useGridState<QueuePageState>({
    surface: 'fleet-approvals',
    baseUrl: getBackendUrl(),
    getPageState: () => pageState.current,
    applyPageState: (page) => {
      if (!restoringLastUsed.current && isQueueShow(page?.show)) setShow(page.show)
      if (isQueueGroup(page?.group)) setGroup(page.group)
    },
    persistKeys: PERSIST_KEYS,
  })
  const bindViews = useRef(gridViews.bind)
  bindViews.current = gridViews.bind
  const markDirty = gridViews.markDirty
  useEffect(() => {
    markDirty()
  }, [markDirty, show, group])

  const onGridReady = useCallback((e: GridReadyEvent<QueueRow>) => {
    apiRef.current = e.api
    setGridApi(e.api)
    restoringLastUsed.current = true
    try {
      bindViews.current(e.api)
    } finally {
      restoringLastUsed.current = false
    }
  }, [])

  const groupRef = useRef(group)
  groupRef.current = group
  const applyGrouping = useCallback((api: GridApi<QueueRow>) => {
    if (api.isDestroyed()) return
    const g = groupRef.current
    api.setRowGroupColumns(g === 'none' ? [] : [GROUP_COLUMN[g]])
  }, [])
  useEffect(() => {
    if (gridApi) applyGrouping(gridApi)
  }, [gridApi, group, columnDefs, applyGrouping])

  // A busy row, a new error or a closed one: redraw only the cells that show them.
  useEffect(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    api.refreshCells({ columns: ['status', 'why', 'actions'], force: true })
  }, [actions.busyIds, actions.errors])

  const onSelectionChanged = useCallback((e: { api: GridApi<QueueRow> }) => {
    setSelectedIds(e.api.getSelectedNodes().flatMap((n) => (!n.group && n.data ? [n.data.id] : [])))
  }, [])
  const selected = useMemo(() => selectedIds.flatMap((id) => rowsById.get(id) ?? []), [selectedIds, rowsById])
  const clearSelection = useCallback(() => apiRef.current?.deselectAll(), [])

  const onRowClicked = useCallback<NonNullable<NexusGridProps<QueueRow>['onRowClicked']>>(
    (e) => {
      if (e.data && !e.node.group) openRow(e.data)
    },
    [openRow],
  )
  /* Enter on a focused cell opens the row — also through AG's own event, in case the grid takes Enter itself. Never
     from a button or a link inside the cell: Enter there is that control's. */
  const onCellKeyDown = useCallback<NonNullable<NexusGridProps<QueueRow>['onCellKeyDown']>>(
    (e) => {
      const key = e.event as KeyboardEvent | null | undefined
      if (key?.key !== 'Enter' || !e.data || e.node.group) return
      const target = key.target as HTMLElement | null
      if (target?.closest?.('button, a, input, [role="button"], [role="menuitem"]')) return
      openRow(e.data)
    },
    [openRow],
  )

  /* ── keyboard ──────────────────────────────────────────────────────────────────────────── */

  const hostRef = useRef<HTMLDivElement>(null)
  const focusedRow = useCallback((): QueueRow | null => {
    const api = apiRef.current
    const cell = api?.getFocusedCell()
    if (!api || !cell) return null
    const node = api.getDisplayedRowAtIndex(cell.rowIndex)
    return node && !node.group ? node.data ?? null : null
  }, [])
  const shortcuts = useMemo<GridShortcut[]>(() => {
    const keys: GridShortcut[] = [
      {
        key: 'a', label: 'Approve',
        run: () => {
          const row = focusedRow()
          if (!row) return
          if (row.state === 'failed') void actions.retry(row)
          else if (row.state === 'waiting' || row.state === 'back_to_you') void actions.approve(row)
        },
      },
      {
        key: 'r', label: 'Reject',
        run: () => {
          const row = focusedRow()
          if (row && isPending(row.state)) void actions.reject(row)
        },
      },
      { key: 'Enter', label: 'Details', run: () => { const row = focusedRow(); if (row) openRow(row) } },
      { key: 'Escape', label: 'Close details', run: closeDrawer },
    ]
    if (!phone) {
      keys.push({
        key: 'Space', label: 'Tick',
        run: () => {
          const api = apiRef.current
          const cell = api?.getFocusedCell()
          const node = cell ? api?.getDisplayedRowAtIndex(cell.rowIndex) : null
          if (node && !node.group && node.selectable) node.setSelected(!node.isSelected())
        },
      })
    }
    return keys
  }, [actions, focusedRow, openRow, closeDrawer, phone])
  const hints = useGridShortcuts(hostRef, shortcuts)

  /* ── Customise (the DS dialog through the column-state bridge) ─────────────────────────── */

  const [prefsOpen, setPrefsOpen] = useState(false)
  const [prefs, setPrefs] = useState<PreferencesValue>(DEFAULT_PREFS)
  const openCustomise = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    setPrefs((current) => columnStateToPrefs(api.getColumnState(), current, BRIDGE))
    setPrefsOpen(true)
  }, [])
  const applyPrefs = useCallback((next: PreferencesValue) => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    const state = prefsToColumnState(next, BRIDGE)
    // The group column is AG's own; keep it right after the checkboxes when rows are grouped.
    if (groupRef.current !== 'none') state.splice(1, 0, { colId: AG_AUTO_COL })
    api.applyColumnState({ state, applyOrder: true })
    setPrefs(next)
  }, [])
  const resetColumns = useCallback(() => {
    const api = apiRef.current
    if (!api || api.isDestroyed()) return
    api.resetColumnState()
    applyGrouping(api)
    setPrefs(DEFAULT_PREFS)
  }, [applyGrouping])
  const columnDialog = useMemo(() => (phone ? undefined : { customise: openCustomise, reset: resetColumns }), [phone, openCustomise, resetColumns])

  /* ── tiles, Show and Group ─────────────────────────────────────────────────────────────── */

  const onTile = useCallback((next: QueueTile | null) => {
    setTile(next)
    if (next) setShow(TILE_SHOW[next])
  }, [])
  const onShow = useCallback((next: QueueShow) => {
    setShow(next)
    setTile((t) => (t && TILE_SHOW[t] !== next ? null : t))
  }, [])

  /* ── bulk: preview → confirm → decide ──────────────────────────────────────────────────── */

  const startBulk = useCallback(
    (decision: 'approve' | 'reject') => {
      const rows = selected
      setBulk({ decision, rows, preview: null, error: null, reason: '', running: false })
      actions.bulkPreview(rows.map((r) => r.id), decision).then(
        (preview) => setBulk((b) => (b && b.decision === decision && b.rows === rows ? { ...b, preview } : b)),
        (e: unknown) => setBulk((b) => (b && b.rows === rows ? { ...b, error: e instanceof Error ? e.message : String(e) } : b)),
      )
    },
    [selected, actions],
  )
  const confirmBulk = useCallback(async () => {
    if (!bulk || !bulk.preview || bulk.preview.blockedReason || bulk.running) return
    setBulk({ ...bulk, running: true })
    const result = await actions.bulkDecide(bulk.rows, bulk.decision, bulk.decision === 'reject' ? bulk.reason : undefined)
    setBulk(null)
    // What ran is unticked; what the server skipped stays ticked, so the person sees which ones (the toast says why).
    const skipped = new Set(result.skipped.map((s) => s.id))
    const api = apiRef.current
    if (api && !api.isDestroyed() && result.done > 0) {
      api.forEachNode((n) => {
        if (n.data && !skipped.has(n.data.id) && n.isSelected()) n.setSelected(false)
      })
    }
  }, [bulk, actions])

  /* ── Automate ──────────────────────────────────────────────────────────────────────────── */

  const onAutomateSaved = useCallback(
    (result: AutomateResult) => {
      const row = automateRow
      setAutomateRow(null)
      queue.refresh()
      // A rule applies to new requests only; "Also approve this one" approves the row it was opened from.
      if (result.alsoApprove && row) void actions.approve(row)
    },
    [automateRow, queue, actions],
  )

  /* ── render ────────────────────────────────────────────────────────────────────────────── */

  const errorRows = [...actions.errors.entries()]
  const asOf = queue.asOf ? clockText(queue.asOf.toISOString()) : null

  return (
    <FleetPageShell
      title="Approvals"
      sub="Requests from Claude, the fleet and your rules. Approve or reject them here, or let a kind of change run by itself."
      aside={<HowApprovalsWork expiryHours={expiry.hours} maintenanceSeconds={expiry.maintenanceSeconds} />}
    >
      <div className="aqg-page">
        <HealthStrip counts={queue.counts} active={tile} onTile={onTile} narrow={phone} now={now} />

        {queue.error && queue.loaded ? (
          <Banner
            tone="warning"
            title="The list could not be refreshed."
            action={<Button size="sm" onClick={queue.refresh}>Try again</Button>}
          >
            {queue.error}
            {asOf ? ` It shows what was read at ${asOf}.` : null}
          </Banner>
        ) : null}

        {errorRows.length > 0 ? (
          <div className="aqg-errors" aria-live="polite">
            {errorRows.map(([id, message]) => {
              const row = rowsById.get(id)
              return (
                <Banner
                  key={id}
                  tone="danger"
                  title={row ? rowName(row) : 'A request'}
                  onDismiss={() => actions.dismissError(id)}
                  action={row ? <Button size="sm" onClick={() => openRow(row)}>Open</Button> : undefined}
                >
                  {message}
                </Banner>
              )
            })}
          </div>
        ) : null}

        {/* The keys' container is always mounted: `useGridShortcuts` binds to it once. */}
        <div ref={hostRef} className="aqg-host">
          {queue.error && !queue.loaded ? (
            // Never the empty grid: a failed first read must not look like "nothing needs you".
            <Banner tone="danger" title="The requests could not be loaded." action={<Button size="sm" onClick={queue.refresh}>Try again</Button>}>
              {queue.error}
            </Banner>
          ) : (
            <GridCard
              toolbar={
                <QueueToolbar
                  phone={phone}
                  count={queue.loaded ? countText(queue.rows.length, queue.total, show) : 'Reading the requests…'}
                  search={search}
                  onSearch={setSearch}
                  show={show}
                  onShow={onShow}
                  group={group}
                  onGroup={setGroup}
                  selected={selected}
                  onClear={clearSelection}
                  onBulk={startBulk}
                  views={gridViews}
                  onCustomise={openCustomise}
                />
              }
            >
              <NexusGrid<QueueRow>
                domLayout="autoHeight"
                suppressCellFocus={false}
                rowData={rowData}
                getRowId={ROW_ID}
                columnDefs={columnDefs}
                rowSelection={phone ? undefined : SELECTION}
                autoGroupColumnDef={AUTO_GROUP_COLUMN}
                groupDefaultExpanded={-1}
                suppressGroupChangesColumnVisibility="suppressShowOnUngroup"
                quickFilterText={search}
                loading={queue.loading}
                loadingOverlayComponent={GridLoadingOverlay}
                loadingOverlayComponentParams={LOADING_PARAMS}
                noRowsOverlayComponent={GridNoRowsOverlay}
                noRowsOverlayComponentParams={noRowsParams}
                initialState={gridViews.initialState}
                columnDialog={columnDialog}
                onGridReady={onGridReady}
                onSelectionChanged={onSelectionChanged}
                onRowClicked={onRowClicked}
                onCellKeyDown={onCellKeyDown}
              />
            </GridCard>
          )}
        </div>

        {queue.moreError ? (
          <Banner tone="danger" title="More requests could not be loaded." action={<Button size="sm" onClick={queue.loadMore}>Try again</Button>}>
            {queue.moreError}
          </Banner>
        ) : null}
        {queue.hasMore && !queue.moreError ? (
          <div className="aqg-more">
            <Button onClick={queue.loadMore} disabled={queue.loadingMore}>{queue.loadingMore ? 'Loading…' : 'Show more'}</Button>
          </div>
        ) : null}

        {phone ? null : (
          <div className="aqg-keys" role="list" aria-label="Keyboard shortcuts">
            <span role="listitem"><Kbd>↑</Kbd> <Kbd>↓</Kbd> Move</span>
            {hints.map((h) => (
              <span role="listitem" key={h.key}><Kbd>{h.keyLabel}</Kbd> {h.label}</span>
            ))}
          </div>
        )}
      </div>

      <ApprovalDrawer id={openId} row={openId ? rowsById.get(openId) ?? null : null} actions={actions} refreshKey={queue.readKey} onClose={closeDrawer} />
      <AutomateModal row={automateRow} onClose={() => setAutomateRow(null)} onSaved={onAutomateSaved} />

      <Modal
        open={!!bulk}
        onClose={() => (bulk?.running ? undefined : setBulk(null))}
        title={bulk ? `${bulk.decision === 'approve' ? 'Approve' : 'Reject'} ${bulk.rows.length} ${bulk.rows.length === 1 ? 'request' : 'requests'}?` : undefined}
        size="md"
        className="fleet-portal"
        footer={
          bulk ? (
            <>
              <Button onClick={() => setBulk(null)} disabled={bulk.running}>Cancel</Button>
              <Button
                variant={bulk.decision === 'approve' ? 'primary' : 'danger'}
                onClick={() => void confirmBulk()}
                disabled={!bulk.preview || !!bulk.preview.blockedReason || bulk.running}
              >
                {bulk.running
                  ? 'Working…'
                  : `${bulk.decision === 'approve' ? 'Approve' : 'Reject'} ${bulk.preview?.count ?? bulk.rows.length}`}
              </Button>
            </>
          ) : null
        }
      >
        {bulk ? (
          <div className="aqg-confirm">
            {bulk.error ? (
              <Banner tone="danger" title="Nexus could not check these requests.">{bulk.error}</Banner>
            ) : !bulk.preview ? (
              <div aria-busy="true" aria-label="Checking the requests">
                <Skeleton height={16} />
              </div>
            ) : (
              <>
                {bulk.preview.sentence ? <p className="aqg-sentence">{bulk.preview.sentence}</p> : null}
                {bulk.preview.blockedReason ? <Banner tone="warning" title="This cannot go ahead.">{bulk.preview.blockedReason}</Banner> : null}
                {bulk.decision === 'approve' && !bulk.preview.blockedReason ? (
                  <p className="aqg-note">Each one waits 20 s, so you can still undo it, and is checked again before it runs.</p>
                ) : null}
              </>
            )}
            {bulk.decision === 'reject' ? (
              <Field label="Reason (optional)" hint="It goes back to whoever asked.">
                <Textarea rows={3} value={bulk.reason} onChange={(e) => setBulk({ ...bulk, reason: e.target.value })} />
              </Field>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {prefsOpen ? (
        <PreferencesModal
          open={prefsOpen}
          onClose={() => setPrefsOpen(false)}
          value={prefs}
          onConfirm={applyPrefs}
          allColumns={PREFERENCE_SPECS}
          defaultVisible={DEFAULT_PREFS.visibleColumns}
          pageSizeChoices={NO_CHOICES}
          sortFieldOptions={NO_SORT_OPTIONS}
          showSticky={false}
          title="Customise columns"
          className="fleet-portal"
          listHint="Choose which columns show, and in what order. This browser remembers it; save a view in the Views menu to keep it everywhere."
        />
      ) : null}
    </FleetPageShell>
  )
}

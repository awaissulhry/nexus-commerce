'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { useSearchParams } from 'next/navigation'
import { CalendarClock, Download, History as HistoryIcon, Layers, Upload, Wand2 } from 'lucide-react'
import Link from 'next/link'
import FlatFileGrid from '@/components/flat-file/FlatFileGrid'
import type {
  BaseRow,
  FlatFileColumnGroup,
  ModalsCtx,
  PushExtrasCtx,
  ToolbarFetchCtx,
  ToolbarImportCtx,
} from '@/components/flat-file/FlatFileGrid.types'
import { getBackendUrl } from '@/lib/backend-url'
import { FFFilterPanel, type FFFilterState } from '@/app/products/_shared/FFFilterPanel'
import { AMAZON_FILTER_DEFAULT as FF_FILTER_DEFAULT } from '@/app/products/_shared/flat-file-filter.types'
import { FFSavedViews, type FFViewState } from '@/app/products/_shared/FFSavedViews'
import { UnifiedFilterExtras, type UnifiedFilterState, UNIFIED_FILTER_DEFAULT, unifiedFilterActiveCount } from './UnifiedFilterExtras'

// ─── Props from server ────────────────────────────────────────────────────────

interface Props {
  initialColumnGroups: FlatFileColumnGroup[]
  initialRows: BaseRow[]
  initialNextCursor: string | null
  initialProductIds?: string
  initialSearch?: string
}

// ─── Blank row factory ────────────────────────────────────────────────────────

function makeBlankRow(): BaseRow {
  return {
    _rowId: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    _isNew: true,
    _dirty: true,
    _status: 'idle',
    sku: '',
    name: '',
  }
}

// ─── Row grouping key (parent → children) ────────────────────────────────────

function getGroupKey(row: BaseRow): string {
  return (row._parentId as string | null) ?? row._rowId
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validateRows(rows: BaseRow[]) {
  const issues: { level: 'error' | 'warn'; sku: string; field: string; msg: string }[] = []
  for (const row of rows) {
    if (!String(row.sku ?? '').trim()) {
      issues.push({ level: 'error', sku: String(row.sku ?? ''), field: 'sku', msg: 'SKU is required' })
    }
  }
  return issues
}

// ─── Sub-page link button (matches existing page style) ──────────────────────

function SubPageLink({ href, icon: Icon, label }: { href: string; icon: React.ComponentType<{ className?: string }>; label: string }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors"
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </Link>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function UnifiedFlatFileClient({
  initialColumnGroups,
  initialRows,
  initialNextCursor,
  initialProductIds,
  initialSearch,
}: Props) {
  const searchParams = useSearchParams()

  // ── Data state ────────────────────────────────────────────────────
  const [columnGroups, setColumnGroups] = useState<FlatFileColumnGroup[]>(initialColumnGroups)
  const [nextCursor, setNextCursor]     = useState<string | null>(initialNextCursor)
  const [loadingMore, setLoadingMore]   = useState(false)

  // ── Filters ───────────────────────────────────────────────────────
  const [filterOpen, setFilterOpen]       = useState(false)
  const [ffFilter, setFfFilter]           = useState<FFFilterState>(FF_FILTER_DEFAULT)
  const [unifiedFilter, setUnifiedFilter] = useState<UnifiedFilterState>({
    ...UNIFIED_FILTER_DEFAULT,
    search: initialSearch ?? '',
  })

  // ── Saved views ───────────────────────────────────────────────────
  const [closedGroups, setClosedGroups]     = useState<string[]>([])
  const [sortConfig, setSortConfig]         = useState<any[]>([])
  const [cfRules, setCfRules]               = useState<any[]>([])
  const [frozenColCount, setFrozenColCount] = useState(1)

  const currentViewState: FFViewState = useMemo(
    () => ({ closedGroups, ffFilter, sortConfig, cfRules, frozenColCount }),
    [closedGroups, ffFilter, sortConfig, cfRules, frozenColCount],
  )

  // ── Build query string ────────────────────────────────────────────
  const buildQs = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams()
      const productIds = initialProductIds ?? searchParams.get('productIds')
      if (productIds) params.set('productIds', productIds)
      if (unifiedFilter.search)             params.set('search', unifiedFilter.search)
      if (unifiedFilter.productTypes.length) params.set('productTypes', unifiedFilter.productTypes.join(','))
      if (unifiedFilter.status.length)      params.set('status', unifiedFilter.status.join(','))
      if (unifiedFilter.stockLevel !== 'all') params.set('stockLevel', unifiedFilter.stockLevel)
      if (ffFilter.channel.parentage !== 'any')     params.set('parentage', ffFilter.channel.parentage)
      if (ffFilter.channel.hasAsin !== 'any')       params.set('hasAsin', ffFilter.channel.hasAsin)
      for (const bn of unifiedFilter.browseNodeIds) params.append('browseNodeId', bn)
      if (unifiedFilter.ebayCategory)       params.set('ebayCategory', unifiedFilter.ebayCategory)
      if (cursor) params.set('cursor', cursor)
      return params.toString()
    },
    [initialProductIds, searchParams, ffFilter, unifiedFilter],
  )

  // ── Refetch on filter change (triggers onReload via key prop change) ─
  const [filterVersion, setFilterVersion] = useState(0)
  void filterVersion // consumed by FlatFileGrid key prop below
  useEffect(() => { setFilterVersion((v) => v + 1) }, [ffFilter, unifiedFilter])

  // ── onReload (called by FlatFileGrid on Reload action) ───────────
  const onReload = useCallback(async (): Promise<BaseRow[]> => {
    const res = await fetch(
      `${getBackendUrl()}/api/flat-file/unified-rows?${buildQs()}`,
      { cache: 'no-store' },
    )
    const json = await res.json()
    setColumnGroups(prev => prev) // template stays stable
    setNextCursor(json.nextCursor ?? null)
    return json.rows ?? []
  }, [buildQs])

  // ── onSave ────────────────────────────────────────────────────────
  const onSave = useCallback(async (dirty: BaseRow[]): Promise<{ saved: number }> => {
    const changes: Array<{ rowId: string; colId: string; value: unknown }> = []
    for (const row of dirty) {
      const rowId = row._rowId as string
      for (const [colId, value] of Object.entries(row)) {
        if (colId.startsWith('_')) continue
        changes.push({ rowId, colId, value })
      }
    }
    const res = await fetch(`${getBackendUrl()}/api/flat-file/unified-rows`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes }),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? `Save failed: HTTP ${res.status}`)
    const saved = json.saved ?? dirty.length
    if (saved > 0) {
      emitInvalidation({ type: 'product.updated', meta: { source: 'unified-flat-file' } })
      emitInvalidation({ type: 'stock.adjusted', meta: { source: 'unified-flat-file' } })
    }
    return { saved }
  }, [])

  // ── Saved views apply ─────────────────────────────────────────────
  const handleApplyView = useCallback((state: FFViewState) => {
    setClosedGroups(state.closedGroups)
    setFfFilter(state.ffFilter)
    setSortConfig(state.sortConfig)
    setCfRules(state.cfRules)
    setFrozenColCount(state.frozenColCount)
  }, [])

  // ── Load more (cursor pagination) ─────────────────────────────────
  const [moreRows, setMoreRows] = useState<BaseRow[]>([])
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/flat-file/unified-rows?${buildQs(nextCursor)}`,
        { cache: 'no-store' },
      )
      const json = await res.json()
      setMoreRows((prev) => [...prev, ...(json.rows ?? [])])
      setNextCursor(json.nextCursor ?? null)
    } finally {
      setLoadingMore(false)
    }
  }, [nextCursor, loadingMore, buildQs])

  // Combined initial + loaded rows
  const allInitialRows = useMemo(
    () => [...initialRows, ...moreRows] as BaseRow[],
    [initialRows, moreRows],
  )

  // ── renderBar3Left ────────────────────────────────────────────────
  // Matches eBay's pattern — shown in Bar 3 left slot
  const [unifiedFilterOpen, setUnifiedFilterOpen] = useState(false)
  const unifiedActiveCount = unifiedFilterActiveCount(unifiedFilter)

  const renderBar3Left = useCallback(() => (
    <div className="flex items-center gap-2">
      <FFFilterPanel
        open={filterOpen}
        onOpenChange={setFilterOpen}
        value={ffFilter}
        onChange={setFfFilter}
      />
      {/* Unified (cross-channel) filter trigger */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setUnifiedFilterOpen((o) => !o)}
          className={[
            'inline-flex items-center gap-1.5 h-7 px-2 text-xs border rounded-md transition-colors',
            unifiedActiveCount > 0
              ? 'border-blue-300 bg-blue-50 text-blue-800 hover:bg-blue-100 dark:border-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700',
          ].join(' ')}
        >
          More filters{unifiedActiveCount > 0 && <span className="ml-1 text-[10px] bg-blue-600 text-white rounded px-1 py-0.5">{unifiedActiveCount}</span>}
        </button>
        {unifiedFilterOpen && (
          <div className="absolute left-0 top-full mt-1 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-lg z-30 p-3 space-y-3">
            <UnifiedFilterExtras value={unifiedFilter} onChange={setUnifiedFilter} />
          </div>
        )}
      </div>
      <FFSavedViews
        currentState={currentViewState}
        onApply={handleApplyView}
        storageKey="unified-bulk-ops-views"
      />
    </div>
  ), [filterOpen, ffFilter, unifiedFilter, unifiedFilterOpen, unifiedActiveCount, currentViewState, handleApplyView])

  // ── renderPushExtras ──────────────────────────────────────────────
  // Sub-page links in Bar 1 (right side, after Save button)
  const renderPushExtras = useCallback((_ctx: PushExtrasCtx) => (
    <div className="flex items-center gap-0.5 ml-1">
      <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mr-0.5 flex-shrink-0" />
      <SubPageLink href="/bulk-operations/imports"   icon={Upload}       label="Imports" />
      <SubPageLink href="/bulk-operations/exports"   icon={Download}     label="Exports" />
      <SubPageLink href="/bulk-operations/automation" icon={Wand2}       label="Automation" />
      <SubPageLink href="/bulk-operations/schedules" icon={CalendarClock} label="Schedules" />
      <SubPageLink href="/bulk-operations/history"   icon={HistoryIcon}  label="History" />
    </div>
  ), [])

  // ── renderFeedBanner ──────────────────────────────────────────────
  const renderFeedBanner = useCallback(() => (
    nextCursor ? (
      <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 dark:bg-blue-950/20 border-b border-blue-100 dark:border-blue-900 text-xs text-blue-700 dark:text-blue-300">
        <span>Showing first {allInitialRows.length} rows —</span>
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="font-semibold underline hover:text-blue-900 dark:hover:text-blue-100 disabled:opacity-50"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      </div>
    ) : null
  ), [nextCursor, allInitialRows.length, loadingMore, loadMore])

  // ─────────────────────────────────────────────────────────────────
  return (
    <FlatFileGrid
      channel="all"
      title="Bulk Operations"
      titleIcon={<Layers className="w-4 h-4 text-slate-400" />}
      marketplace="ALL CHANNELS"
      storageKey="unified-bulk-ops"
      columnGroups={columnGroups}
      initialRows={allInitialRows}
      makeBlankRow={makeBlankRow}
      minRows={15}
      getGroupKey={getGroupKey}
      validate={validateRows}
      onSave={onSave}
      onReload={onReload}
      renderBar3Left={renderBar3Left}
      renderPushExtras={renderPushExtras}
      renderFeedBanner={renderFeedBanner}
      renderModals={(_ctx: ModalsCtx) => null}
      renderToolbarFetch={(_ctx: ToolbarFetchCtx) => null}
      renderToolbarImport={(_ctx: ToolbarImportCtx) => null}
    />
  )
}

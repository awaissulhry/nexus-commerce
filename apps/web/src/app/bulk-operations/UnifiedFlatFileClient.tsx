'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Layers, RefreshCw, Save } from 'lucide-react'
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
import { FFFilterPanel, type FFFilterState, FF_FILTER_DEFAULT } from '@/app/products/_shared/FFFilterPanel'
import { FFSavedViews, type FFViewState } from '@/app/products/_shared/FFSavedViews'
import { UnifiedFilterExtras, type UnifiedFilterState, UNIFIED_FILTER_DEFAULT, unifiedFilterActiveCount } from './UnifiedFilterExtras'

// ─── Types ────────────────────────────────────────────────────────────────────

interface UnifiedRow extends BaseRow {
  _isMaster: boolean
  _parentId: string | null
  _thumbnailUrl: string | null
  sku: string
  name: string
}

// ─── Blank row factory ────────────────────────────────────────────────────────

function makeBlankRow(): BaseRow {
  return {
    _rowId: `new-${Date.now()}`,
    _isNew: true,
    _dirty: true,
    _status: 'idle',
    sku: '',
    name: '',
  }
}

// ─── Row grouping key ─────────────────────────────────────────────────────────

function getGroupKey(row: BaseRow): string {
  const r = row as UnifiedRow
  return r._parentId ?? r._rowId
}

// ─── Row validation ───────────────────────────────────────────────────────────

function validateRows(rows: BaseRow[]) {
  const issues: { level: 'error' | 'warn'; sku: string; field: string; msg: string }[] = []
  for (const row of rows) {
    const r = row as UnifiedRow
    if (!String(r.sku ?? '').trim()) {
      issues.push({ level: 'error', sku: '', field: 'sku', msg: 'SKU is required' })
    }
  }
  return issues
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function UnifiedFlatFileClient() {
  const searchParams = useSearchParams()

  // ── Data state ────────────────────────────────────────────────────
  const [columnGroups, setColumnGroups] = useState<FlatFileColumnGroup[]>([])
  const [initialRows, setInitialRows]   = useState<BaseRow[]>([])
  const [loading, setLoading]           = useState(true)
  const [error, setError]               = useState<string | null>(null)
  const [nextCursor, setNextCursor]     = useState<string | null>(null)
  const [loadingMore, setLoadingMore]   = useState(false)

  // ── Filters ───────────────────────────────────────────────────────
  const [filterOpen, setFilterOpen]       = useState(false)
  const [ffFilter, setFfFilter]           = useState<FFFilterState>(FF_FILTER_DEFAULT)
  const [unifiedFilter, setUnifiedFilter] = useState<UnifiedFilterState>(UNIFIED_FILTER_DEFAULT)

  // ── Saved views ───────────────────────────────────────────────────
  const [closedGroups, setClosedGroups]   = useState<string[]>([])
  const [sortConfig, setSortConfig]       = useState<any[]>([])
  const [cfRules, setCfRules]             = useState<any[]>([])
  const [frozenColCount, setFrozenColCount] = useState(1)

  const currentViewState: FFViewState = useMemo(
    () => ({ closedGroups, ffFilter, sortConfig, cfRules, frozenColCount }),
    [closedGroups, ffFilter, sortConfig, cfRules, frozenColCount],
  )

  // ── Draft recovery ────────────────────────────────────────────────
  const [hasDraft, setHasDraft] = useState(false)
  const DRAFT_KEY = 'unified-bulk-ops-draft'

  // ── Build query string from filters ──────────────────────────────
  const buildQueryString = useCallback(
    (cursor?: string) => {
      const params = new URLSearchParams()

      // Deep-link: ?productIds from /products BulkActionBar
      const productIds = searchParams.get('productIds')
      if (productIds) params.set('productIds', productIds)

      if (unifiedFilter.search)       params.set('search', unifiedFilter.search)
      if (unifiedFilter.productTypes.length)
        params.set('productTypes', unifiedFilter.productTypes.join(','))
      if (unifiedFilter.status.length)
        params.set('status', unifiedFilter.status.join(','))
      if (unifiedFilter.stockLevel !== 'all')
        params.set('stockLevel', unifiedFilter.stockLevel)
      if (ffFilter.parentage !== 'any') params.set('parentage', ffFilter.parentage)
      if (ffFilter.hasAsin !== 'any')   params.set('hasAsin', ffFilter.hasAsin)
      for (const bn of unifiedFilter.browseNodeIds)
        params.append('browseNodeId', bn)
      if (unifiedFilter.ebayCategory)  params.set('ebayCategory', unifiedFilter.ebayCategory)
      if (cursor) params.set('cursor', cursor)

      return params.toString()
    },
    [searchParams, ffFilter, unifiedFilter],
  )

  // ── Fetch template + rows ─────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    const backend = getBackendUrl()
    try {
      const [tmplRes, rowsRes] = await Promise.all([
        fetch(`${backend}/api/flat-file/unified-template`, { cache: 'no-store' }),
        fetch(`${backend}/api/flat-file/unified-rows?${buildQueryString()}`, { cache: 'no-store' }),
      ])
      if (!tmplRes.ok) throw new Error(`Template: HTTP ${tmplRes.status}`)
      if (!rowsRes.ok) throw new Error(`Rows: HTTP ${rowsRes.status}`)
      const tmplJson = await tmplRes.json()
      const rowsJson = await rowsRes.json()
      setColumnGroups(tmplJson.groups ?? [])
      setInitialRows(rowsJson.rows ?? [])
      setNextCursor(rowsJson.nextCursor ?? null)

      // Check for draft
      try {
        const draft = localStorage.getItem(DRAFT_KEY)
        setHasDraft(!!draft)
      } catch {}
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [buildQueryString])

  useEffect(() => { void fetchData() }, [fetchData])

  // ── Load more ─────────────────────────────────────────────────────
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    const backend = getBackendUrl()
    try {
      const res = await fetch(
        `${backend}/api/flat-file/unified-rows?${buildQueryString(nextCursor)}`,
        { cache: 'no-store' },
      )
      const json = await res.json()
      setInitialRows((prev) => [...prev, ...(json.rows ?? [])])
      setNextCursor(json.nextCursor ?? null)
    } finally {
      setLoadingMore(false)
    }
  }, [nextCursor, loadingMore, buildQueryString])

  // ── Save ──────────────────────────────────────────────────────────
  const onSave = useCallback(async (dirty: BaseRow[]): Promise<{ saved: number }> => {
    // Collect all changes as individual column changes
    const changes: Array<{ rowId: string; colId: string; value: unknown }> = []
    for (const row of dirty) {
      const rowId = row._rowId as string
      for (const [colId, value] of Object.entries(row)) {
        if (colId.startsWith('_')) continue
        changes.push({ rowId, colId, value })
      }
    }
    const backend = getBackendUrl()
    const res = await fetch(`${backend}/api/flat-file/unified-rows`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes }),
    })
    const json = await res.json()
    if (!res.ok) throw new Error(json.error ?? `Save failed: HTTP ${res.status}`)
    // Clear draft on successful save
    try { localStorage.removeItem(DRAFT_KEY) } catch {}
    setHasDraft(false)
    return { saved: json.saved ?? dirty.length }
  }, [])

  // ── Reload ────────────────────────────────────────────────────────
  const onReload = useCallback(async (): Promise<BaseRow[]> => {
    const backend = getBackendUrl()
    const res = await fetch(
      `${backend}/api/flat-file/unified-rows?${buildQueryString()}`,
      { cache: 'no-store' },
    )
    const json = await res.json()
    setNextCursor(json.nextCursor ?? null)
    return json.rows ?? []
  }, [buildQueryString])

  // ── Saved views apply ─────────────────────────────────────────────
  const handleApplyView = useCallback((state: FFViewState) => {
    setClosedGroups(state.closedGroups)
    setFfFilter(state.ffFilter)
    setSortConfig(state.sortConfig)
    setCfRules(state.cfRules)
    setFrozenColCount(state.frozenColCount)
  }, [])

  // ── Filter bar (rendered inside FlatFileGrid via renderBar3Left) ──
  const renderBar3Left = useCallback(() => (
    <div className="flex items-center gap-2">
      <FFFilterPanel
        open={filterOpen}
        onOpenChange={setFilterOpen}
        value={ffFilter}
        onChange={setFfFilter}
        extraActiveCount={unifiedFilterActiveCount(unifiedFilter)}
        extraDimensions={
          <UnifiedFilterExtras
            value={unifiedFilter}
            onChange={setUnifiedFilter}
          />
        }
      />
      <FFSavedViews
        currentState={currentViewState}
        onApply={handleApplyView}
        storageKey="unified-bulk-ops-views"
      />
    </div>
  ), [filterOpen, ffFilter, unifiedFilter, currentViewState, handleApplyView])

  // ── Feed banner: draft recovery + load more ───────────────────────
  const renderFeedBanner = useCallback(() => (
    <>
      {hasDraft && (
        <div className="flex items-center gap-3 px-3 py-2 bg-amber-50 dark:bg-amber-950/30 border-b border-amber-200 dark:border-amber-800 text-xs text-amber-800 dark:text-amber-300">
          <Save className="w-3.5 h-3.5 flex-shrink-0" />
          You have unsaved draft changes from a previous session.
          <button
            onClick={() => {
              try {
                const draft = localStorage.getItem(DRAFT_KEY)
                if (draft) {
                  // Draft recovery: for now just notify; full undo-redo wiring in Phase 5
                  console.info('[UnifiedFlatFile] Draft recovery pending Phase 5')
                }
              } catch {}
              setHasDraft(false)
            }}
            className="font-semibold underline hover:text-amber-900 dark:hover:text-amber-200"
          >
            Restore
          </button>
          <button
            onClick={() => {
              try { localStorage.removeItem(DRAFT_KEY) } catch {}
              setHasDraft(false)
            }}
            className="text-amber-600 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-200"
          >
            Dismiss
          </button>
        </div>
      )}
      {nextCursor && (
        <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 dark:bg-blue-950/20 border-b border-blue-100 dark:border-blue-900 text-xs text-blue-700 dark:text-blue-300">
          <RefreshCw className="w-3.5 h-3.5" />
          Showing first {initialRows.length} rows.
          <button
            onClick={loadMore}
            disabled={loadingMore}
            className="font-semibold underline hover:text-blue-900 dark:hover:text-blue-100 disabled:opacity-50"
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </>
  ), [hasDraft, nextCursor, initialRows.length, loadingMore, loadMore])

  // ── Error state ───────────────────────────────────────────────────
  if (error && !loading) {
    return (
      <div className="flex items-center justify-center h-64 text-sm text-red-600 dark:text-red-400">
        Failed to load unified catalog: {error}
      </div>
    )
  }

  // ── Grid ──────────────────────────────────────────────────────────
  return (
    <FlatFileGrid
      channel="all"
      title="Bulk Operations"
      titleIcon={<Layers className="w-4 h-4 text-slate-400" />}
      marketplace="ALL"
      storageKey="unified-bulk-ops"
      columnGroups={columnGroups}
      initialRows={loading ? [] : initialRows}
      makeBlankRow={makeBlankRow}
      minRows={loading ? 20 : 10}
      getGroupKey={getGroupKey}
      validate={validateRows}
      onSave={onSave}
      onReload={onReload}
      renderBar3Left={renderBar3Left}
      renderFeedBanner={renderFeedBanner}
      renderModals={(_ctx: ModalsCtx) => null}
      renderPushExtras={(_ctx: PushExtrasCtx) => null}
      renderToolbarFetch={(_ctx: ToolbarFetchCtx) => null}
      renderToolbarImport={(_ctx: ToolbarImportCtx) => null}
    />
  )
}

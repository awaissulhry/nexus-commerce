'use client'

import {
  useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent,
} from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle, CheckCircle2, ChevronLeft, ChevronRight,
  Download, FileSpreadsheet, Loader2, Plus, RefreshCw,
  Send, Trash2, Upload, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'

// ── Types ──────────────────────────────────────────────────────────────

type ColumnKind = 'text' | 'longtext' | 'number' | 'enum' | 'boolean'

interface Column {
  id: string
  label: string
  description?: string
  required: boolean
  kind: ColumnKind
  options?: string[]
  maxLength?: number
  width: number
  examples?: string[]
}

interface ColumnGroup {
  id: string
  label: string
  color: string
  columns: Column[]
}

interface Manifest {
  marketplace: string
  productType: string
  variationThemes: string[]
  fetchedAt: string
  groups: ColumnGroup[]
}

interface Row {
  _rowId: string
  _isNew?: boolean
  _dirty?: boolean
  _status?: 'idle' | 'pending' | 'success' | 'error'
  _feedMessage?: string
  _productId?: string
  [key: string]: unknown
}

interface FeedResult {
  sku: string
  status: string
  message: string
}

// ── Constants ──────────────────────────────────────────────────────────

const MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK']

const GROUP_COLORS: Record<string, { band: string; header: string; text: string; cell: string }> = {
  blue:    { band: 'bg-blue-50 dark:bg-blue-950/30', header: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300', text: 'text-blue-700 dark:text-blue-300', cell: 'bg-blue-50/40 dark:bg-blue-950/10' },
  purple:  { band: 'bg-purple-50 dark:bg-purple-950/30', header: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300', text: 'text-purple-700 dark:text-purple-300', cell: 'bg-purple-50/40 dark:bg-purple-950/10' },
  emerald: { band: 'bg-emerald-50 dark:bg-emerald-950/30', header: 'bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300', text: 'text-emerald-700 dark:text-emerald-300', cell: 'bg-emerald-50/40 dark:bg-emerald-950/10' },
  amber:   { band: 'bg-amber-50 dark:bg-amber-950/30', header: 'bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300', text: 'text-amber-700 dark:text-amber-300', cell: 'bg-amber-50/40 dark:bg-amber-950/10' },
  slate:   { band: 'bg-slate-50 dark:bg-slate-900/30', header: 'bg-slate-100 dark:bg-slate-800/60 text-slate-600 dark:text-slate-400', text: 'text-slate-600 dark:text-slate-400', cell: '' },
  violet:  { band: 'bg-violet-50 dark:bg-violet-950/30', header: 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300', text: 'text-violet-700 dark:text-violet-300', cell: 'bg-violet-50/40 dark:bg-violet-950/10' },
}

const NEUTRAL_COLOR = GROUP_COLORS.slate

function groupColor(color: string) {
  return GROUP_COLORS[color] ?? NEUTRAL_COLOR
}

function makeEmptyRow(productType: string, marketplace: string): Row {
  return {
    _rowId: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    _isNew: true,
    _dirty: true,
    _status: 'idle',
    update_delete: 'Update',
    item_sku: '',
    feed_product_type: productType,
    parent_child: '',
    parent_sku: '',
    relationship_type: '',
    variation_theme: '',
    item_name: '',
    product_description: '',
    bullet_point1: '', bullet_point2: '', bullet_point3: '',
    bullet_point4: '', bullet_point5: '',
    generic_keyword: '',
    standard_price: '',
    currency_code: marketplace === 'UK' ? 'GBP' : 'EUR',
    quantity: '',
    external_product_id: '',
    external_product_id_type: '',
  }
}

// ── Props ──────────────────────────────────────────────────────────────

interface Props {
  initialManifest: Manifest | null
  initialRows: Row[]
  initialMarketplace: string
  initialProductType: string
}

// ── Component ──────────────────────────────────────────────────────────

export default function AmazonFlatFileClient({
  initialManifest,
  initialRows,
  initialMarketplace,
  initialProductType,
}: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [marketplace, setMarketplace] = useState(initialMarketplace)
  const [productType, setProductType] = useState(initialProductType)
  const [productTypeInput, setProductTypeInput] = useState(initialProductType)

  const [manifest, setManifest] = useState<Manifest | null>(initialManifest)
  const [rows, setRows] = useState<Row[]>(initialRows)

  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set(['identity', 'variation', 'content', 'pricing']))
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())

  // Editing state: which cell is active
  const [activeCell, setActiveCell] = useState<{ rowId: string; colId: string } | null>(null)

  // Feed submission
  const [feedId, setFeedId] = useState<string | null>(null)
  const [feedStatus, setFeedStatus] = useState<string | null>(null)
  const [feedResults, setFeedResults] = useState<FeedResult[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [polling, setPolling] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── Derived data ───────────────────────────────────────────────────

  const allColumns = useMemo<Column[]>(() => {
    if (!manifest) return []
    return manifest.groups
      .filter((g) => openGroups.has(g.id))
      .flatMap((g) => g.columns)
  }, [manifest, openGroups])

  const colGroupForId = useMemo<Map<string, string>>(() => {
    if (!manifest) return new Map()
    const m = new Map<string, string>()
    for (const g of manifest.groups) {
      for (const c of g.columns) m.set(c.id, g.color)
    }
    return m
  }, [manifest])

  const newCount = useMemo(() => rows.filter((r) => r._isNew).length, [rows])

  // ── Load manifest + rows ───────────────────────────────────────────

  const loadData = useCallback(async (mp: string, pt: string, force = false) => {
    if (!pt.trim()) return
    setLoading(true)
    setLoadError(null)
    setFeedId(null)
    setFeedResults([])

    const backend = getBackendUrl()
    const qs = new URLSearchParams({ marketplace: mp, productType: pt, ...(force ? { force: '1' } : {}) })

    try {
      const [manifestRes, rowsRes] = await Promise.all([
        fetch(`${backend}/api/amazon/flat-file/template?${qs}`),
        fetch(`${backend}/api/amazon/flat-file/rows?${new URLSearchParams({ marketplace: mp, productType: pt })}`),
      ])

      if (!manifestRes.ok) {
        const err = await manifestRes.json().catch(() => ({}))
        throw new Error(err.error ?? `Schema fetch failed (${manifestRes.status})`)
      }

      const newManifest: Manifest = await manifestRes.json()
      setManifest(newManifest)
      setOpenGroups(new Set(['identity', 'variation', 'content', 'pricing', 'identifiers']))

      if (rowsRes.ok) {
        const data = await rowsRes.json()
        setRows(data.rows ?? [])
      } else {
        setRows([])
      }

      // Update URL params
      const params = new URLSearchParams(searchParams?.toString() ?? '')
      params.set('marketplace', mp)
      params.set('productType', pt)
      router.replace(`?${params.toString()}`, { scroll: false })
    } catch (err: any) {
      setLoadError(err.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [router, searchParams])

  // ── Row manipulation ───────────────────────────────────────────────

  const addRow = useCallback((isParent = false) => {
    const row = makeEmptyRow(productType, marketplace)
    if (isParent) {
      row.parent_child = 'Parent'
    }
    setRows((prev) => [...prev, row])
    // Focus the SKU cell of the new row
    setTimeout(() => setActiveCell({ rowId: row._rowId as string, colId: 'item_sku' }), 50)
  }, [productType, marketplace])

  const addChildRow = useCallback(() => {
    const row = makeEmptyRow(productType, marketplace)
    row.parent_child = 'Child'
    row.relationship_type = 'Variation'
    setRows((prev) => [...prev, row])
    setTimeout(() => setActiveCell({ rowId: row._rowId as string, colId: 'item_sku' }), 50)
  }, [productType, marketplace])

  const deleteSelectedRows = useCallback(() => {
    setRows((prev) => prev.filter((r) => !selectedRows.has(r._rowId as string)))
    setSelectedRows(new Set())
  }, [selectedRows])

  const updateCell = useCallback((rowId: string, colId: string, value: unknown) => {
    setRows((prev) =>
      prev.map((r) =>
        r._rowId === rowId ? { ...r, [colId]: value, _dirty: true } : r,
      ),
    )
  }, [])

  // ── Navigation between cells ───────────────────────────────────────

  const navigateCell = useCallback(
    (rowId: string, colId: string, direction: 'right' | 'left' | 'down' | 'up') => {
      const colIds = allColumns.map((c) => c.id)
      const rowIds = rows.map((r) => r._rowId as string)
      const ci = colIds.indexOf(colId)
      const ri = rowIds.indexOf(rowId)

      let nextCi = ci
      let nextRi = ri
      if (direction === 'right') nextCi = Math.min(ci + 1, colIds.length - 1)
      else if (direction === 'left') nextCi = Math.max(ci - 1, 0)
      else if (direction === 'down') nextRi = Math.min(ri + 1, rowIds.length - 1)
      else if (direction === 'up') nextRi = Math.max(ri - 1, 0)

      const nextCol = colIds[nextCi]
      const nextRow = rowIds[nextRi]
      if (nextCol && nextRow) setActiveCell({ rowId: nextRow, colId: nextCol })
    },
    [allColumns, rows],
  )

  // ── Feed submission ────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    const submitRows = rows.filter((r) => r._dirty || r._isNew)
    if (submitRows.length === 0) return

    setSubmitting(true)
    setFeedId(null)
    setFeedResults([])
    setFeedStatus(null)

    // Mark pending
    setRows((prev) =>
      prev.map((r) =>
        r._dirty || r._isNew ? { ...r, _status: 'pending' } : r,
      ),
    )

    try {
      const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: submitRows, marketplace }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Submit failed')

      setFeedId(data.feedId)
      setFeedStatus('IN_QUEUE')

      // Mark rows as submitted (no longer dirty, but pending feed result)
      setRows((prev) =>
        prev.map((r) =>
          r._dirty || r._isNew ? { ...r, _dirty: false, _isNew: false, _status: 'pending' } : r,
        ),
      )
    } catch (err: any) {
      setRows((prev) =>
        prev.map((r) =>
          r._status === 'pending' ? { ...r, _status: 'idle', _dirty: true } : r,
        ),
      )
      setLoadError(err.message ?? 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }, [rows, marketplace])

  const pollFeedStatus = useCallback(async () => {
    if (!feedId) return
    setPolling(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/feeds/${feedId}`)
      const data = await res.json()
      setFeedStatus(data.processingStatus)

      if (data.processingStatus === 'DONE') {
        setFeedResults(data.results ?? [])
        // Apply per-row results
        const resultBySku = new Map<string, FeedResult>(
          (data.results as FeedResult[]).map((r) => [r.sku, r]),
        )
        setRows((prev) =>
          prev.map((r) => {
            const result = resultBySku.get(r.item_sku as string)
            if (!result) return r
            return { ...r, _status: result.status as any, _feedMessage: result.message }
          }),
        )
      }
    } catch (err: any) {
      setLoadError(err.message ?? 'Status poll failed')
    } finally {
      setPolling(false)
    }
  }, [feedId])

  // ── TSV Import ─────────────────────────────────────────────────────

  const handleFileImport = useCallback(async (file: File) => {
    const content = await file.text()
    const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/parse-tsv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, productType, marketplace }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      setLoadError(err.error ?? 'Import failed')
      return
    }
    const data = await res.json()
    const importedRows: Row[] = (data.rows ?? []).map((r: any) => ({
      ...r,
      _dirty: true,
      _isNew: !r._productId,
    }))
    setRows((prev) => {
      // Merge: update existing SKUs, append new
      const existingBySku = new Map(prev.map((r) => [r.item_sku as string, r]))
      for (const ir of importedRows) {
        const sku = ir.item_sku as string
        if (existingBySku.has(sku)) {
          existingBySku.set(sku, { ...existingBySku.get(sku)!, ...ir, _dirty: true })
        } else {
          existingBySku.set(sku, ir)
        }
      }
      return Array.from(existingBySku.values())
    })
  }, [productType, marketplace])

  // ── TSV Export ─────────────────────────────────────────────────────

  const handleExport = useCallback(async () => {
    if (!manifest) return
    const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/export-tsv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest, rows }),
    })
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `amazon_flat_file_${productType}_${marketplace}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }, [manifest, rows, productType, marketplace])

  // ── Render ─────────────────────────────────────────────────────────

  const dirtyRows = rows.filter((r) => r._dirty || r._isNew)

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">

      {/* ── Sticky header ─────────────────────────────────────── */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30">

        {/* Top bar */}
        <div className="px-6 h-14 flex items-center gap-3">
          <IconButton
            aria-label="Back to products"
            size="sm"
            onClick={() => router.push('/products')}
            className="!h-auto !w-auto p-1 -m-1"
          >
            <ChevronLeft className="w-4 h-4" />
          </IconButton>

          <FileSpreadsheet className="w-5 h-5 text-orange-500 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Amazon Flat File Editor
              </h1>
              {manifest && (
                <>
                  <Badge variant="info">{manifest.productType}</Badge>
                  <Badge variant="default">{manifest.marketplace}</Badge>
                </>
              )}
              {dirtyRows.length > 0 && (
                <Badge variant="warning">
                  <AlertCircle className="w-3 h-3 mr-1" />
                  {dirtyRows.length} unsaved
                </Badge>
              )}
              {newCount > 0 && (
                <Badge variant="info">{newCount} new</Badge>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Feed status pill */}
            {feedId && (
              <div className="flex items-center gap-1.5">
                <span className={cn(
                  'text-xs font-medium px-2 py-1 rounded-full',
                  feedStatus === 'DONE' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400'
                  : feedStatus === 'FATAL' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
                  : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400'
                )}>
                  Feed: {feedStatus ?? '…'}
                </span>
                {feedStatus !== 'DONE' && feedStatus !== 'FATAL' && (
                  <Button size="sm" variant="ghost" onClick={pollFeedStatus} loading={polling}>
                    <RefreshCw className="w-3 h-3 mr-1" />
                    Check
                  </Button>
                )}
              </div>
            )}

            {/* Import TSV */}
            <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()}>
              <Upload className="w-3.5 h-3.5 mr-1.5" />
              Import TSV
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".txt,.tsv,.csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleFileImport(file)
                e.target.value = ''
              }}
            />

            {/* Export TSV */}
            <Button size="sm" variant="ghost" onClick={handleExport} disabled={rows.length === 0}>
              <Download className="w-3.5 h-3.5 mr-1.5" />
              Export TSV
            </Button>

            {/* Submit */}
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={dirtyRows.length === 0 || submitting || loading}
              loading={submitting}
            >
              <Send className="w-3.5 h-3.5 mr-1.5" />
              Submit to Amazon
              {dirtyRows.length > 0 && ` (${dirtyRows.length})`}
            </Button>
          </div>
        </div>

        {/* Toolbar: marketplace + product type selector + group toggles */}
        <div className="px-6 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center gap-4 flex-wrap">
          {/* Marketplace selector */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Marketplace</span>
            <div className="flex items-center gap-1">
              {MARKETPLACES.map((mp) => (
                <button
                  key={mp}
                  type="button"
                  onClick={() => {
                    setMarketplace(mp)
                    void loadData(mp, productType)
                  }}
                  className={cn(
                    'text-xs font-medium px-2 py-1 rounded border transition-colors',
                    marketplace === mp
                      ? 'bg-slate-800 text-white border-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-400 dark:hover:border-slate-500',
                  )}
                >
                  {mp}
                </button>
              ))}
            </div>
          </div>

          {/* Product type input */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Product Type</span>
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={productTypeInput}
                onChange={(e) => setProductTypeInput(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setProductType(productTypeInput)
                    void loadData(marketplace, productTypeInput)
                  }
                }}
                placeholder="e.g. OUTERWEAR"
                className="text-xs font-mono px-2 py-1 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 w-32 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setProductType(productTypeInput)
                  void loadData(marketplace, productTypeInput, true)
                }}
                loading={loading}
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                Load
              </Button>
            </div>
          </div>

          {/* Group visibility toggles */}
          {manifest && (
            <div className="flex items-center gap-1 flex-wrap ml-auto">
              <span className="text-xs text-slate-400 dark:text-slate-500 mr-1">Groups:</span>
              {manifest.groups.map((g) => {
                const colors = groupColor(g.color)
                const open = openGroups.has(g.id)
                return (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => {
                      setOpenGroups((prev) => {
                        const next = new Set(prev)
                        if (next.has(g.id)) next.delete(g.id)
                        else next.add(g.id)
                        return next
                      })
                    }}
                    className={cn(
                      'inline-flex items-center gap-1 h-6 px-2 text-xs border rounded transition-colors',
                      colors.band,
                      colors.text,
                      open ? 'opacity-100 border-current/30' : 'opacity-50 border-slate-200 dark:border-slate-700 hover:opacity-75',
                    )}
                  >
                    <ChevronRight className={cn('w-3 h-3 transition-transform', open && 'rotate-90')} />
                    {g.label}
                    <span className="opacity-60 tabular-nums">{g.columns.length}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Error banner */}
        {loadError && (
          <div className="px-6 py-2 bg-red-50 dark:bg-red-950/30 border-t border-red-200 dark:border-red-900 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-red-700 dark:text-red-400">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {loadError}
            </div>
            <button onClick={() => setLoadError(null)} className="text-red-400 hover:text-red-600">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </header>

      {/* ── Spreadsheet area ──────────────────────────────────── */}
      {!manifest && !loading && (
        <div className="flex-1 flex items-center justify-center text-slate-400 dark:text-slate-600">
          <div className="text-center">
            <FileSpreadsheet className="w-12 h-12 mx-auto mb-3 opacity-40" />
            <p className="text-sm">Select a marketplace and product type, then click Load.</p>
          </div>
        </div>
      )}

      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          <span className="ml-2 text-sm text-slate-500">Loading schema…</span>
        </div>
      )}

      {manifest && !loading && (
        <div className="flex-1 overflow-auto">
          <table className="border-collapse text-sm w-max min-w-full">
            <thead className="sticky top-0 z-20 bg-white dark:bg-slate-900">
              {/* Row 1: Group headers */}
              <tr>
                {/* Status + checkbox col */}
                <th className="sticky left-0 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 w-10 min-w-[40px]" />
                {/* Row number col */}
                <th className="sticky left-10 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 w-8 min-w-[32px]" />

                {manifest.groups
                  .filter((g) => openGroups.has(g.id))
                  .map((g) => {
                    const colors = groupColor(g.color)
                    return (
                      <th
                        key={g.id}
                        colSpan={g.columns.length}
                        className={cn(
                          'px-3 py-1 text-xs font-semibold border-b border-r border-slate-200 dark:border-slate-700 text-left whitespace-nowrap',
                          colors.header,
                        )}
                      >
                        {g.label}
                      </th>
                    )
                  })}
              </tr>

              {/* Row 2: Column names */}
              <tr>
                <th className="sticky left-0 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 px-2">
                  <input
                    type="checkbox"
                    checked={selectedRows.size === rows.length && rows.length > 0}
                    onChange={(e) =>
                      setSelectedRows(
                        e.target.checked
                          ? new Set(rows.map((r) => r._rowId as string))
                          : new Set(),
                      )
                    }
                    className="w-3.5 h-3.5 accent-blue-600"
                  />
                </th>
                <th className="sticky left-10 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 w-8 text-xs text-slate-400 text-center">#</th>

                {allColumns.map((col) => {
                  const gColor = colGroupForId.get(col.id) ?? 'slate'
                  const colors = groupColor(gColor)
                  return (
                    <th
                      key={col.id}
                      title={col.description}
                      style={{ minWidth: col.width, width: col.width }}
                      className={cn(
                        'px-2 py-1 text-left text-xs font-medium border-b border-r border-slate-200 dark:border-slate-700 whitespace-nowrap',
                        colors.text,
                        col.required && 'font-semibold',
                      )}
                    >
                      {col.label}
                      {col.required && <span className="ml-0.5 text-red-500">*</span>}
                    </th>
                  )
                })}
              </tr>
            </thead>

            <tbody>
              {rows.map((row, rowIdx) => (
                <SpreadsheetRow
                  key={row._rowId as string}
                  row={row}
                  rowIdx={rowIdx}
                  columns={allColumns}
                  colGroupForId={colGroupForId}
                  selected={selectedRows.has(row._rowId as string)}
                  activeCell={activeCell}
                  onSelect={(checked) => {
                    setSelectedRows((prev) => {
                      const next = new Set(prev)
                      if (checked) next.add(row._rowId as string)
                      else next.delete(row._rowId as string)
                      return next
                    })
                  }}
                  onCellActivate={(colId) =>
                    setActiveCell({ rowId: row._rowId as string, colId })
                  }
                  onCellDeactivate={() => setActiveCell(null)}
                  onCellChange={(colId, value) => updateCell(row._rowId as string, colId, value)}
                  onNavigate={(colId, dir) => navigateCell(row._rowId as string, colId, dir)}
                />
              ))}

              {/* Add-row buttons */}
              <tr>
                <td colSpan={allColumns.length + 2} className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={() => addRow()}>
                      <Plus className="w-3.5 h-3.5 mr-1" />
                      Add standalone
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => addRow(true)}>
                      <Plus className="w-3.5 h-3.5 mr-1" />
                      Add parent
                    </Button>
                    <Button size="sm" variant="ghost" onClick={addChildRow}>
                      <Plus className="w-3.5 h-3.5 mr-1" />
                      Add variant (child)
                    </Button>
                    {selectedRows.size > 0 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={deleteSelectedRows}
                        className="text-red-500 hover:text-red-700 ml-2"
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1" />
                        Delete {selectedRows.size} selected
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ── Feed results panel ─────────────────────────────────── */}
      {feedResults.length > 0 && (
        <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-6 py-3">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Processing report — {feedResults.filter((r) => r.status === 'success').length} success,{' '}
              {feedResults.filter((r) => r.status === 'error').length} errors
            </span>
          </div>
          <div className="max-h-32 overflow-y-auto text-xs space-y-1">
            {feedResults
              .filter((r) => r.status === 'error')
              .map((r) => (
                <div key={r.sku} className="flex items-start gap-2 text-red-600 dark:text-red-400">
                  <X className="w-3 h-3 mt-0.5 flex-shrink-0" />
                  <span className="font-mono font-medium">{r.sku}</span>
                  <span>{r.message}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── SpreadsheetRow ─────────────────────────────────────────────────────

interface RowProps {
  row: Row
  rowIdx: number
  columns: Column[]
  colGroupForId: Map<string, string>
  selected: boolean
  activeCell: { rowId: string; colId: string } | null
  onSelect: (checked: boolean) => void
  onCellActivate: (colId: string) => void
  onCellDeactivate: () => void
  onCellChange: (colId: string, value: unknown) => void
  onNavigate: (colId: string, dir: 'right' | 'left' | 'down' | 'up') => void
}

function SpreadsheetRow({
  row, rowIdx, columns, colGroupForId, selected, activeCell,
  onSelect, onCellActivate, onCellDeactivate, onCellChange, onNavigate,
}: RowProps) {
  const rowId = row._rowId as string
  const status = row._status

  const rowBg =
    status === 'success' ? 'bg-emerald-50/60 dark:bg-emerald-950/20'
    : status === 'error' ? 'bg-red-50/60 dark:bg-red-950/20'
    : status === 'pending' ? 'bg-amber-50/60 dark:bg-amber-950/20'
    : row._isNew ? 'bg-blue-50/40 dark:bg-blue-950/10'
    : row._dirty ? 'bg-yellow-50/40 dark:bg-yellow-950/10'
    : ''

  return (
    <tr className={cn('group hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors', rowBg)}>
      {/* Status + checkbox */}
      <td className="sticky left-0 z-10 bg-inherit border-b border-r border-slate-200 dark:border-slate-700 px-2 w-10 text-center">
        <div className="flex items-center gap-1">
          {status === 'success' && <CheckCircle2 className="w-3 h-3 text-emerald-500 flex-shrink-0" />}
          {status === 'error' && (
            <span title={row._feedMessage as string | undefined}>
              <AlertCircle className="w-3 h-3 text-red-500 flex-shrink-0" />
            </span>
          )}
          {status === 'pending' && <Loader2 className="w-3 h-3 text-amber-500 animate-spin flex-shrink-0" />}
          {(!status || status === 'idle') && (
            <input
              type="checkbox"
              checked={selected}
              onChange={(e) => onSelect(e.target.checked)}
              className="w-3.5 h-3.5 accent-blue-600"
            />
          )}
        </div>
      </td>

      {/* Row number */}
      <td className="sticky left-10 z-10 bg-inherit border-b border-r border-slate-200 dark:border-slate-700 px-1 text-xs text-slate-400 tabular-nums text-right w-8">
        {rowIdx + 1}
      </td>

      {/* Data cells */}
      {columns.map((col) => {
        const isActive = activeCell?.rowId === rowId && activeCell?.colId === col.id
        const gColor = colGroupForId.get(col.id) ?? 'slate'
        const colors = groupColor(gColor)
        const value = row[col.id]

        return (
          <SpreadsheetCell
            key={col.id}
            col={col}
            value={value}
            isActive={isActive}
            cellBg={colors.cell}
            onActivate={() => onCellActivate(col.id)}
            onDeactivate={onCellDeactivate}
            onChange={(v) => onCellChange(col.id, v)}
            onNavigate={(dir) => onNavigate(col.id, dir)}
          />
        )
      })}
    </tr>
  )
}

// ── SpreadsheetCell ────────────────────────────────────────────────────

interface CellProps {
  col: Column
  value: unknown
  isActive: boolean
  cellBg: string
  onActivate: () => void
  onDeactivate: () => void
  onChange: (value: unknown) => void
  onNavigate: (dir: 'right' | 'left' | 'down' | 'up') => void
}

function SpreadsheetCell({ col, value, isActive, cellBg, onActivate, onDeactivate, onChange, onNavigate }: CellProps) {
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null>(null)
  const displayValue = value != null ? String(value) : ''

  useEffect(() => {
    if (isActive && inputRef.current) {
      inputRef.current.focus()
      if ('select' in inputRef.current && col.kind !== 'enum') {
        (inputRef.current as HTMLInputElement).select()
      }
    }
  }, [isActive, col.kind])

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Tab') {
      e.preventDefault()
      onNavigate(e.shiftKey ? 'left' : 'right')
    } else if (e.key === 'Enter' && col.kind !== 'longtext') {
      e.preventDefault()
      onNavigate(e.shiftKey ? 'up' : 'down')
    } else if (e.key === 'Escape') {
      onDeactivate()
    }
  }

  const baseCellCls = cn(
    'border-b border-r border-slate-200 dark:border-slate-700 p-0',
    'transition-colors relative',
    cellBg,
    isActive && 'ring-2 ring-inset ring-blue-500 z-[5]',
  )

  if (isActive) {
    if (col.kind === 'enum' && col.options) {
      return (
        <td className={baseCellCls} style={{ minWidth: col.width, width: col.width }}>
          <select
            ref={inputRef as any}
            value={displayValue}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onDeactivate}
            onKeyDown={handleKeyDown}
            className="w-full h-full min-h-[28px] px-1.5 text-xs bg-transparent focus:outline-none text-slate-800 dark:text-slate-200"
          >
            {(col.options ?? []).map((opt) => (
              <option key={opt} value={opt}>{opt || '—'}</option>
            ))}
          </select>
        </td>
      )
    }
    if (col.kind === 'longtext') {
      return (
        <td className={baseCellCls} style={{ minWidth: col.width, width: col.width }}>
          <textarea
            ref={inputRef as any}
            defaultValue={displayValue}
            onBlur={(e) => { onChange(e.target.value); onDeactivate() }}
            onKeyDown={handleKeyDown}
            rows={3}
            className="w-full px-1.5 py-1 text-xs bg-white dark:bg-slate-800 focus:outline-none text-slate-800 dark:text-slate-200 resize-none"
            style={{ minWidth: col.width }}
          />
        </td>
      )
    }
    return (
      <td className={baseCellCls} style={{ minWidth: col.width, width: col.width }}>
        <input
          ref={inputRef as any}
          type={col.kind === 'number' ? 'number' : 'text'}
          defaultValue={displayValue}
          maxLength={col.maxLength}
          onBlur={(e) => { onChange(e.target.value); onDeactivate() }}
          onKeyDown={handleKeyDown}
          className="w-full h-[28px] px-1.5 text-xs bg-white dark:bg-slate-800 focus:outline-none text-slate-800 dark:text-slate-200"
        />
      </td>
    )
  }

  // Inactive cell — click to activate
  const isEmpty = !displayValue
  return (
    <td
      className={cn(baseCellCls, 'cursor-pointer hover:bg-white/70 dark:hover:bg-slate-700/40')}
      style={{ minWidth: col.width, width: col.width }}
      onClick={onActivate}
      title={col.description}
    >
      <div className={cn(
        'h-[28px] px-1.5 flex items-center text-xs truncate',
        isEmpty ? 'text-slate-300 dark:text-slate-600' : 'text-slate-800 dark:text-slate-200',
        col.required && isEmpty && 'bg-red-50/60 dark:bg-red-950/20',
      )}>
        {displayValue || (col.required ? '⚠ required' : '')}
      </div>
    </td>
  )
}

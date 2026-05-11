'use client'

import {
  useCallback, useEffect, useRef, useState, useMemo,
  type KeyboardEvent,
} from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  Copy, Download, FileSpreadsheet, Loader2, Plus, RefreshCw,
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
  fieldRef: string
  labelEn: string
  labelLocal: string
  description?: string
  required: boolean
  kind: ColumnKind
  options?: string[]
  maxLength?: number
  width: number
}

interface ColumnGroup {
  id: string
  labelEn: string
  labelLocal: string
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

const GROUP_COLORS: Record<string, {
  band: string; header: string; text: string; cell: string; badge: string
}> = {
  blue:    { band: 'bg-blue-50 dark:bg-blue-950/30', header: 'bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200', text: 'text-blue-700 dark:text-blue-300', cell: 'bg-blue-50/50 dark:bg-blue-950/10', badge: 'bg-blue-100 text-blue-700 border border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800' },
  purple:  { band: 'bg-purple-50 dark:bg-purple-950/30', header: 'bg-purple-100 dark:bg-purple-900/50 text-purple-800 dark:text-purple-200', text: 'text-purple-700 dark:text-purple-300', cell: 'bg-purple-50/50 dark:bg-purple-950/10', badge: 'bg-purple-100 text-purple-700 border border-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-800' },
  emerald: { band: 'bg-emerald-50 dark:bg-emerald-950/30', header: 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200', text: 'text-emerald-700 dark:text-emerald-300', cell: 'bg-emerald-50/50 dark:bg-emerald-950/10', badge: 'bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800' },
  orange:  { band: 'bg-orange-50 dark:bg-orange-950/30', header: 'bg-orange-100 dark:bg-orange-900/50 text-orange-800 dark:text-orange-200', text: 'text-orange-700 dark:text-orange-300', cell: 'bg-orange-50/50 dark:bg-orange-950/10', badge: 'bg-orange-100 text-orange-700 border border-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-800' },
  teal:    { band: 'bg-teal-50 dark:bg-teal-950/30', header: 'bg-teal-100 dark:bg-teal-900/50 text-teal-800 dark:text-teal-200', text: 'text-teal-700 dark:text-teal-300', cell: 'bg-teal-50/50 dark:bg-teal-950/10', badge: 'bg-teal-100 text-teal-700 border border-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:border-teal-800' },
  amber:   { band: 'bg-amber-50 dark:bg-amber-950/30', header: 'bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200', text: 'text-amber-700 dark:text-amber-300', cell: 'bg-amber-50/50 dark:bg-amber-950/10', badge: 'bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800' },
  yellow:  { band: 'bg-yellow-50 dark:bg-yellow-950/30', header: 'bg-yellow-100 dark:bg-yellow-900/50 text-yellow-800 dark:text-yellow-200', text: 'text-yellow-700 dark:text-yellow-300', cell: 'bg-yellow-50/50 dark:bg-yellow-950/10', badge: 'bg-yellow-100 text-yellow-700 border border-yellow-200 dark:bg-yellow-900/40 dark:text-yellow-300 dark:border-yellow-800' },
  sky:     { band: 'bg-sky-50 dark:bg-sky-950/30', header: 'bg-sky-100 dark:bg-sky-900/50 text-sky-800 dark:text-sky-200', text: 'text-sky-700 dark:text-sky-300', cell: 'bg-sky-50/50 dark:bg-sky-950/10', badge: 'bg-sky-100 text-sky-700 border border-sky-200 dark:bg-sky-900/40 dark:text-sky-300 dark:border-sky-800' },
  red:     { band: 'bg-red-50 dark:bg-red-950/30', header: 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-200', text: 'text-red-700 dark:text-red-300', cell: 'bg-red-50/50 dark:bg-red-950/10', badge: 'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800' },
  violet:  { band: 'bg-violet-50 dark:bg-violet-950/30', header: 'bg-violet-100 dark:bg-violet-900/50 text-violet-800 dark:text-violet-200', text: 'text-violet-700 dark:text-violet-300', cell: 'bg-violet-50/50 dark:bg-violet-950/10', badge: 'bg-violet-100 text-violet-700 border border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800' },
  slate:   { band: 'bg-slate-50 dark:bg-slate-900/30', header: 'bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300', text: 'text-slate-600 dark:text-slate-400', cell: '', badge: 'bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-700' },
}

function gColor(color: string) {
  return GROUP_COLORS[color] ?? GROUP_COLORS.slate
}

function makeEmptyRow(productType: string, _marketplace: string, parentage = ''): Row {
  return {
    _rowId: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    _isNew: true, _dirty: true, _status: 'idle',
    item_sku: '',
    product_type: productType,
    record_action: 'full_update',
    parentage_level: parentage,
    parent_sku: '',
    variation_theme: '',
  }
}

// ── Props ──────────────────────────────────────────────────────────────

interface Props {
  initialManifest: Manifest | null
  initialRows: Row[]
  initialMarketplace: string
  initialProductType: string
  productId?: string
}

// ── Component ──────────────────────────────────────────────────────────

export default function AmazonFlatFileClient({
  initialManifest,
  initialRows,
  initialMarketplace,
  initialProductType,
  productId,
}: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [marketplace, setMarketplace] = useState(initialMarketplace)
  const [productType, setProductType] = useState(initialProductType)

  // Known product types for the current marketplace (from DB cache + catalog)
  const [productTypes, setProductTypes] = useState<Array<{ value: string; source: string }>>([])
  const [ptLoading, setPtLoading] = useState(false)

  const [manifest, setManifest] = useState<Manifest | null>(initialManifest)
  const [rows, setRows] = useState<Row[]>(initialRows)

  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  // Groups that are open (visible)
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(['offer_identity', 'variations', 'schema_fields', 'required_fields', 'images'])
  )

  // User-defined group order — persisted in localStorage
  const [groupOrder, setGroupOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('ff-group-order') ?? '[]') } catch { return [] }
  })
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null)

  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [activeCell, setActiveCell] = useState<{ rowId: string; colId: string } | null>(null)

  const [feedId, setFeedId] = useState<string | null>(null)
  const [feedStatus, setFeedStatus] = useState<string | null>(null)
  const [feedResults, setFeedResults] = useState<FeedResult[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [polling, setPolling] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [copyPanelOpen, setCopyPanelOpen] = useState(false)
  const [copying, setCopying] = useState(false)

  // ── Fetch known product types whenever marketplace changes ─────────
  useEffect(() => {
    let cancelled = false
    async function fetchTypes() {
      setPtLoading(true)
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/amazon/flat-file/product-types?marketplace=${marketplace}`
        )
        if (!cancelled && res.ok) {
          const data = await res.json()
          setProductTypes(data.types ?? [])
        }
      } catch { /* non-fatal */ }
      finally { if (!cancelled) setPtLoading(false) }
    }
    void fetchTypes()
    return () => { cancelled = true }
  }, [marketplace])

  // ── Derived ────────────────────────────────────────────────────────

  // Respect saved drag order; fall back to Amazon's order for new groups
  const orderedGroups = useMemo<ColumnGroup[]>(() => {
    const groups = manifest?.groups ?? []
    if (!groupOrder.length) return groups
    const byId = new Map(groups.map((g) => [g.id, g]))
    const ordered = groupOrder.map((id) => byId.get(id)).filter(Boolean) as ColumnGroup[]
    const rest = groups.filter((g) => !groupOrder.includes(g.id))
    return [...ordered, ...rest]
  }, [manifest, groupOrder])

  const visibleGroups = useMemo(
    () => orderedGroups.filter((g) => openGroups.has(g.id)),
    [orderedGroups, openGroups],
  )

  const allColumns = useMemo<Column[]>(
    () => visibleGroups.flatMap((g) => g.columns),
    [visibleGroups],
  )

  const colToGroup = useMemo<Map<string, ColumnGroup>>(() => {
    const m = new Map<string, ColumnGroup>()
    for (const g of manifest?.groups ?? []) {
      for (const c of g.columns) m.set(c.id, g)
    }
    return m
  }, [manifest])

  const dirtyRows = useMemo(() => rows.filter((r) => r._dirty || r._isNew), [rows])
  const newCount  = useMemo(() => rows.filter((r) => r._isNew).length, [rows])

  // ── Load data ──────────────────────────────────────────────────────

  const loadData = useCallback(async (mp: string, pt: string, force = false) => {
    if (!pt.trim()) return
    setLoading(true)
    setLoadError(null)
    setFeedId(null)
    setFeedResults([])
    const backend = getBackendUrl()
    const qs = new URLSearchParams({ marketplace: mp, productType: pt, ...(force ? { force: '1' } : {}) })
    const rowsQs = new URLSearchParams({ marketplace: mp, productType: pt })
    if (productId) rowsQs.set('productId', productId)
    try {
      const [mRes, rRes] = await Promise.all([
        fetch(`${backend}/api/amazon/flat-file/template?${qs}`),
        fetch(`${backend}/api/amazon/flat-file/rows?${rowsQs}`),
      ])
      if (!mRes.ok) { const e = await mRes.json().catch(() => ({})); throw new Error(e.error ?? `HTTP ${mRes.status}`) }
      const m: Manifest = await mRes.json()
      setManifest(m)
      // Open all groups by default when manifest loads
      setOpenGroups(new Set(m.groups.map((g) => g.id)))
      if (rRes.ok) { const d = await rRes.json(); setRows(d.rows ?? []) }
      else setRows([])
      const p = new URLSearchParams(searchParams?.toString() ?? '')
      p.set('marketplace', mp); p.set('productType', pt)
      router.replace(`?${p.toString()}`, { scroll: false })
    } catch (e: any) {
      setLoadError(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [router, searchParams])

  // ── Row operations ─────────────────────────────────────────────────

  const addRow = useCallback((parentage = '') => {
    const row = makeEmptyRow(productType, marketplace, parentage)
    setRows((prev) => [...prev, row])
    setTimeout(() => setActiveCell({ rowId: row._rowId as string, colId: 'item_sku' }), 30)
  }, [productType, marketplace])

  const deleteSelected = useCallback(() => {
    setRows((prev) => prev.filter((r) => !selectedRows.has(r._rowId as string)))
    setSelectedRows(new Set())
  }, [selectedRows])

  const updateCell = useCallback((rowId: string, colId: string, value: unknown) => {
    setRows((prev) => prev.map((r) => r._rowId === rowId ? { ...r, [colId]: value, _dirty: true } : r))
  }, [])

  const navigate = useCallback((rowId: string, colId: string, dir: 'right' | 'left' | 'down' | 'up') => {
    const colIds = allColumns.map((c) => c.id)
    const rowIds = rows.map((r) => r._rowId as string)
    let ci = colIds.indexOf(colId), ri = rowIds.indexOf(rowId)
    if (dir === 'right') ci = Math.min(ci + 1, colIds.length - 1)
    else if (dir === 'left') ci = Math.max(ci - 1, 0)
    else if (dir === 'down') ri = Math.min(ri + 1, rowIds.length - 1)
    else ri = Math.max(ri - 1, 0)
    const nc = colIds[ci], nr = rowIds[ri]
    if (nc && nr) setActiveCell({ rowId: nr, colId: nc })
  }, [allColumns, rows])

  // ── Submit ─────────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    const toSend = rows.filter((r) => r._dirty || r._isNew)
    if (!toSend.length) return
    setSubmitting(true)
    setFeedId(null); setFeedResults([]); setFeedStatus(null)
    setRows((prev) => prev.map((r) => r._dirty || r._isNew ? { ...r, _status: 'pending' } : r))
    try {
      const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: toSend, marketplace }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Submit failed')
      setFeedId(data.feedId)
      setFeedStatus('IN_QUEUE')
      setRows((prev) => prev.map((r) => r._dirty || r._isNew ? { ...r, _dirty: false, _isNew: false, _status: 'pending' } : r))
    } catch (e: any) {
      setRows((prev) => prev.map((r) => r._status === 'pending' ? { ...r, _status: 'idle', _dirty: true } : r))
      setLoadError(e.message ?? 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }, [rows, marketplace])

  const pollStatus = useCallback(async () => {
    if (!feedId) return
    setPolling(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/feeds/${feedId}`)
      const data = await res.json()
      setFeedStatus(data.processingStatus)
      if (data.processingStatus === 'DONE') {
        setFeedResults(data.results ?? [])
        const bySkU = new Map<string, FeedResult>((data.results as FeedResult[]).map((r) => [r.sku, r]))
        setRows((prev) => prev.map((r) => {
          const res = bySkU.get(r.item_sku as string)
          return res ? { ...r, _status: res.status as any, _feedMessage: res.message } : r
        }))
      }
    } catch (e: any) { setLoadError(e.message) }
    finally { setPolling(false) }
  }, [feedId])

  // ── Import / Export ────────────────────────────────────────────────

  const importFile = useCallback(async (file: File) => {
    const content = await file.text()
    const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/parse-tsv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, productType, marketplace }),
    })
    if (!res.ok) { const e = await res.json().catch(() => ({})); setLoadError(e.error ?? 'Import failed'); return }
    const data = await res.json()
    const imported: Row[] = (data.rows ?? []).map((r: any) => ({ ...r, _dirty: true, _isNew: !r._productId }))
    setRows((prev) => {
      const bySku = new Map(prev.map((r) => [String(r.item_sku), r]))
      for (const ir of imported) {
        const sku = String(ir.item_sku)
        bySku.set(sku, bySku.has(sku) ? { ...bySku.get(sku)!, ...ir, _dirty: true } : ir)
      }
      return Array.from(bySku.values())
    })
  }, [productType, marketplace])

  // ── Copy to market ─────────────────────────────────────────────────
  const handleCopyToMarket = useCallback(async (
    targetMarket: string,
    colIds: Set<string>,
  ) => {
    if (!manifest || !rows.length) return
    setCopying(true)
    setCopyPanelOpen(false)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/amazon/flat-file/template?marketplace=${targetMarket}&productType=${productType}`,
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const targetManifest: Manifest = await res.json()

      const STRUCTURAL = new Set([
        'item_sku', 'product_type', 'record_action',
        'parentage_level', 'parent_sku', 'variation_theme',
      ])
      const copiedRows = rows.map((row) => {
        const newRow: Row = {
          _rowId: `copy-${row._rowId}-${Date.now()}`,
          _isNew: true, _dirty: true, _status: 'idle',
        }
        for (const key of STRUCTURAL) {
          if (row[key] != null) newRow[key] = row[key]
        }
        for (const colId of colIds) {
          if (row[colId] != null) newRow[colId] = row[colId]
        }
        return newRow
      })

      setMarketplace(targetMarket)
      setManifest(targetManifest)
      setOpenGroups(new Set(targetManifest.groups.map((g) => g.id)))
      setRows(copiedRows)
      setFeedId(null)
      setFeedResults([])
    } catch (e: any) {
      setLoadError(e.message ?? 'Copy failed')
    } finally {
      setCopying(false)
    }
  }, [manifest, rows, productType])

  const exportTsv = useCallback(async () => {
    if (!manifest) return
    const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/export-tsv`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ manifest, rows }),
    })
    if (!res.ok) return
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `amazon_${productType}_${marketplace}.txt`; a.click()
    URL.revokeObjectURL(url)
  }, [manifest, rows, productType, marketplace])

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">

      {/* ── Sticky header ────────────────────────────────────── */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30">

        {/* Top bar */}
        <div className="px-4 h-13 flex items-center gap-3 py-2">
          <IconButton aria-label="Back" size="sm" onClick={() => router.push('/products')} className="!h-auto !w-auto p-1 -m-1">
            <ChevronLeft className="w-4 h-4" />
          </IconButton>
          <FileSpreadsheet className="w-5 h-5 text-orange-500 flex-shrink-0" />
          <div className="min-w-0 flex-1 flex items-center gap-2 flex-wrap">
            <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">Amazon Flat File Editor</h1>
            {manifest && <><Badge variant="info">{manifest.productType}</Badge><Badge variant="default">{manifest.marketplace}</Badge></>}
            {productId && (
              <span className="inline-flex items-center gap-1 text-xs bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 border border-orange-200 dark:border-orange-800 rounded px-2 py-0.5">
                <FileSpreadsheet className="w-3 h-3" />
                Filtered to {rows.length} row{rows.length !== 1 ? 's' : ''}
                <button
                  onClick={() => router.push(`/products/amazon-flat-file?marketplace=${marketplace}&productType=${productType}`)}
                  className="ml-1 opacity-60 hover:opacity-100"
                  title="Show all products"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            )}
            {dirtyRows.length > 0 && <Badge variant="warning"><AlertCircle className="w-3 h-3 mr-1" />{dirtyRows.length} unsaved</Badge>}
            {newCount > 0 && <Badge variant="info">{newCount} new rows</Badge>}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {feedId && (
              <div className="flex items-center gap-1.5">
                <span className={cn('text-xs font-medium px-2 py-1 rounded-full',
                  feedStatus === 'DONE' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                  : feedStatus === 'FATAL' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700')}>
                  Feed: {feedStatus ?? '…'}
                </span>
                {feedStatus !== 'DONE' && feedStatus !== 'FATAL' && (
                  <Button size="sm" variant="ghost" onClick={pollStatus} loading={polling}><RefreshCw className="w-3 h-3 mr-1" />Check</Button>
                )}
              </div>
            )}
            {manifest && rows.length > 0 && (
              <div className="relative">
                <Button size="sm" variant="ghost"
                  onClick={() => setCopyPanelOpen((o) => !o)}
                  loading={copying}
                  className={copyPanelOpen ? 'bg-slate-100 dark:bg-slate-800' : ''}>
                  <Copy className="w-3.5 h-3.5 mr-1.5" />Copy to market
                </Button>
                {copyPanelOpen && (
                  <CopyToMarketPanel
                    manifest={manifest}
                    rows={rows}
                    currentMarket={marketplace}
                    onCopy={handleCopyToMarket}
                    onClose={() => setCopyPanelOpen(false)}
                  />
                )}
              </div>
            )}
            <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()}>
              <Upload className="w-3.5 h-3.5 mr-1.5" />Import TSV
            </Button>
            <input ref={fileInputRef} type="file" accept=".txt,.tsv,.csv,.xlsm,.xlsx" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = '' }} />
            <Button size="sm" variant="ghost" onClick={exportTsv} disabled={!rows.length}>
              <Download className="w-3.5 h-3.5 mr-1.5" />Export TSV
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={!dirtyRows.length || submitting || loading} loading={submitting}>
              <Send className="w-3.5 h-3.5 mr-1.5" />Submit to Amazon{dirtyRows.length > 0 && ` (${dirtyRows.length})`}
            </Button>
          </div>
        </div>

        {/* Toolbar: marketplace + product type + group toggles */}
        <div className="px-4 py-1.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 font-medium">Marketplace</span>
            <div className="flex gap-0.5">
              {MARKETPLACES.map((mp) => (
                <button key={mp} type="button"
                  onClick={() => { setMarketplace(mp); void loadData(mp, productType) /* product types fetched via useEffect */ }}
                  className={cn('text-xs font-medium px-2 py-0.5 rounded border transition-colors',
                    marketplace === mp
                      ? 'bg-slate-800 text-white border-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-400')}>
                  {mp}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 font-medium">Product Type</span>
            <ProductTypeDropdown
              value={productType}
              options={productTypes}
              loading={ptLoading || loading}
              onChange={(pt) => {
                setProductType(pt)
                void loadData(marketplace, pt)
              }}
            />
            {/* Reload/refresh — re-fetches schema from Amazon SP-API (bypasses cache) */}
            {productType && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void loadData(marketplace, productType, true)}
                loading={loading}
                title="Force-refresh schema from Amazon (bypasses 24h cache)"
              >
                <RefreshCw className="w-3 h-3 mr-1" />
                Refresh schema
              </Button>
            )}
          </div>

          {/* Group toggles — draggable to reorder */}
          {manifest && (
            <div className="flex items-center gap-1 flex-wrap ml-auto">
              <span className="text-xs text-slate-400 mr-1">Columns:</span>
              {orderedGroups.map((g) => {
                const c = gColor(g.color)
                const open = openGroups.has(g.id)
                const isDragging = draggingGroupId === g.id
                return (
                  <button key={g.id} type="button"
                    draggable
                    onDragStart={(e) => { setDraggingGroupId(g.id); e.dataTransfer.effectAllowed = 'move' }}
                    onDragEnd={() => setDraggingGroupId(null)}
                    onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                    onDrop={(e) => {
                      e.preventDefault()
                      if (!draggingGroupId || draggingGroupId === g.id) return
                      const ids = orderedGroups.map((x) => x.id)
                      const from = ids.indexOf(draggingGroupId)
                      const to = ids.indexOf(g.id)
                      const next = [...ids]
                      next.splice(from, 1)
                      next.splice(to, 0, draggingGroupId)
                      setGroupOrder(next)
                      try { localStorage.setItem('ff-group-order', JSON.stringify(next)) } catch {}
                      setDraggingGroupId(null)
                    }}
                    onClick={() => setOpenGroups((prev) => { const n = new Set(prev); open ? n.delete(g.id) : n.add(g.id); return n })}
                    title={g.labelEn !== g.labelLocal ? `${g.labelLocal} — ${g.labelEn}` : g.labelEn}
                    className={cn('inline-flex items-center gap-1 h-5 px-1.5 text-xs rounded border transition-all cursor-grab active:cursor-grabbing select-none',
                      c.badge, open ? 'opacity-100' : 'opacity-40 hover:opacity-65',
                      isDragging && 'opacity-30 scale-95')}>
                    <ChevronRight className={cn('w-2.5 h-2.5 transition-transform', open && 'rotate-90')} />
                    <span className="font-medium">{g.labelLocal}</span>
                    {g.labelEn !== g.labelLocal && (
                      <span className="opacity-50 font-normal">({g.labelEn})</span>
                    )}
                    <span className="opacity-60 tabular-nums">{g.columns.length}</span>
                  </button>
                )
              })}
              {groupOrder.length > 0 && (
                <button type="button"
                  onClick={() => { setGroupOrder([]); try { localStorage.removeItem('ff-group-order') } catch {} }}
                  className="text-xs text-slate-400 hover:text-slate-600 px-1"
                  title="Reset group order to Amazon's default">
                  ↺
                </button>
              )}
            </div>
          )}
        </div>

        {/* Error */}
        {loadError && (
          <div className="px-4 py-1.5 bg-red-50 dark:bg-red-950/30 border-t border-red-200 dark:border-red-900 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-red-700 dark:text-red-400">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />{loadError}
            </div>
            <button onClick={() => setLoadError(null)}><X className="w-4 h-4 text-red-400 hover:text-red-600" /></button>
          </div>
        )}
      </header>

      {/* ── Empty / loading states ────────────────────────────── */}
      {!manifest && !loading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-slate-400">
            <FileSpreadsheet className="w-10 h-10 mx-auto mb-2 opacity-40" />
            <p className="text-sm">Select a marketplace and product type, then click Load.</p>
          </div>
        </div>
      )}
      {loading && (
        <div className="flex-1 flex items-center justify-center gap-2 text-slate-500 text-sm">
          <Loader2 className="w-5 h-5 animate-spin" />Loading schema from Amazon…
        </div>
      )}

      {/* ── Spreadsheet ───────────────────────────────────────── */}
      {manifest && !loading && (
        <div className="flex-1 overflow-auto">
          <table className="border-collapse text-sm w-max min-w-full">
            <thead className="sticky top-0 z-20 bg-white dark:bg-slate-900">

              {/* Row 1: Group color bands (English group names) */}
              <tr>
                {/* Status col + row# col (frozen) */}
                <th className="sticky left-0 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 w-9 min-w-[36px]" rowSpan={3} />
                <th className="sticky left-9 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 w-7 min-w-[28px] text-xs text-slate-400 text-center font-normal" rowSpan={3}>#</th>

                {visibleGroups.map((g) => {
                  const c = gColor(g.color)
                  return (
                    <th key={g.id} colSpan={g.columns.length}
                      className={cn('px-2 py-1 text-xs font-bold border-b border-r border-slate-200 dark:border-slate-700 text-left whitespace-nowrap', c.header)}>
                      {g.labelLocal}
                      {g.labelEn && g.labelEn !== g.labelLocal && (
                        <span className="ml-1.5 font-normal opacity-55 text-[11px]">({g.labelEn})</span>
                      )}
                    </th>
                  )
                })}
              </tr>

              {/* Row 2: English column labels */}
              <tr>
                {allColumns.map((col) => {
                  const c = gColor(colToGroup.get(col.id)?.color ?? 'slate')
                  return (
                    <th key={`en-${col.id}`}
                      style={{ minWidth: col.width, width: col.width }}
                      className={cn('px-2 py-0.5 text-left text-xs font-semibold border-b border-r border-slate-200 dark:border-slate-700 whitespace-nowrap', c.text,
                        col.required && 'font-bold')}
                      title={col.description}>
                      {col.labelEn}{col.required && <span className="ml-0.5 text-red-500">*</span>}
                    </th>
                  )
                })}
              </tr>

              {/* Row 3: Italian column labels (Amazon native) */}
              <tr>
                {allColumns.map((col) => (
                  <th key={`it-${col.id}`}
                    style={{ minWidth: col.width, width: col.width }}
                    className="px-2 py-0.5 text-left text-xs font-normal border-b border-r border-slate-200 dark:border-slate-700 whitespace-nowrap text-slate-400 dark:text-slate-500 italic">
                    {col.labelLocal}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {rows.map((row, rowIdx) => (
                <SpreadsheetRow
                  key={row._rowId as string}
                  row={row}
                  rowIdx={rowIdx}
                  columns={allColumns}
                  colToGroup={colToGroup}
                  selected={selectedRows.has(row._rowId as string)}
                  activeCell={activeCell}
                  onSelect={(checked) => setSelectedRows((prev) => { const n = new Set(prev); checked ? n.add(row._rowId as string) : n.delete(row._rowId as string); return n })}
                  onActivate={(colId) => setActiveCell({ rowId: row._rowId as string, colId })}
                  onDeactivate={() => setActiveCell(null)}
                  onChange={(colId, val) => updateCell(row._rowId as string, colId, val)}
                  onNavigate={(colId, dir) => navigate(row._rowId as string, colId, dir)}
                />
              ))}

              {/* Add-row bar */}
              <tr>
                <td colSpan={allColumns.length + 2} className="px-4 py-2 border-t border-dashed border-slate-200 dark:border-slate-700">
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={() => addRow()}>
                      <Plus className="w-3.5 h-3.5 mr-1" />Add row
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => addRow('parent')}>
                      <Plus className="w-3.5 h-3.5 mr-1" />Add parent
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => addRow('child')}>
                      <Plus className="w-3.5 h-3.5 mr-1" />Add variant (child)
                    </Button>
                    {selectedRows.size > 0 && (
                      <Button size="sm" variant="ghost" onClick={deleteSelected}
                        className="text-red-500 hover:text-red-700 ml-2">
                        <Trash2 className="w-3.5 h-3.5 mr-1" />Delete {selectedRows.size}
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* ── Feed results ─────────────────────────────────────── */}
      {feedResults.length > 0 && (
        <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
          <div className="flex items-center gap-2 mb-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
              Processing report — {feedResults.filter((r) => r.status === 'success').length} ok,{' '}
              {feedResults.filter((r) => r.status === 'error').length} errors
            </span>
          </div>
          <div className="max-h-28 overflow-y-auto text-xs space-y-1">
            {feedResults.filter((r) => r.status === 'error').map((r) => (
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
  row: Row; rowIdx: number; columns: Column[]; colToGroup: Map<string, ColumnGroup>
  selected: boolean; activeCell: { rowId: string; colId: string } | null
  onSelect: (c: boolean) => void; onActivate: (colId: string) => void
  onDeactivate: () => void; onChange: (colId: string, val: unknown) => void
  onNavigate: (colId: string, dir: 'right' | 'left' | 'down' | 'up') => void
}

function SpreadsheetRow({ row, rowIdx, columns, colToGroup, selected, activeCell,
  onSelect, onActivate, onDeactivate, onChange, onNavigate }: RowProps) {
  const rowId = row._rowId as string
  const status = row._status
  const rowBg = status === 'success' ? 'bg-emerald-50/70 dark:bg-emerald-950/20'
    : status === 'error' ? 'bg-red-50/70 dark:bg-red-950/20'
    : status === 'pending' ? 'bg-amber-50/70 dark:bg-amber-950/20'
    : row._isNew ? 'bg-sky-50/40 dark:bg-sky-950/10'
    : row._dirty ? 'bg-yellow-50/40 dark:bg-yellow-950/10'
    : ''

  return (
    <tr className={cn('group/row transition-colors', rowBg, 'hover:bg-white/60 dark:hover:bg-slate-800/40')}>
      {/* Status + checkbox */}
      <td className="sticky left-0 z-10 bg-inherit border-b border-r border-slate-200 dark:border-slate-700 px-1.5 w-9 text-center">
        {status === 'success' ? <CheckCircle2 className="w-3 h-3 text-emerald-500 mx-auto" />
          : status === 'error' ? <span title={row._feedMessage as string | undefined}><AlertCircle className="w-3 h-3 text-red-500 mx-auto" /></span>
          : status === 'pending' ? <Loader2 className="w-3 h-3 text-amber-500 animate-spin mx-auto" />
          : <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} className="w-3.5 h-3.5 accent-blue-600" />}
      </td>
      {/* Row # */}
      <td className="sticky left-9 z-10 bg-inherit border-b border-r border-slate-200 dark:border-slate-700 px-1 text-xs text-slate-400 tabular-nums text-right w-7">{rowIdx + 1}</td>

      {/* Data cells */}
      {columns.map((col) => {
        const isActive = activeCell?.rowId === rowId && activeCell?.colId === col.id
        const groupColor = colToGroup.get(col.id)?.color ?? 'slate'
        return (
          <SpreadsheetCell key={col.id} col={col} value={row[col.id]} isActive={isActive}
            cellBg={gColor(groupColor).cell}
            onActivate={() => onActivate(col.id)}
            onDeactivate={onDeactivate}
            onChange={(v) => onChange(col.id, v)}
            onNavigate={(dir) => onNavigate(col.id, dir)}
          />
        )
      })}
    </tr>
  )
}

// ── ProductTypeDropdown ────────────────────────────────────────────────
// Searchable list of known Amazon product types for the selected marketplace.
// Shows types cached from the schema API and types currently used by products.

interface ProductTypeOption { value: string; source: string }

interface ProductTypeDropdownProps {
  value: string
  options: ProductTypeOption[]
  loading: boolean
  onChange: (pt: string) => void
}

function ProductTypeDropdown({ value, options, loading, onChange }: ProductTypeDropdownProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [highlighted, setHighlighted] = useState(0)

  const filtered = useMemo(() => {
    const q = query.toUpperCase()
    return q ? options.filter((o) => o.value.includes(q)) : options
  }, [options, query])

  useEffect(() => { setHighlighted(0) }, [filtered])

  useEffect(() => {
    if (open) setTimeout(() => searchRef.current?.focus(), 30)
  }, [open])

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [])

  function select(pt: string) {
    setOpen(false)
    setQuery('')
    onChange(pt)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[highlighted]) select(filtered[highlighted].value) }
    else if (e.key === 'Escape') setOpen(false)
  }

  const sourceLabel = (s: string) =>
    s === 'both' ? 'schema + catalog'
    : s === 'schema' ? 'schema cached'
    : 'catalog'

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 text-xs font-mono px-2 py-0.5 border rounded transition-colors',
          'bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100',
          'border-slate-200 dark:border-slate-700 hover:border-blue-400 dark:hover:border-blue-500',
          open && 'border-blue-500 ring-1 ring-blue-500',
        )}
      >
        {loading
          ? <Loader2 className="w-3 h-3 animate-spin text-slate-400" />
          : <span className="truncate max-w-[120px]">{value || 'Select…'}</span>}
        <ChevronDown className={cn('w-3 h-3 text-slate-400 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-64 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl overflow-hidden">
          {/* Search */}
          <div className="px-2 py-1.5 border-b border-slate-100 dark:border-slate-700">
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search product types…"
              className="w-full text-xs px-2 py-1 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>

          {/* Options */}
          <div className="max-h-56 overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-xs text-slate-400 italic text-center">
                {options.length === 0 ? 'No cached schemas yet. Type a product type and load it.' : 'No matches'}
              </div>
            ) : (
              filtered.map((opt, i) => (
                <button
                  key={opt.value}
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); select(opt.value) }}
                  onMouseEnter={() => setHighlighted(i)}
                  className={cn(
                    'w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left transition-colors',
                    i === highlighted
                      ? 'bg-blue-500 text-white'
                      : opt.value === value
                      ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50',
                  )}
                >
                  <span className="text-xs font-mono font-medium">{opt.value}</span>
                  <span className={cn('text-xs opacity-60 shrink-0', i === highlighted && 'opacity-80')}>
                    {sourceLabel(opt.source)}
                  </span>
                </button>
              ))
            )}
          </div>

          {/* Manual entry footer */}
          <div className="px-2 py-1.5 border-t border-slate-100 dark:border-slate-700">
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                const pt = query.trim().toUpperCase()
                if (pt) select(pt)
              }}
              disabled={!query.trim()}
              className="w-full text-xs text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 py-0.5 text-left disabled:opacity-40 disabled:cursor-default"
            >
              {query.trim()
                ? <>Use <span className="font-mono font-medium">{query.trim().toUpperCase()}</span> (new type)</>
                : 'Type a name to use a custom product type'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── SpreadsheetCell + EnumDropdown ─────────────────────────────────────

interface CellProps {
  col: Column; value: unknown; isActive: boolean; cellBg: string
  onActivate: () => void; onDeactivate: () => void
  onChange: (val: unknown) => void
  onNavigate: (dir: 'right' | 'left' | 'down' | 'up') => void
}

function SpreadsheetCell({ col, value, isActive, cellBg, onActivate, onDeactivate, onChange, onNavigate }: CellProps) {
  const displayValue = value != null ? String(value) : ''
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)

  useEffect(() => {
    if (isActive && col.kind !== 'enum' && inputRef.current) {
      inputRef.current.focus()
      if ('select' in inputRef.current) (inputRef.current as HTMLInputElement).select()
    }
  }, [isActive, col.kind])

  const isEmpty = !displayValue

  const baseCls = cn(
    'border-b border-r border-slate-200 dark:border-slate-700 relative transition-colors',
    cellBg,
    isActive && 'ring-2 ring-inset ring-blue-500 z-[5]',
    !isActive && col.required && isEmpty && 'bg-red-50/70 dark:bg-red-950/20',
  )

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Tab') { e.preventDefault(); onNavigate(e.shiftKey ? 'left' : 'right') }
    else if (e.key === 'Enter' && col.kind !== 'longtext') { e.preventDefault(); onNavigate(e.shiftKey ? 'up' : 'down') }
    else if (e.key === 'Escape') { onDeactivate(); setDropdownOpen(false) }
    else if (e.key === 'ArrowDown' && col.kind === 'enum') { e.preventDefault(); setDropdownOpen(true) }
  }

  // Enum cell: custom dropdown
  if (col.kind === 'enum' && col.options && col.options.length > 0) {
    return (
      <td className={baseCls} style={{ minWidth: col.width, width: col.width }}
        onClick={() => { onActivate(); setDropdownOpen(true) }}>
        <div className="h-[28px] px-1.5 flex items-center justify-between gap-1 cursor-pointer group/cell">
          <span className={cn('text-xs truncate flex-1', isEmpty ? 'text-slate-300 dark:text-slate-600 italic' : 'text-slate-800 dark:text-slate-200')}>
            {displayValue || (col.required ? '⚠ required' : col.options[0] ? `e.g. ${col.options[0]}` : '—')}
          </span>
          <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0 opacity-0 group-hover/cell:opacity-100 transition-opacity" />
        </div>
        {isActive && dropdownOpen && (
          <EnumDropdown
            options={col.options}
            current={displayValue}
            onSelect={(v) => { onChange(v); setDropdownOpen(false); onNavigate('right') }}
            onClose={() => { setDropdownOpen(false); onDeactivate() }}
          />
        )}
      </td>
    )
  }

  // Longtext cell
  if (col.kind === 'longtext') {
    if (isActive) {
      return (
        <td className={baseCls} style={{ minWidth: col.width, width: col.width }}>
          <textarea ref={inputRef as any} defaultValue={displayValue}
            onBlur={(e) => { onChange(e.target.value); onDeactivate() }}
            onKeyDown={handleKeyDown}
            rows={3}
            className="w-full px-1.5 py-1 text-xs bg-white dark:bg-slate-800 focus:outline-none text-slate-800 dark:text-slate-200 resize-none"
            style={{ minWidth: col.width }} />
        </td>
      )
    }
    return (
      <td className={cn(baseCls, 'cursor-pointer hover:bg-white/50 dark:hover:bg-slate-700/30')}
        style={{ minWidth: col.width, width: col.width }} onClick={onActivate}>
        <div className="h-[28px] px-1.5 flex items-center text-xs text-slate-800 dark:text-slate-200 truncate">
          {displayValue || <span className="text-slate-300 dark:text-slate-600 italic">{col.required ? '⚠ required' : ''}</span>}
        </div>
      </td>
    )
  }

  // Text / number cell
  if (isActive) {
    return (
      <td className={baseCls} style={{ minWidth: col.width, width: col.width }}>
        <input ref={inputRef as any} type={col.kind === 'number' ? 'number' : 'text'}
          defaultValue={displayValue} maxLength={col.maxLength}
          onBlur={(e) => { onChange(e.target.value); onDeactivate() }}
          onKeyDown={handleKeyDown}
          className="w-full h-[28px] px-1.5 text-xs bg-white dark:bg-slate-800 focus:outline-none text-slate-800 dark:text-slate-200" />
      </td>
    )
  }

  return (
    <td className={cn(baseCls, 'cursor-pointer hover:bg-white/50 dark:hover:bg-slate-700/30')}
      style={{ minWidth: col.width, width: col.width }} onClick={onActivate} title={col.description}>
      <div className={cn('h-[28px] px-1.5 flex items-center text-xs truncate',
        isEmpty ? (col.required ? 'text-red-400 dark:text-red-500 italic' : 'text-slate-300 dark:text-slate-600') : 'text-slate-800 dark:text-slate-200')}>
        {displayValue || (col.required ? '⚠ required' : '')}
      </div>
    </td>
  )
}

// ── EnumDropdown ────────────────────────────────────────────────────────
// Floating dropdown panel that appears below the active enum cell.
// Matches Excel's "in-cell dropdown" UX: search-to-filter + keyboard nav.

interface EnumDropdownProps {
  options: string[]
  current: string
  onSelect: (val: string) => void
  onClose: () => void
}

function EnumDropdown({ options, current, onSelect, onClose }: EnumDropdownProps) {
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return options.filter((o) => !q || o.toLowerCase().includes(q))
  }, [options, query])

  useEffect(() => { searchRef.current?.focus() }, [])
  useEffect(() => { setHighlighted(0) }, [filtered])

  // Scroll highlighted item into view
  useEffect(() => {
    const el = listRef.current?.children[highlighted] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  // Close on outside click
  useEffect(() => {
    function handle(e: MouseEvent) {
      const target = e.target as Node
      if (!listRef.current?.parentElement?.contains(target)) onClose()
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [onClose])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[highlighted] != null) onSelect(filtered[highlighted]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'Tab') { e.preventDefault(); if (filtered[highlighted] != null) onSelect(filtered[highlighted]) }
  }

  return (
    <div className="absolute left-0 top-full mt-0 z-50 w-48 min-w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg overflow-hidden"
      onKeyDown={handleKeyDown}>
      {/* Search input */}
      <div className="px-2 py-1.5 border-b border-slate-100 dark:border-slate-700">
        <input ref={searchRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          className="w-full text-xs px-1.5 py-1 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
      </div>
      {/* Options list */}
      <div ref={listRef} className="max-h-48 overflow-y-auto">
        {filtered.length === 0
          ? <div className="px-3 py-2 text-xs text-slate-400 italic">No matches</div>
          : filtered.map((opt, i) => (
            <div key={opt || '_empty'} role="option" aria-selected={opt === current}
              onMouseDown={(e) => { e.preventDefault(); onSelect(opt) }}
              onMouseEnter={() => setHighlighted(i)}
              className={cn(
                'px-3 py-1.5 text-xs cursor-pointer truncate',
                i === highlighted ? 'bg-blue-500 text-white' : opt === current ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-medium' : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50',
              )}>
              {opt === '' ? <span className="italic opacity-60">— empty —</span> : opt}
            </div>
          ))}
      </div>
    </div>
  )
}

// ── CopyToMarketPanel ──────────────────────────────────────────────────
// Floating panel for copying rows from the current market to another.
// Three modes: copy whole groups, exclude individual columns within a group,
// or deselect groups entirely. Structural columns (SKU, parentage, etc.)
// are always copied automatically.

const MARKETPLACES_ALL = ['IT', 'DE', 'FR', 'ES', 'UK']

// Groups that are typically market-specific — pre-deselected by default
function isMarketSpecificGroup(id: string) {
  return /^offer_[A-Z0-9]/.test(id) || /^selling_/.test(id) || id === 'fulfillment'
}

interface CopyPanelProps {
  manifest: Manifest
  rows: Row[]
  currentMarket: string
  onCopy: (targetMarket: string, colIds: Set<string>) => void
  onClose: () => void
}

function CopyToMarketPanel({ manifest, rows, currentMarket, onCopy, onClose }: CopyPanelProps) {
  const otherMarkets = MARKETPLACES_ALL.filter((m) => m !== currentMarket)
  const [targetMarket, setTargetMarket] = useState(otherMarkets[0] ?? '')

  // Group selection: default on for content groups, off for market-specific
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(
    () => new Set(
      manifest.groups
        .filter((g) => !isMarketSpecificGroup(g.id))
        .map((g) => g.id)
    )
  )
  // Column-level exclusions within a selected group
  const [excludedCols, setExcludedCols] = useState<Set<string>>(new Set())
  // Which group is expanded to show column-level toggles
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)

  const selectedColIds = useMemo(() => {
    const ids = new Set<string>()
    for (const g of manifest.groups) {
      if (!selectedGroups.has(g.id)) continue
      for (const c of g.columns) {
        if (!excludedCols.has(c.id)) ids.add(c.id)
      }
    }
    return ids
  }, [manifest, selectedGroups, excludedCols])

  // Close on outside click
  const panelRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [onClose])

  function toggleGroup(id: string) {
    setSelectedGroups((prev) => {
      const n = new Set(prev)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  }

  function toggleCol(colId: string) {
    setExcludedCols((prev) => {
      const n = new Set(prev)
      n.has(colId) ? n.delete(colId) : n.add(colId)
      return n
    })
  }

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full mt-1 z-50 w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
            Copy to market
          </div>
          <div className="text-xs text-slate-400">
            {rows.length} row{rows.length !== 1 ? 's' : ''} from {currentMarket}
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Target market */}
      <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800">
        <div className="text-xs font-medium text-slate-500 mb-1.5">Target market</div>
        <div className="flex gap-1">
          {otherMarkets.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setTargetMarket(m)}
              className={cn(
                'text-xs font-medium px-2.5 py-1 rounded border transition-colors',
                m === targetMarket
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-blue-400',
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* Group + column selection */}
      <div className="max-h-72 overflow-y-auto">
        <div className="px-4 pt-2 pb-1">
          <div className="text-xs font-medium text-slate-500">What to copy</div>
        </div>
        {manifest.groups.map((g) => {
          const checked = selectedGroups.has(g.id)
          const isExpanded = expandedGroup === g.id
          const groupExcludedCount = g.columns.filter((c) => excludedCols.has(c.id)).length

          return (
            <div key={g.id}>
              <div className="flex items-center gap-2 px-4 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleGroup(g.id)}
                  className="w-3.5 h-3.5 accent-blue-600 flex-shrink-0"
                />
                <div className="flex-1 min-w-0">
                  <span className={cn('text-xs truncate', checked ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 line-through')}>
                    {g.labelLocal}
                    {g.labelEn !== g.labelLocal && (
                      <span className="ml-1 opacity-50">({g.labelEn})</span>
                    )}
                  </span>
                  {checked && groupExcludedCount > 0 && (
                    <span className="ml-1 text-xs text-amber-500">−{groupExcludedCount}</span>
                  )}
                </div>
                <span className="text-xs text-slate-400 tabular-nums flex-shrink-0">
                  {g.columns.length - (checked ? groupExcludedCount : 0)}
                </span>
                {checked && (
                  <button
                    type="button"
                    onClick={() => setExpandedGroup(isExpanded ? null : g.id)}
                    className="text-slate-400 hover:text-slate-600 flex-shrink-0"
                    title="Expand to exclude specific columns"
                  >
                    <ChevronDown className={cn('w-3 h-3 transition-transform', isExpanded && 'rotate-180')} />
                  </button>
                )}
              </div>

              {/* Column-level toggles */}
              {isExpanded && checked && (
                <div className="ml-8 mr-4 mb-1 bg-slate-50 dark:bg-slate-800/50 rounded-lg p-2 grid grid-cols-1 gap-0.5 max-h-36 overflow-y-auto">
                  {g.columns.map((c) => {
                    const excluded = excludedCols.has(c.id)
                    return (
                      <label key={c.id} className="flex items-center gap-1.5 cursor-pointer group/col">
                        <input
                          type="checkbox"
                          checked={!excluded}
                          onChange={() => toggleCol(c.id)}
                          className="w-3 h-3 accent-blue-600 flex-shrink-0"
                        />
                        <span className={cn('text-xs truncate', excluded ? 'text-slate-400 line-through' : 'text-slate-600 dark:text-slate-400')}>
                          {c.labelLocal}
                          {c.required && <span className="ml-0.5 text-red-400">*</span>}
                        </span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
        <div className="text-xs text-slate-400">
          {selectedColIds.size} column{selectedColIds.size !== 1 ? 's' : ''} → {targetMarket}
        </div>
        <Button
          size="sm"
          onClick={() => onCopy(targetMarket, selectedColIds)}
          disabled={!targetMarket || selectedColIds.size === 0}
        >
          <Copy className="w-3.5 h-3.5 mr-1.5" />
          Copy {rows.length} row{rows.length !== 1 ? 's' : ''}
        </Button>
      </div>
    </div>
  )
}

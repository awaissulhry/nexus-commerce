'use client'

import {
  useCallback, useEffect, useRef, useState, useMemo,
  type KeyboardEvent,
} from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  Copy, Download, FileSpreadsheet, Loader2, Plus, RefreshCw,
  Search, Send, Trash2, Upload, X, ArrowDownToLine,
  Undo2, Redo2, GripVertical, SlidersHorizontal,
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
  expandedFields: Record<string, string>
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

interface SortLevel {
  id: string
  colId: string
  mode: 'asc' | 'desc' | 'custom'
  customOrder: string[]
}

interface FeedEntry {
  market: string
  feedId: string
  status: string | null
  results: FeedResult[]
  error?: string
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
  /** Present when opened from a product page — scopes this to one product family. */
  familyId?: string
}

// ── Component ──────────────────────────────────────────────────────────

export default function AmazonFlatFileClient({
  initialManifest,
  initialRows,
  initialMarketplace,
  initialProductType,
  familyId,
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

  // Groups the user has explicitly CLOSED — persisted in localStorage.
  // Everything not in this set is open by default (including new groups
  // that appear after a schema refresh). This way the user's choices survive
  // refreshes without any explicit reset.
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('ff-closed-groups') ?? '[]')) }
    catch { return new Set() }
  })

  // Derived: open = all manifest groups minus whatever the user has closed
  const openGroups = useMemo(
    () => new Set((manifest?.groups ?? []).map((g) => g.id).filter((id) => !closedGroups.has(id))),
    [manifest, closedGroups],
  )

  // User-defined group order — persisted in localStorage
  const [groupOrder, setGroupOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('ff-group-order') ?? '[]') } catch { return [] }
  })
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null)

  const [sortConfig, setSortConfig] = useState<SortLevel[]>([])
  const [sortPanelOpen, setSortPanelOpen] = useState(false)

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMode, setSearchMode] = useState<'rows' | 'columns'>('rows')
  const searchRef = useRef<HTMLInputElement>(null)

  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [activeCell, setActiveCell] = useState<{ rowId: string; colId: string } | null>(null)

  const [feedEntries, setFeedEntries] = useState<FeedEntry[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [polling, setPolling] = useState(false)
  const [submitPanelOpen, setSubmitPanelOpen] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [copyPanelOpen, setCopyPanelOpen] = useState(false)
  // copying state used by handleCopyToMarket

  // ── Column + row resize ────────────────────────────────────────────
  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem('ff-col-widths') ?? '{}') } catch { return {} }
  })
  const [rowHeight, setRowHeight] = useState<number>(() => {
    try { return Math.max(24, parseInt(localStorage.getItem('ff-row-height') ?? '28', 10) || 28) } catch { return 28 }
  })
  const [resizingType, setResizingType] = useState<'col' | 'row' | null>(null)
  const resizeDragRef = useRef<{
    type: 'col' | 'row'; colId?: string
    startX: number; startY: number; startVal: number
  } | null>(null)
  const [fetchPanelOpen, setFetchPanelOpen] = useState(false)
  const [fetching, setFetching] = useState(false)

  // ── Undo / Redo ────────────────────────────────────────────────────
  const rowsRef = useRef<Row[]>(rows)
  useEffect(() => { rowsRef.current = rows }, [rows])
  const displayRowsRef = useRef<Row[]>([])

  const [draggingRowId, setDraggingRowId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ rowId: string; half: 'top' | 'bottom' } | null>(null)
  const [history, setHistory] = useState<Row[][]>([])
  const [future, setFuture] = useState<Row[][]>([])

  const pushSnapshot = useCallback(() => {
    setHistory((prev) => [...prev.slice(-49), rowsRef.current])
    setFuture([])
  }, [])

  const undo = useCallback(() => {
    setHistory((prev) => {
      if (!prev.length) return prev
      const next = [...prev]
      const snapshot = next.pop()!
      setFuture((f) => [rowsRef.current, ...f.slice(0, 49)])
      setRows(snapshot)
      return next
    })
  }, [])

  const redo = useCallback(() => {
    setFuture((prev) => {
      if (!prev.length) return prev
      const next = [...prev]
      const snapshot = next.shift()!
      setHistory((h) => [...h.slice(-49), rowsRef.current])
      setRows(snapshot)
      return next
    })
  }, [])

  useEffect(() => {
    function handle(e: globalThis.KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      if (e.key === 'z' && e.shiftKey)  { e.preventDefault(); redo() }
      if (e.key === 'y')                 { e.preventDefault(); redo() }
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [undo, redo])

  // Persist resize state to localStorage
  useEffect(() => { try { localStorage.setItem('ff-col-widths', JSON.stringify(colWidths)) } catch {} }, [colWidths])
  useEffect(() => { try { localStorage.setItem('ff-row-height', String(rowHeight)) } catch {} }, [rowHeight])

  // Global mouse handlers for drag-resize
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = resizeDragRef.current
      if (!d) return
      if (d.type === 'col' && d.colId) {
        setColWidths((p) => ({ ...p, [d.colId!]: Math.max(60, d.startVal + e.clientX - d.startX) }))
      } else if (d.type === 'row') {
        setRowHeight(Math.max(24, d.startVal + e.clientY - d.startY))
      }
    }
    function onUp() { resizeDragRef.current = null; setResizingType(null) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [])

  const startColResize = useCallback((e: React.MouseEvent, colId: string, curW: number) => {
    e.preventDefault(); e.stopPropagation()
    resizeDragRef.current = { type: 'col', colId, startX: e.clientX, startY: 0, startVal: curW }
    setResizingType('col')
  }, [])

  const startRowResize = useCallback((e: React.MouseEvent, curH: number) => {
    e.preventDefault(); e.stopPropagation()
    resizeDragRef.current = { type: 'row', startX: 0, startY: e.clientY, startVal: curH }
    setResizingType('row')
  }, [])

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

  // Column-mode search: filter columns within visible groups
  const displayGroups = useMemo<ColumnGroup[]>(() => {
    if (!searchQuery || searchMode !== 'columns') return visibleGroups
    const q = searchQuery.toLowerCase()
    return visibleGroups
      .map((g) => ({
        ...g,
        columns: g.columns.filter(
          (c) =>
            c.id.toLowerCase().includes(q) ||
            c.labelEn.toLowerCase().includes(q) ||
            c.labelLocal.toLowerCase().includes(q) ||
            c.fieldRef.toLowerCase().includes(q),
        ),
      }))
      .filter((g) => g.columns.length > 0)
  }, [visibleGroups, searchQuery, searchMode])

  const allColumns = useMemo<Column[]>(
    () => displayGroups.flatMap((g) => g.columns),
    [displayGroups],
  )

  // Row-mode search + multi-level sort (display-only, never mutates rows)
  const displayRows = useMemo<Row[]>(() => {
    let result: Row[]
    if (searchQuery && searchMode === 'rows') {
      const q = searchQuery.toLowerCase()
      result = rows.filter((row) =>
        Object.entries(row).some(
          ([k, v]) => !k.startsWith('_') && v != null && String(v).toLowerCase().includes(q),
        ),
      )
    } else {
      result = rows
    }

    if (sortConfig.length > 0) {
      result = [...result].sort((a, b) => {
        for (const level of sortConfig) {
          if (!level.colId) continue
          const aVal = String(a[level.colId] ?? '')
          const bVal = String(b[level.colId] ?? '')
          let cmp = 0
          if (level.mode === 'asc') {
            cmp = aVal.localeCompare(bVal, undefined, { numeric: true, sensitivity: 'base' })
          } else if (level.mode === 'desc') {
            cmp = bVal.localeCompare(aVal, undefined, { numeric: true, sensitivity: 'base' })
          } else {
            const ai = level.customOrder.indexOf(aVal)
            const bi = level.customOrder.indexOf(bVal)
            cmp = (ai === -1 ? 1e9 : ai) - (bi === -1 ? 1e9 : bi)
          }
          if (cmp !== 0) return cmp
        }
        return 0
      })
    }
    displayRowsRef.current = result
    return result
  }, [rows, searchQuery, searchMode, sortConfig])

  const reorderRow = useCallback((fromId: string, toId: string, half: 'top' | 'bottom') => {
    if (fromId === toId) return
    pushSnapshot()
    setSortConfig([])
    setRows((prev) => {
      const displayed = displayRowsRef.current.map((r) => r._rowId as string)
      const rowMap = new Map(prev.map((r) => [r._rowId as string, r]))
      const next = [...displayed]
      const fi = next.indexOf(fromId)
      const ti = next.indexOf(toId)
      if (fi === -1 || ti === -1) return prev
      next.splice(fi, 1)
      const adj = fi < ti ? ti - 1 : ti
      next.splice(half === 'top' ? adj : adj + 1, 0, fromId)
      const notDisplayed = prev.filter((r) => !displayed.includes(r._rowId as string))
      return [...next.map((id) => rowMap.get(id)!).filter(Boolean), ...notDisplayed]
    })
    setDraggingRowId(null)
    setDropTarget(null)
  }, [pushSnapshot])

  const colToGroup = useMemo<Map<string, ColumnGroup>>(() => {
    const m = new Map<string, ColumnGroup>()
    for (const g of orderedGroups) {
      for (const c of g.columns) m.set(c.id, g)
    }
    return m
  }, [orderedGroups])


  const dirtyRows = useMemo(() => rows.filter((r) => r._dirty || r._isNew), [rows])
  const newCount  = useMemo(() => rows.filter((r) => r._isNew).length, [rows])

  // ── Row persistence (localStorage) ────────────────────────────────
  // Autosave rows keyed by market+productType so edits survive navigation
  // and schema refreshes. Only overwritten when the user explicitly loads
  // fresh rows (marketplace/product type change) or reloads rows manually.

  function rowStorageKey(mp: string, pt: string) {
    const base = `ff-rows-${mp.toUpperCase()}-${pt.toUpperCase()}`
    // Family sessions get their own key, independent from the global file
    return familyId ? `${base}-family-${familyId}` : base
  }
  function saveRows(mp: string, pt: string, r: Row[]) {
    try { localStorage.setItem(rowStorageKey(mp, pt), JSON.stringify(r)) } catch {}
  }
  function loadSavedRows(mp: string, pt: string): Row[] | null {
    try {
      const raw = localStorage.getItem(rowStorageKey(mp, pt))
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }

  // Debounced autosave — fires 1 s after last edit
  useEffect(() => {
    if (!productType || !rows.length) return
    const t = setTimeout(() => saveRows(marketplace, productType, rows), 1000)
    return () => clearTimeout(t)
  }, [rows, marketplace, productType])

  // ── Load data ──────────────────────────────────────────────────────

  const loadData = useCallback(async (mp: string, pt: string, force = false) => {
    if (!pt.trim()) return
    setLoading(true)
    setLoadError(null)
    setFeedEntries([])
    const backend = getBackendUrl()
    const qs = new URLSearchParams({ marketplace: mp, productType: pt, ...(force ? { force: '1' } : {}) })
    const rowsQs = new URLSearchParams({ marketplace: mp, productType: pt })
    if (familyId) rowsQs.set('productId', familyId)
    try {
      if (force) {
        // Schema refresh — update manifest only, keep current rows unchanged.
        // User's edits must not be overwritten by a schema change.
        const mRes = await fetch(`${backend}/api/amazon/flat-file/template?${qs}`)
        if (!mRes.ok) { const e = await mRes.json().catch(() => ({})); throw new Error(e.error ?? `HTTP ${mRes.status}`) }
        setManifest(await mRes.json())
      } else {
        // Full load (marketplace or product type change) — fetch manifest + rows.
        // Use localStorage draft if available, otherwise fall back to server rows.
        const [mRes, rRes] = await Promise.all([
          fetch(`${backend}/api/amazon/flat-file/template?${qs}`),
          fetch(`${backend}/api/amazon/flat-file/rows?${rowsQs}`),
        ])
        if (!mRes.ok) { const e = await mRes.json().catch(() => ({})); throw new Error(e.error ?? `HTTP ${mRes.status}`) }
        setManifest(await mRes.json())
        const saved = loadSavedRows(mp, pt)
        if (saved && saved.length > 0) {
          setRows(saved)
        } else if (rRes.ok) {
          const d = await rRes.json()
          setRows(d.rows ?? [])
        } else {
          setRows([])
        }
        const p = new URLSearchParams(searchParams?.toString() ?? '')
        p.set('marketplace', mp); p.set('productType', pt)
        router.replace(`?${p.toString()}`, { scroll: false })
      }
    } catch (e: any) {
      setLoadError(e.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [router, searchParams])

  // ── Row operations ─────────────────────────────────────────────────

  const addRow = useCallback((parentage = '') => {
    pushSnapshot()
    const row = makeEmptyRow(productType, marketplace, parentage)
    setRows((prev) => [...prev, row])
    setTimeout(() => setActiveCell({ rowId: row._rowId as string, colId: 'item_sku' }), 30)
  }, [productType, marketplace])

  const deleteSelected = useCallback(() => {
    pushSnapshot()
    setRows((prev) => prev.filter((r) => !selectedRows.has(r._rowId as string)))
    setSelectedRows(new Set())
  }, [selectedRows])

  const updateCell = useCallback((rowId: string, colId: string, value: unknown) => {
    pushSnapshot()
    setRows((prev) => prev.map((r) => r._rowId === rowId ? { ...r, [colId]: value, _dirty: true } : r))
  }, [])

  const navigate = useCallback((rowId: string, colId: string, dir: 'right' | 'left' | 'down' | 'up') => {
    const colIds = allColumns.map((c) => c.id)
    const rowIds = displayRows.map((r) => r._rowId as string)
    let ci = colIds.indexOf(colId), ri = rowIds.indexOf(rowId)
    if (dir === 'right') ci = Math.min(ci + 1, colIds.length - 1)
    else if (dir === 'left') ci = Math.max(ci - 1, 0)
    else if (dir === 'down') ri = Math.min(ri + 1, rowIds.length - 1)
    else ri = Math.max(ri - 1, 0)
    const nc = colIds[ci], nr = rowIds[ri]
    if (nc && nr) setActiveCell({ rowId: nr, colId: nc })
  }, [allColumns, rows])

  // ── Submit ─────────────────────────────────────────────────────────

  const handleSubmitToMarkets = useCallback(async (markets: Set<string>) => {
    setSubmitting(true)
    setSubmitPanelOpen(false)
    setFeedEntries([])

    if (markets.has(marketplace)) {
      setRows((prev) => prev.map((r) => r._dirty || r._isNew ? { ...r, _status: 'pending' } : r))
    }

    const settled = await Promise.allSettled(
      [...markets].map(async (mp) => {
        let toSend: Row[]
        if (mp === marketplace) {
          toSend = rows.filter((r) => r._dirty || r._isNew)
        } else {
          const key = rowStorageKey(mp, productType)
          try {
            const raw = localStorage.getItem(key)
            const saved: Row[] = raw ? JSON.parse(raw) : []
            toSend = saved.filter((r) => r._dirty || r._isNew)
          } catch { toSend = [] }
        }
        if (!toSend.length) return { mp, feedId: '', skipped: true }
        const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: toSend, marketplace: mp, expandedFields: manifest?.expandedFields ?? {} }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(`[${mp}] ${data.error ?? 'Submit failed'}`)
        return { mp, feedId: data.feedId, skipped: false }
      })
    )

    const entries: FeedEntry[] = []
    const errors: string[] = []
    for (const result of settled) {
      if (result.status === 'fulfilled' && !result.value.skipped) {
        entries.push({ market: result.value.mp, feedId: result.value.feedId, status: 'IN_QUEUE', results: [] })
      } else if (result.status === 'rejected') {
        errors.push(result.reason?.message ?? 'Submit failed')
      }
    }
    setFeedEntries(entries)
    if (errors.length) setLoadError(errors.join(' · '))

    if (markets.has(marketplace)) {
      setRows((prev) => prev.map((r) =>
        r._dirty || r._isNew ? { ...r, _dirty: false, _isNew: false, _status: 'pending' } : r
      ))
    }
    setSubmitting(false)
  }, [rows, marketplace, productType, manifest])

  const pollAllFeeds = useCallback(async () => {
    if (!feedEntries.length) return
    setPolling(true)
    try {
      const updated = await Promise.all(
        feedEntries.map(async (entry) => {
          if (entry.status === 'DONE' || entry.status === 'FATAL') return entry
          const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/feeds/${entry.feedId}`)
          const data = await res.json()
          if (data.processingStatus === 'DONE' && entry.market === marketplace) {
            const bySkU = new Map<string, FeedResult>((data.results as FeedResult[]).map((r: FeedResult) => [r.sku, r]))
            setRows((prev) => prev.map((r) => {
              const fr = bySkU.get(r.item_sku as string)
              return fr ? { ...r, _status: fr.status as any, _feedMessage: fr.message } : r
            }))
          }
          return { ...entry, status: data.processingStatus, results: data.results ?? [] }
        })
      )
      setFeedEntries(updated)
    } catch (e: any) { setLoadError(e.message) }
    finally { setPolling(false) }
  }, [feedEntries, marketplace])

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
    pushSnapshot()
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
      setRows(copiedRows)
      setFeedEntries([])
    } catch (e: any) {
      setLoadError(e.message ?? 'Copy failed')
    }
  }, [manifest, rows, productType])

  // ── Fetch from Amazon ───────────────────────────────────────────────
  const handleFetchFromAmazon = useCallback(async (targetMarkets: string[]) => {
    const selectedSkus = [...selectedRows]
      .map((id) => rows.find((r) => r._rowId === id)?.item_sku as string | undefined)
      .filter((s): s is string => !!s)
    if (!selectedSkus.length) return

    setFetching(true)
    setFetchPanelOpen(false)
    try {
      const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/fetch-listings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus: selectedSkus, marketplaces: targetMarkets }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Fetch failed')

      const results: Record<string, Record<string, { asin?: string; status?: string }>> =
        data.results ?? {}

      // 1. Update current market rows in state
      const currentResults = results[marketplace] ?? {}
      setRows((prev) =>
        prev.map((row) => {
          const fetched = currentResults[row.item_sku as string]
          if (!fetched) return row
          return {
            ...row,
            ...(fetched.asin ? { _asin: fetched.asin } : {}),
            ...(fetched.status ? { _listingStatus: fetched.status } : {}),
          }
        }),
      )

      // 2. Merge into other markets' localStorage drafts
      for (const [mp, mpResults] of Object.entries(results)) {
        if (mp === marketplace) continue
        const key = rowStorageKey(mp, productType)
        try {
          const existingRaw = localStorage.getItem(key)
          const existing: Row[] = existingRaw ? JSON.parse(existingRaw) : []
          if (!existing.length) continue
          const updated = existing.map((row) => {
            const fetched = mpResults[row.item_sku as string]
            if (!fetched) return row
            return {
              ...row,
              ...(fetched.asin ? { _asin: fetched.asin } : {}),
              ...(fetched.status ? { _listingStatus: fetched.status } : {}),
            }
          })
          localStorage.setItem(key, JSON.stringify(updated))
        } catch { /* quota exceeded — skip */ }
      }
    } catch (e: any) {
      setLoadError(e.message ?? 'Fetch from Amazon failed')
    } finally {
      setFetching(false)
    }
  }, [selectedRows, rows, marketplace, productType])

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

  // ── Save / Discard ────────────────────────────────────────────────
  const [saveFlash, setSaveFlash] = useState(false)

  const handleSave = useCallback(() => {
    saveRows(marketplace, productType, rows)
    setSaveFlash(true)
    setTimeout(() => setSaveFlash(false), 2000)
  }, [rows, marketplace, productType])

  const handleDiscard = useCallback(() => {
    if (!confirm('Discard all local changes? Your edits will be lost and rows will reload from the server.')) return
    try { localStorage.removeItem(rowStorageKey(marketplace, productType)) } catch {}
    void loadData(marketplace, productType, false)
  }, [marketplace, productType, loadData])

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">

      {/* Full-screen overlay while resizing — locks cursor, prevents text selection */}
      {resizingType && (
        <div className={cn('fixed inset-0 z-[9999] select-none', resizingType === 'col' ? 'cursor-col-resize' : 'cursor-row-resize')} />
      )}

      {/* ── Sticky header ────────────────────────────────────── */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30">

        {/* ── Bar 1: App chrome + menus + primary actions ───── */}
        <div className="px-3 h-10 flex items-center gap-2 border-b border-slate-100 dark:border-slate-800/60">

          {/* Back */}
          <IconButton aria-label="Back" size="sm" onClick={() => router.push('/products')} className="!h-auto !w-auto p-1 -ml-0.5 flex-shrink-0">
            <ChevronLeft className="w-4 h-4" />
          </IconButton>

          {/* ── Menus — left side ── */}
          <div className="flex items-center gap-0.5 flex-shrink-0">
            <MenuDropdown label="File" items={[
              { label: 'Import TSV…', icon: <Upload className="w-3.5 h-3.5" />, onClick: () => fileInputRef.current?.click() },
              { label: 'Export TSV', icon: <Download className="w-3.5 h-3.5" />, onClick: exportTsv, disabled: !rows.length },
              { separator: true },
              { label: 'Reload rows from server', icon: <RefreshCw className="w-3.5 h-3.5" />, disabled: !productType || !rows.length,
                onClick: () => {
                  if (!confirm('Reload rows from server? Your unsaved local edits will be lost.')) return
                  try { localStorage.removeItem(rowStorageKey(marketplace, productType)) } catch {}
                  void loadData(marketplace, productType, false)
                }},
            ]} />
            <MenuDropdown label="Edit" items={[
              { label: 'Undo', icon: <Undo2 className="w-3.5 h-3.5" />, onClick: undo, disabled: !history.length, shortcut: '⌘Z' },
              { label: 'Redo', icon: <Redo2 className="w-3.5 h-3.5" />, onClick: redo, disabled: !future.length, shortcut: '⌘⇧Z' },
              { separator: true },
              { label: 'Copy to market…', icon: <Copy className="w-3.5 h-3.5" />, onClick: () => setCopyPanelOpen((o) => !o), disabled: !manifest || !rows.length },
              { separator: true },
              { label: 'Reset column widths', onClick: () => { setColWidths({}); try { localStorage.removeItem('ff-col-widths') } catch {} }, disabled: !Object.keys(colWidths).length },
              { label: 'Reset row height', onClick: () => { setRowHeight(28); try { localStorage.setItem('ff-row-height', '28') } catch {} }, disabled: rowHeight === 28 },
            ]} />
          </div>

          {/* Separator */}
          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5 flex-shrink-0" />

          {/* Title + status badges */}
          <FileSpreadsheet className="w-4 h-4 text-orange-500 flex-shrink-0" />
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">Amazon Flat File</span>
          {manifest && <><Badge variant="info">{manifest.productType}</Badge><Badge variant="default">{manifest.marketplace}</Badge></>}
          {familyId && (
            <span className="inline-flex items-center gap-1 text-xs bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-800 rounded px-1.5 py-0.5 flex-shrink-0">
              <FileSpreadsheet className="w-3 h-3" />Family
            </span>
          )}
          {dirtyRows.length > 0 && <Badge variant="warning" className="flex-shrink-0"><AlertCircle className="w-3 h-3 mr-1" />{dirtyRows.length} unsaved</Badge>}
          {newCount > 0 && <Badge variant="info" className="flex-shrink-0">{newCount} new</Badge>}

          {/* Flex spacer */}
          <div className="flex-1 min-w-0" />

          {/* Hidden file input for Import */}
          <input ref={fileInputRef} type="file" accept=".txt,.tsv,.csv,.xlsm,.xlsx" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = '' }} />

          {/* Feed status badges */}
          {feedEntries.length > 0 && (
            <div className="flex items-center gap-1">
              {feedEntries.map((e) => (
                <span key={e.market} className={cn(
                  'text-xs font-medium px-2 py-0.5 rounded-full border',
                  e.status === 'DONE'
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800'
                    : e.status === 'FATAL'
                    ? 'bg-red-50 text-red-700 border-red-200'
                    : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800',
                )}>
                  {e.market}: {e.status ?? '…'}
                </span>
              ))}
              {feedEntries.some((e) => e.status !== 'DONE' && e.status !== 'FATAL') && (
                <Button size="sm" variant="ghost" onClick={pollAllFeeds} loading={polling}>
                  <RefreshCw className="w-3 h-3 mr-1" />Check
                </Button>
              )}
            </div>
          )}

          {/* Fetch from Amazon (visible when rows are selected) */}
          {selectedRows.size > 0 && (
            <div className="relative">
              <Button size="sm" variant="ghost" onClick={() => setFetchPanelOpen((o) => !o)} loading={fetching}
                className={fetchPanelOpen ? 'bg-slate-100 dark:bg-slate-800' : ''}>
                <ArrowDownToLine className="w-3.5 h-3.5 mr-1.5" />Fetch ({selectedRows.size})
              </Button>
              {fetchPanelOpen && (
                <FetchFromAmazonPanel selectedCount={selectedRows.size} currentMarket={marketplace}
                  onFetch={handleFetchFromAmazon} onClose={() => setFetchPanelOpen(false)} />
              )}
            </div>
          )}

          {/* Copy to market panel anchor */}
          {copyPanelOpen && manifest && rows.length > 0 && (
            <div className="relative">
              <CopyToMarketPanel manifest={manifest} rows={rows} currentMarket={marketplace}
                onCopy={handleCopyToMarket} onClose={() => setCopyPanelOpen(false)} />
            </div>
          )}

          {/* Separator before save/discard/submit */}
          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5 flex-shrink-0" />

          {/* Discard */}
          <Button size="sm" variant="ghost"
            onClick={handleDiscard}
            disabled={!dirtyRows.length || loading}
            className="text-slate-500 hover:text-red-600 dark:hover:text-red-400">
            Discard
          </Button>

          {/* Save */}
          <Button size="sm" variant="ghost"
            onClick={handleSave}
            disabled={loading}
            className={saveFlash ? 'text-emerald-600 dark:text-emerald-400' : ''}>
            {saveFlash ? <><CheckCircle2 className="w-3.5 h-3.5 mr-1" />Saved</> : 'Save'}
          </Button>

          {/* Submit to Amazon */}
          <div className="relative">
            <Button size="sm" onClick={() => setSubmitPanelOpen((o) => !o)}
              disabled={submitting || loading} loading={submitting}
              className={submitPanelOpen ? 'bg-blue-700' : ''}>
              <Send className="w-3.5 h-3.5 mr-1.5" />Submit to Amazon{dirtyRows.length > 0 && ` (${dirtyRows.length})`}
            </Button>
            {submitPanelOpen && (
              <SubmitToAmazonPanel currentMarket={marketplace} productType={productType}
                familyId={familyId} currentDirtyRows={dirtyRows}
                onSubmit={handleSubmitToMarkets} onClose={() => setSubmitPanelOpen(false)} />
            )}
          </div>
        </div>

        {/* ── Bar 2: Marketplace · Product type · Search ────── */}
        <div className="px-3 py-1.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 font-medium">Market</span>
            <div className="flex gap-0.5">
              {MARKETPLACES.map((mp) => (
                <button key={mp} type="button"
                  onClick={() => { setMarketplace(mp); void loadData(mp, productType) }}
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
            <ProductTypeDropdown value={productType} options={productTypes} loading={ptLoading || loading}
              onChange={(pt) => { setProductType(pt); void loadData(marketplace, pt) }} />
            {productType && (
              <Button size="sm" variant="ghost"
                onClick={() => void loadData(marketplace, productType, true)} loading={loading}
                title="Refresh schema from Amazon — updates columns/groups, keeps row edits">
                <RefreshCw className="w-3 h-3 mr-1" />Refresh schema
              </Button>
            )}
          </div>

          {/* Sort */}
          {manifest && rows.length > 0 && (
            <div className="relative">
              <Button size="sm" variant="ghost"
                onClick={() => setSortPanelOpen((o) => !o)}
                className={cn(sortConfig.length > 0 && 'text-blue-600 dark:text-blue-400 font-semibold', sortPanelOpen && 'bg-slate-100 dark:bg-slate-800')}>
                <SlidersHorizontal className="w-3 h-3 mr-1" />
                Sort{sortConfig.length > 0 && ` (${sortConfig.length})`}
              </Button>
              {sortPanelOpen && (
                <SortPanel
                  rows={rows}
                  groups={orderedGroups}
                  initial={sortConfig}
                  onApply={(levels) => { setSortConfig(levels); setSortPanelOpen(false) }}
                  onClose={() => setSortPanelOpen(false)}
                />
              )}
            </div>
          )}

          {/* Search */}
          {manifest && (
            <div className="flex items-center gap-1 ml-auto">
              <div className="relative flex items-center">
                <Search className="absolute left-2 w-3 h-3 text-slate-400 pointer-events-none" />
                <input ref={searchRef} type="text" value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setSearchQuery('')}
                  placeholder={searchMode === 'rows' ? 'Search rows…' : 'Search columns…'}
                  className="pl-6 pr-6 py-0.5 text-xs border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 w-44" />
                {searchQuery && (
                  <button onClick={() => setSearchQuery('')} className="absolute right-1.5 text-slate-400 hover:text-slate-600">
                    <X className="w-3 h-3" />
                  </button>
                )}
              </div>
              <div className="flex border border-slate-200 dark:border-slate-700 rounded-md overflow-hidden">
                <button type="button" onClick={() => setSearchMode('rows')}
                  className={cn('text-xs px-2 py-0.5 transition-colors', searchMode === 'rows'
                    ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900'
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800')}
                  title="Filter rows">Rows</button>
                <button type="button" onClick={() => setSearchMode('columns')}
                  className={cn('text-xs px-2 py-0.5 transition-colors border-l border-slate-200 dark:border-slate-700', searchMode === 'columns'
                    ? 'bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900'
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800')}
                  title="Filter columns">Cols</button>
              </div>
              {searchQuery && (
                <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">
                  {searchMode === 'rows' ? `${displayRows.length}/${rows.length}` : `${allColumns.length} col${allColumns.length !== 1 ? 's' : ''}`}
                </span>
              )}
            </div>
          )}

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
                    onClick={() => setClosedGroups((prev) => {
                      const n = new Set(prev)
                      open ? n.add(g.id) : n.delete(g.id)
                      try { localStorage.setItem('ff-closed-groups', JSON.stringify([...n])) } catch {}
                      return n
                    })}
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
              {(groupOrder.length > 0 || closedGroups.size > 0) && (
                <button type="button"
                  onClick={() => {
                    setGroupOrder([])
                    setClosedGroups(new Set())
                    try { localStorage.removeItem('ff-group-order'); localStorage.removeItem('ff-closed-groups') } catch {}
                  }}
                  className="text-xs text-slate-400 hover:text-slate-600 px-1"
                  title="Reset group order and visibility to Amazon's default">
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
                {/* Select-all checkbox + row# col (frozen) */}
                <th className="sticky left-0 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 w-9 min-w-[36px] text-center" rowSpan={3}>
                  <input
                    type="checkbox"
                    className="w-3.5 h-3.5 accent-blue-600"
                    checked={displayRows.length > 0 && selectedRows.size === displayRows.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedRows.size > 0 && selectedRows.size < displayRows.length
                    }}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedRows(new Set(displayRows.map((r) => r._rowId as string)))
                      } else {
                        setSelectedRows(new Set())
                      }
                    }}
                    title={selectedRows.size === displayRows.length ? 'Deselect all' : 'Select all'}
                  />
                </th>
                <th className="sticky left-9 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 w-7 min-w-[28px] text-xs text-slate-400 text-center font-normal" rowSpan={3}>#</th>

                {displayGroups.map((g) => {
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

              {/* Row 2: English column labels + column resize handles */}
              <tr>
                {allColumns.map((col) => {
                  const c = gColor(colToGroup.get(col.id)?.color ?? 'slate')
                  const w = colWidths[col.id] ?? col.width
                  return (
                    <th key={`en-${col.id}`}
                      style={{ minWidth: w, width: w }}
                      className={cn('relative px-2 py-0.5 text-left text-xs font-semibold border-b border-r border-slate-200 dark:border-slate-700 whitespace-nowrap select-none', c.text,
                        col.required && 'font-bold')}
                      title={col.description}>
                      {col.labelEn}{col.required && <span className="ml-0.5 text-red-500">*</span>}
                      {/* Resize handle — drag to resize, double-click to reset */}
                      <div
                        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize group/colresize flex items-center justify-center z-10"
                        onMouseDown={(e) => startColResize(e, col.id, w)}
                        onDoubleClick={() => setColWidths((p) => { const n = { ...p }; delete n[col.id]; return n })}
                        title="Drag to resize · Double-click to reset"
                      >
                        <div className="w-px h-3/4 rounded-full bg-slate-300/50 group-hover/colresize:bg-blue-400 dark:bg-slate-600/50 dark:group-hover/colresize:bg-blue-500 transition-colors" />
                      </div>
                    </th>
                  )
                })}
              </tr>

              {/* Row 3: Italian column labels + max-length hint */}
              <tr>
                {allColumns.map((col) => {
                  const w = colWidths[col.id] ?? col.width
                  return (
                    <th key={`it-${col.id}`}
                      style={{ minWidth: w, width: w }}
                      className="px-2 py-0.5 text-left text-xs font-normal border-b border-r border-slate-200 dark:border-slate-700 whitespace-nowrap text-slate-400 dark:text-slate-500 italic">
                      {col.labelLocal}
                      {col.maxLength != null && (
                        <span className="ml-1.5 not-italic font-mono text-[10px] text-slate-300 dark:text-slate-600">
                          max&nbsp;{col.maxLength}
                        </span>
                      )}
                    </th>
                  )
                })}
              </tr>
            </thead>

            <tbody>
              {displayRows.map((row, rowIdx) => (
                <SpreadsheetRow
                  key={row._rowId as string}
                  row={row}
                  rowIdx={rowIdx}
                  columns={allColumns}
                  colToGroup={colToGroup}
                  selected={selectedRows.has(row._rowId as string)}
                  activeCell={activeCell}
                  marketplace={marketplace}
                  colWidths={colWidths}
                  rowHeight={rowHeight}
                  isDraggingRow={draggingRowId === (row._rowId as string)}
                  dropIndicator={dropTarget?.rowId === (row._rowId as string) ? dropTarget.half : null}
                  onSelect={(checked) => setSelectedRows((prev) => { const n = new Set(prev); checked ? n.add(row._rowId as string) : n.delete(row._rowId as string); return n })}
                  onActivate={(colId) => setActiveCell({ rowId: row._rowId as string, colId })}
                  onDeactivate={() => setActiveCell(null)}
                  onChange={(colId, val) => updateCell(row._rowId as string, colId, val)}
                  onNavigate={(colId, dir) => navigate(row._rowId as string, colId, dir)}
                  onRowResizeStart={(e) => startRowResize(e, rowHeight)}
                  onRowDragStart={() => setDraggingRowId(row._rowId as string)}
                  onRowDragEnd={() => { setDraggingRowId(null); setDropTarget(null) }}
                  onRowDragOver={(half) => setDropTarget({ rowId: row._rowId as string, half })}
                  onRowDrop={(half) => draggingRowId && reorderRow(draggingRowId, row._rowId as string, half)}
                />
              ))}

              {/* Empty search result */}
              {searchQuery && searchMode === 'rows' && displayRows.length === 0 && (
                <tr>
                  <td colSpan={allColumns.length + 2} className="px-6 py-6 text-center text-sm text-slate-400 italic">
                    No rows match &ldquo;{searchQuery}&rdquo;
                  </td>
                </tr>
              )}

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
      {feedEntries.some((e) => e.results.length > 0) && (
        <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-3">
          {feedEntries.filter((e) => e.results.length > 0).map((e) => {
            const ok = e.results.filter((r) => r.status === 'success').length
            const err = e.results.filter((r) => r.status === 'error').length
            return (
              <div key={e.market} className="mb-2 last:mb-0">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  <span className="text-sm font-medium text-slate-700 dark:text-slate-300">
                    {e.market} — {ok} ok, {err} error{err !== 1 ? 's' : ''}
                  </span>
                </div>
                {err > 0 && (
                  <div className="max-h-24 overflow-y-auto text-xs space-y-0.5 pl-6">
                    {e.results.filter((r) => r.status === 'error').map((r) => (
                      <div key={r.sku} className="flex items-start gap-2 text-red-600 dark:text-red-400">
                        <X className="w-3 h-3 mt-0.5 flex-shrink-0" />
                        <span className="font-mono font-medium">{r.sku}</span>
                        <span>{r.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── SpreadsheetRow ─────────────────────────────────────────────────────

interface RowProps {
  row: Row; rowIdx: number; columns: Column[]; colToGroup: Map<string, ColumnGroup>
  selected: boolean; activeCell: { rowId: string; colId: string } | null
  marketplace: string
  colWidths: Record<string, number>
  rowHeight: number
  isDraggingRow: boolean
  dropIndicator: 'top' | 'bottom' | null
  onSelect: (c: boolean) => void; onActivate: (colId: string) => void
  onDeactivate: () => void; onChange: (colId: string, val: unknown) => void
  onNavigate: (colId: string, dir: 'right' | 'left' | 'down' | 'up') => void
  onRowResizeStart: (e: React.MouseEvent) => void
  onRowDragStart: () => void
  onRowDragEnd: () => void
  onRowDragOver: (half: 'top' | 'bottom') => void
  onRowDrop: (half: 'top' | 'bottom') => void
}

function SpreadsheetRow({ row, rowIdx, columns, colToGroup, selected, activeCell,
  marketplace, colWidths, rowHeight, isDraggingRow, dropIndicator,
  onSelect, onActivate, onDeactivate, onChange, onNavigate, onRowResizeStart,
  onRowDragStart, onRowDragEnd, onRowDragOver, onRowDrop }: RowProps) {
  const rowId = row._rowId as string
  const status = row._status
  const canDragRef = useRef(false)

  const rowBg = status === 'success' ? 'bg-emerald-50/70 dark:bg-emerald-950/20'
    : status === 'error' ? 'bg-red-50/70 dark:bg-red-950/20'
    : status === 'pending' ? 'bg-amber-50/70 dark:bg-amber-950/20'
    : row._isNew ? 'bg-sky-50/40 dark:bg-sky-950/10'
    : row._dirty ? 'bg-yellow-50/40 dark:bg-yellow-950/10'
    : ''

  return (
    <tr
      draggable
      onDragStart={(e) => {
        if (!canDragRef.current) { e.preventDefault(); return }
        e.dataTransfer.effectAllowed = 'move'
        onRowDragStart()
      }}
      onDragEnd={() => { canDragRef.current = false; onRowDragEnd() }}
      onDragOver={(e) => {
        e.preventDefault()
        const rect = e.currentTarget.getBoundingClientRect()
        onRowDragOver(e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom')
      }}
      onDrop={(e) => {
        e.preventDefault()
        const rect = e.currentTarget.getBoundingClientRect()
        onRowDrop(e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom')
      }}
      style={{
        borderTop: dropIndicator === 'top' ? '2px solid #3b82f6' : undefined,
        borderBottom: dropIndicator === 'bottom' ? '2px solid #3b82f6' : undefined,
      }}
      className={cn('group/row transition-colors', rowBg,
        isDraggingRow ? 'opacity-40' : 'hover:bg-white/60 dark:hover:bg-slate-800/40')}>
      {/* Checkbox — also the drag handle (mousedown initiates drag) */}
      <td
        className="sticky left-0 z-10 bg-inherit border-b border-r border-slate-200 dark:border-slate-700 px-1.5 w-9 text-center cursor-grab active:cursor-grabbing"
        onMouseDown={() => { canDragRef.current = true }}
        onMouseUp={() => { canDragRef.current = false }}
      >
        {status === 'success' ? <CheckCircle2 className="w-3 h-3 text-emerald-500 mx-auto" />
          : status === 'error' ? <span title={row._feedMessage as string | undefined}><AlertCircle className="w-3 h-3 text-red-500 mx-auto" /></span>
          : status === 'pending' ? <Loader2 className="w-3 h-3 text-amber-500 animate-spin mx-auto" />
          : <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} className="w-3.5 h-3.5 accent-blue-600" />}
      </td>
      {/* Row # + ASIN badge + row-height resize handle */}
      <td className="sticky left-9 z-10 bg-inherit border-b border-r border-slate-200 dark:border-slate-700 px-1 w-7 min-w-[28px] relative group/rowresize">
        <div className="flex flex-col items-end gap-0.5" style={{ height: rowHeight, justifyContent: 'center' }}>
          <span className="text-xs text-slate-400 tabular-nums">{rowIdx + 1}</span>
          {row._asin ? (() => {
            const asin = String(row._asin)
            const domain = AMAZON_DOMAIN[marketplace] ?? 'amazon.com'
            return (
              <a
                href={`https://www.${domain}/dp/${asin}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[9px] font-mono text-blue-500 hover:text-blue-700 hover:underline leading-none"
                title={`ASIN: ${asin} — open on ${domain}`}
                onClick={(e) => e.stopPropagation()}
              >{asin}</a>
            )
          })() : null}
        </div>
        {/* Row height resize handle at the bottom edge */}
        <div
          className="absolute bottom-0 left-0 right-0 h-1.5 cursor-row-resize flex items-end justify-center pb-px opacity-0 group-hover/rowresize:opacity-100 transition-opacity"
          onMouseDown={onRowResizeStart}
          title="Drag to resize rows"
        >
          <div className="w-4 h-px rounded-full bg-blue-400" />
        </div>
      </td>

      {/* Data cells */}
      {columns.map((col) => {
        const isActive = activeCell?.rowId === rowId && activeCell?.colId === col.id
        const groupColor = colToGroup.get(col.id)?.color ?? 'slate'
        const w = colWidths[col.id] ?? col.width
        return (
          <SpreadsheetCell key={col.id} col={col} value={row[col.id]} isActive={isActive}
            cellBg={gColor(groupColor).cell}
            width={w}
            cellHeight={rowHeight}
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
  width: number
  cellHeight: number
  onActivate: () => void; onDeactivate: () => void
  onChange: (val: unknown) => void
  onNavigate: (dir: 'right' | 'left' | 'down' | 'up') => void
}

function SpreadsheetCell({ col, value, isActive, cellBg, width, cellHeight, onActivate, onDeactivate, onChange, onNavigate }: CellProps) {
  const displayValue = value != null ? String(value) : ''
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [liveLen, setLiveLen] = useState(displayValue.length)

  useEffect(() => {
    if (isActive && col.kind !== 'enum' && inputRef.current) {
      inputRef.current.focus()
      if ('select' in inputRef.current) (inputRef.current as HTMLInputElement).select()
    }
  }, [isActive, col.kind])

  // Reset counter to committed value length each time cell becomes active
  useEffect(() => { if (isActive) setLiveLen(displayValue.length) }, [isActive])

  const isEmpty = !displayValue
  const cellStyle = { minWidth: width, width }
  const hStyle = { height: cellHeight }

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
      <td className={baseCls} style={cellStyle}
        onClick={() => { onActivate(); setDropdownOpen(true) }}>
        <div className="px-1.5 flex items-center justify-between gap-1 cursor-pointer group/cell" style={hStyle}>
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
      const atLimit = col.maxLength != null && liveLen >= col.maxLength
      const nearLimit = col.maxLength != null && liveLen >= col.maxLength * 0.8
      return (
        <td className={baseCls} style={cellStyle}>
          <textarea ref={inputRef as any} defaultValue={displayValue}
            onInput={(e) => setLiveLen((e.target as HTMLTextAreaElement).value.length)}
            onBlur={(e) => { onChange(e.target.value); onDeactivate() }}
            onKeyDown={handleKeyDown}
            maxLength={col.maxLength}
            className="w-full px-1.5 py-1 text-xs bg-white dark:bg-slate-800 focus:outline-none text-slate-800 dark:text-slate-200 resize-none"
            style={{ minWidth: width, minHeight: Math.max(cellHeight, 60) }} />
          {col.maxLength != null && (
            <div className={cn('absolute bottom-1 right-1.5 text-[9px] tabular-nums font-mono pointer-events-none select-none',
              atLimit ? 'text-red-500 dark:text-red-400 font-bold'
              : nearLimit ? 'text-amber-500 dark:text-amber-400'
              : 'text-slate-300 dark:text-slate-600')}>
              {liveLen}/{col.maxLength}
            </div>
          )}
        </td>
      )
    }
    return (
      <td className={cn(baseCls, 'cursor-pointer hover:bg-white/50 dark:hover:bg-slate-700/30')}
        style={cellStyle} onClick={onActivate}>
        <div className="px-1.5 flex items-center text-xs text-slate-800 dark:text-slate-200 truncate" style={hStyle}>
          {displayValue || <span className="text-slate-300 dark:text-slate-600 italic">{col.required ? '⚠ required' : ''}</span>}
        </div>
      </td>
    )
  }

  // Text / number cell
  if (isActive) {
    const atLimit = col.maxLength != null && liveLen >= col.maxLength
    const nearLimit = col.maxLength != null && liveLen >= col.maxLength * 0.8
    return (
      <td className={baseCls} style={cellStyle}>
        <input ref={inputRef as any} type={col.kind === 'number' ? 'number' : 'text'}
          defaultValue={displayValue} maxLength={col.maxLength}
          onInput={(e) => setLiveLen((e.target as HTMLInputElement).value.length)}
          onBlur={(e) => { onChange(e.target.value); onDeactivate() }}
          onKeyDown={handleKeyDown}
          className="w-full px-1.5 text-xs bg-white dark:bg-slate-800 focus:outline-none text-slate-800 dark:text-slate-200"
          style={hStyle} />
        {col.maxLength != null && (
          <div className={cn('absolute bottom-0.5 right-1 text-[9px] tabular-nums font-mono pointer-events-none select-none leading-none',
            atLimit ? 'text-red-500 dark:text-red-400 font-bold'
            : nearLimit ? 'text-amber-500 dark:text-amber-400'
            : 'text-slate-300 dark:text-slate-600')}>
            {liveLen}/{col.maxLength}
          </div>
        )}
      </td>
    )
  }

  return (
    <td className={cn(baseCls, 'cursor-pointer hover:bg-white/50 dark:hover:bg-slate-700/30')}
      style={cellStyle} onClick={onActivate} title={col.description}>
      <div className={cn('px-1.5 flex items-center text-xs truncate',
        isEmpty ? (col.required ? 'text-red-400 dark:text-red-500 italic' : 'text-slate-300 dark:text-slate-600') : 'text-slate-800 dark:text-slate-200')}
        style={hStyle}>
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

// ── FetchFromAmazonPanel ───────────────────────────────────────────────
// Lets the user pull selected fields from Amazon for the selected rows.
// Current market is pre-selected; other markets can be ticked to save time.

const ALL_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK']
const AMAZON_DOMAIN: Record<string, string> = {
  IT: 'amazon.it', DE: 'amazon.de', FR: 'amazon.fr',
  ES: 'amazon.es', UK: 'amazon.co.uk',
}

interface FetchPanelProps {
  selectedCount: number
  currentMarket: string
  onFetch: (markets: string[]) => void
  onClose: () => void
}

function FetchFromAmazonPanel({ selectedCount, currentMarket, onFetch, onClose }: FetchPanelProps) {
  const [markets, setMarkets] = useState<Set<string>>(() => new Set([currentMarket]))
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [onClose])

  function toggleMarket(mp: string) {
    setMarkets((prev) => {
      const n = new Set(prev)
      n.has(mp) ? n.delete(mp) : n.add(mp)
      return n
    })
  }

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full mt-1 z-50 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
            Fetch from Amazon
          </div>
          <div className="text-xs text-slate-400">
            {selectedCount} SKU{selectedCount !== 1 ? 's' : ''} selected
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* What to fetch */}
      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">
        <div className="text-xs font-medium text-slate-500 mb-2">What to fetch</div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked readOnly className="w-3.5 h-3.5 accent-blue-600" />
          <span className="text-xs text-slate-700 dark:text-slate-300 font-medium">ASIN</span>
          <span className="text-xs text-slate-400">Amazon's assigned identifier</span>
        </label>
        <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
          ASINs are assigned by Amazon after publishing. The ASIN will appear
          as a clickable link on each row, opening the Amazon listing directly.
        </p>
      </div>

      {/* Markets */}
      <div className="px-4 py-3">
        <div className="text-xs font-medium text-slate-500 mb-2">Markets</div>
        <div className="flex flex-wrap gap-1.5">
          {ALL_MARKETS.map((mp) => {
            const isCurrent = mp === currentMarket
            const checked = markets.has(mp)
            return (
              <button
                key={mp}
                type="button"
                onClick={() => toggleMarket(mp)}
                className={cn(
                  'text-xs font-medium px-2.5 py-1 rounded border transition-colors',
                  checked
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-blue-400',
                )}
              >
                {mp}{isCurrent && <span className="ml-1 opacity-70 text-[10px]">current</span>}
              </button>
            )
          })}
        </div>
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800">
        <Button
          size="sm"
          className="w-full justify-center"
          onClick={() => onFetch([...markets])}
          disabled={markets.size === 0}
        >
          <ArrowDownToLine className="w-3.5 h-3.5 mr-1.5" />
          Fetch {selectedCount} SKU{selectedCount !== 1 ? 's' : ''}
          {markets.size > 1 ? ` × ${markets.size} markets` : ` (${[...markets][0]})`}
        </Button>
      </div>
    </div>
  )
}

// ── SubmitToAmazonPanel ────────────────────────────────────────────────
// Market selector for multi-market submit. Shows dirty row count per
// market (current market from state, others from localStorage draft).

interface SubmitPanelProps {
  currentMarket: string
  productType: string
  familyId?: string
  currentDirtyRows: Row[]
  onSubmit: (markets: Set<string>) => void
  onClose: () => void
}

function SubmitToAmazonPanel({
  currentMarket, productType, familyId, currentDirtyRows, onSubmit, onClose,
}: SubmitPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set([currentMarket]))
  const [counts, setCounts] = useState<Record<string, number>>({})
  const panelRef = useRef<HTMLDivElement>(null)

  // Compute dirty-row counts per market from localStorage (non-current markets)
  useEffect(() => {
    const out: Record<string, number> = {}
    for (const mp of ALL_MARKETS) {
      if (mp === currentMarket) { out[mp] = currentDirtyRows.length; continue }
      try {
        const key = familyId
          ? `ff-rows-${mp.toUpperCase()}-${productType.toUpperCase()}-family-${familyId}`
          : `ff-rows-${mp.toUpperCase()}-${productType.toUpperCase()}`
        const saved: Row[] = JSON.parse(localStorage.getItem(key) ?? '[]')
        out[mp] = saved.filter((r) => r._dirty || r._isNew).length
      } catch { out[mp] = 0 }
    }
    setCounts(out)
  }, [currentMarket, productType, familyId, currentDirtyRows.length])

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [onClose])

  function toggle(mp: string) {
    setSelected((prev) => { const n = new Set(prev); n.has(mp) ? n.delete(mp) : n.add(mp); return n })
  }

  const totalRows = [...selected].reduce((s, mp) => s + (counts[mp] ?? 0), 0)

  return (
    <div
      ref={panelRef}
      className="absolute right-0 top-full mt-1 z-50 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">Submit to Amazon</div>
          <div className="text-xs text-slate-400">Select which markets to submit</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
      </div>

      <div className="px-4 py-3 space-y-2.5">
        {ALL_MARKETS.map((mp) => {
          const count = counts[mp] ?? 0
          const isCurrent = mp === currentMarket
          const checked = selected.has(mp)
          return (
            <label key={mp} className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(mp)}
                className="w-3.5 h-3.5 accent-blue-600 flex-shrink-0"
              />
              <span className="text-sm font-medium text-slate-700 dark:text-slate-300 flex-1">
                {mp}
                {isCurrent && <span className="ml-1.5 text-xs font-normal text-slate-400">current</span>}
              </span>
              <span className={cn(
                'text-xs tabular-nums px-1.5 py-0.5 rounded font-medium',
                count > 0
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                  : 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-600',
              )}>
                {count} unsaved
              </span>
            </label>
          )
        })}
      </div>

      <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
        <div className="text-xs text-slate-400">
          {totalRows} row{totalRows !== 1 ? 's' : ''} · {selected.size} market{selected.size !== 1 ? 's' : ''}
        </div>
        <Button
          size="sm"
          onClick={() => onSubmit(selected)}
          disabled={selected.size === 0 || totalRows === 0}
        >
          <Send className="w-3.5 h-3.5 mr-1.5" />Submit
        </Button>
      </div>
    </div>
  )
}

// ── MenuDropdown ───────────────────────────────────────────────────────
// Generic menu-bar dropdown. Items can have icons, shortcuts, separators.

interface MenuItem {
  label?: string
  icon?: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  shortcut?: string
  separator?: boolean
}

interface MenuDropdownProps {
  label: string
  items: MenuItem[]
}

function MenuDropdown({ label, items }: MenuDropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'h-7 px-2.5 text-xs font-medium rounded transition-colors',
          open
            ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100',
        )}
      >
        {label}
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-0.5 z-50 w-52 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 overflow-hidden">
          {items.map((item, i) =>
            item.separator ? (
              <div key={i} className="my-1 border-t border-slate-100 dark:border-slate-800" />
            ) : (
              <button
                key={i}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  if (!item.disabled && item.onClick) { item.onClick(); setOpen(false) }
                }}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-1.5 text-xs text-left transition-colors',
                  item.disabled
                    ? 'text-slate-300 dark:text-slate-600 cursor-default'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                )}
              >
                {item.icon && <span className="w-3.5 h-3.5 flex-shrink-0 flex items-center">{item.icon}</span>}
                <span className="flex-1">{item.label}</span>
                {item.shortcut && <span className="text-[10px] font-mono text-slate-400">{item.shortcut}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  )
}

// ── SortPanel ──────────────────────────────────────────────────────────
// Multi-level custom sort panel. Each level targets one column and can
// be A→Z, Z→A, or a fully custom value order (drag to reorder values).

interface SortPanelProps {
  rows: Row[]
  groups: ColumnGroup[]
  initial: SortLevel[]
  onApply: (levels: SortLevel[]) => void
  onClose: () => void
}

function SortPanel({ rows, groups, initial, onApply, onClose }: SortPanelProps) {
  const [levels, setLevels] = useState<SortLevel[]>(initial)
  const [draggingLevelId, setDraggingLevelId] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const allCols = useMemo(() => groups.flatMap((g) => g.columns), [groups])

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [onClose])

  function uniqueVals(colId: string): string[] {
    const seen = new Set<string>()
    for (const row of rows) {
      const v = String(row[colId] ?? '').trim()
      if (v) seen.add(v)
    }
    return [...seen].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  }

  function addLevel() {
    const first = allCols[0]
    if (!first) return
    setLevels((prev) => [
      ...prev,
      { id: Math.random().toString(36).slice(2), colId: first.id, mode: 'asc', customOrder: [] },
    ])
  }

  function removeLevel(id: string) {
    setLevels((prev) => prev.filter((l) => l.id !== id))
  }

  function changeCol(id: string, colId: string) {
    setLevels((prev) => prev.map((l) => l.id === id ? { ...l, colId, mode: 'asc', customOrder: [] } : l))
  }

  function changeMode(id: string, mode: SortLevel['mode']) {
    setLevels((prev) => prev.map((l) => {
      if (l.id !== id) return l
      return { ...l, mode, customOrder: mode === 'custom' ? uniqueVals(l.colId) : l.customOrder }
    }))
  }

  function reorderValues(levelId: string, fromIdx: number, toIdx: number) {
    setLevels((prev) => prev.map((l) => {
      if (l.id !== levelId) return l
      const next = [...l.customOrder]
      const [item] = next.splice(fromIdx, 1)
      next.splice(toIdx, 0, item)
      return { ...l, customOrder: next }
    }))
  }

  function reorderLevels(fromId: string, toId: string) {
    setLevels((prev) => {
      const from = prev.findIndex((l) => l.id === fromId)
      const to   = prev.findIndex((l) => l.id === toId)
      const next = [...prev]
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      return next
    })
  }

  return (
    <div ref={panelRef}
      className="absolute left-0 top-full mt-1 z-50 w-[430px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden">

      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">Sort rows</div>
          <div className="text-xs text-slate-400">Levels applied top → bottom. Drag ⠿ to reprioritize.</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
      </div>

      {/* Levels */}
      <div className="max-h-[60vh] overflow-y-auto">
        {levels.length === 0 && (
          <p className="px-4 py-6 text-center text-xs text-slate-400 italic">No sort levels — add one below.</p>
        )}
        {levels.map((level, i) => (
          <div
            key={level.id}
            draggable
            onDragStart={(e) => { setDraggingLevelId(level.id); e.dataTransfer.effectAllowed = 'move' }}
            onDragEnd={() => setDraggingLevelId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              if (draggingLevelId && draggingLevelId !== level.id) reorderLevels(draggingLevelId, level.id)
              setDraggingLevelId(null)
            }}
            className={cn('border-b border-slate-100 dark:border-slate-800 last:border-0', draggingLevelId === level.id && 'opacity-40')}
          >
            {/* Level row */}
            <div className="flex items-center gap-2 px-3 py-2.5">
              <GripVertical className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600 cursor-grab flex-shrink-0" />
              <span className="text-[10px] font-mono text-slate-400 w-3 text-center flex-shrink-0">{i + 1}</span>

              {/* Column picker */}
              <select
                value={level.colId}
                onChange={(e) => changeCol(level.id, e.target.value)}
                className="flex-1 min-w-0 text-xs border border-slate-200 dark:border-slate-700 rounded px-1.5 py-0.5 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                {groups.map((g) => (
                  <optgroup key={g.id} label={g.labelEn || g.labelLocal}>
                    {g.columns.map((c) => (
                      <option key={c.id} value={c.id}>{c.labelEn || c.id}</option>
                    ))}
                  </optgroup>
                ))}
              </select>

              {/* Mode toggle */}
              <div className="flex border border-slate-200 dark:border-slate-700 rounded overflow-hidden flex-shrink-0">
                {(['asc', 'desc', 'custom'] as const).map((m, mi) => (
                  <button key={m} type="button" onClick={() => changeMode(level.id, m)}
                    className={cn('text-[10px] px-1.5 py-0.5 transition-colors',
                      mi > 0 && 'border-l border-slate-200 dark:border-slate-700',
                      level.mode === m
                        ? 'bg-blue-500 text-white'
                        : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
                    )}>
                    {m === 'asc' ? 'A→Z' : m === 'desc' ? 'Z→A' : 'Custom'}
                  </button>
                ))}
              </div>

              <button type="button" onClick={() => removeLevel(level.id)}
                className="text-slate-300 hover:text-red-400 dark:text-slate-600 dark:hover:text-red-400 flex-shrink-0">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Custom value list */}
            {level.mode === 'custom' && (
              <div className="mx-3 mb-2.5 rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden">
                <div className="px-2 py-1 bg-slate-50 dark:bg-slate-800/60 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
                  <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400">Custom order — drag to arrange</span>
                  <span className="text-[10px] text-slate-400 tabular-nums">{level.customOrder.length} values</span>
                </div>
                {level.customOrder.length === 0
                  ? <p className="px-3 py-2 text-xs text-slate-400 italic text-center">No values in current rows for this column.</p>
                  : <DraggableValueList
                      values={level.customOrder}
                      onReorder={(from, to) => reorderValues(level.id, from, to)}
                    />
                }
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-slate-100 dark:border-slate-800 flex items-center gap-2">
        <button type="button" onClick={addLevel} disabled={allCols.length === 0}
          className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 font-medium disabled:opacity-40">
          + Add sort level
        </button>
        <div className="flex-1" />
        {levels.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => { setLevels([]); onApply([]) }}>Reset</Button>
        )}
        <Button size="sm" onClick={() => onApply(levels)} disabled={levels.length === 0}>
          Apply sort
        </Button>
      </div>
    </div>
  )
}

// ── DraggableValueList ─────────────────────────────────────────────────
// Reorderable list of unique field values used inside the Sort panel's
// custom-order mode.

function DraggableValueList({
  values, onReorder,
}: { values: string[]; onReorder: (from: number, to: number) => void }) {
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null)
  return (
    <div className="max-h-40 overflow-y-auto">
      {values.map((val, i) => (
        <div
          key={`${val}-${i}`}
          draggable
          onDragStart={(e) => { setDraggingIdx(i); e.dataTransfer.effectAllowed = 'move' }}
          onDragEnd={() => setDraggingIdx(null)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            if (draggingIdx !== null && draggingIdx !== i) onReorder(draggingIdx, i)
            setDraggingIdx(null)
          }}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 cursor-grab select-none transition-colors',
            draggingIdx === i ? 'opacity-40' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50',
          )}
        >
          <GripVertical className="w-3 h-3 text-slate-300 dark:text-slate-600 flex-shrink-0" />
          <span className="text-xs text-slate-700 dark:text-slate-300 flex-1 truncate">
            {val || <span className="italic text-slate-400">empty</span>}
          </span>
          <span className="text-[9px] font-mono text-slate-300 dark:text-slate-600 flex-shrink-0">#{i + 1}</span>
        </div>
      ))}
    </div>
  )
}


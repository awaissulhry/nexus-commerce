'use client'

import {
  useCallback, useEffect, useRef, useState, useMemo,
  type KeyboardEvent,
} from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  ClipboardPaste, Clock, Copy, Download, FileSpreadsheet, History, Image as ImageIcon, Loader2, Pin, Plus, RefreshCw,
  Search, Send, Trash2, Upload, X, ArrowDownToLine, ArrowRightLeft,
  Undo2, Redo2, GripVertical, SlidersHorizontal, Replace, Sparkles,
} from 'lucide-react'
import { FindReplaceBar } from '@/app/bulk-operations/components/FindReplaceBar'
import { ConditionalFormatBar } from '@/app/bulk-operations/components/ConditionalFormatBar'
import { evaluateRule, TONE_CLASSES, type ConditionalRule } from '@/app/bulk-operations/lib/conditional-format'
import { type FindCell } from '@/app/bulk-operations/lib/find-replace'
import { FFFilterPanel, FF_FILTER_DEFAULT, type FFFilterState } from './FFFilterPanel'
import { AIBulkModal } from './AIBulkModal'
import { FFSavedViews, type FFViewState } from './FFSavedViews'
import { FFReplicateModal } from './FFReplicateModal'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { ChannelStrip } from '../ebay-flat-file/ChannelStrip'
import { OverrideBadge } from '../_shared/OverrideBadge'

// ── Types ──────────────────────────────────────────────────────────────

interface NormSel { rMin: number; rMax: number; cMin: number; cMax: number }

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
  /** true → must pick from list; false/undefined → combobox (free text allowed) */
  selectionOnly?: boolean
  /** Which parentage levels this field applies to (undefined = all) */
  applicableParentage?: string[]
  /** Usage level from Amazon schema: REQUIRED / RECOMMENDED / OPTIONAL */
  guidance?: string
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

interface SubmissionRecord {
  id: string            // feedId
  market: string
  productType: string
  submittedAt: string   // ISO
  rowCount: number
  status: 'IN_QUEUE' | 'PROCESSING' | 'DONE' | 'FATAL'
  successCount?: number
  errorCount?: number
  results?: Array<{ sku: string; status: string; message: string }>
  dryRun?: boolean
}

interface VersionRecord {
  id: string
  label: string         // e.g. "Manual save", "Before submit · IT"
  savedAt: string       // ISO
  rowCount: number
  rows: Row[]
}

interface ValueMapping {
  match: string | null
  confidence: 'high' | 'medium' | 'low' | 'none'
  valid: boolean
}

interface TranslateResult {
  colLabel: string
  mappings: Record<string, Record<string, ValueMapping>>
  targetOptions: Record<string, string[]>
  errors: Record<string, string>
}

interface ValidationIssue { level: 'error' | 'warn'; msg: string }

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

// ── Storage key helpers ────────────────────────────────────────────────

function submissionHistoryKey(mp: string, pt: string) {
  return `ff-submissions-${mp.toUpperCase()}-${pt.toUpperCase()}`
}

function versionHistoryKey(mp: string, pt: string) {
  return `ff-versions-${mp.toUpperCase()}-${pt.toUpperCase()}`
}

// ── ASIN cache helpers ─────────────────────────────────────────────────

function asinCacheKey(mp: string) {
  return `ff-asin-cache-${mp.toUpperCase()}`
}

function readAsinCache(mp: string): Record<string, { asin?: string; status?: string }> {
  try { return JSON.parse(localStorage.getItem(asinCacheKey(mp)) ?? '{}') } catch { return {} }
}

function writeAsinCache(mp: string, entries: Record<string, { asin?: string; status?: string }>) {
  try {
    const existing = readAsinCache(mp)
    localStorage.setItem(asinCacheKey(mp), JSON.stringify({ ...existing, ...entries }))
  } catch { /* quota */ }
}

function mergeAsinCache(rows: Row[], mp: string): Row[] {
  const cache = readAsinCache(mp)
  if (!Object.keys(cache).length) return rows
  return rows.map((row) => {
    const sku = String(row.item_sku ?? '')
    const cached = sku ? cache[sku] : undefined
    if (!cached) return row
    return {
      ...row,
      ...(cached.asin ? { _asin: cached.asin } : {}),
      ...(cached.status ? { _listingStatus: cached.status } : {}),
    }
  })
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
  // Always start from the canonical DB state (SSR initialRows). If localStorage
  // has dirty rows from a previous session we surface a restore banner instead
  // of silently loading stale data — this ensures the flat file always opens
  // showing what is actually in the DB.
  // ── Per-market storage keys ────────────────────────────────────────────
  const mp = initialMarketplace.toUpperCase()
  const rowOrderKey = `ff-amazon-${mp}-row-order`
  const sortKey     = `ff-amazon-${mp}-sort`

  // ── Market sync state ──────────────────────────────────────────────────
  // Each market has a boolean: when true it receives auto-propagation from
  // other markets. Default=true. Once set false it stays false until the
  // user manually re-enables it — we never auto-reset to true.
  const SYNC_STATE_KEY = 'ff-amazon-market-sync'
  const ALL_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK'] as const
  const [marketSync, setMarketSync] = useState<Record<string, boolean>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SYNC_STATE_KEY) ?? '{}') as Record<string, boolean>
      const result: Record<string, boolean> = {}
      for (const m of ALL_MARKETS) result[m] = m in saved ? saved[m] : true
      return result
    } catch {
      return Object.fromEntries(ALL_MARKETS.map((m) => [m, true])) as Record<string, boolean>
    }
  })
  const marketSyncRef = useRef(marketSync)
  useEffect(() => { marketSyncRef.current = marketSync }, [marketSync])
  useEffect(() => {
    try { localStorage.setItem(SYNC_STATE_KEY, JSON.stringify(marketSync)) } catch {}
  }, [marketSync])

  const [applyPanelOpen, setApplyPanelOpen] = useState(false)

  function applyOrderToMarkets(targets: string[]) {
    const ids = rows.map((r) => r._rowId as string)
    for (const m of targets) {
      try { localStorage.setItem(`ff-amazon-${m}-row-order`, JSON.stringify(ids)) } catch {}
      try { localStorage.setItem(`ff-amazon-${m}-sort`, JSON.stringify(sortConfig)) } catch {}
    }
  }

  function toggleMarketSync(market: string) {
    setMarketSync((prev) => ({ ...prev, [market]: !prev[market] }))
  }

  // Propagate a row order (_rowId[]) to every market that has sync=true.
  // Never writes to the current market (caller handles that separately).
  function propagateRowOrder(ids: string[]) {
    if (!marketSyncRef.current[mp]) return
    for (const m of ALL_MARKETS) {
      if (m === mp || !marketSyncRef.current[m]) continue
      try { localStorage.setItem(`ff-amazon-${m}-row-order`, JSON.stringify(ids)) } catch {}
    }
  }
  function propagateSort(levels: SortLevel[]) {
    if (!marketSyncRef.current[mp]) return
    for (const m of ALL_MARKETS) {
      if (m === mp || !marketSyncRef.current[m]) continue
      try { localStorage.setItem(`ff-amazon-${m}-sort`, JSON.stringify(levels)) } catch {}
    }
  }

  const [rows, setRows] = useState<Row[]>(() => {
    const merged = mergeAsinCache(initialRows, initialMarketplace)
    try {
      // Try per-market key first, fall back to legacy shared key for migration
      const raw = localStorage.getItem(rowOrderKey) ?? localStorage.getItem('ff-amazon-row-order')
      const saved: string[] | null = JSON.parse(raw ?? 'null')
      if (Array.isArray(saved) && saved.length > 0) {
        const orderMap = new Map(saved.map((id, i) => [id, i]))
        const inOrder = merged.filter((r) => orderMap.has(r._rowId as string))
        inOrder.sort((a, b) => orderMap.get(a._rowId as string)! - orderMap.get(b._rowId as string)!)
        const notInOrder = merged.filter((r) => !orderMap.has(r._rowId as string))
        return [...inOrder, ...notInOrder]
      }
    } catch {}
    return merged
  })
  // Non-null when localStorage has a draft with unsaved edits that differ from
  // the DB rows loaded on this page open.
  const [draftBanner, setDraftBanner] = useState<Row[] | null>(null)

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

  const [sortConfig, setSortConfig] = useState<SortLevel[]>(() => {
    try {
      const raw = localStorage.getItem(sortKey) ?? localStorage.getItem('ff-amazon-sort')
      return JSON.parse(raw ?? '[]')
    } catch { return [] }
  })
  const [sortPanelOpen, setSortPanelOpen] = useState(false)
  useEffect(() => {
    try { localStorage.setItem(sortKey, JSON.stringify(sortConfig)) } catch {}
    propagateSort(sortConfig)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortConfig])

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMode, setSearchMode] = useState<'rows' | 'columns'>('rows')
  const searchRef = useRef<HTMLInputElement>(null)

  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [activeCell, setActiveCell] = useState<{ rowId: string; colId: string } | null>(null)
  const [selAnchor, setSelAnchor] = useState<{ ri: number; ci: number } | null>(null)
  const [selEnd,    setSelEnd]    = useState<{ ri: number; ci: number } | null>(null)
  const [isFillDragging, setIsFillDragging] = useState(false)
  const [fillDragEnd,    setFillDragEnd]    = useState<{ ri: number; ci: number } | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editInitialChar, setEditInitialChar] = useState<string | null>(null)
  const [clipboardRange, setClipboardRange] = useState<NormSel | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [addRowsPanel, setAddRowsPanel] = useState<{
    type: 'row' | 'parent' | 'variant'
    position: 'end' | 'above' | 'below'
  } | null>(null)
  const [smartPasteEnabled, setSmartPasteEnabled] = useState(() => {
    try { return localStorage.getItem('ff-smart-paste') === '1' } catch { return false }
  })

  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set())
  const [frozenColCount, setFrozenColCount] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('ff-frozen-cols') ?? '1', 10) || 1 } catch { return 1 }
  })
  const [showValidPanel, setShowValidPanel] = useState(false)
  const [showRowImages, setShowRowImages] = useState<boolean>(() => {
    try { return localStorage.getItem('ff-show-images') === '1' } catch { return false }
  })
  const [imageSize, setImageSize] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('ff-image-size') ?? '48', 10) || 48 } catch { return 48 }
  })
  const [imagesByAsin, setImagesByAsin] = useState<Record<string, string | null>>(() => {
    try {
      const raw = localStorage.getItem('ff-images-cache')
      return raw ? JSON.parse(raw) : {}
    } catch { return {} }
  })
  const [pushPanel, setPushPanel] = useState<{ tab: 'copy' | 'translate'; preselectedCol?: Column } | null>(null)

  const [feedEntries, setFeedEntries] = useState<FeedEntry[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [polling, setPolling] = useState(false)
  const [submitPanelOpen, setSubmitPanelOpen] = useState(false)
  const [submissionHistory, setSubmissionHistory] = useState<SubmissionRecord[]>([])
  const [submissionPanelOpen, setSubmissionPanelOpen] = useState(false)
  const [versionPanelOpen, setVersionPanelOpen] = useState(false)

  // BF.1 — Find & Replace
  const [findReplaceOpen, setFindReplaceOpen] = useState(false)
  const [matchKeys, setMatchKeys] = useState<Set<string>>(new Set())

  // BF.2 — Conditional formatting
  const [cfRules, setCfRules] = useState<ConditionalRule[]>([])
  const [cfOpen, setCfOpen] = useState(false)

  // BF.3 — Extended row filter
  const [ffFilter, setFFFilter] = useState<FFFilterState>(FF_FILTER_DEFAULT)
  const [filterPanelOpen, setFilterPanelOpen] = useState(false)

  // BF.4 — AI bulk actions
  const [aiModalOpen, setAiModalOpen] = useState(false)

  // BM.2 — Replicate modal
  const [replicateOpen, setReplicateOpen] = useState(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

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

  // Tracks the anchor row when user drags on the # column to select rows
  const rowDragRef = useRef<number | null>(null)

  // ── Undo / Redo ────────────────────────────────────────────────────
  const rowsRef = useRef<Row[]>(rows)
  useEffect(() => { rowsRef.current = rows }, [rows])

  // On mount: if localStorage has a draft with dirty rows from a previous
  // session, offer to restore it rather than silently discarding it.
  useEffect(() => {
    if (!initialProductType) return
    try {
      const base = `ff-rows-${initialMarketplace.toUpperCase()}-${initialProductType.toUpperCase()}`
      const key = familyId ? `${base}-family-${familyId}` : base
      const raw = localStorage.getItem(key)
      if (!raw) return
      const saved = JSON.parse(raw) as Row[]
      if (Array.isArray(saved) && saved.length > 0 && saved.some((r) => r._dirty)) {
        setDraftBanner(saved)
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const displayRowsRef = useRef<Row[]>([])
  const allColumnsRef = useRef<Column[]>([])
  const selAnchorRef = useRef<{ ri: number; ci: number } | null>(null)
  const selEndRef = useRef<{ ri: number; ci: number } | null>(null)
  const isEditingRef = useRef(false)

  useEffect(() => { selAnchorRef.current = selAnchor }, [selAnchor])
  useEffect(() => { selEndRef.current = selEnd }, [selEnd])
  useEffect(() => { isEditingRef.current = isEditing }, [isEditing])
  useEffect(() => { try { localStorage.setItem('ff-smart-paste', smartPasteEnabled ? '1' : '0') } catch {} }, [smartPasteEnabled])

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

  // Persist resize state to localStorage
  useEffect(() => { try { localStorage.setItem('ff-col-widths', JSON.stringify(colWidths)) } catch {} }, [colWidths])
  useEffect(() => { try { localStorage.setItem('ff-row-height', String(rowHeight)) } catch {} }, [rowHeight])
  useEffect(() => { try { localStorage.setItem('ff-frozen-cols', String(frozenColCount)) } catch {} }, [frozenColCount])

  // Persist image preferences
  useEffect(() => { try { localStorage.setItem('ff-show-images', showRowImages ? '1' : '0') } catch {} }, [showRowImages])
  useEffect(() => { try { localStorage.setItem('ff-image-size', String(imageSize)) } catch {} }, [imageSize])

  // Auto row height when images toggled on or size changed
  useEffect(() => {
    if (showRowImages) {
      // Row # always visible (12px) + image + padding; ASIN + status add ~28px for M/L/XL
      const asinExtra = imageSize >= 48 ? 28 : 0
      setRowHeight(imageSize + 24 + asinExtra)
    }
  }, [showRowImages, imageSize])

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
  useEffect(() => { allColumnsRef.current = allColumns }, [allColumns])

  const manifestColumns = useMemo<Column[]>(
    () => (manifest?.groups ?? []).flatMap((g) => g.columns),
    [manifest],
  )

  const cellErrors = useMemo<Map<string, ValidationIssue>>(() => {
    const m = new Map<string, ValidationIssue>()
    for (const row of rows) {
      for (const col of manifestColumns) {
        const rawVal = row[col.id]
        const val = rawVal != null ? String(rawVal) : ''
        if (col.required && !val) {
          m.set(`${row._rowId as string}:${col.id}`, { level: 'error', msg: `${col.labelEn} is required` })
        } else if (col.maxLength && val.length > col.maxLength) {
          m.set(`${row._rowId as string}:${col.id}`, { level: 'warn', msg: `Exceeds max ${col.maxLength} chars (${val.length})` })
        } else if (col.options?.length && val && !col.options.includes(val)) {
          m.set(`${row._rowId as string}:${col.id}`, { level: 'warn', msg: `"${val}" is not a valid option` })
        }
      }
    }
    return m
  }, [rows, manifestColumns])

  const validErrorCount = useMemo(() => [...cellErrors.values()].filter((e) => e.level === 'error').length, [cellErrors])
  const validWarnCount  = useMemo(() => [...cellErrors.values()].filter((e) => e.level === 'warn').length, [cellErrors])

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
    // BF.3 — extended row filter
    if (ffFilter.parentage !== 'any') {
      result = result.filter((row) => {
        if (ffFilter.parentage === 'parent') return row.parentage_level === 'parent'
        return row.parentage_level === 'child'
      })
    }
    if (ffFilter.hasAsin !== 'any') {
      result = result.filter((row) =>
        ffFilter.hasAsin === 'yes' ? !!row._asin : !row._asin,
      )
    }
    if (ffFilter.missingRequired && manifest) {
      const reqCols = manifestColumns.filter((c) => c.required)
      result = result.filter((row) =>
        reqCols.some((c) => {
          const v = row[c.id]
          return v === null || v === undefined || String(v).trim() === ''
        }),
      )
    }

    // FF.40: parent/child hierarchy grouping
    if (result.some((r) => r.parentage_level === 'parent' || r.parentage_level === 'child')) {
      const grouped: Row[] = []
      const processedChildIds = new Set<string>()
      for (const row of result) {
        if (row.parentage_level === 'child') continue
        grouped.push(row)
        if (row.parentage_level === 'parent' && !collapsedParents.has(row._rowId as string)) {
          const pSku = String(row.item_sku ?? '')
          for (const child of result) {
            if (child.parentage_level === 'child' && String(child.parent_sku ?? '') === pSku) {
              grouped.push(child)
              processedChildIds.add(child._rowId as string)
            }
          }
        }
      }
      for (const row of result) {
        if (row.parentage_level === 'child' && !processedChildIds.has(row._rowId as string)) {
          grouped.push(row)
        }
      }
      result = grouped
    }

    displayRowsRef.current = result
    return result
  }, [rows, searchQuery, searchMode, sortConfig, collapsedParents, ffFilter, manifest, manifestColumns])

  // BF.1 — flat list of every visible cell for FindReplaceBar
  const findCells = useMemo<FindCell[]>(() => {
    const out: FindCell[] = []
    displayRows.forEach((row, ri) => {
      allColumnsRef.current.forEach((col, ci) => {
        out.push({ rowIdx: ri, colIdx: ci, rowId: row._rowId as string, columnId: col.id, value: row[col.id] })
      })
    })
    return out
  }, [displayRows])

  // BF.2 — per-cell tone map from conditional formatting rules
  const toneMap = useMemo(() => {
    const out = new Map<string, string>()
    if (cfRules.length === 0) return out
    const active = cfRules.filter((r) => r.enabled)
    const byCol = new Map<string, ConditionalRule[]>()
    for (const rule of active) {
      const arr = byCol.get(rule.columnId) ?? []
      arr.push(rule)
      byCol.set(rule.columnId, arr)
    }
    displayRows.forEach((row, ri) => {
      for (const [colId, colRules] of byCol) {
        for (const rule of colRules) {
          if (evaluateRule(rule, row[colId])) {
            out.set(`${ri}:${colId}`, rule.tone)
            break
          }
        }
      }
    })
    return out
  }, [cfRules, displayRows])

  const normSel = useMemo<NormSel | null>(() => {
    if (!selAnchor || !selEnd) return null
    return {
      rMin: Math.min(selAnchor.ri, selEnd.ri),
      rMax: Math.max(selAnchor.ri, selEnd.ri),
      cMin: Math.min(selAnchor.ci, selEnd.ci),
      cMax: Math.max(selAnchor.ci, selEnd.ci),
    }
  }, [selAnchor, selEnd])

  const fillTarget = useMemo<NormSel | null>(() => {
    if (!isFillDragging || !fillDragEnd || !normSel) return null
    const { rMin, rMax, cMin, cMax } = normSel
    const { ri, ci } = fillDragEnd
    const dRow = ri > rMax ? ri - rMax : ri < rMin ? ri - rMin : 0
    const dCol = ci > cMax ? ci - cMax : ci < cMin ? ci - cMin : 0
    if (Math.abs(dRow) >= Math.abs(dCol)) {
      if (ri > rMax) return { rMin: rMax + 1, rMax: ri,      cMin, cMax }
      if (ri < rMin) return { rMin: ri,       rMax: rMin - 1, cMin, cMax }
    } else {
      if (ci > cMax) return { rMin, rMax, cMin: cMax + 1, cMax: ci }
      if (ci < cMin) return { rMin, rMax, cMin: ci,       cMax: cMin - 1 }
    }
    return null
  }, [isFillDragging, fillDragEnd, normSel])

  // ── Clipboard + selection ops ──────────────────────────────────────

  const handleCopy = useCallback(() => {
    if (!normSel) return
    const { rMin, rMax, cMin, cMax } = normSel
    const tsv = displayRowsRef.current.slice(rMin, rMax + 1)
      .map(row => allColumnsRef.current.slice(cMin, cMax + 1)
        .map(col => String(row[col.id] ?? '')).join('\t'))
      .join('\n')
    navigator.clipboard.writeText(tsv).catch(() => {})
  }, [normSel])

  const handleDeleteCells = useCallback(() => {
    if (!normSel) return
    pushSnapshot()
    const { rMin, rMax, cMin, cMax } = normSel
    setRows(prev => {
      const next = [...prev]
      for (let ri = rMin; ri <= rMax; ri++) {
        const dr = displayRowsRef.current[ri]; if (!dr) continue
        const idx = prev.findIndex(r => r._rowId === dr._rowId); if (idx === -1) continue
        let updated: Row = { ...prev[idx], _dirty: true }
        for (let ci = cMin; ci <= cMax; ci++) {
          const col = allColumnsRef.current[ci]; if (col) updated[col.id] = ''
        }
        next[idx] = updated
      }
      return next
    })
  }, [normSel, pushSnapshot])

  const handleCut = useCallback(() => {
    handleCopy(); handleDeleteCells()
  }, [handleCopy, handleDeleteCells])

  const handlePaste = useCallback(async () => {
    if (!selAnchor) return
    const text = await navigator.clipboard.readText().catch(() => '')
    if (!text) return
    const pasteLines = text.split('\n').filter((l) => l.trim())
    if (!pasteLines.length) return

    // FF.42: detect header row — if ≥2 cells in first row match known column ids/labels
    const firstRow = pasteLines[0].split('\t')
    const colLookup = new Map<string, number>()
    allColumnsRef.current.forEach((c, i) => {
      colLookup.set(c.id.toLowerCase(), i)
      colLookup.set(c.labelEn.toLowerCase(), i)
      colLookup.set(c.labelLocal.toLowerCase(), i)
      if (c.fieldRef) colLookup.set(c.fieldRef.toLowerCase(), i)
    })
    const headerMap = new Map<number, number>() // pasteColIdx → allColumns index
    let matchCount = 0
    firstRow.forEach((cell, pi) => {
      const ci = colLookup.get(cell.trim().toLowerCase())
      if (ci !== undefined) { headerMap.set(pi, ci); matchCount++ }
    })
    const hasHeaders = smartPasteEnabled && matchCount >= 2

    const dataRows = hasHeaders ? pasteLines.slice(1) : pasteLines
    const { ri: startRi, ci: startCi } = selAnchor
    pushSnapshot()
    setRows((prev) => {
      const next = [...prev]
      dataRows.forEach((line, riOffset) => {
        const pasteRow = line.split('\t')
        const dr = displayRowsRef.current[startRi + riOffset]; if (!dr) return
        const idx = prev.findIndex((r) => r._rowId === dr._rowId); if (idx === -1) return
        const updated: Row = { ...prev[idx], _dirty: true }
        if (hasHeaders) {
          pasteRow.forEach((val, pi) => {
            const ci = headerMap.get(pi)
            if (ci !== undefined) { const col = allColumnsRef.current[ci]; if (col) updated[col.id] = val }
          })
        } else {
          pasteRow.forEach((val, ciOffset) => {
            const col = allColumnsRef.current[startCi + ciOffset]; if (col) updated[col.id] = val
          })
        }
        next[idx] = updated
      })
      return next
    })
    const lastR = dataRows.length - 1
    const lastC = hasHeaders
      ? Math.max(0, ...headerMap.values())
      : startCi + Math.max(...dataRows.map((r) => r.split('\t').length)) - 1
    setSelEnd({ ri: startRi + lastR, ci: Math.min(lastC, allColumnsRef.current.length - 1) })
  }, [selAnchor, pushSnapshot, smartPasteEnabled])

  const handleFillDown = useCallback(() => {
    if (!normSel) return
    const { rMin, rMax, cMin, cMax } = normSel
    if (rMin === rMax) return
    pushSnapshot()
    const srcRow = displayRowsRef.current[rMin]; if (!srcRow) return
    setRows(prev => {
      const next = [...prev]
      for (let ri = rMin + 1; ri <= rMax; ri++) {
        const dr = displayRowsRef.current[ri]; if (!dr) continue
        const idx = prev.findIndex(r => r._rowId === dr._rowId); if (idx === -1) continue
        let updated: Row = { ...prev[idx], _dirty: true }
        for (let ci = cMin; ci <= cMax; ci++) {
          const col = allColumnsRef.current[ci]; if (col) updated[col.id] = srcRow[col.id]
        }
        next[idx] = updated
      }
      return next
    })
  }, [normSel, pushSnapshot])

  const handleSelectAll = useCallback(() => {
    const rMax = displayRowsRef.current.length - 1
    const cMax = allColumnsRef.current.length - 1
    if (rMax < 0 || cMax < 0) return
    setSelAnchor({ ri: 0, ci: 0 })
    setSelEnd({ ri: rMax, ci: cMax })
    setActiveCell(null)
  }, [])

  const executeFill = useCallback(() => {
    if (!normSel || !fillTarget) return
    pushSnapshot()
    const { rMin, rMax, cMin, cMax } = normSel
    const selH = rMax - rMin + 1
    const selW = cMax - cMin + 1
    setRows(prev => {
      const next = [...prev]
      for (let ri = fillTarget.rMin; ri <= fillTarget.rMax; ri++) {
        const srcRi = rMin + ((ri - fillTarget.rMin) % selH)
        const dr = displayRowsRef.current[ri]; if (!dr) continue
        const srcDr = displayRowsRef.current[srcRi]; if (!srcDr) continue
        const idx = prev.findIndex(r => r._rowId === dr._rowId); if (idx === -1) continue
        let updated: Row = { ...prev[idx], _dirty: true }
        for (let ci = fillTarget.cMin; ci <= fillTarget.cMax; ci++) {
          const srcCi = cMin + ((ci - fillTarget.cMin) % selW)
          const col = allColumnsRef.current[ci]
          const srcCol = allColumnsRef.current[srcCi]
          if (col && srcCol) updated[col.id] = srcDr[srcCol.id]
        }
        next[idx] = updated
      }
      return next
    })
    // Expand selection to cover filled area
    setSelEnd({
      ri: Math.max(normSel.rMax, fillTarget.rMax),
      ci: Math.max(normSel.cMax, fillTarget.cMax),
    })
    setIsFillDragging(false)
    setFillDragEnd(null)
  }, [normSel, fillTarget, pushSnapshot])

  const handleCellPointerDown = useCallback((ri: number, ci: number, shiftKey: boolean) => {
    if (shiftKey && selAnchor) {
      setSelEnd({ ri, ci })
      setIsEditing(false)
      setActiveCell(null)
    } else {
      setSelAnchor({ ri, ci })
      setSelEnd({ ri, ci })
      setIsEditing(false)
      setEditInitialChar(null)
      const row = displayRowsRef.current[ri]
      const col = allColumnsRef.current[ci]
      if (row && col) setActiveCell({ rowId: row._rowId as string, colId: col.id })
    }
  }, [selAnchor])

  const handleCellDoubleClick = useCallback((ri: number, ci: number) => {
    setSelAnchor({ ri, ci })
    setSelEnd({ ri, ci })
    setIsEditing(true)
    setEditInitialChar(null)
    const row = displayRowsRef.current[ri]
    const col = allColumnsRef.current[ci]
    if (row && col) setActiveCell({ rowId: row._rowId as string, colId: col.id })
  }, [])

  const moveSelection = useCallback((dCol: number, dRow: number, extend = false) => {
    const maxRi = displayRowsRef.current.length - 1
    const maxCi = allColumnsRef.current.length - 1
    const anchor = selAnchorRef.current
    if (!anchor) return
    setIsEditing(false)
    setEditInitialChar(null)
    if (extend) {
      const e = selEndRef.current ?? anchor
      const newRi = Math.max(0, Math.min(maxRi, e.ri + dRow))
      const newCi = Math.max(0, Math.min(maxCi, e.ci + dCol))
      setSelEnd({ ri: newRi, ci: newCi })
    } else {
      const newRi = Math.max(0, Math.min(maxRi, anchor.ri + dRow))
      const newCi = Math.max(0, Math.min(maxCi, anchor.ci + dCol))
      setSelAnchor({ ri: newRi, ci: newCi })
      setSelEnd({ ri: newRi, ci: newCi })
      const row = displayRowsRef.current[newRi]
      const col = allColumnsRef.current[newCi]
      if (row && col) setActiveCell({ rowId: row._rowId as string, colId: col.id })
      requestAnimationFrame(() => {
        document.querySelector(`[data-ri="${newRi}"][data-ci="${newCi}"]`)
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      })
    }
  }, [])

  const handleFillHandlePointerDown = useCallback((ri: number, ci: number) => {
    setIsFillDragging(true)
    setFillDragEnd({ ri, ci })
  }, [])

  const handleFillDrop = useCallback(() => {
    if (isFillDragging) executeFill()
  }, [isFillDragging, executeFill])

  // ── Keyboard handler (merged: undo/redo + clipboard + selection) ───

  useEffect(() => {
    function handle(e: globalThis.KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      // Undo/redo always work
      if (mod && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return }
      if (mod && e.key === 'z' && e.shiftKey)  { e.preventDefault(); redo(); return }
      if (mod && e.key === 'y')                 { e.preventDefault(); redo(); return }
      // BF.1 — Find & Replace
      if (mod && e.key === 'f') { e.preventDefault(); setFindReplaceOpen(true); return }

      // In edit mode: only handle Escape (let input handle everything else)
      if (isEditingRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setIsEditing(false)
          setEditInitialChar(null)
          // revert is handled in SpreadsheetCell via cancelledRef
        }
        return
      }

      // Close context menu on any key
      if (contextMenu) { setContextMenu(null) }

      // Select all
      if (mod && e.key === 'a') { e.preventDefault(); handleSelectAll(); return }

      if (!selAnchorRef.current) return

      // Clipboard ops
      if (mod && e.key === 'c') {
        e.preventDefault()
        handleCopy()
        setClipboardRange(normSel)
        return
      }
      if (mod && e.key === 'x') {
        e.preventDefault()
        handleCut()
        setClipboardRange(normSel)
        return
      }
      if (mod && e.key === 'v') {
        e.preventDefault()
        void handlePaste()
        setClipboardRange(null)
        return
      }
      if (mod && e.key === 'd') { e.preventDefault(); handleFillDown(); return }

      // Ctrl+Home / Ctrl+End
      if (mod && e.key === 'Home') {
        e.preventDefault()
        setSelAnchor({ ri: 0, ci: 0 }); setSelEnd({ ri: 0, ci: 0 })
        const row = displayRowsRef.current[0]; const col = allColumnsRef.current[0]
        if (row && col) setActiveCell({ rowId: row._rowId as string, colId: col.id })
        requestAnimationFrame(() => document.querySelector('[data-ri="0"][data-ci="0"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
        return
      }
      if (mod && e.key === 'End') {
        e.preventDefault()
        const ri = displayRowsRef.current.length - 1; const ci = allColumnsRef.current.length - 1
        setSelAnchor({ ri, ci }); setSelEnd({ ri, ci })
        const row = displayRowsRef.current[ri]; const col = allColumnsRef.current[ci]
        if (row && col) setActiveCell({ rowId: row._rowId as string, colId: col.id })
        requestAnimationFrame(() => document.querySelector(`[data-ri="${ri}"][data-ci="${ci}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
        return
      }

      // Ctrl+Arrow: jump to edge
      if (mod && e.key === 'ArrowDown')  { e.preventDefault(); moveSelection(0, displayRowsRef.current.length - 1 - (selAnchorRef.current?.ri ?? 0)); return }
      if (mod && e.key === 'ArrowUp')    { e.preventDefault(); moveSelection(0, -(selAnchorRef.current?.ri ?? 0)); return }
      if (mod && e.key === 'ArrowRight') { e.preventDefault(); moveSelection(allColumnsRef.current.length - 1 - (selAnchorRef.current?.ci ?? 0), 0); return }
      if (mod && e.key === 'ArrowLeft')  { e.preventDefault(); moveSelection(-(selAnchorRef.current?.ci ?? 0), 0); return }

      // Arrow navigation
      if (!e.shiftKey && !mod) {
        if (e.key === 'ArrowDown')  { e.preventDefault(); moveSelection(0, 1); return }
        if (e.key === 'ArrowUp')    { e.preventDefault(); moveSelection(0, -1); return }
        if (e.key === 'ArrowRight') { e.preventDefault(); moveSelection(1, 0); return }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); moveSelection(-1, 0); return }
        if (e.key === 'Enter')      { e.preventDefault(); moveSelection(0, 1); return }
        if (e.key === 'Tab')        { e.preventDefault(); moveSelection(1, 0); return }
      }
      if (e.shiftKey && !mod) {
        if (e.key === 'ArrowDown')  { e.preventDefault(); moveSelection(0, 1, true); return }
        if (e.key === 'ArrowUp')    { e.preventDefault(); moveSelection(0, -1, true); return }
        if (e.key === 'ArrowRight') { e.preventDefault(); moveSelection(1, 0, true); return }
        if (e.key === 'ArrowLeft')  { e.preventDefault(); moveSelection(-1, 0, true); return }
        if (e.key === 'Tab')        { e.preventDefault(); moveSelection(-1, 0, true); return }
        if (e.key === 'Enter')      { e.preventDefault(); moveSelection(0, -1, true); return }
      }

      // F2: enter edit mode (preserve content)
      if (e.key === 'F2') {
        e.preventDefault()
        setIsEditing(true)
        setEditInitialChar(null)
        return
      }

      // Delete/Backspace: clear cells
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); handleDeleteCells(); return }

      // Escape: clear selection and clipboard marker
      if (e.key === 'Escape') {
        setSelAnchor(null); setSelEnd(null)
        setClipboardRange(null)
        return
      }

      // Printable key: enter edit mode replacing content
      if (e.key.length === 1 && !mod) {
        setIsEditing(true)
        setEditInitialChar(e.key)
      }
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [undo, redo, contextMenu, normSel, handleCopy, handleCut, handlePaste, handleFillDown, handleDeleteCells, handleSelectAll, moveSelection])

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
      const reordered = [...next.map((id) => rowMap.get(id)!).filter(Boolean), ...notDisplayed]
      const ids = reordered.map((r) => r._rowId as string)
      try { localStorage.setItem(rowOrderKey, JSON.stringify(ids)) } catch {}
      propagateRowOrder(ids)
      return reordered
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

  // # cell width adapts to image size so images never overflow the column
  const rowHeaderWidth = useMemo(
    () => showRowImages ? Math.max(28, imageSize + 8) : 28,
    [showRowImages, imageSize],
  )

  const stickyLeftByColIdx = useMemo<Record<number, number>>(() => {
    const out: Record<number, number> = {}
    let left = 36 + rowHeaderWidth // checkbox(36) + row# (dynamic)
    for (let i = 0; i < Math.min(frozenColCount, allColumns.length); i++) {
      out[i] = left
      left += colWidths[allColumns[i].id] ?? allColumns[i].width
    }
    return out
  }, [frozenColCount, allColumns, colWidths, rowHeaderWidth])

  const dirtyRows = useMemo(() => rows.filter((r) => r._dirty || r._isNew), [rows])
  const newCount  = useMemo(() => rows.filter((r) => r._isNew).length, [rows])

  // Memoised string of all unique ASINs in current rows — used as dep to avoid
  // refetching on every keystroke while still catching newly-fetched ASINs.
  const rowAsinString = useMemo(() => {
    const s = new Set<string>()
    for (const row of rows) {
      if (row._asin) s.add(String(row._asin))
    }
    return [...s].sort().join(',')
  }, [rows])

  useEffect(() => {
    if (!showRowImages || !rowAsinString) return
    const allAsins = rowAsinString.split(',').filter(Boolean)
    const uncached = allAsins.filter((a) => !(a in imagesByAsin))
    if (!uncached.length) return

    // Mark as pending immediately (null = loading)
    setImagesByAsin((prev) => {
      const update: Record<string, string | null> = {}
      for (const a of uncached) update[a] = null
      return { ...prev, ...update }
    })

    fetch(`${getBackendUrl()}/api/amazon/flat-file/fetch-images`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asins: uncached, marketplace }),
    })
      .then((r) => (r.ok ? r.json() : { images: {} }))
      .then((data) => {
        const incoming = data.images ?? {}
        setImagesByAsin((prev) => {
          const next = { ...prev, ...incoming }
          try { localStorage.setItem('ff-images-cache', JSON.stringify(next)) } catch {}
          return next
        })
      })
      .catch(() => {})
  // imagesByAsin is intentionally NOT in the dep array (it's updated inside the effect)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRowImages, rowAsinString, marketplace])

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

  // Live sync: reload rows from DB when the Matrix or another tab updates
  // channel prices. Skip if the user has unsaved edits — their work takes
  // priority and will overwrite the external change on next Save.
  useInvalidationChannel('channel-pricing.updated', () => {
    if (!productType) return
    if (rowsRef.current.some((r) => r._dirty)) return
    void loadData(marketplace, productType, false, true)
  })

  // Load submission history when marketplace/productType change
  useEffect(() => {
    if (!productType) return
    try {
      const raw = localStorage.getItem(submissionHistoryKey(marketplace, productType))
      setSubmissionHistory(raw ? JSON.parse(raw) : [])
    } catch { setSubmissionHistory([]) }
  }, [marketplace, productType])

  // ── Load data ──────────────────────────────────────────────────────

  const loadData = useCallback(async (mp: string, pt: string, force = false, fromDB = false) => {
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
        const mRes = await fetch(`${backend}/api/amazon/flat-file/template?${qs}`)
        if (!mRes.ok) { const e = await mRes.json().catch(() => ({})); throw new Error(e.error ?? `HTTP ${mRes.status}`) }
        setManifest(await mRes.json())
      } else {
        // Full load — fetch manifest + rows in parallel.
        // fromDB=true: always use DB rows (called on external invalidation or
        // explicit reload). fromDB=false: prefer localStorage draft if present.
        const [mRes, rRes] = await Promise.all([
          fetch(`${backend}/api/amazon/flat-file/template?${qs}`),
          fetch(`${backend}/api/amazon/flat-file/rows?${rowsQs}`),
        ])
        if (!mRes.ok) { const e = await mRes.json().catch(() => ({})); throw new Error(e.error ?? `HTTP ${mRes.status}`) }
        setManifest(await mRes.json())
        const saved = fromDB ? null : loadSavedRows(mp, pt)
        if (saved && saved.length > 0) {
          setRows(mergeAsinCache(saved, mp))
        } else if (rRes.ok) {
          const d = await rRes.json()
          const freshRows = mergeAsinCache(d.rows ?? [], mp)
          setRows(freshRows)
          // Update localStorage so the next page open starts fresh too.
          if (fromDB) saveRows(mp, pt, freshRows)
        } else {
          setRows([])
        }
        if (fromDB) setDraftBanner(null)
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

  const deleteSelected = useCallback(() => {
    pushSnapshot()
    setRows((prev) => prev.filter((r) => !selectedRows.has(r._rowId as string)))
    setSelectedRows(new Set())
  }, [selectedRows])

  const handleAddRows = useCallback((params: {
    type: 'row' | 'parent' | 'variant'
    count: number
    position: 'end' | 'above' | 'below'
    replicateFromId?: string
    parentSku?: string
  }) => {
    const { type, count, position, replicateFromId, parentSku } = params
    const sourceRow = replicateFromId ? rowsRef.current.find((r) => r._rowId === replicateFromId) : null

    // Fields that should not be copied (identity + internal)
    const SKIP = new Set([
      'item_sku', 'parent_sku', 'parentage_level', 'product_type',
      'record_action', 'variation_theme',
      '_rowId', '_isNew', '_dirty', '_status', '_feedMessage',
      '_productId', '_asin', '_listingStatus',
    ])

    const newRows: Row[] = Array.from({ length: count }, () => {
      const base = makeEmptyRow(
        productType, marketplace,
        type === 'parent' ? 'parent' : type === 'variant' ? 'child' : '',
      )
      if (sourceRow) {
        for (const [k, v] of Object.entries(sourceRow)) {
          if (!SKIP.has(k)) base[k] = v
        }
      }
      if (type === 'variant' && parentSku) base.parent_sku = parentSku
      return base
    })

    pushSnapshot()
    setRows((prev) => {
      if (position === 'end') return [...prev, ...newRows]

      const displayed = displayRowsRef.current
      const anchorRi = selAnchorRef.current?.ri ?? 0
      const endRi = selEndRef.current?.ri ?? anchorRi
      const targetRi = position === 'above'
        ? Math.min(anchorRi, endRi)
        : Math.max(anchorRi, endRi)
      const targetRow = displayed[targetRi]
      if (!targetRow) return [...prev, ...newRows]
      const idx = prev.findIndex((r) => r._rowId === targetRow._rowId)
      if (idx === -1) return [...prev, ...newRows]
      const insertAt = position === 'above' ? idx : idx + 1
      const next = [...prev]
      next.splice(insertAt, 0, ...newRows)
      return next
    })

    setAddRowsPanel(null)

    // Focus the first new row's SKU cell
    const firstNew = newRows[0]
    if (firstNew) setTimeout(() => setActiveCell({ rowId: firstNew._rowId as string, colId: 'item_sku' }), 30)
  }, [productType, marketplace, pushSnapshot])

  const updateCell = useCallback((rowId: string, colId: string, value: unknown) => {
    pushSnapshot()
    setRows((prev) => prev.map((r) => r._rowId === rowId ? { ...r, [colId]: value, _dirty: true } : r))
  }, [])

  const liveUpdateCell = useCallback((rowId: string, colId: string, value: unknown) => {
    setRows((prev) => prev.map((r) => r._rowId === rowId ? { ...r, [colId]: value, _dirty: true } : r))
  }, [])

  const navigate = useCallback((rowId: string, colId: string, dir: 'right' | 'left' | 'down' | 'up') => {
    const colIds = allColumnsRef.current.map((c) => c.id)
    const rowIds = displayRowsRef.current.map((r) => r._rowId as string)
    let ci = colIds.indexOf(colId), ri = rowIds.indexOf(rowId)
    if (dir === 'right') ci = Math.min(ci + 1, colIds.length - 1)
    else if (dir === 'left') ci = Math.max(ci - 1, 0)
    else if (dir === 'down') ri = Math.min(ri + 1, rowIds.length - 1)
    else ri = Math.max(ri - 1, 0)
    const nc = colIds[ci], nr = rowIds[ri]
    if (nc && nr) {
      setActiveCell({ rowId: nr, colId: nc })
      setSelAnchor({ ri, ci })
      setSelEnd({ ri, ci })
      setIsEditing(false)
      setEditInitialChar(null)
      requestAnimationFrame(() => {
        document.querySelector(`[data-ri="${ri}"][data-ci="${ci}"]`)
          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      })
    }
  }, [])

  // ── Submission + version history ──────────────────────────────────

  const createVersion = useCallback((label: string) => {
    if (!productType || !marketplace) return
    const record: VersionRecord = {
      id: `v-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label,
      savedAt: new Date().toISOString(),
      rowCount: rowsRef.current.length,
      rows: rowsRef.current,
    }
    try {
      const key = versionHistoryKey(marketplace, productType)
      const existing: VersionRecord[] = JSON.parse(localStorage.getItem(key) ?? '[]')
      const trimmed = [record, ...existing].slice(0, 15)
      localStorage.setItem(key, JSON.stringify(trimmed))
    } catch { /* quota */ }
  }, [marketplace, productType])

  const saveSubmissionRecord = useCallback((record: SubmissionRecord) => {
    setSubmissionHistory((prev) => {
      const updated = [record, ...prev].slice(0, 50)
      try { localStorage.setItem(submissionHistoryKey(marketplace, productType), JSON.stringify(updated)) } catch {}
      return updated
    })
  }, [marketplace, productType])

  const updateSubmissionRecord = useCallback((feedId: string, patch: Partial<SubmissionRecord>) => {
    setSubmissionHistory((prev) => {
      const updated = prev.map((r) => r.id === feedId ? { ...r, ...patch } : r)
      try { localStorage.setItem(submissionHistoryKey(marketplace, productType), JSON.stringify(updated)) } catch {}
      return updated
    })
  }, [marketplace, productType])

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

    // Save submission records to history
    const now = new Date().toISOString()
    for (const entry of entries) {
      saveSubmissionRecord({
        id: entry.feedId,
        market: entry.market,
        productType,
        submittedAt: now,
        rowCount: entry.market === marketplace
          ? rows.filter((r) => r._dirty || r._isNew).length
          : 0,
        status: 'IN_QUEUE',
        dryRun: false,
      })
    }
    // Create a version snapshot
    createVersion(`Before submit · ${[...markets].join(', ')}`)

    if (markets.has(marketplace)) {
      setRows((prev) => prev.map((r) =>
        r._dirty || r._isNew ? { ...r, _dirty: false, _isNew: false, _status: 'pending' } : r
      ))
    }
    setSubmitting(false)
  }, [rows, marketplace, productType, manifest, saveSubmissionRecord, createVersion])

  // ── Platform sync ──────────────────────────────────────────────────
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle')

  const syncToPlatform = useCallback(async (rowsToSync: Row[], isPublished = false) => {
    if (!manifest) return
    setSyncStatus('syncing')
    try {
      const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/sync-rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: rowsToSync,
          marketplace,
          productType,
          expandedFields: manifest.expandedFields ?? {},
          isPublished,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Sync failed')
      setSyncStatus('synced')
      setTimeout(() => setSyncStatus('idle'), 4000)
      // Notify any open product edit page to re-fetch channel pricing/inventory
      emitInvalidation({ type: 'channel-pricing.updated', meta: { marketplace, productType } })
    } catch {
      setSyncStatus('error')
      setTimeout(() => setSyncStatus('idle'), 6000)
    }
  }, [manifest, marketplace, productType])

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
      // Persist completed submissions to history + sync to platform when DONE
      for (const entry of updated) {
        if (entry.status === 'DONE' || entry.status === 'FATAL') {
          const ok = entry.results.filter((r: FeedResult) => r.status === 'success').length
          const err = entry.results.filter((r: FeedResult) => r.status === 'error').length
          updateSubmissionRecord(entry.feedId, {
            status: entry.status as 'DONE' | 'FATAL',
            successCount: ok,
            errorCount: err,
            results: entry.results,
          })
          // On DONE: sync all rows for this market to the platform with isPublished=true
          if (entry.status === 'DONE') {
            const mpRows = entry.market === marketplace
              ? rows
              : (() => {
                  try {
                    const raw = localStorage.getItem(rowStorageKey(entry.market, productType))
                    return raw ? JSON.parse(raw) as Row[] : []
                  } catch { return [] }
                })()
            void syncToPlatform(mpRows, true)
          }
        } else {
          updateSubmissionRecord(entry.feedId, { status: entry.status as 'IN_QUEUE' | 'PROCESSING' })
        }
      }
    } catch (e: any) { setLoadError(e.message) }
    finally { setPolling(false) }
  }, [feedEntries, marketplace, productType, rows, updateSubmissionRecord, syncToPlatform])

  // ── Import / Export ────────────────────────────────────────────────

  const importFile = useCallback(async (file: File) => {
    createVersion('Before import')
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
  }, [productType, marketplace, createVersion])

  // ── Copy to market ─────────────────────────────────────────────────
  // BM.2 — multi-target replicate used by FFReplicateModal
  const handleReplicate = useCallback(async (
    targets: string[],
    groupIds: Set<string>,
    selectedOnly: boolean,
  ): Promise<{ copied: number; skipped: number }> => {
    if (!manifest) return { copied: 0, skipped: 0 }
    const allColIds = manifest.groups
      .filter((g) => groupIds.has(g.id))
      .flatMap((g) => g.columns.map((c) => c.id))
    const colSet = new Set(allColIds)
    const sourceRows = selectedOnly && selectedRows.size > 0
      ? rows.filter((r) => selectedRows.has(r._rowId as string))
      : rows
    let copied = 0
    let skipped = 0
    for (const target of targets) {
      try {
        const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/template?marketplace=${target}&productType=${productType}`)
        if (!res.ok) { skipped += sourceRows.length; continue }
        const targetManifest: Manifest = await res.json()
        const targetColIds = new Set(targetManifest.groups.flatMap((g) => g.columns.map((c) => c.id)))
        const STRUCTURAL = new Set(['item_sku', 'product_type', 'record_action', 'parentage_level', 'parent_sku', 'variation_theme'])
        const copiedRows = sourceRows.map((row) => {
          const newRow: Row = { _rowId: `copy-${row._rowId}-${target}-${Date.now()}`, _isNew: true, _dirty: true, _status: 'idle' }
          for (const key of STRUCTURAL) { if (row[key] != null) newRow[key] = row[key] }
          for (const colId of colSet) { if (targetColIds.has(colId) && row[colId] != null) newRow[colId] = row[colId] }
          return newRow
        })
        // Persist to localStorage under the target market key
        const base = `ff-rows-${target.toUpperCase()}-${productType.toUpperCase()}`
        const key = familyId ? `${base}-family-${familyId}` : base
        try { localStorage.setItem(key, JSON.stringify(copiedRows)) } catch {}
        copied += copiedRows.length
      } catch { skipped += sourceRows.length }
    }
    return { copied, skipped }
  }, [manifest, rows, selectedRows, productType, familyId])

  const handleCopyToMarket = useCallback(async (
    targetMarket: string,
    colIds: Set<string>,
  ) => {
    if (!manifest || !rows.length) return
    setPushPanel(null)
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

      // Persist ASIN data so it survives row reloads
      const cacheEntries: Record<string, { asin?: string; status?: string }> = {}
      for (const [sku, data] of Object.entries(currentResults)) {
        if (data.asin || data.status) {
          cacheEntries[sku] = { asin: data.asin, status: data.status }
        }
      }
      if (Object.keys(cacheEntries).length) writeAsinCache(marketplace, cacheEntries)

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
        // Persist ASIN data for other markets too
        const mpCacheEntries: Record<string, { asin?: string; status?: string }> = {}
        for (const [sku, data] of Object.entries(mpResults)) {
          if (data.asin || data.status) {
            mpCacheEntries[sku] = { asin: data.asin, status: data.status }
          }
        }
        if (Object.keys(mpCacheEntries).length) writeAsinCache(mp, mpCacheEntries)
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
    createVersion('Manual save')
    saveRows(marketplace, productType, rows)
    setSaveFlash(true)
    setTimeout(() => setSaveFlash(false), 2000)
    void syncToPlatform(rows, false)
  }, [rows, marketplace, productType, createVersion, syncToPlatform])

  const handleDiscard = useCallback(() => {
    if (!confirm('Discard all local changes? Your edits will be lost and rows will reload from the server.')) return
    createVersion('Before discard')
    try { localStorage.removeItem(rowStorageKey(marketplace, productType)) } catch {}
    void loadData(marketplace, productType, false)
  }, [marketplace, productType, loadData, createVersion])

  const handleApplyTranslations = useCallback((
    columnMappings: Array<{
      col: Column
      appliedMappings: Record<string, Record<string, string | null>>
    }>,
  ) => {
    // Current market — one snapshot for all columns
    const currentMarketMappings = columnMappings.filter(({ appliedMappings }) => appliedMappings[marketplace])
    if (currentMarketMappings.length > 0) {
      pushSnapshot()
      setRows((prev) => prev.map((row) => {
        let updated = { ...row }
        let changed = false
        for (const { col, appliedMappings } of currentMarketMappings) {
          const mapping = appliedMappings[marketplace]
          if (!mapping) continue
          const srcVal = String(row[col.id] ?? '')
          const mapped = mapping[srcVal]
          if (mapped != null) { updated[col.id] = mapped; updated._dirty = true; changed = true }
        }
        return changed ? updated : row
      }))
    }

    // Other markets — write to localStorage drafts
    const otherMps = new Set(
      columnMappings.flatMap(({ appliedMappings }) =>
        Object.keys(appliedMappings).filter((m) => m !== marketplace),
      ),
    )
    for (const mp of otherMps) {
      const key = rowStorageKey(mp, productType)
      try {
        const raw = localStorage.getItem(key)
        if (!raw) continue
        const otherRows: Row[] = JSON.parse(raw)
        const updated = otherRows.map((row) => {
          let updRow = { ...row }
          let changed = false
          for (const { col, appliedMappings } of columnMappings) {
            const mapping = appliedMappings[mp]
            if (!mapping) continue
            const srcVal = String(row[col.id] ?? '')
            const mapped = mapping[srcVal]
            if (mapped != null) { updRow[col.id] = mapped; updRow._dirty = true; changed = true }
          }
          return changed ? updRow : row
        })
        localStorage.setItem(key, JSON.stringify(updated))
      } catch { /* quota exceeded */ }
    }
  }, [marketplace, productType, pushSnapshot])

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">

      {/* Full-screen overlay while resizing — locks cursor, prevents text selection */}
      {resizingType && (
        <div className={cn('fixed inset-0 z-[9999] select-none', resizingType === 'col' ? 'cursor-col-resize' : 'cursor-row-resize')} />
      )}

      {/* ── Sticky header ────────────────────────────────────── */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30">

        {/* ── Channel + Market strip ────────────────────────── */}
        <ChannelStrip channel="amazon" marketplace={marketplace} familyId={familyId} />

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
              { separator: true },
              { label: 'Version history…', icon: <Clock className="w-3.5 h-3.5" />, onClick: () => setVersionPanelOpen(true), disabled: !manifest },
            ]} />
            <MenuDropdown label="Edit" items={[
              { label: 'Undo', icon: <Undo2 className="w-3.5 h-3.5" />, onClick: undo, disabled: !history.length, shortcut: '⌘Z' },
              { label: 'Redo', icon: <Redo2 className="w-3.5 h-3.5" />, onClick: redo, disabled: !future.length, shortcut: '⌘⇧Z' },
              { separator: true },
              { label: 'Copy to market…', icon: <Copy className="w-3.5 h-3.5" />, onClick: () => setPushPanel((p) => p ? null : { tab: 'copy' }), disabled: !manifest || !rows.length },
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
          {syncStatus !== 'idle' && (
            <span className={cn(
              'text-[11px] flex items-center gap-1 flex-shrink-0 transition-opacity',
              syncStatus === 'syncing' && 'text-slate-400',
              syncStatus === 'synced'  && 'text-emerald-600 dark:text-emerald-400',
              syncStatus === 'error'   && 'text-red-500 dark:text-red-400',
            )}>
              {syncStatus === 'syncing' && <><RefreshCw className="w-3 h-3 animate-spin" />Syncing…</>}
              {syncStatus === 'synced'  && <><CheckCircle2 className="w-3 h-3" />Synced</>}
              {syncStatus === 'error'   && <>⚠ Sync failed</>}
            </span>
          )}

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
          {submissionHistory.length > 0 && (
            <button
              type="button"
              onClick={() => setSubmissionPanelOpen((o) => !o)}
              className={cn(
                'flex items-center gap-1 text-xs px-2 py-0.5 rounded transition-colors flex-shrink-0',
                submissionPanelOpen
                  ? 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-300',
              )}
              title="Submission history"
            >
              <History className="w-3 h-3" />
              <span>{submissionHistory.length}</span>
            </button>
          )}
        </div>

        {/* ── Icon toolbar ─────────────────────────────────── */}
        <div className="px-3 h-8 flex items-center gap-0.5 border-b border-slate-100 dark:border-slate-800/60">

          {/* Undo / Redo */}
          <TbBtn icon={<Undo2 className="w-3.5 h-3.5" />} title="Undo (⌘Z)" onClick={undo} disabled={!history.length} />
          <TbBtn icon={<Redo2 className="w-3.5 h-3.5" />} title="Redo (⌘⇧Z)" onClick={redo} disabled={!future.length} />

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />

          {/* Push to markets — Copy tab */}
          <TbBtn
            icon={<Copy className="w-3.5 h-3.5" />}
            title="Copy rows to another market"
            onClick={() => setPushPanel((p) => p?.tab === 'copy' ? null : { tab: 'copy' })}
            disabled={!manifest || !rows.length}
            active={pushPanel?.tab === 'copy'}
          />

          {/* BM.2 — Replicate to multiple markets */}
          <TbBtn
            icon={<ArrowRightLeft className="w-3.5 h-3.5" />}
            title="Replicate to multiple markets"
            onClick={() => setReplicateOpen(true)}
            disabled={!manifest || !rows.length}
            active={replicateOpen}
          />

          {/* Fetch from Amazon — always visible, disabled when no rows selected */}
          <div className="relative">
            <TbBtn
              icon={<ArrowDownToLine className="w-3.5 h-3.5" />}
              title={selectedRows.size > 0
                ? `Fetch from Amazon (${selectedRows.size} SKU${selectedRows.size !== 1 ? 's' : ''})`
                : 'Fetch from Amazon — select rows first'}
              onClick={() => setFetchPanelOpen((o) => !o)}
              disabled={selectedRows.size === 0 || fetching}
              active={fetchPanelOpen}
              badge={selectedRows.size || undefined}
            />
            {fetchPanelOpen && (
              <FetchFromAmazonPanel selectedCount={selectedRows.size} currentMarket={marketplace}
                onFetch={handleFetchFromAmazon} onClose={() => setFetchPanelOpen(false)} />
            )}
          </div>

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />

          {/* FF.38 Validation toggle */}
          <TbBtn
            icon={<AlertTriangle className="w-3.5 h-3.5" />}
            title={validErrorCount + validWarnCount > 0
              ? `Validation: ${validErrorCount} error${validErrorCount !== 1 ? 's' : ''}, ${validWarnCount} warning${validWarnCount !== 1 ? 's' : ''}`
              : 'Validation — no issues'}
            onClick={() => setShowValidPanel((o) => !o)}
            disabled={!manifest}
            active={showValidPanel}
            badge={(validErrorCount + validWarnCount) || undefined}
          />

          {/* FF.42 Smart paste toggle */}
          <TbBtn
            icon={<ClipboardPaste className="w-3.5 h-3.5" />}
            title={smartPasteEnabled
              ? 'Smart paste ON — first row treated as column headers when ≥2 columns match. Click to turn off.'
              : 'Smart paste OFF — positional paste (default). Click to turn on header-mapping mode.'}
            onClick={() => setSmartPasteEnabled((o) => !o)}
            active={smartPasteEnabled}
          />

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />

          {/* Push to markets — Translate tab */}
          <TbBtn
            icon={<ArrowRightLeft className="w-3.5 h-3.5" />}
            title="Translate enum values to other markets"
            onClick={() => setPushPanel((p) => p?.tab === 'translate' ? null : { tab: 'translate' })}
            disabled={!manifest || !rows.length}
            active={pushPanel?.tab === 'translate'}
          />

          {/* Row images toggle */}
          <TbBtn
            icon={<ImageIcon className="w-3.5 h-3.5" />}
            title={showRowImages ? 'Hide product images' : 'Show product images in rows (fetches from Amazon by ASIN)'}
            onClick={() => setShowRowImages((o) => !o)}
            disabled={!manifest}
            active={showRowImages}
          />
          {showRowImages && (
            <>
              {([24, 32, 48, 64, 96] as const).map((size) => (
                <button
                  key={size}
                  type="button"
                  onClick={() => setImageSize(size)}
                  className={cn(
                    'h-6 px-1.5 rounded text-[10px] font-medium transition-colors',
                    imageSize === size
                      ? 'bg-slate-800 text-white dark:bg-slate-100 dark:text-slate-900'
                      : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800',
                  )}
                >
                  {size === 24 ? 'XS' : size === 32 ? 'S' : size === 48 ? 'M' : size === 64 ? 'L' : 'XL'}
                </button>
              ))}
            </>
          )}

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />

          {/* Sort */}
          <div className="relative">
            <TbBtn
              icon={<SlidersHorizontal className="w-3.5 h-3.5" />}
              title={sortConfig.length > 0
                ? `Sort — ${sortConfig.length} level${sortConfig.length !== 1 ? 's' : ''} active`
                : 'Sort rows'}
              onClick={() => setSortPanelOpen((o) => !o)}
              disabled={!manifest || !rows.length}
              active={sortPanelOpen || sortConfig.length > 0}
              badge={sortConfig.length || undefined}
            />
            {sortPanelOpen && (
              <SortPanel
                rows={rows} groups={orderedGroups} initial={sortConfig}
                onApply={(levels) => { setSortConfig(levels); setSortPanelOpen(false) }}
                onClose={() => setSortPanelOpen(false)}
                footerExtra={
                  <div className="px-4 py-3 space-y-2">
                    {/* Sync toggle for current market */}
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-600 dark:text-slate-300 font-medium">
                        Auto-sync to other markets
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleMarketSync(mp)}
                        title={marketSync[mp]
                          ? `ON — changes on ${mp} propagate automatically. Click to make ${mp} independent.`
                          : `OFF — click to re-enable auto-propagation`}
                        className={cn(
                          'text-[10px] px-2 py-0.5 rounded font-medium transition-colors border',
                          marketSync[mp]
                            ? 'bg-blue-50 border-blue-200 text-blue-600 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-400'
                            : 'bg-slate-50 border-slate-200 text-slate-400 dark:bg-slate-800 dark:border-slate-700',
                        )}
                      >
                        {marketSync[mp] ? 'ON' : 'OFF'}
                      </button>
                    </div>
                    {/* Apply-to section */}
                    <div>
                      <button
                        type="button"
                        onClick={() => { setSortPanelOpen(false); setApplyPanelOpen(true) }}
                        className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 font-medium"
                      >
                        Apply to specific markets…
                      </button>
                    </div>
                  </div>
                }
              />
            )}
          </div>
          {/* Apply-to panel (opened from inside sort panel) */}
          {applyPanelOpen && (
            <div className="relative">
              <ApplyToPanel
                currentMarket={mp}
                allMarkets={ALL_MARKETS}
                marketSync={marketSync}
                onToggleSync={toggleMarketSync}
                onApplyNow={applyOrderToMarkets}
                onClose={() => setApplyPanelOpen(false)}
              />
            </div>
          )}

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />

          {/* BF.1 — Find & Replace */}
          <TbBtn
            icon={<Replace className="w-3.5 h-3.5" />}
            title="Find & Replace (⌘F)"
            onClick={() => setFindReplaceOpen((o) => !o)}
            disabled={!manifest}
            active={findReplaceOpen}
          />

          {/* BF.2 — Conditional formatting */}
          <TbBtn
            icon={<Sparkles className="w-3.5 h-3.5" />}
            title={cfRules.length > 0 ? `Conditional formatting (${cfRules.filter(r => r.enabled).length} active)` : 'Conditional formatting'}
            onClick={() => setCfOpen((o) => !o)}
            disabled={!manifest}
            active={cfOpen}
            badge={cfRules.filter(r => r.enabled).length || undefined}
          />

          {/* BF.4 — AI bulk actions */}
          <TbBtn
            icon={<Sparkles className="w-3.5 h-3.5 text-amber-500" />}
            title={selectedRows.size > 0 ? `AI bulk actions (${selectedRows.size} selected)` : 'AI bulk actions — select rows first'}
            onClick={() => setAiModalOpen(true)}
            disabled={selectedRows.size === 0 || !manifest}
            badge={selectedRows.size || undefined}
          />
        </div>

        {/* ── Bar 3: Marketplace · Product type · Search ────── */}
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
              {/* BF.3 — extended row filter */}
              <FFFilterPanel
                open={filterPanelOpen}
                onOpenChange={setFilterPanelOpen}
                value={ffFilter}
                onChange={setFFFilter}
              />
              {/* BM.1 — saved views */}
              <FFSavedViews
                currentState={{
                  closedGroups: [...closedGroups],
                  ffFilter,
                  sortConfig,
                  cfRules,
                  frozenColCount,
                }}
                onApply={(state: FFViewState) => {
                  setClosedGroups(new Set(state.closedGroups))
                  setFFFilter(state.ffFilter)
                  setSortConfig(state.sortConfig)
                  setCfRules(state.cfRules)
                  setFrozenColCount(state.frozenColCount)
                }}
              />
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

        {/* Draft restore banner — shown when localStorage has unsaved edits
            from a previous session that differ from the DB rows loaded now. */}
        {draftBanner && (
          <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-t border-amber-200 dark:border-amber-800 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-amber-800 dark:text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              You have unsaved draft edits from a previous session ({draftBanner.filter((r) => r._dirty).length} rows).
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => {
                  setRows(mergeAsinCache(draftBanner, marketplace))
                  setDraftBanner(null)
                }}
                className="text-xs font-medium px-2 py-1 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/60 transition-colors"
              >
                Restore draft
              </button>
              <button
                type="button"
                onClick={() => {
                  saveRows(marketplace, productType, rows)
                  setDraftBanner(null)
                }}
                className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200"
              >
                Discard
              </button>
            </div>
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
        <div
          className="flex-1 overflow-auto"
          onContextMenu={(e) => {
            e.preventDefault()
            const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null

            // Right-click on the # (row number) cell
            const rowEl = el?.closest('[data-row-ri]') as HTMLElement | null
            if (rowEl) {
              const ri = parseInt(rowEl.dataset.rowRi ?? '', 10)
              if (!isNaN(ri)) {
                // Select the full row if not already in selection
                const alreadySelected = normSel
                  ? ri >= normSel.rMin && ri <= normSel.rMax
                  : false
                if (!alreadySelected) {
                  const maxCi = allColumnsRef.current.length - 1
                  setSelAnchor({ ri, ci: 0 })
                  setSelEnd({ ri, ci: maxCi })
                  const row = displayRowsRef.current[ri]
                  const col = allColumnsRef.current[0]
                  if (row && col) setActiveCell({ rowId: row._rowId as string, colId: col.id })
                }
                setContextMenu({ x: e.clientX, y: e.clientY })
              }
              return
            }

            // Right-click on a data cell
            const td = el?.closest('[data-ri]') as HTMLElement | null
            if (td) {
              const ri = parseInt(td.dataset.ri ?? '', 10)
              const ci = parseInt(td.dataset.ci ?? '', 10)
              if (!isNaN(ri) && !isNaN(ci)) {
                if (!normSel) {
                  setSelAnchor({ ri, ci }); setSelEnd({ ri, ci })
                  const row = displayRowsRef.current[ri]; const col = allColumnsRef.current[ci]
                  if (row && col) setActiveCell({ rowId: row._rowId as string, colId: col.id })
                }
                setContextMenu({ x: e.clientX, y: e.clientY })
              }
            }
          }}
          onPointerMove={(e) => {
            if (e.buttons !== 1) return
            const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null

            // Row # column drag — extend row selection vertically
            if (rowDragRef.current !== null) {
              const rowEl = el?.closest('[data-row-ri]') as HTMLElement | null
              if (rowEl) {
                const ri = parseInt(rowEl.dataset.rowRi ?? '', 10)
                if (!isNaN(ri)) {
                  const maxCi = allColumnsRef.current.length - 1
                  setSelEnd((p) => (p?.ri === ri && p?.ci === maxCi ? p : { ri, ci: maxCi }))
                }
              }
              return
            }

            // Regular cell selection / fill drag
            const td = el?.closest('[data-ri]') as HTMLElement | null
            if (!td) return
            const ri = parseInt(td.dataset.ri ?? '', 10)
            const ci = parseInt(td.dataset.ci ?? '', 10)
            if (isNaN(ri) || isNaN(ci)) return
            if (isFillDragging) {
              setFillDragEnd((p) => (p?.ri === ri && p?.ci === ci ? p : { ri, ci }))
            } else if (selAnchor) {
              setSelEnd((p) => (p?.ri === ri && p?.ci === ci ? p : { ri, ci }))
              setActiveCell(null)
            }
          }}
          onPointerUp={() => { rowDragRef.current = null; if (isFillDragging) executeFill() }}
        >
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
                <th
                  className="sticky left-9 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 text-xs text-slate-400 text-center font-normal"
                  style={{ width: rowHeaderWidth, minWidth: rowHeaderWidth }}
                  rowSpan={3}>#</th>

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
                {allColumns.map((col, colIdx) => {
                  const c = gColor(colToGroup.get(col.id)?.color ?? 'slate')
                  const w = colWidths[col.id] ?? col.width
                  return (
                    <th key={`en-${col.id}`}
                      style={{ minWidth: w, width: w, cursor: 'pointer', ...(colIdx < frozenColCount ? { position: 'sticky' as const, left: stickyLeftByColIdx[colIdx] ?? 0, zIndex: 25 } : {}) }}
                      className={cn('relative group/th px-2 py-0.5 text-left text-xs font-semibold border-b border-r border-slate-200 dark:border-slate-700 whitespace-nowrap select-none hover:bg-blue-50/50 dark:hover:bg-blue-950/10', c.text,
                        col.required && 'font-bold',
                        colIdx < frozenColCount && 'bg-white dark:bg-slate-900')}
                      title={col.description}
                      onClick={() => {
                        const maxRi = displayRows.length - 1
                        setSelAnchor({ ri: 0, ci: colIdx })
                        setSelEnd({ ri: maxRi, ci: colIdx })
                        setIsEditing(false)
                        const firstRow = displayRows[0]
                        if (firstRow) setActiveCell({ rowId: firstRow._rowId as string, colId: col.id })
                      }}>
                      {col.labelEn}{col.required && <span className="ml-0.5 text-red-500">*</span>}
                      {/* FF.41 Freeze pin */}
                      <button
                        type="button"
                        className={cn(
                          'ml-1 p-0.5 rounded-sm opacity-0 group-hover/th:opacity-100 transition-opacity flex-shrink-0',
                          colIdx < frozenColCount
                            ? 'text-blue-500 opacity-100'
                            : 'text-slate-400 hover:text-blue-500',
                        )}
                        title={colIdx < frozenColCount ? 'Unfreeze columns' : 'Freeze columns up to here'}
                        onClick={(e) => {
                          e.stopPropagation()
                          setFrozenColCount(colIdx < frozenColCount ? colIdx : colIdx + 1)
                        }}
                      >
                        <Pin className="w-3 h-3" />
                      </button>
                      {/* Push values to markets — column shortcut */}
                      {col.kind === 'enum' && col.options && col.options.length > 0 && (
                        <button
                          type="button"
                          className="ml-0.5 p-0.5 rounded-sm opacity-0 group-hover/th:opacity-100 transition-opacity flex-shrink-0 text-slate-400 hover:text-violet-500"
                          title="Translate values for this column to other markets…"
                          onClick={(e) => { e.stopPropagation(); setPushPanel({ tab: 'translate', preselectedCol: col }) }}
                        >
                          <ArrowRightLeft className="w-3 h-3" />
                        </button>
                      )}
                      {/* Resize handle — drag to resize, double-click to reset */}
                      <div
                        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize group/colresize flex items-center justify-center z-10"
                        onMouseDown={(e) => { e.stopPropagation(); startColResize(e, col.id, w) }}
                        onDoubleClick={(e) => { e.stopPropagation(); setColWidths((p) => { const n = { ...p }; delete n[col.id]; return n }) }}
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
                {allColumns.map((col, colIdx) => {
                  const w = colWidths[col.id] ?? col.width
                  return (
                    <th key={`it-${col.id}`}
                      style={{ minWidth: w, width: w, ...(colIdx < frozenColCount ? { position: 'sticky' as const, left: stickyLeftByColIdx[colIdx] ?? 0, zIndex: 25 } : {}) }}
                      className={cn('px-2 py-0.5 text-left text-xs font-normal border-b border-r border-slate-200 dark:border-slate-700 whitespace-nowrap text-slate-400 dark:text-slate-500 italic',
                        colIdx < frozenColCount && 'bg-white dark:bg-slate-900')}>
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
                  rowHeaderWidth={rowHeaderWidth}
                  showRowImages={showRowImages}
                  imageSize={imageSize}
                  imagesByAsin={imagesByAsin}
                  isDraggingRow={draggingRowId === (row._rowId as string)}
                  dropIndicator={dropTarget?.rowId === (row._rowId as string) ? dropTarget.half : null}
                  normSel={normSel}
                  fillTarget={fillTarget}
                  isFillDragging={isFillDragging}
                  isEditing={isEditing}
                  editInitialChar={editInitialChar}
                  clipboardRange={clipboardRange}
                  onSelect={(checked) => setSelectedRows((prev) => { const n = new Set(prev); checked ? n.add(row._rowId as string) : n.delete(row._rowId as string); return n })}
                  onDeactivate={() => setIsEditing(false)}
                  onChange={(colId, val) => updateCell(row._rowId as string, colId, val)}
                  onLiveChange={(colId, val) => liveUpdateCell(row._rowId as string, colId, val)}
                  onPushSnapshot={pushSnapshot}
                  onNavigate={(colId, dir) => navigate(row._rowId as string, colId, dir)}
                  onRowResizeStart={(e) => startRowResize(e, rowHeight)}
                  onRowDragStart={() => setDraggingRowId(row._rowId as string)}
                  onRowDragEnd={() => { setDraggingRowId(null); setDropTarget(null) }}
                  onRowDragOver={(half) => setDropTarget((p) =>
                    p?.rowId === (row._rowId as string) && p?.half === half ? p : { rowId: row._rowId as string, half }
                  )}
                  onRowDrop={(half) => draggingRowId && reorderRow(draggingRowId, row._rowId as string, half)}
                  onCellPointerDown={handleCellPointerDown}
                  onCellDoubleClick={handleCellDoubleClick}
                  onRowSelect={(ri) => {
                    rowDragRef.current = ri
                    const maxCi = allColumns.length - 1
                    setSelAnchor({ ri, ci: 0 })
                    setSelEnd({ ri, ci: maxCi })
                    setIsEditing(false)
                    const row = displayRows[ri]
                    const col = allColumns[0]
                    if (row && col) setActiveCell({ rowId: row._rowId as string, colId: col.id })
                  }}
                  onFillHandlePointerDown={handleFillHandlePointerDown}
                  onFillDrop={handleFillDrop}
                  stickyLeftByColIdx={stickyLeftByColIdx}
                  cellErrors={cellErrors}
                  collapsedParents={collapsedParents}
                  matchKeys={matchKeys}
                  toneMap={toneMap}
                  onToggleCollapse={(rowId) => setCollapsedParents((prev) => {
                    const next = new Set(prev)
                    if (next.has(rowId)) next.delete(rowId)
                    else next.add(rowId)
                    return next
                  })}
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
                  <div className="flex items-center gap-2 relative">
                    <Button size="sm" variant="ghost"
                      onClick={() => setAddRowsPanel({ type: 'row', position: normSel ? 'below' : 'end' })}>
                      <Plus className="w-3.5 h-3.5 mr-1" />Add row
                    </Button>
                    <Button size="sm" variant="ghost"
                      onClick={() => setAddRowsPanel({ type: 'parent', position: normSel ? 'below' : 'end' })}>
                      <Plus className="w-3.5 h-3.5 mr-1" />Add parent
                    </Button>
                    <Button size="sm" variant="ghost"
                      onClick={() => setAddRowsPanel({ type: 'variant', position: normSel ? 'below' : 'end' })}>
                      <Plus className="w-3.5 h-3.5 mr-1" />Add variant
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

      {/* ── Status bar ─────────────────────────────────────── */}
      {manifest && (
        <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-1 flex items-center gap-4 text-xs text-slate-400 select-none flex-shrink-0">
          <span>{displayRows.length} row{displayRows.length !== 1 ? 's' : ''}</span>
          {normSel && (() => {
            const rCount = normSel.rMax - normSel.rMin + 1
            const cCount = normSel.cMax - normSel.cMin + 1
            const total = rCount * cCount
            return (
              <span className="text-blue-500">
                {total === 1 ? '1 cell' : `${rCount} × ${cCount} = ${total} cells`} selected
              </span>
            )
          })()}
          {dirtyRows.length > 0 && (
            <span className="text-amber-500 ml-auto">{dirtyRows.length} unsaved change{dirtyRows.length !== 1 ? 's' : ''}</span>
          )}
          {clipboardRange && (
            <span className="text-green-500">
              {(clipboardRange.rMax - clipboardRange.rMin + 1) * (clipboardRange.cMax - clipboardRange.cMin + 1)} cells in clipboard
            </span>
          )}
          {(validErrorCount > 0 || validWarnCount > 0) && (
            <button
              type="button"
              onClick={() => setShowValidPanel((o) => !o)}
              className={cn(
                'flex items-center gap-1 ml-auto',
                validErrorCount > 0 ? 'text-red-500' : 'text-amber-500',
              )}
            >
              <AlertTriangle className="w-3 h-3" />
              {validErrorCount > 0 && <span>{validErrorCount} error{validErrorCount !== 1 ? 's' : ''}</span>}
              {validWarnCount > 0 && <span>{validWarnCount} warning{validWarnCount !== 1 ? 's' : ''}</span>}
            </button>
          )}
        </div>
      )}

      {/* FF.38 Validation panel */}
      {showValidPanel && manifest && (
        <div className="fixed right-4 bottom-12 w-80 max-h-96 overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl z-50">
          <div className="sticky top-0 bg-white dark:bg-slate-900 px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
              Validation
              {validErrorCount > 0 && <span className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300 px-1.5 rounded-full text-[10px]">{validErrorCount} error{validErrorCount !== 1 ? 's' : ''}</span>}
              {validWarnCount > 0 && <span className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 px-1.5 rounded-full text-[10px]">{validWarnCount} warning{validWarnCount !== 1 ? 's' : ''}</span>}
            </span>
            <button type="button" onClick={() => setShowValidPanel(false)} className="text-slate-400 hover:text-slate-600"><X className="w-3.5 h-3.5" /></button>
          </div>
          {cellErrors.size === 0 ? (
            <div className="px-3 py-4 text-xs text-center text-slate-400">No issues found</div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {[...cellErrors.entries()].slice(0, 200).map(([key, issue]) => {
                const [rowId, colId] = key.split(':')
                const rowIdx = displayRowsRef.current.findIndex((r) => r._rowId === rowId)
                const colIdx = allColumnsRef.current.findIndex((c) => c.id === colId)
                const col = allColumnsRef.current.find((c) => c.id === colId) ?? manifestColumns.find((c) => c.id === colId)
                const rowLabel = rowIdx >= 0 ? `Row ${rowIdx + 1}` : 'Row ?'
                return (
                  <button
                    key={key}
                    type="button"
                    className="w-full text-left px-3 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-start gap-2"
                    onClick={() => {
                      if (rowIdx < 0 || colIdx < 0) return
                      setSelAnchor({ ri: rowIdx, ci: colIdx })
                      setSelEnd({ ri: rowIdx, ci: colIdx })
                      const row = displayRowsRef.current[rowIdx]
                      if (row) setActiveCell({ rowId: row._rowId as string, colId })
                      requestAnimationFrame(() =>
                        document.querySelector(`[data-ri="${rowIdx}"][data-ci="${colIdx}"]`)
                          ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
                      )
                    }}
                  >
                    <span className={cn('mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0',
                      issue.level === 'error' ? 'bg-red-500' : 'bg-amber-400')} />
                    <div className="min-w-0">
                      <span className="text-[10px] text-slate-400">{rowLabel} · {col?.labelEn ?? colId}</span>
                      <p className="text-xs text-slate-700 dark:text-slate-300 truncate">{issue.msg}</p>
                    </div>
                  </button>
                )
              })}
              {cellErrors.size > 200 && (
                <div className="px-3 py-2 text-[10px] text-slate-400 text-center">
                  +{cellErrors.size - 200} more — fix shown issues first
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* BF.1 — Find & Replace */}
      {manifest && (
        <div className="fixed top-16 right-4 z-50">
          <FindReplaceBar
            open={findReplaceOpen}
            onClose={() => { setFindReplaceOpen(false); setMatchKeys(new Set()) }}
            cells={findCells}
            rangeBounds={normSel ? { minRow: normSel.rMin, maxRow: normSel.rMax, minCol: normSel.cMin, maxCol: normSel.cMax } : null}
            visibleColumns={allColumnsRef.current.map((c) => ({ id: c.id, label: c.labelEn }))}
            onActivate={(match) => {
              setSelAnchor({ ri: match.rowIdx, ci: match.colIdx })
              setSelEnd({ ri: match.rowIdx, ci: match.colIdx })
              const row = displayRows[match.rowIdx]
              if (row) setActiveCell({ rowId: row._rowId as string, colId: match.columnId })
              requestAnimationFrame(() =>
                document.querySelector(`[data-ri="${match.rowIdx}"][data-ci="${match.colIdx}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
              )
            }}
            onMatchSetChange={setMatchKeys}
            onReplaceCell={(rowId, columnId, newValue) => {
              pushSnapshot()
              setRows((prev) => prev.map((r) => r._rowId === rowId ? { ...r, [columnId]: newValue, _dirty: true } : r))
            }}
          />
        </div>
      )}

      {/* BF.2 — Conditional formatting */}
      {manifest && (
        <div className="fixed top-16 right-4 z-50">
          <ConditionalFormatBar
            open={cfOpen}
            onClose={() => setCfOpen(false)}
            rules={cfRules}
            onChange={setCfRules}
            visibleColumns={allColumnsRef.current.map((c) => ({ id: c.id, label: c.labelEn }))}
          />
        </div>
      )}

      {/* BM.2 — Replicate to multiple markets */}
      <FFReplicateModal
        open={replicateOpen}
        onClose={() => setReplicateOpen(false)}
        sourceMarket={marketplace}
        groups={manifest?.groups ?? []}
        rowCount={rows.length}
        selectedRowCount={selectedRows.size}
        onReplicate={handleReplicate}
      />

      {/* BF.4 — AI bulk actions */}
      <AIBulkModal
        open={aiModalOpen}
        onClose={() => setAiModalOpen(false)}
        selectedProductIds={[...selectedRows].flatMap((rowId) => {
          const row = rows.find((r) => r._rowId === rowId)
          return row?._productId ? [row._productId as string] : []
        })}
        marketplace={marketplace}
      />

      {pushPanel && manifest && (
        <PushToMarketsPanel
          initialTab={pushPanel.tab}
          preselectedCol={pushPanel.preselectedCol}
          manifest={manifest}
          rows={rows}
          enumColumns={manifestColumns.filter((c) => c.kind === 'enum' && c.options && c.options.length > 0)}
          sourceMarket={marketplace}
          productType={productType}
          onCopy={(targetMarket, colIds) => { handleCopyToMarket(targetMarket, colIds) }}
          onApplyTranslations={(columnMappings) => { handleApplyTranslations(columnMappings); setPushPanel(null) }}
          onClose={() => setPushPanel(null)}
        />
      )}

      {addRowsPanel && (
        <AddRowsPanel
          initialType={addRowsPanel.type}
          initialPosition={addRowsPanel.position}
          rows={rows}
          hasSelection={!!normSel}
          productType={productType}
          marketplace={marketplace}
          onAdd={handleAddRows}
          onClose={() => setAddRowsPanel(null)}
        />
      )}

      {submissionPanelOpen && (
        <SubmissionHistoryPanel
          history={submissionHistory}
          onClear={() => {
            setSubmissionHistory([])
            try { localStorage.removeItem(submissionHistoryKey(marketplace, productType)) } catch {}
          }}
          onClose={() => setSubmissionPanelOpen(false)}
        />
      )}

      {versionPanelOpen && (
        <VersionHistoryPanel
          marketplace={marketplace}
          productType={productType}
          currentRows={rows}
          onRestore={(versionRows) => {
            pushSnapshot()
            setRows(versionRows)
            setVersionPanelOpen(false)
          }}
          onClose={() => setVersionPanelOpen(false)}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          canPaste={true}
          hasSelection={!!normSel}
          selRowCount={normSel ? normSel.rMax - normSel.rMin + 1 : 0}
          onCut={() => { handleCut(); setClipboardRange(normSel) }}
          onCopy={() => { handleCopy(); setClipboardRange(normSel) }}
          onPaste={() => void handlePaste()}
          onAddRows={() => {
            setContextMenu(null)
            setAddRowsPanel({ type: 'row', position: 'below' })
          }}
          onInsertAbove={() => {
            if (!selAnchor) return
            pushSnapshot()
            const ri = selAnchor.ri
            const newRow = makeEmptyRow(productType, marketplace)
            setRows(prev => {
              const displayed = displayRowsRef.current
              if (ri >= displayed.length) return [...prev, newRow]
              const targetId = displayed[ri]._rowId as string
              const idx = prev.findIndex(r => r._rowId === targetId)
              if (idx === -1) return prev
              const next = [...prev]; next.splice(idx, 0, newRow); return next
            })
          }}
          onInsertBelow={() => {
            if (!selAnchor) return
            pushSnapshot()
            const ri = selAnchor.ri
            const newRow = makeEmptyRow(productType, marketplace)
            setRows(prev => {
              const displayed = displayRowsRef.current
              const targetRi = Math.min(ri + 1, displayed.length - 1)
              if (targetRi >= displayed.length) return [...prev, newRow]
              const targetId = displayed[targetRi]._rowId as string
              const idx = prev.findIndex(r => r._rowId === targetId)
              if (idx === -1) return [...prev, newRow]
              const next = [...prev]; next.splice(idx, 0, newRow); return next
            })
          }}
          onDeleteRows={() => {
            if (!normSel) return
            pushSnapshot()
            const toDelete = new Set(
              displayRowsRef.current.slice(normSel.rMin, normSel.rMax + 1).map(r => r._rowId as string)
            )
            setRows(prev => prev.filter(r => !toDelete.has(r._rowId as string)))
            setSelAnchor(null); setSelEnd(null)
          }}
          onClearCells={handleDeleteCells}
          onClose={() => setContextMenu(null)}
        />
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
  rowHeaderWidth: number
  showRowImages: boolean
  imageSize: number
  imagesByAsin: Record<string, string | null>
  isDraggingRow: boolean
  dropIndicator: 'top' | 'bottom' | null
  normSel: NormSel | null
  fillTarget: NormSel | null
  isFillDragging: boolean
  isEditing: boolean
  editInitialChar: string | null
  clipboardRange: NormSel | null
  stickyLeftByColIdx: Record<number, number>
  cellErrors: Map<string, ValidationIssue>
  collapsedParents: Set<string>
  matchKeys: Set<string>
  toneMap: Map<string, string>
  onToggleCollapse: (rowId: string) => void
  onSelect: (c: boolean) => void
  onDeactivate: () => void; onChange: (colId: string, val: unknown) => void
  onLiveChange: (colId: string, val: string) => void
  onPushSnapshot: () => void
  onNavigate: (colId: string, dir: 'right' | 'left' | 'down' | 'up') => void
  onRowResizeStart: (e: React.MouseEvent) => void
  onRowDragStart: () => void
  onRowDragEnd: () => void
  onRowDragOver: (half: 'top' | 'bottom') => void
  onRowDrop: (half: 'top' | 'bottom') => void
  onCellPointerDown: (ri: number, ci: number, shiftKey: boolean) => void
  onCellDoubleClick: (ri: number, ci: number) => void
  onRowSelect: (ri: number) => void
  onFillHandlePointerDown: (ri: number, ci: number) => void
  onFillDrop: () => void
}

function SpreadsheetRow({ row, rowIdx, columns, colToGroup, selected, activeCell,
  marketplace, colWidths, rowHeight, rowHeaderWidth, showRowImages, imageSize, imagesByAsin,
  isDraggingRow, dropIndicator,
  normSel, fillTarget, isFillDragging, isEditing, editInitialChar, clipboardRange,
  stickyLeftByColIdx, cellErrors, collapsedParents, onToggleCollapse,
  matchKeys, toneMap,
  onSelect, onDeactivate, onChange, onLiveChange, onPushSnapshot, onNavigate, onRowResizeStart,
  onRowDragStart, onRowDragEnd, onRowDragOver, onRowDrop,
  onCellPointerDown, onCellDoubleClick, onRowSelect, onFillHandlePointerDown, onFillDrop }: RowProps) {
  const rowId = row._rowId as string
  const status = row._status
  const canDragRef = useRef(false)
  const isParent = row.parentage_level === 'parent'
  const isChild  = row.parentage_level === 'child'

  const rowBg = status === 'success' ? 'bg-emerald-50/70 dark:bg-emerald-950/20'
    : status === 'error' ? 'bg-red-50/70 dark:bg-red-950/20'
    : status === 'pending' ? 'bg-amber-50/70 dark:bg-amber-950/20'
    : row._isNew ? 'bg-sky-50/40 dark:bg-sky-950/10'
    : row._dirty ? 'bg-yellow-50/40 dark:bg-yellow-950/10'
    : ''

  // Solid (opaque) equivalent for sticky cells — prevents content bleed-through on scroll
  const frozenBg = status === 'success' ? 'bg-emerald-50 dark:bg-emerald-950/60'
    : status === 'error' ? 'bg-red-50 dark:bg-red-950/60'
    : status === 'pending' ? 'bg-amber-50 dark:bg-amber-950/60'
    : row._isNew ? 'bg-sky-50 dark:bg-sky-950/40'
    : row._dirty ? 'bg-yellow-50 dark:bg-yellow-950/40'
    : 'bg-white dark:bg-slate-900'

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
        className={cn('sticky left-0 z-10 border-b border-r border-slate-200 dark:border-slate-700 px-1.5 w-9 text-center cursor-grab active:cursor-grabbing', frozenBg)}
        onMouseDown={() => { canDragRef.current = true }}
        onMouseUp={() => { canDragRef.current = false }}
      >
        {status === 'success' ? <CheckCircle2 className="w-3 h-3 text-emerald-500 mx-auto" />
          : status === 'error' ? <span title={row._feedMessage as string | undefined}><AlertCircle className="w-3 h-3 text-red-500 mx-auto" /></span>
          : status === 'pending' ? <Loader2 className="w-3 h-3 text-amber-500 animate-spin mx-auto" />
          : <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} className="w-3.5 h-3.5 accent-blue-600" />}
      </td>
      {/* Row # + ASIN badge + row-height resize handle */}
      <td
        data-row-ri={rowIdx}
        className={cn(
          'sticky left-9 z-10 border-b border-r border-slate-200 dark:border-slate-700 px-0.5 relative group/rowresize select-none',
          frozenBg,
          isChild && 'border-l-2 border-l-blue-200 dark:border-l-blue-800',
          // IN.1 — amber left-border when price is overriding master AND has drifted
          (row._fieldStates as any)?.price === 'OVERRIDE' &&
            (row._masterValues as any)?.price != null &&
            row.purchasable_offer__our_price !== String((row._masterValues as any).price) &&
            'border-l-2 border-l-amber-400 dark:border-l-amber-500',
        )}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.releasePointerCapture(e.pointerId)
          onRowSelect(rowIdx)
        }}
        style={{ cursor: 'ns-resize', width: rowHeaderWidth, minWidth: rowHeaderWidth, height: rowHeight }}>
        <div
          className={cn('flex flex-col gap-0.5 w-full', showRowImages ? 'items-center' : 'items-end')}
          style={{ minHeight: rowHeight, justifyContent: 'center', padding: '4px 1px' }}
        >
          {/* Product image */}
          {showRowImages && (() => {
            const asin = row._asin ? String(row._asin) : null
            const imgUrl = asin ? imagesByAsin[asin] : null
            if (asin && imgUrl) {
              return (
                <img
                  src={imgUrl}
                  alt=""
                  className="object-contain rounded flex-shrink-0"
                  style={{ width: imageSize, height: imageSize, maxWidth: rowHeaderWidth - 4 }}
                  draggable={false}
                />
              )
            }
            if (asin && imgUrl === null) {
              // loading (null = pending)
              return (
                <div
                  className="rounded bg-slate-100 dark:bg-slate-800 animate-pulse flex-shrink-0"
                  style={{ width: imageSize, height: imageSize }}
                />
              )
            }
            if (showRowImages) {
              // no ASIN — grey placeholder
              return (
                <div
                  className="rounded border border-dashed border-slate-200 dark:border-slate-700 flex items-center justify-center flex-shrink-0"
                  style={{ width: imageSize, height: imageSize }}
                >
                  <ImageIcon className="text-slate-300 dark:text-slate-600" style={{ width: imageSize * 0.4, height: imageSize * 0.4 }} />
                </div>
              )
            }
            return null
          })()}

          {/* Row number + collapse toggle */}
          {!showRowImages && (
            <div className="flex items-center gap-0.5 w-full justify-end">
              {isParent && (
                <button
                  type="button"
                  className="p-0 text-slate-400 hover:text-slate-600 flex-shrink-0"
                  onClick={(e) => { e.stopPropagation(); onToggleCollapse(rowId) }}
                  title={collapsedParents.has(rowId) ? 'Expand children' : 'Collapse children'}
                >
                  {collapsedParents.has(rowId)
                    ? <ChevronRight className="w-3 h-3" />
                    : <ChevronDown className="w-3 h-3" />}
                </button>
              )}
              {isChild && <span className="w-3 flex-shrink-0" />}
              <span className={cn('text-xs text-slate-400 tabular-nums', isChild && 'ml-1')}>{rowIdx + 1}</span>
            </div>
          )}
          {showRowImages && (
            <span className="text-[9px] text-slate-400 tabular-nums leading-none">{rowIdx + 1}</span>
          )}

          {/* ASIN link — always when images off; also for M/L/XL when images on */}
          {(!showRowImages || imageSize >= 48) && row._asin ? (() => {
            const asin = String(row._asin)
            const domain = AMAZON_DOMAIN[marketplace] ?? 'amazon.com'
            return (
              <a
                href={`https://www.${domain}/dp/${asin}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[9px] font-mono text-blue-500 hover:text-blue-700 hover:underline leading-none block w-full truncate text-center z-10 relative"
                title={`ASIN: ${asin} — open on ${domain}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
              >{asin}</a>
            )
          })() : null}

          {/* Listing status — same visibility rule as ASIN */}
          {(!showRowImages || imageSize >= 48) && row._listingStatus != null && (() => {
            const s = String(row._listingStatus)
            const cls = (s === 'ACTIVE' || s === 'BUYABLE')
              ? 'text-emerald-600 dark:text-emerald-400'
              : s === 'INACTIVE' ? 'text-amber-500 dark:text-amber-400'
              : 'text-red-500 dark:text-red-400'
            return <span className={cn('text-[9px] font-semibold leading-none', cls)}>{s.slice(0, 4)}</span>
          })()}

          {/* IN.1 — Override badge: shows when any field has followMaster*=false */}
          {(!showRowImages || imageSize >= 48) && (
            <OverrideBadge
              listingId={row._listingId as string | null | undefined}
              fieldStates={row._fieldStates as any}
              masterValues={row._masterValues as any}
            />
          )}
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
      {columns.map((col, ci) => {
        const isActive = activeCell?.rowId === rowId && activeCell?.colId === col.id
        const groupColor = colToGroup.get(col.id)?.color ?? 'slate'
        const w = colWidths[col.id] ?? col.width
        const validIssue = cellErrors.get(`${rowId}:${col.id}`)
        const stickyLeft = stickyLeftByColIdx[ci]

        const isSelected = normSel
          ? rowIdx >= normSel.rMin && rowIdx <= normSel.rMax && ci >= normSel.cMin && ci <= normSel.cMax
          : false

        const selEdges = isSelected && normSel ? {
          top:    rowIdx === normSel.rMin,
          bottom: rowIdx === normSel.rMax,
          left:   ci === normSel.cMin,
          right:  ci === normSel.cMax,
        } : null

        const isCorner = !!(normSel && !isFillDragging
          && rowIdx === normSel.rMax && ci === normSel.cMax)

        const isFillTarget = !!(fillTarget
          && rowIdx >= fillTarget.rMin && rowIdx <= fillTarget.rMax
          && ci >= fillTarget.cMin && ci <= fillTarget.cMax)

        const fillTargetEdges = isFillTarget && fillTarget ? {
          top:    rowIdx === fillTarget.rMin,
          bottom: rowIdx === fillTarget.rMax,
          left:   ci === fillTarget.cMin,
          right:  ci === fillTarget.cMax,
        } : null

        const isCellEditing = isEditing && isActive

        const isClipboard = !!(clipboardRange
          && rowIdx >= clipboardRange.rMin && rowIdx <= clipboardRange.rMax
          && ci >= clipboardRange.cMin && ci <= clipboardRange.cMax)

        const clipboardEdges = isClipboard && clipboardRange ? {
          top:    rowIdx === clipboardRange.rMin,
          bottom: rowIdx === clipboardRange.rMax,
          left:   ci === clipboardRange.cMin,
          right:  ci === clipboardRange.cMax,
        } : null

        const isMatch = matchKeys.has(`${rowIdx}:${ci}`)
        const toneCls = toneMap.get(`${rowIdx}:${col.id}`) ? TONE_CLASSES[toneMap.get(`${rowIdx}:${col.id}`)! as keyof typeof TONE_CLASSES] : undefined

        // Listing guidance: detect from applicableParentage on the column
        const guidanceLevel = (() => {
          if (!col.applicableParentage?.length) return null
          const parentage = String(row.parentage_level ?? '')
          const rowType = parentage.toLowerCase() === 'parent' ? 'VARIATION_PARENT'
            : parentage.toLowerCase() === 'child' ? 'VARIATION_CHILD'
            : 'STANDALONE'
          return col.applicableParentage.includes(rowType) ? null : 'not-applicable' as const
        })()

        return (
          <SpreadsheetCell
            key={col.id}
            col={col}
            value={row[col.id]}
            isActive={isActive}
            isEditing={isCellEditing}
            editInitialChar={isCellEditing ? editInitialChar : null}
            cellBg={stickyLeft !== undefined ? gColor(groupColor).band : gColor(groupColor).cell}
            grayed={false}
            width={w}
            cellHeight={rowHeight}
            isSelected={isSelected}
            selEdges={selEdges}
            isCorner={isCorner}
            isFillTarget={isFillTarget}
            fillTargetEdges={fillTargetEdges}
            isClipboard={isClipboard}
            clipboardEdges={clipboardEdges}
            isMatch={isMatch}
            toneCls={toneCls}
            guidanceLevel={guidanceLevel}
            ri={rowIdx}
            ci={ci}
            onCellPointerDown={(shiftKey) => onCellPointerDown(rowIdx, ci, shiftKey)}
            onCellDoubleClick={() => onCellDoubleClick(rowIdx, ci)}
            onFillHandlePointerDown={() => onFillHandlePointerDown(rowIdx, ci)}
            onFillDrop={onFillDrop}
            onDeactivate={onDeactivate}
            onChange={(v) => onChange(col.id, v)}
            onLiveChange={(val) => onLiveChange(col.id, val)}
            onPushSnapshot={onPushSnapshot}
            onNavigate={(dir) => onNavigate(col.id, dir)}
            validIssue={validIssue}
            stickyLeft={stickyLeft}
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
  grayed: boolean
  width: number
  cellHeight: number
  ri: number; ci: number
  isSelected: boolean
  selEdges: { top: boolean; right: boolean; bottom: boolean; left: boolean } | null
  isCorner: boolean
  isFillTarget: boolean
  fillTargetEdges: { top: boolean; right: boolean; bottom: boolean; left: boolean } | null
  isEditing: boolean
  editInitialChar: string | null
  isClipboard: boolean
  clipboardEdges: { top: boolean; right: boolean; bottom: boolean; left: boolean } | null
  validIssue?: ValidationIssue
  stickyLeft?: number
  /** BF.1 — cell is a find-replace match */
  isMatch?: boolean
  /** BF.2 — conditional formatting tone class */
  toneCls?: string
  /** Listing guidance: not-applicable = dark gray; optional = light gray */
  guidanceLevel?: 'not-applicable' | 'optional' | null
  onCellPointerDown: (shiftKey: boolean) => void
  onCellDoubleClick: () => void
  onFillHandlePointerDown: () => void
  onFillDrop: () => void
  onDeactivate: () => void
  onChange: (val: unknown) => void
  onLiveChange: (val: string) => void
  onPushSnapshot: () => void
  onNavigate: (dir: 'right' | 'left' | 'down' | 'up') => void
}

// ── Text editing helpers ───────────────────────────────────────────────

function getCharIndexFromPoint(x: number, y: number): number {
  if (typeof document === 'undefined') return -1
  if ('caretRangeFromPoint' in document) {
    const range = (document as any).caretRangeFromPoint(x, y) as Range | null
    if (range?.startContainer?.nodeType === Node.TEXT_NODE) return range.startOffset
  }
  if ('caretPositionFromPoint' in document) {
    const pos = (document as any).caretPositionFromPoint(x, y) as { offsetNode: Node; offset: number } | null
    if (pos?.offsetNode?.nodeType === Node.TEXT_NODE) return pos.offset
  }
  return -1
}

function wordBoundsAt(text: string, pos: number): [number, number] {
  if (!text) return [0, 0]
  const p = Math.min(Math.max(pos, 0), text.length)
  const isWordChar = /\w/
  let start = p
  while (start > 0 && isWordChar.test(text[start - 1])) start--
  let end = p
  while (end < text.length && isWordChar.test(text[end])) end++
  return start === end ? [p, p] : [start, end]
}

function SpreadsheetCell({ col, value, isActive, cellBg, width, cellHeight, ri, ci,
  isSelected, selEdges, isCorner, isFillTarget, fillTargetEdges,
  isEditing, editInitialChar, isClipboard, clipboardEdges,
  validIssue, stickyLeft, isMatch, toneCls,
  guidanceLevel,
  onCellPointerDown, onCellDoubleClick, onFillHandlePointerDown, onFillDrop,
  onDeactivate, onChange, onLiveChange, onPushSnapshot, onNavigate }: CellProps) {
  const displayValue = value != null ? String(value) : ''
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [liveLen, setLiveLen] = useState(displayValue.length)
  const cancelledRef = useRef(false)
  const pendingWordSelRef = useRef<{ start: number; end: number } | null | undefined>(undefined)
  // undefined = F2 entry (select all), null = dblclick but no word found (cursor end), {start,end} = word found
  const originalValueRef = useRef('')
  const snapshotPushedRef = useRef(false)

  useEffect(() => {
    if (!isEditing || col.kind === 'enum' || !inputRef.current) return
    inputRef.current.focus()
    if (editInitialChar !== null) return // key-triggered entry: browser handles selection

    const pending = pendingWordSelRef.current
    if (pending !== undefined) {
      // Double-click triggered: apply stored word selection
      requestAnimationFrame(() => {
        const inp = inputRef.current as HTMLInputElement | null
        if (!inp) return
        if (pending !== null) {
          inp.setSelectionRange(pending.start, pending.end)
        } else {
          inp.setSelectionRange(displayValue.length, displayValue.length)
        }
        pendingWordSelRef.current = undefined // reset for next time
      })
      return
    }

    // F2 / programmatic: select all
    if ('select' in inputRef.current) {
      (inputRef.current as HTMLInputElement).select()
    }
  }, [isEditing, col.kind, editInitialChar])

  useEffect(() => {
    if (isEditing) {
      snapshotPushedRef.current = false
    }
  }, [isEditing])

  // Reset counter to committed value length each time cell becomes editing
  useEffect(() => { if (isEditing) setLiveLen(displayValue.length) }, [isEditing])

  const isEmpty = !displayValue
  const cellStyle: React.CSSProperties = { minWidth: width, width, ...(stickyLeft !== undefined ? { position: 'sticky' as const, left: stickyLeft, zIndex: 4 } : {}) }
  const hStyle = { height: cellHeight }

  const selStyle: React.CSSProperties = selEdges ? {
    borderTop:    selEdges.top    ? '2px solid #3b82f6' : undefined,
    borderRight:  selEdges.right  ? '2px solid #3b82f6' : undefined,
    borderBottom: selEdges.bottom ? '2px solid #3b82f6' : undefined,
    borderLeft:   selEdges.left   ? '2px solid #3b82f6' : undefined,
  } : fillTargetEdges ? {
    borderTop:    fillTargetEdges.top    ? '2px dashed #3b82f6' : undefined,
    borderRight:  fillTargetEdges.right  ? '2px dashed #3b82f6' : undefined,
    borderBottom: fillTargetEdges.bottom ? '2px dashed #3b82f6' : undefined,
    borderLeft:   fillTargetEdges.left   ? '2px dashed #3b82f6' : undefined,
  } : clipboardEdges ? {
    borderTop:    clipboardEdges.top    ? '2px dashed #22c55e' : undefined,
    borderRight:  clipboardEdges.right  ? '2px dashed #22c55e' : undefined,
    borderBottom: clipboardEdges.bottom ? '2px dashed #22c55e' : undefined,
    borderLeft:   clipboardEdges.left   ? '2px dashed #22c55e' : undefined,
  } : {}

  const guidanceCls = !isActive && !isSelected && !isMatch && !toneCls
    ? guidanceLevel === 'not-applicable' ? 'bg-slate-200 dark:bg-slate-700/70'
    : guidanceLevel === 'optional'       ? 'bg-slate-100/80 dark:bg-slate-800/60'
    : ''
    : ''

  const guidanceTitle = guidanceLevel === 'not-applicable'
    ? col.applicableParentage?.length
      ? `Not needed for this row type — typically set on ${col.applicableParentage.map((p) => p.replace('VARIATION_', '').toLowerCase()).join(' or ')} rows only`
      : 'Not applicable for this product configuration'
    : undefined

  const baseCls = cn(
    'border-b border-r border-slate-200 dark:border-slate-700 relative transition-colors',
    isSelected ? 'bg-blue-100/60 dark:bg-blue-900/20'
    : isClipboard ? 'bg-green-50/40 dark:bg-green-900/10'
    : isFillTarget ? 'bg-blue-50/80 dark:bg-blue-900/10'
    : isMatch ? 'bg-yellow-100 dark:bg-yellow-900/30'
    : toneCls ? toneCls
    : guidanceCls || cellBg,
    isActive && !isEditing && 'outline outline-2 outline-blue-500 outline-offset-[-1px] z-[5]',
    isEditing && 'ring-2 ring-inset ring-blue-500 z-[5]',
    !isActive && !isSelected && !isMatch && !toneCls && !guidanceLevel && (
      validIssue?.level === 'error' ? 'bg-red-100/80 dark:bg-red-950/30'
      : validIssue?.level === 'warn' ? 'bg-amber-50/80 dark:bg-amber-950/20'
      : ''
    ),
  )

  const tdPointerDown = (e: React.PointerEvent<HTMLTableCellElement>) => {
    if (e.button !== 0) return
    const tag = (e.target as HTMLElement).tagName
    // While editing, let clicks on the input/textarea pass through so the browser
    // can reposition the cursor naturally — don't exit edit mode or reset selection.
    if (isEditing && (tag === 'INPUT' || tag === 'TEXTAREA')) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    onCellPointerDown(e.shiftKey)
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Tab') { e.preventDefault(); onNavigate(e.shiftKey ? 'left' : 'right') }
    else if (e.key === 'Enter' && col.kind !== 'longtext') { e.preventDefault(); onNavigate(e.shiftKey ? 'up' : 'down') }
    else if (e.key === 'Escape') {
      if (snapshotPushedRef.current) {
        onLiveChange(originalValueRef.current) // revert to pre-edit value
        snapshotPushedRef.current = false
      }
      cancelledRef.current = true
      onDeactivate(); setDropdownOpen(false)
    }
    else if (e.key === 'ArrowDown' && col.kind === 'enum') { e.preventDefault(); setDropdownOpen(true) }
  }

  const fillHandle = isCorner ? (
    <div
      className="absolute bottom-[-3px] right-[-3px] w-[7px] h-[7px] bg-blue-500 border-[1.5px] border-white dark:border-slate-900 z-20 cursor-crosshair"
      onPointerDown={(e) => {
        e.stopPropagation()
        e.preventDefault()
        // Release capture so container pointermove tracks the fill drag
        e.currentTarget.releasePointerCapture(e.pointerId)
        onFillHandlePointerDown()
      }}
    />
  ) : null

  // Shared td props — data-ri/ci let the container's pointermove identify which cell the pointer is over
  const tdShared = {
    'data-ri': ri, 'data-ci': ci,
    onPointerDown: tdPointerDown,
    onPointerUp: onFillDrop,
    onDoubleClick: (e: React.MouseEvent) => {
      // Compute word bounds NOW while static text node is still in DOM
      const charPos = getCharIndexFromPoint(e.clientX, e.clientY)
      if (charPos >= 0) {
        const [s, end] = wordBoundsAt(displayValue, charPos)
        pendingWordSelRef.current = { start: s, end }
      } else {
        pendingWordSelRef.current = null // dblclick but no word — cursor at end
      }
      onCellDoubleClick()
    },
  }

  // Enum cell: custom dropdown
  if (col.kind === 'enum' && col.options && col.options.length > 0) {
    return (
      <td {...tdShared} className={baseCls} style={{ ...cellStyle, ...selStyle }}
        onClick={() => { if (isActive) setDropdownOpen(true) }}
        onDoubleClick={(e) => {
          const charPos = getCharIndexFromPoint(e.clientX, e.clientY)
          pendingWordSelRef.current = charPos >= 0
            ? (() => { const [s, end] = wordBoundsAt(displayValue, charPos); return { start: s, end } })()
            : null
          onCellDoubleClick()
          setDropdownOpen(true)
        }}>
        <div className="px-1.5 flex items-center justify-between gap-1 cursor-pointer group/cell" style={hStyle}>
          <span className={cn('text-xs truncate flex-1', isEmpty ? 'text-slate-300 dark:text-slate-600 italic' : 'text-slate-800 dark:text-slate-200')}>
            {displayValue || (col.required ? '⚠ required' : col.options[0] ? `e.g. ${col.options[0]}` : '—')}
          </span>
          <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0 opacity-0 group-hover/cell:opacity-100 transition-opacity" />
        </div>
        {fillHandle}
        {isActive && dropdownOpen && (
          <EnumDropdown
            options={col.options}
            current={displayValue}
            selectionOnly={col.selectionOnly}
            onSelect={(v) => { onChange(v); setDropdownOpen(false); onNavigate('right') }}
            onClose={() => { setDropdownOpen(false); onDeactivate() }}
          />
        )}
      </td>
    )
  }

  // Longtext cell
  if (col.kind === 'longtext') {
    if (isEditing) {
      const atLimit = col.maxLength != null && liveLen >= col.maxLength
      const nearLimit = col.maxLength != null && liveLen >= col.maxLength * 0.8
      return (
        <td {...tdShared} className={baseCls} style={{ ...cellStyle, ...selStyle }}>
          {fillHandle}
          <textarea ref={inputRef as any} defaultValue={editInitialChar !== null ? editInitialChar : displayValue}
            onInput={(e) => {
              const val = (e.target as HTMLTextAreaElement).value
              setLiveLen(val.length)
              if (!snapshotPushedRef.current) {
                originalValueRef.current = displayValue
                onPushSnapshot()
                snapshotPushedRef.current = true
              }
              onLiveChange(val)
            }}
            onBlur={() => {
              cancelledRef.current = false
              onDeactivate()
            }}
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
      <td {...tdShared} className={cn(baseCls, 'cursor-pointer hover:bg-white/50 dark:hover:bg-slate-700/30')}
        style={{ ...cellStyle, ...selStyle }}>
        {fillHandle}
        <div className="px-1.5 flex items-center text-xs text-slate-800 dark:text-slate-200 truncate" style={hStyle}>
          {displayValue || <span className="text-slate-300 dark:text-slate-600 italic">{col.required ? '⚠ required' : ''}</span>}
        </div>
      </td>
    )
  }

  // Text / number cell
  if (isEditing) {
    const atLimit = col.maxLength != null && liveLen >= col.maxLength
    const nearLimit = col.maxLength != null && liveLen >= col.maxLength * 0.8
    return (
      <td {...tdShared} className={baseCls} style={{ ...cellStyle, ...selStyle }}>
        {fillHandle}
        <input ref={inputRef as any} type={col.kind === 'number' ? 'number' : 'text'}
          defaultValue={editInitialChar !== null ? editInitialChar : displayValue} maxLength={col.maxLength}
          onInput={(e) => {
            const val = (e.target as HTMLInputElement).value
            setLiveLen(val.length)
            if (!snapshotPushedRef.current) {
              originalValueRef.current = displayValue
              onPushSnapshot()
              snapshotPushedRef.current = true
            }
            onLiveChange(val)
          }}
          onBlur={() => {
            cancelledRef.current = false
            onDeactivate()
          }}
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
    <td {...tdShared} className={cn(baseCls, 'cursor-pointer hover:bg-white/50 dark:hover:bg-slate-700/30')}
      style={{ ...cellStyle, ...selStyle }} title={guidanceTitle ?? validIssue?.msg ?? col.description}>
      {fillHandle}
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
  /** When true the user must pick from the list; typed custom values are not allowed */
  selectionOnly?: boolean
  onSelect: (val: string) => void
  onClose: () => void
}

function EnumDropdown({ options, current, selectionOnly = false, onSelect, onClose }: EnumDropdownProps) {
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return options.filter((o) => !q || o.toLowerCase().includes(q))
  }, [options, query])

  const hasCustom = !selectionOnly && query.trim() !== '' && !options.includes(query.trim())
  const totalItems = filtered.length + (hasCustom ? 1 : 0)

  useEffect(() => { searchRef.current?.focus() }, [])
  useEffect(() => { setHighlighted(0) }, [filtered])

  useEffect(() => {
    const el = listRef.current?.children[highlighted] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (!listRef.current?.parentElement?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [onClose])

  function commit(idx: number) {
    if (idx === filtered.length && hasCustom) { onSelect(query.trim()); return }
    if (filtered[idx] != null) onSelect(filtered[idx])
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, totalItems - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); commit(highlighted) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'Tab') { e.preventDefault(); commit(highlighted) }
  }

  return (
    <div className="absolute left-0 top-full mt-0 z-50 w-48 min-w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg overflow-hidden"
      onKeyDown={handleKeyDown}>
      <div className="px-2 py-1.5 border-b border-slate-100 dark:border-slate-700">
        <input ref={searchRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={selectionOnly ? 'Search…' : 'Search or type a value…'}
          className="w-full text-xs px-1.5 py-1 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500" />
      </div>
      <div ref={listRef} className="max-h-52 overflow-y-auto">
        {filtered.map((opt, i) => (
          <div key={opt || '_empty'} role="option" aria-selected={opt === current}
            onMouseDown={(e) => { e.preventDefault(); onSelect(opt) }}
            onMouseEnter={() => setHighlighted(i)}
            className={cn(
              'px-3 py-1.5 text-xs cursor-pointer truncate',
              i === highlighted ? 'bg-blue-500 text-white'
              : opt === current ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 font-medium'
              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700/50',
            )}>
            {opt === '' ? <span className="italic opacity-60">— empty —</span> : opt}
          </div>
        ))}
        {filtered.length === 0 && !hasCustom && (
          <div className="px-3 py-2 text-xs text-slate-400 italic">No matches</div>
        )}
        {hasCustom && (
          <div role="option"
            onMouseDown={(e) => { e.preventDefault(); onSelect(query.trim()) }}
            onMouseEnter={() => setHighlighted(filtered.length)}
            className={cn(
              'px-3 py-1.5 text-xs cursor-pointer border-t border-slate-100 dark:border-slate-700 flex items-center gap-1.5',
              highlighted === filtered.length ? 'bg-blue-500 text-white'
              : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50',
            )}>
            <span className="opacity-60">Use</span>
            <span className="font-mono font-medium truncate">&ldquo;{query.trim()}&rdquo;</span>
          </div>
        )}
      </div>
    </div>
  )
}

// ── PushToMarketsPanel helpers ─────────────────────────────────────────

const MARKETPLACES_ALL = ['IT', 'DE', 'FR', 'ES', 'UK']

// Groups that are typically market-specific — pre-deselected by default
function isMarketSpecificGroup(id: string) {
  return /^offer_[A-Z0-9]/.test(id) || /^selling_/.test(id) || id === 'fulfillment'
}

// ── PushToMarketsPanel ─────────────────────────────────────────────────────

interface PushToMarketsPanelProps {
  initialTab: 'copy' | 'translate'
  preselectedCol?: Column
  manifest: Manifest
  rows: Row[]
  enumColumns: Column[]
  sourceMarket: string
  productType: string
  onCopy: (targetMarket: string, colIds: Set<string>) => void
  onApplyTranslations: (columnMappings: ColumnMappingEntry[]) => void
  onClose: () => void
}

function PushToMarketsPanel({
  initialTab, preselectedCol, manifest, rows, enumColumns,
  sourceMarket, productType, onCopy, onApplyTranslations, onClose,
}: PushToMarketsPanelProps) {
  const [tab, setTab] = useState<'copy' | 'translate'>(initialTab)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[1px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-4xl max-h-[92vh] flex flex-col mx-4">

        {/* Header */}
        <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between gap-4 flex-shrink-0">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Push to Markets</h2>
            <span className="text-xs text-slate-400">from <span className="font-medium text-slate-600 dark:text-slate-300">{sourceMarket}</span></span>
            {/* Tabs */}
            <div className="flex bg-slate-100 dark:bg-slate-800 rounded-lg p-0.5 gap-0.5">
              {(['copy', 'translate'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={cn(
                    'px-3 py-1 rounded-md text-xs font-medium transition-colors',
                    tab === t
                      ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 shadow-sm'
                      : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300',
                  )}
                >
                  {t === 'copy' ? (
                    <span className="flex items-center gap-1.5"><Copy className="w-3 h-3" />Copy rows</span>
                  ) : (
                    <span className="flex items-center gap-1.5"><ArrowRightLeft className="w-3 h-3" />Translate values</span>
                  )}
                </button>
              ))}
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600 flex-shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab content */}
        {tab === 'copy' ? (
          <CopyTabContent
            manifest={manifest}
            rows={rows}
            sourceMarket={sourceMarket}
            onCopy={onCopy}
            onClose={onClose}
          />
        ) : (
          <TranslateTabContent
            enumColumns={enumColumns}
            sourceMarket={sourceMarket}
            productType={productType}
            rows={rows}
            preselectedCol={preselectedCol}
            onApply={onApplyTranslations}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  )
}

// ── CopyTabContent ─────────────────────────────────────────────────────

interface CopyTabContentProps {
  manifest: Manifest
  rows: Row[]
  sourceMarket: string
  onCopy: (targetMarket: string, colIds: Set<string>) => void
  onClose: () => void
}

function CopyTabContent({ manifest, rows, sourceMarket, onCopy, onClose }: CopyTabContentProps) {
  const otherMarkets = MARKETPLACES_ALL.filter((m) => m !== sourceMarket)
  const [targetMarket, setTargetMarket] = useState(otherMarkets[0] ?? '')
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(
    () => new Set(manifest.groups.filter((g) => !isMarketSpecificGroup(g.id)).map((g) => g.id))
  )
  const [excludedCols, setExcludedCols] = useState<Set<string>>(new Set())
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

  function toggleGroup(id: string) {
    setSelectedGroups((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleCol(colId: string) {
    setExcludedCols((prev) => { const n = new Set(prev); n.has(colId) ? n.delete(colId) : n.add(colId); return n })
  }

  return (
    <>
      <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
        {/* Target market */}
        <div>
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">Target market</div>
          <div className="flex gap-1.5">
            {otherMarkets.map((m) => (
              <button key={m} type="button" onClick={() => setTargetMarket(m)}
                className={cn('text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors',
                  m === targetMarket
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-blue-400')}>
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Group + column selection */}
        <div>
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2">What to copy</div>
          <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto">
            {manifest.groups.map((g) => {
              const checked = selectedGroups.has(g.id)
              const isExpanded = expandedGroup === g.id
              const groupExcludedCount = g.columns.filter((c) => excludedCols.has(c.id)).length
              return (
                <div key={g.id}>
                  <div className="flex items-center gap-2 px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <input type="checkbox" checked={checked} onChange={() => toggleGroup(g.id)}
                      className="w-3.5 h-3.5 accent-blue-600 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <span className={cn('text-xs truncate', checked ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 line-through')}>
                        {g.labelLocal}
                        {g.labelEn !== g.labelLocal && <span className="ml-1 opacity-50">({g.labelEn})</span>}
                      </span>
                      {checked && groupExcludedCount > 0 && (
                        <span className="ml-1 text-xs text-amber-500">−{groupExcludedCount}</span>
                      )}
                    </div>
                    <span className="text-xs text-slate-400 tabular-nums flex-shrink-0">
                      {g.columns.length - (checked ? groupExcludedCount : 0)}
                    </span>
                    {checked && (
                      <button type="button" onClick={() => setExpandedGroup(isExpanded ? null : g.id)}
                        className="text-slate-400 hover:text-slate-600 flex-shrink-0" title="Expand to exclude specific columns">
                        <ChevronDown className={cn('w-3 h-3 transition-transform', isExpanded && 'rotate-180')} />
                      </button>
                    )}
                  </div>
                  {isExpanded && checked && (
                    <div className="ml-8 mr-4 mb-2 bg-slate-50 dark:bg-slate-800/50 rounded-lg p-2 grid grid-cols-2 gap-0.5 max-h-36 overflow-y-auto">
                      {g.columns.map((c) => {
                        const excluded = excludedCols.has(c.id)
                        return (
                          <label key={c.id} className="flex items-center gap-1.5 cursor-pointer">
                            <input type="checkbox" checked={!excluded} onChange={() => toggleCol(c.id)}
                              className="w-3 h-3 accent-blue-600 flex-shrink-0" />
                            <span className={cn('text-xs truncate', excluded ? 'text-slate-400 line-through' : 'text-slate-600 dark:text-slate-400')}>
                              {c.labelLocal}{c.required && <span className="ml-0.5 text-red-400">*</span>}
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
        </div>
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3 flex-shrink-0 bg-slate-50/50 dark:bg-slate-800/30 rounded-b-xl">
        <div className="text-xs text-slate-400">{selectedColIds.size} column{selectedColIds.size !== 1 ? 's' : ''} → {targetMarket}</div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => onCopy(targetMarket, selectedColIds)}
            disabled={!targetMarket || selectedColIds.size === 0}>
            <Copy className="w-3.5 h-3.5 mr-1.5" />
            Copy {rows.length} row{rows.length !== 1 ? 's' : ''}
          </Button>
        </div>
      </div>
    </>
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

// ── ApplyToPanel ───────────────────────────────────────────────────────
// Copy current row order + sort to other Amazon markets and/or eBay.
// Each target has a toggle: on=auto-sync (always propagated), off=manual only.
// "off" state is sticky — never auto-reset to true.

interface ApplyToPanelProps {
  currentMarket: string
  allMarkets: readonly string[]
  marketSync: Record<string, boolean>
  onToggleSync: (market: string) => void
  onApplyNow: (targets: string[]) => void
  onClose: () => void
}

function ApplyToPanel({
  currentMarket, allMarkets, marketSync, onToggleSync, onApplyNow, onClose,
}: ApplyToPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(allMarkets.filter((m) => m !== currentMarket))
  )

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [onClose])

  const targets = allMarkets.filter((m) => m !== currentMarket)
  const allSelected = targets.every((m) => selected.has(m))

  function toggle(m: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(m) ? next.delete(m) : next.add(m)
      return next
    })
  }

  return (
    <div ref={panelRef}
      className="absolute left-0 top-full mt-1 z-50 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden">

      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">Apply row order to…</div>
          <div className="text-xs text-slate-400">From {currentMarket} → other Amazon markets</div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
      </div>

      <div className="px-3 py-2 border-b border-slate-100 dark:border-slate-800">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide">Amazon markets</span>
          <button type="button" onClick={() => setSelected(allSelected ? new Set() : new Set(targets))}
            className="text-[10px] text-blue-500 hover:text-blue-600 font-medium">
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>
        {targets.map((m) => (
          <div key={m} className="flex items-center gap-2 py-1.5 border-b border-slate-50 dark:border-slate-800/60 last:border-0">
            {/* Apply-now checkbox */}
            <input type="checkbox" id={`apply-${m}`} checked={selected.has(m)} onChange={() => toggle(m)}
              className="rounded border-slate-300 text-blue-500 focus:ring-blue-400 cursor-pointer" />
            <label htmlFor={`apply-${m}`} className="flex-1 text-xs text-slate-700 dark:text-slate-300 cursor-pointer">
              Amazon {m}
            </label>
            {/* Auto-sync toggle */}
            <button
              type="button"
              onClick={() => onToggleSync(m)}
              title={marketSync[m] ? 'Auto-sync ON — turn off to make this market independent' : 'Auto-sync OFF — click to enable'}
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded font-medium transition-colors border',
                marketSync[m]
                  ? 'bg-blue-50 border-blue-200 text-blue-600 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-400'
                  : 'bg-slate-50 border-slate-200 text-slate-400 dark:bg-slate-800 dark:border-slate-700',
              )}
            >
              {marketSync[m] ? 'auto' : 'manual'}
            </button>
          </div>
        ))}
      </div>

      <div className="px-4 py-3 flex items-center gap-2">
        <div className="flex-1 text-[10px] text-slate-400">
          <span className="font-medium text-blue-500">auto</span> = propagates on every change ·{' '}
          <span className="font-medium text-slate-500">manual</span> = only when you click Apply
        </div>
        <Button size="sm" onClick={() => { onApplyNow([...selected]); onClose() }} disabled={selected.size === 0}>
          Apply now
        </Button>
      </div>
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
  footerExtra?: React.ReactNode
}

function SortPanel({ rows, groups, initial, onApply, onClose, footerExtra }: SortPanelProps) {
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
      {footerExtra && (
        <div className="border-t border-slate-100 dark:border-slate-800">
          {footerExtra}
        </div>
      )}
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

// ── TbBtn ──────────────────────────────────────────────────────────────
// Compact icon button for the icon toolbar. Shows a badge count when
// badge > 0. Tooltip via the native title attribute.

interface TbBtnProps {
  icon: React.ReactNode
  title: string
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  badge?: number
}

function TbBtn({ icon, title, onClick, disabled, active, badge }: TbBtnProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        'relative h-7 w-7 flex items-center justify-center rounded transition-colors flex-shrink-0',
        active
          ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
          : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100',
        'disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent dark:disabled:hover:bg-transparent disabled:hover:text-slate-600',
      )}
    >
      {icon}
      {badge != null && badge > 0 && (
        <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 px-0.5 text-[9px] font-bold bg-blue-500 text-white rounded-full flex items-center justify-center leading-none pointer-events-none">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
}

// ── TranslateTabContent ────────────────────────────────────────────────

interface ColumnMappingEntry {
  col: Column
  appliedMappings: Record<string, Record<string, string | null>>
}

interface TranslateTabContentProps {
  enumColumns: Column[]
  sourceMarket: string
  productType: string
  rows: Row[]
  preselectedCol?: Column
  onApply: (columnMappings: ColumnMappingEntry[]) => void
  onClose: () => void
}

function TranslateTabContent({ enumColumns, sourceMarket, productType, rows, preselectedCol, onApply, onClose }: TranslateTabContentProps) {
  const allMarkets = ['IT', 'DE', 'FR', 'ES', 'UK']
  const otherMarkets = allMarkets.filter((m) => m !== sourceMarket.toUpperCase())

  const [selectedColIds, setSelectedColIds] = useState<Set<string>>(() => {
    // If a specific column was pre-selected from the header button, select only that one
    if (preselectedCol) return new Set([preselectedCol.id])
    // Otherwise pre-select all columns that have values in current rows
    const s = new Set<string>()
    for (const col of enumColumns) {
      for (const row of rows) {
        if (row[col.id] != null && String(row[col.id]).trim()) { s.add(col.id); break }
      }
    }
    return s
  })
  const [selectedMarkets, setSelectedMarkets] = useState<Set<string>>(new Set(otherMarkets))
  const [translating, setTranslating] = useState(false)
  const [colResults, setColResults] = useState<Record<string, TranslateResult>>({})
  const [globalError, setGlobalError] = useState<string | null>(null)
  const [overrides, setOverrides] = useState<Record<string, Record<string, Record<string, string | null>>>>({})
  const [openDropdown, setOpenDropdown] = useState<{ colId: string; market: string; srcVal: string } | null>(null)
  const [collapsedCols, setCollapsedCols] = useState<Set<string>>(new Set())

  const valuesByCol = useMemo<Record<string, string[]>>(() => {
    const out: Record<string, string[]> = {}
    for (const col of enumColumns) {
      const seen = new Set<string>()
      for (const row of rows) {
        const v = row[col.id]
        if (v != null && String(v).trim()) seen.add(String(v).trim())
      }
      out[col.id] = [...seen].sort()
    }
    return out
  }, [enumColumns, rows])

  const selectedCols = enumColumns.filter((c) => selectedColIds.has(c.id))

  async function handleTranslate() {
    if (!selectedCols.length || !selectedMarkets.size) return
    setTranslating(true)
    setGlobalError(null)
    setOverrides({})
    setColResults({})
    setCollapsedCols(new Set())

    const settled = await Promise.allSettled(
      selectedCols.map(async (col) => {
        const values = valuesByCol[col.id]
        if (!values?.length) return { colId: col.id, result: null }
        const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/translate-values`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceMarket, productType, colId: col.id, colLabelEn: col.labelEn, values, targetMarkets: [...selectedMarkets] }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(`[${col.labelEn}] ${data.error ?? 'failed'}`)
        return { colId: col.id, result: data as TranslateResult }
      }),
    )

    const newResults: Record<string, TranslateResult> = {}
    const errors: string[] = []
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value.result) newResults[s.value.colId] = s.value.result
      else if (s.status === 'rejected') errors.push(s.reason?.message ?? 'Unknown error')
    }
    setColResults(newResults)
    if (errors.length) setGlobalError(errors.join(' · '))
    setTranslating(false)
  }

  function getEffectiveValue(colId: string, market: string, srcVal: string): string | null {
    if (overrides[colId]?.[market]?.[srcVal] !== undefined) return overrides[colId][market][srcVal]
    return colResults[colId]?.mappings[market]?.[srcVal]?.match ?? null
  }

  function handleApply() {
    const columnMappings: ColumnMappingEntry[] = []
    for (const col of selectedCols) {
      const result = colResults[col.id]
      if (!result) continue
      const appliedMappings: Record<string, Record<string, string | null>> = {}
      for (const market of selectedMarkets) {
        if (!result.mappings[market]) continue
        appliedMappings[market] = {}
        for (const srcVal of valuesByCol[col.id] ?? []) {
          appliedMappings[market][srcVal] = getEffectiveValue(col.id, market, srcVal)
        }
      }
      if (Object.keys(appliedMappings).length > 0) columnMappings.push({ col, appliedMappings })
    }
    onApply(columnMappings)
  }

  const hasResults = Object.keys(colResults).length > 0

  const confidenceCls = (c: ValueMapping['confidence']) =>
    c === 'high' ? 'text-emerald-600 dark:text-emerald-400'
    : c === 'medium' ? 'text-amber-500 dark:text-amber-400'
    : c === 'low' ? 'text-orange-500 dark:text-orange-400'
    : 'text-red-400 dark:text-red-500'
  const confidenceLabel = (c: ValueMapping['confidence']) =>
    c === 'high' ? '✓ high' : c === 'medium' ? '~ med' : c === 'low' ? '~ low' : '✗ none'

  return (
    <>
      <div className="overflow-y-auto flex-1">
        {!hasResults && (
          <div className="px-5 py-4 space-y-4">
            {/* Column picker */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-medium text-slate-600 dark:text-slate-400">Columns to translate ({selectedColIds.size} selected)</p>
                <div className="flex gap-2">
                  <button type="button" className="text-[11px] text-violet-600 hover:text-violet-700 dark:text-violet-400"
                    onClick={() => setSelectedColIds(new Set(enumColumns.filter((c) => (valuesByCol[c.id]?.length ?? 0) > 0).map((c) => c.id)))}>
                    Select all with values
                  </button>
                  <span className="text-slate-300">·</span>
                  <button type="button" className="text-[11px] text-slate-500 hover:text-slate-700 dark:text-slate-400"
                    onClick={() => setSelectedColIds(new Set())}>Clear</button>
                </div>
              </div>
              <div className="border border-slate-200 dark:border-slate-700 rounded-lg max-h-52 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
                {enumColumns.map((col) => {
                  const vals = valuesByCol[col.id] ?? []
                  const checked = selectedColIds.has(col.id)
                  return (
                    <label key={col.id} className={cn('flex items-center gap-3 px-3 py-2 cursor-pointer transition-colors',
                      checked ? 'bg-violet-50/60 dark:bg-violet-950/20' : 'hover:bg-slate-50 dark:hover:bg-slate-800/40',
                      !vals.length && 'opacity-50')}>
                      <input type="checkbox" checked={checked} disabled={!vals.length}
                        className="w-3.5 h-3.5 accent-violet-600 flex-shrink-0"
                        onChange={(e) => setSelectedColIds((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(col.id); else next.delete(col.id)
                          return next
                        })} />
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{col.labelEn}</span>
                        <span className="ml-1.5 text-[10px] font-mono text-slate-400">{col.id}</span>
                      </div>
                      {vals.length > 0 ? (
                        <div className="flex gap-1 flex-wrap justify-end max-w-[200px]">
                          {vals.slice(0, 3).map((v) => (
                            <span key={v} className="px-1.5 py-0.5 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded text-[10px] font-mono truncate max-w-[80px]">{v}</span>
                          ))}
                          {vals.length > 3 && <span className="text-[10px] text-slate-400">+{vals.length - 3}</span>}
                        </div>
                      ) : (
                        <span className="text-[10px] text-slate-400 italic">no values</span>
                      )}
                    </label>
                  )
                })}
                {enumColumns.length === 0 && (
                  <div className="px-3 py-4 text-xs text-slate-400 text-center italic">No enum columns in current view</div>
                )}
              </div>
            </div>

            {/* Target markets */}
            <div>
              <p className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-2">Target markets</p>
              <div className="flex gap-3 flex-wrap">
                {otherMarkets.map((m) => (
                  <label key={m} className="flex items-center gap-1.5 cursor-pointer group">
                    <input type="checkbox" checked={selectedMarkets.has(m)} className="w-3.5 h-3.5 accent-violet-600"
                      onChange={(e) => setSelectedMarkets((prev) => {
                        const next = new Set(prev); if (e.target.checked) next.add(m); else next.delete(m); return next
                      })} />
                    <span className="text-xs font-medium text-slate-700 dark:text-slate-300 group-hover:text-violet-600">{m}</span>
                  </label>
                ))}
              </div>
            </div>

            {globalError && (
              <div className="flex items-start gap-2 px-3 py-2 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg text-xs text-red-700 dark:text-red-400">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />{globalError}
              </div>
            )}
          </div>
        )}

        {hasResults && (
          <div className="divide-y divide-slate-100 dark:divide-slate-800">
            <div className="px-5 py-2.5 bg-slate-50 dark:bg-slate-800/40 flex items-center justify-between gap-4">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {Object.keys(colResults).length} column{Object.keys(colResults).length !== 1 ? 's' : ''} translated · click any cell to override
              </span>
              <button type="button" className="text-[11px] text-violet-600 hover:text-violet-700 dark:text-violet-400"
                onClick={() => { setColResults({}); setGlobalError(null) }}>← Edit selection</button>
            </div>

            {selectedCols.map((col) => {
              const result = colResults[col.id]
              if (!result) return null
              const vals = valuesByCol[col.id] ?? []
              const activeMarkets = [...selectedMarkets].filter((m) => result.mappings[m])
              const isCollapsed = collapsedCols.has(col.id)
              const matchCount = activeMarkets.reduce((n, m) =>
                n + vals.filter((v) => getEffectiveValue(col.id, m, v) !== null).length, 0)
              const totalPossible = activeMarkets.length * vals.length

              return (
                <div key={col.id}>
                  <button type="button"
                    className="w-full flex items-center justify-between gap-3 px-5 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800/30 text-left"
                    onClick={() => setCollapsedCols((prev) => { const next = new Set(prev); next.has(col.id) ? next.delete(col.id) : next.add(col.id); return next })}>
                    <div className="flex items-center gap-2">
                      <ChevronDown className={cn('w-3.5 h-3.5 text-slate-400 transition-transform', isCollapsed && '-rotate-90')} />
                      <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">{col.labelEn}</span>
                      <span className="text-[10px] font-mono text-slate-400">{col.id}</span>
                    </div>
                    <span className={cn('text-[10px]', matchCount === totalPossible ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-500 dark:text-amber-400')}>
                      {matchCount}/{totalPossible} matched
                    </span>
                  </button>

                  {!isCollapsed && (
                    <div className="px-5 pb-3">
                      <div className="border border-slate-200 dark:border-slate-700 rounded-lg overflow-hidden">
                        <table className="w-full text-xs border-collapse">
                          <thead>
                            <tr className="bg-slate-50 dark:bg-slate-800/60">
                              <th className="px-3 py-1.5 text-left font-medium text-slate-500 dark:text-slate-400 border-b border-r border-slate-200 dark:border-slate-700 w-32">{sourceMarket}</th>
                              {activeMarkets.map((m) => (
                                <th key={m} className="px-3 py-1.5 text-left font-medium text-slate-500 dark:text-slate-400 border-b border-r border-slate-200 dark:border-slate-700 last:border-r-0">{m}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {vals.map((srcVal, ri) => (
                              <tr key={srcVal} className={ri % 2 === 0 ? '' : 'bg-slate-50/50 dark:bg-slate-800/20'}>
                                <td className="px-3 py-1.5 font-mono border-r border-b border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 truncate max-w-[120px]" title={srcVal}>{srcVal}</td>
                                {activeMarkets.map((market) => {
                                  const mapping = result.mappings[market]?.[srcVal]
                                  const effective = getEffectiveValue(col.id, market, srcVal)
                                  const isOverridden = overrides[col.id]?.[market]?.[srcVal] !== undefined
                                  const targetOpts = result.targetOptions[market] ?? []
                                  const isOpen = openDropdown?.colId === col.id && openDropdown?.market === market && openDropdown?.srcVal === srcVal

                                  return (
                                    <td key={market} className="px-2 py-1 border-r border-b border-slate-200 dark:border-slate-700 last:border-r-0 relative">
                                      {isOpen ? (
                                        <div className="absolute left-0 top-0 z-20 min-w-[180px]">
                                          <div className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded-lg shadow-xl max-h-48 overflow-y-auto py-1">
                                            <button type="button"
                                              className="w-full px-3 py-1.5 text-left text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 italic"
                                              onClick={() => { setOverrides((p) => ({ ...p, [col.id]: { ...(p[col.id] ?? {}), [market]: { ...(p[col.id]?.[market] ?? {}), [srcVal]: null } } })); setOpenDropdown(null) }}>
                                              Skip (no mapping)
                                            </button>
                                            <div className="border-t border-slate-100 dark:border-slate-700 my-1" />
                                            {targetOpts.map((opt) => (
                                              <button key={opt} type="button"
                                                className={cn('w-full px-3 py-1 text-left text-xs hover:bg-blue-50 dark:hover:bg-blue-950/30',
                                                  opt === effective ? 'bg-blue-50 dark:bg-blue-950/30 font-medium text-blue-700 dark:text-blue-300' : 'text-slate-700 dark:text-slate-300')}
                                                onClick={() => { setOverrides((p) => ({ ...p, [col.id]: { ...(p[col.id] ?? {}), [market]: { ...(p[col.id]?.[market] ?? {}), [srcVal]: opt } } })); setOpenDropdown(null) }}>
                                                {opt}
                                              </button>
                                            ))}
                                          </div>
                                        </div>
                                      ) : (
                                        <button type="button"
                                          className="w-full text-left flex items-center justify-between gap-1 px-1 py-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-700/50 group/cell"
                                          onClick={() => setOpenDropdown({ colId: col.id, market, srcVal })}>
                                          {effective ? (
                                            <>
                                              <span className={cn('font-mono text-[11px] truncate', isOverridden && 'underline decoration-dashed decoration-violet-400')}>{effective}</span>
                                              <span className={cn('text-[9px] flex-shrink-0', isOverridden ? 'text-violet-500' : confidenceCls(mapping?.confidence ?? 'none'))}>
                                                {isOverridden ? 'ovr' : confidenceLabel(mapping?.confidence ?? 'none')}
                                              </span>
                                            </>
                                          ) : (
                                            <span className="text-slate-300 dark:text-slate-600 italic text-[10px]">no match</span>
                                          )}
                                          <ChevronDown className="w-3 h-3 text-slate-300 flex-shrink-0 opacity-0 group-hover/cell:opacity-100" />
                                        </button>
                                      )}
                                    </td>
                                  )
                                })}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {Object.entries(result.errors).some(([m]) => selectedMarkets.has(m)) && (
                        <div className="mt-1.5 space-y-0.5">
                          {Object.entries(result.errors).filter(([m]) => selectedMarkets.has(m)).map(([m, msg]) => (
                            <div key={m} className="flex items-start gap-1 text-[11px] text-amber-600 dark:text-amber-400">
                              <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                              <span><strong>{m}:</strong> {msg}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-5 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3 flex-shrink-0 bg-slate-50/50 dark:bg-slate-800/30 rounded-b-xl">
        <span className="text-[11px] text-slate-400">
          {hasResults
            ? `${Object.keys(colResults).length} column${Object.keys(colResults).length !== 1 ? 's' : ''} · ${[...selectedMarkets].length} market${[...selectedMarkets].length !== 1 ? 's' : ''}`
            : `${selectedColIds.size} column${selectedColIds.size !== 1 ? 's' : ''} · ${selectedMarkets.size} market${selectedMarkets.size !== 1 ? 's' : ''} selected`}
        </span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          {!hasResults ? (
            <Button size="sm" onClick={handleTranslate} loading={translating}
              disabled={!selectedColIds.size || !selectedMarkets.size}>
              <ArrowRightLeft className="w-3.5 h-3.5 mr-1.5" />Translate
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => { setColResults({}); setGlobalError(null) }}>← Edit</Button>
              <Button size="sm" variant="ghost" onClick={handleTranslate} loading={translating}>Retranslate</Button>
              <Button size="sm" onClick={handleApply} disabled={Object.keys(colResults).length === 0}>Apply to drafts</Button>
            </>
          )}
        </div>
      </div>

      {openDropdown && <div className="fixed inset-0 z-10" onClick={() => setOpenDropdown(null)} />}
    </>
  )
}

// ── AddRowsPanel ───────────────────────────────────────────────────────────

interface AddRowsParams {
  type: 'row' | 'parent' | 'variant'
  count: number
  position: 'end' | 'above' | 'below'
  replicateFromId?: string
  parentSku?: string
}

interface AddRowsPanelProps {
  initialType: 'row' | 'parent' | 'variant'
  initialPosition: 'end' | 'above' | 'below'
  rows: Row[]
  hasSelection: boolean
  productType: string
  marketplace: string
  onAdd: (params: AddRowsParams) => void
  onClose: () => void
}

function AddRowsPanel({ initialType, initialPosition, rows, hasSelection, productType: _productType, marketplace: _marketplace, onAdd, onClose }: AddRowsPanelProps) {
  const [type, setType] = useState<'row' | 'parent' | 'variant'>(initialType)
  const [count, setCount] = useState(1)
  const [position, setPosition] = useState<'end' | 'above' | 'below'>(initialPosition)
  const [replicateFromId, setReplicateFromId] = useState('')
  const [parentSku, setParentSku] = useState('')

  // Source rows for replication picker
  const parentRows = useMemo(() => rows.filter((r) => r.parentage_level === 'parent' && r.item_sku), [rows])
  const variantRows = useMemo(() => rows.filter((r) => r.parentage_level === 'child' && r.item_sku), [rows])
  const allWithSku  = useMemo(() => rows.filter((r) => r.item_sku), [rows])

  const sourceOptions = type === 'parent' ? parentRows : type === 'variant' ? variantRows : allWithSku
  const parentOptions = parentRows

  function handleAdd() {
    onAdd({
      type, count,
      position,
      replicateFromId: replicateFromId || undefined,
      parentSku: type === 'variant' ? (parentSku || undefined) : undefined,
    })
  }

  const tabCls = (t: typeof type) => cn(
    'px-3 py-1 rounded-md text-xs font-medium transition-colors',
    type === t
      ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 shadow-sm'
      : 'text-slate-500 dark:text-slate-400 hover:text-slate-700',
  )

  const selectCls = 'w-full text-xs border border-slate-200 dark:border-slate-700 rounded-md px-2 py-1.5 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[1px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full max-w-sm mx-4">

        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Plus className="w-4 h-4 text-blue-500" />Add rows
          </h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">

          {/* Row type */}
          <div>
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5 block">Row type</label>
            <div className="flex bg-slate-100 dark:bg-slate-800 rounded-lg p-0.5 gap-0.5">
              {(['row', 'parent', 'variant'] as const).map((t) => (
                <button key={t} type="button" onClick={() => { setType(t); setReplicateFromId(''); setParentSku('') }}
                  className={tabCls(t)}>
                  {t === 'row' ? 'Row' : t === 'parent' ? 'Parent' : 'Variant'}
                </button>
              ))}
            </div>
          </div>

          {/* Count */}
          <div>
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5 block">How many</label>
            <div className="flex items-center gap-2">
              <button type="button"
                onClick={() => setCount((c) => Math.max(1, c - 1))}
                className="w-7 h-7 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-bold flex items-center justify-center flex-shrink-0">
                −
              </button>
              <input
                type="number" min={1} max={500} value={count}
                onChange={(e) => setCount(Math.max(1, Math.min(500, parseInt(e.target.value) || 1)))}
                className="w-16 text-center text-sm font-medium border border-slate-200 dark:border-slate-700 rounded-md py-1 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button type="button"
                onClick={() => setCount((c) => Math.min(500, c + 1))}
                className="w-7 h-7 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-bold flex items-center justify-center flex-shrink-0">
                +
              </button>
              <span className="text-xs text-slate-400">row{count !== 1 ? 's' : ''}</span>
            </div>
          </div>

          {/* Position */}
          <div>
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5 block">Where</label>
            <div className="flex gap-1.5">
              {(['end', 'above', 'below'] as const).map((p) => {
                const label = p === 'end' ? 'End of table' : p === 'above' ? 'Above selection' : 'Below selection'
                const disabled = (p === 'above' || p === 'below') && !hasSelection
                return (
                  <button key={p} type="button" disabled={disabled}
                    onClick={() => setPosition(p)}
                    className={cn(
                      'flex-1 text-xs px-2 py-1.5 rounded-lg border transition-colors',
                      position === p
                        ? 'bg-blue-600 text-white border-blue-600'
                        : disabled
                        ? 'border-slate-100 dark:border-slate-800 text-slate-300 dark:text-slate-700 cursor-not-allowed'
                        : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-blue-400',
                    )}>
                    {label}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Replicate from (parent + variant types) */}
          {(type === 'parent' || type === 'variant') && (
            <div>
              <label className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5 block">
                Copy fields from
                <span className="ml-1 font-normal opacity-70">(optional — leaves item_sku blank)</span>
              </label>
              <select value={replicateFromId} onChange={(e) => setReplicateFromId(e.target.value)}
                className={selectCls}>
                <option value="">— None (empty row) —</option>
                {sourceOptions.map((r) => (
                  <option key={r._rowId as string} value={r._rowId as string}>
                    {String(r.item_sku || r._rowId).slice(0, 60)}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Attach to parent (variant only) */}
          {type === 'variant' && (
            <div>
              <label className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5 block">
                Attach to parent
                <span className="ml-1 font-normal opacity-70">(pre-fills parent_sku)</span>
              </label>
              <select value={parentSku} onChange={(e) => setParentSku(e.target.value)}
                className={selectCls}>
                <option value="">— None —</option>
                {parentOptions.map((r) => (
                  <option key={r._rowId as string} value={String(r.item_sku)}>
                    {String(r.item_sku).slice(0, 60)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3 bg-slate-50/50 dark:bg-slate-800/30 rounded-b-xl">
          <span className="text-[11px] text-slate-400">
            {count} {type === 'parent' ? `parent row${count !== 1 ? 's' : ''}` : type === 'variant' ? `variant${count !== 1 ? 's' : ''}` : `row${count !== 1 ? 's' : ''}`}
            {' · '}{position === 'end' ? 'end of table' : position === 'above' ? 'above selection' : 'below selection'}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={handleAdd}>
              <Plus className="w-3.5 h-3.5 mr-1" />Add {count > 1 ? `${count} ` : ''}row{count !== 1 ? 's' : ''}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── SubmissionHistoryPanel ─────────────────────────────────────────────────

interface SubmissionHistoryPanelProps {
  history: SubmissionRecord[]
  onClear: () => void
  onClose: () => void
}

function SubmissionHistoryPanel({ history, onClear, onClose }: SubmissionHistoryPanelProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function statusColor(s: string) {
    if (s === 'DONE') return 'text-emerald-600 dark:text-emerald-400'
    if (s === 'FATAL') return 'text-red-500 dark:text-red-400'
    return 'text-amber-500 dark:text-amber-400'
  }

  function formatTime(iso: string) {
    try {
      const d = new Date(iso)
      return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        + ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    } catch { return iso }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end pt-16 pr-4" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-blue-500" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Submission History</h2>
            <span className="text-xs text-slate-400">({history.length})</span>
          </div>
          <div className="flex items-center gap-2">
            {history.length > 0 && (
              <button type="button" onClick={onClear}
                className="text-xs text-red-400 hover:text-red-600 dark:hover:text-red-300">
                Clear all
              </button>
            )}
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* List */}
        <div className="overflow-y-auto flex-1">
          {history.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-slate-400 italic">No submissions yet</div>
          ) : (
            history.map((rec) => {
              const isExpanded = expanded.has(rec.id)
              const hasErrors = (rec.errorCount ?? 0) > 0
              return (
                <div key={rec.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                  {/* Summary row */}
                  <div className="px-4 py-2.5 flex items-start gap-3 hover:bg-slate-50 dark:hover:bg-slate-800/40">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-semibold bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 px-1.5 py-0.5 rounded">{rec.market}</span>
                        {rec.dryRun && <span className="text-[10px] text-slate-400 italic">dry run</span>}
                        <span className={cn('text-[10px] font-semibold', statusColor(rec.status))}>{rec.status}</span>
                        {rec.status === 'DONE' && (
                          <span className="text-[10px] text-slate-500 dark:text-slate-400">
                            {rec.successCount ?? 0} ok
                            {hasErrors && <span className="ml-1 text-red-500 dark:text-red-400">· {rec.errorCount} error{rec.errorCount !== 1 ? 's' : ''}</span>}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-2">
                        <span>{formatTime(rec.submittedAt)}</span>
                        <span>·</span>
                        <span>{rec.rowCount} row{rec.rowCount !== 1 ? 's' : ''}</span>
                        <span>·</span>
                        <span className="font-mono truncate max-w-[120px]" title={rec.id}>{rec.id.slice(0, 16)}…</span>
                      </div>
                    </div>
                    {(rec.results?.length ?? 0) > 0 && (
                      <button type="button" onClick={() => toggle(rec.id)}
                        className="text-[10px] text-slate-400 hover:text-slate-600 flex items-center gap-0.5 flex-shrink-0 mt-0.5">
                        <ChevronDown className={cn('w-3 h-3 transition-transform', isExpanded && 'rotate-180')} />
                        {isExpanded ? 'Hide' : 'Details'}
                      </button>
                    )}
                  </div>

                  {/* Expanded results */}
                  {isExpanded && rec.results && rec.results.length > 0 && (
                    <div className="px-4 pb-2.5 space-y-0.5 max-h-48 overflow-y-auto">
                      {rec.results.filter((r) => r.status === 'error').map((r) => (
                        <div key={r.sku} className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/20 rounded px-2 py-1">
                          <X className="w-3 h-3 mt-0.5 flex-shrink-0" />
                          <span className="font-mono font-medium flex-shrink-0">{r.sku}</span>
                          <span className="text-[11px] text-red-500/80">{r.message}</span>
                        </div>
                      ))}
                      {rec.results.filter((r) => r.status !== 'error').slice(0, 3).map((r) => (
                        <div key={r.sku} className="flex items-center gap-2 text-[11px] text-emerald-600 dark:text-emerald-400 px-2 py-0.5">
                          <CheckCircle2 className="w-3 h-3 flex-shrink-0" />
                          <span className="font-mono">{r.sku}</span>
                        </div>
                      ))}
                      {rec.results.filter((r) => r.status !== 'error').length > 3 && (
                        <p className="text-[10px] text-slate-400 px-2">+{rec.results.filter((r) => r.status !== 'error').length - 3} more ok</p>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

// ── VersionHistoryPanel ────────────────────────────────────────────────────

interface VersionHistoryPanelProps {
  marketplace: string
  productType: string
  currentRows: Row[]
  onRestore: (rows: Row[]) => void
  onClose: () => void
}

function VersionHistoryPanel({ marketplace, productType, currentRows, onRestore, onClose }: VersionHistoryPanelProps) {
  const [versions, setVersions] = useState<VersionRecord[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(versionHistoryKey(marketplace, productType)) ?? '[]')
    } catch { return [] }
  })
  const [restoring, setRestoring] = useState<string | null>(null)

  function formatTime(iso: string) {
    try {
      const d = new Date(iso)
      return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
        + ' · ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    } catch { return iso }
  }

  function diff(version: VersionRecord) {
    const currentSkus = new Set(currentRows.map((r) => String(r.item_sku ?? r._rowId)))
    const versionSkus = new Set(version.rows.map((r) => String(r.item_sku ?? r._rowId)))
    const added   = currentRows.filter((r) => !versionSkus.has(String(r.item_sku ?? r._rowId))).length
    const removed = version.rows.filter((r) => !currentSkus.has(String(r.item_sku ?? r._rowId))).length
    const parts: string[] = []
    if (added > 0) parts.push(`+${added} row${added !== 1 ? 's' : ''} now`)
    if (removed > 0) parts.push(`−${removed} row${removed !== 1 ? 's' : ''} then`)
    if (parts.length === 0) parts.push(`${version.rowCount} rows`)
    return parts.join(' · ')
  }

  function clearAll() {
    if (!confirm('Delete all saved versions? This cannot be undone.')) return
    try { localStorage.removeItem(versionHistoryKey(marketplace, productType)) } catch {}
    setVersions([])
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end pt-16 pr-4" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-violet-500" />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Version History</h2>
            <span className="text-xs text-slate-400">{marketplace} · {productType}</span>
          </div>
          <div className="flex items-center gap-2">
            {versions.length > 0 && (
              <button type="button" onClick={clearAll}
                className="text-xs text-red-400 hover:text-red-600 dark:hover:text-red-300">
                Clear all
              </button>
            )}
            <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Version list */}
        <div className="overflow-y-auto flex-1">
          {versions.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <Clock className="w-8 h-8 mx-auto mb-2 text-slate-200 dark:text-slate-700" />
              <p className="text-sm text-slate-400 italic">No versions saved yet</p>
              <p className="text-xs text-slate-300 dark:text-slate-600 mt-1">Versions are created automatically on Save, Submit, Import and Discard</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {versions.map((v, i) => (
                <div key={v.id} className="px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {i === 0 && (
                        <span className="text-[10px] bg-violet-100 dark:bg-violet-900/40 text-violet-600 dark:text-violet-300 px-1.5 py-0.5 rounded font-medium">latest</span>
                      )}
                      <span className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">{v.label}</span>
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-2">
                      <span>{formatTime(v.savedAt)}</span>
                      <span>·</span>
                      <span className="text-slate-500 dark:text-slate-400">{diff(v)}</span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={restoring === v.id}
                    onClick={() => {
                      if (!confirm(`Restore to "${v.label}"? Current rows will be replaced (you can undo).`)) return
                      setRestoring(v.id)
                      onRestore(v.rows)
                    }}
                    className="text-xs flex-shrink-0"
                  >
                    Restore
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 text-[10px] text-slate-400 flex-shrink-0">
          Up to 15 versions saved per marketplace + product type
        </div>
      </div>
    </div>
  )
}

// ── ContextMenu ────────────────────────────────────────────────────────

interface ContextMenuProps {
  x: number
  y: number
  canPaste: boolean
  hasSelection: boolean
  selRowCount: number
  onCut: () => void
  onCopy: () => void
  onPaste: () => void
  onInsertAbove: () => void
  onInsertBelow: () => void
  onDeleteRows: () => void
  onAddRows: () => void
  onClearCells: () => void
  onClose: () => void
}

function ContextMenu({ x, y, canPaste, hasSelection, selRowCount, onCut, onCopy, onPaste, onInsertAbove, onInsertBelow, onDeleteRows, onAddRows, onClearCells, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [onClose])

  function item(label: string, shortcut: string | undefined, onClick: () => void, disabled = false) {
    return (
      <button type="button" disabled={disabled}
        onClick={() => { onClick(); onClose() }}
        className={cn(
          'w-full flex items-center justify-between gap-6 px-3 py-1.5 text-xs text-left transition-colors',
          disabled ? 'text-slate-300 dark:text-slate-600 cursor-default'
          : 'text-slate-700 dark:text-slate-300 hover:bg-blue-500 hover:text-white',
        )}>
        <span>{label}</span>
        {shortcut && <span className="text-[10px] font-mono opacity-60">{shortcut}</span>}
      </button>
    )
  }

  // Adjust position to not overflow viewport
  const menuW = 200, menuH = 260
  const left = Math.min(x, window.innerWidth - menuW - 8)
  const top = Math.min(y, window.innerHeight - menuH - 8)

  return (
    <div ref={ref}
      className="fixed z-[9999] w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-2xl py-1 overflow-hidden"
      style={{ left, top }}>
      {item('Cut', '⌘X', onCut, !hasSelection)}
      {item('Copy', '⌘C', onCopy, !hasSelection)}
      {item('Paste', '⌘V', onPaste, !canPaste)}
      <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
      {item('Insert row above', undefined, onInsertAbove)}
      {item('Insert row below', undefined, onInsertBelow)}
      {item(`Delete row${selRowCount !== 1 ? 's' : ''}`, undefined, onDeleteRows, !hasSelection)}
      <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
      {item('Add rows here…', undefined, onAddRows)}
      <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
      {item('Clear cells', 'Del', onClearCells, !hasSelection)}
    </div>
  )
}


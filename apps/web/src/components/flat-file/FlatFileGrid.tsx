'use client'

import {
  useCallback, useEffect, useRef, useState, useMemo,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  ClipboardPaste, Copy, Image as ImageIcon, Loader2, Plus,
  RefreshCw, Search, Trash2, Undo2, Redo2, Replace, SlidersHorizontal, Sparkles, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { FindReplaceBar } from '@/app/bulk-operations/components/FindReplaceBar'
import { ConditionalFormatBar } from '@/app/bulk-operations/components/ConditionalFormatBar'
import { evaluateRule, TONE_CLASSES, type ConditionalRule } from '@/app/bulk-operations/lib/conditional-format'
import { type FindCell } from '@/app/bulk-operations/lib/find-replace'
import { FFFilterPanel, FF_FILTER_DEFAULT, type FFFilterState } from '@/app/products/amazon-flat-file/FFFilterPanel'
import { FFSavedViews, type FFViewState } from '@/app/products/amazon-flat-file/FFSavedViews'
import { AIBulkModal } from '@/app/products/amazon-flat-file/AIBulkModal'
import { FFReplicateModal } from '@/app/products/amazon-flat-file/FFReplicateModal'
import type {
  FlatFileGridProps, BaseRow, FlatFileColumnGroup,
  ValidationIssue, ModalsCtx, ToolbarFetchCtx, ToolbarImportCtx, ReplicateCtx,
} from './FlatFileGrid.types'

// ── Constants ─────────────────────────────────────────────────────────────

const GROUP_BAND_COLORS = [
  'bg-blue-50/30 dark:bg-blue-950/10',
  'bg-violet-50/30 dark:bg-violet-950/10',
  'bg-emerald-50/30 dark:bg-emerald-950/10',
  'bg-amber-50/30 dark:bg-amber-950/10',
  'bg-rose-50/30 dark:bg-rose-950/10',
  'bg-cyan-50/30 dark:bg-cyan-950/10',
]

const GROUP_COLORS: Record<string, { header: string; cell: string }> = {
  slate:   { header: 'bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300', cell: '' },
  blue:    { header: 'bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200', cell: 'bg-blue-50/40 dark:bg-blue-950/10' },
  purple:  { header: 'bg-purple-100 dark:bg-purple-900/50 text-purple-800 dark:text-purple-200', cell: 'bg-purple-50/40 dark:bg-purple-950/10' },
  emerald: { header: 'bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200', cell: 'bg-emerald-50/40 dark:bg-emerald-950/10' },
  orange:  { header: 'bg-orange-100 dark:bg-orange-900/50 text-orange-800 dark:text-orange-200', cell: 'bg-orange-50/40 dark:bg-orange-950/10' },
  teal:    { header: 'bg-teal-100 dark:bg-teal-900/50 text-teal-800 dark:text-teal-200', cell: 'bg-teal-50/40 dark:bg-teal-950/10' },
  amber:   { header: 'bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-200', cell: 'bg-amber-50/40 dark:bg-amber-950/10' },
  sky:     { header: 'bg-sky-100 dark:bg-sky-900/50 text-sky-800 dark:text-sky-200', cell: 'bg-sky-50/40 dark:bg-sky-950/10' },
  violet:  { header: 'bg-violet-100 dark:bg-violet-900/50 text-violet-800 dark:text-violet-200', cell: 'bg-violet-50/40 dark:bg-violet-950/10' },
}

function gColor(color: string) { return GROUP_COLORS[color] ?? GROUP_COLORS.slate }

const GROUP_BADGE: Record<string, string> = {
  slate:   'bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800/40 dark:text-slate-400 dark:border-slate-700',
  blue:    'bg-blue-100 text-blue-700 border border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800',
  purple:  'bg-purple-100 text-purple-700 border border-purple-200 dark:bg-purple-900/40 dark:text-purple-300 dark:border-purple-800',
  emerald: 'bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800',
  orange:  'bg-orange-100 text-orange-700 border border-orange-200 dark:bg-orange-900/40 dark:text-orange-300 dark:border-orange-800',
  teal:    'bg-teal-100 text-teal-700 border border-teal-200 dark:bg-teal-900/40 dark:text-teal-300 dark:border-teal-800',
  amber:   'bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-900/40 dark:text-amber-300 dark:border-amber-800',
  sky:     'bg-sky-100 text-sky-700 border border-sky-200 dark:bg-sky-900/40 dark:text-sky-300 dark:border-sky-800',
  red:     'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/40 dark:text-red-300 dark:border-red-800',
  violet:  'bg-violet-100 text-violet-700 border border-violet-200 dark:bg-violet-900/40 dark:text-violet-300 dark:border-violet-800',
}

function gBadge(color: string) { return GROUP_BADGE[color] ?? GROUP_BADGE.slate }

function statusBadgeCls(status?: string | null) {
  switch (status?.toUpperCase()) {
    case 'ACTIVE': return 'bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300'
    case 'DRAFT':  return 'bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-900/40 dark:text-amber-300'
    case 'ERROR':  return 'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/40 dark:text-red-300'
    default:       return 'bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-400'
  }
}

function rowStatusIcon(status?: BaseRow['_status']) {
  switch (status) {
    case 'pending': return <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
    case 'pushed':  return <CheckCircle2 className="h-3 w-3 text-emerald-500" />
    case 'error':   return <AlertCircle className="h-3 w-3 text-red-500" />
    default:        return null
  }
}

// ── Row padding ───────────────────────────────────────────────────────────

function padToMin(rows: BaseRow[], makeBlankRow: () => BaseRow, min: number): BaseRow[] {
  if (rows.length >= min) return rows
  const blanks = Array.from({ length: min - rows.length }, makeBlankRow)
  return [...rows, ...blanks]
}

// ── GroupHeader ───────────────────────────────────────────────────────────

interface GroupHeaderProps {
  row: BaseRow
  bandClass: string
  isExpanded: boolean
  onToggle: () => void
  showImage: boolean
  imageSize: number
  colSpanCount: number
}

function GroupHeader({ row, bandClass, isExpanded, onToggle, showImage, imageSize, colSpanCount }: GroupHeaderProps) {
  const label   = String(row.title ?? row.sku ?? row.item_sku ?? row._rowId)
  const catId   = row.category_id as string | undefined
  const cond    = row.condition as string | undefined
  const lstatus = row.listing_status as string | undefined
  const imgUrl  = row.image_1 as string | undefined

  return (
    <tr className={cn('border-b border-slate-200 dark:border-slate-700', bandClass)}>
      <td colSpan={colSpanCount} className="px-3 py-1">
        <div className="flex items-center gap-3">
          <button
            onClick={onToggle}
            className="flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900"
          >
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !isExpanded && '-rotate-90')} />
            {label}
          </button>
          {catId && <span className="text-[10px] text-slate-400">Cat: {catId}</span>}
          {cond && (
            <span className="rounded bg-slate-200 dark:bg-slate-700 px-1 py-0.5 text-[10px] text-slate-600 dark:text-slate-300">
              {cond}
            </span>
          )}
          {lstatus && (
            <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', statusBadgeCls(lstatus))}>
              {lstatus}
            </span>
          )}
          {showImage && imgUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imgUrl}
              alt=""
              style={{ width: imageSize, height: imageSize }}
              className="rounded object-cover border border-slate-200 dark:border-slate-700"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          )}
        </div>
      </td>
    </tr>
  )
}

// ── TbBtn ─────────────────────────────────────────────────────────────────

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

// ── MenuDropdown ──────────────────────────────────────────────────────────

interface MenuItem {
  label?: string
  icon?: React.ReactNode
  shortcut?: string
  onClick?: () => void
  disabled?: boolean
  separator?: boolean
}

function MenuDropdown({ label, items }: { label: string; items: MenuItem[] }) {
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
                onClick={() => { if (!item.disabled && item.onClick) { item.onClick(); setOpen(false) } }}
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

// ── Main component ────────────────────────────────────────────────────────

export default function FlatFileGrid({
  channel,
  title,
  titleIcon,
  marketplace,
  storageKey,
  columnGroups,
  initialRows,
  makeBlankRow,
  minRows = 15,
  CellComponent,
  getGroupKey,
  validate,
  onSave,
  onReload,
  onCellChange,
  onReplicate,
  renderChannelStrip,
  renderPushExtras,
  renderFeedBanner,
  renderModals,
  renderToolbarFetch,
  renderToolbarImport,
  renderBar3Left,
}: FlatFileGridProps) {
  const router = useRouter()
  const { toast } = useToast()

  // ── Row state (padded to minRows) ──────────────────────────────────────
  const paddedInitRef = useRef<BaseRow[] | null>(null)
  if (!paddedInitRef.current) paddedInitRef.current = padToMin(initialRows, makeBlankRow, minRows)

  const [rows, setRows]       = useState<BaseRow[]>(paddedInitRef.current)
  const [loading, setLoading] = useState(false)
  const [saving,  setSaving]  = useState(false)

  // ── Selection ──────────────────────────────────────────────────────────
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [activeCell, setActiveCell]     = useState<{ rowId: string; colId: string } | null>(null)

  // ── UI toggles ─────────────────────────────────────────────────────────
  const [showFilter,       setShowFilter]       = useState(false)
  const [filterState,      setFilterState]      = useState<FFFilterState>(FF_FILTER_DEFAULT)
  const [showFindReplace,  setShowFindReplace]  = useState(false)
  const [showConditional,  setShowConditional]  = useState(false)
  const [cfRules,          setCfRules]          = useState<ConditionalRule[]>([])
  const [showValidation,   setShowValidation]   = useState(false)
  const [searchQuery,      setSearchQuery]      = useState('')

  // ── Column group state (localStorage-persisted) ────────────────────────
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(`${storageKey}-closed-groups`) ?? '[]')) } catch { return new Set() }
  })
  const [groupOrder, setGroupOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(`${storageKey}-group-order`) ?? '[]') } catch { return [] }
  })
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null)

  // ── Sort ───────────────────────────────────────────────────────────────
  const [sortPanelOpen, setSortPanelOpen] = useState(false)
  const [sortConfig,    setSortConfig]    = useState<Array<{ id: string; colId: string; mode: 'asc' | 'desc' }>>([])
  void setSortConfig

  // ── Misc UI ────────────────────────────────────────────────────────────
  const [saveFlash,    setSaveFlash]    = useState(false)
  const [aiModalOpen,  setAiModalOpen]  = useState(false)
  const [replicateOpen, setReplicateOpen] = useState(false)

  // ── Smart paste ────────────────────────────────────────────────────────
  const [smartPasteEnabled, setSmartPasteEnabled] = useState(() => {
    try { return localStorage.getItem(`${storageKey}-smart-paste`) === '1' } catch { return false }
  })
  useEffect(() => {
    try { localStorage.setItem(`${storageKey}-smart-paste`, smartPasteEnabled ? '1' : '0') } catch {}
  }, [smartPasteEnabled, storageKey])

  // ── Row images ─────────────────────────────────────────────────────────
  const [showRowImages, setShowRowImages] = useState(false)
  const [imageSize,     setImageSize]     = useState<24 | 32 | 48 | 64 | 96>(48)

  // ── Row group collapse ─────────────────────────────────────────────────
  const [collapsedRowGroups, setCollapsedRowGroups] = useState<Set<string>>(new Set())

  // ── Drag-drop ──────────────────────────────────────────────────────────
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null)
  const [dropTarget,    setDropTarget]    = useState<{ rowId: string; half: 'top' | 'bottom' } | null>(null)
  const canDragRef = useRef(false)

  // ── Undo / redo ────────────────────────────────────────────────────────
  const historyRef = useRef<BaseRow[][]>([paddedInitRef.current])
  const historyIdx = useRef(0)

  // ── Derived ────────────────────────────────────────────────────────────

  const allColumns = useMemo(
    () => columnGroups.flatMap((g) => g.columns),
    [columnGroups],
  )

  const orderedGroups = useMemo<FlatFileColumnGroup[]>(() => {
    if (!groupOrder.length) return columnGroups
    const map = new Map(columnGroups.map((g) => [g.id, g]))
    const ordered = groupOrder.map((id) => map.get(id)).filter(Boolean) as FlatFileColumnGroup[]
    const rest = columnGroups.filter((g) => !groupOrder.includes(g.id))
    return [...ordered, ...rest]
  }, [groupOrder, columnGroups])

  const openGroups = useMemo(
    () => new Set(columnGroups.map((g) => g.id).filter((id) => !closedGroups.has(id))),
    [closedGroups, columnGroups],
  )

  const visibleGroups = useMemo(
    () => orderedGroups.filter((g) => openGroups.has(g.id)),
    [orderedGroups, openGroups],
  )

  const visibleColumns = useMemo(
    () => visibleGroups.flatMap((g) => g.columns),
    [visibleGroups],
  )

  const defaultGetGroupKey = useCallback((row: BaseRow) => String(row.platformProductId ?? row._rowId), [])
  const resolvedGetGroupKey = getGroupKey ?? defaultGetGroupKey

  const rowGroups = useMemo(() => {
    const groups = new Map<string, BaseRow[]>()
    for (const row of rows) {
      const key = resolvedGetGroupKey(row)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }
    return groups
  }, [rows, resolvedGetGroupKey])

  const filteredRows = useMemo(() => {
    if (!searchQuery) return rows
    const q = searchQuery.toLowerCase()
    return rows.filter((r) =>
      String(r.sku ?? r.item_sku ?? '').toLowerCase().includes(q) ||
      String(r.title ?? '').toLowerCase().includes(q) ||
      String(r.ebay_item_id ?? r.asin ?? '').includes(q),
    )
  }, [rows, searchQuery])

  const validationIssues = useMemo<ValidationIssue[]>(
    () => validate ? validate(rows) : [],
    [rows, validate],
  )

  const dirtyCount = rows.filter((r) => r._dirty).length
  const errorCount = validationIssues.filter((i) => i.level === 'error').length
  const warnCount  = validationIssues.filter((i) => i.level === 'warn').length

  // Find-replace cells
  const findCells = useMemo((): FindCell[] =>
    rows.flatMap((row, rowIdx) =>
      allColumns.map((col, colIdx) => ({
        rowIdx,
        colIdx,
        rowId: row._rowId,
        columnId: col.id,
        value: String(row[col.id] ?? ''),
      }))
    ),
    [rows, allColumns],
  )

  // ── Undo / redo ────────────────────────────────────────────────────────

  function pushHistory(nextRows: BaseRow[]) {
    const slice = historyRef.current.slice(0, historyIdx.current + 1)
    slice.push(nextRows)
    if (slice.length > 50) slice.shift()
    historyRef.current = slice
    historyIdx.current = slice.length - 1
  }

  function undo() {
    if (historyIdx.current <= 0) return
    historyIdx.current--
    setRows(historyRef.current[historyIdx.current])
  }

  function redo() {
    if (historyIdx.current >= historyRef.current.length - 1) return
    historyIdx.current++
    setRows(historyRef.current[historyIdx.current])
  }

  // ── Cell update ────────────────────────────────────────────────────────

  function updateCell(rowId: string, colId: string, value: unknown) {
    const nextRows = rows.map((r) =>
      r._rowId === rowId ? { ...r, [colId]: value, _dirty: true } : r,
    )
    pushHistory(nextRows)
    setRows(nextRows)
    onCellChange?.(rowId, colId, value)
  }

  // ── Row add / delete / reorder ─────────────────────────────────────────

  function addRow() {
    const newRow = makeBlankRow()
    const next = [...rows, newRow]
    pushHistory(next)
    setRows(next)
  }

  function deleteSelected() {
    if (!selectedRows.size) return
    const next = rows.filter((r) => !selectedRows.has(r._rowId))
    pushHistory(next)
    setRows(next)
    setSelectedRows(new Set())
  }

  function reorderRow(fromId: string, toId: string, half: 'top' | 'bottom') {
    if (fromId === toId) return
    pushHistory(rows)
    const rowMap = new Map(rows.map((r) => [r._rowId, r]))
    const ids    = rows.map((r) => r._rowId)
    const fi     = ids.indexOf(fromId)
    const ti     = ids.indexOf(toId)
    if (fi === -1 || ti === -1) return
    const next = [...ids]
    next.splice(fi, 1)
    const adj = fi < ti ? ti - 1 : ti
    next.splice(half === 'top' ? adj : adj + 1, 0, fromId)
    setRows(next.map((id) => rowMap.get(id)!).filter(Boolean))
    setDraggingRowId(null)
    setDropTarget(null)
  }

  // ── Save / reload ──────────────────────────────────────────────────────

  async function saveDraft() {
    const dirty = rows.filter((r) => r._dirty)
    if (!dirty.length) { toast({ title: 'Nothing to save', tone: 'info' }); return }
    setSaving(true)
    try {
      const { saved } = await onSave(dirty)
      setRows((prev) => prev.map((r) => ({ ...r, _dirty: false })))
      setSaveFlash(true)
      setTimeout(() => setSaveFlash(false), 2000)
      toast.success(`Saved ${saved} rows`)
    } catch (err) {
      toast.error('Save failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  async function loadData() {
    setLoading(true)
    try {
      const loaded = await onReload()
      const padded = padToMin(loaded, makeBlankRow, minRows)
      setRows(padded)
      pushHistory(padded)
    } catch (err) {
      toast.error('Failed to reload: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }

  function handleDiscard() {
    if (!dirtyCount) return
    if (!confirm('Discard all unsaved changes?')) return
    void loadData()
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey
      if (meta && e.key === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      if (meta && e.key === 'z' &&  e.shiftKey) { e.preventDefault(); redo() }
      if (meta && e.key === 'f')                { e.preventDefault(); setShowFindReplace(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Load on mount ──────────────────────────────────────────────────────

  useEffect(() => { void loadData() }, [])    // eslint-disable-line react-hooks/exhaustive-deps

  // ── Slot contexts (memoised to avoid unnecessary re-renders) ───────────

  const modalsCtx = useMemo<ModalsCtx>(
    () => ({ rows, setRows, pushHistory }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows],
  )

  const toolbarFetchCtx = useMemo<ToolbarFetchCtx>(
    () => ({ rows, selectedRows, loading, setRows, pushHistory }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, selectedRows, loading],
  )

  const toolbarImportCtx = useMemo<ToolbarImportCtx>(
    () => ({ loading, setRows, pushHistory }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loading],
  )

  const replicateCtx = useMemo<ReplicateCtx>(
    () => ({ rows, selectedRows, visibleGroups, pushHistory, setRows }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, selectedRows, visibleGroups],
  )

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">

      {/* ── Sticky header ──────────────────────────────────────────── */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30">

        {/* ── Channel strip (slot) ─── */}
        {renderChannelStrip?.()}

        {/* ── Bar 1: menus + title + primary actions ────────────── */}
        <div className="px-3 h-10 flex items-center gap-2 border-b border-slate-100 dark:border-slate-800/60">

          <button
            type="button"
            onClick={() => router.push('/products')}
            className="p-1 -ml-0.5 flex-shrink-0 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label="Back to products"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          <MenuDropdown label="File" items={[
            { label: 'Reload from server', icon: <RefreshCw className="w-3.5 h-3.5" />, disabled: loading,
              onClick: () => { if (confirm('Reload rows? Unsaved edits will be lost.')) void loadData() } },
          ]} />

          <MenuDropdown label="Edit" items={[
            { label: 'Undo', icon: <Undo2 className="w-3.5 h-3.5" />, onClick: undo, disabled: historyIdx.current <= 0, shortcut: '⌘Z' },
            { label: 'Redo', icon: <Redo2 className="w-3.5 h-3.5" />, onClick: redo, disabled: historyIdx.current >= historyRef.current.length - 1, shortcut: '⌘⇧Z' },
            { separator: true },
            { label: 'Reset column group order', onClick: () => { setGroupOrder([]); try { localStorage.removeItem(`${storageKey}-group-order`) } catch {} }, disabled: !groupOrder.length },
            { label: 'Show all column groups', onClick: () => { setClosedGroups(new Set()); try { localStorage.removeItem(`${storageKey}-closed-groups`) } catch {} }, disabled: !closedGroups.size },
          ]} />

          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5 flex-shrink-0" />

          {titleIcon}
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">{title}</span>
          <Badge variant="default">{rows.length} rows</Badge>
          {dirtyCount > 0 && (
            <Badge variant="warning" className="flex-shrink-0">
              <AlertCircle className="w-3 h-3 mr-1" />{dirtyCount} unsaved
            </Badge>
          )}

          <div className="flex-1 min-w-0" />

          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5 flex-shrink-0" />

          {/* Discard + Save (always shared) */}
          <Button size="sm" variant="ghost"
            onClick={handleDiscard}
            disabled={!dirtyCount || loading}
            className="text-slate-500 hover:text-red-600 dark:hover:text-red-400">
            Discard
          </Button>

          <Button size="sm" variant="ghost"
            onClick={saveDraft}
            disabled={loading || saving}
            className={saveFlash ? 'text-emerald-600 dark:text-emerald-400' : ''}>
            {saving
              ? <><Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />Saving…</>
              : saveFlash
              ? <><CheckCircle2 className="w-3.5 h-3.5 mr-1" />Saved</>
              : 'Save'}
          </Button>

          {/* Channel-specific push section (slot) */}
          {renderPushExtras?.({ rows, selectedRows, dirtyCount, loading, saving })}
        </div>

        {/* ── Bar 2: icon toolbar ───────────────────────────────── */}
        <div className="px-3 h-8 flex items-center gap-0.5 border-b border-slate-100 dark:border-slate-800/60">

          <TbBtn icon={<Undo2 className="w-3.5 h-3.5" />} title="Undo (⌘Z)" onClick={undo} disabled={historyIdx.current <= 0} />
          <TbBtn icon={<Redo2 className="w-3.5 h-3.5" />} title="Redo (⌘⇧Z)" onClick={redo} disabled={historyIdx.current >= historyRef.current.length - 1} />

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />

          <TbBtn icon={<Copy className="w-3.5 h-3.5" />} title="Copy rows" onClick={() => setReplicateOpen(true)} disabled={!rows.length} />

          {onReplicate && (
            <TbBtn icon={<Copy className="w-3.5 h-3.5" />} title="Replicate to multiple markets" onClick={() => setReplicateOpen(true)} disabled={!rows.length} active={replicateOpen} />
          )}

          {/* Channel-specific fetch (slot) */}
          {renderToolbarFetch?.(toolbarFetchCtx)}

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />

          <TbBtn
            icon={<AlertTriangle className="w-3.5 h-3.5" />}
            title={errorCount + warnCount > 0
              ? `Validation: ${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warnCount} warning${warnCount !== 1 ? 's' : ''}`
              : 'Validation — no issues'}
            onClick={() => setShowValidation((o) => !o)}
            active={showValidation}
            badge={(errorCount + warnCount) || undefined}
          />

          <TbBtn
            icon={<ClipboardPaste className="w-3.5 h-3.5" />}
            title={smartPasteEnabled ? 'Smart paste ON — click to turn off' : 'Smart paste OFF — click to turn on'}
            onClick={() => setSmartPasteEnabled((o) => !o)}
            active={smartPasteEnabled}
          />

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />

          {/* Channel-specific import (slot) */}
          {renderToolbarImport?.(toolbarImportCtx)}

          <TbBtn
            icon={<ImageIcon className="w-3.5 h-3.5" />}
            title={showRowImages ? 'Hide product images' : 'Show product images in rows'}
            onClick={() => setShowRowImages((o) => !o)}
            disabled={!rows.length}
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

          <TbBtn
            icon={<SlidersHorizontal className="w-3.5 h-3.5" />}
            title={sortConfig.length > 0 ? `Sort — ${sortConfig.length} level${sortConfig.length !== 1 ? 's' : ''} active` : 'Sort rows'}
            onClick={() => setSortPanelOpen((o) => !o)}
            active={sortPanelOpen || sortConfig.length > 0}
            badge={sortConfig.length || undefined}
          />

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />

          <TbBtn icon={<Replace className="w-3.5 h-3.5" />} title="Find & Replace (⌘F)" onClick={() => setShowFindReplace((o) => !o)} active={showFindReplace} />

          <TbBtn
            icon={<Sparkles className="w-3.5 h-3.5" />}
            title={cfRules.length > 0 ? `Conditional formatting (${cfRules.filter((r) => r.enabled).length} active)` : 'Conditional formatting'}
            onClick={() => setShowConditional((o) => !o)}
            active={showConditional}
            badge={cfRules.filter((r) => r.enabled).length || undefined}
          />

          <TbBtn
            icon={<Sparkles className="w-3.5 h-3.5 text-amber-500" />}
            title={selectedRows.size > 0 ? `AI bulk actions (${selectedRows.size} selected)` : 'AI bulk actions — select rows first'}
            onClick={() => setAiModalOpen(true)}
            disabled={selectedRows.size === 0}
            badge={selectedRows.size || undefined}
          />
        </div>

        {/* ── Bar 3: search · filter · saved views · column pills ── */}
        <div className="px-3 py-1.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-3 flex-wrap">

          {/* Channel-specific left slot */}
          {renderBar3Left?.()}

          {/* Search */}
          <div className="relative flex items-center">
            <Search className="absolute left-2 w-3 h-3 text-slate-400 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setSearchQuery('')}
              placeholder="Search rows…"
              className="pl-6 pr-6 py-0.5 text-xs border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500 w-44"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-1.5 text-slate-400 hover:text-slate-600">
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
          {searchQuery && (
            <span className="text-xs text-slate-400 tabular-nums whitespace-nowrap">
              {filteredRows.length}/{rows.length}
            </span>
          )}

          {/* Filter */}
          <FFFilterPanel
            open={showFilter}
            onOpenChange={setShowFilter}
            value={filterState}
            onChange={setFilterState}
          />

          {/* Saved views */}
          <FFSavedViews
            currentState={{
              closedGroups: [...closedGroups],
              ffFilter: filterState,
              cfRules,
              frozenColCount: 0,
              sortConfig: [],
            } satisfies FFViewState}
            onApply={(state: FFViewState) => {
              setClosedGroups(new Set(state.closedGroups))
              setFilterState(state.ffFilter)
              setCfRules(state.cfRules)
            }}
          />

          {/* Column group pills */}
          <div className="flex items-center gap-1 flex-wrap ml-auto">
            <span className="text-xs text-slate-400 mr-1">Columns:</span>
            {orderedGroups.map((g) => {
              const open      = openGroups.has(g.id)
              const isDraggingThisGroup = draggingGroupId === g.id
              return (
                <button key={g.id} type="button"
                  draggable
                  onDragStart={(e) => { setDraggingGroupId(g.id); e.dataTransfer.effectAllowed = 'move' }}
                  onDragEnd={() => setDraggingGroupId(null)}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (!draggingGroupId || draggingGroupId === g.id) return
                    const ids  = orderedGroups.map((x) => x.id)
                    const from = ids.indexOf(draggingGroupId)
                    const to   = ids.indexOf(g.id)
                    const next = [...ids]
                    next.splice(from, 1)
                    next.splice(to, 0, draggingGroupId)
                    setGroupOrder(next)
                    try { localStorage.setItem(`${storageKey}-group-order`, JSON.stringify(next)) } catch {}
                    setDraggingGroupId(null)
                  }}
                  onClick={() => setClosedGroups((prev) => {
                    if (open && orderedGroups.filter((x) => !prev.has(x.id)).length <= 1) return prev
                    const n = new Set(prev)
                    open ? n.add(g.id) : n.delete(g.id)
                    try { localStorage.setItem(`${storageKey}-closed-groups`, JSON.stringify([...n])) } catch {}
                    return n
                  })}
                  title={g.label}
                  className={cn(
                    'inline-flex items-center gap-1 h-5 px-1.5 text-xs rounded border transition-all cursor-grab active:cursor-grabbing select-none',
                    gBadge(g.color),
                    open ? 'opacity-100' : 'opacity-40 hover:opacity-65',
                    isDraggingThisGroup && 'opacity-30 scale-95',
                  )}>
                  <ChevronRight className={cn('w-2.5 h-2.5 transition-transform', open && 'rotate-90')} />
                  <span className="font-medium">{g.label}</span>
                  <span className="opacity-60 tabular-nums">{g.columns.length}</span>
                </button>
              )
            })}
            {(groupOrder.length > 0 || closedGroups.size > 0) && (
              <button type="button"
                onClick={() => {
                  setGroupOrder([])
                  setClosedGroups(new Set())
                  try { localStorage.removeItem(`${storageKey}-group-order`); localStorage.removeItem(`${storageKey}-closed-groups`) } catch {}
                }}
                className="text-xs text-slate-400 hover:text-slate-600 px-1"
                title="Reset column group order and visibility">
                ↺
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ── Feed banner (slot) ──────────────────────────────────── */}
      {renderFeedBanner?.()}

      {/* ── Replicate modal ─────────────────────────────────────── */}
      {onReplicate && (
        <FFReplicateModal
          open={replicateOpen}
          onClose={() => setReplicateOpen(false)}
          sourceMarket={marketplace}
          groups={visibleGroups.map((g) => ({ id: g.id, labelEn: g.label, color: g.color }))}
          rowCount={rows.length}
          selectedRowCount={selectedRows.size}
          onReplicate={async (targets, groupIds, selectedOnly) =>
            onReplicate(targets, groupIds, selectedOnly, replicateCtx)
          }
        />
      )}

      {/* ── AI modal ────────────────────────────────────────────── */}
      <AIBulkModal
        open={aiModalOpen}
        onClose={() => setAiModalOpen(false)}
        selectedProductIds={[...selectedRows].flatMap((rowId) => {
          const row = rows.find((r) => r._rowId === rowId)
          return row?._productId ? [row._productId as string] : []
        })}
        marketplace={marketplace}
      />

      {/* ── Find / Replace ──────────────────────────────────────── */}
      {showFindReplace && (
        <FindReplaceBar
          open={showFindReplace}
          onClose={() => setShowFindReplace(false)}
          cells={findCells}
          rangeBounds={null}
          visibleColumns={allColumns.map((c) => ({ id: c.id, label: c.label }))}
          onActivate={() => {}}
          onMatchSetChange={() => {}}
          onReplaceCell={(rowId, colId, newValue) => updateCell(rowId, colId, newValue)}
        />
      )}

      {/* ── Conditional format ──────────────────────────────────── */}
      {showConditional && (
        <ConditionalFormatBar
          open={showConditional}
          onClose={() => setShowConditional(false)}
          rules={cfRules}
          onChange={setCfRules}
          visibleColumns={allColumns.map((c) => ({ id: c.id, label: c.label }))}
        />
      )}

      {/* ── Validation panel ────────────────────────────────────── */}
      {showValidation && validationIssues.length > 0 && (
        <div className="border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-4 py-2 max-h-40 overflow-y-auto">
          {validationIssues.map((issue, i) => (
            <div key={i} className={cn('flex items-center gap-2 text-xs py-0.5', issue.level === 'error' ? 'text-red-600' : 'text-amber-600')}>
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span className="font-mono">{issue.sku}</span>
              <span className="text-slate-400">·</span>
              <span className="font-medium">{issue.field}</span>
              <span className="text-slate-400">·</span>
              <span>{issue.msg}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Channel-specific modals (slot) ──────────────────────── */}
      {renderModals?.(modalsCtx)}

      {/* ── Main grid ───────────────────────────────────────────── */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
          </div>
        )}

        {!loading && (
          <table className="border-collapse text-sm w-max min-w-full">
            {/* Sticky two-row header: row 1 = group bands, row 2 = column labels */}
            <thead className="sticky top-0 z-20 bg-white dark:bg-slate-900">
              {/* Row 1: group colour bands */}
              <tr>
                {/* Checkbox / drag handle — spans both header rows */}
                <th
                  className="sticky left-0 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 w-9 min-w-[36px] text-center"
                  rowSpan={2}
                >
                  <input
                    type="checkbox"
                    className="w-3.5 h-3.5 accent-blue-600"
                    checked={rows.length > 0 && selectedRows.size === rows.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedRows.size > 0 && selectedRows.size < rows.length
                    }}
                    onChange={(e) =>
                      setSelectedRows(e.target.checked ? new Set(rows.map((r) => r._rowId)) : new Set())
                    }
                  />
                </th>
                {/* Row # — spans both header rows */}
                <th
                  className="sticky left-9 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 text-xs text-slate-400 text-center font-normal w-10 min-w-[40px]"
                  rowSpan={2}
                >
                  #
                </th>
                {/* Group colour band headers */}
                {visibleGroups.map((group) => (
                  <th
                    key={group.id}
                    colSpan={group.columns.length}
                    className={cn(
                      'px-2 py-1 text-xs font-bold border-b border-r border-slate-200 dark:border-slate-700 text-left whitespace-nowrap',
                      gColor(group.color).header,
                    )}
                  >
                    <button
                      onClick={() =>
                        setClosedGroups((prev) => {
                          const next = new Set(prev)
                          if (next.has(group.id)) next.delete(group.id)
                          else next.add(group.id)
                          return next
                        })
                      }
                      className="flex items-center gap-1"
                    >
                      <ChevronDown className={cn('h-3 w-3 transition-transform', closedGroups.has(group.id) && '-rotate-90')} />
                      {group.label}
                    </button>
                  </th>
                ))}
              </tr>
              {/* Row 2: column labels */}
              <tr>
                {visibleColumns.map((col) => (
                  <th
                    key={col.id}
                    className={cn(
                      'px-2 py-0.5 text-left text-xs font-semibold border-b border-r border-slate-200 dark:border-slate-700 whitespace-nowrap select-none',
                      gColor(visibleGroups.find(g => g.columns.some(c => c.id === col.id))?.color ?? 'slate').header,
                      col.required && 'font-bold',
                    )}
                    style={{ minWidth: col.width, maxWidth: col.width }}
                    title={col.description}
                  >
                    {col.label}{col.required && <span className="ml-0.5 text-red-500">*</span>}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {(() => {
                const rendered: React.ReactNode[] = []
                let bandIdx = 0

                rowGroups.forEach((groupRows, groupKey) => {
                  const bandClass = GROUP_BAND_COLORS[bandIdx % GROUP_BAND_COLORS.length]
                  bandIdx++
                  const isCollapsed = collapsedRowGroups.has(groupKey)
                  const headerRow   = groupRows[0]

                  if (groupRows.length > 1) {
                    rendered.push(
                      <GroupHeader
                        key={`header-${groupKey}`}
                        row={headerRow}
                        bandClass={bandClass}
                        isExpanded={!isCollapsed}
                        showImage={showRowImages}
                        imageSize={imageSize}
                        colSpanCount={visibleColumns.length + 2}
                        onToggle={() =>
                          setCollapsedRowGroups((prev) => {
                            const next = new Set(prev)
                            if (next.has(groupKey)) next.delete(groupKey)
                            else next.add(groupKey)
                            return next
                          })
                        }
                      />,
                    )
                  }

                  if (isCollapsed) return

                  const visibleGroupRows = groupRows.filter((r) =>
                    filteredRows.some((fr) => fr._rowId === r._rowId),
                  )

                  visibleGroupRows.forEach((row, rowDisplayIdx) => {
                    const isRowSelected  = selectedRows.has(row._rowId)
                    const isDraggingThis = draggingRowId === row._rowId
                    const dropInd        = dropTarget?.rowId === row._rowId ? dropTarget.half : null

                    const rowBg = isRowSelected
                      ? 'bg-blue-50/40 dark:bg-blue-900/10'
                      : row._status === 'pushed'  ? 'bg-emerald-50/70 dark:bg-emerald-950/20'
                      : row._status === 'error'   ? 'bg-red-50/70 dark:bg-red-950/20'
                      : row._status === 'pending' ? 'bg-amber-50/70 dark:bg-amber-950/20'
                      : row._isNew  ? 'bg-sky-50/40 dark:bg-sky-950/10'
                      : row._dirty  ? 'bg-yellow-50/40 dark:bg-yellow-950/10'
                      : groupRows.length > 1 ? bandClass
                      : ''

                    // Opaque bg for sticky cells — prevents content bleed-through on horizontal scroll
                    const frozenBg = row._status === 'pushed'  ? 'bg-emerald-50 dark:bg-emerald-950/60'
                      : row._status === 'error'   ? 'bg-red-50 dark:bg-red-950/60'
                      : row._status === 'pending' ? 'bg-amber-50 dark:bg-amber-950/60'
                      : row._isNew  ? 'bg-sky-50 dark:bg-sky-950/40'
                      : row._dirty  ? 'bg-yellow-50 dark:bg-yellow-950/40'
                      : 'bg-white dark:bg-slate-900'

                    void rowDisplayIdx

                    // Conditional formatting per cell
                    const cfClassMap: Record<string, string> = {}
                    if (cfRules.length > 0) {
                      visibleColumns.forEach((col) => {
                        const val = String(row[col.id] ?? '')
                        for (const rule of cfRules) {
                          if (evaluateRule(rule, val)) { cfClassMap[col.id] = TONE_CLASSES[rule.tone]; break }
                        }
                      })
                    }

                    rendered.push(
                      <tr
                        key={row._rowId}
                        draggable
                        onDragStart={(e) => {
                          if (!canDragRef.current) { e.preventDefault(); return }
                          e.dataTransfer.effectAllowed = 'move'
                          setDraggingRowId(row._rowId)
                        }}
                        onDragEnd={() => { canDragRef.current = false; setDraggingRowId(null); setDropTarget(null) }}
                        onDragOver={(e) => {
                          e.preventDefault()
                          const rect = e.currentTarget.getBoundingClientRect()
                          const half: 'top' | 'bottom' = e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom'
                          setDropTarget((p) => p?.rowId === row._rowId && p.half === half ? p : { rowId: row._rowId, half })
                        }}
                        onDrop={(e) => {
                          e.preventDefault()
                          const rect = e.currentTarget.getBoundingClientRect()
                          if (draggingRowId) reorderRow(draggingRowId, row._rowId, e.clientY < rect.top + rect.height / 2 ? 'top' : 'bottom')
                        }}
                        style={{
                          borderTop:    dropInd === 'top'    ? '2px solid #3b82f6' : undefined,
                          borderBottom: dropInd === 'bottom' ? '2px solid #3b82f6' : undefined,
                        }}
                        className={cn(
                          'group/row border-b border-slate-100 dark:border-slate-800 transition-colors',
                          rowBg,
                          isDraggingThis ? 'opacity-40' : 'hover:bg-white/60 dark:hover:bg-slate-800/40',
                        )}
                      >
                        {/* Col 1: checkbox + drag handle (sticky left-0) */}
                        <td
                          className={cn(
                            'sticky left-0 z-10 border-b border-r border-slate-200 dark:border-slate-700 px-1.5 w-9 text-center cursor-grab active:cursor-grabbing',
                            frozenBg,
                          )}
                          onMouseDown={() => { canDragRef.current = true }}
                          onMouseUp={() => { canDragRef.current = false }}
                        >
                          {row._status === 'pushed'
                            ? <CheckCircle2 className="w-3 h-3 text-emerald-500 mx-auto" />
                            : row._status === 'error'
                            ? <span title={String(row._feedMessage ?? '')}><AlertCircle className="w-3 h-3 text-red-500 mx-auto" /></span>
                            : row._status === 'pending'
                            ? <Loader2 className="w-3 h-3 text-amber-500 animate-spin mx-auto" />
                            : <input
                                type="checkbox"
                                className="w-3.5 h-3.5 accent-blue-600"
                                checked={isRowSelected}
                                onChange={(e) =>
                                  setSelectedRows((prev) => {
                                    const next = new Set(prev)
                                    if (e.target.checked) next.add(row._rowId)
                                    else next.delete(row._rowId)
                                    return next
                                  })
                                }
                              />
                          }
                        </td>

                        {/* Col 2: row # + push-status badge + optional image (sticky left-9) */}
                        <td
                          className={cn(
                            'sticky left-9 z-10 border-b border-r border-slate-200 dark:border-slate-700 px-0.5 w-10 min-w-[40px] select-none',
                            frozenBg,
                          )}
                        >
                          <div className="flex flex-col items-center gap-0.5 py-0.5">
                            {showRowImages && (() => {
                              const imgUrl = row.image_1 ? String(row.image_1) : null
                              return imgUrl ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={imgUrl} alt="" style={{ width: imageSize, height: imageSize }}
                                  className="rounded object-cover border border-slate-200 dark:border-slate-700 flex-shrink-0"
                                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                              ) : (
                                <div className="rounded border border-dashed border-slate-200 dark:border-slate-700 flex items-center justify-center flex-shrink-0"
                                  style={{ width: imageSize, height: imageSize }}>
                                  <ImageIcon className="text-slate-300 dark:text-slate-600" style={{ width: imageSize * 0.4, height: imageSize * 0.4 }} />
                                </div>
                              )
                            })()}
                            <span className="text-xs text-slate-400 tabular-nums leading-none">
                              {rows.indexOf(row) + 1}
                            </span>
                            {rowStatusIcon(row._status)}
                          </div>
                        </td>

                        {/* Data cells — rendered by channel-specific CellComponent */}
                        {visibleColumns.map((col) => (
                          <CellComponent
                            key={col.id}
                            col={col}
                            row={row}
                            value={row[col.id]}
                            isActive={activeCell?.rowId === row._rowId && activeCell?.colId === col.id}
                            isSelected={isRowSelected}
                            cfClass={cfClassMap[col.id]}
                            rowBandClass={groupRows.length > 1 ? bandClass : undefined}
                            onChange={(v) => updateCell(row._rowId, col.id, v)}
                            onActivate={() => setActiveCell({ rowId: row._rowId, colId: col.id })}
                          />
                        ))}
                      </tr>,
                    )
                  })
                })

                return rendered
              })()}

              {/* Empty state */}
              {filteredRows.length === 0 && !loading && (
                <tr>
                  <td colSpan={visibleColumns.length + 2} className="px-6 py-6 text-center text-sm text-slate-400 italic">
                    {searchQuery ? 'No rows match your search.' : 'No rows yet.'}
                  </td>
                </tr>
              )}

              {/* Add-row footer — matches Amazon layout */}
              <tr>
                <td colSpan={visibleColumns.length + 2}
                  className="px-4 py-2 border-t border-dashed border-slate-200 dark:border-slate-700">
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="ghost" onClick={addRow}>
                      <Plus className="w-3.5 h-3.5 mr-1" />Add row
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
        )}
      </div>

      {/* ── Status bar — matches Amazon style ───────────────────── */}
      <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-1 flex items-center gap-4 text-xs text-slate-400 select-none flex-shrink-0">
        <span>{filteredRows.length} row{filteredRows.length !== 1 ? 's' : ''}</span>
        {selectedRows.size > 0 && <span className="text-blue-500">{selectedRows.size} selected</span>}
        {dirtyCount > 0 && <span className="text-amber-500 ml-auto">{dirtyCount} unsaved change{dirtyCount !== 1 ? 's' : ''}</span>}
        {(errorCount > 0 || warnCount > 0) && (
          <button
            type="button"
            onClick={() => setShowValidation((o) => !o)}
            className={cn('flex items-center gap-1 ml-auto', errorCount > 0 ? 'text-red-500' : 'text-amber-500')}
          >
            <AlertTriangle className="w-3 h-3" />
            {errorCount > 0 && <span>{errorCount} error{errorCount !== 1 ? 's' : ''}</span>}
            {warnCount  > 0 && <span>{warnCount} warning{warnCount !== 1 ? 's' : ''}</span>}
          </button>
        )}
        <span className="ml-auto">{channel.toUpperCase()} · {marketplace}</span>
      </div>
    </div>
  )
}

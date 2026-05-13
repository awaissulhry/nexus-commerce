'use client'

import {
  useCallback, useEffect, useRef, useState, useMemo,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle, CheckCircle2, ChevronDown, ChevronLeft,
  Loader2, RefreshCw, Send, Undo2, Redo2,
  Download, Search, ArrowDownToLine, Replace, SlidersHorizontal,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { FindReplaceBar } from '@/app/bulk-operations/components/FindReplaceBar'
import { ConditionalFormatBar } from '@/app/bulk-operations/components/ConditionalFormatBar'
import { evaluateRule, TONE_CLASSES, type ConditionalRule } from '@/app/bulk-operations/lib/conditional-format'
import { type FindCell } from '@/app/bulk-operations/lib/find-replace'
import { FFFilterPanel, FF_FILTER_DEFAULT, type FFFilterState } from '../amazon-flat-file/FFFilterPanel'
import { ChannelStrip } from './ChannelStrip'
import {
  EBAY_COLUMN_GROUPS,
  getAllEbayColumns,
  EBAY_MARKETPLACES,
  type EbayColumn,
} from './ebay-columns'

// ── Types ──────────────────────────────────────────────────────────────

export interface EbayRow {
  _rowId: string
  _productId?: string
  _dirty?: boolean
  _status?: 'idle' | 'pending' | 'pushed' | 'error'
  _feedMessage?: string
  sku: string
  ebay_item_id?: string
  ean?: string
  mpn?: string
  title?: string
  condition?: string
  category_id?: string
  subtitle?: string
  description?: string
  price?: number | string
  best_offer_enabled?: boolean
  best_offer_floor?: number | string
  best_offer_ceiling?: number | string
  quantity?: number | string
  handling_time?: number | string
  image_1?: string
  image_2?: string
  image_3?: string
  image_4?: string
  image_5?: string
  image_6?: string
  brand?: string
  colour?: string
  size?: string
  material?: string
  model_number?: string
  custom_label?: string
  fulfillment_policy_id?: string
  payment_policy_id?: string
  return_policy_id?: string
  listing_status?: string
  last_pushed_at?: string
  sync_status?: string
  platformProductId?: string
  [key: string]: unknown
}

interface PushResult {
  sku: string
  status: 'PUSHED' | 'ERROR'
  message: string
  itemId?: string
}

interface FeedStatus {
  taskId: string
  status: string
  completionDate?: string
  summaryCount?: number
  failureCount?: number
}

// ── Constants ──────────────────────────────────────────────────────────

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
}

function gColor(color: string) {
  return GROUP_COLORS[color] ?? GROUP_COLORS.slate
}

function statusBadgeCls(status?: string) {
  switch (status?.toUpperCase()) {
    case 'ACTIVE': return 'bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300'
    case 'DRAFT':  return 'bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-900/40 dark:text-amber-300'
    case 'ERROR':  return 'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/40 dark:text-red-300'
    default:       return 'bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-400'
  }
}

function rowStatusIcon(status?: EbayRow['_status']) {
  switch (status) {
    case 'pending': return <Loader2 className="h-3 w-3 animate-spin text-blue-500" />
    case 'pushed':  return <CheckCircle2 className="h-3 w-3 text-emerald-500" />
    case 'error':   return <AlertCircle className="h-3 w-3 text-red-500" />
    default:        return null
  }
}

// ── Description modal ──────────────────────────────────────────────────

interface DescriptionModalProps {
  value: string
  onSave: (v: string) => void
  onClose: () => void
}

function DescriptionModal({ value, onSave, onClose }: DescriptionModalProps) {
  const [text, setText] = useState(value)
  const remaining = 4000 - text.length

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl flex flex-col w-[800px] max-w-full max-h-[80vh] p-4 gap-2">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-sm">Description Editor</span>
          <span className={cn('text-xs', remaining < 0 ? 'text-red-600' : 'text-slate-400')}>
            {remaining} chars remaining
          </span>
        </div>
        <textarea
          className="flex-1 min-h-[400px] border border-slate-300 dark:border-slate-600 rounded-lg p-3 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-slate-800 dark:text-slate-100"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Enter HTML description..."
        />
        <p className="text-xs text-slate-400">HTML is supported. Use &lt;p&gt;, &lt;ul&gt;, &lt;li&gt;, &lt;br&gt; etc.</p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => { onSave(text); onClose() }}>Save</Button>
        </div>
      </div>
    </div>
  )
}

// ── SpreadsheetCell ────────────────────────────────────────────────────

interface CellProps {
  col: EbayColumn
  value: unknown
  isActive: boolean
  isSelected: boolean
  cfClass?: string
  rowBandClass?: string
  onChange: (v: unknown) => void
  onActivate: () => void
  onOpenDescription: () => void
}

function SpreadsheetCell({
  col, value, isActive, isSelected, cfClass, rowBandClass, onChange, onActivate, onOpenDescription,
}: CellProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null)

  const displayVal = value == null || value === '' ? '' : String(value)
  const isReadOnly = col.readOnly || col.kind === 'readonly'

  const startEdit = useCallback(() => {
    if (isReadOnly) return
    if (col.kind === 'longtext') { onOpenDescription(); return }
    setDraft(displayVal)
    setEditing(true)
  }, [isReadOnly, col.kind, displayVal, onOpenDescription])

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
    }
  }, [editing])

  function commit(v: string) {
    setEditing(false)
    let coerced: unknown = v
    if (col.kind === 'number') coerced = v === '' ? '' : Number(v)
    if (col.kind === 'boolean') coerced = v === 'true' || v === '1'
    onChange(coerced)
  }

  const cellBase = cn(
    'h-7 px-1.5 flex items-center border-r border-b border-slate-200 dark:border-slate-700',
    'text-xs overflow-hidden cursor-pointer select-none',
    isReadOnly && 'bg-slate-50/60 dark:bg-slate-900/40 text-slate-400',
    !isReadOnly && (rowBandClass ?? ''),
    !isReadOnly && (cfClass ?? ''),
    isActive && 'ring-2 ring-inset ring-blue-500',
    isSelected && !isActive && 'bg-blue-100/60 dark:bg-blue-900/20',
    col.id === 'sku' && 'font-mono font-medium',
  )

  if (editing) {
    if (col.kind === 'enum') {
      return (
        <td className={cellBase} style={{ minWidth: col.width, maxWidth: col.width }}>
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            className="w-full h-full text-xs bg-white dark:bg-slate-800 border-none outline-none"
            value={draft}
            onChange={(e) => { commit(e.target.value); setEditing(false) }}
            onBlur={() => commit(draft)}
          >
            {(col.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </td>
      )
    }
    if (col.kind === 'boolean') {
      return (
        <td className={cellBase} style={{ minWidth: col.width, maxWidth: col.width }}>
          <select
            ref={inputRef as React.RefObject<HTMLSelectElement>}
            className="w-full h-full text-xs bg-white dark:bg-slate-800 border-none outline-none"
            value={draft}
            onChange={(e) => { commit(e.target.value); setEditing(false) }}
            onBlur={() => commit(draft)}
          >
            <option value="">—</option>
            <option value="true">Yes</option>
            <option value="false">No</option>
          </select>
        </td>
      )
    }
    return (
      <td className={cellBase} style={{ minWidth: col.width, maxWidth: col.width }}>
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type={col.kind === 'number' ? 'number' : 'text'}
          className="w-full h-full text-xs bg-transparent border-none outline-none"
          value={draft}
          maxLength={col.maxLength}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); commit(draft) }
            if (e.key === 'Escape') { setEditing(false) }
          }}
        />
      </td>
    )
  }

  // Title cell: show char count
  if (col.id === 'title') {
    const len = displayVal.length
    const overLimit = len > 80
    return (
      <td
        className={cellBase}
        style={{ minWidth: col.width, maxWidth: col.width }}
        onClick={onActivate}
        onDoubleClick={startEdit}
      >
        <span className="flex-1 truncate">{displayVal}</span>
        {len > 0 && (
          <span className={cn('ml-1 text-[10px] shrink-0', overLimit ? 'text-red-500' : 'text-slate-400')}>
            {len}
          </span>
        )}
      </td>
    )
  }

  // Description: show snippet + edit trigger
  if (col.id === 'description') {
    return (
      <td
        className={cellBase}
        style={{ minWidth: col.width, maxWidth: col.width }}
        onClick={onActivate}
        onDoubleClick={onOpenDescription}
      >
        <span className="truncate text-slate-400 italic text-[10px]">
          {displayVal ? displayVal.replace(/<[^>]+>/g, '').slice(0, 40) + '…' : 'Double-click to edit…'}
        </span>
      </td>
    )
  }

  // Boolean display
  if (col.kind === 'boolean') {
    return (
      <td
        className={cellBase}
        style={{ minWidth: col.width, maxWidth: col.width }}
        onClick={onActivate}
        onDoubleClick={startEdit}
      >
        {value === true || value === 'true' ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
    )
  }

  // Status badge for listing_status
  if (col.id === 'listing_status') {
    return (
      <td className={cellBase} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate}>
        {displayVal && (
          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', statusBadgeCls(displayVal))}>
            {displayVal}
          </span>
        )}
      </td>
    )
  }

  // Date display for last_pushed_at
  if (col.id === 'last_pushed_at') {
    const d = displayVal ? new Date(displayVal) : null
    return (
      <td className={cellBase} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate}>
        <span className="truncate text-slate-400 text-[10px]">
          {d ? d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
        </span>
      </td>
    )
  }

  return (
    <td
      className={cellBase}
      style={{ minWidth: col.width, maxWidth: col.width }}
      onClick={onActivate}
      onDoubleClick={startEdit}
    >
      <span className="truncate">{displayVal || <span className="text-slate-300">—</span>}</span>
    </td>
  )
}

// ── Group header band ──────────────────────────────────────────────────

interface GroupHeaderProps {
  row: EbayRow
  allColumns: EbayColumn[]
  bandClass: string
  isExpanded: boolean
  onToggle: () => void
}

function GroupHeader({ row, allColumns: _allColumns, bandClass, isExpanded, onToggle }: GroupHeaderProps) {
  return (
    <tr className={cn('border-b border-slate-200 dark:border-slate-700', bandClass)}>
      <td colSpan={99} className="px-3 py-1">
        <div className="flex items-center gap-3">
          <button
            onClick={onToggle}
            className="flex items-center gap-1 text-xs font-medium text-slate-600 dark:text-slate-300 hover:text-slate-900"
          >
            <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !isExpanded && '-rotate-90')} />
            {row.title || row.sku || 'Untitled'}
          </button>
          {row.category_id && (
            <span className="text-[10px] text-slate-400">Cat: {row.category_id}</span>
          )}
          {row.condition && (
            <span className="rounded bg-slate-200 dark:bg-slate-700 px-1 py-0.5 text-[10px] text-slate-600 dark:text-slate-300">
              {row.condition}
            </span>
          )}
          {row.listing_status && (
            <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', statusBadgeCls(row.listing_status))}>
              {row.listing_status}
            </span>
          )}
          {row.image_1 && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.image_1}
              alt=""
              className="h-6 w-6 rounded object-cover border border-slate-200 dark:border-slate-700"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
          )}
        </div>
      </td>
    </tr>
  )
}

// ── Feed status banner ─────────────────────────────────────────────────

function FeedStatusBanner({ feedStatus, onPoll }: { feedStatus: FeedStatus; onPoll: () => void }) {
  const done = ['COMPLETED', 'COMPLETED_WITH_ERROR'].includes(feedStatus.status)
  const failed = feedStatus.status === 'FAILED'

  return (
    <div className={cn(
      'flex items-center gap-3 px-4 py-2 text-sm border-b',
      done && !failed ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : '',
      failed ? 'bg-red-50 border-red-200 text-red-800' : '',
      !done && !failed ? 'bg-blue-50 border-blue-200 text-blue-800' : '',
    )}>
      {!done && !failed && <Loader2 className="h-4 w-4 animate-spin" />}
      {done && !failed && <CheckCircle2 className="h-4 w-4" />}
      {failed && <AlertCircle className="h-4 w-4" />}
      <span>
        Feed task <code className="font-mono text-xs">{feedStatus.taskId}</code>: <strong>{feedStatus.status}</strong>
        {feedStatus.summaryCount != null && ` — ${feedStatus.summaryCount} succeeded`}
        {feedStatus.failureCount != null && `, ${feedStatus.failureCount} failed`}
      </span>
      {!done && !failed && (
        <button onClick={onPoll} className="ml-auto text-xs underline">Refresh</button>
      )}
    </div>
  )
}

// ── Validation panel ───────────────────────────────────────────────────

interface ValidationIssue { level: 'error' | 'warn'; sku: string; field: string; msg: string }

function validateRows(rows: EbayRow[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const row of rows) {
    if (!row.sku) issues.push({ level: 'error', sku: '?', field: 'sku', msg: 'SKU is required' })
    if (!row.title) issues.push({ level: 'warn', sku: row.sku, field: 'title', msg: 'Title is empty' })
    if (row.title && row.title.length > 80) issues.push({ level: 'error', sku: row.sku, field: 'title', msg: `Title exceeds 80 chars (${row.title.length})` })
    if (!row.price || Number(row.price) <= 0) issues.push({ level: 'warn', sku: row.sku, field: 'price', msg: 'Price is 0 or missing' })
    if (row.quantity == null || Number(row.quantity) < 0) issues.push({ level: 'warn', sku: row.sku, field: 'quantity', msg: 'Quantity is missing or negative' })
  }
  return issues
}

// ── Props ──────────────────────────────────────────────────────────────

interface Props {
  initialRows: EbayRow[]
  initialMarketplace: string
  familyId?: string
}

// ── Main component ─────────────────────────────────────────────────────

export default function EbayFlatFileClient({ initialRows, initialMarketplace, familyId }: Props) {
  const router = useRouter()
  const { toast } = useToast()

  const [marketplace, setMarketplace] = useState(initialMarketplace)
  const [rows, setRows] = useState<EbayRow[]>(initialRows)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [pushing, setPushing] = useState(false)

  // Selection
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set())
  const [activeCell, setActiveCell] = useState<{ rowId: string; colId: string } | null>(null)

  // UI toggles
  const [showFilter, setShowFilter] = useState(false)
  const [filterState, setFilterState] = useState<FFFilterState>(FF_FILTER_DEFAULT)
  const [showFindReplace, setShowFindReplace] = useState(false)
  const [showConditional, setShowConditional] = useState(false)
  const [cfRules, setCfRules] = useState<ConditionalRule[]>([])
  const [showValidation, setShowValidation] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  // Groups collapsed state
  const [collapsedColumnGroups, setCollapsedColumnGroups] = useState<Set<string>>(new Set())
  // Collapsed row groups (platformProductId)
  const [collapsedRowGroups, setCollapsedRowGroups] = useState<Set<string>>(new Set())

  // Description editor
  const [descModal, setDescModal] = useState<{ rowId: string } | null>(null)

  // Push results
  const [feedStatus, setFeedStatus] = useState<FeedStatus | null>(null)

  // Undo/redo
  const historyRef = useRef<EbayRow[][]>([initialRows])
  const historyIdx = useRef(0)

  // ── Derived ───────────────────────────────────────────────────────────

  const allColumns = useMemo(() => getAllEbayColumns(), [])
  const visibleGroups = useMemo(
    () => EBAY_COLUMN_GROUPS.filter((g) => !collapsedColumnGroups.has(g.id)),
    [collapsedColumnGroups],
  )
  const visibleColumns = useMemo(
    () => visibleGroups.flatMap((g) => g.columns),
    [visibleGroups],
  )

  // Row groups: group rows by platformProductId
  const rowGroups = useMemo(() => {
    const groups = new Map<string, EbayRow[]>()
    for (const row of rows) {
      const key = row.platformProductId ?? row._rowId
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(row)
    }
    return groups
  }, [rows])

  // Filtered rows based on search + filter
  const filteredRows = useMemo(() => {
    let result = rows
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      result = result.filter((r) =>
        String(r.sku).toLowerCase().includes(q) ||
        String(r.title ?? '').toLowerCase().includes(q) ||
        String(r.ebay_item_id ?? '').includes(q),
      )
    }
    return result
  }, [rows, searchQuery])

  const validationIssues = useMemo(() => validateRows(rows), [rows])

  // ── Helpers ───────────────────────────────────────────────────────────

  function pushHistory(nextRows: EbayRow[]) {
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

  function updateCell(rowId: string, colId: string, value: unknown) {
    const nextRows = rows.map((r) =>
      r._rowId === rowId ? { ...r, [colId]: value, _dirty: true } : r,
    )
    pushHistory(nextRows)
    setRows(nextRows)
  }

  // ── API calls ─────────────────────────────────────────────────────────

  async function loadRows(mp: string) {
    setLoading(true)
    try {
      const qs = new URLSearchParams({ marketplace: mp })
      if (familyId) qs.set('familyId', familyId)
      const res = await fetch(`${getBackendUrl()}/api/ebay/flat-file/rows?${qs}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { rows: EbayRow[] }
      setRows(json.rows)
      pushHistory(json.rows)
    } catch (err) {
      toast.error('Failed to load rows: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }

  async function saveDraft() {
    const dirty = rows.filter((r) => r._dirty)
    if (!dirty.length) { toast({ title: 'Nothing to save', tone: 'info' }); return }
    setSaving(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/flat-file/rows`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: dirty }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { saved: number }
      setRows((prev) => prev.map((r) => ({ ...r, _dirty: false })))
      toast.success(`Saved ${json.saved} rows`)
    } catch (err) {
      toast.error('Save failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  async function pushToEbay() {
    const toPush = selectedRows.size > 0
      ? rows.filter((r) => selectedRows.has(r._rowId))
      : rows.filter((r) => r._dirty || !r.ebay_item_id)

    if (!toPush.length) {
      toast({ title: 'Nothing to push', description: 'Select rows or mark as dirty first.', tone: 'info' })
      return
    }

    const mode = toPush.length > 50 ? 'feed' : 'api'
    setPushing(true)

    // Mark rows as pending
    setRows((prev) =>
      prev.map((r) =>
        toPush.find((p) => p._rowId === r._rowId) ? { ...r, _status: 'pending' } : r,
      ),
    )

    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/flat-file/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: toPush, marketplace, mode }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as {
        mode: string
        pushed?: number
        errors?: number
        results?: PushResult[]
        taskId?: string
      }

      if (json.mode === 'feed' && json.taskId) {
        setFeedStatus({ taskId: json.taskId, status: 'CREATED' })
        toast({ title: 'Feed submitted', description: `Task ID: ${json.taskId}`, tone: 'success' })
        // Mark rows as pushed optimistically
        setRows((prev) =>
          prev.map((r) =>
            toPush.find((p) => p._rowId === r._rowId) ? { ...r, _status: 'pushed', _dirty: false } : r,
          ),
        )
      } else {
        // API mode — apply per-row results
        const resultMap = new Map((json.results ?? []).map((r) => [r.sku, r]))
        setRows((prev) =>
          prev.map((r) => {
            const result = resultMap.get(r.sku)
            if (!result) return r
            return {
              ...r,
              _status: result.status === 'PUSHED' ? 'pushed' : 'error',
              _feedMessage: result.message,
              _dirty: result.status !== 'PUSHED',
              ebay_item_id: result.itemId ?? r.ebay_item_id,
            }
          }),
        )
        toast({
          title: `Push complete`,
          description: `${json.pushed ?? 0} pushed, ${json.errors ?? 0} errors`,
          tone: (json.errors ?? 0) > 0 ? 'warning' : 'success',
        })
      }
    } catch (err) {
      setRows((prev) =>
        prev.map((r) =>
          toPush.find((p) => p._rowId === r._rowId) ? { ...r, _status: 'error' } : r,
        ),
      )
      toast.error('Push failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setPushing(false)
    }
  }

  async function importFromAmazon() {
    setLoading(true)
    try {
      const productIds = rows.map((r) => r._productId).filter(Boolean).join(',')
      const qs = new URLSearchParams({ marketplace })
      if (productIds) qs.set('productIds', productIds)
      const res = await fetch(`${getBackendUrl()}/api/ebay/flat-file/amazon-import?${qs}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { rows: EbayRow[] }

      // Merge Amazon data into existing rows by sku
      const amazonMap = new Map(json.rows.map((r) => [r.sku, r]))
      setRows((prev) =>
        prev.map((r) => {
          const az = amazonMap.get(r.sku)
          if (!az) return r
          return {
            ...r,
            title: az.title || r.title,
            description: az.description || r.description,
            price: az.price ?? r.price,
            quantity: az.quantity ?? r.quantity,
            image_1: az.image_1 || r.image_1,
            image_2: az.image_2 || r.image_2,
            image_3: az.image_3 || r.image_3,
            brand: az.brand || r.brand,
            colour: az.colour || r.colour,
            size: az.size || r.size,
            material: az.material || r.material,
            model_number: az.model_number || r.model_number,
            ean: az.ean || r.ean,
            _dirty: true,
          }
        }),
      )
      toast.success(`Imported ${json.rows.length} rows from Amazon`)
    } catch (err) {
      toast.error('Amazon import failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }

  async function pollFeedStatus() {
    if (!feedStatus?.taskId) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/ebay/flat-file/feed/${feedStatus.taskId}?marketplace=${marketplace}`,
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as FeedStatus
      setFeedStatus(json)
    } catch (err) {
      toast.error('Feed poll failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  // ── Marketplace change ────────────────────────────────────────────────

  function handleMarketplaceChange(mp: string) {
    setMarketplace(mp)
    const qs = new URLSearchParams({ marketplace: mp })
    if (familyId) qs.set('familyId', familyId)
    router.push(`/products/ebay-flat-file?${qs}`)
    loadRows(mp)
  }

  // ── Find/Replace cells helper ─────────────────────────────────────────

  const findCells = useMemo((): FindCell[] => {
    const cells: FindCell[] = []
    rows.forEach((row, ri) => {
      allColumns.forEach((col, ci) => {
        cells.push({
          rowIdx: ri,
          colIdx: ci,
          rowId: row._rowId,
          columnId: col.id,
          value: String(row[col.id] ?? ''),
        })
      })
    })
    return cells
  }, [rows, allColumns])

  // ── Render ─────────────────────────────────────────────────────────────

  const dirtyCount = rows.filter((r) => r._dirty).length
  const errorCount = validationIssues.filter((i) => i.level === 'error').length
  const warnCount  = validationIssues.filter((i) => i.level === 'warn').length

  return (
    <div className="flex flex-col h-screen bg-white dark:bg-slate-950 overflow-hidden">
      {/* Channel strip */}
      <ChannelStrip channel="ebay" marketplace={marketplace} familyId={familyId} />

      {/* Header */}
      <header className="border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shrink-0">
        {/* Bar 1: nav + title */}
        <div className="flex items-center gap-2 px-4 py-2">
          <button
            onClick={() => router.push('/products')}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Products
          </button>
          <span className="text-slate-300 dark:text-slate-600">/</span>
          <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">
            eBay Flat File
          </span>
          <Badge className="text-xs">
            {rows.length} rows
          </Badge>
          {dirtyCount > 0 && (
            <Badge className="bg-amber-100 text-amber-700 border border-amber-200 text-xs">
              {dirtyCount} unsaved
            </Badge>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {/* Market pills */}
            {EBAY_MARKETPLACES.map((mp) => (
              <button
                key={mp}
                onClick={() => handleMarketplaceChange(mp)}
                className={cn(
                  'rounded px-2 py-0.5 text-xs font-medium transition-colors',
                  marketplace === mp
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400',
                )}
              >
                {mp}
              </button>
            ))}
          </div>
        </div>

        {/* Bar 2: toolbar */}
        <div className="flex items-center gap-1 px-4 pb-2 flex-wrap">
          <button
            onClick={undo}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Undo"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={redo}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Redo"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1" />

          <Button
            size="sm"
            variant="secondary"
            onClick={saveDraft}
            disabled={saving || dirtyCount === 0}
            className="h-7 text-xs gap-1"
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            Save Draft {dirtyCount > 0 ? `(${dirtyCount})` : ''}
          </Button>

          <Button
            size="sm"
            onClick={pushToEbay}
            disabled={pushing}
            className="h-7 text-xs gap-1 bg-blue-600 hover:bg-blue-700 text-white"
          >
            {pushing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            Push to eBay {rows.length > 50 ? '(Feed)' : '(API)'}
          </Button>

          <Button
            size="sm"
            variant="secondary"
            onClick={importFromAmazon}
            disabled={loading}
            className="h-7 text-xs gap-1"
          >
            <ArrowDownToLine className="h-3 w-3" />
            Import from Amazon
          </Button>

          <Button
            size="sm"
            variant="secondary"
            onClick={() => loadRows(marketplace)}
            disabled={loading}
            className="h-7 text-xs gap-1"
          >
            {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </Button>

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1" />

          <button
            onClick={() => setShowFilter((v) => !v)}
            className={cn(
              'flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors',
              showFilter ? 'bg-blue-100 text-blue-700' : 'hover:bg-slate-100 dark:hover:bg-slate-800',
            )}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filter
          </button>

          <button
            onClick={() => setShowFindReplace((v) => !v)}
            className={cn(
              'flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors',
              showFindReplace ? 'bg-blue-100 text-blue-700' : 'hover:bg-slate-100 dark:hover:bg-slate-800',
            )}
          >
            <Replace className="h-3.5 w-3.5" />
            Find/Replace
          </button>

          <button
            onClick={() => setShowValidation((v) => !v)}
            className={cn(
              'flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors',
              errorCount > 0 ? 'text-red-600' : warnCount > 0 ? 'text-amber-600' : '',
              showValidation ? 'bg-blue-100 text-blue-700' : 'hover:bg-slate-100 dark:hover:bg-slate-800',
            )}
          >
            <AlertCircle className="h-3.5 w-3.5" />
            Validate {errorCount > 0 && `(${errorCount}E)`}{warnCount > 0 && ` (${warnCount}W)`}
          </button>

          {/* Search */}
          <div className="ml-auto flex items-center gap-1 border border-slate-200 dark:border-slate-700 rounded px-2 py-1">
            <Search className="h-3 w-3 text-slate-400" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter rows…"
              className="w-40 text-xs bg-transparent outline-none dark:text-slate-200 placeholder:text-slate-400"
            />
          </div>
        </div>
      </header>

      {/* Feed status banner */}
      {feedStatus && (
        <FeedStatusBanner feedStatus={feedStatus} onPoll={pollFeedStatus} />
      )}

      {/* Filter panel */}
      {showFilter && (
        <FFFilterPanel
          open={showFilter}
          onOpenChange={setShowFilter}
          value={filterState}
          onChange={setFilterState}
        />
      )}

      {/* Find/Replace */}
      {showFindReplace && (
        <FindReplaceBar
          open={showFindReplace}
          onClose={() => setShowFindReplace(false)}
          cells={findCells}
          rangeBounds={null}
          visibleColumns={allColumns.map((c) => ({ id: c.id, label: c.label }))}
          onActivate={() => { /* no-op: no virtualizer scroll needed */ }}
          onMatchSetChange={() => { /* no-op */ }}
          onReplaceCell={(rowId: string, columnId: string, newValue: unknown) =>
            updateCell(rowId, columnId, newValue)
          }
        />
      )}

      {/* Conditional format */}
      {showConditional && (
        <ConditionalFormatBar
          open={showConditional}
          onClose={() => setShowConditional(false)}
          rules={cfRules}
          onChange={setCfRules}
          visibleColumns={allColumns.map((c) => ({ id: c.id, label: c.label }))}
        />
      )}

      {/* Validation panel */}
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

      {/* Description modal */}
      {descModal && (() => {
        const row = rows.find((r) => r._rowId === descModal.rowId)
        return row ? (
          <DescriptionModal
            value={String(row.description ?? '')}
            onSave={(v) => updateCell(descModal.rowId, 'description', v)}
            onClose={() => setDescModal(null)}
          />
        ) : null
      })()}

      {/* Main grid */}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
          </div>
        )}

        {!loading && (
          <table className="border-collapse text-xs min-w-max">
            {/* Sticky header */}
            <thead className="sticky top-0 z-20">
              {/* Group header row */}
              <tr>
                {/* Row checkbox col */}
                <th className="w-8 h-7 border-r border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 sticky left-0 z-30" />
                {/* Status col */}
                <th className="w-6 h-7 border-r border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800" />
                {visibleGroups.map((group) => (
                  <th
                    key={group.id}
                    colSpan={group.columns.length}
                    className={cn(
                      'h-7 px-2 text-left text-[10px] font-semibold uppercase tracking-wide border-r border-b border-slate-200 dark:border-slate-700',
                      gColor(group.color).header,
                    )}
                  >
                    <button
                      onClick={() =>
                        setCollapsedColumnGroups((prev) => {
                          const next = new Set(prev)
                          if (next.has(group.id)) next.delete(group.id)
                          else next.add(group.id)
                          return next
                        })
                      }
                      className="flex items-center gap-1"
                    >
                      <ChevronDown
                        className={cn('h-3 w-3 transition-transform', collapsedColumnGroups.has(group.id) && '-rotate-90')}
                      />
                      {group.label}
                    </button>
                  </th>
                ))}
              </tr>

              {/* Column header row */}
              <tr>
                <th className="w-8 h-7 border-r border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 sticky left-0 z-30">
                  <input
                    type="checkbox"
                    className="h-3 w-3"
                    checked={selectedRows.size === rows.length && rows.length > 0}
                    onChange={(e) =>
                      setSelectedRows(e.target.checked ? new Set(rows.map((r) => r._rowId)) : new Set())
                    }
                  />
                </th>
                <th className="w-6 h-7 border-r border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800" />
                {visibleColumns.map((col) => (
                  <th
                    key={col.id}
                    className={cn(
                      'h-7 px-1.5 text-left font-medium text-slate-600 dark:text-slate-400 border-r border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 whitespace-nowrap overflow-hidden text-ellipsis',
                      col.required && 'after:content-["*"] after:text-red-400 after:ml-0.5',
                    )}
                    style={{ minWidth: col.width, maxWidth: col.width }}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>

            <tbody>
              {/* Render row groups */}
              {(() => {
                const rendered: React.ReactNode[] = []
                let bandIdx = 0

                rowGroups.forEach((groupRows, groupKey) => {
                  const bandClass = GROUP_BAND_COLORS[bandIdx % GROUP_BAND_COLORS.length]
                  bandIdx++
                  const isCollapsed = collapsedRowGroups.has(groupKey)
                  const headerRow = groupRows[0]

                  // Only show group header band if there are multiple rows in the group
                  if (groupRows.length > 1) {
                    rendered.push(
                      <GroupHeader
                        key={`header-${groupKey}`}
                        row={headerRow}
                        allColumns={allColumns}
                        bandClass={bandClass}
                        isExpanded={!isCollapsed}
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

                  // Filter rows by search
                  const visibleGroupRows = groupRows.filter((r) =>
                    filteredRows.some((fr) => fr._rowId === r._rowId),
                  )

                  visibleGroupRows.forEach((row) => {
                    const isRowSelected = selectedRows.has(row._rowId)

                    // Compute CF classes per cell
                    const cfClassMap: Record<string, string> = {}
                    if (cfRules.length > 0) {
                      visibleColumns.forEach((col) => {
                        const val = String(row[col.id] ?? '')
                        for (const rule of cfRules) {
                          if (evaluateRule(rule, val)) {
                            cfClassMap[col.id] = TONE_CLASSES[rule.tone]
                            break
                          }
                        }
                      })
                    }

                    rendered.push(
                      <tr
                        key={row._rowId}
                        className={cn(
                          'border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors',
                          isRowSelected && 'bg-blue-50/40 dark:bg-blue-900/10',
                          groupRows.length > 1 && bandClass,
                        )}
                      >
                        {/* Checkbox */}
                        <td className="w-8 border-r border-slate-200 dark:border-slate-700 px-1.5 sticky left-0 bg-white dark:bg-slate-900 z-10">
                          <input
                            type="checkbox"
                            className="h-3 w-3"
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
                        </td>

                        {/* Push status icon */}
                        <td className="w-6 border-r border-slate-200 dark:border-slate-700 px-1 text-center">
                          {rowStatusIcon(row._status)}
                        </td>

                        {/* Data cells */}
                        {visibleColumns.map((col) => (
                          <SpreadsheetCell
                            key={col.id}
                            col={col}
                            value={row[col.id]}
                            isActive={activeCell?.rowId === row._rowId && activeCell?.colId === col.id}
                            isSelected={isRowSelected}
                            cfClass={cfClassMap[col.id]}
                            rowBandClass={groupRows.length > 1 ? bandClass : undefined}
                            onChange={(v) => updateCell(row._rowId, col.id, v)}
                            onActivate={() => setActiveCell({ rowId: row._rowId, colId: col.id })}
                            onOpenDescription={() => setDescModal({ rowId: row._rowId })}
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
                  <td colSpan={visibleColumns.length + 2} className="py-16 text-center text-slate-400 text-sm">
                    No eBay listings found for this marketplace.
                    <br />
                    <span className="text-xs mt-1 block">
                      Create listings in the <a href="/products" className="text-blue-600 underline">Products</a> catalog first.
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Status bar */}
      <div className="shrink-0 border-t border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-4 py-1 flex items-center gap-4 text-xs text-slate-500">
        <span>{rows.length} listings</span>
        {selectedRows.size > 0 && <span>{selectedRows.size} selected</span>}
        {dirtyCount > 0 && <span className="text-amber-600">{dirtyCount} unsaved</span>}
        {errorCount > 0 && <span className="text-red-600">{errorCount} errors</span>}
        <span className="ml-auto">eBay · {marketplace}</span>
      </div>
    </div>
  )
}

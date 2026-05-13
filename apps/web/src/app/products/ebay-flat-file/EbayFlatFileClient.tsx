'use client'

import {
  useCallback, useEffect, useRef, useState, useMemo,
} from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  ClipboardPaste, Copy, ExternalLink, Image as ImageIcon, Loader2, RefreshCw,
  Send, Undo2, Redo2, Search, ArrowDownToLine, ArrowRightLeft, Replace,
  SlidersHorizontal, Sparkles, X,
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
import { FFSavedViews, type FFViewState } from '../amazon-flat-file/FFSavedViews'
import { AIBulkModal } from '../amazon-flat-file/AIBulkModal'
import { FFReplicateModal } from '../amazon-flat-file/FFReplicateModal'
import { ChannelStrip } from './ChannelStrip'
import {
  EBAY_FIXED_GROUPS,
  MARKET_COLUMN_GROUPS,
  getAllEbayColumns,
  buildCategoryColumns,
  type CategoryAspect,
  type EbayColumn,
  type EbayColumnGroup,
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
  fulfillment_policy_id?: string
  payment_policy_id?: string
  return_policy_id?: string
  listing_status?: string
  last_pushed_at?: string
  sync_status?: string
  platformProductId?: string
  // per-market flat fields
  it_price?: number | null
  it_qty?: number | null
  it_item_id?: string | null
  it_status?: string | null
  it_listing_id?: string | null
  de_price?: number | null
  de_qty?: number | null
  de_item_id?: string | null
  de_status?: string | null
  de_listing_id?: string | null
  fr_price?: number | null
  fr_qty?: number | null
  fr_item_id?: string | null
  fr_status?: string | null
  fr_listing_id?: string | null
  es_price?: number | null
  es_qty?: number | null
  es_item_id?: string | null
  es_status?: string | null
  es_listing_id?: string | null
  uk_price?: number | null
  uk_qty?: number | null
  uk_item_id?: string | null
  uk_status?: string | null
  uk_listing_id?: string | null
  [key: string]: unknown
}

interface PushResult {
  sku: string
  market: string
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

interface CategoryResult {
  id: string
  name: string
  path: string
  matchScore: number
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
  violet:  { header: 'bg-violet-100 dark:bg-violet-900/50 text-violet-800 dark:text-violet-200', cell: 'bg-violet-50/40 dark:bg-violet-950/10' },
}

function gColor(color: string) {
  return GROUP_COLORS[color] ?? GROUP_COLORS.slate
}

// Market code → eBay listing URL base
const MARKET_URLS: Record<string, string> = {
  IT: 'https://www.ebay.it/itm/',
  DE: 'https://www.ebay.de/itm/',
  FR: 'https://www.ebay.fr/itm/',
  ES: 'https://www.ebay.es/itm/',
  UK: 'https://www.ebay.co.uk/itm/',
}

function statusBadgeCls(status?: string | null) {
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

// ── Category Search Panel ─────────────────────────────────────────────

interface CategorySearchPanelProps {
  marketplace: string
  onSelect: (id: string, name: string) => void
  onClose: () => void
}

function CategorySearchPanel({ marketplace, onSelect, onClose }: CategorySearchPanelProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CategoryResult[]>([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.trim().length < 2) { setResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setLoading(true)
      try {
        const mpId = marketplace.startsWith('EBAY_') ? marketplace : `EBAY_${marketplace}`
        const res = await fetch(
          `${getBackendUrl()}/api/ebay/flat-file/category-search?q=${encodeURIComponent(query)}&marketplace=${mpId}`,
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json() as { categories: CategoryResult[] }
        setResults(json.categories)
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    }, 300)
  }, [query, marketplace])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-32"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-[500px] max-w-full border border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-2 p-3 border-b border-slate-200 dark:border-slate-700">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
            placeholder="Search eBay categories…"
            className="flex-1 text-sm bg-transparent outline-none text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
          />
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 shrink-0" />}
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>
        {results.length > 0 && (
          <ul className="max-h-72 overflow-y-auto py-1">
            {results.map((cat) => (
              <li key={cat.id}>
                <button
                  type="button"
                  onClick={() => { onSelect(cat.id, cat.name); onClose() }}
                  className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
                >
                  <div className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">
                    {cat.path}
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono">ID: {cat.id}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim().length >= 2 && !loading && results.length === 0 && (
          <div className="px-4 py-3 text-xs text-slate-400">No categories found. Try a different term.</div>
        )}
        {query.trim().length < 2 && (
          <div className="px-4 py-3 text-xs text-slate-400">Type at least 2 characters to search…</div>
        )}
      </div>
    </div>
  )
}

// ── Multi-market Publish Panel ────────────────────────────────────────

interface PublishPanelProps {
  selectedCount: number
  publishTargets: string[]
  onChangeTargets: (targets: string[]) => void
  onPublish: () => void
  pushing: boolean
  onClose: () => void
}

const ALL_MARKETS = [
  { code: 'IT', label: 'Italy (eBay.it)' },
  { code: 'DE', label: 'Germany (eBay.de)' },
  { code: 'FR', label: 'France (eBay.fr)' },
  { code: 'ES', label: 'Spain (eBay.es)' },
  { code: 'UK', label: 'UK (eBay.co.uk)' },
]

function PublishPanel({ selectedCount, publishTargets, onChangeTargets, onPublish, pushing, onClose }: PublishPanelProps) {
  function toggle(code: string) {
    onChangeTargets(
      publishTargets.includes(code)
        ? publishTargets.filter((m) => m !== code)
        : [...publishTargets, code],
    )
  }

  return (
    <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Push to markets</span>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="space-y-1.5">
        {ALL_MARKETS.map((m) => (
          <label key={m.code} className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 accent-blue-600"
              checked={publishTargets.includes(m.code)}
              onChange={() => toggle(m.code)}
            />
            <span className="text-xs text-slate-700 dark:text-slate-300">{m.label}</span>
          </label>
        ))}
      </div>
      <p className="text-[10px] text-slate-400">
        {selectedCount > 0 ? `${selectedCount} selected rows` : 'All rows'} will be pushed to checked markets.
      </p>
      <Button
        size="sm"
        className="w-full"
        disabled={publishTargets.length === 0 || pushing}
        loading={pushing}
        onClick={onPublish}
      >
        <Send className="w-3.5 h-3.5 mr-1.5" />
        Push to {publishTargets.length > 0 ? publishTargets.join(', ') : 'markets'}
      </Button>
    </div>
  )
}

// ── SpreadsheetCell ────────────────────────────────────────────────────

interface CellProps {
  col: EbayColumn
  value: unknown
  row: EbayRow
  isActive: boolean
  isSelected: boolean
  cfClass?: string
  rowBandClass?: string
  onChange: (v: unknown) => void
  onActivate: () => void
  onOpenDescription: () => void
  onOpenCategorySearch: () => void
}

function SpreadsheetCell({
  col, value, isActive, isSelected, cfClass, rowBandClass,
  onChange, onActivate, onOpenDescription, onOpenCategorySearch,
}: CellProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null)

  const displayVal = value == null || value === '' ? '' : String(value)
  const isReadOnly = col.readOnly || col.kind === 'readonly'

  const startEdit = useCallback(() => {
    if (isReadOnly) return
    if (col.kind === 'longtext') { onOpenDescription(); return }
    if (col.id === 'category_id') { onOpenCategorySearch(); return }
    setDraft(displayVal)
    setEditing(true)
  }, [isReadOnly, col.kind, col.id, displayVal, onOpenDescription, onOpenCategorySearch])

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

  // ── Market-specific cell rendering ─────────────────────────────────

  // Status columns for markets (it_status, de_status, etc.)
  if (col.id.endsWith('_status') && col.readOnly) {
    return (
      <td className={cellBase} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate}>
        {displayVal ? (
          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', statusBadgeCls(displayVal))}>
            {displayVal}
          </span>
        ) : (
          <span className="text-slate-300 text-[10px]">—</span>
        )}
      </td>
    )
  }

  // Item ID columns for markets (it_item_id, de_item_id, etc.) — external link
  if (col.id.endsWith('_item_id') && col.readOnly) {
    const marketCode = col.id.slice(0, 2).toUpperCase()
    const baseUrl = MARKET_URLS[marketCode] ?? ''
    return (
      <td className={cellBase} style={{ minWidth: col.width, maxWidth: col.width }} onClick={onActivate}>
        {displayVal ? (
          <a
            href={`${baseUrl}${displayVal}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline font-mono text-[10px]"
            onClick={(e) => e.stopPropagation()}
          >
            {displayVal}
            <ExternalLink className="w-2.5 h-2.5 shrink-0" />
          </a>
        ) : (
          <span className="text-slate-300 text-[10px]">—</span>
        )}
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

  // Category ID: show with search trigger hint
  if (col.id === 'category_id') {
    return (
      <td
        className={cellBase}
        style={{ minWidth: col.width, maxWidth: col.width }}
        onClick={onActivate}
        onDoubleClick={onOpenCategorySearch}
      >
        {displayVal ? (
          <span className="font-mono text-[10px] text-blue-700 dark:text-blue-300">{displayVal}</span>
        ) : (
          <span className="text-slate-300 text-[10px]">Double-click to search…</span>
        )}
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
  bandClass: string
  isExpanded: boolean
  onToggle: () => void
  showImage: boolean
  imageSize: number
}

function GroupHeader({ row, bandClass, isExpanded, onToggle, showImage, imageSize }: GroupHeaderProps) {
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
          {showImage && row.image_1 && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.image_1}
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
  }
  return issues
}

// ── Column group pill badge colours ───────────────────────────────────

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

// ── TbBtn ─────────────────────────────────────────────────────────────

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

// ── MenuDropdown ─────────────────────────────────────────────────────

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

  const [marketplace] = useState(initialMarketplace)
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

  // Column group pills
  const [closedGroups, setClosedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('eff-closed-groups') ?? '[]')) } catch { return new Set() }
  })
  const [groupOrder, setGroupOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('eff-group-order') ?? '[]') } catch { return [] }
  })
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null)

  // Sort
  const [sortPanelOpen, setSortPanelOpen] = useState(false)
  const [sortConfig, setSortConfig] = useState<Array<{ id: string; colId: string; mode: 'asc' | 'desc' }>>([])
  void setSortConfig

  // Save flash
  const [saveFlash, setSaveFlash] = useState(false)

  // AI modal
  const [aiModalOpen, setAiModalOpen] = useState(false)

  // Replicate modal
  const [replicateOpen, setReplicateOpen] = useState(false)

  // Smart paste
  const [smartPasteEnabled, setSmartPasteEnabled] = useState(() => {
    try { return localStorage.getItem('eff-smart-paste') === '1' } catch { return false }
  })

  useEffect(() => {
    try { localStorage.setItem('eff-smart-paste', smartPasteEnabled ? '1' : '0') } catch {}
  }, [smartPasteEnabled])

  // Row images
  const [showRowImages, setShowRowImages] = useState(false)
  const [imageSize, setImageSize] = useState<24 | 32 | 48 | 64 | 96>(48)

  // Fetch from eBay panel
  const [fetchPanelOpen, setFetchPanelOpen] = useState(false)
  const [fetching, setFetching] = useState(false)

  // Collapsed row groups
  const [collapsedRowGroups, setCollapsedRowGroups] = useState<Set<string>>(new Set())

  // Description editor
  const [descModal, setDescModal] = useState<{ rowId: string } | null>(null)

  // Push results
  const [feedStatus, setFeedStatus] = useState<FeedStatus | null>(null)

  // Publish panel
  const [publishPanelOpen, setPublishPanelOpen] = useState(false)
  const [publishTargets, setPublishTargets] = useState<string[]>(['IT'])

  // Category search panel
  const [categorySearchOpen, setCategorySearchOpen] = useState(false)
  const [categorySearchRowId, setCategorySearchRowId] = useState<string | null>(null)

  // Dynamic category columns — keyed by categoryId
  const [categoryColumnsCache, setCategoryColumnsCache] = useState<Map<string, EbayColumnGroup>>(new Map())
  const [categoryColumns, setCategoryColumns] = useState<EbayColumnGroup | null>(null)

  // Undo/redo
  const historyRef = useRef<EbayRow[][]>([initialRows])
  const historyIdx = useRef(0)

  // ── Category schema loading ───────────────────────────────────────────

  const loadCategorySchema = useCallback(async (categoryId: string) => {
    if (!categoryId) { setCategoryColumns(null); return }
    if (categoryColumnsCache.has(categoryId)) {
      setCategoryColumns(categoryColumnsCache.get(categoryId)!)
      return
    }
    try {
      const mpId = marketplace.startsWith('EBAY_') ? marketplace : `EBAY_${marketplace}`
      const res = await fetch(
        `${getBackendUrl()}/api/ebay/flat-file/category-schema?categoryId=${encodeURIComponent(categoryId)}&marketplace=${mpId}`,
      )
      if (!res.ok) return
      const json = await res.json() as { aspects: CategoryAspect[] }
      const group = buildCategoryColumns(json.aspects)
      setCategoryColumnsCache((prev) => new Map(prev).set(categoryId, group))
      setCategoryColumns(group)
    } catch {
      // Silently fail — category schema is optional
    }
  }, [marketplace, categoryColumnsCache])

  // Load schema when rows change and they share a consistent category_id
  useEffect(() => {
    const cats = [...new Set(rows.map((r) => r.category_id).filter(Boolean))]
    if (cats.length === 1 && cats[0]) {
      void loadCategorySchema(cats[0])
    }
  }, [rows, loadCategorySchema])

  // ── Derived ───────────────────────────────────────────────────────────

  const allColumnGroups = useMemo<EbayColumnGroup[]>(() => {
    const fixed = EBAY_FIXED_GROUPS
    const itemSpecifics = categoryColumns ? [categoryColumns] : []
    const markets = MARKET_COLUMN_GROUPS
    return [...fixed, ...itemSpecifics, ...markets]
  }, [categoryColumns])

  const allColumns = useMemo(() => getAllEbayColumns(), [])

  const orderedGroups = useMemo<EbayColumnGroup[]>(() => {
    if (!groupOrder.length) return allColumnGroups
    const map = new Map(allColumnGroups.map((g) => [g.id, g]))
    const ordered = groupOrder.map((id) => map.get(id)).filter(Boolean) as EbayColumnGroup[]
    const rest = allColumnGroups.filter((g) => !groupOrder.includes(g.id))
    return [...ordered, ...rest]
  }, [groupOrder, allColumnGroups])

  const openGroups = useMemo(
    () => new Set(allColumnGroups.map((g) => g.id).filter((id) => !closedGroups.has(id))),
    [closedGroups, allColumnGroups],
  )

  const visibleGroups = useMemo(
    () => orderedGroups.filter((g) => openGroups.has(g.id)),
    [orderedGroups, openGroups],
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

  // Filtered rows
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

    // If category_id changed, load new schema
    if (colId === 'category_id' && typeof value === 'string' && value) {
      void loadCategorySchema(value)
    }
  }

  // ── API calls ─────────────────────────────────────────────────────────

  async function loadRows() {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
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
      setSaveFlash(true)
      setTimeout(() => setSaveFlash(false), 2000)
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
      : rows.filter((r) => r._dirty)

    if (!toPush.length) {
      toast({ title: 'Nothing to push', description: 'Select rows or make edits first.', tone: 'info' })
      return
    }

    const targets = publishTargets.length > 0 ? publishTargets : ['IT']
    const mode = toPush.length > 50 ? 'feed' : 'api'
    setPushing(true)
    setPublishPanelOpen(false)

    setRows((prev) =>
      prev.map((r) =>
        toPush.find((p) => p._rowId === r._rowId) ? { ...r, _status: 'pending' } : r,
      ),
    )

    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/flat-file/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: toPush, markets: targets, mode }),
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
        setRows((prev) =>
          prev.map((r) =>
            toPush.find((p) => p._rowId === r._rowId) ? { ...r, _status: 'pushed', _dirty: false } : r,
          ),
        )
      } else {
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
          title: 'Push complete',
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
        `${getBackendUrl()}/api/ebay/flat-file/feed/${feedStatus.taskId}`,
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as FeedStatus
      setFeedStatus(json)
    } catch (err) {
      toast.error('Feed poll failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  async function handleFetchFromEbay() {
    const toFetch = [...selectedRows]
      .map((id) => rows.find((r) => r._rowId === id))
      .filter(Boolean) as EbayRow[]
    if (!toFetch.length) return
    setFetching(true)
    setFetchPanelOpen(false)
    const updates: Array<{ rowId: string; data: Partial<EbayRow> }> = []
    await Promise.all(toFetch.map(async (row) => {
      if (!row.sku) return
      try {
        const res = await fetch(`${getBackendUrl()}/api/ebay/pull-listing?sku=${encodeURIComponent(row.sku)}&marketplace=${marketplace}`)
        if (!res.ok) return
        const json = await res.json() as { found: boolean; summary?: { title?: string; quantity?: number; condition?: string; imageUrls?: string[]; aspects?: Record<string, string[]> } }
        if (!json.found || !json.summary) return
        const s = json.summary
        const patch: Partial<EbayRow> = {}
        if (s.title)    patch.title    = s.title
        if (s.quantity) patch.quantity = s.quantity
        if (s.condition) patch.condition = s.condition
        if (s.imageUrls?.[0]) patch.image_1 = s.imageUrls[0]
        if (s.imageUrls?.[1]) patch.image_2 = s.imageUrls[1]
        if (s.aspects?.Brand?.[0])  patch['aspect_Brand']  = s.aspects.Brand[0]
        if (s.aspects?.Colour?.[0]) patch['aspect_Colour'] = s.aspects.Colour[0]
        if (s.aspects?.Color?.[0])  patch['aspect_Color']  = s.aspects.Color[0]
        if (s.aspects?.Size?.[0])   patch['aspect_Size']   = s.aspects.Size[0]
        updates.push({ rowId: row._rowId, data: patch })
      } catch { /* skip */ }
    }))
    if (updates.length) {
      const nextRows = rows.map((r) => {
        const u = updates.find((x) => x.rowId === r._rowId)
        return u ? { ...r, ...u.data, _dirty: true } : r
      })
      pushHistory(nextRows)
      setRows(nextRows)
      toast.success(`Fetched live data for ${updates.length} SKU${updates.length !== 1 ? 's' : ''}`)
    }
    setFetching(false)
  }

  function handleDiscard() {
    if (!dirtyCount) return
    if (!confirm('Discard all unsaved changes?')) return
    void loadRows()
  }

  // ── Find/Replace ──────────────────────────────────────────────────────

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
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">

      {/* ── Sticky header ────────────────────────────────────────── */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 sticky top-0 z-30">

        {/* ── Channel strip ─── */}
        <ChannelStrip channel="ebay" marketplace={marketplace} familyId={familyId} />

        {/* ── Bar 1: App chrome + menus + primary actions ───── */}
        <div className="px-3 h-10 flex items-center gap-2 border-b border-slate-100 dark:border-slate-800/60">

          {/* Back */}
          <button
            type="button"
            onClick={() => router.push('/products')}
            className="p-1 -ml-0.5 flex-shrink-0 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            aria-label="Back to products"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>

          {/* File / Edit menus */}
          <MenuDropdown label="File" items={[
            { label: 'Reload from server', icon: <RefreshCw className="w-3.5 h-3.5" />, disabled: loading,
              onClick: () => { if (confirm('Reload rows? Unsaved edits will be lost.')) void loadRows() } },
            { separator: true },
            { label: 'Push history…', icon: <Send className="w-3.5 h-3.5" />, disabled: !feedStatus, onClick: () => {} },
          ]} />
          <MenuDropdown label="Edit" items={[
            { label: 'Undo', icon: <Undo2 className="w-3.5 h-3.5" />, onClick: undo, disabled: historyIdx.current <= 0, shortcut: '⌘Z' },
            { label: 'Redo', icon: <Redo2 className="w-3.5 h-3.5" />, onClick: redo, disabled: historyIdx.current >= historyRef.current.length - 1, shortcut: '⌘⇧Z' },
            { separator: true },
            { label: 'Import from Amazon', icon: <ArrowDownToLine className="w-3.5 h-3.5" />, onClick: importFromAmazon, disabled: loading },
            { separator: true },
            { label: 'Reset column group order', onClick: () => { setGroupOrder([]); try { localStorage.removeItem('eff-group-order') } catch {} }, disabled: !groupOrder.length },
            { label: 'Show all column groups', onClick: () => { setClosedGroups(new Set()); try { localStorage.removeItem('eff-closed-groups') } catch {} }, disabled: !closedGroups.size },
          ]} />

          {/* Separator */}
          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5 flex-shrink-0" />

          {/* Title + row count */}
          <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current text-blue-600 dark:text-blue-400 flex-shrink-0" aria-hidden="true">
            <path d="M.43 8.65H3.6V16H.43V8.65zm5.9 0h1.16L9.3 14.33l1.82-5.68h1.19L9.9 16H8.75L6.33 8.65zM13.36 8.65h3.17c2.13 0 3.06 1.24 3.06 3.68 0 2.44-.93 3.67-3.06 3.67h-3.17V8.65zm1.17 6.35h1.87c1.38 0 1.95-.83 1.95-2.67 0-1.84-.57-2.68-1.95-2.68h-1.87v5.35zm5.56-6.35h1.14V16h-1.14V8.65zM2 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm19 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z" />
          </svg>
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-100 whitespace-nowrap">eBay Flat File</span>
          <Badge variant="default">{rows.length} rows</Badge>
          {dirtyCount > 0 && <Badge variant="warning" className="flex-shrink-0"><AlertCircle className="w-3 h-3 mr-1" />{dirtyCount} unsaved</Badge>}

          {/* Spacer */}
          <div className="flex-1 min-w-0" />

          {/* Feed status badge */}
          {feedStatus && (
            <span className={cn(
              'text-xs font-medium px-2 py-0.5 rounded-full border flex-shrink-0',
              ['COMPLETED', 'COMPLETED_WITH_ERROR'].includes(feedStatus.status)
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800'
                : feedStatus.status === 'FAILED'
                ? 'bg-red-50 text-red-700 border-red-200'
                : 'bg-amber-50 text-amber-700 border-amber-200',
            )}>
              Feed: {feedStatus.status}
            </span>
          )}

          {/* Separator */}
          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-0.5 flex-shrink-0" />

          {/* Discard */}
          <Button size="sm" variant="ghost"
            onClick={handleDiscard}
            disabled={!dirtyCount || loading}
            className="text-slate-500 hover:text-red-600 dark:hover:text-red-400">
            Discard
          </Button>

          {/* Save */}
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

          {/* Push to eBay — with multi-market panel */}
          <div className="relative">
            <Button size="sm" onClick={() => setPublishPanelOpen((o) => !o)} disabled={pushing} loading={pushing}>
              <Send className="w-3.5 h-3.5 mr-1.5" />
              Push to eBay{dirtyCount > 0 ? ` (${dirtyCount})` : ''}
            </Button>
            {publishPanelOpen && (
              <PublishPanel
                selectedCount={selectedRows.size}
                publishTargets={publishTargets}
                onChangeTargets={setPublishTargets}
                onPublish={pushToEbay}
                pushing={pushing}
                onClose={() => setPublishPanelOpen(false)}
              />
            )}
          </div>
        </div>

        {/* ── Icon toolbar ── */}
        <div className="px-3 h-8 flex items-center gap-0.5 border-b border-slate-100 dark:border-slate-800/60">

          {/* Undo / Redo */}
          <TbBtn icon={<Undo2 className="w-3.5 h-3.5" />} title="Undo (⌘Z)" onClick={undo} disabled={historyIdx.current <= 0} />
          <TbBtn icon={<Redo2 className="w-3.5 h-3.5" />} title="Redo (⌘⇧Z)" onClick={redo} disabled={historyIdx.current >= historyRef.current.length - 1} />

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />

          {/* Copy rows to another eBay market */}
          <TbBtn
            icon={<Copy className="w-3.5 h-3.5" />}
            title="Copy rows to another market"
            onClick={() => setReplicateOpen(true)}
            disabled={!rows.length}
          />

          {/* Replicate to multiple markets */}
          <TbBtn
            icon={<ArrowRightLeft className="w-3.5 h-3.5" />}
            title="Replicate to multiple markets"
            onClick={() => setReplicateOpen(true)}
            disabled={!rows.length}
            active={replicateOpen}
          />

          {/* Fetch from eBay */}
          <div className="relative">
            <TbBtn
              icon={fetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowDownToLine className="w-3.5 h-3.5" />}
              title={selectedRows.size > 0
                ? `Fetch from eBay (${selectedRows.size} SKU${selectedRows.size !== 1 ? 's' : ''})`
                : 'Fetch from eBay — select rows first'}
              onClick={() => setFetchPanelOpen((o) => !o)}
              disabled={selectedRows.size === 0 || fetching}
              active={fetchPanelOpen}
              badge={selectedRows.size || undefined}
            />
            {fetchPanelOpen && (
              <div className="absolute left-0 top-full mt-1 z-50 w-56 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl p-3 space-y-2">
                <p className="text-xs text-slate-600 dark:text-slate-400">
                  Fetch live listing data from eBay for {selectedRows.size} selected SKU{selectedRows.size !== 1 ? 's' : ''}.
                  Overwrites title, condition, images, and aspects.
                </p>
                <div className="flex gap-2">
                  <button type="button" onClick={handleFetchFromEbay}
                    className="flex-1 h-7 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700">
                    Fetch now
                  </button>
                  <button type="button" onClick={() => setFetchPanelOpen(false)}
                    className="h-7 px-2 text-xs border border-slate-200 dark:border-slate-700 rounded text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />

          {/* Validation */}
          <TbBtn
            icon={<AlertTriangle className="w-3.5 h-3.5" />}
            title={errorCount + warnCount > 0
              ? `Validation: ${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warnCount} warning${warnCount !== 1 ? 's' : ''}`
              : 'Validation — no issues'}
            onClick={() => setShowValidation((o) => !o)}
            active={showValidation}
            badge={(errorCount + warnCount) || undefined}
          />

          {/* Smart paste toggle */}
          <TbBtn
            icon={<ClipboardPaste className="w-3.5 h-3.5" />}
            title={smartPasteEnabled
              ? 'Smart paste ON — first row treated as column headers when ≥2 columns match. Click to turn off.'
              : 'Smart paste OFF — positional paste (default). Click to turn on header-mapping mode.'}
            onClick={() => setSmartPasteEnabled((o) => !o)}
            active={smartPasteEnabled}
          />

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />

          {/* Import from Amazon */}
          <TbBtn
            icon={<ArrowRightLeft className="w-3.5 h-3.5" />}
            title="Import from Amazon — pre-fill eBay fields from matching Amazon listings"
            onClick={importFromAmazon}
            disabled={loading}
          />

          {/* Row images toggle */}
          <TbBtn
            icon={<ImageIcon className="w-3.5 h-3.5" />}
            title={showRowImages ? 'Hide product images' : 'Show product images in rows (uses image_1 field)'}
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

          {/* Sort */}
          <TbBtn
            icon={<SlidersHorizontal className="w-3.5 h-3.5" />}
            title={sortConfig.length > 0 ? `Sort — ${sortConfig.length} level${sortConfig.length !== 1 ? 's' : ''} active` : 'Sort rows'}
            onClick={() => setSortPanelOpen((o) => !o)}
            active={sortPanelOpen || sortConfig.length > 0}
            badge={sortConfig.length || undefined}
          />

          <div className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-1 flex-shrink-0" />

          {/* Find & Replace */}
          <TbBtn
            icon={<Replace className="w-3.5 h-3.5" />}
            title="Find & Replace (⌘F)"
            onClick={() => setShowFindReplace((o) => !o)}
            active={showFindReplace}
          />

          {/* Conditional formatting */}
          <TbBtn
            icon={<Sparkles className="w-3.5 h-3.5" />}
            title={cfRules.length > 0 ? `Conditional formatting (${cfRules.filter((r) => r.enabled).length} active)` : 'Conditional formatting'}
            onClick={() => setShowConditional((o) => !o)}
            active={showConditional}
            badge={cfRules.filter((r) => r.enabled).length || undefined}
          />

          {/* AI bulk actions */}
          <TbBtn
            icon={<Sparkles className="w-3.5 h-3.5 text-amber-500" />}
            title={selectedRows.size > 0 ? `AI bulk actions (${selectedRows.size} selected)` : 'AI bulk actions — select rows first'}
            onClick={() => setAiModalOpen(true)}
            disabled={selectedRows.size === 0}
            badge={selectedRows.size || undefined}
          />
        </div>

        {/* ── Bar 3: All markets label · Search · Filter · Saved Views · Column pills ── */}
        <div className="px-3 py-1.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-3 flex-wrap">

          {/* All markets label */}
          <span className="text-xs text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap">
            All markets
          </span>

          {/* Search — ml-auto pushes right */}
          <div className="flex items-center gap-1 ml-auto">
            <div className="relative flex items-center">
              <Search className="absolute left-2 w-3 h-3 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setSearchQuery('')}
                placeholder="Filter rows…"
                className="pl-6 pr-6 py-0.5 text-xs border border-slate-200 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-blue-500 w-44"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="absolute right-1.5 text-slate-400 hover:text-slate-600">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Row filter */}
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
                sortConfig: sortConfig.map((s) => ({ ...s, mode: s.mode as 'asc' | 'desc' | 'custom', customOrder: [] })),
                cfRules,
                frozenColCount: 1,
              }}
              onApply={(state: FFViewState) => {
                setClosedGroups(new Set(state.closedGroups))
                setFilterState(state.ffFilter)
                setCfRules(state.cfRules)
              }}
            />
          </div>

          {/* Column group pills */}
          <div className="flex items-center gap-1 flex-wrap ml-auto">
            <span className="text-xs text-slate-400 mr-1">Columns:</span>
            {orderedGroups.map((g) => {
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
                    const to   = ids.indexOf(g.id)
                    const next = [...ids]
                    next.splice(from, 1)
                    next.splice(to, 0, draggingGroupId)
                    setGroupOrder(next)
                    try { localStorage.setItem('eff-group-order', JSON.stringify(next)) } catch {}
                    setDraggingGroupId(null)
                  }}
                  onClick={() => setClosedGroups((prev) => {
                    const n = new Set(prev)
                    open ? n.add(g.id) : n.delete(g.id)
                    try { localStorage.setItem('eff-closed-groups', JSON.stringify([...n])) } catch {}
                    return n
                  })}
                  title={g.label}
                  className={cn(
                    'inline-flex items-center gap-1 h-5 px-1.5 text-xs rounded border transition-all cursor-grab active:cursor-grabbing select-none',
                    gBadge(g.color),
                    open ? 'opacity-100' : 'opacity-40 hover:opacity-65',
                    isDragging && 'opacity-30 scale-95',
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
                  try { localStorage.removeItem('eff-group-order'); localStorage.removeItem('eff-closed-groups') } catch {}
                }}
                className="text-xs text-slate-400 hover:text-slate-600 px-1"
                title="Reset column group order and visibility">
                ↺
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Feed status banner */}
      {feedStatus && (
        <FeedStatusBanner feedStatus={feedStatus} onPoll={pollFeedStatus} />
      )}

      {/* Replicate modal */}
      <FFReplicateModal
        open={replicateOpen}
        onClose={() => setReplicateOpen(false)}
        sourceMarket={marketplace}
        groups={visibleGroups.map((g) => ({ id: g.id, labelEn: g.label, color: g.color }))}
        rowCount={rows.length}
        selectedRowCount={selectedRows.size}
        onReplicate={async (targets, groupIds, selectedOnly) => {
          const sourceRows = selectedOnly && selectedRows.size > 0
            ? rows.filter((r) => selectedRows.has(r._rowId))
            : rows
          let copied = 0
          for (const target of targets) {
            const key = `eff-rows-${target.toUpperCase()}`
            const colSet = new Set(
              visibleGroups.filter((g) => groupIds.has(g.id)).flatMap((g) => g.columns.map((c) => c.id)),
            )
            const copiedRows = sourceRows.map((r) => {
              const next: EbayRow = { _rowId: `copy-${r._rowId}-${target}`, _dirty: true, sku: r.sku }
              for (const colId of colSet) { if (r[colId] != null) next[colId] = r[colId] }
              return next
            })
            try { localStorage.setItem(key, JSON.stringify(copiedRows)) } catch {}
            copied += copiedRows.length
          }
          return { copied, skipped: 0 }
        }}
      />

      {/* AI bulk actions modal */}
      <AIBulkModal
        open={aiModalOpen}
        onClose={() => setAiModalOpen(false)}
        selectedProductIds={[...selectedRows].flatMap((rowId) => {
          const row = rows.find((r) => r._rowId === rowId)
          return row?._productId ? [row._productId as string] : []
        })}
        marketplace={marketplace}
      />

      {/* Find/Replace */}
      {showFindReplace && (
        <FindReplaceBar
          open={showFindReplace}
          onClose={() => setShowFindReplace(false)}
          cells={findCells}
          rangeBounds={null}
          visibleColumns={allColumns.map((c) => ({ id: c.id, label: c.label }))}
          onActivate={() => { /* no-op */ }}
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

      {/* Category search modal */}
      {categorySearchOpen && (
        <CategorySearchPanel
          marketplace={marketplace}
          onSelect={(id, _name) => {
            if (categorySearchRowId) {
              updateCell(categorySearchRowId, 'category_id', id)
            } else {
              // Apply to all selected rows or all rows
              const targets = selectedRows.size > 0 ? [...selectedRows] : rows.map((r) => r._rowId)
              const nextRows = rows.map((r) =>
                targets.includes(r._rowId) ? { ...r, category_id: id, _dirty: true } : r,
              )
              pushHistory(nextRows)
              setRows(nextRows)
              void loadCategorySchema(id)
            }
          }}
          onClose={() => { setCategorySearchOpen(false); setCategorySearchRowId(null) }}
        />
      )}

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
                {/* Row image col (when enabled) */}
                {showRowImages && (
                  <th className="border-r border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
                    style={{ minWidth: imageSize + 8, maxWidth: imageSize + 8 }} />
                )}
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
                        setClosedGroups((prev) => {
                          const next = new Set(prev)
                          if (next.has(group.id)) next.delete(group.id)
                          else next.add(group.id)
                          return next
                        })
                      }
                      className="flex items-center gap-1"
                    >
                      <ChevronDown
                        className={cn('h-3 w-3 transition-transform', closedGroups.has(group.id) && '-rotate-90')}
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
                {showRowImages && (
                  <th className="h-7 border-r border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-[10px] text-slate-400 px-1"
                    style={{ minWidth: imageSize + 8, maxWidth: imageSize + 8 }}>
                    Img
                  </th>
                )}
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
              {(() => {
                const rendered: React.ReactNode[] = []
                let bandIdx = 0

                rowGroups.forEach((groupRows, groupKey) => {
                  const bandClass = GROUP_BAND_COLORS[bandIdx % GROUP_BAND_COLORS.length]
                  bandIdx++
                  const isCollapsed = collapsedRowGroups.has(groupKey)
                  const headerRow = groupRows[0]

                  // Show group header band if multiple rows in the group
                  if (groupRows.length > 1) {
                    rendered.push(
                      <GroupHeader
                        key={`header-${groupKey}`}
                        row={headerRow}
                        bandClass={bandClass}
                        isExpanded={!isCollapsed}
                        showImage={showRowImages}
                        imageSize={imageSize}
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

                        {/* Row image */}
                        {showRowImages && (
                          <td
                            className="border-r border-slate-200 dark:border-slate-700 px-0.5 py-0.5 text-center"
                            style={{ minWidth: imageSize + 8, maxWidth: imageSize + 8 }}
                          >
                            {row.image_1 ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={row.image_1}
                                alt=""
                                style={{ width: imageSize, height: imageSize }}
                                className="rounded object-cover border border-slate-200 dark:border-slate-700 inline-block"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                              />
                            ) : (
                              <span className="text-slate-200">—</span>
                            )}
                          </td>
                        )}

                        {/* Data cells */}
                        {visibleColumns.map((col) => (
                          <SpreadsheetCell
                            key={col.id}
                            col={col}
                            value={row[col.id]}
                            row={row}
                            isActive={activeCell?.rowId === row._rowId && activeCell?.colId === col.id}
                            isSelected={isRowSelected}
                            cfClass={cfClassMap[col.id]}
                            rowBandClass={groupRows.length > 1 ? bandClass : undefined}
                            onChange={(v) => updateCell(row._rowId, col.id, v)}
                            onActivate={() => setActiveCell({ rowId: row._rowId, colId: col.id })}
                            onOpenDescription={() => setDescModal({ rowId: row._rowId })}
                            onOpenCategorySearch={() => {
                              setCategorySearchRowId(row._rowId)
                              setCategorySearchOpen(true)
                            }}
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
                  <td colSpan={visibleColumns.length + 2 + (showRowImages ? 1 : 0)} className="py-16 text-center text-slate-400 text-sm">
                    No eBay listings found.
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
        <span>{rows.length} products</span>
        {selectedRows.size > 0 && <span>{selectedRows.size} selected</span>}
        {dirtyCount > 0 && <span className="text-amber-600">{dirtyCount} unsaved</span>}
        {errorCount > 0 && <span className="text-red-600">{errorCount} errors</span>}
        <span className="ml-auto">eBay · All markets</span>
      </div>
    </div>
  )
}

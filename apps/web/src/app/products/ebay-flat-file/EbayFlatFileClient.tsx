'use client'

import { useCallback, useRef, useState, useMemo } from 'react'
import {
  AlertCircle, ArrowDownToLine, ArrowRightLeft, CheckCircle2, ExternalLink, Loader2, Search, Send, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import FlatFileGrid from '@/components/flat-file/FlatFileGrid'
import type { BaseRow, FlatFileColumn, ModalsCtx, ToolbarFetchCtx, ToolbarImportCtx, PushExtrasCtx, RenderCellContent } from '@/components/flat-file/FlatFileGrid.types'
import { ChannelStrip } from './ChannelStrip'
import {
  EBAY_FIXED_GROUPS, MARKET_COLUMN_GROUPS, buildCategoryColumns,
  type CategoryAspect, type EbayColumnGroup,
} from './ebay-columns'

// ── Types ─────────────────────────────────────────────────────────────────

export interface EbayRow extends BaseRow {
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
  image_1?: string; image_2?: string; image_3?: string
  image_4?: string; image_5?: string; image_6?: string
  fulfillment_policy_id?: string
  payment_policy_id?: string
  return_policy_id?: string
  listing_status?: string
  last_pushed_at?: string
  sync_status?: string
  platformProductId?: string
  it_price?: number | null; it_qty?: number | null; it_item_id?: string | null
  it_status?: string | null; it_listing_id?: string | null
  de_price?: number | null; de_qty?: number | null; de_item_id?: string | null
  de_status?: string | null; de_listing_id?: string | null
  fr_price?: number | null; fr_qty?: number | null; fr_item_id?: string | null
  fr_status?: string | null; fr_listing_id?: string | null
  es_price?: number | null; es_qty?: number | null; es_item_id?: string | null
  es_status?: string | null; es_listing_id?: string | null
  uk_price?: number | null; uk_qty?: number | null; uk_item_id?: string | null
  uk_status?: string | null; uk_listing_id?: string | null
}

interface PushResult { sku: string; market: string; status: 'PUSHED' | 'ERROR'; message: string; itemId?: string }
interface FeedStatus { taskId: string; status: string; completionDate?: string; summaryCount?: number; failureCount?: number }
interface CategoryResult { id: string; name: string; path: string; matchScore: number }

// ── Factory ───────────────────────────────────────────────────────────────

function makeBlankRow(): EbayRow {
  return {
    _rowId: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    _isNew: true, _dirty: true, _status: 'idle', sku: '',
  }
}

// ── Validation ────────────────────────────────────────────────────────────

function validateRows(rows: BaseRow[]) {
  const issues: Array<{ level: 'error' | 'warn'; sku: string; field: string; msg: string }> = []
  for (const row of rows) {
    const sku = String(row.sku ?? '')
    if (!sku) issues.push({ level: 'error', sku: '?', field: 'sku', msg: 'SKU is required' })
    const title = String(row.title ?? '')
    if (!title) issues.push({ level: 'warn', sku, field: 'title', msg: 'Title is empty' })
    if (title.length > 80) issues.push({ level: 'error', sku, field: 'title', msg: `Title exceeds 80 chars (${title.length})` })
  }
  return issues
}

// ── Description modal ─────────────────────────────────────────────────────

function DescriptionModal({ value, onSave, onClose }: { value: string; onSave: (v: string) => void; onClose: () => void }) {
  const [text, setText] = useState(value)
  const remaining = 4000 - text.length
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl flex flex-col w-[800px] max-w-full max-h-[80vh] p-4 gap-2">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-sm">Description Editor</span>
          <span className={cn('text-xs', remaining < 0 ? 'text-red-600' : 'text-slate-400')}>{remaining} chars remaining</span>
        </div>
        <textarea
          className="flex-1 min-h-[400px] border border-slate-300 dark:border-slate-600 rounded-lg p-3 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-slate-800 dark:text-slate-100"
          value={text} onChange={(e) => setText(e.target.value)} placeholder="Enter HTML description…" />
        <p className="text-xs text-slate-400">HTML is supported: &lt;p&gt;, &lt;ul&gt;, &lt;li&gt;, &lt;br&gt;…</p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => { onSave(text); onClose() }}>Save</Button>
        </div>
      </div>
    </div>
  )
}

// ── Category search panel ─────────────────────────────────────────────────

function CategorySearchPanel({ marketplace, onSelect, onClose }: {
  marketplace: string; onSelect: (id: string, name: string) => void; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CategoryResult[]>([])
  const [loading, setLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useState(() => { setTimeout(() => inputRef.current?.focus(), 0) })

  useState(() => {}) // mount effect placeholder — using pattern below instead
  const lastQuery = useRef('')
  if (query !== lastQuery.current) {
    lastQuery.current = query
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (query.trim().length >= 2) {
      debounceRef.current = setTimeout(async () => {
        setLoading(true)
        try {
          const mpId = marketplace.startsWith('EBAY_') ? marketplace : `EBAY_${marketplace}`
          const res = await fetch(`${getBackendUrl()}/api/ebay/flat-file/category-search?q=${encodeURIComponent(query)}&marketplace=${mpId}`)
          if (res.ok) setResults((await res.json() as { categories: CategoryResult[] }).categories)
        } catch { setResults([]) }
        finally { setLoading(false) }
      }, 300)
    } else {
      setResults([])
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-32"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl w-[500px] max-w-full border border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-2 p-3 border-b border-slate-200 dark:border-slate-700">
          <Search className="w-4 h-4 text-slate-400 shrink-0" />
          <input ref={inputRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onClose()}
            placeholder="Search eBay categories…"
            className="flex-1 text-sm bg-transparent outline-none text-slate-800 dark:text-slate-100 placeholder:text-slate-400" />
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 shrink-0" />}
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-4 h-4" /></button>
        </div>
        {results.length > 0 && (
          <ul className="max-h-72 overflow-y-auto py-1">
            {results.map((cat) => (
              <li key={cat.id}>
                <button type="button" onClick={() => { onSelect(cat.id, cat.name); onClose() }}
                  className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                  <div className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{cat.path}</div>
                  <div className="text-[10px] text-slate-400 font-mono">ID: {cat.id}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
        {query.trim().length >= 2 && !loading && !results.length && (
          <div className="px-4 py-3 text-xs text-slate-400">No categories found. Try a different term.</div>
        )}
        {query.trim().length < 2 && (
          <div className="px-4 py-3 text-xs text-slate-400">Type at least 2 characters to search…</div>
        )}
      </div>
    </div>
  )
}

// ── Multi-market publish panel ─────────────────────────────────────────────

const ALL_MARKETS = [
  { code: 'IT', label: 'Italy (eBay.it)' },
  { code: 'DE', label: 'Germany (eBay.de)' },
  { code: 'FR', label: 'France (eBay.fr)' },
  { code: 'ES', label: 'Spain (eBay.es)' },
  { code: 'UK', label: 'UK (eBay.co.uk)' },
]

function PublishPanel({ selectedCount, publishTargets, onChangeTargets, onPublish, pushing, onClose }: {
  selectedCount: number; publishTargets: string[]; onChangeTargets: (t: string[]) => void
  onPublish: () => void; pushing: boolean; onClose: () => void
}) {
  return (
    <div className="absolute right-0 top-full mt-1 z-50 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-200">Push to markets</span>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X className="w-3.5 h-3.5" /></button>
      </div>
      <div className="space-y-1.5">
        {ALL_MARKETS.map((m) => (
          <label key={m.code} className="flex items-center gap-2 cursor-pointer select-none">
            <input type="checkbox" className="h-3.5 w-3.5 accent-blue-600"
              checked={publishTargets.includes(m.code)}
              onChange={() => onChangeTargets(publishTargets.includes(m.code)
                ? publishTargets.filter((x) => x !== m.code)
                : [...publishTargets, m.code])} />
            <span className="text-xs text-slate-700 dark:text-slate-300">{m.label}</span>
          </label>
        ))}
      </div>
      <p className="text-[10px] text-slate-400">
        {selectedCount > 0 ? `${selectedCount} selected rows` : 'All rows'} will be pushed.
      </p>
      <Button size="sm" className="w-full" disabled={!publishTargets.length || pushing} loading={pushing} onClick={onPublish}>
        <Send className="w-3.5 h-3.5 mr-1.5" />Push to {publishTargets.length > 0 ? publishTargets.join(', ') : 'markets'}
      </Button>
    </div>
  )
}

// ── Feed status banner ─────────────────────────────────────────────────────

function FeedStatusBanner({ feedStatus, onPoll }: { feedStatus: FeedStatus; onPoll: () => void }) {
  const done   = ['COMPLETED', 'COMPLETED_WITH_ERROR'].includes(feedStatus.status)
  const failed = feedStatus.status === 'FAILED'
  return (
    <div className={cn('flex items-center gap-3 px-4 py-2 text-sm border-b',
      done && !failed ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
        : failed ? 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950/30 dark:text-red-300'
        : 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300')}>
      {!done && !failed && <Loader2 className="h-4 w-4 animate-spin" />}
      {done && !failed && <AlertCircle className="h-4 w-4" />}
      <span className="font-medium">Feed {feedStatus.status}</span>
      {feedStatus.summaryCount != null && <span className="text-xs">{feedStatus.summaryCount} processed</span>}
      {feedStatus.failureCount != null && feedStatus.failureCount > 0 && (
        <span className="text-xs text-red-600">{feedStatus.failureCount} failed</span>
      )}
      {!done && !failed && (
        <button onClick={onPoll} className="ml-auto text-xs underline">Check status</button>
      )}
    </div>
  )
}

// ── Page props ─────────────────────────────────────────────────────────────

interface Props {
  initialRows: EbayRow[]
  initialMarketplace: string
  familyId?: string
}

// ── Main component ─────────────────────────────────────────────────────────

export default function EbayFlatFileClient({ initialRows, initialMarketplace, familyId }: Props) {
  const { toast } = useToast()
  const [marketplace] = useState(initialMarketplace)
  const BACKEND = getBackendUrl()

  // ── eBay-specific UI state ─────────────────────────────────────────────
  const [pushing, setPushing]                 = useState(false)
  const [feedStatus, setFeedStatus]           = useState<FeedStatus | null>(null)
  const [publishPanelOpen, setPublishPanelOpen] = useState(false)
  const [publishTargets, setPublishTargets]   = useState<string[]>(['IT'])
  const [descModal, setDescModal]             = useState<{ rowId: string } | null>(null)
  const [categorySearchOpen, setCategorySearchOpen]   = useState(false)
  const [categorySearchRowId, setCategorySearchRowId] = useState<string | null>(null)
  const [fetching, setFetching]               = useState(false)
  const [fetchPanelOpen, setFetchPanelOpen]   = useState(false)

  // ── Category schema state (drives columnGroups) ────────────────────────
  const [categoryColumnsCache, setCategoryColumnsCache] = useState<Map<string, EbayColumnGroup>>(new Map())
  const [categoryColumns, setCategoryColumns] = useState<EbayColumnGroup | null>(null)

  const columnGroups = useMemo(() => {
    const base = [...EBAY_FIXED_GROUPS, ...MARKET_COLUMN_GROUPS]
    return categoryColumns ? [
      ...EBAY_FIXED_GROUPS,
      categoryColumns,
      ...MARKET_COLUMN_GROUPS,
    ] : base
  }, [categoryColumns])

  // ── Category schema loading ────────────────────────────────────────────

  const loadCategorySchema = useCallback(async (categoryId: string) => {
    if (!categoryId) { setCategoryColumns(null); return }
    if (categoryColumnsCache.has(categoryId)) {
      setCategoryColumns(categoryColumnsCache.get(categoryId)!)
      return
    }
    try {
      const mpId = marketplace.startsWith('EBAY_') ? marketplace : `EBAY_${marketplace}`
      const res  = await fetch(`${BACKEND}/api/ebay/flat-file/category-schema?categoryId=${encodeURIComponent(categoryId)}&marketplace=${mpId}`)
      if (!res.ok) return
      const json  = await res.json() as { aspects: CategoryAspect[] }
      const group = buildCategoryColumns(json.aspects)
      setCategoryColumnsCache((prev) => new Map(prev).set(categoryId, group))
      setCategoryColumns(group)
    } catch { /* silently fail — optional */ }
  }, [marketplace, categoryColumnsCache, BACKEND])

  // ── API: reload ────────────────────────────────────────────────────────

  const onReload = useCallback(async (): Promise<BaseRow[]> => {
    const qs = new URLSearchParams()
    if (familyId) qs.set('familyId', familyId)
    const res = await fetch(`${BACKEND}/api/ebay/flat-file/rows?${qs}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { rows: EbayRow[] }
    return json.rows
  }, [familyId, BACKEND])

  // ── API: save ─────────────────────────────────────────────────────────

  const onSave = useCallback(async (dirty: BaseRow[]): Promise<{ saved: number }> => {
    const res = await fetch(`${BACKEND}/api/ebay/flat-file/rows`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: dirty }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<{ saved: number }>
  }, [BACKEND])

  // ── API: push to eBay ─────────────────────────────────────────────────

  async function pushToEbay(rows: BaseRow[], selectedRows: Set<string>) {
    const toPush = selectedRows.size > 0
      ? rows.filter((r) => selectedRows.has(r._rowId))
      : rows.filter((r) => r._dirty)
    if (!toPush.length) { toast({ title: 'Nothing to push', tone: 'info' }); return }
    setPushing(true)
    try {
      const res = await fetch(`${BACKEND}/api/ebay/flat-file/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: toPush, markets: publishTargets }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { results?: PushResult[]; taskId?: string }
      if (json.taskId) {
        setFeedStatus({ taskId: json.taskId, status: 'IN_PROGRESS' })
        toast({ title: `Feed job started: ${json.taskId}`, tone: 'info' })
      } else if (json.results) {
        const errors = json.results.filter((r) => r.status === 'ERROR')
        if (errors.length) toast.error(`${errors.length} push errors`)
        else toast.success(`Pushed ${json.results.length} rows`)
      }
    } catch (err) {
      toast.error('Push failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setPushing(false)
      setPublishPanelOpen(false)
    }
  }

  // ── API: fetch live data from eBay ────────────────────────────────────

  async function handleFetchFromEbay(rows: BaseRow[], selectedRows: Set<string>, setRows: React.Dispatch<React.SetStateAction<BaseRow[]>>, pushHistory: (r: BaseRow[]) => void) {
    const skus = [...selectedRows].map((id) => {
      const row = rows.find((r) => r._rowId === id)
      return row ? String(row.sku ?? '') : ''
    }).filter(Boolean)
    if (!skus.length) return
    setFetching(true)
    try {
      const res = await fetch(`${BACKEND}/api/ebay/flat-file/fetch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skus, marketplace }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { rows: Record<string, Partial<EbayRow>> }
      const next = rows.map((r) => {
        const live = json.rows[String(r.sku ?? '')]
        return live ? { ...r, ...live, _dirty: true } : r
      })
      pushHistory(next)
      setRows(next)
      toast.success(`Fetched data for ${skus.length} SKU${skus.length !== 1 ? 's' : ''}`)
    } catch (err) {
      toast.error('Fetch failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setFetching(false)
      setFetchPanelOpen(false)
    }
  }

  // ── API: import from Amazon ────────────────────────────────────────────

  async function importFromAmazon(ctx: ToolbarImportCtx) {
    ctx // just to avoid lint warning — used inside
    try {
      const res = await fetch(`${BACKEND}/api/ebay/flat-file/import-amazon?marketplace=${marketplace}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { rows: EbayRow[] }
      const imported = json.rows.map((r) => ({ ...r, _dirty: true, _isNew: !r._productId }))
      ctx.pushHistory(imported)
      ctx.setRows(imported)
      toast.success(`Imported ${imported.length} rows from Amazon`)
    } catch (err) {
      toast.error('Import failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }

  // ── API: poll feed status ─────────────────────────────────────────────

  async function pollFeedStatus() {
    if (!feedStatus?.taskId) return
    try {
      const res = await fetch(`${BACKEND}/api/ebay/flat-file/feed/${feedStatus.taskId}`)
      if (!res.ok) return
      const json = await res.json() as FeedStatus
      setFeedStatus(json)
    } catch { /* ignore */ }
  }

  // ── onCellChange: trigger category schema load ─────────────────────────

  const onCellChange = useCallback((rowId: string, colId: string, value: unknown) => {
    void rowId
    if (colId === 'category_id' && typeof value === 'string') {
      void loadCategorySchema(value)
    }
  }, [loadCategorySchema])

  // ── Market link URLs ───────────────────────────────────────────────────
  const MARKET_URLS: Record<string, string> = {
    IT: 'https://www.ebay.it/itm/', DE: 'https://www.ebay.de/itm/',
    FR: 'https://www.ebay.fr/itm/', ES: 'https://www.ebay.es/itm/',
    UK: 'https://www.ebay.co.uk/itm/',
  }

  // ── Cell content overrides ─────────────────────────────────────────────
  const renderCellContent = useCallback<RenderCellContent>((col, _row, value, displayVal) => {
    // Market status badge
    if (col.id.endsWith('_status') && col.readOnly) {
      return displayVal
        ? <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium',
            displayVal.toUpperCase() === 'ACTIVE' ? 'bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300'
            : displayVal.toUpperCase() === 'DRAFT' ? 'bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-900/40 dark:text-amber-300'
            : displayVal.toUpperCase() === 'ERROR' ? 'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/40 dark:text-red-300'
            : 'bg-slate-100 text-slate-600 border border-slate-200 dark:bg-slate-800 dark:text-slate-400')}>{displayVal}</span>
        : <span className="text-slate-300 text-[10px]">—</span>
    }
    // Market item ID with external link
    if (col.id.endsWith('_item_id') && col.readOnly) {
      const marketCode = col.id.slice(0, 2).toUpperCase()
      const baseUrl = MARKET_URLS[marketCode] ?? ''
      return displayVal
        ? <a href={`${baseUrl}${displayVal}`} target="_blank" rel="noopener noreferrer"
            className="flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline font-mono text-[10px]"
            onClick={(e) => e.stopPropagation()}>
            {displayVal}<ExternalLink className="w-2.5 h-2.5 shrink-0" />
          </a>
        : <span className="text-slate-300 text-[10px]">—</span>
    }
    // Title with char count
    if (col.id === 'title') {
      const len = displayVal.length
      return (
        <>
          <span className="flex-1 truncate">{displayVal}</span>
          {len > 0 && <span className={cn('text-[10px] shrink-0', len > 80 ? 'text-red-500' : 'text-slate-400')}>{len}</span>}
        </>
      )
    }
    // Description preview
    if (col.id === 'description') {
      return (
        <span className="truncate text-slate-400 italic text-[10px]">
          {displayVal ? displayVal.replace(/<[^>]+>/g, '').slice(0, 40) + '…' : 'Double-click to edit…'}
        </span>
      )
    }
    // Category ID
    if (col.id === 'category_id') {
      return displayVal
        ? <span className="font-mono text-[10px] text-blue-700 dark:text-blue-300">{displayVal}</span>
        : <span className="text-slate-300 text-[10px]">Double-click to search…</span>
    }
    // Boolean display
    if (col.kind === 'boolean') {
      return (value === true || value === 'true')
        ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        : <span className="text-slate-300">—</span>
    }
    // listing_status badge
    if (col.id === 'listing_status') {
      return displayVal
        ? <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium',
            displayVal.toUpperCase() === 'ACTIVE' ? 'bg-emerald-100 text-emerald-700 border border-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-300'
            : displayVal.toUpperCase() === 'DRAFT' ? 'bg-amber-100 text-amber-700 border border-amber-200 dark:bg-amber-900/40 dark:text-amber-300'
            : 'bg-red-100 text-red-700 border border-red-200 dark:bg-red-900/40 dark:text-red-300')}>{displayVal}</span>
        : null
    }
    // last_pushed_at date
    if (col.id === 'last_pushed_at') {
      const d = displayVal ? new Date(displayVal) : null
      return <span className="truncate text-slate-400 text-[10px]">
        {d ? d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
      </span>
    }
    // sync_status icon
    if (col.id === 'sync_status') {
      if (displayVal === 'synced')  return <CheckCircle2 className="h-3 w-3 text-emerald-500" />
      if (displayVal === 'pending') return <Loader2 className="h-3 w-3 text-amber-500 animate-spin" />
      if (displayVal === 'error')   return <AlertCircle className="h-3 w-3 text-red-500" />
      return <span className="text-slate-300 text-[10px]">—</span>
    }
    return null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Edit intercept for modal-based editing ─────────────────────────────
  const onBeforeEditCell = useCallback((col: FlatFileColumn, row: BaseRow): boolean => {
    if (col.kind === 'longtext') {
      setDescModal({ rowId: row._rowId })
      return true
    }
    if (col.id === 'category_id') {
      setCategorySearchRowId(row._rowId)
      setCategorySearchOpen(true)
      return true
    }
    return false
  }, [])

  // ── Slot: channel strip ────────────────────────────────────────────────

  const renderChannelStrip = useCallback(() => (
    <ChannelStrip channel="ebay" marketplace={marketplace} familyId={familyId} />
  ), [marketplace, familyId])

  // ── Slot: push extras (after Save button) ─────────────────────────────

  const renderPushExtras = useCallback(({ rows, selectedRows }: PushExtrasCtx) => (
    <div className="relative">
      <Button size="sm" onClick={() => setPublishPanelOpen((o) => !o)} disabled={pushing} loading={pushing}>
        <Send className="w-3.5 h-3.5 mr-1.5" />
        Push to eBay
      </Button>
      {publishPanelOpen && (
        <PublishPanel
          selectedCount={selectedRows.size}
          publishTargets={publishTargets}
          onChangeTargets={setPublishTargets}
          onPublish={() => void pushToEbay(rows, selectedRows)}
          pushing={pushing}
          onClose={() => setPublishPanelOpen(false)}
        />
      )}
    </div>
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [pushing, publishPanelOpen, publishTargets])

  // ── Slot: feed banner ──────────────────────────────────────────────────

  const renderFeedBanner = useCallback(() => feedStatus ? (
    <FeedStatusBanner feedStatus={feedStatus} onPoll={pollFeedStatus} />
  ) : null, [feedStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Slot: fetch button ─────────────────────────────────────────────────

  const renderToolbarFetch = useCallback(({ rows, selectedRows, setRows, pushHistory }: ToolbarFetchCtx) => (
    <div className="relative">
      <button
        type="button"
        onClick={() => setFetchPanelOpen((o) => !o)}
        disabled={selectedRows.size === 0 || fetching}
        title={selectedRows.size > 0 ? `Fetch from eBay (${selectedRows.size} SKU${selectedRows.size !== 1 ? 's' : ''})` : 'Fetch from eBay — select rows first'}
        className={cn(
          'relative h-7 w-7 flex items-center justify-center rounded transition-colors flex-shrink-0',
          fetchPanelOpen ? 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100'
            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800',
          'disabled:opacity-40 disabled:cursor-default',
        )}
      >
        {fetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowDownToLine className="w-3.5 h-3.5" />}
      </button>
      {fetchPanelOpen && (
        <div className="absolute left-0 top-full mt-1 z-50 w-56 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl p-3 space-y-2">
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Fetch live listing data from eBay for {selectedRows.size} selected SKU{selectedRows.size !== 1 ? 's' : ''}. Overwrites title, condition, images, and aspects.
          </p>
          <div className="flex gap-2">
            <button type="button"
              onClick={() => void handleFetchFromEbay(rows, selectedRows, setRows, pushHistory)}
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [fetching, fetchPanelOpen])

  // ── Slot: import button ────────────────────────────────────────────────

  const renderToolbarImport = useCallback((ctx: ToolbarImportCtx) => (
    <button type="button"
      onClick={() => void importFromAmazon(ctx)}
      disabled={ctx.loading}
      title="Import from Amazon — pre-fill eBay fields from matching Amazon listings"
      className="relative h-7 w-7 flex items-center justify-center rounded transition-colors flex-shrink-0 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
    >
      <ArrowRightLeft className="w-3.5 h-3.5" />
    </button>
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [])

  // ── Slot: Bar3 left ────────────────────────────────────────────────────

  const renderBar3Left = useCallback(() => (
    <span className="text-xs text-slate-500 dark:text-slate-400 font-medium whitespace-nowrap flex-shrink-0">
      All markets
    </span>
  ), [])

  // ── Slot: modals ───────────────────────────────────────────────────────

  const renderModals = useCallback(({ rows, setRows, pushHistory }: ModalsCtx) => {
    const desc = descModal ? rows.find((r) => r._rowId === descModal.rowId) : null
    return (
      <>
        {desc && descModal && (
          <DescriptionModal
            value={String(desc.description ?? '')}
            onSave={(v) => {
              const next = rows.map((r) => r._rowId === descModal.rowId ? { ...r, description: v, _dirty: true } : r)
              pushHistory(next)
              setRows(next)
            }}
            onClose={() => setDescModal(null)}
          />
        )}
        {categorySearchOpen && (
          <CategorySearchPanel
            marketplace={marketplace}
            onSelect={(id, _name) => {
              if (categorySearchRowId) {
                const next = rows.map((r) => r._rowId === categorySearchRowId ? { ...r, category_id: id, _dirty: true } : r)
                pushHistory(next)
                setRows(next)
                void loadCategorySchema(id)
              }
            }}
            onClose={() => { setCategorySearchOpen(false); setCategorySearchRowId(null) }}
          />
        )}
      </>
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descModal, categorySearchOpen, categorySearchRowId, marketplace, loadCategorySchema])

  // ── Group key for eBay variations ──────────────────────────────────────

  const getGroupKey = useCallback((row: BaseRow) =>
    String((row as EbayRow).platformProductId ?? row._rowId),
  [])

  // ── Replication handler ────────────────────────────────────────────────

  const onReplicate = useCallback(async (
    targets: string[],
    groupIds: Set<string>,
    selectedOnly: boolean,
    { rows, selectedRows, visibleGroups, pushHistory, setRows }: import('@/components/flat-file/FlatFileGrid.types').ReplicateCtx,
  ) => {
    const sourceRows = selectedOnly && selectedRows.size > 0
      ? rows.filter((r) => selectedRows.has(r._rowId))
      : rows
    const colSet = new Set(
      visibleGroups.filter((g) => groupIds.has(g.id)).flatMap((g) => g.columns.map((c) => c.id)),
    )
    let copied = 0
    for (const target of targets) {
      const copiedRows = sourceRows.map((r) => {
        const next: BaseRow = { _rowId: `copy-${r._rowId}-${target}-${Date.now()}`, _isNew: true, _dirty: true, _status: 'idle', sku: String(r.sku ?? '') }
        for (const colId of colSet) { if (r[colId] != null) next[colId] = r[colId] }
        return next
      })
      const allNext = [...rows, ...copiedRows]
      pushHistory(allNext)
      setRows(allNext)
      copied += copiedRows.length
    }
    return { copied, skipped: 0 }
  }, [])

  // ── eBay logo (title icon) ─────────────────────────────────────────────

  const titleIcon = (
    <svg viewBox="0 0 24 24" className="w-4 h-4 fill-current text-blue-600 dark:text-blue-400 flex-shrink-0" aria-hidden="true">
      <path d="M.43 8.65H3.6V16H.43V8.65zm5.9 0h1.16L9.3 14.33l1.82-5.68h1.19L9.9 16H8.75L6.33 8.65zM13.36 8.65h3.17c2.13 0 3.06 1.24 3.06 3.68 0 2.44-.93 3.67-3.06 3.67h-3.17V8.65zm1.17 6.35h1.87c1.38 0 1.95-.83 1.95-2.67 0-1.84-.57-2.68-1.95-2.68h-1.87v5.35zm5.56-6.35h1.14V16h-1.14V8.65zM2 5.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm19 0a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z" />
    </svg>
  )

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <FlatFileGrid
      channel="ebay"
      title="eBay Flat File"
      titleIcon={titleIcon}
      marketplace={marketplace}
      familyId={familyId}
      storageKey="eff"
      columnGroups={columnGroups}
      initialRows={initialRows as BaseRow[]}
      makeBlankRow={makeBlankRow}
      minRows={15}
      getGroupKey={getGroupKey}
      validate={validateRows}
      onSave={onSave}
      onReload={onReload}
      onCellChange={onCellChange}
      renderCellContent={renderCellContent}
      onBeforeEditCell={onBeforeEditCell}
      onReplicate={onReplicate}
      renderChannelStrip={renderChannelStrip}
      renderPushExtras={renderPushExtras}
      renderFeedBanner={renderFeedBanner}
      renderModals={renderModals as (ctx: ModalsCtx) => React.ReactNode}
      renderToolbarFetch={renderToolbarFetch}
      renderToolbarImport={renderToolbarImport}
      renderBar3Left={renderBar3Left}
    />
  )
}

'use client'

import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import {
  AlertCircle, ArrowRightLeft, CheckCircle2, Download, ExternalLink, GitBranch, GitFork, History, Loader2, RefreshCw, RotateCcw, Search, Send, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import FlatFileGrid from '@/components/flat-file/FlatFileGrid'
import type { BaseRow, FlatFileColumn, ModalsCtx, ToolbarFetchCtx, ToolbarImportCtx, PushExtrasCtx, RenderCellContent } from '@/components/flat-file/FlatFileGrid.types'
import { ChannelStrip } from './ChannelStrip'
import { OverrideBadge } from '../_shared/OverrideBadge'
import { CascadeModal } from '../_shared/CascadeModal'
import { FlatFileAiPanel } from '../_shared/FlatFileAiPanel'
import type { AiPanelCtx } from '@/components/flat-file/FlatFileGrid.types'
import {
  EBAY_FIXED_GROUPS, MARKET_COLUMN_GROUPS, buildCategoryColumns,
  EBAY_CONDITION_LABELS,
  type CategoryAspect, type EbayColumnGroup,
} from './ebay-columns'
import { PullDiffModal, type PullDiffApplyResult } from '../amazon-flat-file/PullDiffModal'
import { PullHistoryDrawer } from '../_shared/PullHistoryDrawer'
import { PendingPullBanner } from '../_shared/PendingPullBanner'
import { TbBtn as SharedTbBtn } from '../_shared/FlatFileIconToolbar'
import { PULL_GROUPS, pullFieldGroup, type PullGroupId } from '../_shared/pull-field-groups'

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
  /** true on the family container (no parentId); false on variant children. */
  _isParent?: boolean
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

// Parent/variant field split (grey-out, still editable). The parent row is
// the listing container, not a sellable SKU; these per-variant / offer
// fields don't apply to it. Per-market price/qty (it_price …) handled by
// regex in getCellGuidance.
const PARENT_NOT_NEEDED = new Set([
  'price', 'quantity',
  'best_offer_enabled', 'best_offer_floor', 'best_offer_ceiling',
  'vat_rate', 'ean', 'mpn',
  'package_weight', 'package_length', 'package_width', 'package_height',
])
// Listing-level fields defined once on the parent; not needed per variant.
const VARIANT_NOT_NEEDED = new Set([
  'variation_theme', 'category_id', 'subtitle', 'listing_format', 'listing_duration',
])

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
  // ── Phase 3: Pull from eBay (full pull → diff preview → apply) ──────
  const [pullPanelOpen, setPullPanelOpen]     = useState(false)
  const [pulling, setPulling]                 = useState(false)
  const [pullProgress, setPullProgress]       = useState<{ progress: number; total: number } | null>(null)
  const [pullResult, setPullResult]           = useState<{ pulled: number; skipped: number; failed: number } | null>(null)
  const [pullDiffOpen, setPullDiffOpen]       = useState(false)
  const [pullDiffData, setPullDiffData]       = useState<{
    pulledRows: BaseRow[]
    selectedColumns: 'all' | PullGroupId[]
    skusRequested: string[]
    skusReturned: number
    jobId: string
  } | null>(null)
  const [pullHistoryOpen, setPullHistoryOpen] = useState(false)
  const [pendingPullReview, setPendingPullReview] = useState<{
    jobId: string
    rows: BaseRow[]
    skusRequested: string[]
    skusReturned: number
    doneAt: string | null
  } | null>(null)

  // P5: On mount, surface a "completed while away" banner if there's
  // a recent unreviewed pull for this marketplace.
  useEffect(() => {
    if (!marketplace) return
    let cancelled = false
    void (async () => {
      try {
        const params = new URLSearchParams({ channel: 'EBAY', marketplace })
        const res = await fetch(`${BACKEND}/api/flat-file/pull-job/active?${params}`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        const job = data?.job
        if (!job || cancelled) return
        if (job.status === 'done' && !data.reviewed && Array.isArray(job.rows) && job.rows.length > 0) {
          setPendingPullReview({
            jobId: job.id,
            rows: job.rows as BaseRow[],
            skusRequested: Array.isArray(job.skus) ? job.skus : [],
            skusReturned: typeof job.pulled === 'number' ? job.pulled : (job.rows.length ?? 0),
            doneAt: job.doneAt ?? null,
          })
        }
      } catch {
        // best-effort
      }
    })()
    return () => { cancelled = true }
  }, [marketplace, BACKEND])

  // IN.2 — Cascade button toggle (default on, shared localStorage key with Amazon)
  const [showCascadeButtons, setShowCascadeButtons] = useState<boolean>(() => {
    try { return localStorage.getItem('ff-show-cascade') !== '0' } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('ff-show-cascade', showCascadeButtons ? '1' : '0') } catch {} }, [showCascadeButtons])
  const [cascadeRow, setCascadeRow] = useState<BaseRow | null>(null)

  // IN.1 — Override badges toggle (default on, persisted to localStorage)
  const [showOverrideBadges, setShowOverrideBadges] = useState<boolean>(() => {
    try { return localStorage.getItem('ff-show-overrides') !== '0' } catch { return true }
  })
  useEffect(() => {
    try { localStorage.setItem('ff-show-overrides', showOverrideBadges ? '1' : '0') } catch {}
  }, [showOverrideBadges])

  // Ensure row height is tall enough for badge + row number to both be visible
  useState(() => {
    try {
      const current = parseInt(localStorage.getItem('eff-row-height') ?? '28', 10) || 28
      if (current < 36) localStorage.setItem('eff-row-height', '36')
    } catch {}
  })

  // ── Category schema state (drives columnGroups) ────────────────────────
  const [categoryColumnsCache, setCategoryColumnsCache] = useState<Map<string, EbayColumnGroup>>(new Map())
  const [categoryColumns, setCategoryColumns] = useState<EbayColumnGroup | null>(null)
  // FF-EN.2 — the loaded category's allowed conditions (Inventory enum + label)
  const [conditionOptions, setConditionOptions] = useState<Array<{ value: string; label: string }>>([])
  const conditionsCacheRef = useRef<Map<string, Array<{ value: string; label: string }>>>(new Map())
  // FF-EN.3 — the loaded category's variant-eligible axis names (for the
  // Variation Theme multi-picker). English name preferred to match the
  // canonical "Size,Color" theme convention.
  const [variantAxisNames, setVariantAxisNames] = useState<string[]>([])
  const variantAxisCacheRef = useRef<Map<string, string[]>>(new Map())

  // ── Business policies (fulfillment / payment / return) ─────────────────
  const [policyOptions, setPolicyOptions] = useState<{
    fulfillment: Array<{ id: string; name: string }>
    payment:     Array<{ id: string; name: string }>
    return:      Array<{ id: string; name: string }>
  }>({ fulfillment: [], payment: [], return: [] })

  // Fetch policies once on mount (non-blocking — column options update when done)
  useEffect(() => {
    fetch(`${BACKEND}/api/ebay/flat-file/policies?marketplace=${marketplace}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setPolicyOptions(d) })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketplace])

  // Inject policy IDs as enum options into the Policies column group,
  // and (FF-EN.2) narrow the Condition column to the category's allowed set.
  const columnGroups = useMemo(() => {
    const patchPolicies = (groups: EbayColumnGroup[]): EbayColumnGroup[] =>
      groups.map((g) => {
        if (g.id !== 'policies') return g
        return {
          ...g,
          columns: g.columns.map((col) => {
            if (col.id === 'fulfillment_policy_id' && policyOptions.fulfillment.length) {
              return { ...col, kind: 'enum' as const, options: policyOptions.fulfillment.map((p) => p.id), optionLabels: Object.fromEntries(policyOptions.fulfillment.map((p) => [p.id, p.name])) }
            }
            if (col.id === 'payment_policy_id' && policyOptions.payment.length) {
              return { ...col, kind: 'enum' as const, options: policyOptions.payment.map((p) => p.id), optionLabels: Object.fromEntries(policyOptions.payment.map((p) => [p.id, p.name])) }
            }
            if (col.id === 'return_policy_id' && policyOptions.return.length) {
              return { ...col, kind: 'enum' as const, options: policyOptions.return.map((p) => p.id), optionLabels: Object.fromEntries(policyOptions.return.map((p) => [p.id, p.name])) }
            }
            return col
          }),
        }
      })
    // FF-EN.2/.3 — when a category is loaded, narrow the Listing group:
    //  - Condition → the category's allowed conditions (strict-overridable),
    //  - Variation Theme → a multi-pick of variant-eligible axis names (open).
    // With nothing loaded the static columns (open) are kept.
    const patchListing = (groups: EbayColumnGroup[]): EbayColumnGroup[] =>
      (conditionOptions.length === 0 && variantAxisNames.length === 0) ? groups : groups.map((g) => {
        if (g.id !== 'listing') return g
        return {
          ...g,
          columns: g.columns.map((col) => {
            if (col.id === 'condition' && conditionOptions.length) {
              return {
                ...col,
                kind: 'enum' as const,
                options: conditionOptions.map((c) => c.value),
                // Prefer the English label (eBay localises condition descriptions
                // to the marketplace even with Accept-Language: en-US, and
                // operators read English); fall back to eBay's text otherwise.
                optionLabels: Object.fromEntries(conditionOptions.map((c) => [c.value, EBAY_CONDITION_LABELS[c.value] ?? c.label])),
                enumMode: 'strict' as const,
              }
            }
            if (col.id === 'variation_theme' && variantAxisNames.length) {
              return {
                ...col,
                kind: 'enum' as const,
                options: variantAxisNames,
                enumMode: 'open' as const,
                multiValue: true,
              }
            }
            return col
          }),
        }
      })
    const patch = (groups: EbayColumnGroup[]) => patchListing(patchPolicies(groups))
    const base = patch([...EBAY_FIXED_GROUPS, ...MARKET_COLUMN_GROUPS])
    return categoryColumns ? [
      ...patch(EBAY_FIXED_GROUPS),
      categoryColumns,
      ...patch(MARKET_COLUMN_GROUPS),
    ] : base
  }, [categoryColumns, policyOptions, conditionOptions, variantAxisNames])

  // ── Category schema loading ────────────────────────────────────────────

  const loadCategorySchema = useCallback(async (categoryId: string) => {
    if (!categoryId) { setCategoryColumns(null); setConditionOptions([]); setVariantAxisNames([]); return }
    if (categoryColumnsCache.has(categoryId)) {
      setCategoryColumns(categoryColumnsCache.get(categoryId)!)
      setConditionOptions(conditionsCacheRef.current.get(categoryId) ?? [])
      setVariantAxisNames(variantAxisCacheRef.current.get(categoryId) ?? [])
      return
    }
    try {
      const mpId = marketplace.startsWith('EBAY_') ? marketplace : `EBAY_${marketplace}`
      const res  = await fetch(`${BACKEND}/api/ebay/flat-file/category-schema?categoryId=${encodeURIComponent(categoryId)}&marketplace=${mpId}`)
      if (!res.ok) return
      const json  = await res.json() as { aspects: CategoryAspect[]; conditions?: Array<{ value: string; label: string }> }
      const group = buildCategoryColumns(json.aspects)
      const conds = json.conditions ?? []
      // Variant-eligible axis names — prefer the English name in "Name (English)".
      const axisNames = json.aspects
        .filter((a) => a.variantEligible)
        .map((a) => a.label.match(/\(([^)]+)\)\s*$/)?.[1] ?? a.label)
      setCategoryColumnsCache((prev) => new Map(prev).set(categoryId, group))
      conditionsCacheRef.current.set(categoryId, conds)
      variantAxisCacheRef.current.set(categoryId, axisNames)
      setCategoryColumns(group)
      setConditionOptions(conds)
      setVariantAxisNames(axisNames)
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
    const result = await res.json() as { saved: number }
    if (result.saved > 0) {
      emitInvalidation({ type: 'product.updated', meta: { source: 'ebay-flat-file' } })
      emitInvalidation({ type: 'stock.adjusted', meta: { source: 'ebay-flat-file' } })
    }
    return result
  }, [BACKEND])

  // ── API: push to eBay ─────────────────────────────────────────────────

  async function pushToEbay(rows: BaseRow[], selectedRows: Set<string>) {
    const toPush = selectedRows.size > 0
      ? rows.filter((r) => selectedRows.has(r._rowId))
      : rows.filter((r) => r._dirty)
    if (!toPush.length) { toast({ title: 'Nothing to push', tone: 'info' }); return }
    setPushing(true)
    try {
      // DSP.7 — pre-save dirty rows BEFORE pushing to eBay. Pre-DSP.7
      // the push went out but the parent grid's localStorage / server
      // state didn't reflect the rows that just shipped — operator
      // refreshing then saw older data while eBay already had the new
      // version. Match Amazon's submit pre-save guarantee.
      const dirty = rows.filter((r) => r._dirty)
      if (dirty.length > 0) {
        try {
          await onSave(dirty)
        } catch (err) {
          toast.error('Save failed before push: ' + (err instanceof Error ? err.message : String(err)))
          return
        }
      }
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

  // ── Pull from eBay (Phase 3) ──────────────────────────────────────────
  // Async pull job. Receives the SKU list + column-group filter from
  // the PullFromEbayPanel, polls the backend until done, then stashes
  // results in pullDiffData so renderModals can show PullDiffModal.
  const startPullJob = useCallback(async (opts: {
    skus: string[]
    columns: 'all' | PullGroupId[]
  }) => {
    if (!opts.skus.length) {
      toast.error('No SKUs to pull')
      return
    }

    setPullPanelOpen(false)
    setPulling(true)
    setPullProgress({ progress: 0, total: opts.skus.length })
    setPullResult(null)

    try {
      const startRes = await fetch(`${BACKEND}/api/ebay/flat-file/pull-preview/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ marketplace, skus: opts.skus }),
      })
      const startData = await startRes.json()
      if (!startRes.ok) throw new Error(startData.error ?? 'Pull failed to start')
      const { jobId } = startData

      let job: any = null
      for (let i = 0; i < 1200; i++) {
        await new Promise((r) => setTimeout(r, 1500))
        const statusRes = await fetch(`${BACKEND}/api/ebay/flat-file/pull-preview/status/${jobId}`)
        if (!statusRes.ok) throw new Error('Pull status check failed')
        job = await statusRes.json()
        setPullProgress({ progress: job.progress, total: job.total })
        if (job.status === 'done' || job.status === 'failed') break
      }

      if (!job || job.status !== 'done') {
        throw new Error(job?.fatalError ?? 'Pull timed out')
      }

      const pulledRows: BaseRow[] = Array.isArray(job.rows) ? job.rows : []
      setPullDiffData({
        pulledRows,
        selectedColumns: opts.columns,
        skusRequested: opts.skus,
        skusReturned: pulledRows.length,
        jobId,
      })
      setPullDiffOpen(true)
    } catch (e: any) {
      toast.error(e?.message ?? 'Pull from eBay failed')
    } finally {
      setPulling(false)
      setPullProgress(null)
    }
  }, [BACKEND, marketplace, toast])

  // Apply selection from PullDiffModal — runs inside the renderModals
  // slot so it can use slot-provided rows/setRows/pushHistory. The
  // callback factory below is invoked from there.
  const makePullDiffApplyHandler = useCallback((
    rows: BaseRow[],
    setRows: React.Dispatch<React.SetStateAction<BaseRow[]>>,
    pushHistory: (r: BaseRow[]) => void,
  ) => async (result: PullDiffApplyResult) => {
    if (!pullDiffData) return

    const { pulledRows, selectedColumns, skusRequested, skusReturned, jobId } = pullDiffData
    const bySku = new Map<string, BaseRow>()
    for (const r of pulledRows) bySku.set(String((r as any).item_sku ?? (r as any).sku ?? ''), r)

    const selectedSet = new Set(result.selectedRowIds)
    const isAllColumns = selectedColumns === 'all'
    const groupFilter = new Set(isAllColumns ? [] : (selectedColumns as PullGroupId[]))

    const next: BaseRow[] = rows.map((row) => {
      if (!selectedSet.has(String(row._rowId))) return row
      const sku = String((row as any).sku ?? '')
      const pulled = bySku.get(sku)
      if (!pulled) return row

      const merged: BaseRow = { ...row }
      let changed = false
      for (const [k, v] of Object.entries(pulled)) {
        if (k.startsWith('_')) continue
        if (k === 'item_sku') continue  // eBay uses 'sku', not 'item_sku'
        if (!isAllColumns && !groupFilter.has(pullFieldGroup(k))) continue
        if ((merged as any)[k] === v) continue
        ;(merged as any)[k] = v
        changed = true
      }
      if (changed) merged._dirty = true
      return changed ? merged : row
    })

    pushHistory(next)
    setRows(next)

    setPullResult({
      pulled: result.selectedRowIds.length,
      skipped: skusReturned - result.selectedRowIds.length,
      failed: 0,
    })
    setTimeout(() => setPullResult(null), 10000)
    setPullDiffOpen(false)
    setPullDiffData(null)

    void fetch(`${BACKEND}/api/ebay/flat-file/pull-preview/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId,
        marketplace,
        skusRequested,
        skusReturned,
        columnsApplied: isAllColumns ? ['all'] : result.groupsApplied,
        rowsApplied: result.selectedRowIds.length,
        fieldsApplied: result.fieldsApplied,
      }),
    }).catch(() => { /* best-effort */ })
  }, [pullDiffData, marketplace, BACKEND])

  // ── API: import from Amazon ────────────────────────────────────────────
  // Slot-agnostic — both ToolbarFetchCtx and ToolbarImportCtx expose
  // setRows + pushHistory, which is all this needs.

  async function importFromAmazon(ctx: {
    setRows: React.Dispatch<React.SetStateAction<BaseRow[]>>
    pushHistory: (rows: BaseRow[]) => void
  }) {
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

  // Parent ids that actually have variant rows loaded — so the SKU badge
  // shows "Parent" only on a true variation parent, not a standalone product
  // (which also has _isParent=true). Variants' platformProductId is the
  // parent's id, so a parent's own id appearing here means it has children.
  const familyParentIds = useMemo(
    () => new Set(
      initialRows
        .filter((r) => r._isParent === false && r.platformProductId)
        .map((r) => String(r.platformProductId)),
    ),
    [initialRows],
  )

  // ── Cell content overrides ─────────────────────────────────────────────
  const renderCellContent = useCallback<RenderCellContent>((col, _row, value, displayVal) => {
    // SKU — parent / variant cue (drives off the _isParent flag + family set)
    if (col.id === 'sku') {
      const er = _row as EbayRow
      const isVariant = er._isParent === false
      const isParent = er._isParent === true && familyParentIds.has(String(er.platformProductId ?? ''))
      if (!isVariant && !isParent) return null // standalone — plain SKU
      return (
        <span className="flex items-center gap-1.5 min-w-0">
          {isVariant && <span className="text-slate-300 dark:text-slate-600 shrink-0 font-mono" aria-hidden>└</span>}
          <span className={cn('truncate', isParent && 'font-semibold text-slate-900 dark:text-slate-100')}>{displayVal}</span>
          {isParent && (
            <span className="shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-blue-100 text-blue-700 border border-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:border-blue-800">Parent</span>
          )}
          {isVariant && (
            <span className="shrink-0 rounded px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide bg-slate-100 text-slate-500 border border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700">Variant</span>
          )}
        </span>
      )
    }
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
  }, [familyParentIds])

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

  // ── Listing guidance ──────────────────────────────────────────────────
  const getCellGuidance = useCallback((col: FlatFileColumn, row: BaseRow): 'not-applicable' | 'optional' | null => {
    const er = row as EbayRow
    const isVariant = er._isParent === false
    const isFamilyParent = er._isParent === true && familyParentIds.has(String(er.platformProductId ?? ''))

    // Parent / variant field split — the parent is the listing container
    // (not a sellable SKU), variants are the SKUs. Greyed cells stay fully
    // editable; this only shades + tooltips the fields that row type doesn't
    // drive on eBay.
    if (isFamilyParent) {
      // Per-variant / offer concepts the parent container doesn't carry.
      if (PARENT_NOT_NEEDED.has(col.id) || /^(it|de|fr|es|uk)_(price|qty)$/.test(col.id)) {
        return 'not-applicable'
      }
    } else if (isVariant) {
      // Listing-level fields defined once on the parent.
      if (VARIANT_NOT_NEEDED.has(col.id)) return 'not-applicable'
    }

    // Best Offer floor/ceiling only meaningful when Best Offer is enabled
    if (col.id === 'best_offer_floor' || col.id === 'best_offer_ceiling') {
      const enabled = row.best_offer_enabled === true || row.best_offer_enabled === 'true'
      if (!enabled) return 'not-applicable'
    }
    // Item specifics: use guidance from eBay category API
    if (col.id.startsWith('aspect_') && col.guidance === 'OPTIONAL') return 'optional'
    return null
  }, [familyParentIds])

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
    <>
      {/* Phase 3 — Pull from eBay (full data, undoable, diff preview) */}
      <div className="relative">
        <SharedTbBtn
          icon={pulling ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
          title={`Pull from eBay ${marketplace} — full listing data with diff preview, undoable with ⌘Z. Does not touch the database until you click Save.`}
          onClick={() => setPullPanelOpen((o) => !o)}
          disabled={!rows.length || pulling}
          active={pullPanelOpen}
        />
        {pullPanelOpen && (
          <PullFromEbayPanel
            selectedCount={selectedRows.size}
            totalCount={rows.length}
            currentMarket={marketplace}
            pulling={pulling}
            onPull={(opts) => {
              let skus: string[]
              if (opts.scope === 'selected') {
                skus = [...selectedRows]
                  .map((id) => String(rows.find((r) => r._rowId === id)?.sku ?? ''))
                  .filter(Boolean)
              } else {
                skus = rows.map((r) => String(r.sku ?? '')).filter(Boolean)
              }
              return startPullJob({ skus, columns: opts.columns })
            }}
            onClose={() => setPullPanelOpen(false)}
          />
        )}
      </div>

      {/* Pull history — recent applied pulls + one-click re-pull */}
      <SharedTbBtn
        icon={<History className="w-3.5 h-3.5" />}
        title="Pull history — review past pulls and re-run with same scope"
        onClick={() => setPullHistoryOpen(true)}
        active={pullHistoryOpen}
      />

      {/* Import from Amazon — pre-fill eBay fields from matching Amazon listings (PC: moved here from renderToolbarImport so all data-fetch actions sit together) */}
      <SharedTbBtn
        icon={<ArrowRightLeft className="w-3.5 h-3.5" />}
        title="Import from Amazon — pre-fill eBay fields from matching Amazon listings"
        onClick={() => void importFromAmazon({ setRows, pushHistory })}
      />

      {/* Inline progress / result indicator */}
      {pullProgress && (
        <span className="text-[11px] flex items-center gap-1 flex-shrink-0 text-blue-600 dark:text-blue-400 ml-1">
          <RefreshCw className="w-3 h-3 animate-spin" />
          Pulling {pullProgress.progress}/{pullProgress.total || '?'} from {marketplace}…
        </span>
      )}
      {pullResult && !pullProgress && (
        <span className="text-[11px] flex items-center gap-1 flex-shrink-0 text-emerald-600 dark:text-emerald-400 ml-1">
          <CheckCircle2 className="w-3 h-3" />
          Pulled {pullResult.pulled}
          {pullResult.skipped > 0 && ` · ${pullResult.skipped} not on ${marketplace}`}
          {' · ⌘Z to undo'}
        </span>
      )}
    </>
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [pullPanelOpen, pulling, pullProgress, pullResult, marketplace, startPullJob, pullHistoryOpen])

  // ── Slot: import button ────────────────────────────────────────────────

  // View-toggle slot (Override / Cascade / Reset). Import-from-Amazon
  // moved to renderToolbarFetch in Phase C so all data-fetch actions
  // sit together.
  const renderToolbarImport = useCallback((ctx: ToolbarImportCtx) => (
    <>
      {/* IN.1 — Override badges toggle */}
      <SharedTbBtn
        icon={<GitBranch className="w-3.5 h-3.5" />}
        title={showOverrideBadges ? 'Hide field-override indicators' : 'Show field-override indicators (amber ⎇ badge on rows with channel overrides)'}
        onClick={() => setShowOverrideBadges((o) => !o)}
        active={showOverrideBadges}
      />

      {/* IN.2 — Cascade buttons toggle */}
      <SharedTbBtn
        icon={<GitFork className="w-3.5 h-3.5" />}
        title={showCascadeButtons ? 'Hide cascade-to-siblings buttons' : 'Show cascade-to-siblings buttons (⎇↓ on each row)'}
        onClick={() => setShowCascadeButtons((o) => !o)}
        active={showCascadeButtons}
      />

      {/* IN.2 — Reset all visible overrides back to master */}
      <SharedTbBtn
        icon={<RotateCcw className="w-3.5 h-3.5" />}
        title="Reset all channel overrides to master values (sets followMaster=true on all visible rows)"
        onClick={async () => {
          const overrideRows = ctx.rows.filter((r) => {
            const fs = (r as any)._fieldStates
            return fs && Object.values(fs).some((v) => v === 'OVERRIDE')
          })
          if (!overrideRows.length) return
          const ids = overrideRows.map((r) => (r as any)._listingId as string).filter(Boolean)
          await Promise.all(
            ids.map((id) =>
              fetch(`${getBackendUrl()}/api/listings/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  followMasterPrice: true, followMasterTitle: true,
                  followMasterDescription: true, followMasterQuantity: true,
                  followMasterBulletPoints: true,
                }),
              }),
            ),
          )
          void ctx.onReload()
        }}
        disabled={!ctx.rows.length}
      />
    </>
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [showOverrideBadges, showCascadeButtons])

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
        {/* Phase 3 — Pull diff preview */}
        {pullDiffData && pullDiffOpen && (
          <PullDiffModal
            open={pullDiffOpen}
            pulledRows={pullDiffData.pulledRows.map((r) => {
              // PullDiffModal matches rows by item_sku. The eBay editor
              // uses `sku` instead — copy it across so the modal can
              // index correctly. The merge in makePullDiffApplyHandler
              // also looks both keys up.
              const sku = String((r as any).sku ?? (r as any).item_sku ?? '')
              return { ...(r as any), item_sku: sku, _rowId: String(r._rowId ?? sku), _dirty: false } as any
            })}
            currentRows={rows.map((r) => ({ ...r, item_sku: String(r.sku ?? '') } as any))}
            marketplace={marketplace}
            productType="eBay"
            selectedColumns={pullDiffData.selectedColumns}
            onApply={makePullDiffApplyHandler(rows, setRows, pushHistory)}
            onClose={() => { setPullDiffOpen(false); setPullDiffData(null) }}
          />
        )}
      </>
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descModal, categorySearchOpen, categorySearchRowId, marketplace, loadCategorySchema, pullDiffData, pullDiffOpen, makePullDiffApplyHandler])

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

  // IN.2 — Cascade modal fields for eBay (use IT market as primary)
  const ebayCascadeFields = cascadeRow ? [
    { key: 'price', label: 'Price', value: (cascadeRow as any).it_price ?? (cascadeRow as any).price },
    { key: 'title', label: 'Title', value: (cascadeRow as any).title },
    { key: 'description', label: 'Description', value: (cascadeRow as any).description },
    { key: 'quantity', label: 'Quantity', value: (cascadeRow as any).it_qty ?? (cascadeRow as any).quantity },
  ] : []

  return (
    <>
      {/* Pull history drawer — Phase 4 */}
      <PullHistoryDrawer
        open={pullHistoryOpen}
        channel="EBAY"
        marketplace={marketplace}
        onRePull={(rec) => {
          setPullHistoryOpen(false)
          const isAllCols = rec.columnsApplied.includes('all') || rec.columnsApplied.length === 0
          const cols = (isAllCols ? 'all' : rec.columnsApplied) as 'all' | PullGroupId[]
          if (!rec.skusRequested.length) return
          void startPullJob({ skus: rec.skusRequested, columns: cols })
        }}
        onClose={() => setPullHistoryOpen(false)}
      />

      {/* P5: completed-while-away banner */}
      {pendingPullReview && (
        <PendingPullBanner
          channelLabel="eBay"
          marketplace={marketplace}
          rowCount={pendingPullReview.skusReturned}
          doneAt={pendingPullReview.doneAt}
          onReview={() => {
            setPullDiffData({
              pulledRows: pendingPullReview.rows,
              selectedColumns: 'all',
              skusRequested: pendingPullReview.skusRequested,
              skusReturned: pendingPullReview.skusReturned,
              jobId: pendingPullReview.jobId,
            })
            setPullDiffOpen(true)
            setPendingPullReview(null)
          }}
          onDismiss={() => setPendingPullReview(null)}
        />
      )}

      {cascadeRow && cascadeRow._productId && (
        <CascadeModal
          sourceProductId={String(cascadeRow._productId)}
          sourceSku={String((cascadeRow as any).sku ?? cascadeRow._rowId)}
          channel="EBAY"
          marketplace="IT"
          availableFields={ebayCascadeFields}
          onClose={() => setCascadeRow(null)}
          onSuccess={(n) => { if (n > 0) void onReload() }}
        />
      )}
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
      getCellGuidance={getCellGuidance}
      onReplicate={onReplicate}
      renderChannelStrip={renderChannelStrip}
      renderPushExtras={renderPushExtras}
      renderFeedBanner={renderFeedBanner}
      renderModals={renderModals as (ctx: ModalsCtx) => React.ReactNode}
      renderToolbarFetch={renderToolbarFetch}
      renderToolbarImport={renderToolbarImport}
      renderBar3Left={renderBar3Left}
      renderAiPanel={(ctx: AiPanelCtx) => (
        <FlatFileAiPanel {...ctx} channel="ebay" />
      )}
      renderRowMeta={(row) => (
        <div className="flex items-center gap-0.5">
          {showOverrideBadges && (
            <OverrideBadge
              listingId={row._listingId as string | null | undefined}
              fieldStates={row._fieldStates as any}
              masterValues={row._masterValues as any}
              marketListingIds={row._marketListingIds as any}
              marketFieldStates={row._marketFieldStates as any}
            />
          )}
          {/* IN.2 — Cascade button */}
          {showCascadeButtons && row._productId && (
            <button
              onClick={(e) => { e.stopPropagation(); setCascadeRow(row) }}
              onPointerDown={(e) => e.stopPropagation()}
              title="Apply this row's values to all sibling variants on eBay"
              className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-semibold leading-none transition-colors bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:hover:bg-blue-900/60"
            >
              <GitFork className="h-2.5 w-2.5" />↓
            </button>
          )}
        </div>
      )}
    />
    </>
  )
}

// ── PullFromEbayPanel ──────────────────────────────────────────────────
// Phase 3 sibling of PullFromAmazonPanel. Full-listing pull from eBay
// for the current market. Scope: selected rows or all rows in sheet.
// Column-group filter narrows which fields the diff modal will show /
// apply.

interface PullPanelProps {
  selectedCount: number
  totalCount: number
  currentMarket: string
  pulling: boolean
  onPull: (opts: { scope: 'selected' | 'all'; columns: 'all' | PullGroupId[] }) => void
  onClose: () => void
}

function PullFromEbayPanel({
  selectedCount, totalCount, currentMarket, pulling, onPull, onClose,
}: PullPanelProps) {
  const [scope, setScope] = useState<'selected' | 'all'>(
    selectedCount > 0 ? 'selected' : 'all',
  )
  const [allColumns, setAllColumns] = useState(true)
  const [selectedGroups, setSelectedGroups] = useState<Set<PullGroupId>>(
    new Set(['content', 'pricing', 'stock']),
  )
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (!panelRef.current?.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handle, true)
    return () => document.removeEventListener('mousedown', handle, true)
  }, [onClose])

  function toggleGroup(g: PullGroupId) {
    setSelectedGroups((prev) => {
      const n = new Set(prev)
      if (n.has(g)) n.delete(g); else n.add(g)
      return n
    })
  }

  const scopeCount = scope === 'selected' ? selectedCount : totalCount
  const canPull = scopeCount > 0 && (allColumns || selectedGroups.size > 0)

  return (
    <div
      ref={panelRef}
      className="absolute left-0 top-full mt-1 z-[60] w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-xl overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
            Pull from eBay {currentMarket}
          </div>
          <div className="text-xs text-slate-400">
            Review every change before it lands. ⌘Z to undo.
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scope */}
      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">
        <div className="text-xs font-medium text-slate-500 mb-2">Scope</div>
        {([
          ['selected', `Selected rows (${selectedCount})`, selectedCount > 0],
          ['all',      `All rows in sheet (${totalCount})`, totalCount > 0],
        ] as const).map(([id, label, enabled]) => (
          <label
            key={id}
            className={cn('flex items-center gap-2 py-1',
              enabled ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed')}
          >
            <input
              type="radio"
              name="ebay-pull-scope"
              checked={scope === id}
              disabled={!enabled}
              onChange={() => setScope(id)}
              className="w-3.5 h-3.5 accent-blue-600"
            />
            <span className="text-xs text-slate-700 dark:text-slate-300">{label}</span>
          </label>
        ))}
      </div>

      {/* Columns */}
      <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800">
        <label className="flex items-center gap-2 cursor-pointer mb-2">
          <input
            type="checkbox"
            checked={allColumns}
            onChange={(e) => setAllColumns(e.target.checked)}
            className="w-3.5 h-3.5 accent-blue-600"
          />
          <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
            All columns
          </span>
          <span className="text-[10px] text-slate-400">(every field eBay returns)</span>
        </label>

        {!allColumns && (
          <div className="space-y-0.5 pl-1 mt-1">
            {PULL_GROUPS.map((g) => (
              <label key={g.id} className="flex items-start gap-2 py-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedGroups.has(g.id)}
                  onChange={() => toggleGroup(g.id)}
                  className="w-3.5 h-3.5 mt-0.5 accent-blue-600"
                />
                <div>
                  <div className="text-xs text-slate-700 dark:text-slate-300">{g.label}</div>
                  <div className="text-[10px] text-slate-400">{g.description}</div>
                </div>
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3">
        <Button
          size="sm"
          className="w-full justify-center"
          onClick={() => onPull({
            scope,
            columns: allColumns ? 'all' : [...selectedGroups],
          })}
          disabled={!canPull || pulling}
          loading={pulling}
        >
          <Download className="w-3.5 h-3.5 mr-1.5" />
          Pull {scopeCount} SKU{scopeCount !== 1 ? 's' : ''} from {currentMarket}
        </Button>
        <p className="mt-2 text-[10px] text-slate-400 leading-relaxed">
          Fetches inventory + offer data from eBay. Sell API is rate-limited; large pulls take 2–5 min.
        </p>
      </div>
    </div>
  )
}

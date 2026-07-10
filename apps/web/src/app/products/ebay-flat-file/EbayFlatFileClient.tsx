'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react'
import {
  AlertCircle, ArrowRightLeft, CheckCircle2, Download, ExternalLink, GitBranch, GitFork, History, ImageIcon, Loader2, ListOrdered, Pin, Plus, RefreshCw, RotateCcw, Search, Send, Trash2, Unlink, Upload, X, Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { useToast } from '@/components/ui/Toast'
import { Button } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { applyBulkFollow, applyBulkBuffer } from '@/lib/follow-master'
import { Badge } from '@/components/ui/Badge'
import FlatFileGrid from '@/components/flat-file/FlatFileGrid'
import type { BaseRow, FlatFileColumn, ModalsCtx, ToolbarFetchCtx, ToolbarImportCtx, PushExtrasCtx, RenderCellContent, GridContextMenuCtx } from '@/components/flat-file/FlatFileGrid.types'
import { FlatFileContextMenu } from '@/components/flat-file/FlatFileContextMenu'
import { materializeGhostPatch } from '@/components/flat-file/ghost-rows'
import { Modal } from '@/design-system/components/Modal'
import { Menu } from '@/design-system/components/Menu'
import { Banner } from '@/design-system/components/Banner'
import { Combobox } from '@/design-system/components/Combobox'
import { Skeleton } from '@/design-system/primitives/Skeleton'
import { pinBlankRowsLast } from './rowOrder'
import { moveRowsToParent, detachRowsToStandalone } from './moveRows'
import { parseThemeAxes } from './themeAxes'
import { unionThemeOptions } from './resolvedAxes.pure'
import { AddListingPopover } from './AddListingPopover'
import { localizedAxisName } from './axisDefaults.pure'
import { scanAspectConflicts, buildPrePublishIssues, type PrePublishIssue } from './prePublishIssues.pure'
import { PrePublishWarningModal } from './PrePublishWarningModal'
import { EbayImportWizard } from './EbayImportWizard'
import { stampUnderParent } from './importUnderParent'
import { EbayFlatFileImageDrawer } from './EbayFlatFileImageModal'
import { deriveImageFamilies, type FamilyDeriveRow, type ImageFamilySummary } from './imageFamilies.pure'
import { AspectsPanel } from './AspectsPanel'
import { ChannelStrip } from './ChannelStrip'
import { HistoryModal } from '@/components/flat-file/HistoryModal'
import { OverrideBadge } from '../_shared/OverrideBadge'
import { CascadeModal } from '../_shared/CascadeModal'
// IE.1 — load the H10 design-system CSS so DS components (Menu, the import wizard)
// render styled on this page (namespaced --h10-*/.h10-ds-* — inert for the rest).
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import { FlatFileAiPanel } from '../_shared/FlatFileAiPanel'
import type { AiPanelCtx } from '@/components/flat-file/FlatFileGrid.types'
import {
  EBAY_FIXED_GROUPS, MARKET_COLUMN_GROUPS, buildCategoryColumns,
  mergeCategoryGroups, buildGhostAspectColumns, computeAspectKeySignature,
  aspectRoutesToPanel,
  EBAY_CONDITION_LABELS, EBAY_MARKETPLACES,
  type CategoryAspect, type EbayColumn, type EbayColumnGroup,
} from './ebay-columns'
import { FlatFileMarketStrip } from '@/components/flat-file/FlatFileMarketStrip'
import { PullDiffModal, type PullDiffApplyResult } from '../amazon-flat-file/PullDiffModal'
// PullHistoryDrawer removed — merged into HistoryModal (H.1–H.4)
import { PendingPullBanner } from '../_shared/PendingPullBanner'
import { TbBtn as SharedTbBtn } from '../_shared/FlatFileIconToolbar'
import { PULL_GROUPS, pullFieldGroup, type PullGroupId } from '../_shared/pull-field-groups'
import { VariationValueOrderModal } from './VariationValueOrderModal'
import { useFlatFileCore } from '@/components/flat-file/useFlatFileCore'
import { ColumnGroupModal } from '@/components/flat-file/ColumnGroupModal'
import { EBAY_FILTER_DEFAULT, type EbayFilterDims } from '../_shared/flat-file-filter.types'
import { isSharedDuplicateAllowed } from './validateRows.shared'
import { draftKey, readDraft, writeDraft, clearDraft, mergeDraftRows } from './draftStore'
import { useOrderEventsRefresh } from '@/hooks/use-order-events-refresh'

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
  /** Phase 4 — publish this family via the Trading-API shared-SKU path (parent-level). */
  shared_sku_listing?: boolean
  /** Task 5 (shared-mgmt) — synthesized membership row from GET /rows; grid must not allow edits. */
  _shared?: boolean
  /** Task 5 (shared-mgmt) — row must be treated as non-editable by the grid. */
  _readonly?: boolean
  /** P2.B2 — explicit parentage column value: 'parent' | 'child' | '' | undefined */
  parentage?: '' | 'parent' | 'child'
  /** FFP.6 — per-row lifecycle action applied on Push: '' publish · deactivate (qty 0, ItemID kept) · end · skip */
  row_action?: '' | 'deactivate' | 'end' | 'skip'
  /** P2.B2 — parent row's SKU for child rows (drives live grouping + orphan validation) */
  parent_sku?: string
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

// ── Sheet-parents derivation (DRY) ─────────────────────────────────────────
// Single source of truth for the parent-picker used by AddListingPopover,
// EbayImportWizard, and the Move-to-parent action.

function deriveSheetParents(rows: BaseRow[]) {
  return rows
    .filter((r) => (r as EbayRow)._isParent === true)
    .map((r) => ({
      id: String((r as EbayRow)._productId ?? (r as EbayRow).platformProductId ?? r._rowId),
      sku: String((r as EbayRow).sku ?? ''),
      variationTheme: (r as EbayRow).variation_theme
        ? String((r as EbayRow).variation_theme)
        : undefined,
    }))
}

// ── Validation ────────────────────────────────────────────────────────────

export { isSharedDuplicateAllowed } from './validateRows.shared'

export function validateRows(rows: BaseRow[], allRows: BaseRow[] = rows) {
  const issues: Array<{ level: 'error' | 'warn'; sku: string; field: string; msg: string }> = []

  // G.1 — parent/child integrity. Build the set of parent identifiers from the
  // WHOLE sheet (robust to either rowId- or productId-based variant linkage) and
  // a SKU frequency map for duplicate detection. eBay rejects duplicate SKUs and
  // orphaned variants, so catch them here instead of after a failed push.
  const parentIds = new Set<string>()
  const skuCount = new Map<string, number>()
  // G.2 — explicit parent SKU set: rows with parentage='parent'|'' or _isParent legacy flag.
  // Used by the orphan-child check below (P2.B2).
  const parentSkuSet = new Set<string>()
  for (const r of allRows) {
    const er = r as EbayRow & Record<string, unknown>
    if (er._isParent === true) {
      for (const k of [er._rowId, er._productId, er.platformProductId]) if (k) parentIds.add(String(k))
    }
    // Collect explicit parent SKUs (covers P2.B2 explicit-parentage rows and legacy _isParent rows).
    if (er.parentage === 'parent' || er.parentage === '' || er._isParent === true) {
      const ps = String(r.sku ?? '').trim()
      if (ps) parentSkuSet.add(ps)
    }
    const s = String(r.sku ?? '')
    if (s) skuCount.set(s, (skuCount.get(s) ?? 0) + 1)
  }

  for (const row of rows) {
    const er = row as EbayRow & Record<string, unknown>
    const sku = String(row.sku ?? '')
    if (!sku) { issues.push({ level: 'error', sku: '?', field: 'sku', msg: 'SKU is required' }); continue }
    if ((skuCount.get(sku) ?? 0) > 1 && !isSharedDuplicateAllowed(sku, allRows as EbayRow[])) issues.push({ level: 'error', sku, field: 'sku', msg: 'Duplicate SKU — each listing needs a unique SKU' })
    const title = String(row.title ?? '')
    if (!title) issues.push({ level: 'warn', sku, field: 'title', msg: 'Title is empty' })
    if (title.length > 80) issues.push({ level: 'error', sku, field: 'title', msg: `Title exceeds 80 chars (${title.length})` })

    if (er._isParent === true) {
      // A parent groups its variants by an axis — without a theme they won't group.
      if (!String(er.variation_theme ?? '').trim()) issues.push({ level: 'warn', sku, field: 'variation_theme', msg: "Parent has no variation theme (e.g. Color, Size) — variants won't group" })
    } else if (er._isParent === false) {
      // A variant must belong to a parent present in this sheet.
      const link = String(er.platformProductId ?? '')
      if (link && !parentIds.has(link)) issues.push({ level: 'error', sku, field: 'parent', msg: "Variant's parent isn't in this sheet — load the family before pushing" })
    }

    // G.2 — P2.B2 orphan-child: explicit child whose parent_sku matches no parent row's SKU in
    // this sheet. isSharedDuplicateAllowed guards the DUPLICATE-SKU path above; this check is
    // orthogonal (looking at the parent SKU, not the child's own SKU) so no skip needed there.
    if (er.parentage === 'child') {
      const pSku = String(er.parent_sku ?? '').trim()
      if (pSku && !parentSkuSet.has(pSku)) {
        issues.push({ level: 'warn', sku, field: 'parent_sku', msg: `Parent SKU '${pSku}' not found in this sheet` })
      }
    }
  }
  return issues
}

// ── Description modal ─────────────────────────────────────────────────────

function DescriptionModal({ value, onSave, onClose }: { value: string; onSave: (v: string) => void; onClose: () => void }) {
  const [text, setText] = useState(value)
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')
  const remaining = 4000 - text.length
  return (
    <Modal
      open
      onClose={onClose}
      title="Description Editor"
      subtitle={<span className={cn(remaining < 0 ? 'text-red-500 font-medium' : '')}>{remaining} chars remaining</span>}
      size="xl"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={() => { onSave(text); onClose() }}>Save</Button>
        </>
      }
    >
      {/* Tab switcher */}
      <div className="flex gap-1 mb-3 border-b border-slate-200 dark:border-slate-700 -mx-[18px] px-[18px]">
        {(['edit', 'preview'] as const).map((t) => (
          <button key={t} type="button"
            onClick={() => setTab(t)}
            className={cn('px-3 py-1.5 text-xs font-medium capitalize rounded-t transition-colors',
              tab === t
                ? 'text-blue-700 dark:text-blue-300 border-b-2 border-blue-500'
                : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
            )}
          >{t}</button>
        ))}
      </div>
      {tab === 'edit' ? (
        <>
          <textarea
            className="w-full min-h-[380px] border border-slate-300 dark:border-slate-600 rounded-lg p-3 text-xs font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-slate-800 dark:text-slate-100"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Enter HTML description…"
          />
          <p className="mt-2 text-xs text-slate-400">HTML is supported: &lt;p&gt;, &lt;ul&gt;, &lt;li&gt;, &lt;br&gt;…</p>
        </>
      ) : (
        <div
          className="min-h-[380px] border border-slate-200 dark:border-slate-700 rounded-lg p-4 prose prose-sm dark:prose-invert max-w-none text-sm overflow-y-auto"
          // This is operator-entered content previewed in their own admin UI — no external source
          dangerouslySetInnerHTML={{ __html: text || '<p class="text-slate-400 italic">No content yet…</p>' }}
        />
      )}
    </Modal>
  )
}

// ── Category search panel ─────────────────────────────────────────────────

function CategorySearchPanel({ marketplace, onSelect, onClose }: {
  marketplace: string; onSelect: (id: string, name: string) => void; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<CategoryResult[]>([])
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 0) }, [])

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return }
    const t = setTimeout(async () => {
      setLoading(true)
      try {
        const mpId = marketplace.startsWith('EBAY_') ? marketplace : `EBAY_${marketplace}`
        const res = await fetch(`${getBackendUrl()}/api/ebay/flat-file/category-search?q=${encodeURIComponent(query)}&marketplace=${mpId}`)
        if (res.ok) setResults((await res.json() as { categories: CategoryResult[] }).categories)
      } catch { setResults([]) }
      finally { setLoading(false) }
    }, 300)
    return () => clearTimeout(t)
  }, [query, marketplace])

  return (
    <Modal open onClose={onClose} title="Search eBay Categories" size="md">
      <div className="flex items-center gap-2 border border-slate-200 dark:border-slate-700 rounded-lg px-3 py-2 mb-3">
        <Search className="w-4 h-4 text-slate-400 shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search eBay categories…"
          className="flex-1 text-sm bg-transparent outline-none text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
        />
        {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 shrink-0" />}
      </div>

      {loading && !results.length && (
        <div className="space-y-2">
          <Skeleton height={40} radius={6} />
          <Skeleton height={40} radius={6} />
          <Skeleton height={40} radius={6} />
        </div>
      )}

      {!loading && results.length > 0 && (
        <ul className="max-h-72 overflow-y-auto rounded-lg border border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
          {results.map((cat) => (
            <li key={cat.id}>
              <button type="button" onClick={() => { onSelect(cat.id, cat.name); onClose() }}
                className="w-full text-left px-3 py-2.5 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors">
                <div className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{cat.path}</div>
                <div className="text-[10px] text-slate-400 font-mono mt-0.5">ID: {cat.id}</div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!loading && query.trim().length >= 2 && !results.length && (
        <div className="text-xs text-slate-400 text-center py-6">No categories found. Try a different term.</div>
      )}
      {query.trim().length < 2 && (
        <div className="text-xs text-slate-400 text-center py-6">Type at least 2 characters to search…</div>
      )}
    </Modal>
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

function PublishPanel({ selectedCount, publishTargets, onChangeTargets, onPublish, pushing, onQuickUpdate, quickUpdating, onClose }: {
  selectedCount: number; publishTargets: string[]; onChangeTargets: (t: string[]) => void
  onPublish: () => void; pushing: boolean
  onQuickUpdate: () => void; quickUpdating: boolean
  onClose: () => void
}) {
  const busy = pushing || quickUpdating
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
      <Button size="sm" className="w-full" disabled={!publishTargets.length || busy} loading={pushing} onClick={onPublish}>
        <Send className="w-3.5 h-3.5 mr-1.5" />Full Publish{publishTargets.length > 0 ? ` → ${publishTargets.join(', ')}` : ''}
      </Button>
      <div className="border-t border-slate-200 dark:border-slate-700 pt-2 space-y-1.5">
        <p className="text-[10px] text-slate-400">Price &amp; quantity only — goes live instantly, no re-publish</p>
        <Button size="sm" variant="ghost" className="w-full" disabled={!publishTargets.length || busy} loading={quickUpdating} onClick={onQuickUpdate}>
          <Zap className="w-3.5 h-3.5 mr-1.5" />Quick Update
        </Button>
      </div>
    </div>
  )
}

// Module-level SWR cache — persists across navigations (Amazon→eBay→Amazon→eBay is instant
// on the second eBay visit because the cache survives the route change).
const _ebay_swr = new Map<string, { rows: EbayRow[], fetchedAt: number }>()
const EBAY_SWR_TTL_MS = 5 * 60 * 1000

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
  'shared_sku_listing',
])

// ── Row completeness ─────────────────────────────────────────────────────────

function computeRowCompleteness(
  row: BaseRow,
  groups: Array<{ columns: Array<{ id: string; label: string; required?: boolean; readOnly?: boolean; applicableCategories?: string[]; requiredForCategories?: string[] }> }>,
): { filled: number; total: number; missing: Array<{ id: string; label: string }> } {
  const er = row as EbayRow
  const isVariant = er._isParent === false
  const isParent  = er._isParent === true
  // EFX P4 — category-aware requiredness: an aspect column only counts as
  // required for THIS row when the row's category is one that requires it.
  const rowCat = String(er.category_id ?? '').trim()
  const missing: Array<{ id: string; label: string }> = []
  let total = 0, filled = 0
  for (const group of groups) {
    for (const col of group.columns) {
      if (col.readOnly) continue
      if (col.id.startsWith('aspect_')) {
        // Not part of this row's category at all → never counted.
        if (col.applicableCategories?.length && rowCat && !col.applicableCategories.includes(rowCat)) continue
        // Category tags present → required only for the categories that require it;
        // tags absent (static/ghost column, or row without a category) → col.required.
        const isReq = col.requiredForCategories?.length && rowCat
          ? col.requiredForCategories.includes(rowCat)
          : col.required
        if (!isReq) continue
      } else if (!col.required) continue
      if (isParent && (PARENT_NOT_NEEDED.has(col.id) || /^(it|de|fr|es|uk)_(price|qty)$/.test(col.id))) continue
      if (isVariant && VARIANT_NOT_NEEDED.has(col.id)) continue
      total++
      const val = (row as any)[col.id]
      const isEmpty = val === null || val === undefined || val === ''
      if (!isEmpty) filled++
      else missing.push({ id: col.id, label: col.label.replace(/[\s*○↕⚠]+$/, '').trim() })
    }
  }
  return { filled, total, missing }
}

// ── EFX P4 — helpers for multi-category schema + market-data dots ──────────

/** Distinct non-empty category IDs across the sheet (drafts included when the
 *  caller passes merged rows). */
function collectCategoryIds(rows: Array<Record<string, unknown>>): string[] {
  return [...new Set(rows.map((r) => String(r.category_id ?? '').trim()).filter(Boolean))]
}

/** Markets whose rows carry any data ({mp}_price / {mp}_qty / {mp}_item_id
 *  non-empty). Returns a stable sorted signature like "DE,IT". */
function computeMarketDataSignature(rows: Array<Record<string, unknown>>): string {
  const found = new Set<string>()
  for (const row of rows) {
    for (const mp of EBAY_MARKETPLACES) {
      if (found.has(mp)) continue
      const p = mp.toLowerCase()
      for (const suffix of ['price', 'qty', 'item_id']) {
        const v = row[`${p}_${suffix}`]
        if (v !== null && v !== undefined && v !== '') { found.add(mp); break }
      }
    }
    if (found.size === EBAY_MARKETPLACES.length) break
  }
  return [...found].sort().join(',')
}

// ── P2.D2 — Delete intent derivation + confirm modal ──────────────────────

type DeleteIntent = 'delete-product' | 'delete-family' | 'remove-listing' | 'remove-channel-listing'

/** Determine the delete intent for a given row given the full sheet context. */
function deriveDeleteIntent(row: EbayRow, _allRows: EbayRow[]): DeleteIntent {
  // Synthesized shared-membership rows → remove just that membership.
  if (row._shared === true) return 'remove-listing'
  // All other rows → remove ONLY this channel+market's listing (Product untouched).
  return 'remove-channel-listing'
}

/** Count direct children in the sheet for a parent row. */
function countFamilyChildren(row: EbayRow, allRows: EbayRow[]): number {
  const ownSku = String(row.sku ?? '').trim()
  const parentId = String(row._productId ?? row.platformProductId ?? '')
  return allRows.filter((r) => {
    if (r._rowId === row._rowId) return false
    if (r._isParent === false && parentId && String(r.platformProductId ?? '') === parentId) return true
    if (r.parentage === 'child' && ownSku && String(r.parent_sku ?? '').trim() === ownSku) return true
    return false
  }).length
}

/** Get the most relevant eBay item ID for the row given the active marketplace. */
function getRowItemId(row: EbayRow, marketplace: string): string | undefined {
  const mkt = marketplace.toLowerCase()
  const mktId = (row as any)[`${mkt}_item_id`] as string | null | undefined
  return (mktId ?? row.ebay_item_id) || undefined
}

function EbayDeleteConfirmModal({
  rows,
  allRows,
  marketplace,
  loading,
  onConfirm,
  onClose,
}: {
  rows: EbayRow[]
  allRows: EbayRow[]
  marketplace: string
  loading: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const isSingle = rows.length === 1
  const intents = rows.map((r) => deriveDeleteIntent(r, allRows))
  const familyCount  = intents.filter((i) => i === 'delete-family').length
  const variantCount = intents.filter((i) => i === 'delete-product').length
  const listingCount = intents.filter((i) => i === 'remove-listing').length
  const channelCount = intents.filter((i) => i === 'remove-channel-listing').length

  const isAllScopedRemoval = channelCount === intents.length

  let mainText: string
  let actionLabel: string

  if (isSingle) {
    const row = rows[0]
    const sku    = String(row.sku ?? '')
    const intent = intents[0]
    if (intent === 'remove-channel-listing') {
      const n = countFamilyChildren(row, allRows)
      mainText    = n > 0
        ? `Remove "${sku}" and its ${n} variant${n !== 1 ? 's' : ''} from eBay ${marketplace}? The product and its stock stay in Nexus, and other channels are untouched.`
        : `Remove "${sku}" from eBay ${marketplace}? The product and its stock stay in Nexus, and other channels are untouched.`
      actionLabel = 'Remove from eBay'
    } else if (intent === 'delete-family') {
      const n = countFamilyChildren(row, allRows)
      mainText    = `Delete family "${sku}" and its ${n} variant${n !== 1 ? 's' : ''}? This is recoverable (soft-delete).`
      actionLabel = 'Delete Family'
    } else if (intent === 'delete-product') {
      mainText    = `Delete variant "${sku}"? Recoverable.`
      actionLabel = 'Delete Variant'
    } else {
      mainText    = `Remove "${sku}" from this listing? It stays live on its other listings.`
      actionLabel = 'Remove from Listing'
    }
  } else {
    const parts: string[] = []
    if (channelCount)  parts.push(`${channelCount} listing${channelCount > 1 ? 's' : ''}`)
    if (familyCount)   parts.push(`${familyCount} famil${familyCount  > 1 ? 'ies' : 'y'}`)
    if (variantCount)  parts.push(`${variantCount} variant${variantCount > 1 ? 's' : ''}`)
    if (listingCount)  parts.push(`${listingCount} shared listing${listingCount > 1 ? 's' : ''}`)
    mainText    = channelCount > 0
      ? `Remove ${parts.join(', ')} from eBay ${marketplace}? The product and stock stay in Nexus, and other channels are untouched.`
      : `Delete ${parts.join(', ')}? Soft-delete — recoverable.`
    actionLabel = channelCount > 0 ? `Remove ${rows.length} from eBay` : `Delete ${rows.length} Items`
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isAllScopedRemoval ? `Remove from eBay ${marketplace}` : 'Confirm delete'}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button size="sm" variant="danger" onClick={onConfirm} loading={loading}>
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
            {actionLabel}
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-700 dark:text-slate-300 mb-3">{mainText}</p>
      <Banner variant="warning">
        {isAllScopedRemoval
          ? `This removes the eBay ${marketplace} listing from Nexus. The product and its stock remain — only this channel’s listing is affected. If eBay can’t be reached the listing stays live — end it manually in Seller Hub.`
          : `This permanently ends the live eBay listing and removes it from Nexus (Nexus record is recoverable; the eBay listing is not). If eBay can’t be reached it stays live — end it manually in Seller Hub.`
        }
      </Banner>
    </Modal>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

export default function EbayFlatFileClient({ initialRows, initialMarketplace, familyId }: Props) {
  const { toast } = useToast()
  const confirm = useConfirm() // FM Phase 3 — bulk Follow/Pinned confirmation
  const [bufferModal, setBufferModal] = useState<{ productIds: string[] } | null>(null) // FM Phase 4 bulk buffer
  const [bufferInput, setBufferInput] = useState('1')
  const [marketplace, setMarketplace] = useState(initialMarketplace.toUpperCase())
  const BACKEND = getBackendUrl()

  // ── eBay-specific UI state ─────────────────────────────────────────────
  const [pushing, setPushing]                 = useState(false)
  const [quickUpdating, setQuickUpdating]     = useState(false)
  // P2.D2 — delete confirm state
  const [deleteConfirmRows, setDeleteConfirmRows] = useState<EbayRow[] | null>(null)
  const [deleteLoading, setDeleteLoading]         = useState(false)
  const [feedStatus, setFeedStatus]           = useState<FeedStatus | null>(null)
  const [publishPanelOpen, setPublishPanelOpen] = useState(false)
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false)
  // historyRefreshKey still incremented after each push (harmless; HistoryModal fetches live on open)
  const [, setHistoryRefreshKey] = useState(0)
  const [imageModalOpen, setImageModalOpen] = useState(false)
  // P1-surface: rows that failed to persist on save — re-injected after reload so they don't vanish
  const [savedErrorRows, setSavedErrorRows] = useState<EbayRow[]>([])
  // Refs so fileMenuItems callbacks can access latest FlatFileGrid ctx without stale closures
  const latestRowsRef = useRef<BaseRow[]>([])
  const latestSelectedRowsRef = useRef<Set<string>>(new Set())
  const latestSetRowsRef = useRef<((rows: BaseRow[]) => void) | null>(null)
  const latestPushHistoryRef = useRef<((rows: BaseRow[]) => void) | null>(null)
  const [publishTargets, setPublishTargets]   = useState<string[]>([marketplace])
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
  // pullHistoryOpen removed — merged into historyPanelOpen (HistoryModal H.1–H.4)
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

  // Task 4 — scoped view: show only eBay-listed SKUs by default (persisted)
  const [scope, setScope] = useState<'listed' | 'all'>(() => {
    if (typeof window === 'undefined') return 'listed'
    return (window.localStorage.getItem('ebay-ff-scope') as 'listed' | 'all') || 'listed'
  })
  const scopeRef = useRef(scope)
  const isFirstScopeEffect = useRef(true)
  const marketplaceRef = useRef(marketplace)
  const isFirstMarketEffect = useRef(true)
  // Captures ctx.onReload from renderToolbarImport so the scope-change effect
  // can call the SAME reload the toolbar's Reload button uses.
  const onReloadCtxRef = useRef<(() => void) | null>(null)

  const [addListingOpen, setAddListingOpen] = useState(false)
  const [moveParentOpen, setMoveParentOpen] = useState(false)
  const [moveTargetId, setMoveTargetId] = useState('')
  const [detachOpen, setDetachOpen] = useState(false)
  const [importWizardOpen, setImportWizardOpen] = useState(false)
  const [importInitialFile, setImportInitialFile] = useState<File | null>(null)
  const [aspectsPanelRowId, setAspectsPanelRowId] = useState<string | null>(null)
  const [incompleteBefore, setIncompleteBefore] = useState<Array<{ sku: string; count: number }>>([])
  const [blockingErrors, setBlockingErrors] = useState<Array<{ level: 'error' | 'warn'; sku: string; field: string; msg: string }>>([])
  // S2 — warn-only pre-publish gate. When a push has theme/aspect issues we stash
  // the prepared push here and show the modal; "Publish anyway" resumes it.
  const [prePublishGate, setPrePublishGate] = useState<{
    issues: PrePublishIssue[]
    sendRows: BaseRow[]
    skippedByAction: number
  } | null>(null)
  const [valueOrderOpen, setValueOrderOpen] = useState(false)

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
  // EFX P4 — per-category groups are cached individually and merged into ONE
  // union Item Specifics group (never all-or-nothing: one category failing to
  // load must not drop another category's columns).
  const [categoryColumnsCache, setCategoryColumnsCache] = useState<Map<string, EbayColumnGroup>>(new Map())
  // Distinct category IDs currently present on the sheet's rows.
  const [activeCategoryIds, setActiveCategoryIds] = useState<string[]>([])
  // FF-EN.2 — allowed conditions, unioned across every loaded category
  const [conditionOptions, setConditionOptions] = useState<Array<{ value: string; label: string }>>([])
  const conditionsCacheRef = useRef<Map<string, Array<{ value: string; label: string }>>>(new Map())
  // FF-EN.3 — variant-eligible axis names, unioned across every loaded category
  // (for the Variation Theme multi-picker). English name preferred to match the
  // canonical "Size,Color" theme convention.
  const [variantAxisNames, setVariantAxisNames] = useState<string[]>([])
  const variantAxisCacheRef = useRef<Map<string, string[]>>(new Map())
  const [categoryLoading, setCategoryLoading] = useState(false)
  // EFX P4 — per-category load failures (categoryId → message); the banner
  // names ONLY the failed categories, the rest keep rendering.
  const [categorySchemaErrors, setCategorySchemaErrors] = useState<Record<string, string>>({})
  // EFX P4.5 — categories served from the durable stored copy (eBay unreachable).
  const staleCategoriesRef = useRef<Set<string>>(new Set())
  const [staleSchemaCategories, setStaleSchemaCategories] = useState<string[]>([])
  // EFX P4 — ghost columns: stable signature of the aspect_* key set present on
  // rows (recomputed only when the SET changes, never per keystroke) + the
  // markets whose rows carry data (drives the market-strip dots).
  const aspectSigRef = useRef<string>('')
  const [ghostAspectSig, setGhostAspectSig] = useState<string>('[]')
  const marketDataSigRef = useRef<string>('')
  const [marketsWithData, setMarketsWithData] = useState<string>('')

  // ── Business policies (fulfillment / payment / return) ─────────────────
  const [policyOptions, setPolicyOptions] = useState<{
    fulfillment: Array<{ id: string; name: string }>
    payment:     Array<{ id: string; name: string }>
    return:      Array<{ id: string; name: string }>
  }>({ fulfillment: [], payment: [], return: [] })

  const ebayKey = `${familyId ?? '__global__'}:${marketplace}`

  // ── FFP.1 — unsaved-edit draft layer (Amazon parity) ────────────────────
  // Dirty rows autosave to a per-market localStorage draft; a reload / tab
  // close / market switch never loses an edit. Restored once per mount (or
  // per market switch) by onReload; explicit Discard / Reload-from-server
  // skip the merge so they stay destructive-by-intent.
  const [draftNotice, setDraftNotice] = useState<{ count: number } | null>(null)
  const pendingDraftRestoreRef = useRef(true)
  const draftNoticeShownRef = useRef(false)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track whether we have rows ready to pass to FlatFileGrid. Starts false;
  // set to true once the SWR cache or client fetch resolves.
  const [rowsReady, setRowsReady] = useState(false)
  const [clientRows, setClientRows] = useState<EbayRow[]>([])

  // useLayoutEffect fires synchronously before the browser paints.
  // Cache hit → remounts FlatFileGrid with real rows in the same frame (invisible).
  // Cache miss → triggers a client-side fetch; shows skeleton until rows arrive.
  useLayoutEffect(() => {
    const snap = _ebay_swr.get(ebayKey)
    if (snap && Date.now() - snap.fetchedAt < EBAY_SWR_TTL_MS) {
      setClientRows(snap.rows)
      setRowsReady(true)
      return
    }
    // No cache or stale — fetch from the API
    const qs = new URLSearchParams()
    if (familyId) qs.set('familyId', familyId)
    qs.set('scope', scopeRef.current)
    qs.set('marketplace', marketplaceRef.current)
    fetch(`${BACKEND}/api/ebay/flat-file/rows?${qs}`)
      .then((r) => r.json())
      .then((json: { rows: EbayRow[] }) => {
        const rows = json.rows ?? []
        _ebay_swr.set(ebayKey, { rows, fetchedAt: Date.now() })
        setClientRows(rows)
      })
      .catch(() => { setClientRows([]) })
      .finally(() => setRowsReady(true))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Task 4 — sync scope ref + localStorage; reload when scope changes
  useEffect(() => {
    scopeRef.current = scope
    try { window.localStorage.setItem('ebay-ff-scope', scope) } catch {}
    if (isFirstScopeEffect.current) { isFirstScopeEffect.current = false; return }
    // Bust SWR cache so the next mount re-fetches with the new scope, then
    // trigger the grid's own reload (same path as the toolbar Reload button).
    _ebay_swr.delete(ebayKey)
    void onReloadCtxRef.current?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  // Per-market file — re-scope rows to the active market on switch. The SWR cache is
  // keyed per market (ebayKey includes marketplace), so a market we've already loaded
  // shows instantly from cache; a fresh one triggers the grid's reload to fetch only
  // that market's listed products. (Column swap is already handled by the MS-E memo.)
  useEffect(() => {
    const prevMarketplace = marketplaceRef.current
    marketplaceRef.current = marketplace
    if (isFirstMarketEffect.current) { isFirstMarketEffect.current = false; return }
    // FFP.1 — flush the OUTGOING market's unsaved edits to its draft BEFORE the
    // grid rows are replaced: a market switch must never silently drop edits.
    if (prevMarketplace !== marketplace) {
      writeDraft(draftKey(prevMarketplace, familyId), latestRowsRef.current)
    }
    const snap = _ebay_swr.get(ebayKey)
    if (snap && Date.now() - snap.fetchedAt < EBAY_SWR_TTL_MS) {
      // FFP.1 — merge the INCOMING market's draft over its cached server rows.
      const draft = readDraft(draftKey(marketplace, familyId))
      const merged = draft?.rows?.length ? mergeDraftRows(snap.rows, draft.rows).rows : snap.rows
      latestSetRowsRef.current?.(merged)
    } else {
      pendingDraftRestoreRef.current = true
      void onReloadCtxRef.current?.()
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketplace])

  // Fetch policies once on mount (non-blocking — column options update when done)
  useEffect(() => {
    fetch(`${BACKEND}/api/ebay/flat-file/policies?marketplace=${marketplace}`)
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (d) setPolicyOptions(d) })
      .catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketplace])

  // ── EFX P4 — union Item Specifics group + ghost columns ────────────────
  // The union merges EVERY loaded category's aspect columns (dedup by
  // lowercase id, required = any category requires, options unioned).
  const categoryUnionGroup = useMemo(() => {
    const entries = activeCategoryIds
      .filter((id) => categoryColumnsCache.has(id))
      .map((id) => ({ categoryId: id, group: categoryColumnsCache.get(id)! }))
    return entries.length ? mergeCategoryGroups(entries) : null
  }, [activeCategoryIds, categoryColumnsCache])

  // Ghost columns: aspect_* keys with row data that no loaded schema knows.
  // Keyed on the stable signature — recomputes when the key SET changes only.
  const ghostAspectColumns = useMemo(() => {
    let keys: string[] = []
    try { keys = JSON.parse(ghostAspectSig) as string[] } catch { keys = [] }
    return buildGhostAspectColumns(keys, categoryUnionGroup?.columns.map((c) => c.id) ?? [])
  }, [ghostAspectSig, categoryUnionGroup])

  // The rendered Item Specifics group: union + ghosts. Present whenever EITHER
  // is non-empty — dynamic eBay columns can never all vanish because one
  // category schema failed to load.
  const itemSpecificsGroup = useMemo((): EbayColumnGroup | null => {
    if (!categoryUnionGroup && ghostAspectColumns.length === 0) return null
    const base = categoryUnionGroup ?? { id: 'item-specifics', label: 'Item Specifics', color: 'teal', columns: [] as EbayColumn[] }
    return ghostAspectColumns.length ? { ...base, columns: [...base.columns, ...ghostAspectColumns] } : base
  }, [categoryUnionGroup, ghostAspectColumns])

  // EAC Layer A (task 4) — widen the Variation Theme combobox. The old options
  // were ONLY the variation-eligible schema aspects (Size/Colour/Scollatura), so
  // custom axes an operator legitimately uses (e.g. "Tipo di prodotto") weren't
  // discoverable even though enumMode:'open' let them be typed. Union the schema
  // axes with every axis OBSERVED on the loaded rows (aspect_* keys, already
  // client-side via ghostAspectSig), synonym-deduped. enumMode stays 'open'
  // below so free text is always still allowed.
  const variationThemeOptions = useMemo(() => {
    let observed: string[] = []
    try { observed = JSON.parse(ghostAspectSig) as string[] } catch { observed = [] }
    return unionThemeOptions(variantAxisNames, observed)
  }, [variantAxisNames, ghostAspectSig])

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
      (conditionOptions.length === 0 && variationThemeOptions.length === 0) ? groups : groups.map((g) => {
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
            if (col.id === 'variation_theme' && variationThemeOptions.length) {
              return {
                ...col,
                kind: 'enum' as const,
                // EAC — widest discoverable axis set (schema ∪ observed),
                // enumMode:'open' so custom/free-text axes still work.
                options: variationThemeOptions,
                enumMode: 'open' as const,
                multiValue: true,
              }
            }
            return col
          }),
        }
      })
    const patch = (groups: EbayColumnGroup[]) => patchListing(patchPolicies(groups))
    // MS-E — one market at a time: show only the active market's column group
    // (the other markets' data is still loaded, just hidden). Falls back to
    // all markets if the active one has no group (shouldn't happen).
    const activeMarketGroups = MARKET_COLUMN_GROUPS.filter((g) => g.id === `market-${marketplace}`)
    const marketGroups = activeMarketGroups.length ? activeMarketGroups : MARKET_COLUMN_GROUPS
    // EFX P4 — the Item Specifics group renders whenever the union OR the
    // ghost columns are non-empty (never the old all-or-nothing null branch
    // that made every dynamic column vanish on a single schema failure).
    if (!itemSpecificsGroup) return patch([...EBAY_FIXED_GROUPS, ...marketGroups])
    return [
      ...patch(EBAY_FIXED_GROUPS),
      itemSpecificsGroup,
      ...patch(marketGroups),
    ]
  }, [itemSpecificsGroup, policyOptions, conditionOptions, variationThemeOptions, marketplace])

  // ── Shared flat-file core (columns modal state, filter state) ─────────
  // initialGroups: the static base groups without category columns or policy
  // patches — the computed `columnGroups` useMemo is passed to FlatFileGrid
  // directly; core only manages visibility/reorder UX state on top of whatever
  // groups come in, so we start from the same base and sync on changes.
  const core = useFlatFileCore<EbayRow, EbayFilterDims>({
    storageKey: `ff-ebay-${marketplace}`,
    initialRows,
    makeBlankRow,
    initialFilter: EBAY_FILTER_DEFAULT,
    initialGroups: columnGroups,
  })
  const {
    columnsOpen, setColumnsOpen,
    closedGroups: coreClosedGroups, applyGroupSettings: coreApplyGroupSettings,
    columnGroups: coreColumnGroups, setColumnGroups: setCoreColumnGroups,
  } = core

  // Keep core column groups in sync when marketplace / policy / category changes
  useEffect(() => {
    setCoreColumnGroups(columnGroups)
  }, [columnGroups, setCoreColumnGroups])

  // ── Category schema loading ────────────────────────────────────────────
  // EFX P4 — loads ALL of the sheet's categories (union manifest). One failed
  // category never drops the others: fetches run via Promise.allSettled, each
  // failure is recorded per-category, and every fulfilled schema still lands.

  const loadCategorySchemas = useCallback(async (categoryIds: string[]) => {
    const ids = [...new Set(categoryIds.map((s) => String(s).trim()).filter(Boolean))]
    setActiveCategoryIds(ids)
    if (ids.length === 0) {
      setConditionOptions([]); setVariantAxisNames([]); setCategorySchemaErrors({}); setStaleSchemaCategories([])
      return
    }

    const toFetch = ids.filter((id) => !categoryColumnsCache.has(id))
    const failures: Record<string, string> = {}
    if (toFetch.length > 0) {
      setCategoryLoading(true)
      const mpId = marketplace.startsWith('EBAY_') ? marketplace : `EBAY_${marketplace}`
      const settled = await Promise.allSettled(toFetch.map(async (categoryId) => {
        const res = await fetch(`${BACKEND}/api/ebay/flat-file/category-schema?categoryId=${encodeURIComponent(categoryId)}&marketplace=${mpId}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json() as { aspects: CategoryAspect[]; conditions?: Array<{ value: string; label: string }>; staleSchema?: boolean }
        return { categoryId, json }
      }))
      const fetched: Array<{ categoryId: string; group: EbayColumnGroup }> = []
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i]
        if (r.status === 'rejected') {
          failures[toFetch[i]] = r.reason instanceof Error ? r.reason.message : String(r.reason)
          continue
        }
        const { categoryId, json } = r.value
        fetched.push({ categoryId, group: buildCategoryColumns(json.aspects ?? []) })
        conditionsCacheRef.current.set(categoryId, json.conditions ?? [])
        // S1 — variant-eligible axis names: carry the LOCALIZED name (the part
        // before the "(English)" gloss) so a new IT family defaults to
        // Colore/Taglia, not English Color/Size. The full "Name (English)" label
        // is still shown verbatim in UI lists; only the value we persist as the
        // axis/theme name is localized. Custom axes (no gloss) pass through.
        variantAxisCacheRef.current.set(categoryId, (json.aspects ?? [])
          .filter((a) => a.variantEligible)
          .map((a) => localizedAxisName(a.label)))
        // EFX P4.5 — schema served from the durable stored copy (eBay down).
        if (json.staleSchema) staleCategoriesRef.current.add(categoryId)
        else staleCategoriesRef.current.delete(categoryId)
      }
      if (fetched.length > 0) {
        setCategoryColumnsCache((prev) => {
          const next = new Map(prev)
          for (const f of fetched) next.set(f.categoryId, f.group)
          return next
        })
      }
      setCategoryLoading(false)
    }
    setCategorySchemaErrors(failures)
    setStaleSchemaCategories(ids.filter((id) => staleCategoriesRef.current.has(id)))

    // Union the per-category conditions + variant axes across ACTIVE categories.
    const condSeen = new Set<string>()
    const conds: Array<{ value: string; label: string }> = []
    const axisSeen = new Set<string>()
    const axes: string[] = []
    for (const id of ids) {
      for (const c of conditionsCacheRef.current.get(id) ?? []) {
        if (!condSeen.has(c.value)) { condSeen.add(c.value); conds.push(c) }
      }
      for (const a of variantAxisCacheRef.current.get(id) ?? []) {
        const k = a.toLowerCase()
        if (!axisSeen.has(k)) { axisSeen.add(k); axes.push(a) }
      }
    }
    setConditionOptions(conds)
    setVariantAxisNames(axes)
  }, [marketplace, categoryColumnsCache, BACKEND])

  // Auto-load every category schema once rows are ready, so the category-driven
  // columns (Variation Theme axis names, item-specifics aspects, narrowed
  // Condition) show immediately instead of only after a Category cell click.
  // EFX P4 — union across ALL distinct categories (was: first row's category wins).
  useEffect(() => {
    if (!rowsReady) return
    const source = clientRows.length ? clientRows : initialRows
    const ids = collectCategoryIds(source as Array<Record<string, unknown>>)
    if (ids.length) void loadCategorySchemas(ids)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowsReady])

  // ── API: reload ────────────────────────────────────────────────────────

  const onReload = useCallback(async (): Promise<BaseRow[]> => {
    const qs = new URLSearchParams()
    if (familyId) qs.set('familyId', familyId)
    qs.set('scope', scopeRef.current)
    qs.set('marketplace', marketplaceRef.current)
    const res = await fetch(`${BACKEND}/api/ebay/flat-file/rows?${qs}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json() as { rows: EbayRow[] }
    const serverRows = json.rows ?? []

    // P1-surface: re-inject rows that failed to persist on save and are still missing from the DB
    let rows = serverRows
    if (savedErrorRows.length > 0) {
      const serverSkus = new Set(serverRows.map((r) => r.sku))
      const stillMissing = savedErrorRows.filter((fr) => !serverSkus.has(fr.sku))
      if (stillMissing.length > 0) {
        rows = [...serverRows, ...stillMissing]
      }
    }

    _ebay_swr.set(ebayKey, { rows, fetchedAt: Date.now() })

    // FFP.1 — restore pending drafts exactly once per mount / market switch.
    // Explicit "Discard" / "Reload from server" leave the flag false, so those
    // stay destructive on purpose (and the autosave loop then clears the draft).
    if (pendingDraftRestoreRef.current) {
      pendingDraftRestoreRef.current = false
      const draft = readDraft(draftKey(marketplaceRef.current, familyId))
      if (draft?.rows?.length) {
        const { rows: merged, restored } = mergeDraftRows(rows, draft.rows)
        if (restored > 0) {
          if (!draftNoticeShownRef.current) {
            draftNoticeShownRef.current = true
            setDraftNotice({ count: restored })
          }
          // EFX P4 — re-derive category columns from the MERGED rows (drafts
          // included), all distinct categories, so saved Category IDs keep
          // their columns after an in-app reload.
          void loadCategorySchemas(collectCategoryIds(merged as Array<Record<string, unknown>>))
          return merged
        }
      }
    }
    // EFX P4 — union across every category on the reloaded rows (was: the
    // first row's category only).
    void loadCategorySchemas(collectCategoryIds(rows as Array<Record<string, unknown>>))
    return rows
  }, [familyId, BACKEND, ebayKey, savedErrorRows, loadCategorySchemas])

  // ── FFP.5 — real-time grid refresh ─────────────────────────────────────
  // Reload the MOUNTED grid (via the grid's own loadData handle) while
  // preserving any in-progress edits: the draft layer re-merges dirty rows
  // over the fresh server rows, so live itemId/status/qty land without
  // clobbering what the operator is typing.
  const reloadGridPreservingEdits = useCallback(() => {
    try { writeDraft(draftKey(marketplaceRef.current, familyId), latestRowsRef.current) } catch {}
    pendingDraftRestoreRef.current = true
    void onReloadCtxRef.current?.()
  }, [familyId])

  // FM Phase 3 — bulk Set Follow / Set Pinned on the selected eBay rows (active
  // market), via the pool-safe endpoint (never writes the warehouse pool). eBay is
  // always merchant-fulfilled, so there's no FBA skip. Confirms first because Follow
  // re-points quantity at the pool (can change the live eBay quantity).
  const bulkSetFollowEbay = useCallback(async (follow: boolean, ctxRows: EbayRow[], ctxSelectedRows: Set<string>) => {
    const mp = marketplaceRef.current
    const selected = ctxRows.filter((r) => ctxSelectedRows.has(r._rowId))
    const productIds = [...new Set(selected.map((r) => String(r._productId ?? '')).filter(Boolean))]
    if (productIds.length === 0) { toast.error('No listings selected.'); return }
    const verb = follow ? 'Follow' : 'Pinned'
    const ok = await confirm({
      title: `Set ${productIds.length} eBay listing${productIds.length === 1 ? '' : 's'} to ${verb}?`,
      description: follow
        ? `They will track your shared warehouse pool — each listing's live eBay quantity may change to match it, queuing up to ${productIds.length} quantity sync${productIds.length === 1 ? '' : 's'}.`
        : 'They will hold their current quantity and stop tracking the pool.',
      tone: 'warning',
      confirmLabel: `Set ${verb}`,
    })
    if (!ok) return
    try {
      const result = await applyBulkFollow({ productIds, channel: 'EBAY', markets: [mp], follow })
      const parts = [`${result.updated} → ${verb}`]
      if (result.unchanged) parts.push(`${result.unchanged} already ${follow ? 'following' : 'pinned'}`)
      toast.success(parts.join(' · '))
      reloadGridPreservingEdits()
    } catch (e) {
      toast.error(`Couldn't apply Follow/Pinned — ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [confirm, toast, reloadGridPreservingEdits])

  // FM Phase 4 — bulk "Set buffer" on the selected Following eBay rows (buffer only
  // applies while Following, so Pinned rows are excluded from the target set).
  const openEbayBufferModal = useCallback((ctxRows: EbayRow[], ctxSelectedRows: Set<string>) => {
    const followKey = `${marketplaceRef.current.toLowerCase()}_follow`
    const productIds = [...new Set(ctxRows
      .filter((r) => ctxSelectedRows.has(r._rowId) && (r as Record<string, unknown>)[followKey] === 'Follow')
      .map((r) => String(r._productId ?? '')).filter(Boolean))]
    if (productIds.length === 0) {
      toast.error('Select some Following listings — a buffer only applies while Following.')
      return
    }
    setBufferInput('1')
    setBufferModal({ productIds })
  }, [toast])

  const applyEbayBufferModal = useCallback(async () => {
    if (!bufferModal) return
    const mp = marketplaceRef.current
    const buffer = Math.max(0, Math.floor(Number(bufferInput) || 0))
    try {
      const res = await applyBulkBuffer({ productIds: bufferModal.productIds, channel: 'EBAY', markets: [mp], buffer })
      const parts = [`${res.updated} → buffer ${buffer}`]
      if (res.unchanged) parts.push(`${res.unchanged} already ${buffer}`)
      toast.success(parts.join(' · '))
      setBufferModal(null)
      reloadGridPreservingEdits()
    } catch (e) {
      toast.error(`Couldn't set buffer — ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [bufferModal, bufferInput, toast, reloadGridPreservingEdits])

  // Push status changed anywhere (this tab's push, another tab, or the feed
  // poll cron finishing a bulk task) → refresh itemIds/status live.
  useOrderEventsRefresh(() => { reloadGridPreservingEdits() }, {
    eventTypes: ['ebay_push.status_changed'],
    debounceMs: 1500,
  })

  // ── API: save ─────────────────────────────────────────────────────────

  const onSave = useCallback(async (dirty: BaseRow[]): Promise<{ saved: number; createResult?: { errors?: unknown[] } }> => {
    const res = await fetch(`${BACKEND}/api/ebay/flat-file/rows`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      // FFP.1 — marketplace scopes content fields + flatFileSnapshot to the
      // ACTIVE market's listing server-side (each market file is independent).
      body: JSON.stringify({ rows: dirty, marketplace: marketplaceRef.current }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // P1-surface: read the full response including createResult to detect rows that failed to persist
    const result = await res.json() as {
      saved: number
      createResult?: {
        idMap: Array<{ tempRowId?: string; sku: string; productId: string }>
        errors: Array<{ sku?: string; tempRowId?: string; reason: string }>
        warnings: Array<{ sku?: string; reason: string }>
        collapsedSkus?: string[]
      }
    }
    if (result.saved > 0) {
      emitInvalidation({ type: 'product.updated', meta: { source: 'ebay-flat-file' } })
      emitInvalidation({ type: 'stock.adjusted', meta: { source: 'ebay-flat-file' } })
    }

    const errors = result.createResult?.errors ?? []

    // FB2 — identify the dirty rows whose CONTENT save FAILED (by SKU or tempRowId),
    // so Follow/Buffer is NOT applied to them below. Built once here and reused by
    // both the error-banner block and the follow/buffer capture loops.
    const failedRowIds = new Set<string>()
    if (errors.length > 0) {
      for (const r of dirty) {
        const sku = String((r as EbayRow).sku ?? '')
        const hit = errors.find((e) => (e.sku && e.sku === sku) || (e.tempRowId && e.tempRowId === r._rowId))
        if (hit) failedRowIds.add(r._rowId)
      }
    }

    // FFP.1 — successful save clears the draft; failed rows stay in it so a
    // reload after a partial save still restores what didn't persist.
    if (errors.length === 0) {
      clearDraft(draftKey(marketplaceRef.current, familyId))
    }

    if (errors.length > 0) {
      // Map each failed dirty row to its error entry (by SKU or tempRowId)
      const failedRows: EbayRow[] = dirty.flatMap((r) => {
        const sku = String((r as EbayRow).sku ?? '')
        const errEntry = errors.find(
          (e) => (e.sku && e.sku === sku) || (e.tempRowId && e.tempRowId === r._rowId),
        )
        if (!errEntry) return []
        return [{ ...(r as EbayRow), _dirty: true, _status: 'error' as const, _feedMessage: errEntry.reason }]
      })

      // Store failed rows so onReload can re-inject them if user reloads the grid
      if (failedRows.length > 0) setSavedErrorRows(failedRows)
      // FFP.1 — keep only the failed rows in the draft (saved ones left it)
      writeDraft(draftKey(marketplaceRef.current, familyId), failedRows)

      // Re-mark failed rows in the grid AFTER the grid's own setRows(_dirty:false) call.
      // setTimeout(0) ensures we fire after saveDraft's synchronous state update.
      // (failedRowIds is computed once above and reused here.)
      const toastFn = toast
      const savedCount = result.saved
      const errorCount = errors.length
      const firstReason = errors[0]?.reason ?? 'Save error'
      const moreStr = errors.length > 1 ? ` (+${errors.length - 1} more)` : ''
      setTimeout(() => {
        // Re-apply error state to failed rows (grid cleared _dirty above).
        // latestSetRowsRef takes a concrete array; use latestRowsRef for current state.
        const setRowsFn = latestSetRowsRef.current
        if (setRowsFn && failedRowIds.size > 0) {
          const current = latestRowsRef.current
          const next = current.map((r) => {
            if (!failedRowIds.has(r._rowId)) return r
            const fr = failedRows.find((f) => f._rowId === r._rowId)
            return { ...r, _dirty: true, _status: 'error' as const, _feedMessage: fr?._feedMessage }
          })
          setRowsFn(next)
        }
        // Show combined info toast (grid's generic toast is suppressed when errors are present).
        toastFn({
          title: `Saved ${savedCount} · ${errorCount} couldn't save`,
          description: `${firstReason}${moreStr}`,
          tone: 'info',
        })
      }, 0)
    }

    // FB-S1 — Follow/Buffer intent that can't land (row not yet published, i.e. no
    // _productId): warn instead of silently dropping. FB-S1 also flags a matched:0
    // response for rows we DID send (product has no ChannelListing on this market yet).
    const unpublishedIntent = new Set<string>()
    let sentAnyApply = false
    let matchedTotal = 0
    // FB2/FB-S2 — a row is capturable only when its content save SUCCEEDED
    // (!failedRowIds), it's a real editable row (not a synthesized read-only /
    // shared-membership VIEW row), and it has a productId. Mirrors the push filter.
    const capturable = (r: BaseRow) => {
      const er = r as EbayRow
      return !failedRowIds.has(r._rowId) && !er._readonly && !er._shared
    }

    // FM Phase 2 — apply per-market Follow/Pinned through the dedicated endpoint
    // (pool-safe, FBA-skipping, and it no-op-skips anything unchanged so a routine
    // save fires no needless pushes). Runs AFTER the content save so a Pin
    // snapshots the just-saved quantity. Grouped by follow value; failures are
    // surfaced but never block the content save.
    try {
      const mp = marketplaceRef.current
      const followKey = `${mp.toLowerCase()}_follow`
      const byFollow = new Map<boolean, Set<string>>()
      for (const r of dirty) {
        if (!capturable(r)) continue
        const fv = (r as Record<string, unknown>)[followKey]
        if (fv !== 'Follow' && fv !== 'Pinned') continue
        const pid = String((r as EbayRow)._productId ?? '')
        if (!pid) { unpublishedIntent.add(r._rowId); continue }
        const follow = fv === 'Follow'
        if (!byFollow.has(follow)) byFollow.set(follow, new Set())
        byFollow.get(follow)!.add(pid)
      }
      let followChanged = 0
      for (const [follow, ids] of byFollow) {
        if (ids.size === 0) continue
        sentAnyApply = true
        const fr = await fetch(`${BACKEND}/api/listings/follow-master-quantity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productIds: [...ids], channel: 'EBAY', markets: [mp], follow }),
        })
        if (fr.ok) {
          const body = await fr.json().catch(() => ({}))
          followChanged += body?.updated ?? 0
          matchedTotal += body?.matched ?? 0
        } else throw new Error(`follow apply HTTP ${fr.status}`)
      }
      if (followChanged > 0) {
        toast({ title: `${followChanged} market listing${followChanged === 1 ? '' : 's'} updated (Follow/Pinned)`, tone: 'success' })
      }
    } catch (e) {
      toast({ title: 'Follow/Pinned change failed to apply', description: e instanceof Error ? e.message : String(e), tone: 'error' })
    }

    // FM Phase 4 — apply per-market Buffer changes (grouped by value) via the pool-safe
    // stock-buffer endpoint. Following markets republish pool−buffer; Pinned markets
    // just store it. Runs AFTER the follow-apply; the endpoint no-op-skips unchanged.
    try {
      const mp = marketplaceRef.current
      const bufferKey = `${mp.toLowerCase()}_buffer`
      const byBuffer = new Map<number, Set<string>>()
      for (const r of dirty) {
        if (!capturable(r)) continue
        const bv = (r as Record<string, unknown>)[bufferKey]
        if (bv === '' || bv == null) continue
        const n = Math.max(0, Math.floor(Number(bv)))
        if (!Number.isFinite(n)) continue
        const pid = String((r as EbayRow)._productId ?? '')
        if (!pid) { unpublishedIntent.add(r._rowId); continue }
        if (!byBuffer.has(n)) byBuffer.set(n, new Set())
        byBuffer.get(n)!.add(pid)
      }
      let bufferChanged = 0
      for (const [buf, ids] of byBuffer) {
        if (ids.size === 0) continue
        sentAnyApply = true
        const res = await applyBulkBuffer({ productIds: [...ids], channel: 'EBAY', markets: [mp], buffer: buf })
        bufferChanged += res.updated
        matchedTotal += res.matched ?? 0
      }
      if (bufferChanged > 0) {
        toast({ title: `${bufferChanged} market listing${bufferChanged === 1 ? '' : 's'} buffer updated`, tone: 'success' })
      }
    } catch (e) {
      toast({ title: 'Buffer change failed to apply', description: e instanceof Error ? e.message : String(e), tone: 'error' })
    }

    // FB-S1 — surface dropped Follow/Buffer intent instead of a silent no-op.
    if (unpublishedIntent.size > 0 || (sentAnyApply && matchedTotal === 0)) {
      const parts: string[] = []
      if (unpublishedIntent.size > 0) {
        const n = unpublishedIntent.size
        parts.push(`${n} unpublished row${n === 1 ? '' : 's'} — publish first, then set Follow/Buffer`)
      }
      if (sentAnyApply && matchedTotal === 0) {
        parts.push('no matching live listing yet for the rows you edited')
      }
      toast({ title: 'Follow/Buffer not applied', description: parts.join(' · '), tone: 'warning' })
    }

    return { saved: result.saved, createResult: result.createResult }
  }, [BACKEND, toast])

  // ── P2.D2 — API: delete rows ──────────────────────────────────────────

  const handleExecuteDelete = useCallback(async () => {
    if (!deleteConfirmRows || !deleteConfirmRows.length) return
    const allRows = latestRowsRef.current as EbayRow[]
    const targets = deleteConfirmRows.map((r) => ({
      productId: r._productId ? String(r._productId) : undefined,
      sku: String(r.sku ?? ''),
      marketplace,
      itemId: getRowItemId(r, marketplace),
      parentSku: r.parent_sku ?? undefined,
      intent: deriveDeleteIntent(r, allRows),
    }))
    setDeleteLoading(true)
    try {
      const res = await fetch(`${BACKEND}/api/ebay/flat-file/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as {
        results: Array<{ sku: string; intent: string; softDeleted: string[]; membershipsRemoved: number; channelListingsRemoved?: number; delisted: boolean; error?: string }>
      }

      // Collect every SKU that was successfully removed
      const removedSkus = new Set<string>()
      let warnCount = 0
      for (const r of json.results) {
        if (r.error) { warnCount++; continue }
        if (r.intent === 'remove-listing' && r.membershipsRemoved === 0) { warnCount++; continue }
        if (r.intent === 'remove-channel-listing' && (r.channelListingsRemoved ?? 0) === 0) { warnCount++; continue }
        removedSkus.add(r.sku)
        // For family deletes the backend soft-deletes all children too
        for (const s of (r.softDeleted ?? [])) removedSkus.add(s)
      }

      // Remove deleted rows from grid and update SWR cache
      const current = latestRowsRef.current as EbayRow[]
      const next = current.filter((r) => !removedSkus.has(String(r.sku ?? '')))
      _ebay_swr.set(ebayKey, { rows: next, fetchedAt: Date.now() })
      latestSetRowsRef.current?.(next)

      const succeeded = json.results.filter((r) => !r.error)
      const deleted = succeeded.length
      const delistedCount = succeeded.filter((r) => r.delisted).length
      const notDelistedCount = deleted - delistedCount
      const label = deleted !== 1 ? 'listings' : 'listing'
      if (notDelistedCount > 0) {
        toast({ title: `Removed ${deleted} ${label} from eBay ${marketplace} — couldn't end ${notDelistedCount} on eBay (end manually in Seller Hub). Product and stock kept.`, tone: 'info' })
      } else if (warnCount > 0) {
        toast({ title: `Removed ${deleted} ${label} from eBay ${marketplace} — product and stock kept.`, description: `${warnCount} row${warnCount !== 1 ? 's' : ''} had nothing to remove — check the grid.`, tone: 'info' })
      } else {
        toast.success(`Removed ${deleted} ${label} from eBay ${marketplace} — product and stock kept.`)
      }
      setDeleteConfirmRows(null)
    } catch (err) {
      toast.error('Delete failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setDeleteLoading(false)
    }
  }, [deleteConfirmRows, marketplace, BACKEND, ebayKey, toast])

  // ── API: push to eBay ─────────────────────────────────────────────────

  async function pushToEbay(rows: BaseRow[], selectedRows: Set<string>) {
    const toPush = (selectedRows.size > 0
      ? rows.filter((r) => selectedRows.has(r._rowId))
      : rows.filter((r) => r._dirty))
      // C2 — synthesized shared-membership rows are read-only VIEW rows; never a push
      // source (they'd create a phantom Inventory-API listing). Mirror the grid's edit block.
      .filter((r) => !(r as EbayRow)._readonly && !(r as EbayRow)._shared)
    if (!toPush.length) { toast({ title: 'Nothing to push', tone: 'info' }); return }

    // FFP.6 — Action column: 'skip' rows never leave the client; deactivate/end
    // rows go to the server but are exempt from publish validation (an 'end'
    // doesn't need a title).
    const actionOf = (r: BaseRow) => String((r as EbayRow).row_action ?? '').trim().toLowerCase()
    let sendRows = toPush.filter((r) => actionOf(r) !== 'skip')
    const skippedByAction = toPush.length - sendRows.length
    if (!sendRows.length) { toast({ title: 'All rows are set to skip — nothing to push', tone: 'info' }); return }
    const publishRows = sendRows.filter((r) => !['deactivate', 'end'].includes(actionOf(r)))

    // G.1 — structural errors (duplicate SKU, orphan variant, oversized title),
    // surfaced persistently rather than as a vanishing toast. FFP.6 — no longer
    // an unconditional wall: when every blocked row is UNPUBLISHED (not live on
    // this market and not a parent), the operator can push the rest without
    // them — the blocked rows simply stay untouched on eBay.
    const blocking = validateRows(publishRows, rows).filter((i) => i.level === 'error')
    if (blocking.length) {
      setBlockingErrors(blocking)
      setPublishPanelOpen(true)
      const blockedSkus = new Set(blocking.map((b) => b.sku))
      const mpKey = marketplace.toLowerCase()
      const isLiveHere = (r: BaseRow) =>
        Boolean(String((r as EbayRow)[`${mpKey}_item_id` as keyof EbayRow] ?? '').trim()) ||
        String((r as EbayRow)[`${mpKey}_status` as keyof EbayRow] ?? '').toUpperCase() === 'ACTIVE'
      const isBlocked = (r: BaseRow) => blockedSkus.has(String((r as EbayRow).sku ?? ''))
      const hardBlocked = publishRows.filter((r) => isBlocked(r) && ((r as EbayRow)._isParent === true || isLiveHere(r)))
      const rest = sendRows.filter((r) => !isBlocked(r))
      const excludableCount = publishRows.filter(isBlocked).length - hardBlocked.length
      if (hardBlocked.length > 0 || rest.length === 0 || excludableCount === 0) {
        toast.error(`${blocking.length} blocking issue${blocking.length > 1 ? 's' : ''} — fix before pushing`)
        return
      }
      if (!confirm(`${excludableCount} row(s) have blocking issues but aren't live on eBay ${marketplace} yet.\n\nPush the other ${rest.length} row(s) without them? The blocked rows stay untouched on eBay.`)) return
      sendRows = rest
    } else {
      setBlockingErrors([])
    }

    // EFF.3 — pre-push completeness check (warn, not block)
    const incomplete = sendRows.flatMap((r) => {
      const { missing } = computeRowCompleteness(r, columnGroups)
      return missing.length ? [{ sku: String((r as EbayRow).sku ?? ''), count: missing.length }] : []
    })
    setIncompleteBefore(incomplete)

    // S2 — warn-only pre-publish scan (NEVER blocks). Gather theme/aspect issues
    // BEFORE firing the push; if any exist, show the modal and pause. The
    // operator can always "Publish anyway". Best-effort — a failing scan never
    // stops a push.
    let issues: PrePublishIssue[] = []
    try {
      issues = await gatherPrePublishIssues(sendRows, rows)
    } catch { /* ignore — warn scan must never block the push */ }
    if (issues.length > 0) {
      setPrePublishGate({ issues, sendRows, skippedByAction })
      return
    }

    await executePush(rows, sendRows, skippedByAction)
  }

  /**
   * S2 — gather warn-only pre-publish issues for the rows about to be pushed:
   *   • client conflict scan — synonym-equivalent aspect_* keys with differing
   *     values on one variant (e.g. Color=Red vs Colore=Rosso);
   *   • Layer A resolvedAxisWarnings + resolvedAxisSuppressed for each REAL
   *     parent family in the push (new families have no DB id → skipped; the
   *     conflict scan still covers them).
   * Never throws to the caller in a way that stops the push (caller wraps it).
   */
  async function gatherPrePublishIssues(sendRows: BaseRow[], allRows: BaseRow[]): Promise<PrePublishIssue[]> {
    const variantRows = sendRows.filter((r) => (r as EbayRow)._isParent !== true)
    const conflicts = scanAspectConflicts(variantRows as Array<Record<string, unknown>>)

    // Real DB parent product ids present in this push.
    const rowById = new Map(allRows.map((r) => [r._rowId, r as EbayRow]))
    const parentIds = new Set<string>()
    for (const r of sendRows) {
      const er = r as EbayRow
      if (er._isParent === true && er._productId) {
        parentIds.add(String(er._productId))
      } else if (er.platformProductId) {
        const parent = rowById.get(String(er.platformProductId))
        if (parent?._productId) parentIds.add(String(parent._productId))
      }
    }

    const axisWarnings: string[] = []
    const suppressed: string[] = []
    await Promise.allSettled([...parentIds].map(async (pid) => {
      const res = await fetch(`${BACKEND}/api/ebay/cockpit/variation-cells?parentProductId=${encodeURIComponent(pid)}&marketplace=${encodeURIComponent(marketplace)}`)
      if (!res.ok) return
      const d = await res.json() as { resolvedAxisWarnings?: string[]; resolvedAxisSuppressed?: string[] }
      if (Array.isArray(d.resolvedAxisWarnings)) axisWarnings.push(...d.resolvedAxisWarnings)
      if (Array.isArray(d.resolvedAxisSuppressed)) suppressed.push(...d.resolvedAxisSuppressed)
    }))

    return buildPrePublishIssues({ conflicts, axisWarnings, suppressed })
  }

  /** S2 — the actual push request. Extracted from pushToEbay so the warn gate
   *  can resume it unchanged when the operator clicks "Publish anyway". */
  async function executePush(rows: BaseRow[], sendRows: BaseRow[], skippedByAction: number) {
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
        body: JSON.stringify({ rows: sendRows, markets: publishTargets }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { results?: PushResult[]; taskId?: string; axisWarnings?: string[] }
      if (skippedByAction > 0) {
        toast({ title: `${skippedByAction} row${skippedByAction !== 1 ? 's' : ''} skipped (Action = skip)`, tone: 'info' })
      }
      // A push just landed — refresh the durable history, and auto-open it on
      // errors so the operator sees the full per-SKU result, not a vanishing toast.
      setHistoryRefreshKey((k) => k + 1)
      if (json.taskId) {
        setFeedStatus({ taskId: json.taskId, status: 'IN_PROGRESS' })
        toast({ title: `Feed job started: ${json.taskId}`, tone: 'info' })
      } else if (json.results) {
        const errors = json.results.filter((r) => r.status === 'ERROR')
        if (errors.length) {
          const first = errors[0]
          const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : ''
          toast.error(`${first.sku}: ${first.message}${more}`)
          setHistoryPanelOpen(true)
        } else {
          toast.success(`Pushed ${json.results.length} rows`)
        }
        // FFP.5 — refresh the MOUNTED grid (old onReload only warmed the SWR
        // cache; the new Item ID / status columns never appeared until a manual
        // reload). Edits in progress survive via the draft merge.
        reloadGridPreservingEdits()
      }
      // EFX D7 — surface the push's variation-axis warnings (undeclared varying
      // axis / declared axis missing or single-valued). Non-blocking, additive:
      // never alters the push flow. Deduped; if more than 3, show first 3 + more.
      if (json.axisWarnings?.length) {
        const uniq = [...new Set(json.axisWarnings.filter(Boolean))]
        if (uniq.length) {
          const shown = uniq.slice(0, 3)
          const extra = uniq.length > 3 ? `\n…and ${uniq.length - 3} more` : ''
          toast({ title: 'Variation axis warnings', description: shown.join('\n') + extra, tone: 'warning' })
        }
      }
    } catch (err) {
      toast.error('Push failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setPushing(false)
      setPublishPanelOpen(false)
    }
  }

  async function quickUpdateToEbay(rows: BaseRow[], selectedRows: Set<string>) {
    const toPush = (selectedRows.size > 0
      ? rows.filter((r) => selectedRows.has(r._rowId))
      : rows.filter((r) => r._dirty))
      // C2 — exclude synthesized shared-membership VIEW rows from offer-only updates too.
      .filter((r) => !(r as EbayRow)._readonly && !(r as EbayRow)._shared)
    if (!toPush.length) { toast({ title: 'Nothing to update', tone: 'info' }); return }
    const dirty = rows.filter((r) => r._dirty)
    if (dirty.length > 0) {
      try { await onSave(dirty) } catch (err) {
        toast.error('Save failed before update: ' + (err instanceof Error ? err.message : String(err)))
        return
      }
    }
    setQuickUpdating(true)
    try {
      const res = await fetch(`${BACKEND}/api/ebay/flat-file/push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: toPush, markets: publishTargets, strategy: 'offers-only' }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { results?: PushResult[] }
      setHistoryRefreshKey((k) => k + 1)
      if (json.results) {
        const errors = json.results.filter((r) => r.status === 'ERROR')
        if (errors.length) {
          const first = errors[0]
          const more = errors.length > 1 ? ` (+${errors.length - 1} more)` : ''
          toast.error(`${first.sku}: ${first.message}${more}`)
          setHistoryPanelOpen(true)
        } else {
          toast.success(`Updated ${json.results.length} offer${json.results.length !== 1 ? 's' : ''} — live on eBay`)
        }
        // FFP.5 — refresh the mounted grid (see pushToEbay note).
        reloadGridPreservingEdits()
      }
    } catch (err) {
      toast.error('Quick update failed: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setQuickUpdating(false)
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
    setRows: (rows: BaseRow[]) => void
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

  // ── onCellChange: trigger category schema load ─────────────────────────
  // EFX P4 — recompute the FULL category list (union), replacing the old
  // last-edit-wins single-category load. The grid's rows state may not yet
  // include this edit, so exclude the edited row's old value and add the new.

  const onCellChange = useCallback((rowId: string, colId: string, value: unknown) => {
    if (colId === 'category_id' && typeof value === 'string') {
      const others = (latestRowsRef.current as Array<Record<string, unknown>>)
        .filter((r) => r._rowId !== rowId)
      const ids = collectCategoryIds(others)
      const v = value.trim()
      if (v) ids.push(v)
      void loadCategorySchemas(ids)
    }
  }, [loadCategorySchemas])

  // ── Market link URLs ───────────────────────────────────────────────────
  const MARKET_URLS: Record<string, string> = {
    IT: 'https://www.ebay.it/itm/', DE: 'https://www.ebay.de/itm/',
    FR: 'https://www.ebay.fr/itm/', ES: 'https://www.ebay.es/itm/',
    UK: 'https://www.ebay.co.uk/itm/',
  }

  // EFX P6 — SSR-snapshot family derivation is kept ONLY as the toolbar
  // button's visibility gate (cheap, stable). The drawer itself snapshots the
  // grid's CURRENT rows at open time (openImageDrawer below) so families
  // added/removed after page load — imports, re-parenting, Add listing —
  // are covered.
  const hasImageFamilies = useMemo(
    () => deriveImageFamilies(initialRows as FamilyDeriveRow[], familyId).length > 0,
    [familyId, initialRows],
  )
  const [imageDrawerFamilies, setImageDrawerFamilies] = useState<ImageFamilySummary[]>([])
  const openImageDrawer = useCallback(() => {
    const live = latestRowsRef.current
    const rows = (live.length > 0 ? live : initialRows) as FamilyDeriveRow[]
    setImageDrawerFamilies(deriveImageFamilies(rows, familyId))
    setImageModalOpen(true)
  }, [familyId, initialRows])

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
    // UFX P5 — ghost canvas rows (trailing blank rows, UFX P2d) render plain
    // default (empty) cells: no red 0/N completeness chip, no Parent/Variant
    // badges, no '—' / 'Click to search…' placeholders. The blank canvas
    // looks blank until the first real edit materializes the row.
    if (_row._ghost === true) return null
    // FFP.1 — typed price is authoritative; when the live DB price diverges
    // (repricer/external) the row carries `_live_price_{mp}` and we show a
    // subtle amber dot with the live value in the tooltip.
    if (/^(it|de|fr|es|uk)_price$/.test(col.id)) {
      const mp = col.id.split('_')[0]
      const live = (_row as Record<string, unknown>)[`_live_price_${mp}`]
      if (live != null && displayVal != null && displayVal !== '') {
        return (
          <span className="inline-flex items-center gap-1 min-w-0">
            <span className="truncate">{displayVal}</span>
            <span
              title={`Live ${mp.toUpperCase()} price is €${live} (repricer/external). Your value is shown — it's what gets saved and pushed.`}
              className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"
            />
          </span>
        )
      }
      return undefined
    }
    // SKU — parent / variant cue + completeness chip
    if (col.id === 'sku') {
      const er = _row as EbayRow
      const isVariant = er._isParent === false
      const isParent = er._isParent === true && familyParentIds.has(String(er.platformProductId ?? ''))
      const { filled, total } = computeRowCompleteness(_row, columnGroups)
      const complete = total > 0 && filled === total
      const partial  = total > 0 && filled > 0 && filled < total
      const empty    = total > 0 && filled === 0
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
          {/* Task 5 (shared-mgmt) — synthesized membership row badge */}
          {er._shared && (
            <Badge variant="default" size="sm" className="shrink-0 uppercase tracking-wide text-[9px]">Shared</Badge>
          )}
          {total > 0 && (
            <span className={cn('ml-auto shrink-0 font-mono text-[9px] rounded px-1 py-0.5 tabular-nums',
              complete ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
              : partial  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
              : empty    ? 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-400'
              : ''
            )} title={`${filled}/${total} required fields filled`}>
              {filled}/{total}
            </span>
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
    // Category ID — single-click opens search panel
    if (col.id === 'category_id') {
      const openSearch = (e: React.MouseEvent) => {
        e.stopPropagation()
        setCategorySearchRowId(_row._rowId)
        setCategorySearchOpen(true)
      }
      if (categoryLoading && displayVal) {
        return (
          <button type="button" className="flex items-center gap-1 text-[10px] w-full text-left" onClick={openSearch}>
            <Loader2 className="w-3 h-3 animate-spin shrink-0 text-slate-400" />
            <span className="font-mono text-slate-500 dark:text-slate-400">{displayVal}</span>
          </button>
        )
      }
      return (
        <button type="button" className="flex items-center w-full h-full text-left" onClick={openSearch}>
          {displayVal
            ? <span className="font-mono text-[10px] text-blue-700 dark:text-blue-300">{displayVal}</span>
            : <span className="text-slate-300 text-[10px]">Click to search categories…</span>}
        </button>
      )
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
  }, [familyParentIds, categoryLoading, columnGroups])

  // ── Edit intercept for modal-based editing ─────────────────────────────
  const onBeforeEditCell = useCallback((col: FlatFileColumn, row: BaseRow): boolean => {
    // Task 5 (shared-mgmt) — synthesized shared membership rows are fully read-only.
    if ((row as EbayRow)._readonly === true) return true
    if (col.kind === 'longtext') {
      setDescModal({ rowId: row._rowId })
      return true
    }
    if (col.id === 'category_id') {
      setCategorySearchRowId(row._rowId)
      setCategorySearchOpen(true)
      return true
    }
    // EFF.4 — Item Specifics aspects: open structured panel instead of inline
    // editor. UFX P5 — ghost aspect columns (data outside every loaded schema,
    // `ghost: true`, ' ⚠' label) fall through to the inline editor instead:
    // the panel is schema-driven and can't edit them, which left typing /
    // double-click / F2 dead on ghost cells (only paste worked).
    if (aspectRoutesToPanel(col) && itemSpecificsGroup) {
      setAspectsPanelRowId(row._rowId)
      return true
    }
    return false
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemSpecificsGroup])

  // ── Hard per-cell lock (UFX P5) ────────────────────────────────────────
  // Synthesized shared-membership rows (_readonly, Task 5 shared-mgmt) must be
  // fully read-only. The onBeforeEditCell guard above only blocks edit-mode
  // ENTRY (typing / double-click / F2); paste, Delete and fill writes go
  // through the grid's bulk write path, which consults getCellReadOnly
  // (dropReadOnlyCellChanges). Without this lock a paste onto a _readonly row
  // mutated it locally and the edit silently vanished at save — onSave and
  // publish already filter _readonly/_shared rows out.
  const getCellReadOnly = useCallback((_col: FlatFileColumn, row: BaseRow): boolean =>
    (row as EbayRow)._readonly === true, [])

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
    // Item specifics: per-row applicability + guidance from eBay category API
    if (col.id.startsWith('aspect_')) {
      // EFX P4 — an aspect column that belongs to OTHER categories' schemas is
      // not applicable to a row whose category doesn't include it (union grid:
      // every category's columns show, only the relevant ones apply per row).
      const ac = (col as { applicableCategories?: string[] }).applicableCategories
      const rowCat = String(er.category_id ?? '').trim()
      if (ac?.length && rowCat && !ac.includes(rowCat)) return 'not-applicable'
      if (col.guidance === 'OPTIONAL') return 'optional'
    }
    return null
  }, [familyParentIds])

  // ── Market switch (MS-E) — one market at a time ────────────────────────
  // Instant client-side re-scope: every market's data is already loaded, so
  // switching just changes which market's columns are shown. No reload, no
  // lost edits.
  const handleMarketSwitch = useCallback((m: string) => {
    const up = m.toUpperCase()
    // Sync the market into the URL via the History API (shallow — no Next.js server
    // round-trip), matching the Amazon flat file, so the switch is visible in the URL,
    // bookmarkable, and survives a hard refresh (page.tsx reads ?marketplace on load).
    // eBay loads every market's data up front, so the column swap stays instant.
    try {
      const params = new URLSearchParams(window.location.search)
      params.set('marketplace', up)
      window.history.replaceState(null, '', `?${params.toString()}`)
    } catch { /* non-fatal — fall back to state-only switch */ }
    // FFP.4 — market memory: deep links without ?marketplace adopt this.
    try { localStorage.setItem('ff-ebay-last-market', up) } catch {}
    setMarketplace(up)
    // Market-specific: default Publish / Quick-update to the market you're now on
    // (the panel still lets you add other markets before pushing).
    setPublishTargets([up])
  }, [])

  // FFP.4 — market memory: entering WITHOUT an explicit ?marketplace adopts
  // the last market you worked on (deep links no longer hardcode a market).
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      if (params.has('marketplace')) return
      const last = localStorage.getItem('ff-ebay-last-market')?.toUpperCase()
      if (last && (EBAY_MARKETPLACES as readonly string[]).includes(last) && last !== marketplace) {
        handleMarketSwitch(last)
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Slot: channel strip ────────────────────────────────────────────────

  const renderChannelStrip = useCallback(() => (
    <ChannelStrip channel="ebay" marketplace={marketplace} familyId={familyId} />
  ), [marketplace, familyId])

  // ── Slot: push extras (after Save button) ─────────────────────────────

  const renderPushExtras = useCallback(({ rows, selectedRows }: PushExtrasCtx) => (
    <div className="relative flex flex-col items-end gap-1">
      {blockingErrors.length > 0 && publishPanelOpen && (
        <div className="absolute bottom-full mb-1.5 right-0 w-80 rounded-lg border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800 px-3 py-2 shadow-sm z-50">
          <p className="text-xs font-semibold text-red-800 dark:text-red-300 mb-1">
            {blockingErrors.length} issue{blockingErrors.length !== 1 ? 's' : ''} block this push
          </p>
          <ul className="text-[10px] text-red-700 dark:text-red-400 space-y-0.5 max-h-28 overflow-y-auto">
            {blockingErrors.map((e, i) => (
              <li key={`${e.sku}-${e.field}-${i}`} className="flex gap-1">
                <span className="font-mono shrink-0">{e.sku}</span>
                <span className="truncate">· {e.msg}</span>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-red-600 dark:text-red-500 mt-1">Fix these, then push again.</p>
        </div>
      )}
      {incompleteBefore.length > 0 && publishPanelOpen && (
        <div className="absolute bottom-full mb-1.5 right-0 w-72 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-3 py-2 shadow-sm z-50">
          <p className="text-xs font-semibold text-amber-800 dark:text-amber-300 mb-1">
            {incompleteBefore.length} row{incompleteBefore.length !== 1 ? 's' : ''} have missing required fields
          </p>
          <ul className="text-[10px] text-amber-700 dark:text-amber-400 space-y-0.5 max-h-24 overflow-y-auto">
            {incompleteBefore.map(({ sku, count }) => (
              <li key={sku} className="flex justify-between">
                <span className="font-mono truncate">{sku}</span>
                <span className="shrink-0 ml-2">{count} missing</span>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-amber-600 dark:text-amber-500 mt-1">eBay may reject these rows. Push anyway?</p>
        </div>
      )}
      {publishPanelOpen && rows.some((r) => (r as EbayRow)._isParent && (r as EbayRow).shared_sku_listing) && (
        <div className="absolute bottom-full mb-28 right-0 w-80 z-50">
          <Banner variant="warning" title="Shared-SKU listing (Trading API)">
            One or more families publish as Trading-API multi-variation listings whose variant SKUs may
            also appear in other listings. Use this ONLY for genuinely-different products that legitimately
            share stock. Listing the same item as multiple listings violates eBay&rsquo;s duplicate-listing policy.
          </Banner>
        </div>
      )}
      <div className="flex items-center gap-2">
        {feedStatus && (() => {
          const done = ['COMPLETED', 'COMPLETED_WITH_ERROR'].includes(feedStatus.status)
          const failed = feedStatus.status === 'FAILED'
          return (
            <span className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium leading-none',
              !done && !failed ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
                : done && !failed ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                : 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300',
            )}>
              {!done && !failed && <Loader2 className="w-2.5 h-2.5 animate-spin" />}
              {feedStatus.status === 'COMPLETED' ? 'Sent'
                : feedStatus.status === 'FAILED' ? 'Failed'
                : feedStatus.status === 'COMPLETED_WITH_ERROR' ? 'Partial'
                : 'Sending…'}
              {feedStatus.failureCount != null && feedStatus.failureCount > 0 && ` · ${feedStatus.failureCount} err`}
            </span>
          )
        })()}
        <Button size="sm" onClick={() => setPublishPanelOpen((o) => !o)} disabled={pushing || quickUpdating} loading={pushing || quickUpdating}>
          <Send className="w-3.5 h-3.5 mr-1.5" />
          Push to eBay
        </Button>
      </div>
      {publishPanelOpen && (
        <PublishPanel
          selectedCount={selectedRows.size}
          publishTargets={publishTargets}
          onChangeTargets={setPublishTargets}
          onPublish={() => void pushToEbay(rows, selectedRows)}
          pushing={pushing}
          onQuickUpdate={() => void quickUpdateToEbay(rows, selectedRows)}
          quickUpdating={quickUpdating}
          onClose={() => { setPublishPanelOpen(false); setIncompleteBefore([]); setBlockingErrors([]) }}
        />
      )}
    </div>
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [pushing, quickUpdating, publishPanelOpen, publishTargets, incompleteBefore, blockingErrors, feedStatus])

  // ── Slot: feed banner ──────────────────────────────────────────────────

  // Feed status is shown inline in Bar 1 (renderPushExtras chip) — no longer needed as a banner below the toolbar.
  // If the category schema failed to load, surface a dismissible danger banner here.
  // Task 4 — also show a muted "Showing SKUs listed on eBay / Show all products" cue when scoped.
  const renderFeedBanner = useCallback(() => {
    const hasCue = scope === 'listed' && !familyId
    const failedCategories = Object.keys(categorySchemaErrors)
    if (!draftNotice && !hasCue && failedCategories.length === 0 && staleSchemaCategories.length === 0) return null
    return (
      <>
        {draftNotice && (
          <Banner tone="warning" onDismiss={() => setDraftNotice(null)}>
            Restored {draftNotice.count} unsaved edit{draftNotice.count === 1 ? '' : 's'} from your last
            session on eBay {marketplace} — Save to persist {draftNotice.count === 1 ? 'it' : 'them'}.{' '}
            <button
              type="button"
              className="underline text-red-600 dark:text-red-400"
              onClick={() => {
                clearDraft(draftKey(marketplaceRef.current, familyId))
                setDraftNotice(null)
                void onReloadCtxRef.current?.()
              }}
            >
              Discard drafts
            </button>
          </Banner>
        )}
        {hasCue && (
          <div className="flex items-center gap-1 px-4 py-1 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
            Showing SKUs listed on eBay.{' '}
            <button
              type="button"
              className="text-blue-600 dark:text-blue-400 hover:underline"
              onClick={() => setScope('all')}
            >
              Show all products
            </button>
          </div>
        )}
        {failedCategories.length > 0 && (
          <Banner tone="danger" onDismiss={() => setCategorySchemaErrors({})}>
            Couldn&rsquo;t load the eBay schema for categor{failedCategories.length === 1 ? 'y' : 'ies'}{' '}
            {failedCategories.join(', ')} — {failedCategories.length === 1 ? 'its' : 'their'} Item Specifics
            columns may be incomplete. Columns from the other categories (and any existing row data) are
            still shown. Check the eBay connection or the Category ID.
          </Banner>
        )}
        {staleSchemaCategories.length > 0 && (
          <div className="flex items-center gap-1 px-4 py-1 text-xs text-slate-500 dark:text-slate-400 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/40">
            Schema for categor{staleSchemaCategories.length === 1 ? 'y' : 'ies'} {staleSchemaCategories.join(', ')} is
            served from a saved copy — eBay couldn&rsquo;t be reached. Columns stay visible; options may be slightly out of date.
          </div>
        )}
      </>
    )
  }, [scope, familyId, categorySchemaErrors, staleSchemaCategories, draftNotice, marketplace])

  // ── Slot: fetch button ─────────────────────────────────────────────────

  // ── IE.1 — Export (TSV / CSV / XLSX) reusing the shared renderExport ───
  const exportColumns = useMemo(() => {
    const seen = new Set<string>()
    const out: Array<{ id: string; label: string }> = []
    for (const g of columnGroups) for (const c of g.columns) {
      if (!seen.has(c.id)) { seen.add(c.id); out.push({ id: c.id, label: c.label }) }
    }
    return out
  }, [columnGroups])

  const exportEbay = useCallback(async (
    format: 'tsv' | 'csv' | 'xlsx',
    scope: 'all' | 'selected' | 'template',
    allRows: BaseRow[],
    selected: Set<string>,
  ) => {
    const rowsOut = scope === 'template' ? []
      : scope === 'selected' ? allRows.filter((r) => selected.has(r._rowId))
      : allRows
    try {
      const res = await fetch(`${BACKEND}/api/ebay/flat-file/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: rowsOut, columns: exportColumns, format, marketplace }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ebay_${marketplace.toLowerCase()}${scope === 'template' ? '_template' : ''}.${format}`
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
      toast.success(scope === 'template' ? 'Blank template downloaded' : `Exported ${rowsOut.length} row${rowsOut.length === 1 ? '' : 's'} as ${format.toUpperCase()}`)
    } catch (e) {
      toast.error('Export failed: ' + (e instanceof Error ? e.message : String(e)))
    }
  }, [BACKEND, exportColumns, marketplace, toast])

  // ── IE.2 — merge imported rows into the grid (fill-missing | overwrite) ──
  const handleImport = useCallback((
    imported: Record<string, unknown>[],
    mode: 'fill-missing' | 'overwrite',
    allRows: BaseRow[],
    setRows: (rows: BaseRow[]) => void,
    pushHistory: (rows: BaseRow[]) => void,
    targetParentId?: string,
  ) => {
    const bySku = new Map(allRows.map((r) => [String(r.sku ?? '').trim(), r]))
    const next = [...allRows]
    let added = 0, updated = 0
    for (const imp of imported) {
      const sku = String(imp.sku ?? '').trim()
      const existing = sku ? bySku.get(sku) : undefined
      if (existing) {
        // Update branch: never re-parent an existing SKU.
        const idx = next.findIndex((r) => r._rowId === existing._rowId)
        if (idx === -1) continue
        const merged = { ...next[idx] } as Record<string, unknown>
        for (const [k, v] of Object.entries(imp)) {
          if (mode === 'overwrite') merged[k] = v
          else if (merged[k] == null || merged[k] === '') merged[k] = v
        }
        merged._dirty = true
        next[idx] = merged as BaseRow
        updated++
      } else {
        // New-row branch: stamp under a parent when the operator chose "Under parent".
        const baseRow: Record<string, unknown> = { ...makeBlankRow(), ...imp, _isNew: true, _dirty: true }
        // Aspect-split: when nesting under a parent, copy axis values from the
        // imported row into canonical aspect_* fields using the parent's
        // variation_theme. Do this BEFORE stampUnderParent so the grid can render
        // the variant in the correct axis column immediately.
        let importParentRow: BaseRow | undefined
        if (targetParentId) {
          importParentRow = allRows.find(
            (r) =>
              String((r as EbayRow)._productId ?? (r as EbayRow).platformProductId ?? r._rowId) ===
              targetParentId,
          )
          const axes = parseThemeAxes(
            importParentRow ? String((importParentRow as EbayRow).variation_theme ?? '') : '',
          )
          for (const axis of axes) {
            const val =
              imp[axis] ??
              imp[axis.toLowerCase()] ??
              imp[`aspect_${axis}`] ??
              imp[`aspect_${axis.toLowerCase()}`]
            if (val !== undefined && val !== null) {
              // Dual-write: both the canonical casing and lowercase_underscore form.
              const canonKey = `aspect_${axis.replace(/\s+/g, '_')}`
              const lowerKey = `aspect_${axis.toLowerCase().replace(/\s+/g, '_')}`
              baseRow[canonKey] = val
              if (lowerKey !== canonKey) baseRow[lowerKey] = val
            }
          }
        }
        const newRow = targetParentId
          ? stampUnderParent(baseRow, targetParentId, String((importParentRow as EbayRow | undefined)?.sku ?? ''))
          : baseRow
        next.push(newRow as BaseRow)
        added++
      }
    }
    const ordered = pinBlankRowsLast(next)
    pushHistory(ordered)
    setRows(ordered)
    toast.success(`Imported ${imported.length} row${imported.length === 1 ? '' : 's'} — ${added} added, ${updated} updated`)
  }, [toast])

  // ── File menu items (Export + Import) — injected into FlatFileGrid's File menu ──
  const fileMenuItems = useMemo(() => [
    {
      label: 'Export as CSV',
      icon: <Download className="w-3.5 h-3.5" />,
      onClick: () => void exportEbay('csv', 'all', latestRowsRef.current, latestSelectedRowsRef.current),
    },
    {
      label: 'Export as Excel (.xlsx)',
      icon: <Download className="w-3.5 h-3.5" />,
      onClick: () => void exportEbay('xlsx', 'all', latestRowsRef.current, latestSelectedRowsRef.current),
    },
    {
      label: 'Export as TSV',
      icon: <Download className="w-3.5 h-3.5" />,
      onClick: () => void exportEbay('tsv', 'all', latestRowsRef.current, latestSelectedRowsRef.current),
    },
    { separator: true, label: '' },
    {
      label: 'Import from Amazon',
      icon: <ArrowRightLeft className="w-3.5 h-3.5" />,
      onClick: () => {
        const s = latestSetRowsRef.current; const p = latestPushHistoryRef.current
        if (s && p) void importFromAmazon({ setRows: s, pushHistory: p })
      },
    },
    {
      label: 'Import from file',
      icon: <Upload className="w-3.5 h-3.5" />,
      onClick: () => setImportWizardOpen(true),
    },
  ], [exportEbay])

  // FM Phase 3/4 — bulk Follow/Buffer, injected into the shared grid's Edit menu
  // (kept out of the toolbar so the sheet stays uncluttered). A factory so the items
  // read the grid's live selection: disabled with nothing selected, and each handler
  // acts on exactly the selected rows.
  const editMenuItems = useCallback((ctx: ToolbarFetchCtx) => {
    const noSel = ctx.selectedRows.size === 0
    return [
      { separator: true },
      { label: 'Set to Follow (pool)', icon: <RefreshCw className="w-3.5 h-3.5" />, disabled: noSel, onClick: () => void bulkSetFollowEbay(true, ctx.rows as EbayRow[], ctx.selectedRows) },
      { label: 'Set to Pinned (fixed)', icon: <Pin className="w-3.5 h-3.5" />, disabled: noSel, onClick: () => void bulkSetFollowEbay(false, ctx.rows as EbayRow[], ctx.selectedRows) },
      { label: 'Set buffer…', icon: <ListOrdered className="w-3.5 h-3.5" />, disabled: noSel, onClick: () => openEbayBufferModal(ctx.rows as EbayRow[], ctx.selectedRows) },
    ]
  }, [bulkSetFollowEbay, openEbayBufferModal])

  const renderToolbarFetch = useCallback(({ rows, selectedRows, setRows, pushHistory }: ToolbarFetchCtx) => {
    // Keep refs current so fileMenuItems callbacks always act on the latest rows
    latestRowsRef.current = rows
    latestSelectedRowsRef.current = selectedRows
    latestSetRowsRef.current = setRows
    latestPushHistoryRef.current = pushHistory

    // FFP.1 — debounced draft autosave. This slot re-renders on every grid
    // rows change, so it doubles as the rows-changed signal (the grid exposes
    // no onRowsChange). Key captured at schedule time so edits flush to the
    // market they were made on even across a market switch.
    if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
    {
      const k = draftKey(marketplaceRef.current, familyId)
      draftTimerRef.current = setTimeout(() => { writeDraft(k, latestRowsRef.current) }, 400)
    }

    // EFX P4 — aspect-key + market-data signatures. This slot re-renders on
    // every rows change (same signal the draft autosave uses); the signatures
    // are stable serializations, so state only updates — and the ghost-column
    // memo / market-strip dots only recompute — when the SET changes, never
    // per keystroke. setState is deferred out of the render pass.
    {
      const sig = computeAspectKeySignature(rows as Array<Record<string, unknown>>)
      const mSig = computeMarketDataSignature(rows as Array<Record<string, unknown>>)
      if (sig !== aspectSigRef.current || mSig !== marketDataSigRef.current) {
        aspectSigRef.current = sig
        marketDataSigRef.current = mSig
        setTimeout(() => { setGhostAspectSig(sig); setMarketsWithData(mSig) }, 0)
      }
    }

    // ── sheetParents (DRY) — single derivation reused by AddListingPopover and Move-to-parent ──
    const sheetParents = deriveSheetParents(rows)

    // Detach: shared-SKU warning — show if any selected row's parent family publishes as shared-SKU
    const showDetachSharedWarning = rows.filter((r) => selectedRows.has(r._rowId)).some((sr) => {
      const parentId = String((sr as EbayRow).platformProductId ?? '')
      if (!parentId) return false
      return (rows as EbayRow[]).some(
        (r) => r._isParent === true &&
          String((r as EbayRow)._productId ?? (r as EbayRow).platformProductId ?? r._rowId) === parentId &&
          (r as EbayRow).shared_sku_listing === true,
      )
    })

    // Move-to-parent: shared-SKU warning — show if target OR source family publishes as shared-SKU
    const showMoveSharedWarning = (() => {
      if (!moveTargetId) return false
      if ((rows as EbayRow[]).some(
        (r) => r._isParent === true &&
          String((r as EbayRow)._productId ?? (r as EbayRow).platformProductId ?? r._rowId) === moveTargetId &&
          (r as EbayRow).shared_sku_listing === true,
      )) return true
      return rows.filter((r) => selectedRows.has(r._rowId)).some((sr) => {
        const parentId = String((sr as EbayRow).platformProductId ?? '')
        if (!parentId) return false
        return (rows as EbayRow[]).some(
          (r) => r._isParent === true &&
            String((r as EbayRow)._productId ?? (r as EbayRow).platformProductId ?? r._rowId) === parentId &&
            (r as EbayRow).shared_sku_listing === true,
        )
      })
    })()

    return (
      <>
        {/* Add listing row generator */}
        <div className="relative">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setAddListingOpen((o) => !o)}
            title="Add a new listing — generates parent + variant rows in the grid"
          >
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            Add listing
          </Button>
          {addListingOpen && (
            <AddListingPopover
              categoryAxisNames={variantAxisNames}
              marketplace={marketplace}
              existingParents={sheetParents}
              onConfirm={(newRows) => {
                const next = pinBlankRowsLast([...rows, ...newRows])
                pushHistory(next)
                setRows(next)
                // Note: no focus-set here — the grid exposes no clean imperative
                // handle for jumping to a row by _rowId from outside the grid tree.
              }}
              onClose={() => setAddListingOpen(false)}
            />
          )}
        </div>

        {/* FFP.9 — selection row-actions live in ONE menu instead of three
            permanent toolbar residents (they only apply to selected rows). */}
        {(() => {
          const deletable = (rows as EbayRow[])
            .filter((r) => selectedRows.has(r._rowId))
            .filter((r) => !!r.sku && !(r._readonly === true && r._shared !== true))
          return (
            <Menu
              label={
                <span className="inline-flex items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5" />
                  Rows{selectedRows.size > 0 ? ` (${selectedRows.size})` : ''}
                </span>
              }
              triggerProps={{
                disabled: selectedRows.size === 0,
                title: 'Actions for the selected rows — move to a parent, detach to standalone, or delete',
              }}
              items={[
                {
                  id: 'move-to-parent',
                  label: 'Move to parent…',
                  icon: <GitBranch className="w-3.5 h-3.5" />,
                  onSelect: () => { setMoveParentOpen(true); setMoveTargetId('') },
                },
                {
                  id: 'detach-standalone',
                  label: 'Detach to standalone',
                  icon: <Unlink className="w-3.5 h-3.5" />,
                  onSelect: () => setDetachOpen(true),
                },
                {
                  id: 'delete-rows',
                  label: `Delete… (${deletable.length})`,
                  icon: <Trash2 className="w-3.5 h-3.5" />,
                  disabled: deletable.length === 0,
                  onSelect: () => setDeleteConfirmRows(deletable),
                },
              ]}
            />
          )
        })()}
        {moveParentOpen && (
          <Modal
            open
            onClose={() => setMoveParentOpen(false)}
            title="Move variants to parent"
            size="sm"
            footer={
              <>
                <Button size="sm" variant="ghost" onClick={() => setMoveParentOpen(false)}>Cancel</Button>
                <Button
                  size="sm"
                  disabled={!moveTargetId}
                  onClick={() => {
                    const moveTargetSku = sheetParents.find((p) => p.id === moveTargetId)?.sku ?? ''
                    const next = pinBlankRowsLast(moveRowsToParent(rows, selectedRows, moveTargetId, moveTargetSku))
                    pushHistory(next)
                    setRows(next)
                    setMoveParentOpen(false)
                  }}
                >
                  Move {selectedRows.size} variant{selectedRows.size !== 1 ? 's' : ''}
                </Button>
              </>
            }
          >
            {showMoveSharedWarning && (
              <Banner variant="warning" className="mb-3">
                This family publishes as a shared-SKU listing; moving a variant is membership-managed and won&rsquo;t re-parent on the server.
              </Banner>
            )}
            <Combobox
              options={sheetParents.map((p) => ({ value: p.id, label: p.sku || p.id }))}
              value={moveTargetId}
              onChange={setMoveTargetId}
              placeholder="Choose parent…"
            />
          </Modal>
        )}

        {detachOpen && (
          <Modal
            open
            onClose={() => setDetachOpen(false)}
            title="Detach to standalone"
            size="sm"
            footer={
              <>
                <Button size="sm" variant="ghost" onClick={() => setDetachOpen(false)}>Cancel</Button>
                <Button
                  size="sm"
                  onClick={() => {
                    const next = pinBlankRowsLast(detachRowsToStandalone(rows, selectedRows))
                    pushHistory(next)
                    setRows(next)
                    setDetachOpen(false)
                  }}
                >
                  Detach {selectedRows.size} variant{selectedRows.size !== 1 ? 's' : ''}
                </Button>
              </>
            }
          >
            <Banner variant="info" className="mb-3">
              Detach {selectedRows.size} variant{selectedRows.size !== 1 ? 's' : ''} to standalone? Their parent link is removed on Save.
            </Banner>
            {showDetachSharedWarning && (
              <Banner variant="warning">
                This family publishes as a shared-SKU listing; the server suppresses detach for shared families.
              </Banner>
            )}
          </Modal>
        )}

        {/* P2.D2 — Delete selected rows: moved into the Rows menu (FFP.9). */}

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

        {/* History — unified push, pull history + one-click re-pull */}
        <SharedTbBtn
          icon={<History className="w-3.5 h-3.5" />}
          title="History — push submissions, pull log and re-pull"
          onClick={() => setHistoryPanelOpen(true)}
          active={historyPanelOpen}
        />

        {/* Images — drawer covering every family in the sheet (EFX P6) */}
        {hasImageFamilies && (
          <SharedTbBtn
            icon={<ImageIcon className="w-3.5 h-3.5" />}
            title="Manage eBay images — drawer listing every family in this sheet; curate per-variation image sets; publishes to the selected market only"
            onClick={openImageDrawer}
            active={imageModalOpen}
          />
        )}

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
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pullPanelOpen, pulling, pullProgress, pullResult, marketplace, startPullJob, historyPanelOpen, addListingOpen, variantAxisNames, imageModalOpen, hasImageFamilies, openImageDrawer, moveParentOpen, moveTargetId, detachOpen])

  // ── Slot: import button ────────────────────────────────────────────────

  // View-toggle slot (Override / Cascade / Reset). Import-from-Amazon
  // moved to renderToolbarFetch in Phase C so all data-fetch actions
  // sit together.
  // Task 4 — also captures ctx.onReload (same pattern as renderToolbarFetch captures setRows)
  // so the scope-change useEffect can trigger the grid's own reload mechanism.
  const renderToolbarImport = useCallback((ctx: ToolbarImportCtx) => {
    onReloadCtxRef.current = ctx.onReload
    return (
      <>
        {/* Task 4 — This file / All products scope toggle (hidden in family drill-in mode) */}
        {!familyId && (
          <div
            className="flex items-center rounded-md border border-slate-200 dark:border-slate-700 divide-x divide-slate-200 dark:divide-slate-700 overflow-hidden"
            title="Scope: This file shows only eBay-listed SKUs; All products shows the full catalog"
          >
            <Button
              size="sm"
              variant={scope === 'listed' ? 'secondary' : 'ghost'}
              onClick={() => setScope('listed')}
              className="rounded-none border-none px-2.5"
            >
              This file
            </Button>
            <Button
              size="sm"
              variant={scope === 'all' ? 'secondary' : 'ghost'}
              onClick={() => setScope('all')}
              className="rounded-none border-none px-2.5"
            >
              All products
            </Button>
          </div>
        )}

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
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOverrideBadges, showCascadeButtons, scope, familyId])

  // ── Slot: Bar3 left ────────────────────────────────────────────────────

  const renderBar3Left = useCallback(() => (
    <FlatFileMarketStrip
      markets={EBAY_MARKETPLACES}
      active={marketplace}
      onSelect={handleMarketSwitch}
      // EFX P4 — dot on inactive markets whose rows carry data (price/qty/item id)
      dataMarkets={marketsWithData ? marketsWithData.split(',') : []}
    />
  ), [marketplace, handleMarketSwitch, marketsWithData])

  // ── Slot: modals ───────────────────────────────────────────────────────

  const renderModals = useCallback(({ rows, setRows, pushHistory }: ModalsCtx) => {
    const desc = descModal ? rows.find((r) => r._rowId === descModal.rowId) : null
    const aspectsRow = aspectsPanelRowId ? rows.find((r) => r._rowId === aspectsPanelRowId) ?? null : null
    const parentRow = (rows as EbayRow[]).find((r) => r._isParent === true)
    const parentProductId = String(parentRow?._productId ?? parentRow?.platformProductId ?? familyId ?? '')
    return (
      <>
        {/* EFF.4 — Aspects side panel (EFX P4 — union group incl. ghost columns) */}
        <AspectsPanel
          open={aspectsPanelRowId !== null}
          row={aspectsRow}
          categoryGroup={itemSpecificsGroup}
          onSave={(rowId, values) => {
            // UFX P7 (item 12) — a modal write into a ghost row must materialize
            // it (same patch the grid's own write paths apply), or the edit is
            // invisible to dirty counts / save / validation.
            const next = rows.map((r) => r._rowId === rowId ? { ...r, ...materializeGhostPatch(r), ...values, _dirty: true } : r)
            pushHistory(next)
            setRows(next)
          }}
          onClose={() => setAspectsPanelRowId(null)}
        />

        {desc && descModal && (
          <DescriptionModal
            value={String(desc.description ?? '')}
            onSave={(v) => {
              // UFX P7 (item 12) — materialize a ghost target (see AspectsPanel note)
              const next = rows.map((r) => r._rowId === descModal.rowId ? { ...r, ...materializeGhostPatch(r), description: v, _dirty: true } : r)
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
                // UFX P7 (item 12) — P5 residual: applying a category to a GHOST
                // row via this modal left it a ghost (excluded from dirty/save/
                // validation). Materialize it exactly like the grid's write paths
                // do; the grid's topup effect re-grows the blank canvas below.
                const next = rows.map((r) => r._rowId === categorySearchRowId ? { ...r, ...materializeGhostPatch(r), category_id: id, _dirty: true } : r)
                pushHistory(next)
                setRows(next)
                // EFX P4 — union across ALL categories on the updated rows
                void loadCategorySchemas(collectCategoryIds(next as Array<Record<string, unknown>>))
              }
            }}
            onClose={() => { setCategorySearchOpen(false); setCategorySearchRowId(null) }}
          />
        )}
        {/* VAVO — Variation value order modal */}
        {valueOrderOpen && (
          <VariationValueOrderModal
            open={valueOrderOpen}
            onClose={() => setValueOrderOpen(false)}
            rows={rows as EbayRow[]}
            parentProductId={parentProductId || null}
            marketplace={marketplace}
          />
        )}

        {/* S2 — warn-only pre-publish modal. Never blocks: "Publish anyway"
            always resumes the push; "Go back & fix" just closes it. */}
        {prePublishGate && (
          <PrePublishWarningModal
            open
            issues={prePublishGate.issues}
            publishing={pushing}
            onGoBack={() => setPrePublishGate(null)}
            onPublishAnyway={() => {
              const gate = prePublishGate
              // Traceable audit trail: operator proceeded past N issues.
              console.warn(`[eBay push] Publish anyway — proceeding past ${gate.issues.length} pre-publish issue(s):`, gate.issues.map((i) => i.message))
              setPrePublishGate(null)
              void executePush(rows, gate.sendRows, gate.skippedByAction)
            }}
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

        {/* IE.2 — Import wizard (moved from renderToolbarFetch to keep toolbar clean) */}
        <EbayImportWizard
          open={importWizardOpen}
          onClose={() => { setImportWizardOpen(false); setImportInitialFile(null) }}
          columns={exportColumns}
          existingSkus={new Set(rows.map((r) => String(r.sku ?? '').trim()).filter(Boolean))}
          existingParents={deriveSheetParents(rows)}
          marketplace={marketplace}
          initialFile={importInitialFile}
          onImport={(imported, mode, targetParentId) => handleImport(imported, mode, rows, setRows, pushHistory, targetParentId)}
        />
      </>
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [descModal, categorySearchOpen, categorySearchRowId, marketplace, loadCategorySchemas, pullDiffData, pullDiffOpen, makePullDiffApplyHandler, aspectsPanelRowId, itemSpecificsGroup, valueOrderOpen, familyId, importWizardOpen, importInitialFile, exportColumns, handleImport])

  // ── Slot: right-click context menu (UFX P7 item 1 — shared FlatFileContextMenu) ──
  // Channel-appropriate actions: inserts are local blank rows (same as the
  // grid's Add row), delete routes through eBay's EXISTING delete-confirm flow
  // (soft-delete + live delist — never a bare local row removal), and the add
  // flow opens the AddListingPopover. Reads the latest grid ctx via the
  // renderToolbarFetch refs, so actions never see stale rows.
  const renderContextMenu = useCallback((ctx: GridContextMenuCtx) => {
    const insertAt = (offset: 0 | 1) => {
      const rows = latestRowsRef.current
      const anchorId = ctx.anchorRow?._rowId
      const idx = anchorId ? rows.findIndex((r) => r._rowId === anchorId) : -1
      const next = [...rows]
      const newRow = makeBlankRow()
      if (idx === -1) next.push(newRow); else next.splice(idx + offset, 0, newRow)
      latestPushHistoryRef.current?.(next)
    }
    // Same deletable predicate as the toolbar Rows menu (needs a SKU; synthesized
    // read-only membership rows are only deletable when they're shared memberships).
    const deletable = (ctx.selectionRows as EbayRow[])
      .filter((r) => !!r.sku && !(r._readonly === true && r._shared !== true))
    return (
      <FlatFileContextMenu
        x={ctx.x}
        y={ctx.y}
        onClose={ctx.close}
        items={[
          { label: 'Cut', shortcut: '⌘X', onClick: ctx.ops.cut, disabled: !ctx.hasSelection },
          { label: 'Copy', shortcut: '⌘C', onClick: ctx.ops.copy, disabled: !ctx.hasSelection },
          { label: 'Paste', shortcut: '⌘V', onClick: ctx.ops.paste },
          { separator: true },
          { label: 'Insert row above', onClick: () => insertAt(0) },
          { label: 'Insert row below', onClick: () => insertAt(1) },
          {
            label: `Delete row${deletable.length !== 1 ? 's' : ''}… (${deletable.length})`,
            danger: true,
            disabled: deletable.length === 0,
            onClick: () => setDeleteConfirmRows(deletable),
          },
          { separator: true },
          { label: 'Add listing…', onClick: () => setAddListingOpen(true) },
          { separator: true },
          { label: 'Group selected…', onClick: ctx.ops.groupFromSelection, disabled: ctx.selRowCount === 0 },
          { label: 'Clear cells', shortcut: 'Del', onClick: ctx.ops.clearCells, disabled: !ctx.hasSelection },
        ]}
      />
    )
  }, [])

  // ── Group key for eBay variations ──────────────────────────────────────
  // Mirrors server ebayFamilyKey (ebay-flat-file-create.logic.ts:255):
  //   explicit parent/standalone → own sku (fallback _productId/_rowId)
  //   explicit child             → parent_sku (fallback platformProductId)
  //   no explicit parentage      → platformProductId (back-compat, ppid heuristic)
  // Editing parent_sku on a child re-groups it live without a reload.

  const getGroupKey = useCallback((row: BaseRow) => {
    const er = row as EbayRow
    const parentage = er.parentage
    if (parentage === 'parent' || parentage === '') {
      // Explicit parent or standalone: key by own SKU so children with parent_sku=this.sku join it.
      return String(er.sku ?? '').trim() || String(row._productId ?? row._rowId)
    }
    if (parentage === 'child') {
      // Explicit child: key by parent_sku, fallback to platformProductId (transition safety).
      const ps = String(er.parent_sku ?? '').trim()
      return ps || String(er.platformProductId ?? row._rowId)
    }
    // No explicit parentage (legacy data, back-compat): original ppid-based key.
    return String(er.platformProductId ?? row._rowId)
  }, [])

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
    <div
      style={{ display: 'contents' }}
      onDragOver={(e) => { if (!importWizardOpen && e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={(e) => {
        // IE.3 — drop a spreadsheet anywhere on the editor to open the import wizard pre-loaded.
        if (importWizardOpen || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        const f = e.dataTransfer.files?.[0]
        if (f) { setImportInitialFile(f); setImportWizardOpen(true) }
      }}
    >
      {/* Image management drawer — EFX P6 */}
      <EbayFlatFileImageDrawer
        open={imageModalOpen}
        onClose={() => setImageModalOpen(false)}
        marketplace={marketplace}
        families={imageDrawerFamilies}
        onSyncColumns={(productId, urls) => {
          const IMAGE_COLS = ['image_1', 'image_2', 'image_3', 'image_4', 'image_5', 'image_6'] as const
          const cur = latestRowsRef.current
          const next = (cur as EbayRow[]).map((r) => {
            // Only sync rows belonging to the saved family.
            const rowProductId = String((r as EbayRow)._productId ?? (r as EbayRow).platformProductId ?? '')
            if (rowProductId !== productId) return r
            const patch: Partial<EbayRow> = {}
            IMAGE_COLS.forEach((col, i) => { patch[col] = urls[i] ?? '' })
            return { ...r, ...patch, _dirty: true }
          })
          latestPushHistoryRef.current?.(next)
          latestSetRowsRef.current?.(next)
        }}
      />

      {/* Unified history modal — H.1–H.4 */}
      <HistoryModal
        open={historyPanelOpen}
        onClose={() => setHistoryPanelOpen(false)}
        channel="ebay"
        marketplace={marketplace}
        onResubmitErroredSkus={(_skus) => {
          // eBay re-submit: close modal (operator manually pushes after seeing errored SKUs)
          setHistoryPanelOpen(false)
        }}
        onRePull={(rec) => {
          setHistoryPanelOpen(false)
          const isAllCols = rec.columnsApplied.includes('all') || rec.columnsApplied.length === 0
          const cols = (isAllCols ? 'all' : rec.columnsApplied) as 'all' | PullGroupId[]
          if (!rec.skusRequested.length) return
          void startPullJob({ skus: rec.skusRequested, columns: cols })
        }}
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
          onSuccess={(n) => { if (n > 0) reloadGridPreservingEdits() }}
        />
      )}
      {/* P2.D2 — Delete confirm modal */}
      {deleteConfirmRows && (
        <EbayDeleteConfirmModal
          rows={deleteConfirmRows}
          allRows={latestRowsRef.current as EbayRow[]}
          marketplace={marketplace}
          loading={deleteLoading}
          onConfirm={() => void handleExecuteDelete()}
          onClose={() => setDeleteConfirmRows(null)}
        />
      )}

      {/* FM Phase 4 — bulk Set buffer modal */}
      {bufferModal && (
        <Modal open onClose={() => setBufferModal(null)} title="Set buffer" size="sm"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setBufferModal(null)}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={() => void applyEbayBufferModal()}>Set buffer</Button>
            </>
          }>
          <p className="text-sm text-slate-600 dark:text-slate-300 mb-3">
            Reserve units from the shared pool on <strong>{bufferModal.productIds.length}</strong> Following listing{bufferModal.productIds.length === 1 ? '' : 's'}. Each will then advertise <strong>pool − buffer</strong> — its live quantity may change and a sync is queued.
          </p>
          <label className="block text-xs font-medium text-slate-500 mb-1">Units to hold back</label>
          <input type="number" min={0} value={bufferInput}
            onChange={(e) => setBufferInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void applyEbayBufferModal() }}
            autoFocus
            className="w-28 px-2 py-1.5 border border-slate-300 dark:border-slate-600 rounded text-sm bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100" />
        </Modal>
      )}

      {/* ColumnGroupModal — controlled by useFlatFileCore columnsOpen state */}
      <ColumnGroupModal
        open={columnsOpen}
        onClose={() => setColumnsOpen(false)}
        groups={coreColumnGroups.map((g) => ({
          id: g.id,
          label: g.label,
          color: g.color,
          columns: g.columns.map((c) => c.id),
          visible: !coreClosedGroups.has(g.id),
        }))}
        onGroupsChange={(updated) => {
          const nextClosed = new Set(updated.filter((g) => !g.visible).map((g) => g.id))
          const nextOrder = updated.map((g) => g.id)
          coreApplyGroupSettings(nextClosed, nextOrder)
        }}
      />

    {!rowsReady ? (
        <div className="flex-1 flex items-center justify-center bg-white dark:bg-slate-900">
          <div className="flex flex-col items-center gap-3 text-slate-400 dark:text-slate-500">
            <div className="w-6 h-6 border-2 border-slate-200 dark:border-slate-700 border-t-blue-500 rounded-full animate-spin" />
            <span className="text-xs">Loading listings…</span>
          </div>
        </div>
      ) : (
    <FlatFileGrid
      key={rowsReady ? 'ready' : 'loading'}
      channel="ebay"
      title="eBay Flat File"
      titleIcon={titleIcon}
      marketplace={marketplace}
      familyId={familyId}
      storageKey="eff"
      enableCustomGroups
      columnGroups={columnGroups}
      columnGroupState={coreColumnGroups.map((g) => ({
        id: g.id,
        label: g.label,
        color: g.color,
        columns: g.columns.map((c) => c.id),
        visible: !coreClosedGroups.has(g.id),
      }))}
      onGroupStateChange={(closed, order) => coreApplyGroupSettings(closed, order)}
      initialRows={clientRows as BaseRow[]}
      makeBlankRow={makeBlankRow}
      // UFX P2d — Sheets-style ghost canvas replaces the minRows={15} padding:
      // unlike padToMin rows (which makeBlankRow marks _isNew/_dirty and so
      // polluted dirty counts + Save), ghosts are excluded from dirty counts,
      // onSave(dirty), validate() and select-all by the grid, and materialize
      // into plain new rows on first edit.
      ghostRows={10}
      getGroupKey={getGroupKey}
      validate={validateRows}
      onSave={onSave}
      onReload={onReload}
      onCellChange={onCellChange}
      renderCellContent={renderCellContent}
      onBeforeEditCell={onBeforeEditCell}
      getCellReadOnly={getCellReadOnly}
      getCellGuidance={getCellGuidance}
      onReplicate={onReplicate}
      renderContextMenu={renderContextMenu}
      renderChannelStrip={renderChannelStrip}
      renderPushExtras={renderPushExtras}
      renderEmptyAction={() => (
        <Button size="sm" onClick={() => setAddListingOpen(true)}>
          <Plus className="w-3.5 h-3.5 mr-1.5" />Add your first listing
        </Button>
      )}
      fileMenuItems={fileMenuItems}
      editMenuItems={editMenuItems}
      renderFeedBanner={renderFeedBanner}
      renderModals={renderModals as (ctx: ModalsCtx) => React.ReactNode}
      renderToolbarFetch={renderToolbarFetch}
      renderToolbarImport={renderToolbarImport}
      renderBar3Left={renderBar3Left}
      onColumnsClick={() => setColumnsOpen((o) => !o)}
      columnsActive={columnsOpen}
      toolbarTrailing={
        <SharedTbBtn
          icon={<ListOrdered className="w-3.5 h-3.5" />}
          title="Variation order — set which axis buyers pick first (e.g. Colour before Size) and the value order within each, per market"
          onClick={() => setValueOrderOpen(true)}
        />
      }
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
          {/* P2.D2 — per-row delete removed (inflated row height); delete via the
              toolbar "Delete selected" (select rows → bulk delete) instead. */}
        </div>
      )}
    />
    )}
    </div>
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

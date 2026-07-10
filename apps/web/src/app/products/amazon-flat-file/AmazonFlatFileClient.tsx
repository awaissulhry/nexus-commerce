'use client'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

import {
  useCallback, useEffect, useRef, useState, useMemo,
} from 'react'
import { useSearchParams } from 'next/navigation'
import {
  Activity, AlertCircle, AlertTriangle, CheckCircle2, ChevronDown,
  Clock, Copy, Download, FileSpreadsheet, GitBranch, GitFork, Globe, History, Loader2, Pin, Plus, RefreshCw, RotateCcw,
  Search, Send, Trash2, Upload, X, ArrowRightLeft,
  GripVertical, Wand2, Layers,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { useFlatFileCore } from '@/components/flat-file/useFlatFileCore'
import FlatFileGrid from '@/components/flat-file/FlatFileGrid'
import type {
  BaseRow, FlatFileColumn, FlatFileGridApi, AiPanelCtx,
  ToolbarFetchCtx, ToolbarImportCtx, PushExtrasCtx, ModalsCtx,
  FooterActionsCtx, GridContextMenuCtx,
} from '@/components/flat-file/FlatFileGrid.types'
import {
  buildGridColumnGroups, validateAmazonRows, isFbaRow, isFbaManagedCell,
  amazonGroupKey, fbaBucketFor, type AmazonColumnGroup,
} from './gridAdapter'
import { AMAZON_FILTER_DEFAULT, type AmazonFilterDims } from '../_shared/flat-file-filter.types'
import { type PullDiffApplyResult } from './PullDiffModal'
import { type ImportApplyResult } from './ImportWizardModal'
import { PendingPullBanner } from '../_shared/PendingPullBanner'
import { TbBtn as SharedTbBtn } from '@/components/flat-file/FlatFileToolbar'
import { ColumnGroupModal } from '@/design-system/components/ColumnGroupModal'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { PublishModeBadge } from '@/components/PublishModeBadge'
import { useOrderEventsRefresh } from '@/hooks/use-order-events-refresh'
import { useToast } from '@/components/ui/Toast'
import { HistoryModal } from '@/components/flat-file/HistoryModal'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { Button } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { applyBulkFollow, applyBulkBuffer } from '@/lib/follow-master'
import { Modal as DSModal } from '@/design-system/components/Modal'
import { Badge } from '@/components/ui/Badge'
import { TagInput } from '@/design-system/primitives/TagInput'
import { ChannelStrip } from '../ebay-flat-file/ChannelStrip'
import { OverrideBadge } from '../_shared/OverrideBadge'
import { categoryOf, assignCategory, productTypesInUse, formatNodeBreadcrumb } from './category-model'
import {
  sheetCompositionKey, serializeComposition, parseComposition,
  compositionMatchesPrimary, compositionStorageType,
} from './sheet-composition'

// EH.5 — Lazy-loaded modals, panels, and bars. Each one only ships
// to the browser when the operator first opens it, so the initial
// AmazonFlatFileClient chunk drops from ~600 kB to under ~250 kB.
// All are client-only (state-gated, no SSR benefit) — ssr: false
// short-circuits the SSR pass for them entirely.
const PullDiffModal = dynamic(
  () => import('./PullDiffModal').then((m) => m.PullDiffModal),
  { ssr: false },
)
// PullHistoryDrawer removed — merged into HistoryModal (H.1–H.4)
const CascadeModal = dynamic(
  () => import('../_shared/CascadeModal').then((m) => m.CascadeModal),
  { ssr: false },
)
const FlatFileAiPanel = dynamic(
  () => import('../_shared/FlatFileAiPanel').then((m) => m.FlatFileAiPanel),
  { ssr: false },
)
const ImportWizardModal = dynamic(
  () => import('./ImportWizardModal').then((m) => m.ImportWizardModal),
  { ssr: false },
)
const SetCategoryModal = dynamic(() => import('./SetCategoryModal'), { ssr: false })


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
  /** true → must pick from list; false/undefined → combobox (free text allowed) */
  selectionOnly?: boolean
  /** Which parentage levels this field applies to (undefined = all) */
  applicableParentage?: string[]
  /** MT.3 — union manifest: which product types define this column + which
   *  require it. Lets a cell grey out for a row whose product_type it doesn't
   *  apply to. undefined on a single-type manifest. */
  applicableProductTypes?: string[]
  requiredForProductTypes?: string[]
  /** UFX P4d — union manifest: each product type's OWN enum option list
   *  (UPPERCASE type → options). Drives per-row-type dropdowns + validation. */
  optionsByProductType?: Record<string, string[]>
  /** Usage level from Amazon schema: REQUIRED / RECOMMENDED / OPTIONAL */
  guidance?: string
  maxLength?: number
  maxUtf8ByteLength?: number
  width: number
  /** Maps canonical stored value → localized display label for enum cells.
   *  e.g. { 'parent': 'Articolo padre', 'child': 'Articolo figlio' } for IT. */
  optionLabels?: Record<string, string>
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

/** FFP.2 — which rows a submit sends: edited/pending (default), the grid
 *  selection, or every real row in view. Full operator freedom either way —
 *  Amazon is the authoritative validator. */
type SubmitScope = 'edited' | 'selected' | 'all'

interface Row {
  _rowId: string
  _isNew?: boolean
  _dirty?: boolean
  /** FFP.2 — saved to Nexus but not yet submitted to Amazon. Set when Save
   *  clears _dirty; cleared when a feed completes (isPublished resync). Submit
   *  gathers _dirty || _isNew || _needsPublish, so Save never disarms Submit. */
  _needsPublish?: boolean
  /** GX.5 — a trailing blank "canvas" row (Sheets-style). Never counted, saved,
   *  submitted or exported; materializes into a real row on first edit. */
  _ghost?: boolean
  _status?: 'idle' | 'pending' | 'pushed' | 'success' | 'error'
  _feedMessage?: string
  /** P2.1 — Column IDs that Amazon flagged in the last feed result. */
  _errorFields?: string[]
  /** P2.2 — Raw SP-API error code for the last feed error. */
  _feedCode?: string
  /** P3.1 — Row is currently suppressed on Amazon. */
  _suppressed?: boolean
  /** P3.1 — Human-readable suppression reason. */
  _suppressionReason?: string | null
  /** P3.1 — Count of open ListingIssues from ALA. */
  _issueCount?: number
  /** P3.1 — Worst open issue severity: ERROR | WARNING | INFO. */
  _issueSeverity?: string | null
  /** P3.1 — Column IDs that ALA ListingIssues identify as failing. */
  _issueFields?: string[]
  _marketCoverage?: Record<string, { status: string; title?: string; price?: string }>  // P5.1
  _productId?: string
  [key: string]: unknown
}

interface FeedResult {
  sku: string
  status: string
  message: string
  /** P2.1 — Column IDs extracted from error messages. */
  fields?: string[]
  /** P2.2 — SP-API error code. */
  code?: string
  /** P1/P2 — structured per-issue detail with resolved editor columns. */
  issues?: Array<{ code: string; severity: string; message: string; attributeNames?: string[]; columns?: Array<{ id: string; label: string }> }>
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

// FFS.5 — Amazon's real feed statuses are IN_QUEUE | IN_PROGRESS | DONE | FATAL |
// CANCELLED. Treat all three end-states as terminal so polling stops + the
// "Check" loop can't spin forever (previously CANCELLED was treated as in-flight).
const FEED_TERMINAL = new Set(['DONE', 'FATAL', 'CANCELLED'])
const isFeedTerminal = (s: string | null | undefined): boolean => !!s && FEED_TERMINAL.has(s)
const feedErrorCount = (results: FeedResult[]): number => results.filter((r) => r.status === 'error').length

// FFA.2 — merge copied columns into a target market's existing rows BY SKU
// (update matching SKUs, add genuinely-new ones). Replaces the old behaviour
// that overwrote the target market's whole row set with copies-only (wiping
// existing target rows) and created duplicate rows for SKUs already present.
function mergeReplicatedRows(
  targetRows: Row[],
  sourceRows: Row[],
  colsToCopy: Set<string>,
  structural: Set<string>,
): Row[] {
  const bySku = new Map<string, Row>(targetRows.map((r) => [String(r.item_sku ?? ''), r]))
  for (const src of sourceRows) {
    const sku = String(src.item_sku ?? '')
    if (!sku) continue
    const existing = bySku.get(sku)
    const base: Row = existing
      ? { ...existing, _dirty: true }
      : { _rowId: `copy-${sku}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, _isNew: true, _dirty: true, _status: 'idle' }
    for (const k of structural) if (src[k] != null) base[k] = src[k]
    for (const colId of colsToCopy) if (src[colId] != null) base[colId] = src[colId]
    bySku.set(sku, base)
  }
  return Array.from(bySku.values())
}

interface SubmissionRecord {
  id: string            // feedId
  market: string
  productType: string
  submittedAt: string   // ISO
  rowCount: number
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'PROCESSING' | 'DONE' | 'FATAL' | 'CANCELLED'
  successCount?: number
  errorCount?: number
  results?: Array<{ sku: string; status: string; message: string }>
  dryRun?: boolean
}

// ── Pull from Amazon ───────────────────────────────────────────────────
// Groups used by the in-editor Pull panel to let users restrict which
// columns get overwritten. Field IDs map to a single group via
// pullFieldGroup(); the merge logic in handlePullFromAmazon skips any
// field whose group is not selected.

type PullGroupId = 'content' | 'pricing' | 'stock' | 'images' | 'variations' | 'other'

interface PullGroup {
  id: PullGroupId
  label: string
  description: string
}

const PULL_GROUPS: PullGroup[] = [
  { id: 'content',    label: 'Title & content',     description: 'Title, description, bullets, keywords, color' },
  { id: 'pricing',    label: 'Pricing',             description: 'Price, sale price, currency, condition' },
  { id: 'stock',      label: 'Stock & fulfillment', description: 'Quantity, fulfillment channel, lead time' },
  { id: 'images',     label: 'Images',              description: 'Main image + additional image locators' },
  { id: 'variations', label: 'Variations',          description: 'Parentage level, parent SKU, variation theme' },
  { id: 'other',      label: 'All other attributes', description: 'Everything else returned by Amazon' },
]

function pullFieldGroup(field: string): PullGroupId {
  if (field === 'item_name' || field === 'product_description' || field === 'generic_keyword' || field === 'brand' || field === 'color') return 'content'
  if (/^bullet_point(_\d+)?$/.test(field)) return 'content'
  if (field.startsWith('purchasable_offer')) return 'pricing'
  if (field.startsWith('fulfillment_availability')) return 'stock'
  if (field === 'main_product_image_locator' || /image_locator(_\d+)?$/.test(field)) return 'images'
  if (field === 'parentage_level' || field === 'parent_sku' || field === 'variation_theme') return 'variations'
  return 'other'
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

// ── Constants ──────────────────────────────────────────────────────────

const MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK']

// ── Module-level SWR cache ─────────────────────────────────────────────
// Keyed by "MP:PT". Lives at module scope so it survives component
// unmount/remount (navigating Amazon → eBay → Amazon reuses the cache).
const SWR_TTL_MS = 5 * 60 * 1000
type Snapshot = { manifest: Manifest; rows: Row[]; fetchedAt: number }
const _swr = new Map<string, Snapshot>()

// ── FFP.11 — persistent manifest cache (localStorage) ─────────────────
// The in-memory SWR cache dies on a hard reload, and the SSR template
// prefetch is anonymous under RBAC (always null) — so every reload used to
// block the first paint on a full template+rows round trip ("Preparing …").
// The manifest (~120KB) is stable for a given (market, productType); persist
// it so a reload paints the grid instantly and the fetch revalidates quietly.
const MANIFEST_LS_VERSION = 1
const MANIFEST_LS_TTL_MS = 24 * 60 * 60 * 1000
const manifestLsKey = (mp: string, pt: string) => `ff-manifest-${mp.toUpperCase()}-${pt.toUpperCase()}`

function loadCachedManifest(mp: string, pt: string): Manifest | null {
  try {
    const raw = localStorage.getItem(manifestLsKey(mp, pt))
    if (!raw) return null
    const p = JSON.parse(raw) as { v?: number; savedAt?: number; manifest?: Manifest }
    if (p?.v !== MANIFEST_LS_VERSION || !p.manifest) return null
    if (Date.now() - (p.savedAt ?? 0) > MANIFEST_LS_TTL_MS) return null
    return p.manifest
  } catch { return null }
}

function saveCachedManifest(mp: string, pt: string, manifest: Manifest): void {
  const write = () =>
    localStorage.setItem(manifestLsKey(mp, pt), JSON.stringify({ v: MANIFEST_LS_VERSION, savedAt: Date.now(), manifest }))
  try { write() } catch {
    // Quota — evict other cached manifests and retry once; on failure the
    // background refresh path still works, we just lose the instant paint.
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i)
        if (k && k.startsWith('ff-manifest-') && k !== manifestLsKey(mp, pt)) localStorage.removeItem(k)
      }
      write()
    } catch { /* give up quietly */ }
  }
}
const _prefetchInFlight = new Set<string>()

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

// FM Phase 2b — synthetic per-market Follow/Pinned control, spliced in right after
// the Quantity column (see effectiveManifest). 'Follow' = quantity tracks the shared
// warehouse pool; 'Pinned' = holds a fixed quantity you set. FBA rows render a
// read-only '—' (Amazon manages FBA stock). Saving routes through the pool-safe
// follow-apply endpoint — the flat file never writes the warehouse pool itself.
const FOLLOW_COL_DESC =
  'Follow = this listing draws from the shared warehouse pool and updates automatically when stock changes. ' +
  'Pinned = this listing holds a fixed quantity you set and ignores the pool. To hold a value: set this to Pinned, then edit the Quantity. ' +
  'Default is Follow. FBA listings show "—" (Amazon manages FBA stock). ' +
  'Your actual stock is managed on the Stock page and imports — saving here never changes it.'
const FOLLOW_COLUMN: Column = {
  id: 'follow', fieldRef: 'follow', labelEn: 'Follow', labelLocal: 'Follow',
  description: FOLLOW_COL_DESC, required: false, kind: 'enum',
  options: ['Follow', 'Pinned'], selectionOnly: true, width: 96,
}

// FM Phase 4 — units reserved from the shared pool so a Following listing never
// oversells (it advertises pool − buffer). Only applies while Following; grayed on
// Pinned (fixed qty ignores it) and FBA (Amazon-managed). Spliced in after Follow.
const BUFFER_COL_DESC =
  'Buffer = units held back from the shared warehouse pool so this listing never oversells — a Following listing then advertises pool − buffer. ' +
  'Useful when several channels draw from one pool. The buffer applies while the listing is Following; on a Pinned listing it is stored and takes effect if you switch it back to Following. FBA is Amazon-managed (shows —).'
const BUFFER_COLUMN: Column = {
  id: 'buffer', fieldRef: 'buffer', labelEn: 'Buffer', labelLocal: 'Buffer',
  description: BUFFER_COL_DESC, required: false, kind: 'number', width: 84,
}

// GX.5 — how many trailing blank "canvas" rows to keep so you can always just
// start typing (auto-grow, like Sheets).
const GHOST_BUFFER = 8
// A ghost row: FULLY blank + NOT _isNew/_dirty, so it looks like a Sheets blank
// canvas and is excluded from counts, save, submit and export. product_type +
// record_action are filled only when it materializes into a real row on edit.
function makeGhostRow(): Row {
  return {
    _rowId: `ghost-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    _isNew: false, _dirty: false, _ghost: true, _status: 'idle',
    item_sku: '',
    product_type: '',
    record_action: '',
    parentage_level: '',
    parent_sku: '',
    variation_theme: '',
  }
}

// ── Variation-family helpers (Add-variation wizard) ─────────────────────
// Mirrors the API-side ffcParseThemeAxes / ffcExtractVariantAxes in
// apps/api/src/services/amazon/flat-file.service.ts so the rows the wizard
// generates carry the SAME axis columns + variation_theme the manifest, the
// product-create importer, and the SP-API push all expect.

/** Amazon variation_theme (e.g. "SIZE_COLOR", "Color/Size", "SizeName-ColorName")
 *  → friendly axis names. Same rule as ffcParseThemeAxes on the API. */
function parseThemeAxes(theme: string | null | undefined): string[] {
  if (!theme) return []
  return theme
    .split(/[_/\s,-]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => {
      const lc = t.toLowerCase()
      // FFP.18 — the IT manifest serves LOCALIZED theme tokens (COLORE/TAGLIA/
      // FORMATO_NOME …); without these mappings the Add-parent panel never
      // "detected" the variation theme on Italian marketplaces.
      if (lc.includes('colour') || lc.includes('color') || lc.includes('colore')) return 'Color'
      if (lc.includes('size') || lc.includes('taglia') || lc.includes('formato')) return 'Size'
      if (lc.includes('material') || lc.includes('materiale')) return 'Material'
      // Strip a trailing "name"/"_name"/"nome" token so "StyleName" → "Style".
      const cleaned = t.replace(/[_-]?(name|nome)$/i, '') || t
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase()
    })
}

/** Candidate child-row COLUMN ids that can hold an axis value, most-preferred
 *  first. Mirrors the columns ffcExtractVariantAxes reads on the API so the
 *  importer/push pick the value back up. Used to pick whichever column the
 *  active manifest actually exposes for the product type. */
function axisColumnCandidates(axis: string): string[] {
  const lc = axis.toLowerCase()
  if (lc === 'color' || lc === 'colour') return ['color', 'color_name']
  if (lc === 'size') return ['size', 'apparel_size', 'shirt_size', 'shoe_size', 'size_name']
  // Generic axis (Style, Material, …): try `<snake>` then `<snake>_name`.
  const snake = lc.replace(/\s+/g, '_')
  return [snake, `${snake}_name`]
}

/** Pick the manifest column id that should hold an axis value: the first
 *  candidate present in the manifest, else the first candidate (still valid for
 *  the importer/push, which read the same bare names). */
function resolveAxisColumnId(axis: string, columnIds: Set<string>): string {
  const candidates = axisColumnCandidates(axis)
  return candidates.find((c) => columnIds.has(c)) ?? candidates[0]
}

function cartesianProduct<T>(arrays: T[][]): T[][] {
  if (!arrays.length) return [[]]
  return arrays.reduce<T[][]>(
    (acc, arr) => acc.flatMap((prev) => arr.map((v) => [...prev, v])),
    [[]],
  )
}

/** Default child item_sku, e.g. PARENT-BLACK-M (uppercased, space→dash). */
function buildChildSku(parentSku: string, comboValues: string[]): string {
  const suffix = comboValues
    .map((v) => v.trim().toUpperCase().replace(/\s+/g, '-'))
    .filter(Boolean)
    .join('-')
  return suffix ? `${parentSku}-${suffix}` : parentSku
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
  const searchParams = useSearchParams()

  const [marketplace, setMarketplace] = useState(initialMarketplace)
  const [productType, setProductType] = useState(initialProductType)

  // Known product types for the current marketplace (from DB cache + catalog)
  const [productTypes, setProductTypes] = useState<Array<{ value: string; source: string }>>([])
  const [, setPtLoading] = useState(false)

  const [manifest, setManifest] = useState<Manifest | null>(initialManifest)

  // MT.3 — multi-category sheet. sheetTypes = the product types in this sheet.
  // >1 ⇒ "union mode": the grid renders the UNION of all types' columns (from
  // /union-template). One type ⇒ the existing single-type editor, untouched.
  const [sheetTypes, setSheetTypes] = useState<string[]>([initialProductType])
  const [unionManifest, setUnionManifest] = useState<Manifest | null>(null)
  const isUnionMode = sheetTypes.length > 1
  // MT.5 — when set (union mode), the grid shows only this category's columns
  // (+ shared/infra), so a wide union sheet stays navigable.
  const [filterType, setFilterType] = useState<string | null>(null)
  // The render side reads effectiveManifest; the (single-type) load path keeps
  // using `manifest`, so single-type mode can't regress.
  const effectiveManifest = useMemo(() => {
    const base = unionManifest ?? manifest
    if (!base) return base
    // MT.5 — in union mode, constrain the Product Type cell to a strict dropdown
    // of the sheet's categories, so each row's category is picked (not typed).
    const unionMode = !!unionManifest
    const opts = ['', ...sheetTypes.map((t) => t.toUpperCase())]
    // FM Phase 2b — splice the synthetic Follow column in immediately after the
    // Quantity column (whichever group holds it). This runs in single-market mode
    // too — the old `!unionManifest` early-return skipped it, so it only appeared
    // in union sheets. `followInjected` guards against a (theoretical) duplicate.
    let followInjected = false
    const groups = base.groups.map((g) => {
      const columns: Column[] = []
      for (const c of g.columns) {
        columns.push(
          unionMode && c.id === 'product_type'
            ? { ...c, kind: 'enum' as ColumnKind, options: opts, selectionOnly: true }
            : c,
        )
        if (c.id === 'fulfillment_availability__quantity' && !followInjected) {
          columns.push(FOLLOW_COLUMN, BUFFER_COLUMN)
          followInjected = true
        }
      }
      return { ...g, columns }
    })
    return { ...base, groups }
  }, [unionManifest, manifest, sheetTypes])

  // MT.3 — the UNION manifest fetch lives in the merged sheetTypes effect
  // below (UFX P4d): union template + newly-added categories' rows are fetched
  // IN PARALLEL and applied in one batched pass, so adding a category paints
  // once instead of paint→widen→grow.

  // Always start from the canonical DB state (SSR initialRows). If localStorage
  // has dirty rows from a previous session we surface a restore banner instead
  // of silently loading stale data — this ensures the flat file always opens
  // showing what is actually in the DB.
  // ── Per-market storage keys ────────────────────────────────────────────
  // FF-MS.1 — derive from the live `marketplace` state, not `initialMarketplace`.
  // The initial prop is captured once at mount; reading from it meant that
  // sort/row-order writes always landed in the FIRST market's keys, even after
  // the user switched. Now writes track the active market.
  const mp = marketplace.toUpperCase()

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

  // UFX P3 — the grid owns + persists the sort config (ff-amazon-{MP}-sort);
  // this mirror (seeded from storage, updated via onSortConfigChange) feeds
  // the market-sync propagation exactly like the old page-level state did.
  const sortConfigRef = useRef<SortLevel[]>([])
  useEffect(() => {
    try { sortConfigRef.current = JSON.parse(localStorage.getItem(`ff-amazon-${mp}-sort`) ?? '[]') } catch { sortConfigRef.current = [] }
  }, [mp])

  function applyOrderToMarkets(targets: string[]) {
    const ids = latestRowsRef.current.map((r) => r._rowId as string)
    for (const m of targets) {
      try { localStorage.setItem(`ff-amazon-${m}-row-order`, JSON.stringify(ids)) } catch {}
      try { localStorage.setItem(`ff-amazon-${m}-sort`, JSON.stringify(sortConfigRef.current)) } catch {}
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

  // ── UFX P3 — grid-owned rows, page-observed via refs (eBay pattern) ──────
  // The shared FlatFileGrid owns the rows state. The page reads live rows via
  // latestRowsRef (updated on every grid render through renderToolbarFetch)
  // and writes through the captured grid setters. `setRows`/`pushSnapshot`
  // shims keep the page's many handlers (submit gathering, feed polling,
  // pull/import apply, copy-to-market …) verbatim.
  const latestRowsRef = useRef<Row[]>([])
  const latestSelectedRowsRef = useRef<Set<string>>(new Set())
  const latestSetRowsRef = useRef<React.Dispatch<React.SetStateAction<BaseRow[]>> | null>(null)
  const latestPushHistoryRef = useRef<((rows: BaseRow[]) => void) | null>(null)
  const latestSetSelectedRowsRef = useRef<React.Dispatch<React.SetStateAction<Set<string>>> | null>(null)
  // Captures ctx.onReload (the grid's own load path) so page-level events —
  // scope change, external invalidation, follow/buffer apply — can reload the
  // MOUNTED grid.
  const onReloadCtxRef = useRef<(() => void) | null>(null)
  const rowsRef = latestRowsRef // alias — kept handlers read rowsRef.current

  const setRows: React.Dispatch<React.SetStateAction<Row[]>> = useCallback((action) => {
    const set = latestSetRowsRef.current
    if (!set) return
    if (typeof action === 'function') {
      set((prev) => (action as (p: Row[]) => Row[])(prev as Row[]) as BaseRow[])
    } else {
      set(action as BaseRow[])
    }
  }, [])

  // Push an undo snapshot of the grid's CURRENT rows (grid pushHistory with
  // the same array reference: history records it, the setState bails out).
  const pushSnapshot = useCallback(() => {
    latestPushHistoryRef.current?.(latestRowsRef.current as BaseRow[])
  }, [])

  // MT.3 / BN.2.3 — derive sheetTypes from the union of the primary product
  // type AND the types actually present in the rows (signalled from
  // renderToolbarFetch on every grid rows change — the grid exposes no
  // onRowsChange). VALUE-GUARD identical to the old effect: no-op when the
  // set is unchanged → no union-manifest refetch churn.
  const syncSheetTypesFromRows = useCallback((rows: Row[], pt: string) => {
    const inUse = productTypesInUse(rows)                                   // distinct UPPERCASE
    const next = Array.from(new Set([pt.toUpperCase(), ...inUse])).filter(Boolean)
    setSheetTypes((prev) => {
      const a = [...prev].map((t) => t.toUpperCase()).sort().join(',')
      const b = [...next].sort().join(',')
      return a === b ? prev : next
    })
  }, [])
  // UFX P4b — set by onGridReload when a composite (multi-category) draft was
  // just restored for the CURRENT (marketplace, primaryType). The grid's mount
  // load runs BEFORE the page's own (mp, pt)-change effects (child effects
  // first), so those effects consult this ref instead of stomping the restored
  // sheetTypes / loadedExtraTypesRef with single-type resets (the MT.4 race).
  const restoredCompositionRef = useRef<{ mp: string; pt: string; types: string[] } | null>(null)
  const restoredCompositionMatches = useCallback((mp: string, pt: string) => {
    const r = restoredCompositionRef.current
    return !!r && r.mp === mp.toUpperCase() && r.pt === pt.toUpperCase()
  }, [])

  // productType/marketplace switches re-derive immediately (rows reload comes
  // separately through the grid's own reload).
  useEffect(() => {
    // UFX P4b — a just-restored composite already set sheetTypes; deriving
    // from latestRowsRef here would read the PREVIOUS market's rows and
    // collapse the union (manifest flip churn).
    if (restoredCompositionMatches(marketplace, productType)) return
    syncSheetTypesFromRows(latestRowsRef.current, productType)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productType, marketplace])

  // Non-null when localStorage has a draft with unsaved edits that differ from
  // the DB rows loaded on this page open.
  const [draftBanner, setDraftBanner] = useState<Row[] | null>(null)

  // Scope: 'listed' = only SKUs with a ChannelListing on this Amazon market (default);
  // 'all' = full catalog. Persisted to localStorage; ignored in family drill-in view.
  const [scope, setScope] = useState<'listed' | 'all'>(() => {
    if (typeof window === 'undefined') return 'listed'
    return (window.localStorage.getItem('amazon-ff-scope') as 'listed' | 'all') || 'listed'
  })
  const scopeRef = useRef(scope)
  useEffect(() => {
    scopeRef.current = scope
    try { window.localStorage.setItem('amazon-ff-scope', scope) } catch {}
  }, [scope])

  const [loading, setLoading] = useState(false)
  // FF-MS.6 — carry which (mp, pt) failed and the HTTP status so the banner
  // can render a market-specific message + tailored copy for 429/5xx/network
  // errors. mp/pt are optional: load failures populate them and unlock the
  // Retry button; operation errors (import/submit/pull) leave them undefined
  // and the banner falls back to a plain message + dismiss.
  // Cleared at the start of every loadData() call.
  type LoadError = { message: string; status?: number; mp?: string; pt?: string; at: number }
  const [loadError, setLoadError] = useState<LoadError | null>(null)

  // ── useFlatFileCore — shared state hook ───────────────────────────────
  // Manages sort, CF rules, filter, smart paste, row images, column groups,
  // panel open states, selection, and undo/redo in a single hook that is
  // shared with EbayFlatFileClient.
  const core = useFlatFileCore<Row, AmazonFilterDims>({
    storageKey: `ff-amazon-${initialMarketplace.toUpperCase()}-${initialProductType?.toUpperCase() ?? 'UNKNOWN'}`,
    initialRows: [],
    makeBlankRow: makeGhostRow,
    initialGroups: (initialManifest?.groups ?? []).map((g) => ({
      id: g.id,
      label: g.labelEn,
      color: g.color,
      columns: g.columns.map((c) => ({
        id: c.id,
        label: c.labelEn,
        kind: c.kind as any,
        description: c.description,
        required: c.required,
        options: c.options,
        guidance: c.guidance,
        maxLength: c.maxLength,
        maxUtf8ByteLength: c.maxUtf8ByteLength,
        width: c.width,
      })),
    })),
    initialFilter: AMAZON_FILTER_DEFAULT,
  })

  // UFX P3 — the shared FlatFileGrid now owns sort / conditional format /
  // filter / smart paste / row images / find&replace / validation panel /
  // AI panel + modal / row selection. The page keeps only the column-group
  // model (Columns modal + controlled group state passed to the grid).
  const {
    columnGroups, setColumnGroups,
    closedGroups, groupOrder, applyGroupSettings,
    columnsOpen, setColumnsOpen,
  } = core


  // Sync columnGroups when effectiveManifest changes (market or productType switch)
  useEffect(() => {
    if (!effectiveManifest) return
    setColumnGroups(
      effectiveManifest.groups.map((g) => ({
        id: g.id,
        label: g.labelEn,
        color: g.color,
        columns: g.columns.map((c) => ({
          id: c.id,
          label: c.labelEn,
          kind: c.kind as any,
          description: c.description,
          required: c.required,
          options: c.options,
          guidance: c.guidance,
          maxLength: c.maxLength,
          width: c.width,
        })),
      })),
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveManifest])

  // Add-rows panel — anchorRowId captures where the panel was opened from
  // (footer selection anchor or context-menu row) so above/below inserts land
  // next to it (the grid owns the live selection now).
  const [addRowsPanel, setAddRowsPanel] = useState<{
    type: 'row' | 'parent' | 'variant'
    position: 'end' | 'above' | 'below'
    anchorRowId?: string
  } | null>(null)

  // ── CG — custom groups + FBA/FBM sections now live in the shared grid ────
  // One-time key migration: the page persisted groups under
  // ff-amazon-{MP}-groups; the shared grid scopes them as
  // ff-{storageKey}-groups with storageKey `ff-amazon-{MP}` →
  // ff-ff-amazon-{MP}-groups. Copy old → new once so operator groups (and
  // the group mode / collapsed set) survive the port.
  useEffect(() => {
    try {
      for (const m of MARKETPLACES) {
        for (const suffix of ['groups', 'group-mode', 'collapsed-groups']) {
          const oldKey = `ff-amazon-${m}-${suffix}`
          const newKey = `ff-ff-amazon-${m}-${suffix}`
          const old = localStorage.getItem(oldKey)
          if (old != null && localStorage.getItem(newKey) == null) localStorage.setItem(newKey, old)
        }
      }
    } catch { /* non-fatal */ }
  }, [])

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
  const { toast } = useToast() // FFS.7 — submit summary + feed-completion notices
  const confirm = useConfirm() // FM Phase 3 — bulk Follow/Pinned confirmation
  const [submitPanelOpen, setSubmitPanelOpen] = useState(false)
  // FFC — pre-publish Review & Confirm gate. A Promise-based modal so Submit can
  // `await` the operator's decision in place of the old crude confirm().
  type ReviewData = {
    markets: string[]
    totalRows: number
    newCount: number
    updateCount: number
    errors: Array<{ mp: string; sku: string; message: string }>
    warnings: Array<{ mp: string; sku: string; message: string }>
  }
  const [reviewModal, setReviewModal] = useState<{ data: ReviewData; resolve: (ok: boolean) => void } | null>(null)
  const [reviewAck, setReviewAck] = useState(false)
  // FFP.10 — double-submit advisory (FFS.7 pain): identical rows to the same
  // markets within 90s is usually an accidental re-click mid-processing.
  const lastSubmitRef = useRef<{ key: string; at: number } | null>(null)
  // FFP.2 — errors are acknowledgeable too (Amazon validates authoritatively);
  // only the compliance + FBA-flip server gates remain hard blocks.
  const [reviewErrorAck, setReviewErrorAck] = useState(false)
  const openReviewModal = useCallback((data: ReviewData) => {
    setReviewAck(false)
    setReviewErrorAck(false)
    return new Promise<boolean>((resolve) => {
      setReviewModal({ data, resolve: (ok) => { setReviewModal(null); resolve(ok) } })
    })
  }, [])
  // submissionHistory is written to localStorage but no longer displayed (HistoryModal fetches live)
  const [submissionHistory, setSubmissionHistory] = useState<SubmissionRecord[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  // versionPanelOpen kept to handle "Version history…" menu — redirects to historyOpen

  const fileInputRef = useRef<HTMLInputElement>(null)

  const [coverageModalOpen, setCoverageModalOpen] = useState(false)
  const [healthModalOpen, setHealthModalOpen] = useState(false)
  const [pullPanelOpen, setPullPanelOpen] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [pullProgress, setPullProgress] = useState<{ progress: number; total: number } | null>(null)
  const [pullResult, setPullResult] = useState<{ pulled: number; skipped: number; failed: number } | null>(null)
  // Diff modal state — populated when a pull job completes and the
  // operator hasn't reviewed the results yet.
  const [pullDiffOpen, setPullDiffOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false) // FX.5b — smart import wizard
  const [importInitialFile, setImportInitialFile] = useState<File | null>(null) // FX.7 — file dropped on the grid
  const [pullDiffData, setPullDiffData] = useState<{
    pulledRows: Row[]
    selectedColumns: 'all' | PullGroupId[]
    skusRequested: string[]
    skusReturned: number
    jobId: string
  } | null>(null)
  const [showSetCategory, setShowSetCategory] = useState(false)
  const [bufferModal, setBufferModal] = useState<{ productIds: string[] } | null>(null) // FM Phase 4
  const [bufferInput, setBufferInput] = useState('1')
  // P1.2 — auto-save indicator
  const [lastLocalSave, setLastLocalSave] = useState<number>(0)
  const [lastSaveTick, setLastSaveTick] = useState<number>(0)
  // P1.3 — column search / quick-jump
  const [colSearchOpen, setColSearchOpen] = useState(false)
  const [colSearchQuery, setColSearchQuery] = useState('')
  useEffect(() => {
    if (!colSearchOpen) return
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('[data-col-search]')) {
        setColSearchOpen(false); setColSearchQuery('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [colSearchOpen])

  // EH.5 — Sticky open-once flags for dynamic-imported modals. Each
  // resolves to true the first time its `open` state goes true, then
  // latches. Gating the JSX with these keeps the chunk + component
  // unmounted until first use (saves initial bundle), then keeps them
  // mounted afterward (preserves in-modal state across open/close).
  const [pendingPullReview, setPendingPullReview] = useState<{
    jobId: string
    rows: Row[]
    skusRequested: string[]
    skusReturned: number
    doneAt: string | null
  } | null>(null)
  // FFX.2 — true when the local grid has diverged from the DB (e.g. a pull that
  // isn't yet round-tripped). Survives Publish clearing _dirty, so a background
  // external reload can't silently overwrite freshly-pulled work. Cleared after
  // a sync-to-DB / fromDB load / discard, when grid == DB again.
  const localDivergedRef = useRef(false)

  // P5: On mount, ask the API if a recent pull job is waiting for
  // review (operator pulled then closed the tab / refreshed before
  // applying). If so, surface a banner with the cached rows so they
  // can resume without re-hitting SP-API.
  useEffect(() => {
    if (!initialProductType || !initialMarketplace) return
    let cancelled = false
    void (async () => {
      try {
        const params = new URLSearchParams({
          channel: 'AMAZON',
          marketplace: initialMarketplace,
          productType: initialProductType,
        })
        const res = await fetch(`${getBackendUrl()}/api/flat-file/pull-job/active?${params}`)
        if (!res.ok || cancelled) return
        const data = await res.json()
        const job = data?.job
        if (!job || cancelled) return
        if (job.status === 'done' && !data.reviewed && Array.isArray(job.rows) && job.rows.length > 0) {
          setPendingPullReview({
            jobId: job.id,
            rows: job.rows as Row[],
            skusRequested: Array.isArray(job.skus) ? job.skus : [],
            skusReturned: typeof job.pulled === 'number' ? job.pulled : (job.rows.length ?? 0),
            doneAt: job.doneAt ?? null,
          })
        }
      } catch {
        // best-effort — banner just won't appear
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // IN.1 — Override badges toggle (default on)
  const [showOverrideBadges, setShowOverrideBadges] = useState<boolean>(() => {
    try { return localStorage.getItem('ff-show-overrides') !== '0' } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('ff-show-overrides', showOverrideBadges ? '1' : '0') } catch {} }, [showOverrideBadges])

  // IN.2 — Cascade button toggle (default on) + row being cascaded
  const [showCascadeButtons, setShowCascadeButtons] = useState<boolean>(() => {
    try { return localStorage.getItem('ff-show-cascade') !== '0' } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('ff-show-cascade', showCascadeButtons ? '1' : '0') } catch {} }, [showCascadeButtons])
  const [cascadeRow, setCascadeRow] = useState<Row | null>(null)

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

  // Respect saved drag order; fall back to Amazon's order for new groups.
  // Uses columnGroups from useFlatFileCore (synced to effectiveManifest) +
  // groupOrder from core for the user-defined reorder.
  const orderedGroups = useMemo<ColumnGroup[]>(() => {
    // Map FlatFileColumnGroup → local ColumnGroup shape (label → labelEn/labelLocal).
    // Falls back to effectiveManifest groups (already the correct shape) when no
    // columnGroups have been loaded yet.
    const manifestById = new Map((effectiveManifest?.groups ?? []).map((mg) => [mg.id, mg]))
    const groups: ColumnGroup[] = columnGroups.length > 0
      ? columnGroups.map((g) => {
          const mg = manifestById.get(g.id)
          return {
            id: g.id,
            labelEn: mg?.labelEn ?? (g as any).labelEn ?? g.label ?? g.id,
            labelLocal: mg?.labelLocal ?? (g as any).labelLocal ?? g.label ?? g.id,
            color: g.color,
            columns: mg?.columns ?? [],
          }
        })
      : (effectiveManifest?.groups ?? [])
    if (!groupOrder.length) return groups
    const byId = new Map(groups.map((g) => [g.id, g]))
    const ordered = groupOrder.map((id) => byId.get(id)).filter(Boolean) as ColumnGroup[]
    const rest = groups.filter((g) => !groupOrder.includes(g.id))
    return [...ordered, ...rest]
  }, [columnGroups, effectiveManifest, groupOrder])

  // BN.1.1 — override display label only; id/fieldRef stay untouched (row keys + serialization).
  const withBrowseNodeLabel = (col: Column): Column =>
    col.id === 'recommended_browse_nodes' || /^recommended_browse_nodes\b/.test(col.fieldRef)
      ? { ...col, labelEn: 'Browse node', labelLocal: 'Browse node' }
      : col

  // UFX P3 — the column groups handed to the shared grid: manifest groups
  // converted to the grid contract (per-type applicability first-class,
  // selectionOnly→strict enums, synthetic Category column after record_action).
  // MT.5 — filterType narrows the union sheet to one category's columns.
  const gridColumnGroups = useMemo(() => {
    const activeFilter = filterType && sheetTypes.map((t) => t.toUpperCase()).includes(filterType) ? filterType : null
    const groups = (effectiveManifest?.groups ?? []).map((g) => ({ ...g, columns: g.columns.map(withBrowseNodeLabel) }))
    return buildGridColumnGroups(groups as AmazonColumnGroup[], { filterType: activeFilter })
  }, [effectiveManifest, filterType, sheetTypes])

  // The grid's VISIBLE columns in its render order (controlled group order +
  // visibility) — used by the column quick-jump (data-ci lookup) and the
  // variant-clone axis resolution.
  const visibleGridColumns = useMemo(() => {
    const byId = new Map(gridColumnGroups.map((g) => [g.id, g]))
    const ordered = groupOrder.length
      ? [
          ...(groupOrder.map((id) => byId.get(id)).filter(Boolean) as typeof gridColumnGroups),
          ...gridColumnGroups.filter((g) => !groupOrder.includes(g.id)),
        ]
      : gridColumnGroups
    return ordered.filter((g) => !closedGroups.has(g.id)).flatMap((g) => g.columns)
  }, [gridColumnGroups, groupOrder, closedGroups])

  const manifestColumns = useMemo<Column[]>(
    () => (effectiveManifest?.groups ?? []).flatMap((g) => g.columns),
    [effectiveManifest],
  )

  // BN.2.1 — browse-node id→path label map (drives the Category chip).
  const browseNodeLabels = useMemo<Record<string, string>>(() => {
    const col = manifestColumns.find((c) => c.id === 'recommended_browse_nodes' || /^recommended_browse_nodes\b/.test(c.fieldRef))
    return col?.optionLabels ?? {}
  }, [manifestColumns])

  // Field ID → label map. Powers the PullDiffModal so the diff table
  // shows "Title" instead of "item_name". Falls back to the field id
  // for any pulled attribute not represented in the manifest.
  const columnLabelMap = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>()
    for (const c of manifestColumns) {
      m.set(c.id, c.labelLocal || c.labelEn || c.id)
    }
    return m
  }, [manifestColumns])

  // UFX P3 — validation is a pure function handed to the grid (per-cell
  // shading + counts + panel live inside FlatFileGrid now).
  const validateRows = useCallback(
    (rows: BaseRow[]) => validateAmazonRows(rows, gridColumnGroups.flatMap((g) => g.columns)),
    [gridColumnGroups],
  )

  // P4 — variation_theme of a child's parent (used by Clone variant to know
  // which axis columns to blank). Computed on demand from the live rows.
  const parentThemeOf = useCallback((row: Row): string => {
    const ps = String(row.parent_sku ?? '')
    if (!ps) return ''
    const parent = latestRowsRef.current.find((r) => !r._ghost && r.parentage_level === 'parent' && String(r.item_sku ?? '') === ps)
    return String(parent?.variation_theme ?? '')
  }, [])

  // WARM — prefetch the Set-category modal chunk before first click so it opens instantly.
  const warmSetCategoryModal = useCallback(() => { void import('./SetCategoryModal') }, [])

  // ── Clipboard / selection / keyboard / drag-reorder / resize ─────────────
  // All owned by the shared FlatFileGrid now (single commitCells write path
  // with central normalizeCellValue enforcement per column def).

  // FFP.2 — rows Submit can send: unsaved edits OR saved-but-not-yet-submitted.
  const publishableOf = (rows: Row[]) => rows.filter((r) => !r._ghost && (r._dirty || r._isNew || r._needsPublish))

  // ── ASIN row thumbnails (UFX P3 — grid getRowImageUrl hook) ──────────────
  // The grid consults getRowImageUrl only while its row-images toggle is on;
  // uncached ASINs are batched into one fetch per frame. Return semantics:
  // string → image, null → skeleton (resolving), undefined → default image_1.
  const imagesByAsinRef = useRef(imagesByAsin)
  useEffect(() => { imagesByAsinRef.current = imagesByAsin }, [imagesByAsin])
  const pendingAsinFetchRef = useRef<Set<string> | null>(null)
  const requestAsinImage = useCallback((asin: string) => {
    if (pendingAsinFetchRef.current) { pendingAsinFetchRef.current.add(asin); return }
    pendingAsinFetchRef.current = new Set([asin])
    setTimeout(() => {
      const batch = [...(pendingAsinFetchRef.current ?? [])]
      pendingAsinFetchRef.current = null
      if (!batch.length) return
      // Mark as pending immediately (null = loading skeleton)
      setImagesByAsin((prev) => {
        const update: Record<string, string | null> = {}
        for (const a of batch) if (!(a in prev)) update[a] = null
        return Object.keys(update).length ? { ...prev, ...update } : prev
      })
      fetch(`${getBackendUrl()}/api/amazon/flat-file/fetch-images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asins: batch, marketplace }),
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
    }, 50)
  }, [marketplace])

  const getRowImageUrl = useCallback((row: BaseRow): string | null | undefined => {
    const asin = row._asin ? String(row._asin) : null
    if (!asin) return undefined // fall back to the grid's default (image_1 → placeholder)
    const cached = imagesByAsinRef.current[asin]
    if (cached === undefined) { requestAsinImage(asin); return null }
    return cached // string = image; null = still resolving (skeleton)
  }, [requestAsinImage])

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
    // GX.5 — never persist ghost (blank canvas) rows; they're re-created on load.
    try { localStorage.setItem(rowStorageKey(mp, pt), JSON.stringify(r.filter((row) => !row._ghost))) } catch {}
  }
  function loadSavedRows(mp: string, pt: string): Row[] | null {
    try {
      const raw = localStorage.getItem(rowStorageKey(mp, pt))
      if (!raw) return null
      let saved: Row[] = JSON.parse(raw)
      // FFP.2 — one-time migration per draft key: 'full_update' used to be the
      // inert default on every pulled row. Now that full_update maps to a real
      // full-replace UPDATE, legacy stored defaults must not silently become
      // one — normalize non-new rows to partial_update ONCE. An explicit
      // full_update picked after this ships round-trips untouched.
      const migrKey = `ff-opmigr1-${rowStorageKey(mp, pt)}`
      if (!localStorage.getItem(migrKey)) {
        saved = saved.map((r) =>
          !r._isNew && !r._ghost && String(r.record_action ?? '') === 'full_update'
            ? { ...r, record_action: 'partial_update' }
            : r,
        )
        try {
          localStorage.setItem(rowStorageKey(mp, pt), JSON.stringify(saved))
          localStorage.setItem(migrKey, '1')
        } catch {}
      }
      return saved
    } catch { return null }
  }

  // UFX P4b — composition pointer: remembers, per market (family-scoped like
  // rowStorageKey), that the last sheet was a union of which types, so the
  // mount restore can find the composite "A+B" draft again. Written by the
  // autosave flush + the explicit draft-save sites (always alongside saveRows,
  // never from transient render states); a single-type storageType REMOVES the
  // pointer, so leaving union mode stops the composite restore.
  function persistSheetComposition(mp: string, storageType: string) {
    try {
      const key = sheetCompositionKey(mp, familyId)
      const val = serializeComposition(storageType)
      if (val) localStorage.setItem(key, val)
      else localStorage.removeItem(key)
    } catch { /* quota / private mode — pointer is best-effort */ }
  }
  function loadSheetComposition(mp: string): string[] | null {
    try { return parseComposition(localStorage.getItem(sheetCompositionKey(mp, familyId))) } catch { return null }
  }

  // MT.4 — the localStorage key suffix for the CURRENT grid. A union (mixed-
  // category) sheet persists under a composite "A+B" key derived from the rows'
  // ACTUAL product types, so a union sheet can NEVER overwrite a per-type sheet's
  // draft (and removing a category can't corrupt one either). Single-type rows →
  // that one type's key (identical to before).
  const computeStorageType = useCallback((rows: Row[], pt: string) => {
    const types = [...new Set(rows.map((r) => String(r.product_type ?? '').toUpperCase()).filter(Boolean))].sort()
    return types.length > 1 ? types.join('+') : (types[0] || pt)
  }, [])
  // Always-fresh handle for the save sites that live in callbacks / unmount
  // cleanup (so they never persist under a stale key). Updated by the grid
  // rows-change signal below.
  const storageTypeRef = useRef(initialProductType)

  // Debounced autosave — fires 1 s after last grid edit (renderToolbarFetch
  // re-renders on every rows change, so it doubles as the rows-changed signal;
  // the grid exposes no onRowsChange). Persists under storageType (composite
  // for a union sheet) so it never clobbers a per-type draft. The key + rows
  // are read from refs at flush time, so edits always land on the market/type
  // they were made in even across a switch.
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const marketplaceRef = useRef(marketplace)
  useEffect(() => { marketplaceRef.current = marketplace }, [marketplace])
  const productTypeRef = useRef(productType)
  useEffect(() => { productTypeRef.current = productType }, [productType])
  const scheduleAutosave = useCallback(() => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    const mpAt = marketplaceRef.current
    autosaveTimerRef.current = setTimeout(() => {
      const rows = latestRowsRef.current
      if (!productTypeRef.current || !rows.length) return
      saveRows(mpAt, storageTypeRef.current, rows)
      // UFX P4b — keep the composition pointer in lockstep with the draft
      // write itself (the flush reads fresh refs, so transient render states
      // never clobber it).
      persistSheetComposition(mpAt, storageTypeRef.current)
      setLastLocalSave(Date.now())
    }, 1000)
  }, [])

  // P1.2 — tick every 15 s to keep "saved X ago" label fresh
  useEffect(() => {
    if (!lastLocalSave) return
    const t = setInterval(() => setLastSaveTick((n) => n + 1), 15000)
    return () => clearInterval(t)
  }, [lastLocalSave])

  // P8.4 — cleanup the latency flash timer on unmount
  useEffect(() => () => {
    if (lastSwitchMsTimerRef.current) clearTimeout(lastSwitchMsTimerRef.current)
  }, [])

  const lastSaveLabel = useMemo(() => {
    if (!lastLocalSave) return null
    const sec = Math.round((Date.now() - lastLocalSave) / 1000)
    if (sec < 5) return 'Draft saved'
    if (sec < 60) return `Saved ${sec}s ago`
    if (sec < 3600) return `Saved ${Math.round(sec / 60)}m ago`
    return 'Saved'
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastLocalSave, lastSaveTick])

  // MT.4 — load each ADDED category's rows into the union grid, so a mixed sheet
  // holds rows of every category (a Jacket row AND a Pants row). The primary
  // type's rows come from loadData; this appends server rows for the extras as
  // they're added (dedup by SKU). The rows-based storageType keeps the combined
  // sheet under its own "A+B" key — no per-type draft is ever corrupted.
  const loadedExtraTypesRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    // UFX P4b — a just-restored composite draft already holds every member
    // type's rows: mark them ALL loaded so the extras loader below doesn't
    // re-append server rows over the draft (this effect runs AFTER the grid's
    // mount load — the MT.4 reset must not undo the restore).
    loadedExtraTypesRef.current = restoredCompositionMatches(marketplace, productType)
      ? new Set(restoredCompositionRef.current!.types)
      : new Set([productType.toUpperCase()])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productType, marketplace])
  // UFX P4d — when a category disappears from the sheet (rows reassigned or
  // removed), prune it from loadedExtraTypesRef so re-adding it refetches its
  // rows (MT.4's mark-before-await otherwise made a removed type permanently
  // "loaded" for the session).
  useEffect(() => {
    const keep = new Set([productType.toUpperCase(), ...sheetTypes.map((t) => t.toUpperCase())])
    for (const t of [...loadedExtraTypesRef.current]) {
      if (!keep.has(t)) loadedExtraTypesRef.current.delete(t)
    }
  }, [sheetTypes, productType])

  // UFX P4d — ONE flow per sheetTypes change: the union manifest AND the
  // newly-added categories' rows are fetched IN PARALLEL, then applied
  // back-to-back in the same microtask (React batches → one render), so
  // adding a category paints once — no paint→widen→grow reflow.
  useEffect(() => {
    if (sheetTypes.length <= 1) { setUnionManifest(null); return }
    let alive = true
    const typesU = sheetTypes.map((t) => t.toUpperCase())
    const toLoad = typesU.filter((t) => !loadedExtraTypesRef.current.has(t))
    for (const t of toLoad) loadedExtraTypesRef.current.add(t) // mark before await → no double-fetch

    const qs = `marketplace=${marketplace}&productTypes=${encodeURIComponent(typesU.join(','))}`
    const manifestP: Promise<Manifest | null> = fetch(`${getBackendUrl()}/api/amazon/flat-file/union-template?${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null) // union manifest is advisory; single-type still works
    const extraRowsP: Promise<Row[][]> = Promise.all(toLoad.map(async (t) => {
      try {
        const q = new URLSearchParams({ marketplace, productType: t })
        if (familyId) q.set('productId', familyId)
        else q.set('scope', scopeRef.current)
        const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/rows?${q}`)
        if (!res.ok) return []
        const d = await res.json()
        return mergeAsinCache(
          (d.rows ?? []).map((r: any) => ({ ...r, product_type: String(r.product_type || t).toUpperCase() })),
          marketplace,
        )
      } catch { return [] /* skip this category */ }
    }))

    void (async () => {
      const [m, extraPerType] = await Promise.all([manifestP, extraRowsP])
      if (!alive) return
      if (m) setUnionManifest(m)
      const incoming = extraPerType.flat()
      if (incoming.length) {
        setRows((prev) => {
          const seen = new Set(prev.map((r) => String(r.item_sku ?? '')))
          const append = incoming.filter((r: Row) => r.item_sku && !seen.has(String(r.item_sku)))
          return append.length ? [...prev, ...append] : prev
        })
      }
    })()
    return () => { alive = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetTypes, marketplace, familyId])

  // Live sync: reload rows from DB when the Matrix or another tab updates
  // channel prices. Skip if the user has unsaved edits — their work takes
  // priority and will overwrite the external change on next Save.
  useInvalidationChannel('channel-pricing.updated', (event) => {
    if (!productType) return
    // FFX.1 — ignore our OWN sync emit. syncToPlatform (Save / feed-DONE) fires
    // channel-pricing.updated; reacting to it here ran loadData(fromDB=true),
    // which overwrote a just-pulled grid + localStorage with the DB
    // representation (the "previous version") — worst after Publish, which
    // clears _dirty so the guard below no longer protects.
    if ((event?.meta as { source?: string } | undefined)?.source === 'amazon-flat-file') return
    // FFX.2 — never force-overwrite local work. _dirty covers unsaved edits;
    // localDivergedRef covers a pulled-but-not-round-tripped grid even after
    // Publish clears _dirty. Surface the external change instead of clobbering.
    if (rowsRef.current.some((r) => r._dirty) || localDivergedRef.current) {
      toast.info('This listing changed elsewhere — use Refresh to load the latest.')
      return
    }
    reloadGridFromServer()
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

  // FF-MS.2 — race-safety guards. Every loadData() call gets a monotonically
  // increasing reqId AND an AbortController. Rapid market switches (IT→DE→FR)
  // abort the in-flight fetch and any late-resolving response is dropped, so
  // the LAST clicked market always wins regardless of network latency.
  const loadReqIdRef = useRef(0)
  const loadAbortRef = useRef<AbortController | null>(null)

  // FF-MS.4 — Stale-while-revalidate client cache. Keyed by "MP:PT".
  // Cache lives at module scope (see _swr above) so it survives navigating
  // away (Amazon → eBay → Amazon) without a round-trip.
  const cacheKey = (mp: string, pt: string) => `${mp.toUpperCase()}:${pt.toUpperCase()}`

  // FF-MS.9 — Switch-latency telemetry. navigateTo() stamps {from, to,
  // startedAt}; loadData() reads it back the moment the new manifest is
  // committed and records click→ready ms tagged with the source (cache
  // vs fetch). Logged to console.info in dev; production code keeps the
  // performance.measure entries so DevTools / RUM probes can pick them up.
  const switchPerfRef = useRef<{ from: string; to: string; startedAt: number } | null>(null)
  const recordSwitchPerf = (mp: string, pt: string, source: 'cache' | 'fetch') => {
    const perf = switchPerfRef.current
    if (!perf) return
    if (perf.to !== `${mp.toUpperCase()}·${pt.toUpperCase()}`) return
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const ms = Math.round(now - perf.startedAt)
    // P8.4 — expose latency to the market tab; clear after 2.5 s
    setLastSwitchMs(ms)
    if (lastSwitchMsTimerRef.current) clearTimeout(lastSwitchMsTimerRef.current)
    lastSwitchMsTimerRef.current = setTimeout(() => setLastSwitchMs(null), 2500)
    if (process.env.NODE_ENV !== 'production') {
      const tag = ms > 1000 ? 'slow' : ms < 50 ? 'instant' : 'ok'
      // eslint-disable-next-line no-console
      console.info(`[FF-MS] ${perf.from} → ${perf.to} · ${ms}ms (${source}, ${tag})`)
    }
    try {
      if (typeof performance !== 'undefined' && 'measure' in performance) {
        performance.measure(`ff-ms:switch:${source}`, { start: perf.startedAt, end: now })
      }
    } catch { /* some browsers reject options syntax; non-fatal */ }
    switchPerfRef.current = null
  }

  // On mount: rows are no longer pre-fetched server-side. Check the SWR cache
  // (warm from a previous visit in this session) for an instant paint, or kick
  // off a client-side loadData() fetch if the cache is cold/stale.
  useEffect(() => {
    if (!initialMarketplace || !initialProductType) return
    const key = cacheKey(initialMarketplace, initialProductType)
    const snap = _swr.get(key)
    const isFresh = !!snap && (Date.now() - snap.fetchedAt) < SWR_TTL_MS
    if (initialManifest && isFresh) {
      // Return visit: the grid paints rows from the module-level cache
      // instantly (initialRows); use the server-provided manifest.
      setManifest(initialManifest)
      _swr.set(key, { ...snap!, manifest: initialManifest })
    } else {
      // First visit, stale cache, OR a missing SSR manifest (initialManifest null
      // — e.g. the CDN template fetch failed/timed out). Previously a null
      // initialManifest bailed out of this effect entirely, so the client never
      // fetched anything and the grid hung on "Preparing schema…". Fall through to
      // loadData(), which fetches manifest+rows client-side (painting from cache
      // first if one exists) so the page always loads.
      void loadData(initialMarketplace, initialProductType)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadData = useCallback(async (mp: string, pt: string, force = false, fromDB = false) => {
    if (!pt.trim()) return
    // Cancel any in-flight load and stake out a new request id.
    loadAbortRef.current?.abort()
    const ctrl = new AbortController()
    loadAbortRef.current = ctrl
    const reqId = ++loadReqIdRef.current
    setLoadError(null)
    setFeedEntries([])

    // FF-MS.4 — Optimistic paint from cache: a fresh SWR snapshot (or the
    // localStorage manifest on a hard reload) unblocks the grid mount
    // immediately; the fetch below revalidates. force=true (Refresh schema)
    // and fromDB=true bypass the optimistic paint.
    let paintedFromCache = false
    if (!force && !fromDB) {
      const snap = _swr.get(cacheKey(mp, pt))
      if (snap && (Date.now() - snap.fetchedAt) < SWR_TTL_MS) {
        setManifest(snap.manifest)
        paintedFromCache = true
        recordSwitchPerf(mp, pt, 'cache')
      } else {
        const cachedManifest = loadCachedManifest(mp, pt)
        if (cachedManifest) {
          setManifest(cachedManifest)
          paintedFromCache = true
          recordSwitchPerf(mp, pt, 'cache')
        }
      }
    }
    if (!paintedFromCache) { setLoading(true); setManifest(null) }

    const backend = getBackendUrl()
    const qs = new URLSearchParams({ marketplace: mp, productType: pt, ...(force ? { force: '1' } : {}) })
    const rowsQs = new URLSearchParams({ marketplace: mp, productType: pt })
    if (familyId) rowsQs.set('productId', familyId)
    else rowsQs.set('scope', scopeRef.current)
    try {
      if (force) {
        // Schema refresh — update manifest only, keep current rows unchanged.
        const mRes = await fetch(`${backend}/api/amazon/flat-file/template?${qs}`, { signal: ctrl.signal })
        if (reqId !== loadReqIdRef.current) return
        if (!mRes.ok) {
          const body = await mRes.json().catch(() => ({}))
          const e = new Error(body.error ?? `HTTP ${mRes.status}`) as Error & { status?: number }
          e.status = mRes.status
          throw e
        }
        const manifest: Manifest = await mRes.json()
        setManifest(manifest)
        // Refresh the cached manifest without disturbing the cached rows.
        const prev = _swr.get(cacheKey(mp, pt))
        _swr.set(cacheKey(mp, pt), { manifest, rows: prev?.rows ?? [], fetchedAt: Date.now() })
        saveCachedManifest(mp, pt, manifest)
      } else {
        // Full load — fetch manifest + rows in parallel. The rows land in the
        // SWR cache: the grid reads them as initialRows on (re)mount, and its
        // own onReload consumes the fresh snapshot without a second fetch.
        const [mRes, rRes] = await Promise.all([
          fetch(`${backend}/api/amazon/flat-file/template?${qs}`, { signal: ctrl.signal }),
          fetch(`${backend}/api/amazon/flat-file/rows?${rowsQs}`, { signal: ctrl.signal }),
        ])
        if (reqId !== loadReqIdRef.current) return
        if (!mRes.ok) {
          const body = await mRes.json().catch(() => ({}))
          const e = new Error(body.error ?? `HTTP ${mRes.status}`) as Error & { status?: number }
          e.status = mRes.status
          throw e
        }
        const manifest: Manifest = await mRes.json()
        setManifest(manifest)
        const freshRows: Row[] = rRes.ok ? mergeAsinCache((await rRes.json()).rows ?? [], mp) : []
        _swr.set(cacheKey(mp, pt), { manifest, rows: freshRows, fetchedAt: Date.now() })
        saveCachedManifest(mp, pt, manifest)
        if (fromDB) {
          // Push server-fresh rows into the mounted grid + reset the draft so
          // grid == DB again (external invalidation / explicit refresh).
          const freshStorageType = computeStorageType(freshRows, pt)
          saveRows(mp, freshStorageType, freshRows)
          persistSheetComposition(mp, freshStorageType) // UFX P4b
          setDraftBanner(null)
          localDivergedRef.current = false
          latestSetRowsRef.current?.(freshRows)
        }
        if (!paintedFromCache) recordSwitchPerf(mp, pt, 'fetch')
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return
      if (reqId !== loadReqIdRef.current) return
      setLoadError({
        message: e?.message ?? 'Failed to load',
        status: typeof e?.status === 'number' ? e.status : undefined,
        mp, pt,
        at: Date.now(),
      })
    } finally {
      if (reqId === loadReqIdRef.current) setLoading(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familyId])

  // ── UFX P3 — the grid's own rows load (onReload prop) ────────────────────
  // Mount / market switch: the autosaved draft wins (FF-MS.5 parity — unsaved
  // edits survive), else a fresh SWR snapshot, else the server. Explicit
  // reloads (File ▸ Reload, Discard, scope change, external invalidation) skip
  // the draft and reset it to match the DB.
  const pendingDraftRestoreRef = useRef(true)
  const pageForceServerRef = useRef(false)

  const onGridReload = useCallback(async (): Promise<BaseRow[]> => {
    const mp = marketplaceRef.current
    const pt = productTypeRef.current
    const firstLoad = pendingDraftRestoreRef.current
    pendingDraftRestoreRef.current = false
    const forceServer = pageForceServerRef.current
    pageForceServerRef.current = false

    if (firstLoad && !forceServer) {
      restoredCompositionRef.current = null
      // UFX P4b — union sheet restore: the composition pointer says the last
      // sheet on this market was a union whose members include the primary;
      // its draft lives under the sorted composite "A+B" key (the exact
      // write-side storageType). Restoring it brings back ALL types' rows and
      // kicks the union-template fetch immediately (sheetTypes), so columns
      // and rows land together.
      const comp = loadSheetComposition(mp)
      if (comp && compositionMatchesPrimary(comp, pt)) {
        const compositeType = compositionStorageType(comp)
        const savedUnion = loadSavedRows(mp, compositeType)
        if (savedUnion && savedUnion.length > 0) {
          restoredCompositionRef.current = { mp: mp.toUpperCase(), pt: pt.toUpperCase(), types: comp }
          loadedExtraTypesRef.current = new Set(comp)
          storageTypeRef.current = compositeType
          setSheetTypes(comp)
          if (savedUnion.some((r) => r._dirty)) setDraftBanner(savedUnion)
          return mergeAsinCache(savedUnion, mp)
        }
        // Stale pointer (composite draft gone) — drop it and fall through.
        persistSheetComposition(mp, pt)
      }
      const saved = loadSavedRows(mp, pt)
      if (saved && saved.length > 0) {
        // Informational banner when the restored draft carries unsaved edits.
        if (saved.some((r) => r._dirty)) setDraftBanner(saved)
        return mergeAsinCache(saved, mp)
      }
      const snap = _swr.get(cacheKey(mp, pt))
      if (snap && (Date.now() - snap.fetchedAt) < SWR_TTL_MS) return snap.rows
    }

    const rowsQs = new URLSearchParams({ marketplace: mp, productType: pt })
    if (familyId) rowsQs.set('productId', familyId)
    else rowsQs.set('scope', scopeRef.current)
    const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/rows?${rowsQs}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const freshRows = mergeAsinCache(d.rows ?? [], mp)
    const prev = _swr.get(cacheKey(mp, pt))
    if (prev) _swr.set(cacheKey(mp, pt), { ...prev, rows: freshRows, fetchedAt: Date.now() })
    // A server reload resets the draft to match the DB (the autosave loop
    // would rewrite it from the fresh rows anyway). UFX P4b — the composition
    // pointer resets with it (single-type fresh rows remove it).
    const freshStorageType = computeStorageType(freshRows, pt)
    saveRows(mp, freshStorageType, freshRows)
    persistSheetComposition(mp, freshStorageType)
    setDraftBanner(null)
    localDivergedRef.current = false
    return freshRows
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [familyId])

  /** Reload the MOUNTED grid with server-fresh rows (draft skipped + reset). */
  const reloadGridFromServer = useCallback(() => {
    if (onReloadCtxRef.current) {
      pageForceServerRef.current = true
      pendingDraftRestoreRef.current = false
      onReloadCtxRef.current()
    } else {
      void loadData(marketplaceRef.current, productTypeRef.current, false, true)
    }
  }, [loadData])

  // Reload rows from DB when scope toggles between 'listed' and 'all'.
  // Skip the initial mount (loadData fires separately in the mount effect).
  const scopeReloadMountedRef = useRef(false)
  useEffect(() => {
    if (!scopeReloadMountedRef.current) { scopeReloadMountedRef.current = true; return }
    if (!productType || !marketplace) return
    reloadGridFromServer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  // FF-MS.4 — Best-effort hover/focus prefetch for market buttons. Fires a
  // fetch for the (mp, currentPT) pair so the click is instant. Aborts if
  // the snapshot is already fresh or another prefetch is in-flight. Errors
  // are swallowed because this is purely speculative work.
  const prefetch = useCallback(async (mp: string, pt: string) => {
    if (!pt.trim()) return
    const key = cacheKey(mp, pt)
    const cached = _swr.get(key)
    if (cached && (Date.now() - cached.fetchedAt) < SWR_TTL_MS) return
    if (_prefetchInFlight.has(key)) return
    _prefetchInFlight.add(key)
    try {
      const backend = getBackendUrl()
      const qs = new URLSearchParams({ marketplace: mp.toUpperCase(), productType: pt.toUpperCase() })
      const rowsQs = new URLSearchParams({ marketplace: mp.toUpperCase(), productType: pt.toUpperCase() })
      if (familyId) rowsQs.set('productId', familyId)
      else rowsQs.set('scope', scopeRef.current)
      const [mRes, rRes] = await Promise.all([
        fetch(`${backend}/api/amazon/flat-file/template?${qs}`),
        fetch(`${backend}/api/amazon/flat-file/rows?${rowsQs}`),
      ])
      if (!mRes.ok) return
      const manifest: Manifest = await mRes.json()
      const rows: Row[] = rRes.ok ? mergeAsinCache((await rRes.json()).rows ?? [], mp) : []
      _swr.set(key, { manifest, rows, fetchedAt: Date.now() })
    } catch { /* prefetch is best-effort */ }
    finally { _prefetchInFlight.delete(key) }
  }, [familyId])

  // ── FF-MS.1 — URL is the source of truth for (marketplace, productType) ──
  // navigateTo() writes the URL synchronously on click; the effect below
  // observes URL changes and drives state + re-fetch. This ordering means
  // a hard refresh during an in-flight switch lands on the NEW market (URL
  // has already updated) instead of snapping back to the previous one.
  // FFP.4 — market memory: entering WITHOUT an explicit ?marketplace adopts
  // the last market you worked on (the editor deep link no longer pins IT).
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search)
      if (params.has('marketplace')) return
      const last = localStorage.getItem('ff-amazon-last-market')?.toUpperCase()
      if (last && (MARKETPLACES as readonly string[]).includes(last) && last !== marketplace.toUpperCase()) {
        // navigateTo is declared below; the effect runs post-render, so the
        // binding is initialized by the time this executes.
        navigateTo(last, productType)
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const navigateTo = useCallback((nextMp: string, nextPt: string) => {
    // FF-MS.5 — Force-flush any pending edits to localStorage before we
    // switch away. The 1s autosave debounce can leave the last few keystrokes
    // unwritten; this catches them so the draft restore banner has the full
    // picture when the user returns.
    if (productType && rowsRef.current.some((r) => r._dirty || r._isNew)) {
      saveRows(marketplace, storageTypeRef.current, rowsRef.current)
      persistSheetComposition(marketplace, storageTypeRef.current) // UFX P4b
    }
    // UFX P3 — the grid remounts for the new (mp, pt); its first load should
    // restore that market's draft (unsaved edits survive a switch).
    pendingDraftRestoreRef.current = true
    // FF-MS.9 — Start the switch-latency timer. loadData() reads this back
    // to compute click→ready ms and tags it with source (cache vs fetch).
    const nextMpU = nextMp.toUpperCase()
    const nextPtU = nextPt.toUpperCase()
    // FFP.4 — market memory: deep links without ?marketplace adopt this.
    try { localStorage.setItem('ff-amazon-last-market', nextMpU) } catch {}
    if (nextMpU !== marketplace.toUpperCase() || nextPtU !== productType.toUpperCase()) {
      switchPerfRef.current = {
        from: `${marketplace}·${productType}`,
        to: `${nextMpU}·${nextPtU}`,
        startedAt: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      }
    }
    const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '')
    params.set('marketplace', nextMpU)
    params.set('productType', nextPtU)
    // Bypass router.replace() to avoid the Next.js server round-trip on every market
    // switch (force-dynamic re-fetches rows on every router navigation). We drive state
    // directly and sync the URL via the History API; the URL effect below is a no-op
    // (marketplace already matches) except on hard refresh or direct-URL navigation.
    window.history.replaceState(null, '', `?${params.toString()}`)
    setMarketplace(nextMpU)
    setProductType(nextPtU)
    void loadData(nextMpU, nextPtU)
  }, [marketplace, productType, familyId, loadData])

  // FF-MS.5 — Per-market dirty counts for the marketplace selector. Reads
  // each other market's localStorage draft (for the CURRENT productType) and
  // counts dirty/new rows. Active market is excluded — its dirty state is
  // already conveyed by the Save / submit button. Recomputes whenever the
  // user switches market or PT, which is exactly when a fresh switch could
  // have stashed a new draft.
  // P8.4 — latency flash on the active market tab
  const [lastSwitchMs, setLastSwitchMs] = useState<number | null>(null)
  const lastSwitchMsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const otherMarketsDirtyCount = useMemo<Record<string, number>>(() => {
    if (typeof window === 'undefined' || !productType) return {}
    const out: Record<string, number> = {}
    const currentMp = marketplace.toUpperCase()
    for (const m of MARKETPLACES) {
      if (m === currentMp) continue
      try {
        const raw = localStorage.getItem(rowStorageKey(m, productType))
        if (!raw) continue
        const saved = JSON.parse(raw) as Row[]
        if (!Array.isArray(saved)) continue
        const n = saved.filter((r) => r._dirty || r._isNew).length
        if (n > 0) out[m] = n
      } catch { /* ignore */ }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketplace, productType, familyId])

  // Read URL params as primitives so the effect's deps are stable.
  const urlMpRaw = searchParams.get('marketplace')
  const urlPtRaw = searchParams.get('productType')

  useEffect(() => {
    const mpUpper = (urlMpRaw ?? initialMarketplace).toUpperCase()
    const ptUpper = (urlPtRaw ?? initialProductType).toUpperCase()
    if (mpUpper === marketplace && ptUpper === productType) return
    pendingDraftRestoreRef.current = true
    setMarketplace(mpUpper)
    setProductType(ptUpper)
    // FF-MS.3 — clear the manifest immediately so the user doesn't see
    // stale fields from the previous market while the new one loads.
    setManifest(null)
    void loadData(mpUpper, ptUpper)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlMpRaw, urlPtRaw])

  // Eager background prefetch — after the initial market finishes loading,
  // silently warm every other market so switching is instant. Uses
  // requestIdleCallback so it doesn't compete with the first render, and
  // the existing prefetch() dedup guard means no double-fetches.
  useEffect(() => {
    if (loading || !manifest || !productType) return
    const currentMp = marketplace.toUpperCase()
    const others = MARKETPLACES.filter((m) => m !== currentMp)
    if (typeof requestIdleCallback !== 'undefined') {
      requestIdleCallback(() => { others.forEach((m) => void prefetch(m, productType)) }, { timeout: 1500 })
    } else {
      setTimeout(() => { others.forEach((m) => void prefetch(m, productType)) }, 1500)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, productType])

  // FF-MS.7 — Alt+1..5 (Option+1..5 on Mac) switches between IT/DE/FR/ES/UK.
  // We match by `e.code` (Digit1..Digit5) because Option+digit on Mac produces
  // special characters (¡™£¢∞) in `e.key`, but the physical key code stays
  // stable. Suppressed when:
  //   - any other modifier is held (avoids stomping browser shortcuts)
  //   - a cell is in edit mode
  //   - focus is in any text field (input/textarea/select/contenteditable)
  // so typing in the data grid or the search box never accidentally triggers
  // a market switch.
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (target?.isContentEditable) return
      const m = /^Digit([1-9])$/.exec(e.code)
      if (!m) return
      const idx = Number(m[1]) - 1
      if (idx < 0 || idx >= MARKETPLACES.length) return
      const next = MARKETPLACES[idx]
      if (next === marketplace) return
      e.preventDefault()
      navigateTo(next, productType)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [marketplace, productType, navigateTo])

  // ── Row operations ─────────────────────────────────────────────────

  // Market-scoped Amazon listing removal: POSTs product ids to the real
  // removal endpoint, then prunes only the rows the server confirmed removed.
  // The Product and its stock are never touched (inventory invariant I2/I3).
  const removeFromAmazon = useCallback(async (rowsToRemove: Row[]) => {
    const targets = rowsToRemove
      .map((r) => ({ productId: String(r._productId ?? ''), marketplace }))
      .filter((t) => t.productId)
    if (!targets.length) return
    try {
      const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { results } = await res.json() as { results: Array<{ productId: string; channelListingsRemoved: number; error?: string }> }
      const removedIds = new Set(results.filter((r) => !r.error && r.channelListingsRemoved > 0).map((r) => r.productId))
      setRows((prev) => prev.filter((r) => !removedIds.has(String(r._productId ?? ''))))
      const removed = removedIds.size
      toast.success(`Removed ${removed} listing${removed === 1 ? '' : 's'} from Amazon ${marketplace} — product and stock kept.`)
    } catch (err) {
      toast.error('Remove from Amazon failed: ' + (err instanceof Error ? err.message : String(err)))
    }
  }, [marketplace, setRows, toast])

  // UFX P3 — selection lives in the grid; page ops read the live capture.
  const deleteSelected = useCallback(async () => {
    const selected = latestSelectedRowsRef.current
    const rowsToRemove = latestRowsRef.current.filter((r) => selected.has(r._rowId as string))
    const n = rowsToRemove.length
    if (!n) return
    if (!confirm(`Remove ${n} listing${n === 1 ? '' : 's'} from Amazon ${marketplace}? The product and its stock stay in Nexus; other channels are untouched.`)) return
    pushSnapshot()
    await removeFromAmazon(rowsToRemove)
    latestSetSelectedRowsRef.current?.(new Set())
  }, [marketplace, pushSnapshot, removeFromAmazon])

  // MT.5 — bulk-set the category for the selected rows (build a mixed sheet fast).
  const bulkSetProductType = useCallback((t: string) => {
    const T = t.toUpperCase()
    const selected = latestSelectedRowsRef.current
    pushSnapshot()
    setRows((prev) => prev.map((r) =>
      selected.has(r._rowId as string) ? { ...r, product_type: T, _dirty: true } : r,
    ))
  }, [pushSnapshot, setRows])

  // UFX P4d — remove a category from a union sheet (chip × → dialog).
  // 'reassign' recategorizes the rows onto another of the sheet's types
  // (browse node cleared — it belonged to the old type; the BN.4.3 advisory
  // prompts for a new one); 'remove' drops the rows from THIS sheet only
  // (they stay on the server / their own single-type sheet). The sheetTypes
  // re-derive + loadedExtraTypesRef prune make re-adding the type refetch.
  const [removeCategoryType, setRemoveCategoryType] = useState<string | null>(null)
  const reassignCategoryRows = useCallback((fromType: string, toType: string) => {
    const F = fromType.toUpperCase()
    const T = toType.toUpperCase()
    if (!T || T === F) return
    pushSnapshot()
    setRows((prev) => prev.map((r) =>
      !r._ghost && String(r.product_type ?? '').toUpperCase() === F
        ? { ...r, product_type: T, recommended_browse_nodes: '', _dirty: true }
        : r))
    setFilterType((f) => (f === F ? null : f))
    setRemoveCategoryType(null)
  }, [pushSnapshot, setRows])
  const removeCategoryRows = useCallback((fromType: string) => {
    const F = fromType.toUpperCase()
    pushSnapshot()
    setRows((prev) => prev.filter((r) => r._ghost || String(r.product_type ?? '').toUpperCase() !== F))
    setFilterType((f) => (f === F ? null : f))
    setRemoveCategoryType(null)
  }, [pushSnapshot, setRows])

  // BN.2.2 — bulk-assign product type + browse node to selected rows.
  const applyCategory = useCallback((c: { productType: string; nodeId: string | null }) => {
    const selected = latestSelectedRowsRef.current
    pushSnapshot()
    setRows((prev) => prev.map((r) =>
      !r._ghost && selected.has(r._rowId as string)
        ? ({ ...assignCategory(r as Record<string, unknown>, c), _dirty: true } as Row)
        : r))
    setSheetTypes((s) => Array.from(new Set([...s, c.productType.toUpperCase()])))
    setShowSetCategory(false)
  }, [pushSnapshot, setRows])

  // FM Phase 3 — bulk Set Follow / Set Pinned on the selected rows, for the active
  // market. Routes through the pool-safe endpoint (never writes the warehouse pool);
  // FBA rows are excluded here and skipped fail-closed server-side. Confirms first
  // because Follow re-points quantity at the pool (can change live Amazon quantity).
  const bulkSetFollow = useCallback(async (follow: boolean) => {
    const selectedIds = latestSelectedRowsRef.current
    const selected = latestRowsRef.current.filter((r) => !r._ghost && selectedIds.has(r._rowId as string))
    const productIds = [...new Set(selected.filter((r) => !isFbaRow(r)).map((r) => String(r._productId ?? '')).filter(Boolean))]
    const fbaCount = selected.filter(isFbaRow).length
    if (productIds.length === 0) {
      toast.error(fbaCount > 0
        ? 'Only FBA listings selected — Amazon manages their stock, so Follow/Pinned does not apply.'
        : 'No listings selected.')
      return
    }
    const verb = follow ? 'Follow' : 'Pinned'
    const ok = await confirm({
      title: `Set ${productIds.length} listing${productIds.length === 1 ? '' : 's'} to ${verb}?`,
      description: follow
        ? `They will track your shared warehouse pool — each listing's live Amazon quantity may change to match it, queuing up to ${productIds.length} quantity sync${productIds.length === 1 ? '' : 's'}.${fbaCount ? ` ${fbaCount} FBA listing${fbaCount === 1 ? '' : 's'} in the selection are skipped (Amazon-managed).` : ''}`
        : `They will hold their current quantity and stop tracking the pool.${fbaCount ? ` ${fbaCount} FBA listing${fbaCount === 1 ? '' : 's'} in the selection are skipped (Amazon-managed).` : ''}`,
      tone: 'warning',
      confirmLabel: `Set ${verb}`,
    })
    if (!ok) return
    try {
      const result = await applyBulkFollow({ productIds, channel: 'AMAZON', markets: [marketplace], follow })
      const parts = [`${result.updated} → ${verb}`]
      if (result.unchanged) parts.push(`${result.unchanged} already ${follow ? 'following' : 'pinned'}`)
      if (result.skippedFba) parts.push(`${result.skippedFba} FBA skipped`)
      toast.success(parts.join(' · '))
      latestSetSelectedRowsRef.current?.(new Set())
      reloadGridFromServer() // refresh follow/qty from DB
    } catch (e) {
      toast.error(`Couldn't apply Follow/Pinned — ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [marketplace, confirm, toast, reloadGridFromServer])

  // FM Phase 3 — select every Pinned listing in the sheet (active market) so the old
  // auto-pins can be reviewed and bulk-set to Follow in two clicks.
  const selectAllPinned = useCallback(() => {
    const ids = latestRowsRef.current.filter((r) => !r._ghost && r.follow === 'Pinned').map((r) => r._rowId as string)
    if (ids.length === 0) { toast.info('No pinned listings in this sheet.'); return }
    latestSetSelectedRowsRef.current?.(new Set(ids))
  }, [toast])

  // FM Phase 4 / FB4 — bulk "Set buffer" on the selected FBM rows, Following or
  // Pinned (Pinned stores the value inert; only FBA stays excluded fail-closed).
  const openBufferModal = useCallback(() => {
    const selectedIds = latestSelectedRowsRef.current
    const selected = latestRowsRef.current.filter((r) => !r._ghost && selectedIds.has(r._rowId as string))
    const productIds = [...new Set(selected
      .filter((r) => (String(r.follow) === 'Follow' || String(r.follow) === 'Pinned')
        && !isFbaRow(r))
      .map((r) => String(r._productId ?? '')).filter(Boolean))]
    if (productIds.length === 0) {
      toast.error('Select some Following or Pinned listings — FBA is Amazon-managed and excluded.')
      return
    }
    setBufferInput('1')
    setBufferModal({ productIds })
  }, [toast])

  const applyBufferModal = useCallback(async () => {
    if (!bufferModal) return
    const buffer = Math.max(0, Math.floor(Number(bufferInput) || 0))
    try {
      const result = await applyBulkBuffer({ productIds: bufferModal.productIds, channel: 'AMAZON', markets: [marketplace], buffer })
      const parts = [`${result.updated} → buffer ${buffer}`]
      if (result.unchanged) parts.push(`${result.unchanged} already ${buffer}`)
      toast.success(parts.join(' · '))
      setBufferModal(null)
      latestSetSelectedRowsRef.current?.(new Set())
      reloadGridFromServer()
    } catch (e) {
      toast.error(`Couldn't set buffer — ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [bufferModal, bufferInput, marketplace, toast, reloadGridFromServer])

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
      '_errorFields', '_feedCode',
      '_suppressed', '_suppressionReason', '_issueCount', '_issueSeverity', '_issueFields',
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
    const anchorId = addRowsPanel?.anchorRowId
    setRows((prev) => {
      if (position === 'end') return [...prev, ...newRows]
      // UFX P3 — insert relative to the anchor row captured when the panel
      // opened (grid selection anchor / context-menu row).
      const idx = anchorId ? prev.findIndex((r) => r._rowId === anchorId) : -1
      if (idx === -1) return [...prev, ...newRows]
      const insertAt = position === 'above' ? idx : idx + 1
      const next = [...prev]
      next.splice(insertAt, 0, ...newRows)
      return next
    })

    setAddRowsPanel(null)
  }, [productType, marketplace, pushSnapshot, addRowsPanel, setRows])

  // Add-variation wizard — insert a whole family (1 parent + the Cartesian
  // product of the axis values as children) in one go. Reuses makeEmptyRow for
  // row shaping and the SAME position-splice logic as handleAddRows.
  const handleAddVariationFamily = useCallback((params: {
    parentSku: string
    productType: string
    variationTheme: string
    axes: Array<{ name: string; columnId: string; values: string[] }>
    position: 'end' | 'above' | 'below'
  }) => {
    const { parentSku, productType: pt, variationTheme, axes, position } = params
    const parent = parentSku.trim()
    if (!parent || axes.length === 0) return

    // Parent row: parentage_level=parent, carries the variation_theme + item_sku.
    const parentRow = makeEmptyRow(pt, marketplace, 'parent')
    parentRow.item_sku = parent
    parentRow.variation_theme = variationTheme

    // Children: Cartesian product of the per-axis value lists.
    const valueLists = axes.map((a) => a.values.map((v) => v.trim()).filter(Boolean))
    const combos = cartesianProduct(valueLists)
    const childRows: Row[] = combos.map((combo) => {
      const child = makeEmptyRow(pt, marketplace, 'child')
      child.item_sku = buildChildSku(parent, combo)
      child.parent_sku = parent
      // Children don't carry the theme; the axis columns carry the values.
      child.variation_theme = ''
      axes.forEach((axis, i) => { child[axis.columnId] = combo[i] ?? '' })
      return child
    })

    const newRows: Row[] = [parentRow, ...childRows]

    pushSnapshot()
    const anchorId = addRowsPanel?.anchorRowId
    setRows((prev) => {
      if (position === 'end') return [...prev, ...newRows]
      const idx = anchorId ? prev.findIndex((r) => r._rowId === anchorId) : -1
      if (idx === -1) return [...prev, ...newRows]
      const insertAt = position === 'above' ? idx : idx + 1
      const next = [...prev]
      next.splice(insertAt, 0, ...newRows)
      return next
    })

    setAddRowsPanel(null)
  }, [marketplace, pushSnapshot, addRowsPanel, setRows])

  // P4.3 — Clone variant: duplicate a child row with axis columns and identity
  // fields cleared so the operator only needs to fill in the new variant's values.
  const handleCloneVariant = useCallback((row: Row) => {
    if (row.parentage_level !== 'child') return
    const theme = parentThemeOf(row)
    const colIdSet = new Set(visibleGridColumns.map((c) => c.id))
    const axisColIds = parseThemeAxes(theme)
      .map((axis) => axisColumnCandidates(axis).find((c) => colIdSet.has(c)))
      .filter((c): c is string => c !== undefined)
    const clone: Row = {
      ...row,
      _rowId: `clone-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      _isNew: true, _dirty: true, _status: 'idle',
      _feedMessage: undefined, _errorFields: undefined, _feedCode: undefined,
      _suppressed: undefined, _suppressionReason: undefined,
      _issueCount: undefined, _issueSeverity: undefined, _issueFields: undefined,
      _listingId: undefined, _asin: undefined, _listingStatus: undefined,
      _productId: undefined, _lastSyncedAt: undefined, _lastSyncStatus: undefined,
      // Clear item_sku and all axis columns — what makes each variant unique
      item_sku: '',
    }
    for (const colId of axisColIds) clone[colId] = ''
    pushSnapshot()
    setRows((prev) => {
      const idx = prev.findIndex((r) => r._rowId === row._rowId)
      const next = [...prev]
      next.splice(idx === -1 ? next.length : idx + 1, 0, clone)
      return next
    })
  }, [parentThemeOf, visibleGridColumns, pushSnapshot, setRows])

  // GX.5 — ghost materialization: the grid materializes the row (its single
  // write path) and asks the page for the infra fields a real Amazon row
  // needs; the edited cell value is applied after, so a user editing
  // product_type itself wins (grid contract).
  // UFX P4d — union sheets: the materialized type is the category the operator
  // is LOOKING AT (the active filter chip); with "All" shown the type is
  // ambiguous — leave it blank: validation prompts for a category, and the
  // feed's parent-fallback + type-skip (P6d) protects a stray submit.
  const filterTypeRef = useRef(filterType)
  useEffect(() => { filterTypeRef.current = filterType }, [filterType])
  const isUnionModeRef = useRef(isUnionMode)
  useEffect(() => { isUnionModeRef.current = isUnionMode }, [isUnionMode])
  const onMaterializeRow = useCallback((): Partial<Row> => ({
    product_type: isUnionModeRef.current ? (filterTypeRef.current ?? '') : productTypeRef.current,
    record_action: 'full_update',
  }), [])

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

  const handleSubmitToMarkets = useCallback(async (markets: Set<string>, scope: SubmitScope = 'edited') => {
    // UFX P3 — live grid rows + selection (the grid owns both now). Captured
    // once per submit so gathering and the pending-status flip stay coherent.
    const rows = latestRowsRef.current
    const selectedRows = latestSelectedRowsRef.current
    // FFP.2 — gather rows per market by SCOPE: 'edited' (dirty/new/needs-publish,
    // the default), 'selected' (grid selection), or 'all' (every real row in
    // view). The active market reads from state; other markets read their
    // localStorage draft — for selected/all they match by SKU, since row ids
    // are per-market.
    const needsPublish = (r: Row) => r._dirty || r._isNew || r._needsPublish
    const scopeSkus: Set<string> =
      scope === 'selected'
        ? new Set(rows.filter((r) => !r._ghost && selectedRows.has(r._rowId as string)).map((r) => String(r.item_sku ?? '')).filter(Boolean))
        : scope === 'all'
          ? new Set(rows.filter((r) => !r._ghost).map((r) => String(r.item_sku ?? '')).filter(Boolean))
          : new Set<string>()
    // FFP.3 — auto-include the parent row: submitting an edited child without
    // its parent hard-failed preflight ("Parent isn't in this submission").
    // When the parent exists in the sheet, bring it along automatically.
    const withParents = (gathered: Row[], all: Row[]): Row[] => {
      const have = new Set(gathered.map((r) => String(r.item_sku ?? '')))
      const out = [...gathered]
      for (const r of gathered) {
        if (String(r.parentage_level ?? '').toLowerCase() !== 'child') continue
        if (String(r.record_action ?? '').toLowerCase() === 'delete') continue
        const ps = String(r.parent_sku ?? '').trim()
        if (!ps || have.has(ps)) continue
        const parent = all.find((p) => !p._ghost && String(p.item_sku ?? '') === ps)
        if (parent) { out.push(parent); have.add(ps) }
      }
      return out
    }
    const gatherRows = (mp: string): Row[] => {
      if (mp === marketplace) {
        if (scope === 'selected') return withParents(rows.filter((r) => !r._ghost && selectedRows.has(r._rowId as string)), rows)
        if (scope === 'all') return rows.filter((r) => !r._ghost)
        return withParents(rows.filter((r) => !r._ghost && needsPublish(r)), rows)
      }
      const saved = loadSavedRows(mp, productType) ?? []
      if (scope === 'edited') return withParents(saved.filter((r) => !r._ghost && needsPublish(r)), saved)
      return withParents(saved.filter((r) => !r._ghost && scopeSkus.has(String(r.item_sku ?? ''))), saved)
    }

    // A5 — pre-flight BEFORE the feed goes out: per market, check required fields /
    // barcodes / main image against the live schema and let the operator review.
    // Non-blocking — they can submit anyway. Advisory: a check failure never blocks.
    type PreflightFlag = { sku: string; issues: Array<{ severity: string; message: string }> }
    try {
      const toCheck = [...markets].map((mp) => ({ mp, rows: gatherRows(mp) })).filter((m) => m.rows.length > 0)
      const checks = await Promise.all(toCheck.map(async ({ mp, rows: toSend }) => {
        try {
          const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/preflight`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows: toSend, marketplace: mp, productType }),
          })
          if (!res.ok) return { mp, flagged: [] as PreflightFlag[] }
          const data = await res.json()
          return { mp, flagged: (data.preflight ?? []) as PreflightFlag[] }
        } catch { return { mp, flagged: [] as PreflightFlag[] } }
      }))
      // FFC — always show the Review & Publish gate (not only on issues), block on
      // errors, acknowledge warnings. Replaces the old warn-only confirm().
      const allErrors: ReviewData['errors'] = []
      const allWarnings: ReviewData['warnings'] = []
      for (const c of checks) {
        for (const p of c.flagged) {
          for (const i of p.issues) {
            const entry = { mp: c.mp, sku: p.sku || '(no SKU)', message: i.message }
            ;(String(i.severity).toLowerCase() === 'error' ? allErrors : allWarnings).push(entry)
          }
        }
      }
      const totalRows = toCheck.reduce((n, m) => n + m.rows.length, 0)
      const newCount = toCheck.reduce((n, m) => n + m.rows.filter((r) => r._isNew).length, 0)
      setSubmitPanelOpen(false)
      const proceed = await openReviewModal({
        markets: toCheck.map((m) => m.mp),
        totalRows,
        newCount,
        updateCount: Math.max(0, totalRows - newCount),
        errors: allErrors,
        warnings: allWarnings,
      })
      if (!proceed) return
    } catch {
      // Pre-flight is advisory — never block a deliberate submit on a check failure.
    }

    // FFP.10 — double-submit advisory. Two rapid submits of the same rows
    // create two live Amazon feeds; warn (never block) inside 90 seconds.
    {
      const submitKey = `${[...markets].sort().join(',')}|${scope}|${[...markets]
        .flatMap((m) => gatherRows(m).map((r) => String(r.item_sku ?? '')))
        .sort()
        .join(',')}`
      const last = lastSubmitRef.current
      if (last && last.key === submitKey && Date.now() - last.at < 90_000) {
        if (!confirm('You submitted these exact rows to the same market(s) less than 90 seconds ago — that feed may still be processing. Submit again anyway?')) return
      }
      lastSubmitRef.current = { key: submitKey, at: Date.now() }
    }

    setSubmitting(true)
    setSubmitPanelOpen(false)
    setFeedEntries([])

    // DSP.7 — Submit now pre-saves the in-memory rows BEFORE firing the
    // feed request. Pre-DSP.7 the active marketplace's edits went to
    // Amazon but were never persisted to localStorage; the operator
    // refreshing or navigating away then "lost" their edits even
    // though they were already at Amazon. createVersion + saveRows
    // are the same calls handleSave makes, so this is a no-op when
    // the operator just clicked Save first — idempotent.
    try {
      createVersion('Auto-save before submit')
      saveRows(marketplace, storageTypeRef.current, rows)
      persistSheetComposition(marketplace, storageTypeRef.current) // UFX P4b
    } catch {
      // Persisting locally is best-effort; never block the submit
      // because the operator already committed to firing it.
    }

    if (markets.has(marketplace)) {
      const sending = new Set(gatherRows(marketplace).map((r) => r._rowId))
      setRows((prev) => prev.map((r) => sending.has(r._rowId) ? { ...r, _status: 'pending' } : r))
    }

    const settled = await Promise.allSettled(
      [...markets].map(async (mp) => {
        const toSend = gatherRows(mp)
        if (!toSend.length) return { mp, feedId: '', skipped: true, dryRun: false, created: 0 }
        const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/submit`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: toSend, marketplace: mp, expandedFields: effectiveManifest?.expandedFields ?? {}, productType }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(`[${mp}] ${data.error ?? 'Submit failed'}`)
        // PD.1 — carry the dry-run flag through so the UI never shows a gated/
        // dry-run no-op as a successful publish (it hid a 30-day outage).
        // FFC — carry the created count so one click (create + publish) is visible.
        return { mp, feedId: data.feedId, skipped: false, dryRun: !!data.dryRun, created: Number(data.created) || 0 }
      })
    )

    const entries: FeedEntry[] = []
    const errors: string[] = []
    const skipped: string[] = []
    const submitted: string[] = []
    const dryRunMarkets: string[] = []
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        if (result.value.skipped) { skipped.push(result.value.mp) }
        else {
          entries.push({ market: result.value.mp, feedId: result.value.feedId, status: 'IN_QUEUE', results: [] })
          submitted.push(result.value.mp)
          if (result.value.dryRun) dryRunMarkets.push(result.value.mp)
        }
      } else if (result.status === 'rejected') {
        errors.push(result.reason?.message ?? 'Submit failed')
      }
    }
    setFeedEntries(entries)
    const isDry = (mp: string) => dryRunMarkets.includes(mp)
    // FFS.7 — explicit summary: skipped markets were silently dropped before
    // (leading to duplicate re-submits), and partial failures were invisible.
    if (errors.length) {
      setLoadError({ message: errors.join(' · '), at: Date.now() })
      toast.error(`Submit failed: ${errors.join(' · ')}`)
    }
    if (submitted.length) {
      const skip = skipped.length ? ` · skipped ${skipped.join(', ')} (no edited rows)` : ''
      const realMarkets = submitted.filter((mp) => !isDry(mp))
      // PD.1 — a dry-run/gated response must NOT read as a successful publish.
      if (dryRunMarkets.length === submitted.length) {
        toast.warning(`⚠ DRY-RUN — validated but NOT published to ${submitted.join(', ')}. Amazon publish mode is not live, so no feed was sent.${skip}`)
      } else if (dryRunMarkets.length > 0) {
        toast.warning(`Submitted to ${realMarkets.join(', ')} · DRY-RUN (not published): ${dryRunMarkets.join(', ')}${skip}`)
      } else {
        toast.success(`Submitted to ${submitted.join(', ')}${skip}`)
      }
      // (serverFeedCount removed — unified HistoryModal fetches live count)
    } else if (skipped.length && !errors.length) {
      toast.warning(`Nothing submitted — ${skipped.join(', ')} had no edited rows to send`)
    }

    // FFC — surface new products created by the submit (runs for dry-run too, since
    // creating a product in Nexus is independent of the Amazon publish gate).
    const totalCreated = settled.reduce(
      (n, r) => n + (r.status === 'fulfilled' && !r.value.skipped ? (r.value.created ?? 0) : 0),
      0,
    )
    if (totalCreated > 0) {
      toast.success(`${totalCreated} new product${totalCreated === 1 ? '' : 's'} created in Nexus — find them in /products`)
    }

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
        dryRun: isDry(entry.market),
      })
    }
    // Create a version snapshot
    createVersion(`Before submit · ${[...markets].join(', ')}`)

    if (markets.has(marketplace)) {
      setRows((prev) => prev.map((r) =>
        r._dirty || r._isNew ? { ...r, _dirty: false, _isNew: false, _status: 'pending' } : r
      ))
    }
    // FFA.2 — clear _dirty/_isNew in OTHER submitted markets' localStorage too, so
    // returning to them doesn't show stale "unsaved" flags (which caused re-submits).
    for (const mp of submitted) {
      if (mp === marketplace) continue
      const saved = loadSavedRows(mp, productType)
      if (!saved) continue
      saveRows(mp, productType, saved.map((r) =>
        r._dirty || r._isNew ? { ...r, _dirty: false, _isNew: false, _status: 'pending' } : r
      ))
    }
    setSubmitting(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketplace, productType, effectiveManifest, saveSubmissionRecord, createVersion, toast, openReviewModal, setRows])

  // ── Platform sync ──────────────────────────────────────────────────
  const [syncStatus, setSyncStatus] = useState<'idle' | 'syncing' | 'synced' | 'error'>('idle')

  const syncToPlatform = useCallback(async (rowsToSync: Row[], isPublished = false): Promise<{ errorSkus: string[] }> => {
    if (!manifest) return { errorSkus: [] }
    // FM Phase 2b — capture per-listing Follow/Pinned intent from the DIRTY rows
    // BEFORE the content save; applied AFTER it (so a Pin snapshots the just-saved
    // quantity). FBA rows carry follow='' and are excluded here; the endpoint also
    // skips FBA fail-closed. Not run on the post-publish resync (isPublished).
    const followByBool = new Map<boolean, Set<string>>()
    // FM Phase 4 — dirty rows' Buffer, grouped by value. FB4 — captured on Pinned
    // rows too (the endpoint stores it inert until the listing Follows); still
    // grayed only on FBA (Amazon-managed). The endpoint no-op-skips unchanged.
    const bufferByValue = new Map<number, Set<string>>()
    // FB-S1 — dirty rows that typed a Follow/Buffer intent but have no _productId
    // yet (new / unpublished): the endpoints match 0 listings, so warn instead of
    // silently dropping the operator's edit.
    const unpublishedIntent = new Set<string>()
    if (!isPublished) {
      for (const r of rowsToSync) {
        if (!(r._dirty || r._isNew)) continue
        const fv = (r as Record<string, unknown>).follow
        const bv = (r as Record<string, unknown>).buffer
        const hasFollowIntent = fv === 'Follow' || fv === 'Pinned'
        const bufN = bv !== '' && bv != null ? Math.max(0, Math.floor(Number(bv))) : NaN
        const hasBufferIntent = Number.isFinite(bufN)
        const pid = String(r._productId ?? '')
        if (!pid) {
          if (hasFollowIntent || hasBufferIntent) unpublishedIntent.add(String(r._rowId))
          continue
        }
        if (hasFollowIntent) {
          const followVal = fv === 'Follow'
          if (!followByBool.has(followVal)) followByBool.set(followVal, new Set())
          followByBool.get(followVal)!.add(pid)
        }
        // FB4 — no longer gated on follow === 'Follow'; a numeric buffer on a Pinned
        // row is sent and the server decides (stores inert until Following).
        if (hasBufferIntent) {
          if (!bufferByValue.has(bufN)) bufferByValue.set(bufN, new Set())
          bufferByValue.get(bufN)!.add(pid)
        }
      }
    }
    setSyncStatus('syncing')
    try {
      const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/sync-rows`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rows: rowsToSync,
          marketplace,
          productType,
          expandedFields: effectiveManifest?.expandedFields ?? {},
          isPublished,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Sync failed')
      setSyncStatus('synced')
      localDivergedRef.current = false // FFX.2 — grid is now persisted to the DB
      // FFA.6 — surface per-SKU sync failures instead of silently reporting "synced".
      const syncErrors: Array<{ sku: string; error: string }> = Array.isArray(data?.errors) ? data.errors : []
      if (syncErrors.length) {
        const sample = syncErrors.slice(0, 3).map((e) => e.sku).filter(Boolean).join(', ')
        toast.warning(`${syncErrors.length} row${syncErrors.length === 1 ? '' : 's'} didn't save${sample ? `: ${sample}${syncErrors.length > 3 ? '…' : ''}` : ''} — ${syncErrors[0]?.error ?? 'see details'}`)
      }
      // A3 — refresh _version from the save so a legitimate second save (same
      // operator, no re-pull) doesn't hit a false optimistic-concurrency conflict.
      // P.2 — also clear _dirty for successfully-synced rows so the draft banner
      // never appears on reload for data that is already in the DB. Rows that had
      // sync errors keep _dirty=true and will trigger the banner on reload.
      const newVersions: Record<string, number> =
        data?.versions && typeof data.versions === 'object' ? data.versions : {}
      const errorSkus = new Set(syncErrors.map((e) => String(e.sku ?? '')).filter(Boolean))
      // FB2 — never apply Follow/Buffer for a row whose CONTENT save failed. Map the
      // failed SKUs back to their productIds and drop them from the apply sets (if a
      // set empties out, it's skipped below).
      if (errorSkus.size > 0 && (followByBool.size > 0 || bufferByValue.size > 0)) {
        const failedPids = new Set<string>()
        for (const r of rowsToSync) {
          if (errorSkus.has(String(r.item_sku ?? ''))) {
            const pid = String(r._productId ?? '')
            if (pid) failedPids.add(pid)
          }
        }
        const pruneSets = (m: Map<unknown, Set<string>>) => {
          for (const [k, ids] of m) {
            for (const p of failedPids) ids.delete(p)
            if (ids.size === 0) m.delete(k)
          }
        }
        pruneSets(followByBool as Map<unknown, Set<string>>)
        pruneSets(bufferByValue as Map<unknown, Set<string>>)
      }
      // The rows this sync actually sent (only they may flip _dirty/_needsPublish).
      const syncedSkus = new Set(rowsToSync.map((r) => String(r.item_sku ?? '')).filter(Boolean))
      // UFX P3 — deferred one tick: when Save runs through the grid, the grid
      // clears _dirty on every row right after onSave resolves; this patch must
      // land AFTER that so failed rows stay dirty and _needsPublish arms Submit.
      setTimeout(() => setRows((prev) => prev.map((r) => {
        const sku = String(r.item_sku ?? '')
        const v = newVersions[sku]
        const withVersion = v != null ? { ...r, _version: v } : r
        if (!r._ghost && errorSkus.has(sku)) {
          // FFA.6 — failed rows keep their unsaved state for a retry.
          return { ...withVersion, _dirty: true }
        }
        if (!r._ghost && syncedSkus.has(sku) && !isPublished) {
          // FFP.2 — a DB save marks the row as still needing an Amazon submit;
          // the post-feed resync (isPublished=true) clears the flag instead.
          // INVARIANT: Save never disarms Submit.
          return { ...withVersion, _dirty: false, _isNew: false, _needsPublish: true }
        }
        if (isPublished && !r._ghost && withVersion._needsPublish) {
          return { ...withVersion, _needsPublish: false }
        }
        return withVersion
      })), 0)
      setTimeout(() => setSyncStatus('idle'), 4000)
      // FFC — surface newly-created products (new SKUs become real Nexus products).
      const createdCount: number = typeof data?.created === 'number' ? data.created : 0
      if (createdCount > 0) {
        toast.success(`${createdCount} new product${createdCount === 1 ? '' : 's'} created in Nexus — find them in /products`)
      }
      emitInvalidation({ type: 'channel-pricing.updated', meta: { marketplace, productType, source: 'amazon-flat-file' } })
      emitInvalidation({ type: 'stock.adjusted', meta: { source: 'amazon-flat-file', marketplace } })
      emitInvalidation({ type: 'product.updated', meta: { source: 'amazon-flat-file', marketplace } })

      // FM Phase 2b — content save persisted; now push each dirty row's Follow/Pinned
      // choice through the pool-safe follow-apply endpoint. It writes all three
      // quantity columns coherently, skips FBA fail-closed, and no-op-skips anything
      // unchanged (so a routine save fires no needless pushes). Failures are surfaced
      // but never roll back the content save.
      // FB-S1 — did we send any ids, and did the endpoints match any live listing?
      // A matched:0 for rows we DID send means the products have no ChannelListing
      // yet, so the operator's Follow/Buffer evaporated — surfaced in the warning below.
      let sentAnyApply = false
      let matchedTotal = 0
      if (followByBool.size > 0) {
        try {
          let followChanged = 0
          for (const [followVal, ids] of followByBool) {
            sentAnyApply = true
            const fr = await fetch(`${getBackendUrl()}/api/listings/follow-master-quantity`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ productIds: [...ids], channel: 'AMAZON', markets: [marketplace], follow: followVal }),
            })
            if (fr.ok) {
              const body = await fr.json().catch(() => ({}))
              followChanged += body?.updated ?? 0
              matchedTotal += body?.matched ?? 0
            } else throw new Error(`follow apply HTTP ${fr.status}`)
          }
          if (followChanged > 0) {
            toast.success(`${followChanged} listing${followChanged === 1 ? '' : 's'} updated (Follow/Pinned)`)
          }
        } catch (e) {
          toast.error(`Follow/Pinned change didn't apply — ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // FM Phase 4 — after Follow/Pinned settled, apply any edited Buffer values
      // (grouped by value) via the pool-safe stock-buffer endpoint. Following listings
      // republish pool−buffer; the endpoint no-op-skips unchanged.
      if (bufferByValue.size > 0) {
        try {
          let bufferChanged = 0
          for (const [buf, ids] of bufferByValue) {
            sentAnyApply = true
            const result = await applyBulkBuffer({ productIds: [...ids], channel: 'AMAZON', markets: [marketplace], buffer: buf })
            bufferChanged += result.updated
            matchedTotal += result.matched ?? 0
          }
          if (bufferChanged > 0) {
            toast.success(`${bufferChanged} listing${bufferChanged === 1 ? '' : 's'} buffer updated`)
          }
        } catch (e) {
          toast.error(`Buffer change didn't apply — ${e instanceof Error ? e.message : String(e)}`)
        }
      }

      // FB-S1 — surface Follow/Buffer intent that couldn't land instead of a silent
      // no-op: unpublished rows (no productId) + rows we sent that matched no listing.
      if (unpublishedIntent.size > 0 || (sentAnyApply && matchedTotal === 0)) {
        const parts: string[] = []
        if (unpublishedIntent.size > 0) {
          const n = unpublishedIntent.size
          parts.push(`${n} unpublished row${n === 1 ? '' : 's'} — publish first, then set Follow/Buffer`)
        }
        if (sentAnyApply && matchedTotal === 0) {
          parts.push('no matching live listing yet for the rows you edited')
        }
        toast.warning(`Follow/Buffer not applied to ${parts.join(' · ')}`)
      }
      return { errorSkus: [...errorSkus] }
    } catch (err) {
      setSyncStatus('error')
      setTimeout(() => setSyncStatus('idle'), 6000)
      // Rethrow — the grid's Save path surfaces the toast and, crucially,
      // keeps the rows dirty (a failed save must never clear unsaved state).
      throw err instanceof Error ? err : new Error('Save failed — check your connection and try again')
    }
  }, [manifest, marketplace, productType, toast])

  // ── UFX P3 — grid Save (onSave prop) ──────────────────────────────────────
  // The grid passes the dirty rows; the wrapper keeps the page's Save
  // semantics: version snapshot + localStorage draft + platform sync
  // (which itself applies Follow/Buffer intent and stamps _needsPublish so
  // Save never disarms Submit).
  const onGridSave = useCallback(async (dirty: BaseRow[]): Promise<{ saved: number; createResult?: { errors?: unknown[] } }> => {
    createVersion('Manual save')
    saveRows(marketplaceRef.current, storageTypeRef.current, latestRowsRef.current)
    persistSheetComposition(marketplaceRef.current, storageTypeRef.current) // UFX P4b
    const { errorSkus } = await syncToPlatform(dirty as Row[], false)
    if (errorSkus.length > 0) {
      // Suppress the grid's generic "Saved N rows" toast; the FFA.6 warning
      // toast from syncToPlatform already carries the per-SKU detail.
      return { saved: Math.max(0, dirty.length - errorSkus.length), createResult: { errors: errorSkus } }
    }
    return { saved: dirty.length }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createVersion, syncToPlatform])

  const pollAllFeeds = useCallback(async () => {
    if (!feedEntries.length) return
    setPolling(true)
    try {
      const updated = await Promise.all(
        feedEntries.map(async (entry) => {
          if (isFeedTerminal(entry.status)) return entry
          const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/feeds/${entry.feedId}`)
          // FFS.5 — guard against non-OK / malformed responses. Previously a 500/429
          // was parsed as data and overwrote the status with `undefined` (looked
          // "stuck"/blank). Keep the entry intact + surface a transient error.
          if (!res.ok) {
            return { ...entry, error: `Status check failed (HTTP ${res.status})` }
          }
          const data = await res.json().catch(() => null)
          if (!data || !data.processingStatus) {
            return { ...entry, error: 'Status check returned no status' }
          }
          if (data.processingStatus === 'DONE' && entry.market === marketplace) {
            const bySkU = new Map<string, FeedResult>((data.results as FeedResult[]).map((r: FeedResult) => [r.sku, r]))
            setRows((prev) => prev.map((r) => {
              const fr = bySkU.get(r.item_sku as string)
              if (!fr) return r
              // Prefer server-resolved issue columns (exact cells Amazon flagged);
              // fall back to the legacy regex-derived fields for older jobs.
              const resolvedCols = (fr.issues ?? [])
                .flatMap((iss) => iss.columns ?? [])
                .map((c) => c.id)
                .filter(Boolean)
              const errorFields = resolvedCols.length ? Array.from(new Set(resolvedCols)) : (fr.fields ?? [])
              return {
                ...r,
                _status: fr.status as Row['_status'],
                _feedMessage: fr.message,
                _errorFields: fr.status === 'error' ? errorFields : [],
                _feedCode: fr.status === 'error' ? (fr.code ?? '') : '',
              }
            }))
          }
          return { ...entry, status: data.processingStatus, results: data.results ?? [], error: undefined }
        })
      )
      setFeedEntries(updated)
      // Persist completed submissions to history + sync to platform when DONE
      for (const entry of updated) {
        if (isFeedTerminal(entry.status)) {
          const ok = entry.results.filter((r: FeedResult) => r.status === 'success').length
          const err = feedErrorCount(entry.results)
          // FFS.7 — notify on completion (the cron/SSE can flip this while the
          // operator is on another screen). Only on the transition into terminal.
          const prev = feedEntries.find((e) => e.feedId === entry.feedId)
          if (prev && !isFeedTerminal(prev.status)) {
            if (entry.status === 'DONE' && err === 0) toast.success(`${entry.market}: feed done — ${ok} SKU${ok === 1 ? '' : 's'} ok`)
            else if (entry.status === 'DONE') toast.warning(`${entry.market}: feed done — ${ok} ok, ${err} error${err === 1 ? '' : 's'}`)
            else toast.error(`${entry.market}: feed ${entry.status}`)
          }
          updateSubmissionRecord(entry.feedId, {
            status: entry.status as SubmissionRecord['status'],
            successCount: ok,
            errorCount: err,
            results: entry.results,
          })
          // On DONE: sync all rows for this market to the platform with isPublished=true
          if (entry.status === 'DONE') {
            const mpRows = entry.market === marketplace
              ? latestRowsRef.current.filter((r) => !r._ghost)
              : (() => {
                  try {
                    const raw = localStorage.getItem(rowStorageKey(entry.market, productType))
                    return raw ? JSON.parse(raw) as Row[] : []
                  } catch { return [] }
                })()
            void syncToPlatform(mpRows, true).catch(() => { /* status chip shows the failure */ })
          }
        } else {
          updateSubmissionRecord(entry.feedId, { status: entry.status as SubmissionRecord['status'] })
        }
      }
    } catch (e: any) { setLoadError({ message: e?.message ?? 'Polling failed', at: Date.now() }) }
    finally { setPolling(false) }
  }, [feedEntries, marketplace, productType, updateSubmissionRecord, syncToPlatform, toast, setRows])

  // FFS.5 — restore in-flight feeds from the server on mount so a reload/reopen
  // never "loses" a submission that's still processing (feedEntries is in-memory
  // only). Doesn't clobber a live session that already has entries.
  useEffect(() => {
    let alive = true
    fetch(`${getBackendUrl()}/api/amazon/flat-file/feeds?limit=30`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !Array.isArray(d?.jobs)) return
        // (serverFeedCount removed — count is fetched inside HistoryModal)
        const inflight = (d.jobs as Array<{ marketplace: string; feedId: string; status: string }>)
          .filter((j) => j.status === 'IN_QUEUE' || j.status === 'IN_PROGRESS')
        if (!inflight.length) return
        setFeedEntries((prev) => prev.length ? prev : inflight.map((j) => ({
          market: j.marketplace, feedId: j.feedId, status: j.status, results: [] as FeedResult[],
        })))
      })
      .catch(() => {})
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // FFS.5 — live status: re-poll when the server pushes a feed status change (the
  // reconcile cron + manual poll both emit). Replaces manual-only "Check".
  useOrderEventsRefresh(() => { void pollAllFeeds() }, {
    eventTypes: ['flat_file_feed.status_changed'],
    debounceMs: 1500,
    enabled: feedEntries.some((e) => !isFeedTerminal(e.status)),
  })

  // ── Import / Export ────────────────────────────────────────────────

  const importFile = useCallback(async (file: File) => {
    createVersion('Before import')
    const content = await file.text()
    const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/parse-tsv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, productType, marketplace }),
    })
    if (!res.ok) { const e = await res.json().catch(() => ({})); setLoadError({ message: e.error ?? 'Import failed', at: Date.now() }); return }
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
  // UFX P4c — union-aware target helpers shared by replicate + copy-to-market.
  // The copied rows' DISTINCT types drive the target schema: mixed types fetch
  // the target's UNION template (that column set is what the target sheet can
  // hold); target drafts are read under the target's own composition pointer
  // and written back under the merge's composite storageType, so a mixed copy
  // restores intact when the target market mounts.
  const STRUCTURAL_COPY_COLS = new Set([
    'item_sku', 'product_type', 'record_action',
    'parentage_level', 'parent_sku', 'variation_theme',
  ])

  async function fetchTargetColIds(target: string, types: string[]): Promise<Set<string>> {
    const backend = getBackendUrl()
    const res = types.length > 1
      ? await fetch(`${backend}/api/amazon/flat-file/union-template?marketplace=${target}&productTypes=${encodeURIComponent(types.join(','))}`)
      : await fetch(`${backend}/api/amazon/flat-file/template?marketplace=${target}&productType=${encodeURIComponent(types[0] ?? productType)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const m: Manifest = await res.json()
    return new Set(m.groups.flatMap((g) => g.columns.map((c) => c.id)))
  }

  // FFA.2 — the target's EXISTING rows: its composite draft (composition
  // pointer), else its single-type draft, else server rows for EVERY copied
  // type (parallel, dedup by SKU).
  async function loadTargetRows(target: string, types: string[]): Promise<Row[]> {
    const comp = loadSheetComposition(target)
    if (comp) {
      const saved = loadSavedRows(target, compositionStorageType(comp))
      if (saved) return saved
    }
    const single = loadSavedRows(target, productType)
    if (single) return single
    const fetched = await Promise.all(types.map(async (t) => {
      try {
        const rq = new URLSearchParams({ marketplace: target, productType: t })
        if (familyId) rq.set('productId', familyId)
        const rr = await fetch(`${getBackendUrl()}/api/amazon/flat-file/rows?${rq}`)
        return rr.ok ? (((await rr.json()).rows ?? []) as Row[]) : []
      } catch { return [] as Row[] }
    }))
    const seen = new Set<string>()
    const out: Row[] = []
    for (const r of fetched.flat()) {
      const sku = String(r.item_sku ?? '')
      if (sku) {
        if (seen.has(sku)) continue
        seen.add(sku)
      }
      out.push(r)
    }
    return out
  }

  // BM.2 — multi-target replicate used by FFReplicateModal
  const handleReplicate = useCallback(async (
    targets: string[],
    groupIds: Set<string>,
    selectedOnly: boolean,
  ): Promise<{ copied: number; skipped: number }> => {
    const sourceManifest = effectiveManifest
    if (!sourceManifest) return { copied: 0, skipped: 0 }
    const rows = latestRowsRef.current.filter((r) => !r._ghost)
    const selectedRows = latestSelectedRowsRef.current
    // UFX P4c — column ids come from the EFFECTIVE (union-aware) manifest, so
    // replicating a mixed sheet offers every category's columns.
    const allColIds = sourceManifest.groups
      .filter((g) => groupIds.has(g.id))
      .flatMap((g) => g.columns.map((c) => c.id))
    const colSet = new Set(allColIds)
    const sourceRows = selectedOnly && selectedRows.size > 0
      ? rows.filter((r) => selectedRows.has(r._rowId as string))
      : rows
    const copyTypes = productTypesInUse(sourceRows as Array<Record<string, unknown>>)
    const typesForTarget = copyTypes.length ? copyTypes : [productType.toUpperCase()]
    let copied = 0
    let skipped = 0
    for (const target of targets) {
      try {
        const targetColIds = await fetchTargetColIds(target, typesForTarget)
        const cols = new Set([...colSet].filter((c) => targetColIds.has(c)))
        const existingTarget = await loadTargetRows(target, typesForTarget)
        const merged = mergeReplicatedRows(existingTarget, sourceRows, cols, STRUCTURAL_COPY_COLS)
        // UFX P4c — persist under the merge's composite storageType + pointer
        // (single-type merges keep the legacy per-type key, pointer removed).
        const targetStorageType = computeStorageType(merged, productType)
        saveRows(target, targetStorageType, merged)
        persistSheetComposition(target, targetStorageType)
        copied += sourceRows.length
      } catch { skipped += sourceRows.length }
    }
    return { copied, skipped }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveManifest, productType, familyId, computeStorageType])

  const handleCopyToMarket = useCallback(async (
    targetMarket: string,
    colIds: Set<string>,
  ) => {
    const rows = latestRowsRef.current.filter((r) => !r._ghost)
    if (!effectiveManifest || !rows.length) return
    setPushPanel(null)
    try {
      // UFX P4c — target template = UNION over the copied rows' distinct types
      // (a JACKET+PANTS sheet copies both categories' columns); single-type
      // sheets keep the plain template fetch.
      const copyTypes = productTypesInUse(rows as Array<Record<string, unknown>>)
      const typesForTarget = copyTypes.length ? copyTypes : [productType.toUpperCase()]
      const targetColIds = await fetchTargetColIds(targetMarket, typesForTarget)
      const cols = new Set([...colIds].filter((c) => targetColIds.has(c)))
      // FFA.2 — merge into the target's existing rows by SKU (don't replace the
      // grid with copies-only, which shadowed the target's real rows).
      const existingTarget = await loadTargetRows(targetMarket, typesForTarget)
      const merged = mergeReplicatedRows(existingTarget, rows, cols, STRUCTURAL_COPY_COLS)

      // UFX P3 — persist the merge as the target market's draft and switch
      // through the normal navigation: the grid remounts for the new market
      // and its first load restores this draft (mergeReplicatedRows marked
      // the copies _dirty, so nothing publishes without an explicit Save).
      // UFX P4c — the composition pointer makes that restore union-aware, and
      // the CURRENT sheet's manifest/types are never touched.
      const targetStorageType = computeStorageType(merged, productType)
      saveRows(targetMarket, targetStorageType, merged)
      persistSheetComposition(targetMarket, targetStorageType)
      setFeedEntries([])
      navigateTo(targetMarket, productType)
    } catch (e: any) {
      setLoadError({ message: e?.message ?? 'Copy failed', at: Date.now() })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveManifest, productType, familyId])

  // ── Pull from Amazon (full attributes, in-editor, undoable) ─────────
  // Calls /api/amazon/flat-file/pull-preview which fetches live SP-API data
  // per SKU and returns expanded flat-file rows WITHOUT touching the DB.
  // We merge the returned columns into editor state via pushSnapshot() so
  // Cmd+Z reverts the entire pull as one step.
  const handlePullFromAmazon = useCallback(async (opts: {
    scope: 'selected' | 'visible' | 'all'
    columns: 'all' | PullGroupId[]
  }) => {
    if (!productType) return

    const rows = latestRowsRef.current
    const selectedRows = latestSelectedRowsRef.current
    let targetSkus: string[]
    if (opts.scope === 'selected') {
      targetSkus = [...selectedRows]
        .map((id) => rows.find((r) => r._rowId === id)?.item_sku as string | undefined)
        .filter((s): s is string => !!s)
    } else {
      // 'visible' ≈ 'all' now (the grid owns search/filter state; every real
      // row in the sheet is pulled).
      targetSkus = rows
        .filter((r) => !r._ghost)
        .map((r) => r.item_sku as string | undefined)
        .filter((s): s is string => !!s)
    }

    if (!targetSkus.length) {
      setLoadError({ message: 'No SKUs to pull', at: Date.now() })
      return
    }

    setPullPanelOpen(false)
    setPulling(true)
    setPullProgress({ progress: 0, total: targetSkus.length })
    setPullResult(null)

    try {
      const startRes = await fetch(
        `${getBackendUrl()}/api/amazon/flat-file/pull-preview/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ marketplace, productType, skus: targetSkus }),
        },
      )
      const startData = await startRes.json()
      if (!startRes.ok) throw new Error(startData.error ?? 'Pull failed to start')
      const { jobId } = startData

      let job: any = null
      // Poll every 1.5s. SP-API per-SKU is rate-limited, ~280 SKUs ≈ 2-5 min.
      for (let i = 0; i < 1200; i++) {
        await new Promise((r) => setTimeout(r, 1500))
        const statusRes = await fetch(
          `${getBackendUrl()}/api/amazon/flat-file/pull-preview/status/${jobId}`,
        )
        if (!statusRes.ok) throw new Error('Pull status check failed')
        job = await statusRes.json()
        setPullProgress({ progress: job.progress, total: job.total })
        if (job.status === 'done' || job.status === 'failed') break
      }

      if (!job || job.status !== 'done') {
        throw new Error(job?.fatalError ?? 'Pull timed out')
      }

      const pulledRows: Row[] = Array.isArray(job.rows) ? job.rows : []

      // Hand off to the diff-preview modal. The merge into editor state
      // happens in handlePullDiffApply when the operator confirms.
      setPullDiffData({
        pulledRows,
        selectedColumns: opts.columns,
        skusRequested: targetSkus,
        skusReturned: pulledRows.length,
        jobId,
      })
      setPullDiffOpen(true)
    } catch (e: any) {
      setLoadError({ message: e?.message ?? 'Pull from Amazon failed', at: Date.now() })
    } finally {
      setPulling(false)
      setPullProgress(null)
    }
  }, [marketplace, productType])

  // Called by PullDiffModal on Apply. Merges the chosen rows/columns
  // into editor state (wrapped in pushSnapshot so ⌘Z reverts the
  // whole pull as one step) and writes an audit-log row.
  const handlePullDiffApply = useCallback(async (result: PullDiffApplyResult) => {
    if (!pullDiffData) return

    const { pulledRows, selectedColumns, skusRequested, skusReturned, jobId } = pullDiffData
    const bySku = new Map<string, Row>(
      pulledRows.map((r) => [String(r.item_sku ?? ''), r]),
    )
    const selectedSet = new Set(result.selectedRowIds)
    const isAllColumns = selectedColumns === 'all'
    const groupFilter = new Set(isAllColumns ? [] : (selectedColumns as PullGroupId[]))

    pushSnapshot()
    // Per-SKU ASIN + status entries to persist to the local cache so they
    // survive row reloads (the legacy Fetch-from-Amazon button used to do
    // this; we keep the same behaviour now that Pull is the only path).
    const asinCacheEntries: Record<string, { asin?: string; status?: string }> = {}
    setRows((prev) => prev.map((row) => {
      if (!selectedSet.has(String(row._rowId))) return row
      const sku = String(row.item_sku ?? '')
      const pulled = bySku.get(sku)
      if (!pulled) return row

      const merged: Row = { ...row }
      let changed = false
      for (const [k, v] of Object.entries(pulled)) {
        if (k.startsWith('_')) continue
        if (!isAllColumns && !groupFilter.has(pullFieldGroup(k))) continue
        if (merged[k] === v) continue
        merged[k] = v
        changed = true
      }
      const pulledAsin = (pulled as any)._asin
      const pulledStatus = (pulled as any)._listingStatus
      if (pulledAsin) merged._asin = pulledAsin
      if (pulledStatus) merged._listingStatus = pulledStatus
      if (sku && (pulledAsin || pulledStatus)) {
        asinCacheEntries[sku] = { asin: pulledAsin || undefined, status: pulledStatus || undefined }
      }
      if (changed) merged._dirty = true
      return changed ? merged : row
    }))
    if (Object.keys(asinCacheEntries).length) writeAsinCache(marketplace, asinCacheEntries)
    localDivergedRef.current = true // FFX.2 — grid now diverges from DB until synced

    setPullResult({
      pulled: result.selectedRowIds.length,
      skipped: skusReturned - result.selectedRowIds.length,
      failed: 0,
    })
    setTimeout(() => setPullResult(null), 10000)
    setPullDiffOpen(false)
    setPullDiffData(null)

    // Write audit log. Fire-and-forget — a failed audit row shouldn't
    // block the operator's edits from landing.
    void fetch(`${getBackendUrl()}/api/amazon/flat-file/pull-preview/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId,
        marketplace,
        productType,
        skusRequested,
        skusReturned,
        columnsApplied: isAllColumns ? ['all'] : result.groupsApplied,
        rowsApplied: result.selectedRowIds.length,
        fieldsApplied: result.fieldsApplied,
      }),
    }).catch(() => { /* best-effort */ })
  }, [pullDiffData, pushSnapshot, marketplace, productType])

  // FX.5b — apply the smart-import wizard's chosen cells into the grid: update
  // existing rows in place (by _rowId) + append new rows; one undoable snapshot.
  const handleImportApply = useCallback((result: ImportApplyResult) => {
    pushSnapshot()
    // F.2 — build the post-import rows imperatively (from the live ref) so we can
    // both render them AND persist them in the same handler. Applying an import is
    // an explicit user action, so it SAVES immediately — the backend FFC creates
    // any new products and syncToPlatform surfaces created/skipped feedback —
    // rather than silently staging rows that then look like a stale "draft" on
    // reload. (Not the silent-auto-save anti-pattern: the operator clicked Import.)
    const prev = rowsRef.current
    const next = [...prev]
    const idxById = new Map(next.map((r, i) => [String(r._rowId), i]))
    for (const u of result.updates) {
      const idx = idxById.get(u.rowId)
      if (idx == null) continue
      next[idx] = { ...next[idx], ...u.cells, _dirty: true }
    }
    // F.1 — family mode: when the operator is viewing a specific parent's family
    // (?familyId=xxx) and imports a file that doesn't carry parent_sku /
    // parentage_level on every row (common for supplier CSV dumps or simple SKU
    // lists), stamp those structural fields onto every new row whose parent_sku
    // is still blank. The parent SKU is resolved from the parent row already in
    // the grid (the row with parentage_level='parent'). Without this, new rows
    // save to DB with parentId=null and never appear in the Matrix tab.
    const familyParentSku = familyId
      ? String(prev.find((r) => r.parentage_level === 'parent' && r.item_sku)?.item_sku ?? '')
      : ''
    for (const n of result.newRows) {
      const row = makeEmptyRow(productType, marketplace)
      Object.assign(row, n.cells, { _dirty: true, _isNew: true })
      if (familyId && familyParentSku && !String(row.parent_sku ?? '').trim()) {
        row.parent_sku = familyParentSku
        row.parentage_level = 'child'
      }
      next.push(row)
    }
    setRows(next)
    setImportOpen(false); setImportInitialFile(null)
    const newCount = result.newRows.length
    toast.success(
      `Imported ${result.cellCount} value${result.cellCount === 1 ? '' : 's'}` +
      `${newCount ? ` · creating ${newCount} product${newCount === 1 ? '' : 's'}` : ''} · saving…`,
    )
    void syncToPlatform(next.filter((r) => !r._ghost), false).catch(() => { /* sync chip shows the failure */ })
  }, [pushSnapshot, setRows, productType, marketplace, syncToPlatform, familyId])

  // FX.1 — export the grid to TSV (Amazon template), CSV, or XLSX. Uses
  // effectiveManifest so a multi-category (MT) union sheet exports every column;
  // honors the current row selection so "export selected" is partial export.
  const exportFile = useCallback(async (format: 'tsv' | 'csv' | 'xlsx') => {
    const mf = effectiveManifest ?? manifest
    if (!mf) return
    const selectedRows = latestSelectedRowsRef.current
    const selectedOnly = selectedRows.size > 0
    const exportable = latestRowsRef.current.filter((r) => !r._ghost) // GX.5 — never export blank canvas rows
    const outRows = selectedOnly ? exportable.filter((r) => selectedRows.has(r._rowId as string)) : exportable
    if (!outRows.length) { toast.warning('No rows to export'); return }
    // Export in the editor's on-screen column order (orderedGroups — respects the
    // saved group drag-order), not the raw Amazon schema order, so the file's
    // columns match exactly what's shown in the grid. Safe for Amazon uploads:
    // the flat file matches columns by header name, not position.
    const exportManifest = { ...mf, groups: orderedGroups.length ? orderedGroups : mf.groups }
    try {
      const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/export`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest: exportManifest, rows: outRows, format }),
      })
      if (!res.ok) { toast.error('Export failed'); return }
      const blob = await res.blob()
      const ext = format === 'tsv' ? 'txt' : format
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `amazon_${productType}_${marketplace}${selectedOnly ? `_${outRows.length}sel` : ''}.${ext}`
      a.click()
      URL.revokeObjectURL(url)
      toast.success(`Exported ${outRows.length} row${outRows.length === 1 ? '' : 's'} as ${ext.toUpperCase()}`)
    } catch {
      toast.error('Export failed')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, effectiveManifest, orderedGroups, productType, marketplace])

  // ── Save / Discard — owned by the shared grid (onSave / Discard button) ──

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

  // P4 — jump-to-cell from the feed-report panel: delegated to the grid's
  // imperative API (clears search/collapse, selects + scrolls).
  const gridApiRef = useRef<FlatFileGridApi | null>(null)
  const handleGoToCell = useCallback((sku: string, columnId: string) => {
    gridApiRef.current?.goToCell(sku, columnId)
  }, [])

  // ⌘⇧G — column quick-jump (the grid owns the rest of the keyboard).
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'G') { e.preventDefault(); setColSearchOpen((o) => !o) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ── Grid contract pieces ───────────────────────────────────────────────

  // Blank row factory: fully blank (like the old ghost rows). The grid builds
  // ghosts from this (forcing _ghost:true, _isNew/_dirty false); real infra
  // fields are stamped by onMaterializeRow when a ghost is first edited.
  const makeBlankRow = useCallback((): BaseRow => ({
    _rowId: `new-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    _isNew: true, _dirty: true, _status: 'idle',
    item_sku: '',
    product_type: '',
    record_action: '',
    parentage_level: '',
    parent_sku: '',
    variation_theme: '',
  }), [])

  // FBA-MANAGED CELLS (INVARIANT — never weaken): quantity + Follow + Buffer
  // hard-lock on FBA rows. Every edit-entry and bulk-write path is blocked
  // centrally by the grid (getCellReadOnly → commitCells filter).
  const getCellReadOnly = useCallback((col: FlatFileColumn, row: BaseRow) => isFbaManagedCell(col.id, row), [])

  // Parentage greying — 'not-applicable' shading + tooltip, still editable
  // (union per-type greying is built into the grid via applicableProductTypes).
  const getCellGuidance = useCallback((col: FlatFileColumn, row: BaseRow): 'not-applicable' | 'optional' | null => {
    if (!col.applicableParentage?.length) return null
    const parentage = String(row.parentage_level ?? '').toLowerCase()
    const rowType = parentage === 'parent' ? 'VARIATION_PARENT'
      : parentage === 'child' ? 'VARIATION_CHILD'
      : 'STANDALONE'
    return col.applicableParentage.includes(rowType) ? null : 'not-applicable'
  }, [])

  // FBA/FBM auto-sections (grid bucketMode) — parent follows its FBA children.
  const bucketMode = useMemo(() => ({
    label: 'FBA/FBM',
    buckets: [
      { key: 'FBA', name: 'FBA', color: 'blue' as const },
      { key: 'FBM', name: 'FBM', color: 'amber' as const },
    ],
    bucketFor: (row: BaseRow, rows: BaseRow[]) => fbaBucketFor(row, rows),
  }), [])

  // Cell display overrides: FBA-managed cells render '—' even when a value
  // exists (Amazon parity); the derived Category column renders its chip.
  const renderCellContent = useCallback((col: FlatFileColumn, row: BaseRow, _value: unknown, _displayVal: string): React.ReactNode | null => {
    if (isFbaManagedCell(col.id, row)) {
      return <span title="Managed by Amazon for FBA listings — set stock on the Stock page">—</span>
    }
    if (col.id === '__category') {
      if (row._ghost) return <span className="text-slate-300 dark:text-slate-600">—</span>
      const cat = categoryOf(row as Record<string, unknown>, browseNodeLabels)
      const crumb = formatNodeBreadcrumb(cat.nodePath)
      if (!cat.productType && !cat.nodeId) return <span className="text-slate-300 dark:text-slate-600">—</span>
      return (
        <span className="flex items-center gap-1.5 min-w-0" title={cat.nodePath ?? undefined}>
          {cat.productType && <Badge variant="info" size="sm">{cat.productType}</Badge>}
          {crumb && <span className="text-[11px] text-slate-600 dark:text-slate-300 truncate">{crumb}</span>}
          {!cat.nodeId && cat.productType && <span className="text-[10px] text-amber-500 shrink-0">no node</span>}
        </span>
      )
    }
    return null
  }, [browseNodeLabels])

  // ── Slot: channel strip ──────────────────────────────────────────────────
  const renderChannelStrip = useCallback(() => (
    <ChannelStrip channel="amazon" marketplace={marketplace} familyId={familyId} />
  ), [marketplace, familyId])

  // ── Slot: fetch group (also the rows-changed signal / live-refs capture) ──
  const lastSignalledRowsRef = useRef<Row[] | null>(null)
  const sheetTypesSigRef = useRef('')
  const renderToolbarFetch = useCallback((ctx: ToolbarFetchCtx) => {
    // Keep refs current so every page handler acts on the latest grid state.
    latestRowsRef.current = ctx.rows as Row[]
    latestSelectedRowsRef.current = ctx.selectedRows
    latestSetRowsRef.current = ctx.setRows
    latestPushHistoryRef.current = ctx.pushHistory
    latestSetSelectedRowsRef.current = ctx.setSelectedRows

    // Rows-changed signal: this slot re-renders on every grid render; only a
    // NEW rows array re-arms the autosave debounce + derived-state syncs.
    if (lastSignalledRowsRef.current !== ctx.rows) {
      lastSignalledRowsRef.current = ctx.rows as Row[]
      storageTypeRef.current = computeStorageType(ctx.rows as Row[], productTypeRef.current)
      scheduleAutosave()
      const sig = productTypesInUse(ctx.rows as Array<Record<string, unknown>>).sort().join(',')
      if (sig !== sheetTypesSigRef.current) {
        sheetTypesSigRef.current = sig
        const rows = ctx.rows as Row[]
        setTimeout(() => syncSheetTypesFromRows(rows, productTypeRef.current), 0)
      }
    }

    return (
      <>
        {/* Pull from Amazon — full attribute pull (in-memory, undoable via ⌘Z) */}
        <div className="relative">
          <SharedTbBtn
            icon={<Download className="w-3.5 h-3.5" />}
            title={`Pull from Amazon ${marketplace} — full attribute pull, undoable with ⌘Z. Does not touch the database until you click Save.`}
            onClick={() => setPullPanelOpen((o) => !o)}
            disabled={!manifest || pulling || !ctx.rows.length}
            active={pullPanelOpen}
          />
          {pullPanelOpen && (
            <PullFromAmazonPanel
              selectedCount={ctx.selectedRows.size}
              visibleCount={ctx.rows.filter((r) => !r._ghost).length}
              totalCount={ctx.rows.filter((r) => !r._ghost).length}
              currentMarket={marketplace}
              pulling={pulling}
              onPull={handlePullFromAmazon}
              onClose={() => setPullPanelOpen(false)}
            />
          )}
        </div>
        {/* P8.1 — Feed sparkline: last 10 submissions as coloured dots */}
        {submissionHistory.length > 0 && (() => {
          const dots = submissionHistory.slice(-10)
          return (
            <button
              type="button"
              onClick={() => setHistoryOpen(true)}
              title={`Last ${dots.length} submission${dots.length !== 1 ? 's' : ''} — click to open history`}
              className="inline-flex items-center gap-px h-7 px-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              aria-label="Feed submission history sparkline"
            >
              {dots.map((sub, i) => {
                const isTerminalOk = sub.status === 'DONE' && (sub.errorCount ?? 0) === 0
                const isTerminalWarn = sub.status === 'DONE' && (sub.errorCount ?? 0) > 0
                const isFatal = sub.status === 'FATAL' || sub.status === 'CANCELLED'
                const cls = isFatal ? 'bg-red-500 dark:bg-red-400'
                  : isTerminalWarn ? 'bg-amber-400 dark:bg-amber-300'
                  : isTerminalOk ? 'bg-emerald-500 dark:bg-emerald-400'
                  : 'bg-slate-300 dark:bg-slate-600 animate-pulse'
                return (
                  <span
                    key={`${sub.id}-${i}`}
                    className={`inline-block w-1.5 h-4 rounded-sm ${cls}`}
                    title={`${sub.market} · ${sub.status}${sub.errorCount ? ` · ${sub.errorCount} errors` : ''}`}
                  />
                )
              })}
            </button>
          )
        })()}
        {/* History — same slot/position as eBay */}
        <SharedTbBtn
          icon={<History className="w-3.5 h-3.5" />}
          title="History — push submissions, pull log and version history"
          onClick={() => setHistoryOpen(true)}
          active={historyOpen}
        />
      </>
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketplace, manifest, pulling, pullPanelOpen, submissionHistory, historyOpen, handlePullFromAmazon, scheduleAutosave, syncSheetTypesFromRows, computeStorageType])

  // ── Slot: view toggles + scope (captures ctx.onReload for page reloads) ──
  const renderToolbarImport = useCallback((ctx: ToolbarImportCtx) => {
    onReloadCtxRef.current = ctx.onReload
    return (
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
              const fs = (r as Row)._fieldStates as any
              return fs && Object.values(fs).some((v) => v === 'OVERRIDE')
            })
            if (!overrideRows.length) return
            const ids = overrideRows.map((r) => (r as Row)._listingId as string).filter(Boolean)
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
            reloadGridFromServer()
          }}
          disabled={!ctx.rows.length}
        />
        {/* Scope: This file / All products — hidden in family drill-in view */}
        {!familyId && (
          <div
            className="flex items-center gap-0.5 ml-1 pl-1.5 border-l border-slate-200 dark:border-slate-700"
            title="This file = only SKUs listed on this Amazon market. All products = full catalog."
          >
            <span className="text-[10px] uppercase tracking-wide text-slate-400 mr-0.5 select-none">Scope</span>
            {(['listed', 'all'] as const).map((val) => (
              <button
                key={val}
                type="button"
                onClick={() => setScope(val)}
                aria-pressed={scope === val}
                className={`px-1.5 py-0.5 text-[11px] rounded transition-colors ${
                  scope === val
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                {val === 'listed' ? 'This file' : 'All products'}
              </button>
            ))}
            {scope === 'listed' && (
              <span className="ml-1 text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap select-none">
                Showing Amazon {marketplace} only
              </span>
            )}
          </div>
        )}
      </>
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showOverrideBadges, showCascadeButtons, scope, familyId, marketplace, reloadGridFromServer])

  // ── File menu extras (grid already has Reload + workbook) ────────────────
  const fileMenuItems = useMemo(() => [
    { label: 'Smart import (CSV/Excel/JSON)…', icon: <Wand2 className="w-3.5 h-3.5" />, onClick: () => { setImportInitialFile(null); setImportOpen(true) }, disabled: !effectiveManifest },
    { label: 'Import TSV…', icon: <Upload className="w-3.5 h-3.5" />, onClick: () => { fileInputRef.current?.click() } },
    { separator: true, label: '' },
    { label: 'Export as TSV (Amazon) — selected rows when any are ticked', icon: <Download className="w-3.5 h-3.5" />, onClick: () => void exportFile('tsv'), disabled: !manifest },
    { label: 'Export as CSV', icon: <Download className="w-3.5 h-3.5" />, onClick: () => void exportFile('csv'), disabled: !manifest },
    { label: 'Export as Excel (.xlsx)', icon: <Download className="w-3.5 h-3.5" />, onClick: () => void exportFile('xlsx'), disabled: !manifest },
    { separator: true, label: '' },
    { label: 'Version history…', icon: <Clock className="w-3.5 h-3.5" />, onClick: () => setHistoryOpen(true), disabled: !manifest },
    { separator: true, label: '' },
    { label: 'Market coverage…', icon: <Globe className="w-3.5 h-3.5" />, onClick: () => setCoverageModalOpen(true), disabled: !manifest },
    { label: 'Listing health…', icon: <Activity className="w-3.5 h-3.5" />, onClick: () => setHealthModalOpen(true), disabled: !manifest },
  ], [effectiveManifest, manifest, exportFile])

  // ── Edit menu extras (factory — reads live rows/selection) ───────────────
  const editMenuItems = useCallback((ctx: ToolbarFetchCtx) => {
    const rows = ctx.rows as Row[]
    const selected = rows.filter((r) => !r._ghost && ctx.selectedRows.has(r._rowId as string))
    const followEligibleCount = selected.filter((r) => !isFbaRow(r)).length
    const bufferEligibleCount = selected.filter((r) =>
      (String(r.follow) === 'Follow' || String(r.follow) === 'Pinned') && !isFbaRow(r)).length
    const pinnedCount = rows.filter((r) => !r._ghost && r.follow === 'Pinned').length
    return [
      { separator: true },
      { label: 'Copy to market…', icon: <Copy className="w-3.5 h-3.5" />, onClick: () => setPushPanel((p) => p ? null : { tab: 'copy' }), disabled: !manifest || !rows.length },
      { label: 'Translate values…', icon: <ArrowRightLeft className="w-3.5 h-3.5" />, onClick: () => setPushPanel((p) => p ? null : { tab: 'translate' }), disabled: !manifest || !rows.length },
      { separator: true },
      // FM Phase 3/4 — bulk Follow/Pinned/Buffer on the selected rows (active market).
      { label: `Set Follow${followEligibleCount ? ` (${followEligibleCount})` : ''}`, icon: <RefreshCw className="w-3.5 h-3.5" />, onClick: () => void bulkSetFollow(true), disabled: followEligibleCount === 0 },
      { label: `Set Pinned${followEligibleCount ? ` (${followEligibleCount})` : ''}`, icon: <Pin className="w-3.5 h-3.5" />, onClick: () => void bulkSetFollow(false), disabled: followEligibleCount === 0 },
      { label: `Set buffer…${bufferEligibleCount ? ` (${bufferEligibleCount})` : ''}`, icon: <Layers className="w-3.5 h-3.5" />, onClick: openBufferModal, disabled: bufferEligibleCount === 0 },
      { separator: true },
      { label: `Select all Pinned${pinnedCount ? ` (${pinnedCount})` : ''}`, onClick: selectAllPinned, disabled: pinnedCount === 0 },
      { separator: true },
      // FF-MS — market sync: copy the current row order + sort to other markets.
      { label: 'Apply order to markets…', icon: <GripVertical className="w-3.5 h-3.5" />, onClick: () => setApplyPanelOpen(true), disabled: !rows.length },
    ]
  }, [manifest, bulkSetFollow, openBufferModal, selectAllPinned])

  // ── Slot: push extras (feed badges · sync chip · Submit) ─────────────────
  const renderPushExtras = useCallback(({ rows, selectedRows: gridSelected }: PushExtrasCtx) => {
    const realRows = (rows as Row[]).filter((r) => !r._ghost)
    const publishable = publishableOf(rows as Row[])
    return (
      <>
        {/* Feed status badges (FFS.5 — error-aware + terminal-correct) */}
        {feedEntries.length > 0 && (
          <div className="flex items-center gap-1">
            {feedEntries.map((e) => {
              const errs = feedErrorCount(e.results)
              const done = e.status === 'DONE'
              const failed = e.status === 'FATAL' || e.status === 'CANCELLED'
              const cls = failed || (done && errs > 0)
                ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-800'
                : done
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-800'
                : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-800'
              const label = done && errs > 0
                ? `${e.status} · ${errs} error${errs === 1 ? '' : 's'}`
                : (e.status ?? '…')
              const inFlight = !done && !failed
              return (
                <span key={e.market} title={e.error ?? label}
                  className={cn('inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border', cls)}>
                  {inFlight && (
                    <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500" />
                    </span>
                  )}
                  {e.market}: {label}
                </span>
              )
            })}
            {/* Always available — re-check even after DONE to re-verify the report */}
            <Button size="sm" variant="ghost" onClick={pollAllFeeds} loading={polling}>
              <RefreshCw className="w-3 h-3 mr-1" />Check
            </Button>
          </div>
        )}

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
        {pullProgress && (
          <span className="text-[11px] flex items-center gap-1 flex-shrink-0 text-blue-600 dark:text-blue-400">
            <RefreshCw className="w-3 h-3 animate-spin" />
            Pulling {pullProgress.progress}/{pullProgress.total || '?'} from {marketplace}…
          </span>
        )}
        {pullResult && !pullProgress && (
          <span className="text-[11px] flex items-center gap-1 flex-shrink-0 text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="w-3 h-3" />
            Pulled {pullResult.pulled}
            {pullResult.skipped > 0 && ` · ${pullResult.skipped} not on ${marketplace}`}
            {pullResult.failed > 0 && ` · ${pullResult.failed} failed`}
            {' · ⌘Z to undo'}
          </span>
        )}

        {/* PD.1 — publish-mode truth, right where you publish. */}
        <PublishModeBadge channel="amazon" />

        {/* Submit to Amazon */}
        <div className="relative">
          <Button size="sm" onClick={() => setSubmitPanelOpen((o) => !o)}
            disabled={submitting || loading} loading={submitting}
            className={submitPanelOpen ? 'bg-blue-700' : ''}>
            <Send className="w-3.5 h-3.5 mr-1.5" />Submit to Amazon{publishable.length > 0 && ` (${publishable.length})`}
          </Button>
          {submitPanelOpen && (
            <SubmitToAmazonPanel currentMarket={marketplace} productType={productType}
              familyId={familyId} currentDirtyRows={publishable}
              currentSelectedRows={realRows.filter((r) => gridSelected.has(r._rowId as string))}
              currentAllRows={realRows}
              getMarketRows={(mp) => loadSavedRows(mp, productType) ?? []}
              onSubmit={handleSubmitToMarkets} onClose={() => setSubmitPanelOpen(false)} />
          )}
        </div>

        {/* P1.2 — Draft saved indicator */}
        {lastSaveLabel && (
          <span className="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap select-none" aria-live="polite">
            {lastSaveLabel}
          </span>
        )}
      </>
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedEntries, polling, pollAllFeeds, syncStatus, pullProgress, pullResult, marketplace, productType, familyId, submitting, loading, submitPanelOpen, handleSubmitToMarkets, lastSaveLabel])

  // ── Toolbar trailing: column quick-jump (⌘⇧G) ────────────────────────────
  const toolbarTrailing = (
    <div className="relative">
      <SharedTbBtn
        icon={<Search className="w-3.5 h-3.5" />}
        title="Jump to column (⌘⇧G)"
        onClick={() => setColSearchOpen((o) => !o)}
        active={colSearchOpen}
      />
      {colSearchOpen && (
        <div data-col-search className="absolute right-0 top-8 z-50 w-64 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl"
          onKeyDown={(e) => { if (e.key === 'Escape') { setColSearchOpen(false); setColSearchQuery('') } }}>
          <div className="px-2 py-1.5 border-b border-slate-100 dark:border-slate-800">
            <input
              autoFocus
              type="text"
              placeholder="Search columns…"
              value={colSearchQuery}
              onChange={(e) => setColSearchQuery(e.target.value)}
              className="w-full text-xs bg-transparent text-slate-800 dark:text-slate-200 placeholder:text-slate-400 outline-none"
            />
          </div>
          <div className="max-h-52 overflow-y-auto py-1">
            {(() => {
              const q = colSearchQuery.toLowerCase()
              const hits = visibleGridColumns
                .map((c, ci) => ({ c, ci }))
                .filter(({ c }) => !q || c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
                .slice(0, 24)
              if (!hits.length) return <div className="px-3 py-2 text-xs text-slate-400">No columns found</div>
              return hits.map(({ c, ci }) => (
                <button
                  key={c.id}
                  type="button"
                  className="w-full text-left px-3 py-1.5 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-2"
                  onClick={() => {
                    requestAnimationFrame(() => {
                      document.querySelector(`[data-ri="0"][data-ci="${ci}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' })
                    })
                    setColSearchOpen(false)
                    setColSearchQuery('')
                  }}
                >
                  <span className="truncate flex-1">{c.label}</span>
                  {c.required && <span className="text-[9px] text-amber-500 flex-shrink-0">req</span>}
                </button>
              ))
            })()}
          </div>
        </div>
      )}
    </div>
  )

  // ── Slot: Bar 3 left — market strip · category chips · Set category ──────
  const renderBar3Left = useCallback(() => {
    const liveRows = latestRowsRef.current
    const activeDirty = liveRows.filter((r) => r._dirty || r._isNew).length
    const typesInUse = productTypesInUse(liveRows)
    const selectedRealCount = liveRows.filter((r) => !r._ghost && latestSelectedRowsRef.current.has(r._rowId as string)).length
    return (
      <>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400 font-medium">Market</span>
          <div className="flex gap-0.5">
            {MARKETPLACES.map((m, idx) => {
              const isActive = marketplace === m
              const isSwitching = isActive && loading
              const dirtyCount = otherMarketsDirtyCount[m] ?? 0
              const shortcutHint = idx < 9 ? ` (Alt+${idx + 1})` : ''
              return (
                <button key={m} type="button"
                  onClick={() => navigateTo(m, productType)}
                  onMouseEnter={() => { if (!isActive) void prefetch(m, productType) }}
                  onFocus={() => { if (!isActive) void prefetch(m, productType) }}
                  aria-pressed={isActive}
                  aria-label={`Switch to ${m} marketplace${shortcutHint}${isSwitching ? ' (loading)' : ''}${dirtyCount > 0 ? ` (${dirtyCount} unsaved)` : ''}`}
                  title={`${m} marketplace${shortcutHint}${dirtyCount > 0 ? ` — ${dirtyCount} unsaved change${dirtyCount === 1 ? '' : 's'}` : ''}`}
                  className={cn('inline-flex items-center text-xs font-medium px-2 py-0.5 rounded border transition-colors',
                    isActive
                      ? 'bg-slate-800 text-white border-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
                      : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:border-slate-400')}>
                  {isSwitching && <Loader2 className="w-2.5 h-2.5 mr-1 animate-spin" aria-hidden />}
                  {m}
                  {(() => {
                    const count = isActive ? activeDirty : dirtyCount
                    if (!count) return null
                    return (
                      <span
                        className="ml-1 inline-flex items-center justify-center min-w-[14px] h-3.5 px-1 rounded-sm text-[9px] font-semibold leading-none bg-amber-500 text-white"
                        title={`${count} unsaved change${count === 1 ? '' : 's'}${isActive ? '' : ` on ${m}`}`}
                      >
                        {count}
                      </span>
                    )
                  })()}
                  {isActive && lastSwitchMs !== null && (
                    <span
                      className="ml-1 text-[8px] font-mono leading-none text-slate-400 dark:text-slate-500 tabular-nums"
                      title={`Market switch took ${lastSwitchMs}ms`}
                    >
                      {lastSwitchMs < 1000 ? `${lastSwitchMs}ms` : `${(lastSwitchMs / 1000).toFixed(1)}s`}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
        {familyId && (
          <span className="inline-flex items-center gap-1 text-xs bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-800 rounded px-1.5 py-0.5 flex-shrink-0">
            <FileSpreadsheet className="w-3 h-3" />Family
          </span>
        )}
        <div className="flex items-center gap-2">
          {/* BN.3.1 — Categories in this sheet; clicking a chip filters columns to that type. */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400 font-medium">Categories in this sheet</span>
            <div className="flex items-center gap-1 flex-wrap">
              {typesInUse.length === 0 ? (
                <span className="text-[11px] text-slate-400 italic">none yet — select rows and Set category</span>
              ) : (
                <>
                  {isUnionMode && (
                    <button type="button" onClick={() => setFilterType(null)}
                      className={cn('px-1.5 py-0.5 rounded text-[11px] font-semibold border transition-colors',
                        !filterType ? 'bg-indigo-100 text-indigo-700 border-indigo-300 dark:bg-indigo-900/40 dark:text-indigo-300' : 'border-slate-200 text-slate-500 hover:border-indigo-400')}>
                      All
                    </button>
                  )}
                  {typesInUse.map((t) => (
                    // UFX P4d — union chips carry a remove affordance (× →
                    // reassign-or-remove dialog); the label part still toggles
                    // the column filter. Buttons are siblings (nesting is
                    // invalid HTML), joined into one chip visually.
                    <span key={t}
                      className={cn('inline-flex items-stretch rounded border overflow-hidden transition-colors',
                        filterType === t ? 'bg-indigo-100 border-indigo-300 dark:bg-indigo-900/40' : 'border-slate-200 hover:border-indigo-400')}>
                      <button type="button" onClick={() => setFilterType((f) => (f === t ? null : t))}
                        title={filterType === t ? `Show all categories' columns` : `Show only ${t}'s columns`}
                        className={cn('px-1.5 py-0.5 text-[11px] font-semibold transition-colors',
                          filterType === t ? 'text-indigo-700 dark:text-indigo-300' : 'text-slate-500')}>
                        {t}
                      </button>
                      {isUnionMode && (
                        <button type="button" onClick={() => setRemoveCategoryType(t)}
                          title={`Remove ${t} from this sheet…`}
                          aria-label={`Remove ${t} from this sheet`}
                          className={cn('px-1 flex items-center border-l transition-colors',
                            filterType === t
                              ? 'border-indigo-200 dark:border-indigo-800 text-indigo-400 hover:text-indigo-700 dark:hover:text-indigo-200'
                              : 'border-slate-200 dark:border-slate-700 text-slate-400 hover:text-red-500')}>
                          <X className="w-2.5 h-2.5" aria-hidden />
                        </button>
                      )}
                    </span>
                  ))}
                </>
              )}
            </div>
            <Button size="sm" variant="ghost" onClick={() => void loadData(marketplace, productType, true)} loading={loading}
              title="Refresh schema from Amazon — updates columns/groups, keeps row edits">
              <RefreshCw className="w-3 h-3 mr-1" />Refresh schema
            </Button>
          </div>
          {/* BN.2.2 — Set category: bulk-assign product type + browse node to selected rows. */}
          {selectedRealCount > 0 && (
            <Button size="sm" variant="secondary"
              onMouseEnter={warmSetCategoryModal}
              onFocus={warmSetCategoryModal}
              onClick={() => setShowSetCategory(true)}>
              Set category ({selectedRealCount})
            </Button>
          )}
        </div>
      </>
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketplace, productType, loading, otherMarketsDirtyCount, lastSwitchMs, navigateTo, prefetch, familyId, isUnionMode, filterType, loadData, warmSetCategoryModal])

  // ── Slot: banners under the toolbar ──────────────────────────────────────
  const renderFeedBanner = useCallback(() => {
    if (!loadError && !draftBanner) return null
    return (
      <>
        {/* Error — FF-MS.6 */}
        {loadError && (() => {
          const { status, mp: errMp, pt: errPt, message } = loadError
          const isLoadFailure = !!(errMp && errPt)
          const hint = !isLoadFailure
            ? null
            : status === 429
              ? 'Amazon is rate-limiting our requests. Wait a few seconds and retry.'
              : status === 401 || status === 403
              ? 'Auth expired — re-connect this marketplace in Settings.'
              : status === 404
              ? 'This product type isn’t configured for this marketplace.'
              : status && status >= 500
              ? 'Amazon server error. This is usually transient — retry in a moment.'
              : status == null
              ? 'Network error — check your connection.'
              : null
          return (
            <div
              role="alert"
              className="px-4 py-1.5 bg-red-50 dark:bg-red-950/30 border-t border-red-200 dark:border-red-900 flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2 text-xs text-red-700 dark:text-red-400 min-w-0">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="truncate">
                  {isLoadFailure ? (
                    <>
                      Failed to load <strong>{errMp} · {errPt}</strong>
                      {hint && <span className="ml-1 text-red-600/80 dark:text-red-300/80">— {hint}</span>}
                      <span className="ml-1 text-red-500/60 dark:text-red-400/60">({message})</span>
                    </>
                  ) : (
                    message
                  )}
                </span>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                {isLoadFailure && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={loading && marketplace === errMp && productType === errPt}
                    onClick={() => { setLoadError(null); void loadData(errMp!, errPt!) }}
                  >
                    <RefreshCw className="w-3 h-3 mr-1" /> Retry
                  </Button>
                )}
                <button
                  type="button"
                  onClick={() => setLoadError(null)}
                  aria-label="Dismiss error"
                  className="p-1"
                >
                  <X className="w-4 h-4 text-red-400 hover:text-red-600" />
                </button>
              </div>
            </div>
          )
        })()}

        {/* Draft restored banner — the grid auto-restored unsaved edits; offer a reset. */}
        {draftBanner && (
          <div className="px-4 py-2 bg-amber-50 dark:bg-amber-950/30 border-t border-amber-200 dark:border-amber-800 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs text-amber-800 dark:text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              Restored {draftBanner.filter((r) => r._dirty).length} unsaved edit{draftBanner.filter((r) => r._dirty).length === 1 ? '' : 's'} from your last session — Save to persist them.
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                type="button"
                onClick={() => { setDraftBanner(null); reloadGridFromServer() }}
                className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200"
              >
                Discard drafts &amp; reload from server
              </button>
              <button
                type="button"
                onClick={() => setDraftBanner(null)}
                className="text-xs font-medium px-2 py-1 rounded bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 hover:bg-amber-200 dark:hover:bg-amber-800/60 transition-colors"
              >
                Keep drafts
              </button>
            </div>
          </div>
        )}
      </>
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadError, draftBanner, loading, marketplace, productType, loadData, reloadGridFromServer])

  // ── Slot: footer actions (Add row/parent/variant · Set type · Group · Delete) ──
  const renderFooterActions = useCallback((ctx: FooterActionsCtx) => {
    const selCount = ctx.selectedRows.size
    return (
      <div className="flex items-center gap-2 relative">
        <Button size="sm" variant="ghost"
          onClick={() => setAddRowsPanel({ type: 'row', position: ctx.anchorRow ? 'below' : 'end', anchorRowId: ctx.anchorRow?._rowId })}>
          <Plus className="w-3.5 h-3.5 mr-1" />Add row
        </Button>
        <Button size="sm" variant="ghost"
          onClick={() => setAddRowsPanel({ type: 'parent', position: ctx.anchorRow ? 'below' : 'end', anchorRowId: ctx.anchorRow?._rowId })}>
          <Plus className="w-3.5 h-3.5 mr-1" />Add parent
        </Button>
        <Button size="sm" variant="ghost"
          onClick={() => setAddRowsPanel({ type: 'variant', position: ctx.anchorRow ? 'below' : 'end', anchorRowId: ctx.anchorRow?._rowId })}>
          <Plus className="w-3.5 h-3.5 mr-1" />Add variant
        </Button>
        {selCount > 0 && isUnionMode && (
          <select
            value=""
            onChange={(e) => { if (e.target.value) { bulkSetProductType(e.target.value); e.currentTarget.value = '' } }}
            className="ml-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs text-slate-700 dark:text-slate-200"
            title={`Set the category for the ${selCount} selected row(s)`}
          >
            <option value="">Set type…</option>
            {sheetTypes.map((t) => t.toUpperCase()).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
        {selCount > 0 && (
          <Button size="sm" variant="ghost" onClick={ctx.groupFromSelection} className="ml-2"
            title={`Create a custom group from the ${selCount} selected row(s)`}>
            <Layers className="w-3.5 h-3.5 mr-1" />Group {selCount}…
          </Button>
        )}
        {selCount > 0 && (
          <Button size="sm" variant="ghost" onClick={deleteSelected}
            className="text-red-500 hover:text-red-700 ml-2">
            <Trash2 className="w-3.5 h-3.5 mr-1" />Delete {selCount}
          </Button>
        )}
      </div>
    )
  }, [isUnionMode, sheetTypes, bulkSetProductType, deleteSelected])

  // ── Slot: right-click context menu (Amazon ContextMenu on grid ops) ──────
  const renderContextMenu = useCallback((ctx: GridContextMenuCtx) => (
    <ContextMenu
      x={ctx.x}
      y={ctx.y}
      canPaste={true}
      hasSelection={ctx.hasSelection}
      selRowCount={ctx.selRowCount}
      onCut={ctx.ops.cut}
      onCopy={ctx.ops.copy}
      onPaste={ctx.ops.paste}
      onAddRows={() => setAddRowsPanel({ type: 'row', position: 'below', anchorRowId: ctx.anchorRow?._rowId })}
      onInsertAbove={() => {
        const anchorId = ctx.anchorRow?._rowId
        pushSnapshot()
        const newRow = makeEmptyRow(productTypeRef.current, marketplaceRef.current)
        setRows((prev) => {
          const idx = anchorId ? prev.findIndex((r) => r._rowId === anchorId) : -1
          if (idx === -1) return [...prev, newRow]
          const next = [...prev]; next.splice(idx, 0, newRow); return next
        })
      }}
      onInsertBelow={() => {
        const anchorId = ctx.anchorRow?._rowId
        pushSnapshot()
        const newRow = makeEmptyRow(productTypeRef.current, marketplaceRef.current)
        setRows((prev) => {
          const idx = anchorId ? prev.findIndex((r) => r._rowId === anchorId) : -1
          if (idx === -1) return [...prev, newRow]
          const next = [...prev]; next.splice(idx + 1, 0, newRow); return next
        })
      }}
      onDeleteRows={async () => {
        const toRemove = ctx.selectionRows as Row[]
        const n = toRemove.length
        if (!n) return
        if (!confirm(`Remove ${n} listing${n === 1 ? '' : 's'} from Amazon ${marketplaceRef.current}? The product and its stock stay in Nexus; other channels are untouched.`)) return
        pushSnapshot()
        await removeFromAmazon(toRemove)
      }}
      onClearCells={ctx.ops.clearCells}
      onGroupSelected={ctx.ops.groupFromSelection}
      onClose={ctx.close}
    />
  ), [pushSnapshot, setRows, removeFromAmazon])

  // ── Slot: row-header meta (ASIN link · status · badges · clone) ──────────
  const renderRowMeta = useCallback((row: BaseRow) => {
    const r = row as Row
    if (r._ghost) return null
    const asin = r._asin ? String(r._asin) : null
    const domain = AMAZON_DOMAIN[marketplace] ?? 'amazon.com'
    const listingStatus = r._listingStatus != null ? String(r._listingStatus) : null
    return (
      <div className="flex flex-col items-end gap-0.5">
        {asin && (
          <a
            href={`https://www.${domain}/dp/${asin}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[9px] font-mono text-blue-500 hover:text-blue-700 hover:underline leading-none block truncate z-10 relative"
            title={`ASIN: ${asin} — open on ${domain}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >{asin}</a>
        )}
        {listingStatus && (() => {
          const cls = (listingStatus === 'ACTIVE' || listingStatus === 'BUYABLE')
            ? 'text-emerald-600 dark:text-emerald-400'
            : listingStatus === 'INACTIVE' ? 'text-amber-500 dark:text-amber-400'
            : 'text-red-500 dark:text-red-400'
          return <span className={cn('text-[9px] font-semibold leading-none', cls)}>{listingStatus.slice(0, 4)}</span>
        })()}
        <div className="flex items-center gap-0.5">
          {showOverrideBadges && (
            <OverrideBadge
              listingId={r._listingId as string | null | undefined}
              fieldStates={r._fieldStates as any}
              masterValues={r._masterValues as any}
            />
          )}
          {/* IN.2 — Cascade button */}
          {showCascadeButtons && r._productId && (
            <button
              onClick={(e) => { e.stopPropagation(); setCascadeRow(r) }}
              onPointerDown={(e) => e.stopPropagation()}
              title="Apply this row's values to all sibling variants"
              className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-semibold leading-none transition-colors bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:hover:bg-blue-900/60"
            >
              <GitFork className="h-2.5 w-2.5" />↓
            </button>
          )}
          {/* P4.3 — Clone variant (child rows only) */}
          {r.parentage_level === 'child' && (
            <button
              onClick={(e) => { e.stopPropagation(); handleCloneVariant(r) }}
              onPointerDown={(e) => e.stopPropagation()}
              title="Clone this variant — copies all fields, clears axis values (SKU, Color, Size) for you to fill in"
              className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-semibold leading-none transition-colors bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700/50 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <Copy className="h-2.5 w-2.5" />
            </button>
          )}
          {/* P1.4 — Last-sync badge */}
          {r._lastSyncedAt ? (() => {
            const syncSt = String(r._lastSyncStatus ?? '')
            const syncAt = new Date(String(r._lastSyncedAt))
            const secAgo = Math.round((Date.now() - syncAt.getTime()) / 1000)
            const timeLabel = secAgo < 60 ? `${secAgo}s` : secAgo < 3600 ? `${Math.round(secAgo / 60)}m` : `${Math.round(secAgo / 3600)}h`
            const ok = /^success$/i.test(syncSt)
            const errSt = /^error$/i.test(syncSt)
            return (
              <span
                className={cn('shrink-0 text-[8px] font-mono leading-none px-0.5',
                  ok ? 'text-emerald-500 dark:text-emerald-400'
                  : errSt ? 'text-red-500 dark:text-red-400'
                  : 'text-slate-400 dark:text-slate-500')}
                title={`Last Amazon sync: ${syncAt.toLocaleString()} (${syncSt || 'n/a'})`}
              >↑{timeLabel}</span>
            )
          })() : null}
        </div>
      </div>
    )
  }, [marketplace, showOverrideBadges, showCascadeButtons, handleCloneVariant])

  // ── Slot: modals that need live grid rows ─────────────────────────────────
  const renderModals = useCallback(({ rows }: ModalsCtx) => {
    const realRows = (rows as Row[]).filter((r) => !r._ghost)
    return (
      <>
        {/* Unified history modal — H.1–H.4 */}
        <HistoryModal
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          channel="amazon"
          marketplace={marketplace}
          productType={productType}
          onResubmitErroredSkus={(skus) => {
            latestSetSelectedRowsRef.current?.(new Set(
              realRows.filter((r) => skus.includes(String(r.item_sku ?? ''))).map((r) => r._rowId as string),
            ))
            setHistoryOpen(false)
          }}
          onGoToCell={handleGoToCell}
          onRePull={(rec) => {
            setHistoryOpen(false)
            const isAllCols = rec.columnsApplied.includes('all') || rec.columnsApplied.length === 0
            const cols = (isAllCols ? 'all' : rec.columnsApplied) as 'all' | PullGroupId[]
            const skus = rec.skusRequested
            if (!skus.length) return
            void (async () => {
              setPulling(true)
              setPullProgress({ progress: 0, total: skus.length })
              setPullResult(null)
              try {
                const startRes = await fetch(`${getBackendUrl()}/api/amazon/flat-file/pull-preview/start`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ marketplace, productType, skus }),
                })
                const startData = await startRes.json()
                if (!startRes.ok) throw new Error(startData.error ?? 'Pull failed to start')
                const { jobId } = startData
                let job: any = null
                for (let i = 0; i < 1200; i++) {
                  await new Promise((r) => setTimeout(r, 1500))
                  const statusRes = await fetch(`${getBackendUrl()}/api/amazon/flat-file/pull-preview/status/${jobId}`)
                  if (!statusRes.ok) throw new Error('Pull status check failed')
                  job = await statusRes.json()
                  setPullProgress({ progress: job.progress, total: job.total })
                  if (job.status === 'done' || job.status === 'failed') break
                }
                if (!job || job.status !== 'done') throw new Error(job?.fatalError ?? 'Pull timed out')
                const pulledRows: Row[] = Array.isArray(job.rows) ? job.rows : []
                setPullDiffData({ pulledRows, selectedColumns: cols, skusRequested: skus, skusReturned: pulledRows.length, jobId })
                setPullDiffOpen(true)
              } catch (e: any) {
                setLoadError({ message: e?.message ?? 'Re-pull failed', at: Date.now() })
              } finally {
                setPulling(false)
                setPullProgress(null)
              }
            })()
          }}
          onRestoreVersion={(restoredRows) => {
            latestPushHistoryRef.current?.(restoredRows as BaseRow[])
            setHistoryOpen(false)
          }}
          currentRows={rows as Row[]}
        />

        {/* Pull diff preview — Phase 2 of in-editor pull */}
        {pullDiffData && (
          <PullDiffModal
            open={pullDiffOpen}
            pulledRows={pullDiffData.pulledRows as Row[]}
            currentRows={rows as Row[]}
            marketplace={marketplace}
            productType={productType}
            selectedColumns={pullDiffData.selectedColumns}
            columnLabels={columnLabelMap}
            onApply={handlePullDiffApply}
            onClose={() => { setPullDiffOpen(false); setPullDiffData(null) }}
          />
        )}

        {/* FX.5b — Smart import wizard (external CSV/Excel/TSV/JSON → grid) */}
        {importOpen && (
          <ImportWizardModal
            open={importOpen}
            marketplace={marketplace}
            productType={productType}
            productTypes={sheetTypes}
            currentRows={rows as Row[]}
            columnLabels={columnLabelMap}
            columnIds={manifestColumns.map((c) => c.id)}
            initialFile={importInitialFile}
            onApply={handleImportApply}
            onClose={() => { setImportOpen(false); setImportInitialFile(null) }}
          />
        )}

        {/* View → Market coverage modal */}
        {coverageModalOpen && (
          <CoverageModal
            rows={realRows}
            marketplace={marketplace}
            onSwitchMarket={(m) => { setCoverageModalOpen(false); navigateTo(m, productType) }}
            onClose={() => setCoverageModalOpen(false)}
          />
        )}

        {/* View → Listing health modal */}
        {healthModalOpen && (
          <HealthModal
            rows={realRows}
            columns={manifestColumns}
            onClose={() => setHealthModalOpen(false)}
          />
        )}

        {/* UFX P4c — the panel sees the EFFECTIVE (union-aware) manifest so a
            mixed sheet offers every category's columns for copying. */}
        {pushPanel && effectiveManifest && (
          <PushToMarketsPanel
            initialTab={pushPanel.tab}
            preselectedCol={pushPanel.preselectedCol}
            manifest={effectiveManifest}
            rows={realRows}
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
            rows={realRows}
            hasSelection={!!addRowsPanel.anchorRowId}
            productType={productType}
            marketplace={marketplace}
            variationThemes={effectiveManifest?.variationThemes ?? []}
            manifestColumnIds={manifestColumns.map((c) => c.id)}
            onAdd={handleAddRows}
            onAddFamily={handleAddVariationFamily}
            onClose={() => setAddRowsPanel(null)}
          />
        )}

        {/* FF-MS — apply row order + sort to other markets */}
        {applyPanelOpen && (
          <div className="fixed top-24 right-4 z-50">
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
      </>
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyOpen, marketplace, productType, handleGoToCell, pullDiffData, pullDiffOpen, columnLabelMap, handlePullDiffApply, importOpen, sheetTypes, manifestColumns, importInitialFile, handleImportApply, coverageModalOpen, healthModalOpen, navigateTo, pushPanel, manifest, handleCopyToMarket, handleApplyTranslations, addRowsPanel, effectiveManifest, handleAddRows, handleAddVariationFamily, applyPanelOpen, marketSync])

  // ── Render ─────────────────────────────────────────────────────────

  // IN.2 — Build CascadeModal fields from the row when cascade is triggered
  const cascadeFields = cascadeRow ? [
    { key: 'price', label: 'Price', value: cascadeRow.purchasable_offer__our_price },
    { key: 'title', label: 'Title', value: cascadeRow.item_name },
    { key: 'description', label: 'Description', value: cascadeRow.product_description },
    { key: 'quantity', label: 'Quantity', value: cascadeRow.fulfillment_availability__quantity },
  ] : []

  const gridInitialRows = (_swr.get(cacheKey(marketplace, productType))?.rows
    ?? mergeAsinCache(initialRows ?? [], marketplace)) as BaseRow[]

  return (
    <div
      style={{ display: 'contents' }}
      onDragOver={(e) => { if (!importOpen && e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={(e) => {
        // FX.7 — drop a spreadsheet on the grid to open the import wizard pre-loaded.
        if (importOpen || !e.dataTransfer.types.includes('Files')) return
        const f = e.dataTransfer.files?.[0]
        if (!f || !/\.(csv|tsv|txt|xlsx|xls|json)$/i.test(f.name)) return
        e.preventDefault()
        setImportInitialFile(f); setImportOpen(true)
      }}>

      {/* Hidden file input for Import TSV */}
      <input ref={fileInputRef} type="file" accept=".txt,.tsv,.csv,.xlsm,.xlsx" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = '' }} />

      {/* IN.2 — Cascade modal */}
      {cascadeRow && cascadeRow._productId && (
        <CascadeModal
          sourceProductId={String(cascadeRow._productId)}
          sourceSku={String(cascadeRow.item_sku ?? cascadeRow._rowId)}
          channel="AMAZON"
          marketplace={marketplace}
          availableFields={cascadeFields}
          onClose={() => setCascadeRow(null)}
          onSuccess={(n) => { if (n > 0) reloadGridFromServer() }}
        />
      )}

      {/* FFC — pre-publish Review & Confirm gate (replaces the old confirm()). */}
      {reviewModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
          onMouseDown={(e) => { if (e.target === e.currentTarget) reviewModal.resolve(false) }}
        >
          <div className="w-full max-w-lg max-h-[85vh] flex flex-col rounded-lg border border-default dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl">
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-subtle dark:border-slate-800">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Review &amp; Publish</div>
                <div className="text-[11px] text-tertiary">
                  {reviewModal.data.markets.join(', ')} · {reviewModal.data.totalRows} row{reviewModal.data.totalRows === 1 ? '' : 's'}
                </div>
              </div>
              <button type="button" onClick={() => reviewModal.resolve(false)} className="p-1 rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" aria-label="Cancel">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-4 py-3 overflow-y-auto space-y-3">
              <div className="flex items-center gap-3 text-[12px] flex-wrap">
                {reviewModal.data.newCount > 0 && (
                  <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                    <Plus className="w-3.5 h-3.5" />{reviewModal.data.newCount} new product{reviewModal.data.newCount === 1 ? '' : 's'} will be created
                  </span>
                )}
                <span className="text-slate-600 dark:text-slate-300">{reviewModal.data.updateCount} updated</span>
              </div>
              {reviewModal.data.errors.length > 0 && (
                <div className="space-y-1">
                  <div className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-rose-700 dark:text-rose-400">
                    <AlertCircle className="w-3.5 h-3.5" />{reviewModal.data.errors.length} error{reviewModal.data.errors.length === 1 ? '' : 's'}
                  </div>
                  <ul className="space-y-1">
                    {reviewModal.data.errors.slice(0, 40).map((e, i) => (
                      <li key={`e${i}`} className="text-[11.5px] text-slate-800 dark:text-slate-200 leading-snug">
                        <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">{e.mp}·{e.sku}</span> {e.message}
                      </li>
                    ))}
                    {reviewModal.data.errors.length > 40 && <li className="text-[10.5px] text-tertiary">…and {reviewModal.data.errors.length - 40} more</li>}
                  </ul>
                </div>
              )}
              {reviewModal.data.warnings.length > 0 && (
                <div className="space-y-1">
                  <div className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="w-3.5 h-3.5" />{reviewModal.data.warnings.length} warning{reviewModal.data.warnings.length === 1 ? '' : 's'}
                  </div>
                  <ul className="space-y-1">
                    {reviewModal.data.warnings.slice(0, 40).map((w, i) => (
                      <li key={`w${i}`} className="text-[11.5px] text-slate-700 dark:text-slate-300 leading-snug">
                        <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">{w.mp}·{w.sku}</span> {w.message}
                      </li>
                    ))}
                    {reviewModal.data.warnings.length > 40 && <li className="text-[10.5px] text-tertiary">…and {reviewModal.data.warnings.length - 40} more</li>}
                  </ul>
                </div>
              )}
              {reviewModal.data.errors.length === 0 && reviewModal.data.warnings.length === 0 && (
                <div className="text-[12px] text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1.5">
                  <CheckCircle2 className="w-4 h-4" />No issues — ready to publish.
                </div>
              )}
              {reviewModal.data.errors.length > 0 && (
                <label className="flex items-start gap-2 text-[11.5px] text-rose-700 dark:text-rose-400 cursor-pointer">
                  <input type="checkbox" checked={reviewErrorAck} onChange={(e) => setReviewErrorAck(e.target.checked)} className="w-3.5 h-3.5 mt-0.5 accent-rose-600" />
                  <span>
                    I understand the {reviewModal.data.errors.length} error{reviewModal.data.errors.length === 1 ? '' : 's'} — publish anyway.
                    Amazon validates authoritatively and reports per-SKU results.
                  </span>
                </label>
              )}
              {reviewModal.data.warnings.length > 0 && (
                <label className="flex items-center gap-2 text-[11.5px] text-slate-700 dark:text-slate-300 cursor-pointer">
                  <input type="checkbox" checked={reviewAck} onChange={(e) => setReviewAck(e.target.checked)} className="w-3.5 h-3.5" />
                  I&apos;ve reviewed the {reviewModal.data.warnings.length} warning{reviewModal.data.warnings.length === 1 ? '' : 's'} and want to publish.
                </label>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-subtle dark:border-slate-800">
              <button type="button" onClick={() => reviewModal.resolve(false)} className="inline-flex items-center h-7 px-3 rounded text-[12px] border border-default dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">Cancel</button>
              <button type="button" onClick={() => reviewModal.resolve(true)}
                disabled={(reviewModal.data.errors.length > 0 && !reviewErrorAck) || (reviewModal.data.warnings.length > 0 && !reviewAck)}
                className="inline-flex items-center gap-1.5 h-7 px-3 rounded text-[12px] font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                <Send className="w-3.5 h-3.5" />Publish to {reviewModal.data.markets.join(', ')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* P5: completed-while-away banner */}
      {pendingPullReview && (
        <PendingPullBanner
          channelLabel="Amazon"
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

      {/* BN.2.2 — Set category modal */}
      {showSetCategory && (
        <SetCategoryModal open marketplace={marketplace}
          productTypeOptions={productTypes.map((p) => p.value)}
          selectedCount={latestRowsRef.current.filter((r) => !r._ghost && latestSelectedRowsRef.current.has(r._rowId as string)).length}
          onApply={applyCategory} onClose={() => setShowSetCategory(false)} />
      )}

      {/* UFX P4d — remove-category dialog (chip ×): reassign rows or drop them from this sheet */}
      {removeCategoryType && (
        <RemoveCategoryDialog
          type={removeCategoryType}
          rowCount={latestRowsRef.current.filter((r) => !r._ghost && String(r.product_type ?? '').toUpperCase() === removeCategoryType).length}
          otherTypes={sheetTypes.map((t) => t.toUpperCase()).filter((t) => t !== removeCategoryType)}
          onReassign={(to) => reassignCategoryRows(removeCategoryType, to)}
          onRemoveRows={() => removeCategoryRows(removeCategoryType)}
          onClose={() => setRemoveCategoryType(null)}
        />
      )}

      {/* FM Phase 4 — bulk Set buffer modal */}
      {bufferModal && (
        <DSModal open onClose={() => setBufferModal(null)} title="Set buffer" size="sm"
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setBufferModal(null)}>Cancel</Button>
              <Button variant="primary" size="sm" onClick={() => void applyBufferModal()}>Set buffer</Button>
            </>
          }>
          <p className="text-sm text-slate-600 dark:text-slate-300 mb-3">
            Reserve units from the shared pool on <strong>{bufferModal.productIds.length}</strong> listing{bufferModal.productIds.length === 1 ? '' : 's'}. A Following listing then advertises <strong>pool − buffer</strong> — its live quantity may change and a sync is queued. On a Pinned listing the buffer is stored and takes effect when it returns to Following.
          </p>
          <label className="block text-xs font-medium text-slate-500 mb-1">Units to hold back</label>
          <input type="number" min={0} value={bufferInput}
            onChange={(e) => setBufferInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void applyBufferModal() }}
            autoFocus
            className="w-28 px-2 py-1.5 border border-slate-300 dark:border-slate-600 rounded text-sm bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100" />
        </DSModal>
      )}

      {/* ── Empty / loading states (page-level: the grid needs a manifest) ── */}
      {!manifest && !loading && !loadError && (
        <div
          className="h-screen flex items-center justify-center gap-2 text-slate-500 text-sm bg-slate-50 dark:bg-slate-950"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
          Preparing {marketplace}{productType ? ` · ${productType}` : ''} schema…
        </div>
      )}
      {!manifest && !loading && loadError && (
        <div className="h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950">
          <div className="text-center text-slate-400">
            <FileSpreadsheet className="w-10 h-10 mx-auto mb-2 opacity-40" />
            <p className="text-sm mb-1">Couldn&apos;t load the Amazon schema for {marketplace}{productType ? ` · ${productType}` : ''}.</p>
            <p className="text-xs mb-3 text-slate-500">{loadError.message}</p>
            <Button size="sm" onClick={() => { setLoadError(null); void loadData(marketplace, productType, true) }}>
              Retry
            </Button>
          </div>
        </div>
      )}
      {!manifest && loading && (
        <div
          className="h-screen flex items-center justify-center gap-2 text-slate-500 text-sm bg-slate-50 dark:bg-slate-950"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
          Loading {marketplace}{productType ? ` · ${productType}` : ''} schema…
        </div>
      )}

      {/* ── The shared grid (UFX P3 — replaces the page's private grid) ──── */}
      {manifest && (
        <FlatFileGrid
          key={`${marketplace}:${productType}`}
          channel="amazon"
          title="Amazon Flat File"
          titleIcon={<FileSpreadsheet className="w-4 h-4 text-orange-500 flex-shrink-0" />}
          marketplace={marketplace}
          familyId={familyId}
          storageKey={`ff-amazon-${mp}`}
          enableCustomGroups
          columnGroups={gridColumnGroups}
          columnGroupState={orderedGroups.map((g) => ({
            id: g.id,
            label: g.labelEn,
            color: g.color,
            columns: g.columns.map((c) => c.id),
            visible: !closedGroups.has(g.id),
          }))}
          onGroupStateChange={(closed, order) => applyGroupSettings(closed, order)}
          initialRows={gridInitialRows}
          makeBlankRow={makeBlankRow}
          ghostRows={GHOST_BUFFER}
          getGroupKey={amazonGroupKey}
          bucketMode={bucketMode}
          validate={validateRows}
          onSave={onGridSave}
          onReload={onGridReload}
          onMaterializeRow={onMaterializeRow}
          onSortConfigChange={(levels) => { sortConfigRef.current = levels; propagateSort(levels) }}
          onRowOrderChange={(ids) => propagateRowOrder(ids)}
          renderCellContent={renderCellContent}
          getCellGuidance={getCellGuidance}
          getCellReadOnly={getCellReadOnly}
          getRowImageUrl={getRowImageUrl}
          renderRowMeta={renderRowMeta}
          onReplicate={handleReplicate}
          renderChannelStrip={renderChannelStrip}
          renderPushExtras={renderPushExtras}
          renderFeedBanner={renderFeedBanner}
          renderModals={renderModals}
          renderToolbarFetch={renderToolbarFetch}
          renderToolbarImport={renderToolbarImport}
          renderBar3Left={renderBar3Left}
          renderContextMenu={renderContextMenu}
          renderFooterActions={renderFooterActions}
          renderEmptyAction={() => (
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => setAddRowsPanel({ type: 'parent', position: 'end' })}>
                <Plus className="w-3.5 h-3.5 mr-1.5" />Add a parent (variations)
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setAddRowsPanel({ type: 'row', position: 'end' })}>
                <Plus className="w-3.5 h-3.5 mr-1.5" />Add a single item
              </Button>
            </div>
          )}
          fileMenuItems={fileMenuItems}
          editMenuItems={editMenuItems}
          onColumnsClick={() => setColumnsOpen(true)}
          columnsActive={columnsOpen}
          toolbarTrailing={toolbarTrailing}
          renderAiPanel={(ctx: AiPanelCtx) => (
            <FlatFileAiPanel {...(ctx as any)} channel="amazon" />
          )}
          apiRef={gridApiRef}
        />
      )}

      {/* ColumnGroupModal — controlled by useFlatFileCore columnsOpen state */}
      <ColumnGroupModal
        open={columnsOpen}
        onClose={() => setColumnsOpen(false)}
        groups={orderedGroups.map((g) => ({
          id: g.id,
          label: g.labelEn,
          color: g.color,
          columns: g.columns.map((c) => c.id),
          visible: !closedGroups.has(g.id),
        }))}
        onGroupsChange={(groups) => {
          const nextClosed = new Set(groups.filter((g) => !g.visible).map((g) => g.id))
          const nextOrder = groups.map((g) => g.id)
          applyGroupSettings(nextClosed, nextOrder)
        }}
      />
    </div>
  )
}

// ── RemoveCategoryDialog (UFX P4d) ──────────────────────────────────────
// Chip × on a union sheet: the operator either reassigns the category's rows
// to another of the sheet's types (data change — rows go dirty, browse node
// cleared) or removes them from THIS sheet only (view change — rows stay on
// the server / their own single-type sheet). DS Modal + Button.

function RemoveCategoryDialog({
  type, rowCount, otherTypes, onReassign, onRemoveRows, onClose,
}: {
  type: string
  rowCount: number
  otherTypes: string[]
  onReassign: (toType: string) => void
  onRemoveRows: () => void
  onClose: () => void
}) {
  const canReassign = otherTypes.length > 0
  const [mode, setMode] = useState<'reassign' | 'remove'>(canReassign ? 'reassign' : 'remove')
  const [target, setTarget] = useState(otherTypes[0] ?? '')
  const rowsLabel = `${rowCount} row${rowCount === 1 ? '' : 's'}`

  return (
    <DSModal open onClose={onClose} title={`Remove ${type} from this sheet`} size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant={mode === 'remove' ? 'danger' : 'primary'} size="sm"
            disabled={mode === 'reassign' && !target}
            onClick={() => { if (mode === 'reassign') onReassign(target); else onRemoveRows() }}>
            {mode === 'reassign' ? `Reassign ${rowsLabel}` : `Remove ${rowsLabel}`}
          </Button>
        </>
      }>
      <p className="text-sm text-slate-600 dark:text-slate-300 mb-3">
        This sheet has <strong>{rowsLabel}</strong> in <strong>{type}</strong>. Choose what happens to them:
      </p>
      <div className="space-y-2">
        <label className={cn('flex items-start gap-2 p-2 rounded border cursor-pointer transition-colors',
          mode === 'reassign' ? 'border-indigo-300 bg-indigo-50/60 dark:border-indigo-700 dark:bg-indigo-950/30' : 'border-slate-200 dark:border-slate-700',
          !canReassign && 'opacity-50 cursor-not-allowed')}>
          <input type="radio" name="remove-category-mode" className="mt-0.5" checked={mode === 'reassign'}
            disabled={!canReassign} onChange={() => setMode('reassign')} />
          <span className="text-xs text-slate-700 dark:text-slate-200">
            <span className="font-semibold block">Reassign to another category</span>
            <span className="text-slate-500 dark:text-slate-400 block mb-1.5">
              Rows switch product type and go dirty (save/submit to apply on Amazon). Their browse node is cleared — set a new one for the target category.
            </span>
            {canReassign && (
              <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={mode !== 'reassign'}
                className="rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs text-slate-700 dark:text-slate-200">
                {otherTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
          </span>
        </label>
        <label className={cn('flex items-start gap-2 p-2 rounded border cursor-pointer transition-colors',
          mode === 'remove' ? 'border-red-300 bg-red-50/60 dark:border-red-800 dark:bg-red-950/30' : 'border-slate-200 dark:border-slate-700')}>
          <input type="radio" name="remove-category-mode" className="mt-0.5" checked={mode === 'remove'}
            onChange={() => setMode('remove')} />
          <span className="text-xs text-slate-700 dark:text-slate-200">
            <span className="font-semibold block">Remove the rows from this sheet</span>
            <span className="text-slate-500 dark:text-slate-400 block">
              Sheet-only: nothing is deleted on Amazon or in Nexus — the rows come back when you re-add the {type} category. Undo with ⌘Z.
            </span>
          </span>
        </label>
      </div>
    </DSModal>
  )
}

// ── Row completeness (HealthModal) ─────────────────────────────────────

// Per-row required-fields completeness. Counts the SAME required cells the grid
// reddens — i.e. col.required AND applicable to this row — mirroring the cell's
// own applicability gates (applicableParentage greying L5012-5019,
// applicableProductTypes L5024-5025, FBA-qty greying L5030-5031) and emptiness
// (value != null ? String : '' → isEmpty, L5293/5345). Greyed/not-applicable
// required cells are excluded so the chip never over-counts.
function computeRowCompleteness(row: Row, columns: Column[]): { filled: number; total: number } {
  if (row._ghost) return { filled: 0, total: 0 }
  // FFP.2 — delete rows need only the SKU; the completeness chip has nothing to count.
  if (String(row.record_action ?? '').toLowerCase() === 'delete') return { filled: 0, total: 0 }
  const parentage = String(row.parentage_level ?? '')
  const rowType = parentage.toLowerCase() === 'parent' ? 'VARIATION_PARENT'
    : parentage.toLowerCase() === 'child' ? 'VARIATION_CHILD'
    : 'STANDALONE'
  const rowProductType = String(row.product_type ?? '').toUpperCase()
  let total = 0, filled = 0
  for (const col of columns) {
    // UFX P4d — per-ROW required on union sheets: a column required only for
    // JACKET must not count against a PANTS row (union-OR over-counted).
    const requiredForRow = col.requiredForProductTypes
      ? (!!rowProductType && col.requiredForProductTypes.includes(rowProductType))
      : col.required
    if (!requiredForRow) continue
    // applicableParentage greying (mirrors guidanceLevel === 'not-applicable')
    if (col.applicableParentage?.length && !col.applicableParentage.includes(rowType)) continue
    // applicableProductTypes greying (mirrors !appliesToType)
    if (col.applicableProductTypes && !col.applicableProductTypes.includes(rowProductType)) continue
    // FBA-managed quantity is greyed/not-applicable on FBA rows
    if (col.id === 'fulfillment_availability__quantity'
      && /^(AMAZON|AFN|FBA)/.test(String(row.fulfillment_availability__fulfillment_channel_code ?? '').toUpperCase())) continue
    total++
    if (row[col.id] != null && String(row[col.id]) !== '') filled++
  }
  return { filled, total }
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

// Module-level constants shared by SubmitToAmazonPanel + per-row renderers.
// Used to live alongside the now-removed FetchFromAmazonPanel.

const ALL_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK']
const AMAZON_DOMAIN: Record<string, string> = {
  IT: 'amazon.it', DE: 'amazon.de', FR: 'amazon.fr',
  ES: 'amazon.es', UK: 'amazon.co.uk',
}

// ── PullFromAmazonPanel ────────────────────────────────────────────────
// Full attribute pull from Amazon for the current market. Lets the user
// pick scope (selected / visible / all rows) and which column groups to
// overwrite. Pulled data is merged into editor state via pushSnapshot()
// in the parent — Cmd+Z reverts the entire pull as one step. No DB
// writes happen until the user clicks Save.

interface PullPanelProps {
  selectedCount: number
  visibleCount: number
  totalCount: number
  currentMarket: string
  pulling: boolean
  onPull: (opts: { scope: 'selected' | 'visible' | 'all'; columns: 'all' | PullGroupId[] }) => void
  onClose: () => void
}

function PullFromAmazonPanel({
  selectedCount, visibleCount, totalCount, currentMarket, pulling, onPull, onClose,
}: PullPanelProps) {
  const [scope, setScope] = useState<'selected' | 'visible' | 'all'>(
    selectedCount > 0 ? 'selected' : 'visible',
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

  const scopeCount = scope === 'selected' ? selectedCount
                    : scope === 'visible'  ? visibleCount
                    : totalCount
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
            Pull from Amazon {currentMarket}
          </div>
          <div className="text-xs text-slate-400">
            Overwrites editor cells. ⌘Z to undo.
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
          ['visible',  `Visible rows (${visibleCount})`,   visibleCount > 0],
          ['all',      `All rows in sheet (${totalCount})`, totalCount > 0],
        ] as const).map(([id, label, enabled]) => (
          <label
            key={id}
            className={cn('flex items-center gap-2 py-1',
              enabled ? 'cursor-pointer' : 'opacity-40 cursor-not-allowed')}
          >
            <input
              type="radio"
              name="ff-pull-scope"
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
          <span className="text-[10px] text-slate-400">(every attribute Amazon returns)</span>
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
          Fetches full live data from Amazon. SP-API is rate-limited; large pulls take 2–5 min.
        </p>
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
  /** FFP.2 — rows needing publish on the current market (edited scope). */
  currentDirtyRows: Row[]
  currentSelectedRows: Row[]
  currentAllRows: Row[]
  getMarketRows: (mp: string) => Row[]
  onSubmit: (markets: Set<string>, scope: SubmitScope) => void
  onClose: () => void
}

function SubmitToAmazonPanel({
  currentMarket, productType, familyId, currentDirtyRows, currentSelectedRows,
  currentAllRows, getMarketRows, onSubmit, onClose,
}: SubmitPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set([currentMarket]))
  // FFP.2 — submit scope: edited (default) / grid selection / everything in view.
  const [scope, setScope] = useState<SubmitScope>('edited')
  const [counts, setCounts] = useState<Record<string, number>>({})
  const panelRef = useRef<HTMLDivElement>(null)

  // Per-market row counts for the chosen scope. The current market counts from
  // live state; other markets count their localStorage draft — edited scope by
  // flags, selected/all by SKU match (row ids are per-market).
  useEffect(() => {
    const scopeSkus = scope === 'edited' ? null : new Set(
      (scope === 'selected' ? currentSelectedRows : currentAllRows)
        .map((r) => String(r.item_sku ?? '')).filter(Boolean),
    )
    const out: Record<string, number> = {}
    for (const mp of ALL_MARKETS) {
      if (mp === currentMarket) {
        out[mp] = scope === 'selected' ? currentSelectedRows.length
          : scope === 'all' ? currentAllRows.length
          : currentDirtyRows.length
        continue
      }
      try {
        const saved = getMarketRows(mp)
        out[mp] = scope === 'edited'
          ? saved.filter((r) => !r._ghost && (r._dirty || r._isNew || r._needsPublish)).length
          : saved.filter((r) => !r._ghost && scopeSkus!.has(String(r.item_sku ?? ''))).length
      } catch { out[mp] = 0 }
    }
    setCounts(out)
  }, [scope, currentMarket, productType, familyId, currentDirtyRows.length,
    currentSelectedRows, currentAllRows, getMarketRows])

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

      {/* FFP.2 — rows-to-submit scope */}
      <div className="px-4 pt-3 pb-1 space-y-1.5 border-b border-slate-100 dark:border-slate-800">
        <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400">Rows to submit</div>
        {([
          { id: 'edited' as const, label: `Edited / pending (${currentDirtyRows.length})` },
          { id: 'selected' as const, label: `Selected in grid (${currentSelectedRows.length})` },
          { id: 'all' as const, label: `All rows in view (${currentAllRows.length})` },
        ]).map((opt) => (
          <label key={opt.id} className="flex items-center gap-2 cursor-pointer text-[12px] text-slate-700 dark:text-slate-300">
            <input
              type="radio"
              name="ff-submit-scope"
              checked={scope === opt.id}
              onChange={() => setScope(opt.id)}
              className="w-3 h-3 accent-blue-600"
            />
            {opt.label}
          </label>
        ))}
        {scope !== 'edited' && (
          <div className="text-[10.5px] text-slate-400 pb-1">Other markets match these rows by SKU.</div>
        )}
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
                {count} to send
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
          onClick={() => onSubmit(selected, scope)}
          disabled={selected.size === 0 || totalRows === 0}
        >
          <Send className="w-3.5 h-3.5 mr-1.5" />Submit
        </Button>
      </div>
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

interface VariationFamilyParams {
  parentSku: string
  productType: string
  variationTheme: string
  axes: Array<{ name: string; columnId: string; values: string[] }>
  position: 'end' | 'above' | 'below'
}

interface AddRowsPanelProps {
  initialType: 'row' | 'parent' | 'variant'
  initialPosition: 'end' | 'above' | 'below'
  rows: Row[]
  hasSelection: boolean
  productType: string
  marketplace: string
  /** Valid Amazon variation_theme enum values for the active product type
   *  (from the manifest); used by the variation wizard. */
  variationThemes: string[]
  /** All column ids in the active manifest; lets the wizard target the real
   *  axis column the product type exposes (e.g. size vs apparel_size). */
  manifestColumnIds: string[]
  onAdd: (params: AddRowsParams) => void
  onAddFamily: (params: VariationFamilyParams) => void
  onClose: () => void
}

// Preset axis suggestions when the manifest has nothing better to offer.
const VARIATION_AXIS_SUGGESTIONS: Record<string, string[]> = {
  Color:  ['Black', 'White', 'Blue', 'Red', 'Yellow', 'Green', 'Grey', 'Brown', 'Navy', 'Orange'],
  Size:   ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL'],
}

function AddRowsPanel({ initialType, initialPosition, rows, hasSelection, productType, marketplace: _marketplace, variationThemes, manifestColumnIds, onAdd, onAddFamily, onClose }: AddRowsPanelProps) {
  // Top-level mode: the existing blank-row adder vs the new variation wizard.
  const [mode, setMode] = useState<'rows' | 'variation'>('rows')
  const [type, setType] = useState<'row' | 'parent' | 'variant'>(initialType)
  const [count, setCount] = useState(1)
  const [position, setPosition] = useState<'end' | 'above' | 'below'>(initialPosition)
  const [replicateFromId, setReplicateFromId] = useState('')
  const [parentSku, setParentSku] = useState('')

  // ── Variation-wizard state ─────────────────────────────────────────────
  const columnIdSet = useMemo(() => new Set(manifestColumnIds), [manifestColumnIds])
  // Axis names offered by the live themes (e.g. SIZE_COLOR → Size, Color),
  // plus the universal Size/Color presets, deduped + order-stable.
  const themeAxisNames = useMemo(() => {
    const fromThemes = variationThemes.flatMap((t) => parseThemeAxes(t))
    const ordered = ['Size', 'Color', ...fromThemes]
    return Array.from(new Set(ordered))
  }, [variationThemes])

  const [wizParentSku, setWizParentSku] = useState('')
  const [selectedAxes, setSelectedAxes] = useState<string[]>(['Size', 'Color'])
  const [axisValues, setAxisValues] = useState<Record<string, string[]>>({})
  const [customAxisName, setCustomAxisName] = useState('')
  const [customAxes, setCustomAxes] = useState<string[]>([])
  // Optional explicit theme override; '' = auto-derive from selected axes.
  const [themeOverride, setThemeOverride] = useState('')

  const displayWizAxes = useMemo(
    () => Array.from(new Set([...themeAxisNames, ...customAxes])),
    [themeAxisNames, customAxes],
  )

  function toggleAxis(name: string) {
    setSelectedAxes((prev) =>
      prev.includes(name) ? prev.filter((a) => a !== name) : [...prev, name],
    )
  }
  function addCustomAxis() {
    const name = customAxisName.trim()
    if (!name || displayWizAxes.some((a) => a.toLowerCase() === name.toLowerCase())) return
    setCustomAxes((prev) => [...prev, name])
    setSelectedAxes((prev) => [...prev, name])
    setCustomAxisName('')
  }

  // Try to match the chosen axes to a real theme enum (any order). Falls back
  // to a synthesised UPPERCASE_SNAKE theme (Amazon's own format) when the PT
  // has no enum or none matches — still a valid value on the parent row.
  const derivedTheme = useMemo(() => {
    if (!selectedAxes.length) return ''
    const want = [...selectedAxes].map((a) => a.toLowerCase()).sort()
    const match = variationThemes.find((t) => {
      const got = parseThemeAxes(t).map((a) => a.toLowerCase()).sort()
      return got.length === want.length && got.every((v, i) => v === want[i])
    })
    if (match) return match
    return selectedAxes.map((a) => a.toUpperCase().replace(/\s+/g, '_')).join('_')
  }, [selectedAxes, variationThemes])

  const effectiveTheme = themeOverride || derivedTheme

  // Per-axis target column (what the manifest exposes for this product type).
  const axisColumnFor = (axis: string) => resolveAxisColumnId(axis, columnIdSet)

  // Preview: parent + Cartesian product of the value lists.
  const activeAxisValueLists = selectedAxes
    .map((a) => (axisValues[a] ?? []).filter((v) => v.trim()))
    .filter((vals) => vals.length > 0)
  const variantCount = selectedAxes.length > 0 && activeAxisValueLists.length === selectedAxes.length
    ? activeAxisValueLists.reduce((n, vals) => n * vals.length, 1)
    : 0
  const sampleChildSku = wizParentSku.trim() && variantCount > 0
    ? buildChildSku(wizParentSku.trim(), selectedAxes.map((a) => (axisValues[a] ?? [])[0] ?? ''))
    : ''

  const canConfirmFamily = wizParentSku.trim().length > 0
    && selectedAxes.length > 0
    && variantCount > 0
    && !!effectiveTheme

  function handleAddFamily() {
    onAddFamily({
      parentSku: wizParentSku.trim().toUpperCase(),
      productType,
      variationTheme: effectiveTheme,
      axes: selectedAxes.map((name) => ({
        name,
        columnId: axisColumnFor(name),
        values: (axisValues[name] ?? []).map((v) => v.trim()).filter(Boolean),
      })),
      position,
    })
  }

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

  const modeTabCls = (m: typeof mode) => cn(
    'flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
    mode === m
      ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 shadow-sm'
      : 'text-slate-500 dark:text-slate-400 hover:text-slate-700',
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[1px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={cn(
        'bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-700 w-full mx-4 flex flex-col max-h-[90vh]',
        mode === 'variation' ? 'max-w-md' : 'max-w-sm',
      )}>

        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between flex-shrink-0">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            {mode === 'variation'
              ? <><GitFork className="w-4 h-4 text-blue-500" />Add variation listing</>
              : <><Plus className="w-4 h-4 text-blue-500" />Add rows</>}
          </h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Mode toggle: existing blank-row adder vs guided variation wizard */}
        <div className="px-4 pt-3 flex-shrink-0">
          <div className="flex bg-slate-100 dark:bg-slate-800 rounded-lg p-0.5 gap-0.5">
            <button type="button" onClick={() => setMode('rows')} className={modeTabCls('rows')}>Blank rows</button>
            <button type="button" onClick={() => setMode('variation')} className={modeTabCls('variation')}>Variation listing</button>
          </div>
        </div>

        {mode === 'rows' && (
        <div className="px-4 py-4 space-y-4 overflow-y-auto">

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
        )}

        {/* ── Variation wizard body ──────────────────────────────────────── */}
        {mode === 'variation' && (
        <div className="px-4 py-4 space-y-4 overflow-y-auto">
          <p className="text-[11px] text-slate-400 leading-snug">
            Generates one non-buyable parent plus a child row for every combination of the axis values below — like the eBay variation builder.
          </p>

          {/* Parent SKU */}
          <div>
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5 block">Parent SKU</label>
            <input
              type="text"
              value={wizParentSku}
              onChange={(e) => setWizParentSku(e.target.value.toUpperCase())}
              placeholder="e.g. GALE-JACKET"
              className="w-full text-xs border border-slate-300 dark:border-slate-600 rounded-lg px-3 py-1.5 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Product type (defaults to the editor's current type) */}
          <div>
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5 block">Product type</label>
            <div className="text-xs font-mono px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300">
              {productType || '—'}
            </div>
          </div>

          {/* Variation axes */}
          <div>
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-2 block">Variation axes</label>
            <div className="space-y-2">
              {displayWizAxes.map((name) => {
                const selected = selectedAxes.includes(name)
                const vals = axisValues[name] ?? []
                return (
                  <div key={name}
                    className={cn(
                      'rounded-lg border transition-colors',
                      selected
                        ? 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50'
                        : 'border-transparent',
                    )}>
                    <label className="flex items-center gap-2 px-3 py-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleAxis(name)}
                        className="w-3.5 h-3.5 rounded accent-blue-600"
                      />
                      <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{name}</span>
                      {selected && (
                        <span className="ml-auto text-[10px] text-slate-400 font-mono">→ {axisColumnFor(name)}</span>
                      )}
                    </label>
                    {selected && (
                      <div className="px-3 pb-2">
                        <TagInput
                          value={vals}
                          onChange={(tags) => setAxisValues((prev) => ({ ...prev, [name]: tags }))}
                          suggestions={VARIATION_AXIS_SUGGESTIONS[name] ?? []}
                          placeholder={`Add ${name.toLowerCase()} values… (Enter or comma)`}
                          aria-label={`${name} values`}
                        />
                      </div>
                    )}
                  </div>
                )
              })}

              {/* Custom axis input */}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={customAxisName}
                  onChange={(e) => setCustomAxisName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustomAxis() } }}
                  placeholder="+ Add custom axis…"
                  className="flex-1 text-xs bg-transparent border border-dashed border-slate-300 dark:border-slate-600 rounded-lg px-3 py-1.5 text-slate-600 dark:text-slate-400 placeholder:text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                {customAxisName.trim() && (
                  <Button size="sm" variant="ghost" onClick={addCustomAxis}>
                    <Plus className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Variation theme (derived, overridable from the live enum) */}
          <div>
            <label className="text-xs font-medium text-slate-500 dark:text-slate-400 mb-1.5 block">
              Variation theme
              <span className="ml-1 font-normal opacity-70">(value written on the parent row)</span>
            </label>
            {variationThemes.length > 0 ? (
              <select value={themeOverride} onChange={(e) => setThemeOverride(e.target.value)}
                className={selectCls}>
                <option value="">Auto from axes — {derivedTheme || '…'}</option>
                {variationThemes.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            ) : (
              <div className="text-xs font-mono px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300">
                {derivedTheme || '—'}
              </div>
            )}
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

          {sampleChildSku && (
            <div className="text-[10px] text-slate-400">
              Example child SKU: <span className="font-mono text-slate-600 dark:text-slate-300">{sampleChildSku}</span>
            </div>
          )}
        </div>
        )}

        {/* Footer */}
        {mode === 'rows' ? (
          <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3 bg-slate-50/50 dark:bg-slate-800/30 rounded-b-xl flex-shrink-0">
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
        ) : (
          <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3 bg-slate-50/50 dark:bg-slate-800/30 rounded-b-xl flex-shrink-0">
            <span className="text-[11px] text-slate-400">
              {variantCount > 0
                ? <>1 parent + <strong className="text-slate-600 dark:text-slate-300">{variantCount}</strong> variant{variantCount !== 1 ? 's' : ''}</>
                : selectedAxes.length > 0
                ? <span className="text-amber-500">Add values to every selected axis</span>
                : <span className="text-amber-500">Select at least one axis</span>}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button size="sm" disabled={!canConfirmFamily} onClick={handleAddFamily}>
                <Plus className="w-3.5 h-3.5 mr-1" />Add family
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// VersionHistoryPanel removed — merged into HistoryModal (H.1–H.4)

// ── CoverageModal ───────────────────────────────────────────────────────

const COVERAGE_MARKETS = ['IT', 'DE', 'FR', 'ES', 'UK'] as const
type CoverageStatus = 'active' | 'inactive' | 'suppressed' | 'missing'
type CoverageFilter = 'all' | 'active' | 'suppressed' | 'missing'

function CoverageModal({
  rows, marketplace, onSwitchMarket, onClose,
}: {
  rows: Row[]
  marketplace: string
  onSwitchMarket: (m: string) => void
  onClose: () => void
}) {
  const [filter, setFilter] = useState<CoverageFilter>('all')

  const filtered = useMemo(() => {
    if (filter === 'all') return rows
    return rows.filter((row) => {
      const cov = row._marketCoverage as Record<string, { status: string }> | undefined
      if (!cov) return filter === 'missing'
      return COVERAGE_MARKETS.some((m) => {
        const s = (cov[m]?.status ?? 'missing') as CoverageStatus
        return s === filter
      })
    })
  }, [rows, filter])

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  function statusDot(status: CoverageStatus) {
    const cls =
      status === 'active'     ? 'bg-emerald-500'
      : status === 'suppressed' ? 'bg-red-500'
      : status === 'inactive'   ? 'bg-amber-400'
      :                           'bg-slate-300 dark:bg-slate-600'
    return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${cls}`} />
  }

  const totals: Record<string, number> = { active: 0, suppressed: 0, inactive: 0, missing: 0 }
  for (const row of rows) {
    const cov = row._marketCoverage as Record<string, { status: string }> | undefined
    for (const m of COVERAGE_MARKETS) {
      const s = (cov?.[m]?.status ?? 'missing') as CoverageStatus
      totals[s] = (totals[s] ?? 0) + 1
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-3xl max-h-[80vh] flex flex-col rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-slate-500" />
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Market Coverage</span>
            <span className="text-xs text-slate-400">{rows.length} SKU{rows.length !== 1 ? 's' : ''}</span>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Summary strip + filter */}
        <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center gap-3 flex-wrap">
          {(['all', 'active', 'suppressed', 'missing'] as CoverageFilter[]).map((f) => {
            const count = f === 'all' ? rows.length : totals[f] ?? 0
            const labelCls =
              f === 'active'     ? 'text-emerald-700 dark:text-emerald-400'
              : f === 'suppressed' ? 'text-red-700 dark:text-red-400'
              : f === 'missing'    ? 'text-slate-500 dark:text-slate-400'
              : 'text-slate-700 dark:text-slate-200'
            return (
              <button key={f} type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  'text-xs px-2 py-0.5 rounded-full border transition-colors',
                  filter === f
                    ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:border-blue-700 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800',
                  filter !== f && labelCls,
                )}>
                {f === 'all' ? 'All SKUs' : `${f.charAt(0).toUpperCase() + f.slice(1)}`} · {count}
              </button>
            )
          })}
          <div className="flex-1" />
          <div className="flex items-center gap-2">
            {COVERAGE_MARKETS.map((m) => (
              <button key={m} type="button"
                onClick={() => onSwitchMarket(m)}
                className={cn(
                  'text-[11px] font-medium px-2 py-0.5 rounded transition-colors',
                  m === marketplace
                    ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                    : 'text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 dark:text-slate-400',
                )}
                title={`Switch editor to ${m}`}
              >{m}</button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="overflow-auto flex-1">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800/80 z-10">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-700 w-48">SKU</th>
                <th className="text-left px-3 py-2 font-medium text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-700 w-16">Type</th>
                {COVERAGE_MARKETS.map((m) => (
                  <th key={m}
                    className={cn(
                      'px-3 py-2 font-medium border-b border-slate-200 dark:border-slate-700 text-center cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors',
                      m === marketplace ? 'text-blue-600 dark:text-blue-400' : 'text-slate-600 dark:text-slate-300',
                    )}
                    onClick={() => onSwitchMarket(m)}
                    title={`Switch editor to ${m}`}
                  >{m}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400 text-xs">No SKUs match this filter.</td></tr>
              )}
              {filtered.map((row) => {
                const sku = String(row.item_sku ?? '—')
                const parentage = String(row.parentage_level ?? '')
                const isParent = parentage.toLowerCase() === 'parent'
                const isChild = parentage.toLowerCase() === 'child'
                const cov = row._marketCoverage as Record<string, { status: string; title?: string; price?: string }> | undefined
                return (
                  <tr key={row._rowId as string} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="px-3 py-1.5 font-mono text-[11px] text-slate-700 dark:text-slate-300 max-w-[192px] truncate">
                      {isChild && <span className="inline-block w-3 mr-0.5 text-slate-300">↳</span>}
                      {sku}
                    </td>
                    <td className="px-3 py-1.5 text-slate-400 dark:text-slate-500">
                      {isParent ? 'parent' : isChild ? 'child' : 'single'}
                    </td>
                    {COVERAGE_MARKETS.map((m) => {
                      const entry = cov?.[m]
                      const status = (entry?.status ?? 'missing') as CoverageStatus
                      const tip = [
                        `${m}: ${status}`,
                        entry?.title ? `"${entry.title.slice(0, 40)}${entry.title.length > 40 ? '…' : ''}"` : '',
                        entry?.price ? `€${entry.price}` : '',
                      ].filter(Boolean).join(' · ')
                      return (
                        <td key={m} className="px-3 py-1.5 text-center" title={tip}>
                          <div className="flex items-center justify-center gap-1">
                            {statusDot(status)}
                            {entry?.price && <span className="text-[10px] text-slate-500 dark:text-slate-400 tabular-nums">€{entry.price}</span>}
                          </div>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div className="px-4 py-2 border-t border-slate-100 dark:border-slate-800 flex items-center gap-4 text-[10px] text-slate-400">
          <span className="flex items-center gap-1">{statusDot('active')} Active</span>
          <span className="flex items-center gap-1">{statusDot('inactive')} Inactive</span>
          <span className="flex items-center gap-1">{statusDot('suppressed')} Suppressed</span>
          <span className="flex items-center gap-1">{statusDot('missing')} Not listed</span>
          <span className="ml-auto">Click a market column header to switch the editor to that market.</span>
        </div>
      </div>
    </div>
  )
}

// ── HealthModal ─────────────────────────────────────────────────────────

type HealthFilter = 'all' | 'suppressed' | 'issues' | 'incomplete'

function HealthModal({
  rows, columns, onClose,
}: {
  rows: Row[]
  columns: Column[]
  onClose: () => void
}) {
  const [filter, setFilter] = useState<HealthFilter>('all')

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const rowsWithHealth = useMemo(() => rows.map((row) => {
    const suppressed = !!row._suppressed
    const issueCount = typeof row._issueCount === 'number' ? row._issueCount : 0
    const issueSeverity = row._issueSeverity ? String(row._issueSeverity) : null
    const suppressionReason = row._suppressionReason ? String(row._suppressionReason) : null
    const { filled, total } = computeRowCompleteness(row, columns)
    const incomplete = total > 0 && filled < total
    return { row, suppressed, issueCount, issueSeverity, suppressionReason, filled, total, incomplete }
  }), [rows, columns])

  const counts = useMemo(() => ({
    suppressed: rowsWithHealth.filter((r) => r.suppressed).length,
    issues:     rowsWithHealth.filter((r) => r.issueCount > 0).length,
    incomplete: rowsWithHealth.filter((r) => r.incomplete).length,
    flagged:    rowsWithHealth.filter((r) => r.suppressed || r.issueCount > 0 || r.incomplete).length,
  }), [rowsWithHealth])

  const filtered = useMemo(() => {
    const base = filter === 'all'
      ? rowsWithHealth.filter((r) => r.suppressed || r.issueCount > 0 || r.incomplete)
      : filter === 'suppressed' ? rowsWithHealth.filter((r) => r.suppressed)
      : filter === 'issues'     ? rowsWithHealth.filter((r) => r.issueCount > 0)
      :                           rowsWithHealth.filter((r) => r.incomplete)
    return [...base].sort((a, b) => {
      if (a.suppressed !== b.suppressed) return a.suppressed ? -1 : 1
      return b.issueCount - a.issueCount
    })
  }, [rowsWithHealth, filter])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="w-full max-w-3xl max-h-[80vh] flex flex-col rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-slate-500" />
            <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">Listing Health</span>
            <span className="text-xs text-slate-400">{counts.flagged} of {rows.length} SKU{rows.length !== 1 ? 's' : ''} flagged</span>
          </div>
          <button type="button" onClick={onClose} className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Filter strip */}
        <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2 flex-wrap">
          {([
            { key: 'all' as HealthFilter,        label: `All flagged · ${counts.flagged}` },
            { key: 'suppressed' as HealthFilter, label: `Suppressed · ${counts.suppressed}`, cls: 'text-red-600 dark:text-red-400' },
            { key: 'issues' as HealthFilter,     label: `Has issues · ${counts.issues}`,    cls: 'text-amber-600 dark:text-amber-400' },
            { key: 'incomplete' as HealthFilter, label: `Incomplete · ${counts.incomplete}`, cls: 'text-slate-500 dark:text-slate-400' },
          ]).map(({ key, label, cls }) => (
            <button key={key} type="button"
              onClick={() => setFilter(key)}
              className={cn(
                'text-xs px-2 py-0.5 rounded-full border transition-colors',
                filter === key
                  ? 'bg-blue-50 border-blue-300 text-blue-700 dark:bg-blue-950/40 dark:border-blue-700 dark:text-blue-300'
                  : cn('border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800', cls ?? 'text-slate-600 dark:text-slate-300'),
              )}>
              {label}
            </button>
          ))}
        </div>

        {/* Table */}
        <div className="overflow-auto flex-1">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-slate-400">
              <CheckCircle2 className="w-8 h-8 text-emerald-400" />
              <span className="text-sm">No issues found — all SKUs look healthy.</span>
            </div>
          ) : (
            <table className="w-full text-xs border-collapse">
              <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800/80 z-10">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-700 w-40">SKU</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-700 w-16">Type</th>
                  <th className="text-center px-3 py-2 font-medium text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-700 w-24">Status</th>
                  <th className="text-center px-3 py-2 font-medium text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-700 w-20">Issues</th>
                  <th className="text-center px-3 py-2 font-medium text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-700 w-24">Required</th>
                  <th className="text-left px-3 py-2 font-medium text-slate-600 dark:text-slate-300 border-b border-slate-200 dark:border-slate-700">Suppression / Note</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ row, suppressed, issueCount, issueSeverity, suppressionReason, filled, total }) => {
                  const sku = String(row.item_sku ?? '—')
                  const parentage = String(row.parentage_level ?? '')
                  const isParent = parentage.toLowerCase() === 'parent'
                  const isChild = parentage.toLowerCase() === 'child'
                  const listingStatus = row._listingStatus ? String(row._listingStatus) : null
                  return (
                    <tr key={row._rowId as string} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                      <td className="px-3 py-1.5 font-mono text-[11px] text-slate-700 dark:text-slate-300 max-w-[160px] truncate">
                        {isChild && <span className="inline-block w-3 mr-0.5 text-slate-300">↳</span>}
                        {sku}
                      </td>
                      <td className="px-3 py-1.5 text-slate-400 dark:text-slate-500">
                        {isParent ? 'parent' : isChild ? 'child' : 'single'}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {suppressed
                          ? <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400 font-medium"><AlertCircle className="w-3 h-3" />Suppressed</span>
                          : listingStatus
                          ? <span className={cn('font-medium',
                              (listingStatus === 'ACTIVE' || listingStatus === 'BUYABLE') ? 'text-emerald-600 dark:text-emerald-400'
                              : listingStatus === 'INACTIVE' ? 'text-amber-500 dark:text-amber-400'
                              : 'text-slate-400'
                            )}>{listingStatus}</span>
                          : <span className="text-slate-300 dark:text-slate-600">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {issueCount > 0
                          ? <span className={cn('font-medium tabular-nums',
                              issueSeverity === 'ERROR' ? 'text-orange-600 dark:text-orange-400' : 'text-amber-600 dark:text-amber-400'
                            )}>{issueCount}{issueSeverity ? ` ${issueSeverity.slice(0,3).toLowerCase()}` : ''}</span>
                          : <span className="text-slate-300 dark:text-slate-600">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        {total > 0
                          ? <span className={cn('font-mono tabular-nums',
                              filled === total ? 'text-emerald-600 dark:text-emerald-400'
                              : filled === 0 ? 'text-red-500 dark:text-red-400'
                              : 'text-amber-600 dark:text-amber-400'
                            )}>{filled}/{total}</span>
                          : <span className="text-slate-300 dark:text-slate-600">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-slate-500 dark:text-slate-400 truncate max-w-[220px]" title={suppressionReason ?? undefined}>
                        {suppressionReason ?? <span className="text-slate-300 dark:text-slate-600">—</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
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
  onGroupSelected: () => void
  onClose: () => void
}

function ContextMenu({ x, y, canPaste, hasSelection, selRowCount, onCut, onCopy, onPaste, onInsertAbove, onInsertBelow, onDeleteRows, onAddRows, onClearCells, onGroupSelected, onClose }: ContextMenuProps) {
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
  const menuW = 200, menuH = 300
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
      {item('Group selected…', undefined, onGroupSelected, selRowCount === 0)}
      {item('Clear cells', 'Del', onClearCells, !hasSelection)}
    </div>
  )
}


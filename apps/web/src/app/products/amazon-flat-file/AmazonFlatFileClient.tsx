'use client'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'

import {
  useCallback, useEffect, useRef, useState, useMemo, memo,
  type KeyboardEvent,
} from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  Activity, AlertCircle, AlertTriangle, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight,
  Clock, Copy, Download, FileSpreadsheet, GitBranch, GitFork, Globe, History, Image as ImageIcon, Keyboard, Loader2, Pin, Plus, RefreshCw, RotateCcw,
  Search, Send, Trash2, Upload, X, ArrowRightLeft,
  Undo2, Redo2, GripVertical, Wand2,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { evaluateRule, TONE_CLASSES, type ConditionalRule } from '@/app/_shared/bulk-edit/conditional-format'
import { type FindCell } from '@/app/_shared/bulk-edit/find-replace'
import { useFlatFileCore } from '@/components/flat-file/useFlatFileCore'
import { AMAZON_FILTER_DEFAULT, type AmazonFFFilterState, type AmazonFilterDims } from '../_shared/flat-file-filter.types'
import { FFSavedViews, type FFViewState } from '../_shared/FFSavedViews'
import { type PullDiffApplyResult } from './PullDiffModal'
import { type ImportApplyResult } from './ImportWizardModal'
import { PendingPullBanner } from '../_shared/PendingPullBanner'
import { FLAT_FILE_SHORTCUTS } from '../_shared/flat-file-shortcuts'
import { FlatFileToolbar as FlatFileIconToolbar, TbBtn as SharedTbBtn } from '@/components/flat-file/FlatFileToolbar'
import { ColumnGroupModal } from '@/design-system/components/ColumnGroupModal'
import { Tooltip } from '@/design-system/primitives/Tooltip'
import { cn } from '@/lib/utils'
import { getBackendUrl } from '@/lib/backend-url'
import { PublishModeBadge } from '@/components/PublishModeBadge'
import { useOrderEventsRefresh } from '@/hooks/use-order-events-refresh'
import { useToast } from '@/components/ui/Toast'
import { HistoryModal } from '@/components/flat-file/HistoryModal'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { TagInput } from '@/design-system/primitives/TagInput'
import { ChannelStrip } from '../ebay-flat-file/ChannelStrip'
import { OverrideBadge } from '../_shared/OverrideBadge'
import type { FlatFileAiChange } from '@/components/flat-file/FlatFileGrid.types'
import { FEED_ERROR_CODES } from './feedErrorCodes'
import { categoryOf, assignCategory, productTypesInUse, mixedTypeFamilies, rowsMissingNode, formatNodeBreadcrumb } from './category-model'
import {
  loadGroups, saveGroups, loadGroupMode, saveGroupMode, loadCollapsedGroups, saveCollapsedGroups,
  groupIdForSku, fulfillmentBucket, makeGroupId, assignSkusToGroup, GROUP_PALETTE,
  type GroupMode, type FlatFileGroup, type FamilyColorName,
} from './group-model'

// EH.5 — Lazy-loaded modals, panels, and bars. Each one only ships
// to the browser when the operator first opens it, so the initial
// AmazonFlatFileClient chunk drops from ~600 kB to under ~250 kB.
// All are client-only (state-gated, no SSR benefit) — ssr: false
// short-circuits the SSR pass for them entirely.
const FindReplaceBar = dynamic(
  () => import('@/app/_shared/bulk-edit/components/FindReplaceBar').then((m) => m.FindReplaceBar),
  { ssr: false },
)
const ConditionalFormatBar = dynamic(
  () => import('@/app/_shared/bulk-edit/components/ConditionalFormatBar').then((m) => m.ConditionalFormatBar),
  { ssr: false },
)
const AmazonFFFilterPanelLazy = dynamic(
  () => import('../_shared/AmazonFFFilterPanel').then((m) => m.AmazonFFFilterPanel),
  { ssr: false },
)
const AIBulkModal = dynamic(
  () => import('./AIBulkModal').then((m) => m.AIBulkModal),
  { ssr: false },
)
const FFReplicateModal = dynamic(
  () => import('./FFReplicateModal').then((m) => m.FFReplicateModal),
  { ssr: false },
)
const PullDiffModal = dynamic(
  () => import('./PullDiffModal').then((m) => m.PullDiffModal),
  { ssr: false },
)
// PullHistoryDrawer removed — merged into HistoryModal (H.1–H.4)
const KeyboardShortcutsModal = dynamic(
  () => import('../../_shared/grid-lens/KeyboardShortcutsModal').then((m) => m.KeyboardShortcutsModal),
  { ssr: false },
)
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

/**
 * EH.5 — Returns true once `open` has been true at least once, then
 * stays true forever. Used to gate dynamic-imported modals so:
 *   - The chunk doesn't load until the operator first opens it
 *     (gating by `open` directly would unload the modal on close,
 *     wiping any in-modal state)
 *   - Subsequent opens are instant (chunk + component stay mounted)
 *
 * Mutating a ref during render is legal: it derives from props, not
 * from state, so it's idempotent and doesn't break React's render
 * model. The hook returns the same value across renders once true.
 */
function useOpenOnce(open: boolean): boolean {
  const ref = useRef(false)
  if (open) ref.current = true
  return ref.current
}

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
  /** MT.3 — union manifest: which product types define this column + which
   *  require it. Lets a cell grey out for a row whose product_type it doesn't
   *  apply to. undefined on a single-type manifest. */
  applicableProductTypes?: string[]
  requiredForProductTypes?: string[]
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

interface Row {
  _rowId: string
  _isNew?: boolean
  _dirty?: boolean
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

interface ValidationIssue { level: 'error' | 'warn'; msg: string }

// ── Constants ──────────────────────────────────────────────────────────

const MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK']

// ── Module-level SWR cache ─────────────────────────────────────────────
// Keyed by "MP:PT". Lives at module scope so it survives component
// unmount/remount (navigating Amazon → eBay → Amazon reuses the cache).
const SWR_TTL_MS = 5 * 60 * 1000
type Snapshot = { manifest: Manifest; rows: Row[]; fetchedAt: number }
const _swr = new Map<string, Snapshot>()
const _prefetchInFlight = new Set<string>()

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

// ── Per-product-family row banding ─────────────────────────────────────────
// Cycles through 6 colours. Each family (parent + its children) gets one slot.
// These are background-only classes to avoid cascading text-color onto cells.
const FAMILY_PALETTE = ['blue', 'purple', 'emerald', 'orange', 'teal', 'amber'] as const
type FamilyColor = typeof FAMILY_PALETTE[number]

const FC_PARENT_ROW: Record<FamilyColor, string> = {
  blue:    'bg-blue-100/80 dark:bg-blue-900/35',
  purple:  'bg-purple-100/80 dark:bg-purple-900/35',
  emerald: 'bg-emerald-100/80 dark:bg-emerald-900/35',
  orange:  'bg-orange-100/80 dark:bg-orange-900/35',
  teal:    'bg-teal-100/80 dark:bg-teal-900/35',
  amber:   'bg-amber-100/80 dark:bg-amber-900/35',
}
const FC_CHILD_ROW: Record<FamilyColor, string> = {
  blue:    'bg-blue-50/60 dark:bg-blue-950/20',
  purple:  'bg-purple-50/60 dark:bg-purple-950/20',
  emerald: 'bg-emerald-50/60 dark:bg-emerald-950/20',
  orange:  'bg-orange-50/60 dark:bg-orange-950/20',
  teal:    'bg-teal-50/60 dark:bg-teal-950/20',
  amber:   'bg-amber-50/60 dark:bg-amber-950/20',
}
// Opaque equivalents for sticky/frozen cells (prevent scroll bleed-through)
const FC_PARENT_FROZEN: Record<FamilyColor, string> = {
  blue:    'bg-blue-100 dark:bg-blue-900/60',
  purple:  'bg-purple-100 dark:bg-purple-900/60',
  emerald: 'bg-emerald-100 dark:bg-emerald-900/60',
  orange:  'bg-orange-100 dark:bg-orange-900/60',
  teal:    'bg-teal-100 dark:bg-teal-900/60',
  amber:   'bg-amber-100 dark:bg-amber-900/60',
}
const FC_CHILD_FROZEN: Record<FamilyColor, string> = {
  blue:    'bg-blue-50 dark:bg-blue-950/40',
  purple:  'bg-purple-50 dark:bg-purple-950/40',
  emerald: 'bg-emerald-50 dark:bg-emerald-950/40',
  orange:  'bg-orange-50 dark:bg-orange-950/40',
  teal:    'bg-teal-50 dark:bg-teal-950/40',
  amber:   'bg-amber-50 dark:bg-amber-950/40',
}
// Left-border accent: strong on parent (section-header feel), subtle on children
const FC_PARENT_BORDER: Record<FamilyColor, string> = {
  blue:    'border-l-blue-400 dark:border-l-blue-500',
  purple:  'border-l-purple-400 dark:border-l-purple-500',
  emerald: 'border-l-emerald-400 dark:border-l-emerald-500',
  orange:  'border-l-orange-400 dark:border-l-orange-500',
  teal:    'border-l-teal-400 dark:border-l-teal-500',
  amber:   'border-l-amber-400 dark:border-l-amber-500',
}
const FC_CHILD_BORDER: Record<FamilyColor, string> = {
  blue:    'border-l-blue-200 dark:border-l-blue-800',
  purple:  'border-l-purple-200 dark:border-l-purple-800',
  emerald: 'border-l-emerald-200 dark:border-l-emerald-800',
  orange:  'border-l-orange-200 dark:border-l-orange-800',
  teal:    'border-l-teal-200 dark:border-l-teal-800',
  amber:   'border-l-amber-200 dark:border-l-amber-800',
}

// CG — static swatch backgrounds (must be literal class strings for Tailwind JIT).
const GROUP_SWATCH: Record<FamilyColor, string> = {
  blue: 'bg-blue-400', purple: 'bg-purple-400', emerald: 'bg-emerald-400',
  orange: 'bg-orange-400', teal: 'bg-teal-400', amber: 'bg-amber-400',
}

// ── CG — group section rendering (VIEW-ONLY) ──────────────────────────────
// A RenderItem is either a data row (carrying its index into displayRows, so
// paste/selection/nav ri-mapping is unchanged) or a synthetic section header.
// Header items exist ONLY in the render output — never in rows/displayRows/the
// Amazon feed.
type RenderItem =
  | { kind: 'header'; groupId: string; name: string; color: FamilyColorName; count: number; collapsed: boolean }
  | { kind: 'row'; row: Row; dataIdx: number }

function GroupHeaderRow({
  name, color, count, collapsed, colSpan, onToggle,
}: {
  name: string; color: FamilyColorName; count: number; collapsed: boolean; colSpan: number; onToggle: () => void
}) {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className={cn(
          'px-2 py-1 border-b border-l-4 border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/60',
          FC_PARENT_BORDER[color],
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100"
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          <span>{name}</span>
          <span className="font-normal normal-case text-slate-400 dark:text-slate-500">
            · {count} {count === 1 ? 'SKU' : 'SKUs'}
          </span>
        </button>
      </td>
    </tr>
  )
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

// BN.2.1 — synthetic derived column; NEVER enters data/paste/serialize paths.
// CAT-WIDTH: single source of truth — used in both column def AND sticky-offset math.
const CATEGORY_COL_WIDTH = 360
const CATEGORY_COL: Column = { id: '__category', fieldRef: '', labelEn: 'Category', labelLocal: 'Category', required: false, kind: 'text', width: CATEGORY_COL_WIDTH }

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
function makeGhostRows(n: number): Row[] {
  return Array.from({ length: n }, () => makeGhostRow())
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
      if (lc.includes('colour') || lc.includes('color')) return 'Color'
      if (lc.includes('size')) return 'Size'
      // Strip a trailing "name"/"_name" token so "StyleName" → "Style".
      const cleaned = t.replace(/[_-]?name$/i, '') || t
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
  const router = useRouter()
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
    // MT.5 — in union mode, constrain the Product Type cell to a strict dropdown
    // of the sheet's categories, so each row's category is picked (not typed).
    if (!base || !unionManifest) return base
    const opts = ['', ...sheetTypes.map((t) => t.toUpperCase())]
    return {
      ...base,
      groups: base.groups.map((g) => ({
        ...g,
        columns: g.columns.map((c) =>
          c.id === 'product_type' ? { ...c, kind: 'enum' as ColumnKind, options: opts, selectionOnly: true } : c,
        ),
      })),
    }
  }, [unionManifest, manifest, sheetTypes])

  // MT.3 — fetch the UNION manifest whenever the sheet holds >1 product type.
  // Single type ⇒ clear it (effectiveManifest falls back to the single manifest).
  useEffect(() => {
    if (sheetTypes.length <= 1) { setUnionManifest(null); return }
    let alive = true
    const qs = `marketplace=${marketplace}&productTypes=${encodeURIComponent(sheetTypes.map((t) => t.toUpperCase()).join(','))}`
    fetch(`${getBackendUrl()}/api/amazon/flat-file/union-template?${qs}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (alive && m) setUnionManifest(m) })
      .catch(() => { /* union manifest is advisory; single-type still works */ })
    return () => { alive = false }
  }, [sheetTypes, marketplace])

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
  const rowOrderKey = `ff-amazon-${mp}-row-order`

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
  // MT.3 / BN.2.3 — derive sheetTypes from the union of the primary product type
  // AND the types actually present in the rows. A mixed-type family (e.g. COAT
  // rows + PANTS rows) therefore renders both types' columns automatically.
  // On market-switch, rows reload via loadData so inUse reflects the new set;
  // productType change re-derives immediately.
  // VALUE-GUARD: the functional updater compares sorted joined strings and returns
  // the PREVIOUS array when the set is unchanged — this prevents a new sheetTypes
  // reference on every cell edit from thrashing the union-manifest fetch.
  useEffect(() => {
    const inUse = productTypesInUse(rows)                                   // distinct UPPERCASE
    const next = Array.from(new Set([productType.toUpperCase(), ...inUse])).filter(Boolean)
    setSheetTypes((prev) => {
      const a = [...prev].map((t) => t.toUpperCase()).sort().join(',')
      const b = [...next].sort().join(',')
      return a === b ? prev : next                                          // no-op when set unchanged → no union refetch churn
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productType, marketplace, rows])

  // Non-null when localStorage has a draft with unsaved edits that differ from
  // the DB rows loaded on this page open.
  const [draftBanner, setDraftBanner] = useState<Row[] | null>(null)

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

  const {
    sortConfig, setSortConfig: _setSortCoreConfig, persistSort,
    sortPanelOpen, setSortPanelOpen,
    cfRules, setCfRules, persistCfRules,
    conditionalOpen: cfOpen, setConditionalOpen: setCfOpen,
    ffFilter, setFfFilter: setFFFilter,
    filterOpen: filterPanelOpen, setFilterOpen: setFilterPanelOpen,
    smartPasteEnabled, toggleSmartPaste,
    showRowImages, rowImageSize: imageSize, toggleRowImages, changeImageSize: setImageSizeCore,
    columnGroups, setColumnGroups,
    closedGroups, groupOrder, applyGroupSettings,
    columnsOpen, setColumnsOpen,
    findReplaceOpen, setFindReplaceOpen,
    validationOpen: showValidPanel, setValidationOpen: setShowValidPanel,
    aiPanelOpen, setAiPanelOpen,
    aiModalOpen, setAiModalOpen,
    selectedRows, setSelectedRows,
  } = core

  // Wrapper: persistSort + propagate across synced markets
  const setSortConfig = useCallback((levels: SortLevel[]) => {
    persistSort(levels)
    propagateSort(levels)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistSort])


  // Derived: open = all manifest groups minus whatever the user has closed
  const openGroups = useMemo(
    () => new Set((effectiveManifest?.groups ?? []).map((g) => g.id).filter((id) => !closedGroups.has(id))),
    [effectiveManifest, closedGroups],
  )

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

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchMode, setSearchMode] = useState<'rows' | 'columns'>('rows')
  const searchRef = useRef<HTMLInputElement>(null)

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

  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set())
  // ── CG — custom SKU groups (view-only; per-market, localStorage) ──────
  // Grouping is a pure VIEW concern: it never enters rows/data/paste/serialize/
  // submit/export. `family` (default) renders identically to before.
  const [groupMode, setGroupMode] = useState<GroupMode>(() => loadGroupMode(marketplace))
  const [customGroups, setCustomGroups] = useState<FlatFileGroup[]>(() => loadGroups(marketplace))
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => loadCollapsedGroups(marketplace))
  // Pending "Group selected…" creation (captured SKUs + draft name/colour).
  const [groupCreate, setGroupCreate] = useState<{ skus: string[]; name: string; color: FamilyColorName } | null>(null)
  // Tracks the market the group state currently belongs to, so persistence
  // saves to the right market and a market switch never clobbers it.
  const groupMarketRef = useRef(marketplace)
  const [frozenColCount, setFrozenColCount] = useState<number>(() => {
    try { return parseInt(localStorage.getItem('ff-frozen-cols') ?? '1', 10) || 1 } catch { return 1 }
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
  const { toast } = useToast() // FFS.7 — submit summary + feed-completion notices
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
  const openReviewModal = useCallback((data: ReviewData) => {
    setReviewAck(false)
    return new Promise<boolean>((resolve) => {
      setReviewModal({ data, resolve: (ok) => { setReviewModal(null); resolve(ok) } })
    })
  }, [])
  // submissionHistory is written to localStorage but no longer displayed (HistoryModal fetches live)
  const [submissionHistory, setSubmissionHistory] = useState<SubmissionRecord[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  // versionPanelOpen kept to handle "Version history…" menu — redirects to historyOpen

  // BF.1 — Find & Replace
  const [matchKeys, setMatchKeys] = useState<Set<string>>(new Set())

  // BF.4 — AI bulk actions (open states now from useFlatFileCore above)

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
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [showSetCategory, setShowSetCategory] = useState(false)
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
  const findReplaceMounted = useOpenOnce(findReplaceOpen)
  const cfMounted = useOpenOnce(cfOpen)
  const filterPanelMounted = useOpenOnce(filterPanelOpen)
  const aiModalMounted = useOpenOnce(aiModalOpen)
  const replicateMounted = useOpenOnce(replicateOpen)
  const [pendingPullReview, setPendingPullReview] = useState<{
    jobId: string
    rows: Row[]
    skusRequested: string[]
    skusReturned: number
    doneAt: string | null
  } | null>(null)
  // Tracks the anchor row when user drags on the # column to select rows
  const rowDragRef = useRef<number | null>(null)

  // ── Undo / Redo ────────────────────────────────────────────────────
  const rowsRef = useRef<Row[]>(rows)
  useEffect(() => { rowsRef.current = rows }, [rows])
  // FFX.2 — true when the local grid has diverged from the DB (e.g. a pull that
  // isn't yet round-tripped). Survives Publish clearing _dirty, so a background
  // external reload can't silently overwrite freshly-pulled work. Cleared after
  // a sync-to-DB / fromDB load / discard, when grid == DB again.
  const localDivergedRef = useRef(false)

  // On mount: reconcile localStorage draft with the SSR DB snapshot.
  // P.3 — _isNew rows not yet in the DB (creation failed in a previous session)
  // are auto-injected into the grid immediately, so they reappear without a
  // manual "Restore" click. Other dirty rows (failed updates) still show the
  // restore banner so the operator can choose whether to re-apply them.
  useEffect(() => {
    if (!initialProductType) return
    try {
      const base = `ff-rows-${initialMarketplace.toUpperCase()}-${initialProductType.toUpperCase()}`
      const key = familyId ? `${base}-family-${familyId}` : base
      const raw = localStorage.getItem(key)
      if (!raw) return
      const saved = JSON.parse(raw) as Row[]
      if (!Array.isArray(saved) || saved.length === 0) return

      // Auto-inject new rows that were never persisted to the DB.
      const dbSkus = new Set(
        (initialRows ?? []).map((r: any) => String(r.item_sku ?? '').trim()).filter(Boolean),
      )
      const unpersistedNew = saved.filter(
        (r) => r._isNew && String(r.item_sku ?? '').trim() && !dbSkus.has(String(r.item_sku ?? '').trim()),
      )
      if (unpersistedNew.length > 0) {
        setRows((prev) => {
          const existingSkus = new Set(prev.map((r) => String(r.item_sku ?? '').trim()).filter(Boolean))
          const toAdd = unpersistedNew.filter((r) => !existingSkus.has(String(r.item_sku ?? '').trim()))
          return toAdd.length ? [...prev, ...mergeAsinCache(toAdd, initialMarketplace)] : prev
        })
      }

      // Restore banner: only show when there are dirty rows (sync failures).
      if (saved.some((r) => r._dirty)) {
        setDraftBanner(saved)
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
  const displayRowsRef = useRef<Row[]>([])
  const allColumnsRef = useRef<Column[]>([])
  const selAnchorRef = useRef<{ ri: number; ci: number } | null>(null)
  const selEndRef = useRef<{ ri: number; ci: number } | null>(null)
  const isEditingRef = useRef(false)
  // GX.9 — column-anchor for Sheets-style row entry: Tab across a row's fields,
  // then Enter drops to the next row at the column where the row entry started.
  // Set by Tab, used by Enter, reset by any other navigation.
  const entryAnchorColRef = useRef<number | null>(null)

  useEffect(() => { selAnchorRef.current = selAnchor }, [selAnchor])
  useEffect(() => { selEndRef.current = selEnd }, [selEnd])
  useEffect(() => { isEditingRef.current = isEditing }, [isEditing])

  const [draggingRowId, setDraggingRowId] = useState<string | null>(null)
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ rowId: string; half: 'top' | 'bottom' } | null>(null)
  const [history, setHistory] = useState<Row[][]>([])
  const [future, setFuture] = useState<Row[][]>([])

  const pushSnapshot = useCallback(() => {
    setHistory((prev) => [...prev.slice(-49), rowsRef.current])
    setFuture([])
  }, [])

  const applyAiChanges = useCallback((changes: FlatFileAiChange[]) => {
    if (changes.length === 0) return
    pushSnapshot()
    setRows((prev) => {
      const byRowId = new Map(prev.map((r) => [r._rowId as string, r]))
      const bySku = new Map(prev.map((r) => [String(r.item_sku ?? ''), r]))
      const updated = new Map<string, Row>()
      for (const ch of changes) {
        const row = byRowId.get(ch.rowId) ?? bySku.get(ch.sku)
        if (!row) continue
        const existing = updated.get(row._rowId as string) ?? { ...row }
        updated.set(row._rowId as string, { ...existing, [ch.field]: ch.newValue, _dirty: true })
      }
      return prev.map((r) => updated.get(r._rowId as string) ?? r)
    })
  }, [pushSnapshot])

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

  // IN.1 — Override badges toggle (default on)
  const [showOverrideBadges, setShowOverrideBadges] = useState<boolean>(() => {
    try { return localStorage.getItem('ff-show-overrides') !== '0' } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('ff-show-overrides', showOverrideBadges ? '1' : '0') } catch {} }, [showOverrideBadges])

  // CG — persist group state on change. Save to the ref-tracked market (NOT
  // `marketplace` in deps) so switching markets — which reloads state below —
  // can't save the old market's groups into the new market's key.
  useEffect(() => { saveGroups(groupMarketRef.current, customGroups) }, [customGroups])
  useEffect(() => { saveGroupMode(groupMarketRef.current, groupMode) }, [groupMode])
  useEffect(() => { saveCollapsedGroups(groupMarketRef.current, collapsedGroups) }, [collapsedGroups])
  // CG — rehydrate group state when the market changes (ref guard skips mount
  // and prevents a load/save loop; persist effects above don't fire here since
  // their deps are the state values, which only change on the next render).
  useEffect(() => {
    if (groupMarketRef.current === marketplace) return
    groupMarketRef.current = marketplace
    setGroupMode(loadGroupMode(marketplace))
    setCustomGroups(loadGroups(marketplace))
    setCollapsedGroups(loadCollapsedGroups(marketplace))
  }, [marketplace])

  // IN.2 — Cascade button toggle (default on) + row being cascaded
  const [showCascadeButtons, setShowCascadeButtons] = useState<boolean>(() => {
    try { return localStorage.getItem('ff-show-cascade') !== '0' } catch { return true }
  })
  useEffect(() => { try { localStorage.setItem('ff-show-cascade', showCascadeButtons ? '1' : '0') } catch {} }, [showCascadeButtons])
  const [cascadeRow, setCascadeRow] = useState<Row | null>(null)

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

  const visibleGroups = useMemo(
    () => orderedGroups.filter((g) => openGroups.has(g.id)),
    [orderedGroups, openGroups],
  )

  // Column-mode search: filter columns within visible groups
  const displayGroups = useMemo<ColumnGroup[]>(() => {
    let groups = visibleGroups
    // MT.5 — filter the union grid to one category's columns (+ shared/infra
    // columns, which have no applicableProductTypes). Only when the filter is
    // an active sheet category.
    if (filterType && sheetTypes.map((t) => t.toUpperCase()).includes(filterType)) {
      groups = groups
        .map((g) => ({
          ...g,
          columns: g.columns.filter((c) => !c.applicableProductTypes || c.applicableProductTypes.includes(filterType)),
        }))
        .filter((g) => g.columns.length > 0)
    }
    if (!searchQuery || searchMode !== 'columns') return groups
    const q = searchQuery.toLowerCase()
    return groups
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
  }, [visibleGroups, searchQuery, searchMode, filterType, sheetTypes])

  // BN.1.1 — override display label only; id/fieldRef stay untouched (row keys + serialization).
  const withBrowseNodeLabel = (col: Column): Column =>
    col.id === 'recommended_browse_nodes' || /^recommended_browse_nodes\b/.test(col.fieldRef)
      ? { ...col, labelEn: 'Browse node', labelLocal: 'Browse node' }
      : col

  const allColumns = useMemo<Column[]>(
    () => displayGroups.flatMap((g) => g.columns).map(withBrowseNodeLabel),
    [displayGroups],
  )
  useEffect(() => { allColumnsRef.current = allColumns }, [allColumns])

  const manifestColumns = useMemo<Column[]>(
    () => (effectiveManifest?.groups ?? []).flatMap((g) => g.columns),
    [effectiveManifest],
  )

  // BN.2.1 — browse-node id→path label map (drives the Category chip).
  const browseNodeLabels = useMemo<Record<string, string>>(() => {
    const col = manifestColumns.find((c) => c.id === 'recommended_browse_nodes' || /^recommended_browse_nodes\b/.test(c.fieldRef))
    return col?.optionLabels ?? {}
  }, [manifestColumns])

  // BN.2.1 — position helpers for the synthetic Category column injection.
  // categoryInsertAfterIdx: allColumns index of record_action (insert Category after it).
  // categoryGroupInsertAfterIdx: displayGroups index of the group that contains record_action.
  // These drive the 3 render-side injections; data/paste/nav/serialize keep using allColumns.
  const categoryInsertAfterIdx = useMemo(
    () => allColumns.findIndex((c) => c.id === 'record_action'),
    [allColumns],
  )
  const categoryGroupInsertAfterIdx = useMemo(() => {
    if (categoryInsertAfterIdx < 0) return -1
    let cum = 0
    for (let gi = 0; gi < displayGroups.length; gi++) {
      cum += displayGroups[gi].columns.length
      if (cum > categoryInsertAfterIdx) return gi
    }
    return displayGroups.length - 1
  }, [displayGroups, categoryInsertAfterIdx])

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

  const cellErrors = useMemo<Map<string, ValidationIssue>>(() => {
    const m = new Map<string, ValidationIssue>()
    for (const row of rows) {
      if (row._ghost) continue // GX.5 — don't validate blank canvas rows
      for (const col of manifestColumns) {
        const rawVal = row[col.id]
        const val = rawVal != null ? String(rawVal) : ''
        if (col.required && !val) {
          m.set(`${row._rowId as string}:${col.id}`, { level: 'error', msg: `${col.labelEn} is required` })
        } else if (col.maxUtf8ByteLength && val) {
          // P2.3 — Amazon enforces UTF-8 byte limits (accented chars = 2+ bytes).
          const bytes = new TextEncoder().encode(val).length
          if (bytes > col.maxUtf8ByteLength) {
            m.set(`${row._rowId as string}:${col.id}`, { level: 'warn', msg: `Exceeds ${col.maxUtf8ByteLength}-byte Amazon limit (${bytes} bytes; accented chars count as 2+)` })
          }
        } else if (col.maxLength && val.length > col.maxLength) {
          m.set(`${row._rowId as string}:${col.id}`, { level: 'warn', msg: `Exceeds max ${col.maxLength} chars (${val.length})` })
        } else if (col.options?.length && val && !col.options.includes(val)) {
          m.set(`${row._rowId as string}:${col.id}`, { level: 'warn', msg: `"${val}" is not a valid option` })
        }
      }
    }
    // P2.1 — Feed-error field highlighting: when Amazon returns per-field errors,
    // shade those specific cells red so the operator knows exactly which to fix.
    // P3.1 — ListingIssue field highlighting: shade issue-flagged cells amber.
    for (const row of rows) {
      if (row._ghost) continue
      if (row._status === 'error' && row._errorFields) {
        const feedMsg = row._feedMessage ?? 'Amazon rejected this field'
        for (const fieldId of (row._errorFields as string[])) {
          const key = `${row._rowId as string}:${fieldId}`
          if (!m.has(key)) m.set(key, { level: 'error', msg: String(feedMsg) })
        }
      }
      if (row._issueFields && (row._issueFields as string[]).length) {
        const sev = row._issueSeverity ? String(row._issueSeverity) : 'WARNING'
        const level: 'error' | 'warn' = sev === 'ERROR' ? 'error' : 'warn'
        for (const fieldId of (row._issueFields as string[])) {
          const key = `${row._rowId as string}:${fieldId}`
          if (!m.has(key)) m.set(key, { level, msg: `Amazon listing issue: ${sev.toLowerCase()} on this attribute` })
        }
      }
    }
    // P4.1 — Orphaned child detection: flag parent_sku if no parent with that SKU exists.
    const parentSkus = new Set<string>()
    for (const r of rows) {
      if (!r._ghost && r.parentage_level === 'parent' && r.item_sku) parentSkus.add(String(r.item_sku))
    }
    for (const row of rows) {
      if (row._ghost || row.parentage_level !== 'child') continue
      const ps = String(row.parent_sku ?? '').trim()
      if (!ps || parentSkus.has(ps)) continue
      const key = `${row._rowId as string}:parent_sku`
      if (!m.has(key)) m.set(key, { level: 'error', msg: `No parent row with SKU "${ps}" found — add a parent row or fix the parent SKU` })
    }
    return m
  }, [rows, manifestColumns])

  const validErrorCount = useMemo(() => [...cellErrors.values()].filter((e) => e.level === 'error').length, [cellErrors])
  const validWarnCount  = useMemo(() => [...cellErrors.values()].filter((e) => e.level === 'warn').length, [cellErrors])

  // BN.4.3 — Advisory-only warnings (never block submit).
  const mixedFamilies = useMemo(() => mixedTypeFamilies(rows as Array<Record<string, unknown>>), [rows])
  const missingNodeRowIds = useMemo(() => rowsMissingNode(rows as Array<Record<string, unknown>>), [rows])
  // Display-only count — kept strictly separate from validErrorCount/validWarnCount (those drive blocking logic).
  const advisoryCount = mixedFamilies.length + missingNodeRowIds.length

  // P4 — Map from child rowId → parent's variation_theme, used for axis fingerprint + clone.
  const parentThemeByChildId = useMemo<Map<string, string>>(() => {
    const parentThemeBySku = new Map<string, string>()
    for (const r of rows) {
      if (!r._ghost && r.parentage_level === 'parent' && r.item_sku && r.variation_theme) {
        parentThemeBySku.set(String(r.item_sku), String(r.variation_theme))
      }
    }
    const m = new Map<string, string>()
    for (const r of rows) {
      if (!r._ghost && r.parentage_level === 'child' && r.parent_sku) {
        const theme = parentThemeBySku.get(String(r.parent_sku))
        if (theme) m.set(r._rowId as string, theme)
      }
    }
    return m
  }, [rows])

  // Row-mode search + multi-level sort (display-only, never mutates rows)
  const displayRows = useMemo<Row[]>(() => {
    // GX.5 — process only REAL rows through search/sort/filter/grouping; the
    // trailing ghost (blank canvas) rows are re-appended at the bottom below.
    const ghostRows = rows.filter((r) => r._ghost)
    const baseRows = rows.filter((r) => !r._ghost)
    let result: Row[]
    if (searchQuery && searchMode === 'rows') {
      const q = searchQuery.toLowerCase()
      result = baseRows.filter((row) =>
        Object.entries(row).some(
          ([k, v]) => !k.startsWith('_') && v != null && String(v).toLowerCase().includes(q),
        ),
      )
    } else {
      result = baseRows
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
    if (ffFilter.channel.parentage !== 'any') {
      result = result.filter((row) => {
        if (ffFilter.channel.parentage === 'parent') return row.parentage_level === 'parent'
        return row.parentage_level === 'child'
      })
    }
    if (ffFilter.channel.hasAsin !== 'any') {
      result = result.filter((row) =>
        ffFilter.channel.hasAsin === 'yes' ? !!row._asin : !row._asin,
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
      // FFA.5 — only TRUE orphans (parent absent from the view, e.g. filtered out)
      // get appended. A child of a COLLAPSED parent stays hidden until expanded —
      // previously it leaked to the bottom of the grid + into fill/copy/validation.
      const presentParentSkus = new Set(
        result.filter((r) => r.parentage_level === 'parent').map((r) => String(r.item_sku ?? '')),
      )
      for (const row of result) {
        if (row.parentage_level === 'child'
          && !processedChildIds.has(row._rowId as string)
          && !presentParentSkus.has(String(row.parent_sku ?? ''))) {
          grouped.push(row)
        }
      }
      result = grouped
    }

    // GX.5 — re-append the blank canvas at the bottom, but only in the default
    // (unfiltered) view; a search / row-filter result shouldn't be padded.
    const isDefaultView = !(searchQuery && searchMode === 'rows')
      && ffFilter.channel.parentage === 'any' && ffFilter.channel.hasAsin === 'any' && !ffFilter.missingRequired
    if (isDefaultView) result = result === baseRows ? [...baseRows, ...ghostRows] : [...result, ...ghostRows]

    displayRowsRef.current = result
    return result
  }, [rows, searchQuery, searchMode, sortConfig, collapsedParents, ffFilter, manifest, manifestColumns])

  // Family colour assignment: map each rowId → FamilyColor.
  // Derived purely from displayRows — NOT written onto row objects (no data leakage).
  const familyColorByRowId = useMemo<Map<string, FamilyColor>>(() => {
    const m = new Map<string, FamilyColor>()
    // First pass: assign a colour index to each unique parent SKU
    const parentColorMap = new Map<string, FamilyColor>()
    let idx = 0
    for (const row of displayRows) {
      if (row._ghost || row.parentage_level !== 'parent') continue
      const sku = String(row.item_sku ?? row._rowId)
      if (!parentColorMap.has(sku)) {
        parentColorMap.set(sku, FAMILY_PALETTE[idx % FAMILY_PALETTE.length])
        idx++
      }
    }
    // Only colour rows when there are at least 2 distinct families (single-family
    // sheets look fine with plain white rows — banding adds noise not value).
    if (parentColorMap.size < 2) return m
    // Second pass: apply colour to parents and their children
    for (const row of displayRows) {
      if (row._ghost) continue
      if (row.parentage_level === 'parent') {
        const color = parentColorMap.get(String(row.item_sku ?? row._rowId))
        if (color) m.set(row._rowId as string, color)
      } else if (row.parentage_level === 'child') {
        const color = parentColorMap.get(String(row.parent_sku ?? ''))
        if (color) m.set(row._rowId as string, color)
      }
    }
    return m
  }, [displayRows])

  // GX.5 — keep a buffer of trailing ghost rows so there's always a blank canvas
  // to type into (auto-grow). Tops up after a ghost materializes or on load.
  // Converges: once the buffer is full the guard is false, so no render loop.
  useEffect(() => {
    if (!productType) return
    const ghosts = rows.reduce((n, r) => n + (r._ghost ? 1 : 0), 0)
    if (ghosts >= GHOST_BUFFER) return
    setRows((prev) => {
      const g = prev.reduce((n, r) => n + (r._ghost ? 1 : 0), 0)
      return g >= GHOST_BUFFER ? prev : [...prev, ...makeGhostRows(GHOST_BUFFER - g)]
    })
  }, [rows, productType])

  // GX.5 — the visible rows excluding the blank canvas, for counts + select-all.
  const realDisplayRows = useMemo(() => displayRows.filter((r) => !r._ghost), [displayRows])
  const realRowCount = useMemo(() => rows.reduce((n, r) => n + (r._ghost ? 0 : 1), 0), [rows])

  // ── CG — render items: data rows + injected section headers (VIEW-ONLY) ──
  // `dataIdx` is the index into `displayRows`, passed to SpreadsheetRow as
  // rowIdx so data-ri / paste / selection / keyboard-nav are unchanged. Header
  // rows are never added to displayRows/rows, so submit + export (which iterate
  // `rows`) can never see them. `family` mode is a 1:1 passthrough → identical
  // DOM to before the feature.
  const groupHeaderColSpan = allColumns.length + 2 // data cols + Category col + row-header col
  const renderRows = useMemo<RenderItem[]>(() => {
    const all = displayRows.map((row, i) => ({ row, dataIdx: i }))
    const asRows = (xs: Array<{ row: Row; dataIdx: number }>): RenderItem[] =>
      xs.map((x) => ({ kind: 'row', row: x.row, dataIdx: x.dataIdx }))
    if (groupMode === 'family') return asRows(all)
    if (groupMode === 'custom' && customGroups.length === 0) return asRows(all)

    const ghosts = all.filter((x) => x.row._ghost)
    const reals = all.filter((x) => !x.row._ghost)

    type Sec = { id: string; name: string; color: FamilyColorName; items: Array<{ row: Row; dataIdx: number }> }
    let sections: Sec[]
    let sectionFor: (x: { row: Row; dataIdx: number }) => string

    if (groupMode === 'custom') {
      const ids = new Set(customGroups.map((g) => g.id))
      sections = [...customGroups]
        .sort((a, b) => a.order - b.order)
        .map((g) => ({ id: g.id, name: g.name, color: g.color, items: [] as Sec['items'] }))
      sections.push({ id: '__ungrouped', name: 'Ungrouped', color: 'blue', items: [] })
      sectionFor = (x) => {
        const gid = groupIdForSku(customGroups, String(x.row.item_sku ?? ''))
        return gid && ids.has(gid) ? gid : '__ungrouped'
      }
    } else {
      // fulfillment: a parent follows its FBA children (kept with its FBA group);
      // otherwise bucket by the row's own fulfillment. FBA section first.
      sections = [
        { id: '__fba', name: 'FBA', color: 'blue', items: [] },
        { id: '__fbm', name: 'FBM', color: 'amber', items: [] },
      ]
      const parentHasFba = new Set<string>()
      for (const x of reals) {
        if (String(x.row.parentage_level ?? '') === 'child' && fulfillmentBucket(x.row) === 'FBA') {
          parentHasFba.add(String(x.row.parent_sku ?? ''))
        }
      }
      sectionFor = (x) => {
        const bucket = String(x.row.parentage_level ?? '') === 'parent'
          ? (parentHasFba.has(String(x.row.item_sku ?? '')) ? 'FBA' : 'FBM')
          : fulfillmentBucket(x.row)
        return bucket === 'FBA' ? '__fba' : '__fbm'
      }
    }

    const byId = new Map(sections.map((s) => [s.id, s]))
    for (const x of reals) byId.get(sectionFor(x))!.items.push(x)

    const out: RenderItem[] = []
    for (const s of sections) {
      if (s.items.length === 0) continue // hide empty sections (incl. Ungrouped)
      const collapsed = collapsedGroups.has(s.id)
      out.push({ kind: 'header', groupId: s.id, name: s.name, color: s.color, count: s.items.length, collapsed })
      if (!collapsed) for (const it of s.items) out.push({ kind: 'row', row: it.row, dataIdx: it.dataIdx })
    }
    // Ghost/canvas rows always trail at the bottom, ungrouped + headerless.
    for (const gRow of ghosts) out.push({ kind: 'row', row: gRow.row, dataIdx: gRow.dataIdx })
    return out
  }, [displayRows, groupMode, customGroups, collapsedGroups])
  // P-1 — non-ghost selected count: used for Set-category button label/gate AND
  // passed to SetCategoryModal so button N === modal N === apply N always agree.
  const selectedRealCount = useMemo(
    () => rows.filter((r) => !r._ghost && selectedRows.has(r._rowId as string)).length,
    [rows, selectedRows],
  )
  // WARM — prefetch the Set-category modal chunk before first click so it opens instantly.
  const warmSetCategoryModal = useCallback(() => { void import('./SetCategoryModal') }, [])
  useEffect(() => { if (selectedRealCount > 0) warmSetCategoryModal() }, [selectedRealCount > 0, warmSetCategoryModal])

  // BF.1 — flat list of every visible cell for FindReplaceBar
  const findCells = useMemo<FindCell[]>(() => {
    // FFA.4 — only build the full-grid cell index when Find/Replace is actually
    // open (it's the sole consumer). Previously this allocated rows×cols objects
    // on every keystroke even with the panel closed.
    if (!findReplaceOpen) return []
    const out: FindCell[] = []
    displayRows.forEach((row, ri) => {
      allColumnsRef.current.forEach((col, ci) => {
        out.push({ rowIdx: ri, colIdx: ci, rowId: row._rowId as string, columnId: col.id, value: row[col.id] })
      })
    })
    return out
  }, [displayRows, findReplaceOpen])

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

  // GX.7 — Sheets-style aggregates of the selected cells (status bar).
  const selectionStats = useMemo(() => {
    if (!normSel) return null
    const parseNum = (raw: string): number | null => {
      let t = raw.trim().replace(/[^\d.,-]/g, '')
      if (!t) return null
      const hasDot = t.includes('.'), hasComma = t.includes(',')
      if (hasDot && hasComma) t = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')
      else if (hasComma) { const p = t.split(','); t = (p.length === 2 && p[1].length <= 2) ? `${p[0]}.${p[1]}` : t.replace(/,/g, '') }
      const n = parseFloat(t)
      return Number.isFinite(n) ? n : null
    }
    const { rMin, rMax, cMin, cMax } = normSel
    let nonEmpty = 0, numCount = 0, sum = 0, min = Infinity, max = -Infinity
    for (let ri = rMin; ri <= rMax; ri++) {
      const row = displayRows[ri]; if (!row) continue
      for (let ci = cMin; ci <= cMax; ci++) {
        const col = allColumns[ci]; if (!col) continue
        const s = row[col.id] == null ? '' : String(row[col.id]).trim()
        if (!s) continue
        nonEmpty++
        const n = parseNum(s)
        if (n != null) { numCount++; sum += n; if (n < min) min = n; if (n > max) max = n }
      }
    }
    return { nonEmpty, numCount, sum, avg: numCount ? sum / numCount : 0, min, max }
  }, [normSel, displayRows, allColumns])

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

  // GX.6 — double-click the fill handle to fill the selection down to the bottom
  // of the data (the last real, non-ghost row), like Sheets. Tiles a multi-row
  // selection; for a single cell it just copies the value down.
  const fillToBottom = useCallback(() => {
    if (!normSel) return
    const dr = displayRowsRef.current
    let lastDataRi = -1
    for (let i = dr.length - 1; i >= 0; i--) { if (!dr[i]?._ghost) { lastDataRi = i; break } }
    if (lastDataRi <= normSel.rMax) return // nothing below to fill into
    pushSnapshot()
    const { rMin, rMax, cMin, cMax } = normSel
    const selH = rMax - rMin + 1
    setRows((prev) => {
      const next = [...prev]
      for (let ri = rMax + 1; ri <= lastDataRi; ri++) {
        const targetDr = dr[ri]; if (!targetDr || targetDr._ghost) continue
        const srcDr = dr[rMin + ((ri - (rMax + 1)) % selH)]; if (!srcDr) continue
        const idx = prev.findIndex((r) => r._rowId === targetDr._rowId); if (idx === -1) continue
        const updated: Row = { ...prev[idx], _dirty: true }
        for (let ci = cMin; ci <= cMax; ci++) {
          const col = allColumnsRef.current[ci]
          if (col) updated[col.id] = srcDr[col.id]
        }
        next[idx] = updated
      }
      return next
    })
    setSelEnd({ ri: lastDataRi, ci: cMax })
  }, [normSel, pushSnapshot])

  const handleCellPointerDown = useCallback((ri: number, ci: number, shiftKey: boolean) => {
    entryAnchorColRef.current = null // clicking a cell starts a fresh row-entry anchor
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

  const moveSelection = useCallback((dCol: number, dRow: number, extend = false, keepEntryAnchor = false) => {
    if (!keepEntryAnchor) entryAnchorColRef.current = null // any non-Tab/Enter nav resets the row-entry anchor
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

  // GX.9 — edge autoscroll: while drag-selecting cells, hold near the top/bottom
  // edge of the grid and it scrolls + extends the selection (Sheets behaviour).
  const gridScrollRef = useRef<HTMLDivElement | null>(null)
  const autoScrollRef = useRef<{ raf: number; vy: number; x: number; y: number } | null>(null)
  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current) { cancelAnimationFrame(autoScrollRef.current.raf); autoScrollRef.current = null }
  }, [])
  const runAutoScroll = useCallback(() => {
    const a = autoScrollRef.current; const cont = gridScrollRef.current
    if (!a || !cont) return
    cont.scrollTop += a.vy
    const el = document.elementFromPoint(a.x, a.y) as HTMLElement | null
    const td = el?.closest('[data-ri]') as HTMLElement | null
    if (td) {
      const ri = parseInt(td.dataset.ri ?? '', 10), ci = parseInt(td.dataset.ci ?? '', 10)
      if (!isNaN(ri) && !isNaN(ci)) setSelEnd((p) => (p?.ri === ri && p?.ci === ci ? p : { ri, ci }))
    }
    a.raf = requestAnimationFrame(runAutoScroll)
  }, [])
  const updateAutoScroll = useCallback((vy: number, x: number, y: number) => {
    if (vy === 0) { stopAutoScroll(); return }
    if (autoScrollRef.current) { Object.assign(autoScrollRef.current, { vy, x, y }) }
    else { autoScrollRef.current = { raf: requestAnimationFrame(runAutoScroll), vy, x, y } }
  }, [runAutoScroll, stopAutoScroll])
  // Safety: always stop autoscroll on any pointer release, even outside the grid.
  useEffect(() => {
    const stop = () => stopAutoScroll()
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
    return () => { window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop) }
  }, [stopAutoScroll])

  const handleFillDrop = useCallback(() => {
    if (isFillDragging) executeFill()
  }, [isFillDragging, executeFill])

  // ── Keyboard handler (merged: undo/redo + clipboard + selection) ───

  useEffect(() => {
    function handle(e: globalThis.KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey
      // Undo/redo — but NOT while editing a cell, so ⌘Z does a native text-undo
      // inside the input instead of reverting the whole grid.
      if (mod && e.key === 'z' && !e.shiftKey && !isEditingRef.current) { e.preventDefault(); undo(); return }
      if (mod && e.key === 'z' && e.shiftKey && !isEditingRef.current)  { e.preventDefault(); redo(); return }
      if (mod && e.key === 'y' && !isEditingRef.current)                { e.preventDefault(); redo(); return }
      // BF.1 — Find & Replace
      if (mod && e.key === 'f') { e.preventDefault(); setFindReplaceOpen(true); return }
      if (mod && e.shiftKey && e.key === 'G') { e.preventDefault(); setColSearchOpen((o) => !o); return }
      if (mod && e.key === 'g') { e.preventDefault(); setColumnsOpen(true); return }
      // PE: '?' opens the shortcuts modal (no modifier — ignore when typing in an input)
      if (e.key === '?' && !mod && !isEditingRef.current) {
        const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase()
        if (tag !== 'input' && tag !== 'textarea') {
          e.preventDefault()
          setShortcutsOpen(true)
          return
        }
      }

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

      // Nothing selected yet (fresh load, or after Escape / a row delete): a nav or
      // edit keystroke wakes the grid at A1 instead of being swallowed — the root of
      // "shortcuts often don't work". Clipboard/fill need a real selection → no-op.
      if (!selAnchorRef.current) {
        if (mod && (e.key === 'c' || e.key === 'x' || e.key === 'v' || e.key === 'd')) return
        const row0 = displayRowsRef.current[0]; const col0 = allColumnsRef.current[0]
        if (!row0 || !col0) return
        setSelAnchor({ ri: 0, ci: 0 }); setSelEnd({ ri: 0, ci: 0 })
        setActiveCell({ rowId: row0._rowId as string, colId: col0.id })
        selAnchorRef.current = { ri: 0, ci: 0 }; selEndRef.current = { ri: 0, ci: 0 }
        // Plain nav just focuses A1; modified nav (⌘Home/End/Arrow) + edit/delete keys
        // fall through to their own handlers now that an anchor exists.
        if (!mod && (e.key === 'Tab' || e.key === 'Enter' || e.key.startsWith('Arrow'))) {
          e.preventDefault(); return
        }
      }

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
        entryAnchorColRef.current = null
        setSelAnchor({ ri: 0, ci: 0 }); setSelEnd({ ri: 0, ci: 0 })
        const row = displayRowsRef.current[0]; const col = allColumnsRef.current[0]
        if (row && col) setActiveCell({ rowId: row._rowId as string, colId: col.id })
        requestAnimationFrame(() => document.querySelector('[data-ri="0"][data-ci="0"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
        return
      }
      if (mod && e.key === 'End') {
        e.preventDefault()
        entryAnchorColRef.current = null
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
        if (e.key === 'Enter') {
          e.preventDefault()
          const a = entryAnchorColRef.current, ci = selAnchorRef.current?.ci ?? 0
          moveSelection(a !== null ? a - ci : 0, 1, false, true) // back to anchor column, down a row
          return
        }
        if (e.key === 'Tab') {
          e.preventDefault()
          if (entryAnchorColRef.current === null) entryAnchorColRef.current = selAnchorRef.current?.ci ?? 0
          moveSelection(1, 0, false, true)
          return
        }
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

      // Escape: drop the clipboard marquee + context menu and collapse a range back
      // to the active cell, but KEEP the anchor so the keyboard stays alive (Sheets
      // behaviour). Nulling it here was the main reason shortcuts went dead.
      if (e.key === 'Escape') {
        setClipboardRange(null)
        setContextMenu(null)
        entryAnchorColRef.current = null
        if (selAnchorRef.current) setSelEnd(selAnchorRef.current)
        return
      }

      // Printable key: enter edit mode replacing content. preventDefault so the
      // browser doesn't ALSO type the char into the freshly-focused input — the
      // char becomes the input's defaultValue (via editInitialChar). Without this
      // the first letter was entered twice ("A" → "AA").
      if (e.key.length === 1 && !mod) {
        e.preventDefault()
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

  // P-2: combined memo — stickyLeftByColIdx keyed by allColumns index + categoryStickyLeft
  // for the synthetic Category column.  When frozenColCount <= categoryInsertAfterIdx, the
  // loop never reaches column R so catLeft stays undefined and offsets are BYTE-IDENTICAL
  // to the original (default frozenColCount=1 is unaffected).  When frozen past R the
  // category's 200px is added to subsequent column offsets and the category itself gets
  // a sticky left equal to the accumulated offset right after column R.
  const { stickyLeftByColIdx, categoryStickyLeft } = useMemo(() => {
    const out: Record<number, number> = {}
    let left = 36 + rowHeaderWidth // checkbox(36) + row# (dynamic)
    let catLeft: number | undefined
    const R = categoryInsertAfterIdx
    const CAT_W = CATEGORY_COL_WIDTH // matches CATEGORY_COL.width — keep these equal
    for (let i = 0; i < Math.min(frozenColCount, allColumns.length); i++) {
      out[i] = left
      left += colWidths[allColumns[i].id] ?? allColumns[i].width
      if (i === R) {
        catLeft = left   // category sits right after column R in the render
        left += CAT_W   // shift all subsequent frozen cols by category width
      }
    }
    return { stickyLeftByColIdx: out, categoryStickyLeft: catLeft }
  }, [frozenColCount, allColumns, colWidths, rowHeaderWidth, categoryInsertAfterIdx])

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
    // GX.5 — never persist ghost (blank canvas) rows; they're re-created on load.
    try { localStorage.setItem(rowStorageKey(mp, pt), JSON.stringify(r.filter((row) => !row._ghost))) } catch {}
  }
  function loadSavedRows(mp: string, pt: string): Row[] | null {
    try {
      const raw = localStorage.getItem(rowStorageKey(mp, pt))
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }

  // MT.4 — the localStorage key suffix for the CURRENT grid. A union (mixed-
  // category) sheet persists under a composite "A+B" key derived from the rows'
  // ACTUAL product types, so a union sheet can NEVER overwrite a per-type sheet's
  // draft (and removing a category can't corrupt one either). Single-type rows →
  // that one type's key (identical to before).
  const storageType = useMemo(() => {
    const types = [...new Set(rows.map((r) => String(r.product_type ?? '').toUpperCase()).filter(Boolean))].sort()
    return types.length > 1 ? types.join('+') : (types[0] || productType)
  }, [rows, productType])
  // Always-fresh handle for the save sites that live in callbacks / unmount
  // cleanup (so they never persist under a stale key).
  const storageTypeRef = useRef(storageType)
  useEffect(() => { storageTypeRef.current = storageType }, [storageType])

  // Debounced autosave — fires 1 s after last edit. Persists under storageType
  // (composite for a union sheet) so it never clobbers a per-type draft.
  useEffect(() => {
    if (!productType || !rows.length) return
    const t = setTimeout(() => {
      saveRows(marketplace, storageType, rows)
      setLastLocalSave(Date.now())
    }, 1000)
    return () => clearTimeout(t)
  }, [rows, marketplace, storageType, productType])

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
  useEffect(() => { loadedExtraTypesRef.current = new Set([productType.toUpperCase()]) }, [productType, marketplace])
  useEffect(() => {
    if (sheetTypes.length <= 1) return
    const toLoad = sheetTypes.map((t) => t.toUpperCase()).filter((t) => !loadedExtraTypesRef.current.has(t))
    if (toLoad.length === 0) return
    let alive = true
    ;(async () => {
      for (const t of toLoad) {
        loadedExtraTypesRef.current.add(t) // mark before await → no double-fetch
        try {
          const q = new URLSearchParams({ marketplace, productType: t })
          if (familyId) q.set('productId', familyId)
          const res = await fetch(`${getBackendUrl()}/api/amazon/flat-file/rows?${q}`)
          if (!alive || !res.ok) continue
          const d = await res.json()
          const incoming = mergeAsinCache(
            (d.rows ?? []).map((r: any) => ({ ...r, product_type: String(r.product_type || t).toUpperCase() })),
            marketplace,
          )
          if (!alive || incoming.length === 0) continue
          setRows((prev) => {
            const seen = new Set(prev.map((r) => String(r.item_sku ?? '')))
            const append = incoming.filter((r: Row) => r.item_sku && !seen.has(String(r.item_sku)))
            return append.length ? [...prev, ...append] : prev
          })
        } catch { /* skip this category */ }
      }
    })()
    return () => { alive = false }
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
    if (!initialManifest || !initialMarketplace || !initialProductType) return
    const key = cacheKey(initialMarketplace, initialProductType)
    const snap = _swr.get(key)
    const isFresh = !!snap && (Date.now() - snap.fetchedAt) < SWR_TTL_MS
    if (isFresh) {
      // Return visit: paint rows from the module-level cache instantly.
      // Use the server-provided manifest (always fresh from the 30-min CDN cache).
      setManifest(initialManifest)
      setRows(snap.rows)
      _swr.set(key, { ...snap, manifest: initialManifest })
    } else {
      // First visit or stale cache: loadData() fetches both manifest+rows and
      // seeds the cache on completion so the next visit is instant.
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

    // FF-MS.4 — Optimistic paint from cache. If a fresh snapshot exists we
    // surface it before the fetch even starts; the network call still runs
    // to revalidate. force=true (Refresh schema) and fromDB=true bypass
    // the cache because the caller explicitly wants server-fresh data.
    let paintedFromCache = false
    if (!force && !fromDB) {
      const snap = _swr.get(cacheKey(mp, pt))
      if (snap && (Date.now() - snap.fetchedAt) < SWR_TTL_MS) {
        setManifest(snap.manifest)
        const saved = loadSavedRows(mp, pt)
        setRows(saved && saved.length > 0 ? mergeAsinCache(saved, mp) : snap.rows)
        paintedFromCache = true
        recordSwitchPerf(mp, pt, 'cache')
      }
    }
    if (!paintedFromCache) { setLoading(true); setManifest(null) }

    const backend = getBackendUrl()
    const qs = new URLSearchParams({ marketplace: mp, productType: pt, ...(force ? { force: '1' } : {}) })
    const rowsQs = new URLSearchParams({ marketplace: mp, productType: pt })
    if (familyId) rowsQs.set('productId', familyId)
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
      } else {
        // Full load — fetch manifest + rows in parallel.
        // fromDB=true: always use DB rows (called on external invalidation or
        // explicit reload). fromDB=false: prefer localStorage draft if present.
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
        const saved = fromDB ? null : loadSavedRows(mp, pt)
        let freshRows: Row[] = []
        if (saved && saved.length > 0) {
          freshRows = mergeAsinCache(saved, mp)
          setRows(freshRows)
        } else if (rRes.ok) {
          const d = await rRes.json()
          freshRows = mergeAsinCache(d.rows ?? [], mp)
          setRows(freshRows)
          // Update localStorage so the next page open starts fresh too.
          if (fromDB) saveRows(mp, pt, freshRows)
        } else {
          setRows([])
        }
        if (fromDB) { setDraftBanner(null); localDivergedRef.current = false } // FFX.2 — grid == DB
        // FF-MS.4 — Write through to the SWR cache so next visit is instant.
        _swr.set(cacheKey(mp, pt), { manifest, rows: freshRows, fetchedAt: Date.now() })
        // FF-MS.9 — Only record fetch-source telemetry if cache didn't already
        // resolve this switch — otherwise we'd double-log a cache+fetch pair.
        if (!paintedFromCache) recordSwitchPerf(mp, pt, 'fetch')
        // FF-MS.1 — URL is now updated by `navigateTo` BEFORE the fetch starts
        // (see below), so loadData no longer touches the URL. This avoids the
        // "switch happens but URL stays put on refresh" class of bugs and lets
        // the URL→state effect be the single driver of market changes.
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
  }, [familyId, initialManifest, initialMarketplace, initialProductType, initialRows])

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
  const navigateTo = useCallback((nextMp: string, nextPt: string) => {
    // FF-MS.5 — Force-flush any pending edits to localStorage before we
    // switch away. The 1s autosave debounce can leave the last few keystrokes
    // unwritten; this catches them so the draft restore banner has the full
    // picture when the user returns.
    if (productType && rowsRef.current.some((r) => r._dirty || r._isNew)) {
      saveRows(marketplace, storageTypeRef.current, rowsRef.current)
    }
    // FF-MS.9 — Start the switch-latency timer. loadData() reads this back
    // to compute click→ready ms and tags it with source (cache vs fetch).
    const nextMpU = nextMp.toUpperCase()
    const nextPtU = nextPt.toUpperCase()
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
      if (isEditingRef.current) return
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

  const deleteSelected = useCallback(() => {
    pushSnapshot()
    setRows((prev) => prev.filter((r) => !selectedRows.has(r._rowId as string)))
    setSelectedRows(new Set())
  }, [selectedRows])

  // MT.5 — bulk-set the category for the selected rows (build a mixed sheet fast).
  const bulkSetProductType = useCallback((t: string) => {
    const T = t.toUpperCase()
    pushSnapshot()
    setRows((prev) => prev.map((r) =>
      selectedRows.has(r._rowId as string) ? { ...r, product_type: T, _dirty: true } : r,
    ))
  }, [selectedRows, pushSnapshot])

  // BN.2.2 — bulk-assign product type + browse node to selected rows.
  const applyCategory = useCallback((c: { productType: string; nodeId: string | null }) => {
    pushSnapshot()
    setRows((prev) => prev.map((r) =>
      !r._ghost && selectedRows.has(r._rowId as string)
        ? ({ ...assignCategory(r as Record<string, unknown>, c), _dirty: true } as Row)
        : r))
    setSheetTypes((s) => Array.from(new Set([...s, c.productType.toUpperCase()])))
    setShowSetCategory(false)
  }, [selectedRows, pushSnapshot])

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
    setTimeout(() => setActiveCell({ rowId: parentRow._rowId as string, colId: 'item_sku' }), 30)
  }, [marketplace, pushSnapshot])

  // P4.3 — Clone variant: duplicate a child row with axis columns and identity
  // fields cleared so the operator only needs to fill in the new variant's values.
  const handleCloneVariant = useCallback((row: Row) => {
    if (row.parentage_level !== 'child') return
    const theme = parentThemeByChildId.get(row._rowId as string) ?? ''
    const colIdSet = new Set(allColumnsRef.current.map((c) => c.id))
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
    setTimeout(() => setActiveCell({ rowId: clone._rowId as string, colId: 'item_sku' }), 30)
  }, [parentThemeByChildId, pushSnapshot])

  // GX.5 — editing a ghost (blank canvas) row materializes it into a real new
  // row; the buffer effect then re-adds a fresh ghost below (auto-grow).
  // Fills the infra fields a real row needs (the ghost was fully blank). Spread
  // BEFORE the edited cell so if the user is editing product_type itself, their
  // value wins.
  const materializeGhost = (r: Row): Partial<Row> => (r._ghost
    ? { _ghost: false, _isNew: true, product_type: productType, record_action: 'full_update' }
    : {})

  const updateCell = useCallback((rowId: string, colId: string, value: unknown) => {
    pushSnapshot()
    setRows((prev) => prev.map((r) => r._rowId === rowId ? { ...r, ...materializeGhost(r), [colId]: value, _dirty: true } : r))
  }, [productType])

  const liveUpdateCell = useCallback((rowId: string, colId: string, value: unknown) => {
    setRows((prev) => prev.map((r) => r._rowId === rowId ? { ...r, ...materializeGhost(r), [colId]: value, _dirty: true } : r))
  }, [productType])

  const navigate = useCallback((rowId: string, colId: string, dir: 'right' | 'left' | 'down' | 'up') => {
    const colIds = allColumnsRef.current.map((c) => c.id)
    const rowIds = displayRowsRef.current.map((r) => r._rowId as string)
    let ci = colIds.indexOf(colId), ri = rowIds.indexOf(rowId)
    // GX.9 — column-anchor: Tab sets the anchor, Enter returns to it (row entry).
    if (dir === 'right') {
      if (entryAnchorColRef.current === null) entryAnchorColRef.current = ci
      ci = Math.min(ci + 1, colIds.length - 1)
    } else if (dir === 'left') { entryAnchorColRef.current = null; ci = Math.max(ci - 1, 0) }
    else if (dir === 'down') {
      ri = Math.min(ri + 1, rowIds.length - 1)
      if (entryAnchorColRef.current !== null) ci = Math.min(entryAnchorColRef.current, colIds.length - 1)
    } else { entryAnchorColRef.current = null; ri = Math.max(ri - 1, 0) }
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
    // Gather the dirty/new rows for a market — the active market from state, the
    // others from their localStorage snapshot. Shared by pre-flight + the submit.
    const gatherRows = (mp: string): Row[] => {
      if (mp === marketplace) return rows.filter((r) => r._dirty || r._isNew)
      try {
        const raw = localStorage.getItem(rowStorageKey(mp, productType))
        const saved: Row[] = raw ? JSON.parse(raw) : []
        return saved.filter((r) => r._dirty || r._isNew)
      } catch { return [] }
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
    } catch {
      // Persisting locally is best-effort; never block the submit
      // because the operator already committed to firing it.
    }

    if (markets.has(marketplace)) {
      setRows((prev) => prev.map((r) => r._dirty || r._isNew ? { ...r, _status: 'pending' } : r))
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
  }, [rows, marketplace, productType, manifest, saveSubmissionRecord, createVersion, toast, openReviewModal])

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
      setRows((prev) => prev.map((r) => {
        const sku = String(r.item_sku ?? '')
        const v = newVersions[sku]
        const withVersion = v != null ? { ...r, _version: v } : r
        return !r._ghost && !errorSkus.has(sku) && (withVersion._dirty || withVersion._isNew)
          ? { ...withVersion, _dirty: false, _isNew: false }
          : withVersion
      }))
      setTimeout(() => setSyncStatus('idle'), 4000)
      // FFC — surface newly-created products (new SKUs become real Nexus products).
      const createdCount: number = typeof data?.created === 'number' ? data.created : 0
      if (createdCount > 0) {
        toast.success(`${createdCount} new product${createdCount === 1 ? '' : 's'} created in Nexus — find them in /products`)
      }
      emitInvalidation({ type: 'channel-pricing.updated', meta: { marketplace, productType, source: 'amazon-flat-file' } })
      emitInvalidation({ type: 'stock.adjusted', meta: { source: 'amazon-flat-file', marketplace } })
      emitInvalidation({ type: 'product.updated', meta: { source: 'amazon-flat-file', marketplace } })
    } catch {
      setSyncStatus('error')
      toast.error('Save failed — check your connection and try again')
      setTimeout(() => setSyncStatus('idle'), 6000)
    }
  }, [manifest, marketplace, productType, toast])

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
              return {
                ...r,
                _status: fr.status as Row['_status'],
                _feedMessage: fr.message,
                _errorFields: fr.status === 'error' ? (fr.fields ?? []) : [],
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
          updateSubmissionRecord(entry.feedId, { status: entry.status as SubmissionRecord['status'] })
        }
      }
    } catch (e: any) { setLoadError({ message: e?.message ?? 'Polling failed', at: Date.now() }) }
    finally { setPolling(false) }
  }, [feedEntries, marketplace, productType, rows, updateSubmissionRecord, syncToPlatform, toast])

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
        const cols = new Set([...colSet].filter((c) => targetColIds.has(c)))
        // FFA.2 — merge into the target's EXISTING rows (local draft, else DB) by
        // SKU, instead of overwriting the target's whole row set with copies-only.
        let existingTarget = loadSavedRows(target, productType)
        if (!existingTarget) {
          try {
            const rq = new URLSearchParams({ marketplace: target, productType })
            if (familyId) rq.set('productId', familyId)
            const rr = await fetch(`${getBackendUrl()}/api/amazon/flat-file/rows?${rq}`)
            existingTarget = rr.ok ? ((await rr.json()).rows ?? []) : []
          } catch { existingTarget = [] }
        }
        const merged = mergeReplicatedRows(existingTarget ?? [], sourceRows, cols, STRUCTURAL)
        saveRows(target, productType, merged)
        copied += sourceRows.length
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
      const targetColIds = new Set(targetManifest.groups.flatMap((g) => g.columns.map((c) => c.id)))
      const cols = new Set([...colIds].filter((c) => targetColIds.has(c)))
      // FFA.2 — merge into the target's existing rows by SKU (don't replace the
      // grid with copies-only, which shadowed the target's real rows).
      let existingTarget = loadSavedRows(targetMarket, productType)
      if (!existingTarget) {
        try {
          const rq = new URLSearchParams({ marketplace: targetMarket, productType })
          if (familyId) rq.set('productId', familyId)
          const rr = await fetch(`${getBackendUrl()}/api/amazon/flat-file/rows?${rq}`)
          existingTarget = rr.ok ? ((await rr.json()).rows ?? []) : []
        } catch { existingTarget = [] }
      }
      const merged = mergeReplicatedRows(existingTarget ?? [], rows, cols, STRUCTURAL)

      setMarketplace(targetMarket)
      setManifest(targetManifest)
      setRows(merged)
      setFeedEntries([])
    } catch (e: any) {
      setLoadError({ message: e?.message ?? 'Copy failed', at: Date.now() })
    }
  }, [manifest, rows, productType, familyId])

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

    let targetSkus: string[]
    if (opts.scope === 'selected') {
      targetSkus = [...selectedRows]
        .map((id) => rows.find((r) => r._rowId === id)?.item_sku as string | undefined)
        .filter((s): s is string => !!s)
    } else if (opts.scope === 'visible') {
      targetSkus = displayRowsRef.current
        .map((r) => r.item_sku as string | undefined)
        .filter((s): s is string => !!s)
    } else {
      targetSkus = rows
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
  }, [marketplace, productType, selectedRows, rows, pushSnapshot])

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
    void syncToPlatform(next.filter((r) => !r._ghost), false)
  }, [pushSnapshot, productType, marketplace, syncToPlatform, familyId])

  // FX.1 — export the grid to TSV (Amazon template), CSV, or XLSX. Uses
  // effectiveManifest so a multi-category (MT) union sheet exports every column;
  // honors the current row selection so "export selected" is partial export.
  const exportFile = useCallback(async (format: 'tsv' | 'csv' | 'xlsx') => {
    const mf = effectiveManifest ?? manifest
    if (!mf) return
    const selectedOnly = selectedRows.size > 0
    const exportable = rows.filter((r) => !r._ghost) // GX.5 — never export blank canvas rows
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
  }, [manifest, effectiveManifest, orderedGroups, rows, selectedRows, productType, marketplace])

  // ── Save / Discard ────────────────────────────────────────────────
  const [saveFlash, setSaveFlash] = useState(false)

  const handleSave = useCallback(() => {
    createVersion('Manual save')
    saveRows(marketplace, storageTypeRef.current, rows)
    setSaveFlash(true)
    setTimeout(() => setSaveFlash(false), 2000)
    void syncToPlatform(rows.filter((r) => !r._ghost), false)
  }, [rows, marketplace, productType, createVersion, syncToPlatform])

  const handleDiscard = useCallback(() => {
    if (!confirm('Discard all local changes? Your edits will be lost and rows will reload from the server.')) return
    createVersion('Before discard')
    try { localStorage.removeItem(rowStorageKey(marketplace, productType)) } catch {}
    localDivergedRef.current = false // FFX.2 — discarding local work; grid reloads from DB
    setDraftBanner(null) // FFA.6 — the restore-draft banner referred to the now-deleted draft
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

  // IN.2 — Build CascadeModal fields from the row when cascade is triggered
  const cascadeFields = cascadeRow ? [
    { key: 'price', label: 'Price', value: cascadeRow.purchasable_offer__our_price },
    { key: 'title', label: 'Title', value: cascadeRow.item_name },
    { key: 'description', label: 'Description', value: cascadeRow.product_description },
    { key: 'quantity', label: 'Quantity', value: cascadeRow.fulfillment_availability__quantity },
  ] : []

  return (
    <div className="h-screen bg-slate-50 dark:bg-slate-950 flex flex-col"
      onDragOver={(e) => { if (!importOpen && e.dataTransfer.types.includes('Files')) e.preventDefault() }}
      onDrop={(e) => {
        // FX.7 — drop a spreadsheet on the grid to open the import wizard pre-loaded.
        // Only reacts to FILE drags (not the grid's own cell/column mouse-drags) and
        // only when the wizard isn't already open (its own drop zone handles that).
        if (importOpen || !e.dataTransfer.types.includes('Files')) return
        const f = e.dataTransfer.files?.[0]
        if (!f || !/\.(csv|tsv|txt|xlsx|xls|json)$/i.test(f.name)) return
        e.preventDefault()
        setImportInitialFile(f); setImportOpen(true)
      }}>

      {/* IN.2 — Cascade modal */}
      {cascadeRow && cascadeRow._productId && (
        <CascadeModal
          sourceProductId={String(cascadeRow._productId)}
          sourceSku={String(cascadeRow.item_sku ?? cascadeRow._rowId)}
          channel="AMAZON"
          marketplace={marketplace}
          availableFields={cascadeFields}
          onClose={() => setCascadeRow(null)}
          onSuccess={(n) => { if (n > 0) void loadData(marketplace, productType, false, true) }}
        />
      )}

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
              { label: 'Smart import (CSV/Excel/JSON)…', icon: <Wand2 className="w-3.5 h-3.5" />, onClick: () => { setImportInitialFile(null); setImportOpen(true) }, disabled: !effectiveManifest },
              { label: 'Import TSV…', icon: <Upload className="w-3.5 h-3.5" />, onClick: () => fileInputRef.current?.click() },
              { separator: true },
              { label: `Export as TSV (Amazon)${selectedRows.size > 0 ? ` · ${selectedRows.size} sel` : ''}`, icon: <Download className="w-3.5 h-3.5" />, onClick: () => void exportFile('tsv'), disabled: !rows.length },
              { label: `Export as CSV${selectedRows.size > 0 ? ` · ${selectedRows.size} sel` : ''}`, icon: <Download className="w-3.5 h-3.5" />, onClick: () => void exportFile('csv'), disabled: !rows.length },
              { label: `Export as Excel (.xlsx)${selectedRows.size > 0 ? ` · ${selectedRows.size} sel` : ''}`, icon: <Download className="w-3.5 h-3.5" />, onClick: () => void exportFile('xlsx'), disabled: !rows.length },
              { separator: true },
              { label: 'Reload rows from server', icon: <RefreshCw className="w-3.5 h-3.5" />, disabled: !productType || !rows.length,
                onClick: () => {
                  if (!confirm('Reload rows from server? Your unsaved local edits will be lost.')) return
                  try { localStorage.removeItem(rowStorageKey(marketplace, productType)) } catch {}
                  void loadData(marketplace, productType, false)
                }},
              { separator: true },
              { label: 'Version history…', icon: <Clock className="w-3.5 h-3.5" />, onClick: () => setHistoryOpen(true), disabled: !manifest },
            ]} />
            <MenuDropdown label="Edit" items={[
              { label: 'Undo', icon: <Undo2 className="w-3.5 h-3.5" />, onClick: undo, disabled: !history.length, shortcut: '⌘Z' },
              { label: 'Redo', icon: <Redo2 className="w-3.5 h-3.5" />, onClick: redo, disabled: !future.length, shortcut: '⌘⇧Z' },
              { separator: true },
              { label: 'Copy to market…', icon: <Copy className="w-3.5 h-3.5" />, onClick: () => setPushPanel((p) => p ? null : { tab: 'copy' }), disabled: !manifest || !rows.length },
              { separator: true },
              { label: 'Reset column widths', onClick: () => { setColWidths({}); try { localStorage.removeItem('ff-col-widths') } catch {} }, disabled: !Object.keys(colWidths).length },
            ]} />
            <MenuDropdown label="View" items={[
              { label: 'Market coverage…', icon: <Globe className="w-3.5 h-3.5" />, onClick: () => setCoverageModalOpen(true), disabled: !manifest || !rows.length },
              { label: 'Listing health…', icon: <Activity className="w-3.5 h-3.5" />, onClick: () => setHealthModalOpen(true), disabled: !manifest || !rows.length },
              { separator: true },
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

          {/* PD.1 — publish-mode truth, right where you publish. A non-LIVE
              badge means a submit is validated but NOT sent to Amazon. */}
          <PublishModeBadge channel="amazon" />

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
                    <div className="text-[11.5px] text-rose-700 dark:text-rose-400 inline-flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5" />Fix {reviewModal.data.errors.length} error{reviewModal.data.errors.length === 1 ? '' : 's'} before publishing.
                    </div>
                  )}
                  {reviewModal.data.errors.length === 0 && reviewModal.data.warnings.length > 0 && (
                    <label className="flex items-center gap-2 text-[11.5px] text-slate-700 dark:text-slate-300 cursor-pointer">
                      <input type="checkbox" checked={reviewAck} onChange={(e) => setReviewAck(e.target.checked)} className="w-3.5 h-3.5" />
                      I&apos;ve reviewed the {reviewModal.data.warnings.length} warning{reviewModal.data.warnings.length === 1 ? '' : 's'} and want to publish.
                    </label>
                  )}
                </div>
                <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-subtle dark:border-slate-800">
                  <button type="button" onClick={() => reviewModal.resolve(false)} className="inline-flex items-center h-7 px-3 rounded text-[12px] border border-default dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">Cancel</button>
                  <button type="button" onClick={() => reviewModal.resolve(true)}
                    disabled={reviewModal.data.errors.length > 0 || (reviewModal.data.warnings.length > 0 && !reviewAck)}
                    className="inline-flex items-center gap-1.5 h-7 px-3 rounded text-[12px] font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed">
                    <Send className="w-3.5 h-3.5" />Publish to {reviewModal.data.markets.join(', ')}
                  </button>
                </div>
              </div>
            </div>
          )}
          {/* History button moved to FlatFileIconToolbar via onHistoryClick */}
          {/* P1.2 — Draft saved indicator */}
          {lastSaveLabel && (
            <span className="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap select-none" aria-live="polite">
              {lastSaveLabel}
            </span>
          )}
          {/* P1.3 — Column search / quick-jump (⌘⇧G) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setColSearchOpen((o) => !o)}
              className={cn('h-6 w-6 inline-flex items-center justify-center rounded flex-shrink-0 transition-colors',
                colSearchOpen
                  ? 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-400'
                  : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 dark:hover:text-slate-200')}
              title="Jump to column (⌘⇧G)"
              aria-label="Jump to column"
            >
              <Search className="w-3 h-3" />
            </button>
            {colSearchOpen && (
              <div data-col-search className="absolute right-0 top-7 z-50 w-64 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl"
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
                    const hits = allColumns
                      .map((c, ci) => ({ c, ci }))
                      .filter(({ c }) => !q ||
                        c.labelEn.toLowerCase().includes(q) ||
                        c.labelLocal.toLowerCase().includes(q) ||
                        c.id.toLowerCase().includes(q),
                      )
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
                        <span className="truncate flex-1">{c.labelEn}</span>
                        {c.required && <span className="text-[9px] text-amber-500 flex-shrink-0">req</span>}
                      </button>
                    ))
                  })()}
                </div>
              </div>
            )}
          </div>
          {/* PE: keyboard shortcuts modal trigger */}
          <button
            type="button"
            onClick={() => setShortcutsOpen(true)}
            className="h-6 w-6 inline-flex items-center justify-center rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 dark:hover:text-slate-200 flex-shrink-0"
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard className="w-3 h-3" />
          </button>
        </div>

        {/* ── Icon toolbar — shared with eBay via FlatFileIconToolbar ─ */}
        <FlatFileIconToolbar
          canUndo={history.length > 0}
          canRedo={future.length > 0}
          onUndo={undo}
          onRedo={redo}

          onCopy={() => setPushPanel((p) => p?.tab === 'copy' ? null : { tab: 'copy' })}
          copyActive={pushPanel?.tab === 'copy'}
          copyDisabled={!manifest || !rows.length}

          onReplicate={() => setReplicateOpen(true)}
          replicateDisabled={!manifest || !rows.length}
          replicateActive={replicateOpen}

          validationErrorCount={validErrorCount}
          validationWarnCount={validWarnCount}
          validationActive={showValidPanel}
          onValidationClick={() => setShowValidPanel((o) => !o)}
          validationDisabled={!manifest}

          smartPasteEnabled={smartPasteEnabled}
          onSmartPasteToggle={toggleSmartPaste}

          showRowImages={showRowImages}
          rowImageSize={imageSize as 24 | 32 | 48 | 64 | 96}
          rowImagesDisabled={!manifest}
          onRowImagesToggle={toggleRowImages}
          onRowImageSizeChange={(s) => setImageSizeCore(s as 24 | 32 | 48 | 64 | 96)}

          sortLevelCount={sortConfig.length}
          sortPanelOpen={sortPanelOpen}
          sortDisabled={!manifest || !rows.length}
          onSortClick={() => setSortPanelOpen((o) => !o)}
          sortPanel={
            <>
              {sortPanelOpen && (
                <SortPanel
                  rows={rows} groups={orderedGroups} initial={sortConfig}
                  onApply={(levels) => { setSortConfig(levels); setSortPanelOpen(false) }}
                  onClose={() => setSortPanelOpen(false)}
                  footerExtra={
                    <div className="px-4 py-3 space-y-2">
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
              {applyPanelOpen && (
                <ApplyToPanel
                  currentMarket={mp}
                  allMarkets={ALL_MARKETS}
                  marketSync={marketSync}
                  onToggleSync={toggleMarketSync}
                  onApplyNow={applyOrderToMarkets}
                  onClose={() => setApplyPanelOpen(false)}
                />
              )}
            </>
          }

          findReplaceOpen={findReplaceOpen}
          onFindReplaceClick={() => setFindReplaceOpen((o) => !o)}
          findReplaceDisabled={!manifest}

          conditionalEnabledCount={cfRules.filter((r) => r.enabled).length}
          conditionalOpen={cfOpen}
          onConditionalClick={() => setCfOpen((o: boolean) => !o)}
          conditionalDisabled={!manifest}

          onColumnsClick={() => setColumnsOpen(true)}
          columnsActive={columnsOpen}

          aiBulkSelectedCount={selectedRows.size}
          aiBulkDisabled={!manifest}
          onAiBulkClick={() => setAiModalOpen(true)}

          aiAssistantOpen={aiPanelOpen}
          onAiAssistantClick={manifest ? () => setAiPanelOpen((o) => !o) : undefined}

          slotAfterReplicate={
            <>
              {/* Pull from Amazon — full attribute pull (in-memory, undoable via ⌘Z) */}
              <div className="relative">
                <SharedTbBtn
                  icon={<Download className="w-3.5 h-3.5" />}
                  title={`Pull from Amazon ${marketplace} — full attribute pull, undoable with ⌘Z. Does not touch the database until you click Save.`}
                  onClick={() => setPullPanelOpen((o) => !o)}
                  disabled={!manifest || pulling || !rows.length}
                  active={pullPanelOpen}
                />
                {pullPanelOpen && (
                  <PullFromAmazonPanel
                    selectedCount={selectedRows.size}
                    visibleCount={realDisplayRows.length}
                    totalCount={rows.length}
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
                    {dots.map((s, i) => {
                      const isTerminalOk = s.status === 'DONE' && (s.errorCount ?? 0) === 0
                      const isTerminalWarn = s.status === 'DONE' && (s.errorCount ?? 0) > 0
                      const isFatal = s.status === 'FATAL' || s.status === 'CANCELLED'
                      const cls = isFatal ? 'bg-red-500 dark:bg-red-400'
                        : isTerminalWarn ? 'bg-amber-400 dark:bg-amber-300'
                        : isTerminalOk ? 'bg-emerald-500 dark:bg-emerald-400'
                        : 'bg-slate-300 dark:bg-slate-600 animate-pulse'
                      return (
                        <span
                          key={`${s.id}-${i}`}
                          className={`inline-block w-1.5 h-4 rounded-sm ${cls}`}
                          title={`${s.market} · ${s.status}${s.errorCount ? ` · ${s.errorCount} errors` : ''}`}
                        />
                      )
                    })}
                  </button>
                )
              })()}
              {/* History — same slot/position as eBay */}
              <SharedTbBtn
                icon={<History className="w-3.5 h-3.5" />}
                title="History — push submissions, pull log and version history (⌘H)"
                onClick={() => setHistoryOpen(true)}
                active={historyOpen}
              />
            </>
          }

          slotAfterSmartPaste={
            <>
              {/* IN.1 — Override badges toggle */}
              <SharedTbBtn
                icon={<GitBranch className="w-3.5 h-3.5" />}
                title={showOverrideBadges ? 'Hide field-override indicators' : 'Show field-override indicators (amber ⎇ badge on rows with channel overrides)'}
                onClick={() => setShowOverrideBadges((o) => !o)}
                active={showOverrideBadges}
              />
              {/* CG — Group by mode (view-only grouping) */}
              <div
                className="flex items-center gap-0.5 ml-1 pl-1.5 border-l border-slate-200 dark:border-slate-700"
                title="Group rows by variation family (default), fulfillment (FBA/FBM), or your custom groups. View-only — never affects the feed."
              >
                <span className="text-[10px] uppercase tracking-wide text-slate-400 mr-0.5 select-none">Group</span>
                {([['family', 'Family'], ['fulfillment', 'FBA/FBM'], ['custom', 'Custom']] as const).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setGroupMode(val)}
                    aria-pressed={groupMode === val}
                    className={`px-1.5 py-0.5 text-[11px] rounded transition-colors ${
                      groupMode === val
                        ? 'bg-blue-600 text-white'
                        : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {/* IN.2 — Cascade buttons toggle */}
              <SharedTbBtn
                icon={<GitFork className="w-3.5 h-3.5" />}
                title={showCascadeButtons ? 'Hide cascade-to-siblings buttons' : 'Show cascade-to-siblings buttons (⎇↓ on each row)'}
                onClick={() => setShowCascadeButtons((o) => !o)}
                active={showCascadeButtons}
              />
              {/* IN.2 — Cascade: reset all visible rows back to master */}
              <SharedTbBtn
                icon={<RotateCcw className="w-3.5 h-3.5" />}
                title="Reset all channel overrides to master values (sets followMaster=true on all visible rows)"
                onClick={async () => {
                  const overrideRows = rows.filter((r) => {
                    const fs = r._fieldStates as any
                    return fs && Object.values(fs).some((v) => v === 'OVERRIDE')
                  })
                  if (!overrideRows.length) return
                  const ids = overrideRows.map((r) => r._listingId as string).filter(Boolean)
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
                  void loadData(marketplace, productType, false, true)
                }}
                disabled={!rows.length}
              />
            </>
          }
        />

        {/* ── Bar 3: Marketplace · Product type · Search ────── */}
        <div className="px-3 py-1.5 border-t border-slate-100 dark:border-slate-800 flex items-center gap-3 flex-wrap">
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
                      const count = isActive ? dirtyRows.length : dirtyCount
                      if (!count) return null
                      return (
                        <span
                          className={cn(
                            'ml-1 inline-flex items-center justify-center min-w-[14px] h-3.5 px-1 rounded-sm text-[9px] font-semibold leading-none',
                            isActive
                              ? 'bg-amber-500 text-white'
                              : 'bg-amber-500 text-white',
                          )}
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
          <div className="flex items-center gap-2">
            {/* BN.3.1 — Categories in this sheet: replaces Product Type dropdown + "+ Add category".
                Chips derived from productTypesInUse(rows); clicking a chip filters columns to that type. */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400 font-medium">Categories in this sheet</span>
              <div className="flex items-center gap-1 flex-wrap">
                {productTypesInUse(rows).length === 0 ? (
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
                    {productTypesInUse(rows).map((t) => (
                      <button key={t} type="button" onClick={() => setFilterType((f) => (f === t ? null : t))}
                        className={cn('px-1.5 py-0.5 rounded text-[11px] font-semibold border transition-colors',
                          filterType === t ? 'bg-indigo-100 text-indigo-700 border-indigo-300 dark:bg-indigo-900/40 dark:text-indigo-300' : 'border-slate-200 text-slate-500 hover:border-indigo-400')}>
                        {t}
                      </button>
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
            {/* P-1: gate + label on selectedRealCount (non-ghost) so they match the modal's apply count */}
            {selectedRealCount > 0 && (
              <Button size="sm" variant="secondary"
                onMouseEnter={warmSetCategoryModal}
                onFocus={warmSetCategoryModal}
                onClick={() => setShowSetCategory(true)}>
                Set category ({selectedRealCount})
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
                  {searchMode === 'rows' ? `${realDisplayRows.length}/${realRowCount}` : `${allColumns.length} col${allColumns.length !== 1 ? 's' : ''}`}
                </span>
              )}
              {/* BF.3 — extended row filter */}
              {filterPanelMounted && (
                <AmazonFFFilterPanelLazy
                  open={filterPanelOpen}
                  onOpenChange={setFilterPanelOpen}
                  value={ffFilter as AmazonFFFilterState}
                  onChange={setFFFilter}
                />
              )}
              {/* BM.1 — saved views */}
              <FFSavedViews
                currentState={{
                  closedGroups: [...closedGroups],
                  groupOrder: [...groupOrder],
                  ffFilter,
                  sortConfig,
                  cfRules,
                  frozenColCount,
                }}
                onApply={(state: FFViewState) => {
                  applyGroupSettings(new Set(state.closedGroups), state.groupOrder ?? [])
                  setFFFilter(state.ffFilter)
                  setSortConfig(state.sortConfig)
                  setCfRules(state.cfRules)
                  setFrozenColCount(state.frozenColCount)
                }}
                groups={orderedGroups.map((g) => ({
                  id: g.id,
                  label: (g as any).labelEn ?? (g as any).label ?? g.id,
                }))}
              />
            </div>
          )}

          {/* ColumnGroupModal — replaces the old draggable badge bar */}
          <ColumnGroupModal
            open={columnsOpen}
            onClose={() => setColumnsOpen(false)}
            groups={orderedGroups.map((g) => ({
              id: g.id,
              label: (g as any).labelEn ?? (g as any).label ?? g.id,
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

        {/* ── Badge bar: column group chips (drag-to-reorder, click-to-toggle) ── */}
        {orderedGroups.length > 0 && (
          <div className="px-3 py-1 border-t border-slate-100 dark:border-slate-800 flex items-center gap-1 flex-wrap">
            <span className="text-xs text-slate-400 mr-1">Columns:</span>
            {orderedGroups.map((g) => {
              const open = !closedGroups.has(g.id)
              const isDragging = draggingGroupId === g.id
              const c = gColor(g.color)
              return (
                <button key={g.id} type="button" draggable
                  onDragStart={(e) => { setDraggingGroupId(g.id); e.dataTransfer.effectAllowed = 'move' }}
                  onDragEnd={() => setDraggingGroupId(null)}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move' }}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (!draggingGroupId || draggingGroupId === g.id) return
                    const ids = orderedGroups.map((x) => x.id)
                    const from = ids.indexOf(draggingGroupId); const to = ids.indexOf(g.id)
                    const next = [...ids]; next.splice(from, 1); next.splice(to, 0, draggingGroupId)
                    applyGroupSettings(closedGroups, next)
                    setDraggingGroupId(null)
                  }}
                  onClick={() => {
                    if (open && orderedGroups.filter((x) => !closedGroups.has(x.id)).length <= 1) return
                    const n = new Set(closedGroups); open ? n.add(g.id) : n.delete(g.id)
                    applyGroupSettings(n, groupOrder)
                  }}
                  title={g.labelEn}
                  className={cn('inline-flex items-center gap-1 h-5 px-1.5 text-xs rounded border transition-all cursor-grab active:cursor-grabbing select-none',
                    c.badge, open ? 'opacity-100' : 'opacity-40 hover:opacity-65',
                    isDragging && 'opacity-30 scale-95')}>
                  <ChevronRight className={cn('w-2.5 h-2.5 transition-transform', open && 'rotate-90')} />
                  <span className="font-medium">{g.labelEn}</span>
                  <span className="opacity-60 tabular-nums">{g.columns.length}</span>
                </button>
              )
            })}
            {(groupOrder.length > 0 || closedGroups.size > 0) && (
              <button type="button"
                onClick={() => applyGroupSettings(new Set(), [])}
                className="text-xs text-slate-400 hover:text-slate-600 px-1" title="Reset group order and visibility">↺</button>
            )}
          </div>
        )}

        {/* Error — FF-MS.6: when a load failed, identifies the failed market,
            tailors copy per status code, and offers an inline Retry. For
            operation errors (import/submit/pull) it falls back to a plain
            message + dismiss. */}
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
                  saveRows(marketplace, storageTypeRef.current, rows)
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
        <div
          className="flex-1 flex items-center justify-center gap-2 text-slate-500 text-sm"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
          Loading {marketplace}{productType ? ` · ${productType}` : ''} schema…
        </div>
      )}

      {/* ── Spreadsheet + AI panel ────────────────────────────── */}
      {manifest && !loading && (
        <div className="flex-1 flex overflow-hidden min-h-0">
        <div
          ref={gridScrollRef}
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
            // GX.9 — edge autoscroll while drag-selecting cells
            const sc = gridScrollRef.current
            if (sc && selAnchor && !isFillDragging && rowDragRef.current === null) {
              const r = sc.getBoundingClientRect()
              const EDGE = 48
              const vy = e.clientY < r.top + EDGE ? -Math.max(2, Math.ceil((r.top + EDGE - e.clientY) / 3))
                : e.clientY > r.bottom - EDGE ? Math.max(2, Math.ceil((e.clientY - (r.bottom - EDGE)) / 3)) : 0
              updateAutoScroll(vy, e.clientX, e.clientY)
            } else stopAutoScroll()
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
          onPointerUp={() => { rowDragRef.current = null; stopAutoScroll(); if (isFillDragging) executeFill() }}
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
                    checked={realDisplayRows.length > 0 && selectedRows.size === realDisplayRows.length}
                    ref={(el) => {
                      if (el) el.indeterminate = selectedRows.size > 0 && selectedRows.size < realDisplayRows.length
                    }}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedRows(new Set(realDisplayRows.map((r) => r._rowId as string)))
                      } else {
                        setSelectedRows(new Set())
                      }
                    }}
                    title={selectedRows.size === realDisplayRows.length ? 'Deselect all' : 'Select all'}
                  />
                </th>
                <th
                  className="sticky left-9 z-30 bg-white dark:bg-slate-900 border-b border-r border-slate-200 dark:border-slate-700 text-xs text-slate-400 text-center font-normal"
                  style={{ width: rowHeaderWidth, minWidth: rowHeaderWidth }}
                  rowSpan={3}>#</th>

                {/* BN.2.1 — inject Category band after the group containing record_action */}
                {displayGroups.flatMap((g, gi) => {
                  const c = gColor(g.color)
                  const groupTh = (
                    <th key={g.id} colSpan={g.columns.length}
                      className={cn('px-2 py-1 text-xs font-bold border-b border-r border-slate-200 dark:border-slate-700 text-left whitespace-nowrap', c.header)}>
                      {g.labelLocal}
                      {g.labelEn && g.labelEn !== g.labelLocal && (
                        <span className="ml-1.5 font-normal opacity-55 text-[11px]">({g.labelEn})</span>
                      )}
                    </th>
                  )
                  if (gi === categoryGroupInsertAfterIdx) {
                    return [groupTh, <th key="__category-band"
                      style={{ minWidth: CATEGORY_COL.width, width: CATEGORY_COL.width, ...(categoryStickyLeft !== undefined ? { position: 'sticky' as const, left: categoryStickyLeft, zIndex: 30 } : {}) }}
                      className={cn('px-2 py-1 text-xs font-bold border-b border-r border-slate-200 dark:border-slate-700 text-left whitespace-nowrap text-slate-500 dark:text-slate-400', categoryStickyLeft !== undefined && 'bg-white dark:bg-slate-900')}>
                      {/* P-3: band label intentionally blank — column header row already says "Category" */}
                    </th>]
                  }
                  return [groupTh]
                })}
              </tr>

              {/* Row 2: English column labels + column resize handles */}
              <tr>
                {/* BN.2.1 — flatMap injects Category th after record_action; ci/colIdx stay allColumns-based */}
                {allColumns.flatMap((col, colIdx) => {
                  const c = gColor(colToGroup.get(col.id)?.color ?? 'slate')
                  const w = colWidths[col.id] ?? col.width
                  const _th = (
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
                  if (col.id === 'record_action') {
                    return [_th, <th key="en-__category"
                      style={{ minWidth: CATEGORY_COL.width, width: CATEGORY_COL.width, ...(categoryStickyLeft !== undefined ? { position: 'sticky' as const, left: categoryStickyLeft, zIndex: 25 } : {}) }}
                      className={cn('px-2 py-0.5 text-left text-xs font-semibold border-b border-r border-slate-200 dark:border-slate-700 whitespace-nowrap select-none text-indigo-600 dark:text-indigo-400', categoryStickyLeft !== undefined && 'bg-white dark:bg-slate-900')}>
                      {CATEGORY_COL.labelEn}
                    </th>]
                  }
                  return [_th]
                })}
              </tr>

              {/* Row 3: Italian column labels + max-length hint */}
              <tr>
                {/* BN.2.1 — flatMap injects Category th after record_action; ci/colIdx stay allColumns-based */}
                {allColumns.flatMap((col, colIdx) => {
                  const w = colWidths[col.id] ?? col.width
                  const _th = (
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
                  if (col.id === 'record_action') {
                    return [_th, <th key="it-__category"
                      style={{ minWidth: CATEGORY_COL.width, width: CATEGORY_COL.width, ...(categoryStickyLeft !== undefined ? { position: 'sticky' as const, left: categoryStickyLeft, zIndex: 25 } : {}) }}
                      className={cn('px-2 py-0.5 text-left text-xs font-normal border-b border-r border-slate-200 dark:border-slate-700 whitespace-nowrap text-slate-400 dark:text-slate-500 italic', categoryStickyLeft !== undefined && 'bg-white dark:bg-slate-900')}>
                      {CATEGORY_COL.labelLocal}
                    </th>]
                  }
                  return [_th]
                })}
              </tr>
            </thead>

            <tbody>
              {renderRows.map((item) => {
                if (item.kind === 'header') {
                  return (
                    <GroupHeaderRow
                      key={`gh-${item.groupId}`}
                      name={item.name}
                      color={item.color}
                      count={item.count}
                      collapsed={item.collapsed}
                      colSpan={groupHeaderColSpan}
                      onToggle={() => setCollapsedGroups((prev) => {
                        const n = new Set(prev)
                        if (n.has(item.groupId)) n.delete(item.groupId)
                        else n.add(item.groupId)
                        return n
                      })}
                    />
                  )
                }
                const row = item.row
                const rowIdx = item.dataIdx
                return (
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
                  onFillToBottom={fillToBottom}
                  onFillDrop={handleFillDrop}
                  stickyLeftByColIdx={stickyLeftByColIdx}
                  categoryStickyLeft={categoryStickyLeft}
                  cellErrors={cellErrors}
                  collapsedParents={collapsedParents}
                  familyColor={familyColorByRowId.get(row._rowId as string)}
                  matchKeys={matchKeys}
                  toneMap={toneMap}
                  onToggleCollapse={(rowId) => setCollapsedParents((prev) => {
                    const next = new Set(prev)
                    if (next.has(rowId)) next.delete(rowId)
                    else next.add(rowId)
                    return next
                  })}
                  showOverrideBadges={showOverrideBadges}
                  showCascadeButtons={showCascadeButtons}
                  onCascadeRow={(r) => setCascadeRow(r)}
                  parentVariationTheme={parentThemeByChildId.get(row._rowId as string)}
                  onCloneVariant={handleCloneVariant}
                  onSwitchMarket={(m) => navigateTo(m, productType)}
                  browseNodeLabels={browseNodeLabels}
                />
                )
              })}

              {/* Empty search result */}
              {searchQuery && searchMode === 'rows' && displayRows.length === 0 && (
                <tr>
                  <td colSpan={allColumns.length + 3} className="px-6 py-6 text-center text-sm text-slate-400 italic">
                    No rows match &ldquo;{searchQuery}&rdquo;
                  </td>
                </tr>
              )}

              {/* G.2 — genuinely empty: beginner CTA distinguishing parent (variations) vs single item */}
              {!searchQuery && displayRows.length === 0 && (
                <tr>
                  <td colSpan={allColumns.length + 3} className="px-6 py-10 text-center">
                    <div className="flex flex-col items-center gap-1.5">
                      <p className="text-sm font-medium text-slate-600 dark:text-slate-300">No products yet</p>
                      <p className="text-xs text-slate-400 max-w-md">Add your first product to get started — &ldquo;Add a parent&rdquo; for a listing with variations (sizes, colours), or &ldquo;Add a single item&rdquo; if it has none.</p>
                      <div className="mt-1 flex items-center gap-2">
                        <Button size="sm" onClick={() => setAddRowsPanel({ type: 'parent', position: 'end' })}>
                          <Plus className="w-3.5 h-3.5 mr-1.5" />Add a parent (variations)
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => setAddRowsPanel({ type: 'row', position: 'end' })}>
                          <Plus className="w-3.5 h-3.5 mr-1.5" />Add a single item
                        </Button>
                      </div>
                    </div>
                  </td>
                </tr>
              )}

              {/* Add-row bar */}
              <tr>
                <td colSpan={allColumns.length + 3} className="px-4 py-2 border-t border-dashed border-slate-200 dark:border-slate-700">
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
                    {selectedRows.size > 0 && isUnionMode && (
                      <select
                        value=""
                        onChange={(e) => { if (e.target.value) { bulkSetProductType(e.target.value); e.currentTarget.value = '' } }}
                        className="ml-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs text-slate-700 dark:text-slate-200"
                        title={`Set the category for the ${selectedRows.size} selected row(s)`}
                      >
                        <option value="">Set type…</option>
                        {sheetTypes.map((t) => t.toUpperCase()).map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    )}
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

        {/* A4.1 — AI assistant panel */}
        {aiPanelOpen && (
          <div className="w-[40%] min-w-[360px] max-w-[560px] border-l border-slate-200 dark:border-slate-700 flex-shrink-0 overflow-y-auto bg-white dark:bg-slate-900">
            <FlatFileAiPanel
              rows={rows as any}
              columns={manifestColumns as any}
              marketplace={marketplace}
              onApplyChanges={applyAiChanges}
              channel="amazon"
            />
          </div>
        )}
        </div>
      )}

      {/* ── Status bar ─────────────────────────────────────── */}
      {manifest && (
        <div className="border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-1 flex items-center gap-4 text-xs text-slate-400 select-none flex-shrink-0">
          <span>{realDisplayRows.length} row{realDisplayRows.length !== 1 ? 's' : ''}</span>
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
          {selectionStats && selectionStats.nonEmpty >= 2 && (() => {
            const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toLocaleString(undefined, { maximumFractionDigits: 2 }))
            return (
              <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                Count {selectionStats.nonEmpty}
                {selectionStats.numCount >= 1 && <> · Sum {fmt(selectionStats.sum)} · Avg {fmt(selectionStats.avg)} · Min {fmt(selectionStats.min)} · Max {fmt(selectionStats.max)}</>}
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
          {(validErrorCount > 0 || validWarnCount > 0 || advisoryCount > 0) && (
            <button
              type="button"
              onClick={() => setShowValidPanel((o) => !o)}
              className={cn(
                'flex items-center gap-1 ml-auto',
                validErrorCount > 0 ? 'text-red-500' : validWarnCount > 0 ? 'text-amber-500' : 'text-indigo-500',
              )}
            >
              <AlertTriangle className="w-3 h-3" />
              {validErrorCount > 0 && <span>{validErrorCount} error{validErrorCount !== 1 ? 's' : ''}</span>}
              {validWarnCount > 0 && <span>{validWarnCount} warning{validWarnCount !== 1 ? 's' : ''}</span>}
              {advisoryCount > 0 && validErrorCount === 0 && validWarnCount === 0 && (
                <span className="bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 px-1.5 rounded-full text-[10px]">{advisoryCount} advisory</span>
              )}
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
              {advisoryCount > 0 && <span className="bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300 px-1.5 rounded-full text-[10px]">{advisoryCount} advisory</span>}
            </span>
            <button type="button" onClick={() => setShowValidPanel(false)} className="text-slate-400 hover:text-slate-600"><X className="w-3.5 h-3.5" /></button>
          </div>
          {cellErrors.size === 0 && mixedFamilies.length === 0 && missingNodeRowIds.length === 0 ? (
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
              {/* BN.4.3 — Advisory-only warnings (display only; do NOT block submit) */}
              {mixedFamilies.length > 0 && (
                <div className="px-3 py-1.5 flex items-start gap-2">
                  <span className="mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 bg-amber-300" />
                  <div className="min-w-0">
                    <span className="text-[10px] text-slate-400">Advisory</span>
                    <p className="text-xs text-slate-700 dark:text-slate-300">
                      {mixedFamilies.length} mixed-type famil{mixedFamilies.length === 1 ? 'y' : 'ies'} ({mixedFamilies.join(', ')}) — Amazon may reject mixed product types in one variation family.
                    </p>
                  </div>
                </div>
              )}
              {missingNodeRowIds.length > 0 && (
                <div className="px-3 py-1.5 flex items-start gap-2">
                  <span className="mt-0.5 w-1.5 h-1.5 rounded-full flex-shrink-0 bg-amber-300" />
                  <div className="min-w-0">
                    <span className="text-[10px] text-slate-400">Advisory</span>
                    <p className="text-xs text-slate-700 dark:text-slate-300">
                      {missingNodeRowIds.length} row{missingNodeRowIds.length === 1 ? '' : 's'} have no browse node — Amazon will use the category root (lower discoverability). Set a category to add one.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* BF.1 — Find & Replace */}
      {manifest && findReplaceMounted && (
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
      {manifest && cfMounted && (
        <div className="fixed top-16 right-4 z-50">
          <ConditionalFormatBar
            open={cfOpen}
            onClose={() => setCfOpen(false)}
            rules={cfRules}
            onChange={persistCfRules}
            visibleColumns={allColumnsRef.current.map((c) => ({ id: c.id, label: c.labelEn }))}
          />
        </div>
      )}

      {/* PE: keyboard shortcuts modal — extended with Amazon-only entries (FF-MS.7). */}
      {shortcutsOpen && (
        <KeyboardShortcutsModal
          groups={[
            ...FLAT_FILE_SHORTCUTS,
            {
              title: 'Marketplace',
              rows: [
                { keys: ['⌥', '1'], label: 'Switch to IT' },
                { keys: ['⌥', '2'], label: 'Switch to DE' },
                { keys: ['⌥', '3'], label: 'Switch to FR' },
                { keys: ['⌥', '4'], label: 'Switch to ES' },
                { keys: ['⌥', '5'], label: 'Switch to UK' },
              ],
            },
          ]}
          onClose={() => setShortcutsOpen(false)}
        />
      )}

      {/* View → Market coverage modal */}
      {coverageModalOpen && (
        <CoverageModal
          rows={displayRows.filter((r) => !r._ghost)}
          marketplace={marketplace}
          onSwitchMarket={(m) => { setCoverageModalOpen(false); navigateTo(m, productType) }}
          onClose={() => setCoverageModalOpen(false)}
        />
      )}

      {/* View → Listing health modal */}
      {healthModalOpen && (
        <HealthModal
          rows={displayRows.filter((r) => !r._ghost)}
          columns={allColumns}
          onClose={() => setHealthModalOpen(false)}
        />
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

      {/* Unified history modal — H.1–H.4 */}
      <HistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        channel="amazon"
        marketplace={marketplace}
        productType={productType}
        onResubmitErroredSkus={(skus) => {
          setSelectedRows(new Set(
            rows.filter(r => skus.includes(String(r.item_sku ?? ''))).map(r => r._rowId as string)
          ))
          setHistoryOpen(false)
        }}
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
          pushSnapshot()
          setRows(restoredRows as Row[])
          setHistoryOpen(false)
        }}
        currentRows={rows}
      />

      {/* Pull diff preview — Phase 2 of in-editor pull */}
      {pullDiffData && (
        <PullDiffModal
          open={pullDiffOpen}
          pulledRows={pullDiffData.pulledRows as Row[]}
          currentRows={rows}
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
          currentRows={rows}
          columnLabels={columnLabelMap}
          columnIds={manifestColumns.map((c) => c.id)}
          initialFile={importInitialFile}
          onApply={handleImportApply}
          onClose={() => { setImportOpen(false); setImportInitialFile(null) }}
        />
      )}

      {/* BM.2 — Replicate to multiple markets */}
      {replicateMounted && (
        <FFReplicateModal
          open={replicateOpen}
          onClose={() => setReplicateOpen(false)}
          sourceMarket={marketplace}
          groups={manifest?.groups ?? []}
          rowCount={rows.length}
          selectedRowCount={selectedRows.size}
          onReplicate={handleReplicate}
        />
      )}

      {/* BF.4 — AI bulk actions */}
      {aiModalMounted && (
        <AIBulkModal
          open={aiModalOpen}
          onClose={() => setAiModalOpen(false)}
          selectedProductIds={[...selectedRows].flatMap((rowId) => {
            const row = rows.find((r) => r._rowId === rowId)
            return row?._productId ? [row._productId as string] : []
          })}
          marketplace={marketplace}
        />
      )}

      {/* BN.2.2 — Set category modal */}
      {showSetCategory && (
        <SetCategoryModal open marketplace={marketplace}
          productTypeOptions={productTypes.map((p) => p.value)}
          selectedCount={selectedRealCount}
          onApply={applyCategory} onClose={() => setShowSetCategory(false)} />
      )}

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
          variationThemes={effectiveManifest?.variationThemes ?? []}
          manifestColumnIds={manifestColumns.map((c) => c.id)}
          onAdd={handleAddRows}
          onAddFamily={handleAddVariationFamily}
          onClose={() => setAddRowsPanel(null)}
        />
      )}

      {/* FeedSubmissionsPanel + VersionHistoryPanel replaced by HistoryModal above */}

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
          onGroupSelected={() => {
            setContextMenu(null)
            // collect the selected real rows' SKUs (checkbox Set ∪ range selection)
            const ids = new Set<string>(selectedRows)
            if (normSel) for (const r of displayRowsRef.current.slice(normSel.rMin, normSel.rMax + 1)) ids.add(r._rowId as string)
            const skus: string[] = []
            const seen = new Set<string>()
            for (const r of rows) {
              if (r._ghost || !ids.has(r._rowId as string)) continue
              const sku = String(r.item_sku ?? '')
              if (sku && !seen.has(sku)) { seen.add(sku); skus.push(sku) }
            }
            if (skus.length) setGroupCreate({ skus, name: '', color: GROUP_PALETTE[customGroups.length % GROUP_PALETTE.length] })
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
      {groupCreate && (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/20" onClick={() => setGroupCreate(null)}>
          <div
            className="w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-lg shadow-2xl p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1">New group</div>
            <div className="text-[11px] text-slate-400 mb-3">{groupCreate.skus.length} SKU{groupCreate.skus.length === 1 ? '' : 's'} selected</div>
            <input
              autoFocus
              value={groupCreate.name}
              onChange={(e) => setGroupCreate((g) => (g ? { ...g, name: e.target.value } : g))}
              onKeyDown={(e) => { if (e.key === 'Enter') (document.getElementById('cg-create-btn') as HTMLButtonElement | null)?.click() }}
              placeholder="Group name (e.g. FBM items)"
              className="w-full text-sm px-2 py-1.5 border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 mb-3"
            />
            <div className="flex items-center gap-1.5 mb-4">
              {GROUP_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  onClick={() => setGroupCreate((g) => (g ? { ...g, color: c } : g))}
                  className={cn(
                    'w-6 h-6 rounded-full border-2',
                    GROUP_SWATCH[c],
                    groupCreate.color === c ? 'ring-2 ring-offset-1 ring-slate-400' : 'border-transparent',
                  )}
                />
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setGroupCreate(null)} className="px-3 py-1.5 text-xs text-slate-500 hover:text-slate-700">Cancel</button>
              <button
                id="cg-create-btn"
                type="button"
                onClick={() => {
                  const id = makeGroupId(customGroups)
                  const order = customGroups.reduce((m, g) => Math.max(m, g.order), -1) + 1
                  const name = groupCreate.name.trim() || `Group ${customGroups.length + 1}`
                  const withNew = [...customGroups, { id, name, color: groupCreate.color, order, memberSkus: [] as string[] }]
                  setCustomGroups(assignSkusToGroup(withNew, id, groupCreate.skus))
                  setGroupMode('custom')
                  setGroupCreate(null)
                }}
                className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                Create group
              </button>
            </div>
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
  /** P-2: sticky left offset for the synthetic Category column when frozen. undefined = not frozen. */
  categoryStickyLeft?: number
  cellErrors: Map<string, ValidationIssue>
  collapsedParents: Set<string>
  familyColor?: FamilyColor
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
  onFillToBottom: () => void
  onFillDrop: () => void
  showOverrideBadges: boolean
  showCascadeButtons: boolean
  onCascadeRow: (row: Row) => void
  /** P4 — variation_theme from this row's parent (child rows only). */
  parentVariationTheme?: string
  onCloneVariant: (row: Row) => void
  onSwitchMarket: (market: string) => void
  /** BN.2.1 — browse-node id→path labels for the derived Category chip. */
  browseNodeLabels: Record<string, string>
}

// Per-row required-fields completeness. Counts the SAME required cells the grid
// reddens — i.e. col.required AND applicable to this row — mirroring the cell's
// own applicability gates (applicableParentage greying L5012-5019,
// applicableProductTypes L5024-5025, FBA-qty greying L5030-5031) and emptiness
// (value != null ? String : '' → isEmpty, L5293/5345). Greyed/not-applicable
// required cells are excluded so the chip never over-counts.
function computeRowCompleteness(row: Row, columns: Column[]): { filled: number; total: number } {
  if (row._ghost) return { filled: 0, total: 0 }
  const parentage = String(row.parentage_level ?? '')
  const rowType = parentage.toLowerCase() === 'parent' ? 'VARIATION_PARENT'
    : parentage.toLowerCase() === 'child' ? 'VARIATION_CHILD'
    : 'STANDALONE'
  let total = 0, filled = 0
  for (const col of columns) {
    if (!col.required) continue
    // applicableParentage greying (mirrors guidanceLevel === 'not-applicable')
    if (col.applicableParentage?.length && !col.applicableParentage.includes(rowType)) continue
    // applicableProductTypes greying (mirrors !appliesToType)
    if (col.applicableProductTypes && !col.applicableProductTypes.includes(String(row.product_type ?? '').toUpperCase())) continue
    // FBA-managed quantity is greyed/not-applicable on FBA rows
    if (col.id === 'fulfillment_availability__quantity'
      && /^(AMAZON|AFN|FBA)/.test(String(row.fulfillment_availability__fulfillment_channel_code ?? '').toUpperCase())) continue
    total++
    if (row[col.id] != null && String(row[col.id]) !== '') filled++
  }
  return { filled, total }
}

// FF-2 (perf) — event-handler props. Their identity changes on every parent
// render (inline arrows closing over row._rowId), but their BEHAVIOR is stable,
// so they must not force a row re-render.
const SPREADSHEET_ROW_CALLBACK_PROPS = new Set<string>([
  'onToggleCollapse', 'onSelect', 'onDeactivate', 'onChange', 'onLiveChange', 'onPushSnapshot',
  'onNavigate', 'onRowResizeStart', 'onRowDragStart', 'onRowDragEnd', 'onRowDragOver', 'onRowDrop',
  'onCellPointerDown', 'onCellDoubleClick', 'onRowSelect', 'onFillHandlePointerDown', 'onFillToBottom',
  'onFillDrop', 'onCascadeRow', 'onCloneVariant', 'onSwitchMarket',
])

// FF-2 (perf) — memo comparator so a keystroke (liveUpdateCell → setRows →
// cellErrors recompute) no longer re-runs all ~500 row bodies. A row re-renders
// only when something it actually shows changes: any non-callback prop by
// identity (every one is a state/useMemo value or an inline primitive, so it's
// stable when unchanged), PLUS this row's own cell-error levels (the cellErrors
// Map gets a fresh identity on every edit, but a given row's errors usually
// don't). The on* callbacks are skipped — identity churns, behavior is stable.
function areRowPropsEqual(prev: RowProps, next: RowProps): boolean {
  const keys = Object.keys(next) as Array<keyof RowProps>
  if (keys.length !== Object.keys(prev).length) return false
  for (const k of keys) {
    if (k === 'cellErrors') continue
    if (SPREADSHEET_ROW_CALLBACK_PROPS.has(k as string)) continue
    if (!Object.is(prev[k], next[k])) return false
  }
  // Per-row cell-error levels (the row body renders its own error chip; cells
  // are separately memoized so their own error styling is handled there).
  const rowId = next.row._rowId as string
  const pe = prev.cellErrors as Map<string, { level: string; msg: string }>
  const ne = next.cellErrors as Map<string, { level: string; msg: string }>
  for (const col of next.columns) {
    const key = `${rowId}:${col.id}`
    const a = pe.get(key)
    const b = ne.get(key)
    if ((a?.level ?? null) !== (b?.level ?? null) || (a?.msg ?? null) !== (b?.msg ?? null)) {
      return false
    }
  }
  return true
}

const SpreadsheetRow = memo(SpreadsheetRowImpl, areRowPropsEqual)

function SpreadsheetRowImpl({ row, rowIdx, columns, colToGroup, selected, activeCell,
  marketplace, colWidths, rowHeight, rowHeaderWidth, showRowImages, imageSize, imagesByAsin,
  isDraggingRow, dropIndicator,
  normSel, fillTarget, isFillDragging, isEditing, editInitialChar, clipboardRange,
  stickyLeftByColIdx, categoryStickyLeft, cellErrors, collapsedParents, familyColor, onToggleCollapse,
  matchKeys, toneMap,
  onSelect, onDeactivate, onChange, onLiveChange, onPushSnapshot, onNavigate, onRowResizeStart,
  onRowDragStart, onRowDragEnd, onRowDragOver, onRowDrop,
  onCellPointerDown, onCellDoubleClick, onRowSelect, onFillHandlePointerDown, onFillToBottom, onFillDrop,
  showOverrideBadges, showCascadeButtons, onCascadeRow,
  onCloneVariant, browseNodeLabels }: RowProps) {
  const rowId = row._rowId as string
  const status = row._status
  const canDragRef = useRef(false)
  const isParent = row.parentage_level === 'parent'
  const isChild  = row.parentage_level === 'child'

  const rowBg = status === 'success' ? 'bg-emerald-50/70 dark:bg-emerald-950/20'
    : status === 'error' ? 'bg-red-50/70 dark:bg-red-950/20'
    : status === 'pending' ? 'bg-amber-50/70 dark:bg-amber-950/20'
    // P3.1 — suppressed rows get a faint pink tint (below push-status, above dirty)
    : row._suppressed ? 'bg-pink-50/60 dark:bg-pink-950/15'
    : row._isNew ? 'bg-sky-50/40 dark:bg-sky-950/10'
    : row._dirty ? 'bg-yellow-50/40 dark:bg-yellow-950/10'
    // Family colour banding — only when ≥2 families present (map is empty otherwise)
    : isParent && familyColor ? FC_PARENT_ROW[familyColor]
    : isChild && familyColor ? FC_CHILD_ROW[familyColor]
    : ''

  // Solid (opaque) equivalent for sticky cells — prevents content bleed-through on scroll
  const frozenBg = status === 'success' ? 'bg-emerald-50 dark:bg-emerald-950/60'
    : status === 'error' ? 'bg-red-50 dark:bg-red-950/60'
    : status === 'pending' ? 'bg-amber-50 dark:bg-amber-950/60'
    : row._suppressed ? 'bg-pink-50 dark:bg-pink-950/40'
    : row._isNew ? 'bg-sky-50 dark:bg-sky-950/40'
    : row._dirty ? 'bg-yellow-50 dark:bg-yellow-950/40'
    : isParent && familyColor ? FC_PARENT_FROZEN[familyColor]
    : isChild && familyColor ? FC_CHILD_FROZEN[familyColor]
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
        // FF-4 (perf) — let the browser skip layout/paint of off-screen rows.
        // Unlike windowing, every row stays in the DOM, so drag / fill /
        // selection / scroll-into-view all keep working unchanged. The
        // intrinsic height keeps the scrollbar accurate for skipped rows.
        contentVisibility: 'auto',
        containIntrinsicSize: `0 ${rowHeight}px`,
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
          : status === 'error' ? (() => {
            const errMsg = String(row._feedMessage ?? 'Push error')
            const errCode = row._feedCode ? String(row._feedCode) : ''
            const errFields = Array.isArray(row._errorFields) ? (row._errorFields as string[]) : []
            const lookup = errCode ? FEED_ERROR_CODES[errCode] : undefined
            return (
              <Tooltip label={
                <div className="text-xs space-y-1 max-w-[240px]">
                  {lookup && <div className="font-semibold text-red-300">{lookup.title}</div>}
                  <div>{errMsg}</div>
                  {lookup?.hint && <div className="text-slate-400 italic">{lookup.hint}</div>}
                  {errFields.length > 0 && (
                    <div className="text-slate-400">Fields: <span className="font-mono">{errFields.join(', ')}</span></div>
                  )}
                  {errCode && <div className="text-slate-500 font-mono text-[10px]">Code: {errCode}</div>}
                </div>
              } className="h10-ds-tooltip--light">
                <AlertCircle className="w-3 h-3 text-red-500 mx-auto" />
              </Tooltip>
            )
          })()
          : status === 'pending' ? <Loader2 className="w-3 h-3 text-amber-500 animate-spin mx-auto" />
          : <input type="checkbox" checked={selected} onChange={(e) => onSelect(e.target.checked)} className="w-3.5 h-3.5 accent-blue-600" />}
      </td>
      {/* Row # + ASIN badge + row-height resize handle */}
      <td
        data-row-ri={rowIdx}
        className={cn(
          'sticky left-9 z-10 border-b border-r border-slate-200 dark:border-slate-700 px-0.5 relative group/rowresize select-none',
          frozenBg,
          isParent && familyColor ? `border-l-2 ${FC_PARENT_BORDER[familyColor]}`
            : isChild && familyColor ? `border-l-2 ${FC_CHILD_BORDER[familyColor]}`
            : isChild ? 'border-l-2 border-l-blue-200 dark:border-l-blue-800'
            : undefined,
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

          {/* ASIN link — only when row images are ON and at view M/L/XL (size ≥ 48 = M) */}
          {showRowImages && imageSize >= 48 && row._asin ? (() => {
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

          {/* Listing status — same visibility rule as ASIN (images ON + view M/L/XL) */}
          {showRowImages && imageSize >= 48 && row._listingStatus != null && (() => {
            const s = String(row._listingStatus)
            const cls = (s === 'ACTIVE' || s === 'BUYABLE')
              ? 'text-emerald-600 dark:text-emerald-400'
              : s === 'INACTIVE' ? 'text-amber-500 dark:text-amber-400'
              : 'text-red-500 dark:text-red-400'
            return <span className={cn('text-[9px] font-semibold leading-none', cls)}>{s.slice(0, 4)}</span>
          })()}


          {/* IN.1 — Override badge: shows when toggle is on and any field has followMaster*=false */}
          {showOverrideBadges && (!showRowImages || imageSize >= 48) && (
            <OverrideBadge
              listingId={row._listingId as string | null | undefined}
              fieldStates={row._fieldStates as any}
              masterValues={row._masterValues as any}
            />
          )}

          {/* IN.2 — Cascade button */}
          {showCascadeButtons && (!showRowImages || imageSize >= 48) && row._productId && (
            <button
              onClick={(e) => { e.stopPropagation(); onCascadeRow(row) }}
              onPointerDown={(e) => e.stopPropagation()}
              title="Apply this row's values to all sibling variants"
              className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-semibold leading-none transition-colors bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/40 dark:text-blue-300 dark:hover:bg-blue-900/60"
            >
              <GitFork className="h-2.5 w-2.5" />↓
            </button>
          )}

          {/* P4.3 — Clone variant button (child rows only) */}
          {!row._ghost && isChild && (!showRowImages || imageSize >= 48) && (
            <button
              onClick={(e) => { e.stopPropagation(); onCloneVariant(row) }}
              onPointerDown={(e) => e.stopPropagation()}
              title="Clone this variant — copies all fields, clears axis values (SKU, Color, Size) for you to fill in"
              className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-semibold leading-none transition-colors bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700/50 dark:text-slate-300 dark:hover:bg-slate-700"
            >
              <Copy className="h-2.5 w-2.5" />
            </button>
          )}

          {/* P1.4 — Last-sync badge: shows when images panel is at M+ (≥48 px) */}
          {!row._ghost && (() => {
            if (!row._lastSyncedAt || !showRowImages || imageSize < 48) return null
            const syncStatus = String(row._lastSyncStatus ?? '')
            const syncAt = new Date(String(row._lastSyncedAt))
            const secAgo = Math.round((Date.now() - syncAt.getTime()) / 1000)
            const timeLabel = secAgo < 60 ? `${secAgo}s` : secAgo < 3600 ? `${Math.round(secAgo / 60)}m` : `${Math.round(secAgo / 3600)}h`
            const ok = /^success$/i.test(syncStatus)
            const err = /^error$/i.test(syncStatus)
            return (
              <span
                className={cn('shrink-0 text-[8px] font-mono leading-none px-0.5',
                  ok ? 'text-emerald-500 dark:text-emerald-400'
                  : err ? 'text-red-500 dark:text-red-400'
                  : 'text-slate-400 dark:text-slate-500')}
                title={`Last Amazon sync: ${syncAt.toLocaleString()} (${syncStatus || 'n/a'})`}
              >↑{timeLabel}</span>
            )
          })()}
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

      {/* Data cells — BN.2.1: flatMap injects __category td after record_action; ci stays allColumns-based */}
      {columns.flatMap((col, ci) => {
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

        // MT.3b — in a union (multi-category) sheet, grey a cell whose column
        // doesn't apply to THIS row's product_type. Single-type manifests have
        // no applicableProductTypes ⇒ always applicable (no greying).
        const appliesToType = !col.applicableProductTypes
          || col.applicableProductTypes.includes(String(row.product_type ?? '').toUpperCase())

        // FBA rows: quantity is Amazon-managed (a merchant qty flips FBA→FBM).
        // F.1 already blanks the value server-side; grey the cell so it reads as
        // not-applicable here (FBM rows still get an editable quantity cell).
        const isFbaQtyCell = col.id === 'fulfillment_availability__quantity'
          && /^(AMAZON|AFN|FBA)/.test(String(row.fulfillment_availability__fulfillment_channel_code ?? '').toUpperCase())

        const _cell = (
          <SpreadsheetCell
            key={col.id}
            col={col}
            value={row[col.id]}
            isActive={isActive}
            isEditing={isCellEditing}
            editInitialChar={isCellEditing ? editInitialChar : null}
            cellBg={stickyLeft !== undefined ? gColor(groupColor).band : gColor(groupColor).cell}
            grayed={!appliesToType || isFbaQtyCell}
            isGhost={!!row._ghost}
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
            onFillToBottom={onFillToBottom}
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
        // BN.2.1 — inject derived Category td immediately after record_action.
        // No event handlers → never enters selection/paste/nav paths.
        if (col.id === 'record_action') {
          const cat = categoryOf(row as Record<string, unknown>, browseNodeLabels)
          const crumb = formatNodeBreadcrumb(cat.nodePath)
          const show = !row._ghost && !!(cat.productType || cat.nodeId)
          return [
            _cell,
            <td key="__category"
              style={{ minWidth: CATEGORY_COL.width, width: CATEGORY_COL.width, ...(categoryStickyLeft !== undefined ? { position: 'sticky' as const, left: categoryStickyLeft, zIndex: 22 } : {}) }}
              className="border-b border-r border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
              <div className="px-1.5 flex items-center gap-1.5 min-w-0" style={{ height: rowHeight }} title={cat.nodePath ?? undefined}>
                {show ? (
                  <>
                    {cat.productType && <Badge variant="info" size="sm">{cat.productType}</Badge>}
                    {crumb && <span className="text-[11px] text-slate-600 dark:text-slate-300 truncate">{crumb}</span>}
                    {!cat.nodeId && cat.productType && <span className="text-[10px] text-amber-500 shrink-0">no node</span>}
                  </>
                ) : <span className="text-slate-300 dark:text-slate-600">—</span>}
              </div>
            </td>,
          ]
        }
        return [_cell]
      })}
    </tr>
  )
}

// ProductTypeDropdown removed — BN.3.1 replaced it with Categories-in-this-sheet chips.

// ── SpreadsheetCell + EnumDropdown ─────────────────────────────────────

interface CellProps {
  col: Column; value: unknown; isActive: boolean; cellBg: string
  grayed: boolean
  /** GX.5 — a trailing blank canvas row: suppress the "⚠ required" placeholder. */
  isGhost?: boolean
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
  onFillToBottom: () => void
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

function SpreadsheetCellImpl({ col, value, isActive, cellBg, width, cellHeight, ri, ci,
  isSelected, selEdges, isCorner, isFillTarget, fillTargetEdges,
  isEditing, editInitialChar, isClipboard, clipboardEdges,
  validIssue, stickyLeft, isMatch, toneCls,
  guidanceLevel, isGhost, grayed,
  onCellPointerDown, onCellDoubleClick, onFillHandlePointerDown, onFillToBottom, onFillDrop,
  onDeactivate, onChange, onLiveChange, onPushSnapshot, onNavigate }: CellProps) {
  const displayValue = value != null ? String(value) : ''
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [liveLen, setLiveLen] = useState(displayValue.length)
  const [liveBytes, setLiveBytes] = useState(() => new TextEncoder().encode(displayValue).length)
  const cancelledRef = useRef(false)
  // Grayed cells (e.g. FBA quantity) are read-only; deactivate immediately if the
  // grid somehow starts editing one (e.g. via keyboard shortcut).
  useEffect(() => { if (isEditing && grayed) onDeactivate() }, [isEditing, grayed, onDeactivate])
  const effectivelyEditing = isEditing && !grayed
  const pendingWordSelRef = useRef<{ start: number; end: number } | null | undefined>(undefined)
  // undefined = F2 entry (select all), null = dblclick but no word found (cursor end), {start,end} = word found
  const originalValueRef = useRef('')
  const snapshotPushedRef = useRef(false)

  useEffect(() => {
    if (!effectivelyEditing || col.kind === 'enum' || !inputRef.current) return
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
  }, [effectivelyEditing, col.kind, editInitialChar])

  useEffect(() => {
    if (effectivelyEditing) {
      snapshotPushedRef.current = false
    }
  }, [effectivelyEditing])

  // Reset counters to committed value length each time cell becomes editing
  useEffect(() => {
    if (effectivelyEditing) {
      setLiveLen(displayValue.length)
      setLiveBytes(new TextEncoder().encode(displayValue).length)
    }
  }, [effectivelyEditing])

  // GX.2b — typing on an active enum cell (or F2) opens its dropdown, pre-filled
  // with the typed character, so Color/Size/Brand support type-to-replace too.
  useEffect(() => {
    if (effectivelyEditing && col.kind === 'enum') setDropdownOpen(true)
  }, [isEditing, col.kind])

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
    ? grayed                             ? 'bg-slate-200 dark:bg-slate-700/70'
    : guidanceLevel === 'not-applicable' ? 'bg-slate-200 dark:bg-slate-700/70'
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
    isActive && !effectivelyEditing && 'outline outline-2 outline-blue-500 outline-offset-[-1px] z-[5]',
    effectivelyEditing && 'ring-2 ring-inset ring-blue-500 z-[5]',
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
    if (effectivelyEditing && (tag === 'INPUT' || tag === 'TEXTAREA')) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    onCellPointerDown(e.shiftKey)
  }

  // GX.2 — commit the input's CURRENT value before leaving the cell. A single
  // typed char arrives as the input's defaultValue and fires NO onInput, so
  // without this it was silently dropped on Tab/Enter/blur ("type 5, Enter → gone").
  const commitInput = () => {
    const inp = inputRef.current
    if (!inp) return
    const val = inp.value
    if (val === displayValue) return
    if (!snapshotPushedRef.current) {
      originalValueRef.current = displayValue
      onPushSnapshot()
      snapshotPushedRef.current = true
    }
    onLiveChange(val)
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Tab') { e.preventDefault(); commitInput(); onNavigate(e.shiftKey ? 'left' : 'right') }
    else if (e.key === 'Enter' && col.kind !== 'longtext') { e.preventDefault(); commitInput(); onNavigate(e.shiftKey ? 'up' : 'down') }
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
      onDoubleClick={(e) => { e.stopPropagation(); e.preventDefault(); onFillToBottom() }}
      title="Double-click to fill down to the bottom of the data"
    />
  ) : null

  // Shared td props — data-ri/ci let the container's pointermove identify which cell the pointer is over
  const tdShared = {
    'data-ri': ri, 'data-ci': ci,
    onPointerDown: tdPointerDown,
    onPointerUp: onFillDrop,
    onDoubleClick: (e: React.MouseEvent) => {
      if (grayed) return
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
    // Localized display label for the stored canonical value (e.g. 'parent' → 'Articolo padre')
    const displayLabel = (col.optionLabels?.[displayValue] ?? displayValue)
    // A selection-only cell holding a value Amazon doesn't list. Allowed (you
    // can type your own) but flagged, since Amazon may reject it at submit.
    const strictInvalid = !!col.selectionOnly && !!displayValue && !col.options.includes(displayValue)
    return (
      <td {...tdShared} className={baseCls} style={{ ...cellStyle, ...selStyle }}
        title={strictInvalid ? `"${displayLabel}" isn't in Amazon's valid values for this field — Amazon may reject it at submit` : undefined}
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
          <span className={cn('text-xs truncate flex-1 flex items-center gap-1',
            strictInvalid ? 'text-amber-600 dark:text-amber-400'
            : isEmpty ? 'text-slate-300 dark:text-slate-600 italic' : 'text-slate-800 dark:text-slate-200')}>
            {strictInvalid && <AlertCircle className="w-3 h-3 shrink-0" aria-hidden />}
            <span className="truncate">{displayLabel || ((col.required && !isGhost) ? '⚠ required' : col.options[0] ? `e.g. ${col.optionLabels?.[col.options[0]] ?? col.options[0]}` : '—')}</span>
          </span>
          <ChevronDown className="w-3 h-3 text-slate-400 flex-shrink-0 opacity-0 group-hover/cell:opacity-100 transition-opacity" />
        </div>
        {fillHandle}
        {isActive && dropdownOpen && (
          <EnumDropdown
            options={col.options}
            optionLabels={col.optionLabels}
            current={displayValue}
            selectionOnly={col.selectionOnly}
            initialQuery={editInitialChar ?? ''}
            onSelect={(v, dir) => { onChange(v); setDropdownOpen(false); if (dir) onNavigate(dir); else onDeactivate() }}
            onClose={() => { setDropdownOpen(false); onDeactivate() }}
          />
        )}
      </td>
    )
  }

  // Longtext cell
  if (col.kind === 'longtext') {
    if (effectivelyEditing) {
      const atCharLimit = col.maxLength != null && liveLen >= col.maxLength
      const nearCharLimit = col.maxLength != null && liveLen >= col.maxLength * 0.8
      const atByteLimit = col.maxUtf8ByteLength != null && liveBytes > col.maxUtf8ByteLength
      const nearByteLimit = col.maxUtf8ByteLength != null && liveBytes >= col.maxUtf8ByteLength * 0.9
      const atLimit = atCharLimit || atByteLimit
      const nearLimit = !atLimit && (nearCharLimit || nearByteLimit)
      return (
        <td {...tdShared} className={baseCls} style={{ ...cellStyle, ...selStyle }}>
          {fillHandle}
          <textarea ref={inputRef as any} defaultValue={editInitialChar !== null ? editInitialChar : displayValue}
            onInput={(e) => {
              // GX.8 — same local-edit model as the text/number cell (GX.3): only the
              // counter while typing; commitInput() writes the row once on exit.
              const v = (e.target as HTMLTextAreaElement).value
              setLiveLen(v.length)
              if (col.maxUtf8ByteLength != null) setLiveBytes(new TextEncoder().encode(v).length)
            }}
            onBlur={() => {
              if (!cancelledRef.current) commitInput()
              cancelledRef.current = false
              onDeactivate()
            }}
            onKeyDown={handleKeyDown}
            maxLength={col.maxLength}
            className="w-full px-1.5 py-1 text-xs bg-white dark:bg-slate-800 focus:outline-none text-slate-800 dark:text-slate-200 resize-none"
            style={{ minWidth: width, minHeight: Math.max(cellHeight, 60) }} />
          {(col.maxLength != null || col.maxUtf8ByteLength != null) && (
            <div className={cn('absolute bottom-1 right-1.5 text-[9px] tabular-nums font-mono pointer-events-none select-none flex gap-1.5',
              atLimit ? 'text-red-500 dark:text-red-400 font-bold'
              : nearLimit ? 'text-amber-500 dark:text-amber-400'
              : 'text-slate-300 dark:text-slate-600')}>
              {col.maxLength != null && <span>{liveLen}/{col.maxLength}</span>}
              {col.maxUtf8ByteLength != null && (
                <span className={atByteLimit ? 'text-red-500 dark:text-red-400 font-bold' : nearByteLimit ? 'text-amber-500' : ''}>
                  {liveBytes}B/{col.maxUtf8ByteLength}B
                </span>
              )}
            </div>
          )}
        </td>
      )
    }
    const viewByteOver = col.maxUtf8ByteLength != null && new TextEncoder().encode(displayValue).length > col.maxUtf8ByteLength
    return (
      <td {...tdShared} className={cn(baseCls, 'cursor-pointer hover:bg-white/50 dark:hover:bg-slate-700/30',
        viewByteOver && 'ring-1 ring-inset ring-red-400 dark:ring-red-500')}
        style={{ ...cellStyle, ...selStyle }}>
        {fillHandle}
        <div className="px-1.5 flex items-center text-xs text-slate-800 dark:text-slate-200 truncate" style={hStyle}>
          {displayValue || <span className="text-slate-300 dark:text-slate-600 italic">{(col.required && !isGhost) ? '⚠ required' : ''}</span>}
        </div>
      </td>
    )
  }

  // Text / number cell
  if (effectivelyEditing) {
    const atCharLimit = col.maxLength != null && liveLen >= col.maxLength
    const nearCharLimit = col.maxLength != null && liveLen >= col.maxLength * 0.8
    const atByteLimit = col.maxUtf8ByteLength != null && liveBytes > col.maxUtf8ByteLength
    const nearByteLimit = col.maxUtf8ByteLength != null && liveBytes >= col.maxUtf8ByteLength * 0.9
    const atLimit = atCharLimit || atByteLimit
    const nearLimit = !atLimit && (nearCharLimit || nearByteLimit)
    return (
      <td {...tdShared} className={baseCls} style={{ ...cellStyle, ...selStyle }}>
        {fillHandle}
        <input ref={inputRef as any} type="text" inputMode={col.kind === 'number' ? 'decimal' : undefined}
          defaultValue={editInitialChar !== null ? editInitialChar : displayValue} maxLength={col.maxLength}
          onInput={(e) => {
            // GX.3 — edit LOCALLY: only update the char counter while typing. No
            // setRows per keystroke (that re-rendered all ~62k cells on every key —
            // the real "typing feels laggy"). The input is uncontrolled, so the
            // typed text shows without React; commitInput() writes the final value
            // to the row once, on Tab/Enter/blur.
            const v = (e.target as HTMLInputElement).value
            setLiveLen(v.length)
            if (col.maxUtf8ByteLength != null) setLiveBytes(new TextEncoder().encode(v).length)
          }}
          onBlur={() => {
            if (!cancelledRef.current) commitInput()
            cancelledRef.current = false
            onDeactivate()
          }}
          onKeyDown={handleKeyDown}
          className="w-full px-1.5 text-xs bg-white dark:bg-slate-800 focus:outline-none text-slate-800 dark:text-slate-200"
          style={hStyle} />
        {(col.maxLength != null || col.maxUtf8ByteLength != null) && (
          <div className={cn('absolute bottom-0.5 right-1 text-[9px] tabular-nums font-mono pointer-events-none select-none leading-none flex gap-1',
            atLimit ? 'text-red-500 dark:text-red-400 font-bold'
            : nearLimit ? 'text-amber-500 dark:text-amber-400'
            : 'text-slate-300 dark:text-slate-600')}>
            {col.maxLength != null && <span>{liveLen}/{col.maxLength}</span>}
            {col.maxUtf8ByteLength != null && (
              <span className={atByteLimit ? 'text-red-500 dark:text-red-400 font-bold' : nearByteLimit ? 'text-amber-500' : ''}>
                {liveBytes}B/{col.maxUtf8ByteLength}B
              </span>
            )}
          </div>
        )}
      </td>
    )
  }

  const viewByteOver = col.maxUtf8ByteLength != null && new TextEncoder().encode(displayValue).length > col.maxUtf8ByteLength
  return (
    <td {...tdShared} className={cn(baseCls, grayed ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-white/50 dark:hover:bg-slate-700/30',
      viewByteOver && 'ring-1 ring-inset ring-red-400 dark:ring-red-500')}
      style={{ ...cellStyle, ...selStyle }} title={grayed ? 'Quantity is managed by Amazon for FBA listings' : (guidanceTitle ?? validIssue?.msg ?? col.description)}>
      {fillHandle}
      <div className={cn('px-1.5 flex items-center text-xs truncate',
        grayed ? 'text-slate-400 dark:text-slate-500 select-none'
        : isEmpty ? ((col.required && !isGhost) ? 'text-red-400 dark:text-red-500 italic' : 'text-slate-300 dark:text-slate-600') : 'text-slate-800 dark:text-slate-200')}
        style={hStyle}>
        {grayed ? '—' : (displayValue || ((col.required && !isGhost) ? '⚠ required' : ''))}
      </div>
    </td>
  )
}

// GX.4 — memoize the cell so a re-render of the parent/row (navigation, a commit,
// autosave) only re-renders the cells whose VISUAL props actually changed, not all
// ~62k. The callbacks are intentionally NOT compared: their behaviour is stable for
// a given (ri, ci, col) — which ARE compared — so a stale closure can't act on the
// wrong cell. Edge objects are new literals each render, so compare their fields.
type CellEdges = { top: boolean; right: boolean; bottom: boolean; left: boolean } | null | undefined
function edgesEqual(a: CellEdges, b: CellEdges): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left
}
function areCellPropsEqual(a: CellProps, b: CellProps): boolean {
  return (
    a.col === b.col &&
    a.value === b.value &&
    a.isActive === b.isActive &&
    a.isEditing === b.isEditing &&
    a.editInitialChar === b.editInitialChar &&
    a.cellBg === b.cellBg &&
    a.grayed === b.grayed &&
    a.isGhost === b.isGhost &&
    a.width === b.width &&
    a.cellHeight === b.cellHeight &&
    a.isSelected === b.isSelected &&
    a.isCorner === b.isCorner &&
    a.isFillTarget === b.isFillTarget &&
    a.isClipboard === b.isClipboard &&
    a.isMatch === b.isMatch &&
    a.toneCls === b.toneCls &&
    a.guidanceLevel === b.guidanceLevel &&
    a.ri === b.ri &&
    a.ci === b.ci &&
    a.stickyLeft === b.stickyLeft &&
    edgesEqual(a.selEdges, b.selEdges) &&
    edgesEqual(a.fillTargetEdges, b.fillTargetEdges) &&
    edgesEqual(a.clipboardEdges, b.clipboardEdges) &&
    (a.validIssue === b.validIssue ||
      (!!a.validIssue && !!b.validIssue && a.validIssue.level === b.validIssue.level && a.validIssue.msg === b.validIssue.msg))
  )
}
const SpreadsheetCell = memo(SpreadsheetCellImpl, areCellPropsEqual)

// ── EnumDropdown ────────────────────────────────────────────────────────
// Floating dropdown panel that appears below the active enum cell.
// Matches Excel's "in-cell dropdown" UX: search-to-filter + keyboard nav.

interface EnumDropdownProps {
  options: string[]
  /** Maps canonical stored value → localized display label */
  optionLabels?: Record<string, string>
  current: string
  /** When true the user must pick from the list; typed custom values are not allowed */
  selectionOnly?: boolean
  /** GX.2b — pre-fill the search (e.g. the char typed to open the dropdown). */
  initialQuery?: string
  /** navDir set when committed via Tab/Enter, so the parent can move to the next cell. */
  onSelect: (val: string, navDir?: 'right' | 'left' | 'down' | 'up') => void
  onClose: () => void
}

function EnumDropdown({ options, optionLabels, current, selectionOnly = false, initialQuery = '', onSelect, onClose }: EnumDropdownProps) {
  const [query, setQuery] = useState(initialQuery)
  const [highlighted, setHighlighted] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  const getLabel = (opt: string) => optionLabels?.[opt] ?? opt

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    // Search against both the canonical value AND the localized label
    return options.filter((o) => !q || o.toLowerCase().includes(q) || getLabel(o).toLowerCase().includes(q))
  }, [options, optionLabels, query])

  // A typed value not in the list is always allowed (you can write your own);
  // for selection-only fields it's flagged, since Amazon may reject it.
  const hasCustom = query.trim() !== '' && !options.includes(query.trim())
  const totalItems = filtered.length + (hasCustom ? 1 : 0)

  useEffect(() => {
    const el = searchRef.current
    if (el) { el.focus(); const n = el.value.length; el.setSelectionRange(n, n) }
  }, [])
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

  function commit(idx: number, navDir?: 'right' | 'left' | 'down' | 'up') {
    if (idx === filtered.length && hasCustom) { onSelect(query.trim(), navDir); return }
    if (filtered[idx] != null) onSelect(filtered[idx], navDir)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlighted((h) => Math.min(h + 1, totalItems - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlighted((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); commit(highlighted, e.shiftKey ? 'up' : 'down') }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    else if (e.key === 'Tab') { e.preventDefault(); commit(highlighted, e.shiftKey ? 'left' : 'right') }
  }

  return (
    <div className="absolute left-0 top-full mt-0 z-50 w-48 min-w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg overflow-hidden"
      onKeyDown={handleKeyDown}>
      <div className="px-2 py-1.5 border-b border-slate-100 dark:border-slate-700">
        <input ref={searchRef} type="text" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={selectionOnly ? 'Search Amazon’s values…' : 'Search or type your own…'}
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
            {opt === '' ? <span className="italic opacity-60">— empty —</span> : getLabel(opt)}
          </div>
        ))}
        {filtered.length === 0 && !hasCustom && (
          <div className="px-3 py-2 text-xs text-slate-400 italic">No matches</div>
        )}
        {hasCustom && (
          <div role="option" aria-selected={false}
            onMouseDown={(e) => { e.preventDefault(); onSelect(query.trim()) }}
            onMouseEnter={() => setHighlighted(filtered.length)}
            className={cn(
              'px-3 py-1.5 text-xs cursor-pointer border-t flex items-center gap-1.5',
              selectionOnly ? 'border-amber-200 dark:border-amber-800/60' : 'border-slate-100 dark:border-slate-700',
              highlighted === filtered.length
                ? (selectionOnly ? 'bg-amber-500 text-white' : 'bg-blue-500 text-white')
                : (selectionOnly
                    ? 'text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30'
                    : 'text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700/50'),
            )}>
            {selectionOnly && <AlertCircle className="w-3 h-3 shrink-0" />}
            <span className="opacity-60">Use</span>
            <span className="font-mono font-medium truncate">&ldquo;{query.trim()}&rdquo;</span>
            {selectionOnly && (
              <span className={cn('ml-auto text-[10px] shrink-0', highlighted === filtered.length ? 'text-amber-100' : 'text-amber-500/80')}>
                not in Amazon&apos;s list
              </span>
            )}
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

// TbBtn moved to ../_shared/FlatFileIconToolbar.tsx in Phase B. The
// toolbar block in this file now consumes FlatFileIconToolbar and the
// shared SharedTbBtn primitive for any Amazon-specific buttons it
// renders inside its slot props.

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
      {item('Group selected…', undefined, onGroupSelected, !hasSelection)}
      {item('Clear cells', 'Del', onClearCells, !hasSelection)}
    </div>
  )
}


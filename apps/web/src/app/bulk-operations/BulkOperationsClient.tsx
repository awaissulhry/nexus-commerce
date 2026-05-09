// @ts-nocheck — U.54 BISECT 5: StatusBar + first 4 modals only
'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useSearchParams, useRouter, usePathname } from 'next/navigation'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnSizingState,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { produce } from 'immer'
import {
  AlertTriangle,
  ChevronRight,
  Loader2,
  Lock,
  Redo2,
  RefreshCw,
  RotateCcw,
  Search,
  Undo2,
  Upload,
  WifiOff,
  Wand2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import {
  emitInvalidation,
  useInvalidationChannel,
} from '@/lib/sync/invalidation-channel'
import { editHandlers, editKey } from './EditableCell'
import PreviewChangesModal from './PreviewChangesModal'
import UploadModal from './UploadModal'
import BulkOperationModal from './BulkOperationModal'
import FilterDropdown from './components/FilterDropdown'
import PastePreviewModal, {
  type PasteCell,
  type PasteError,
  type PastePreview,
} from './PastePreviewModal'
import CascadeChoiceModal from './components/CascadeChoiceModal'
import ColumnSelector, { type FieldDef } from './components/ColumnSelector'
import MarketplaceSelector, {
  MarketplaceContextBanner,
  type MarketplaceContext,
  type MarketplaceOption,
} from './components/MarketplaceSelector'
import MarketplaceTabs from './components/MarketplaceTabs'
import {
  loadAllViews,
  saveUserView,
  deleteUserView,
  hydrateViewsFromServer,
  isDefaultView,
  setActiveViewId,
  getActiveViewId,
  DEFAULT_VIEWS,
  type SavedView,
} from './lib/saved-views'
import {
  buildHierarchy,
  loadDisplayMode,
  saveDisplayMode,
  loadExpandedParents,
  saveExpandedParents,
  type DisplayMode,
} from './lib/hierarchy'
import {
  isDimFieldId,
  isWeightFieldId,
  parseDimension,
  parseWeight,
} from './lib/unit-parsing'
import { cn } from '@/lib/utils'

// ── T.1 — extracted modules ──────────────────────────────────────
//
// The bulky helpers + small components moved out of this file when
// it was decomposed in T.1. Behaviour unchanged — the imports below
// alias them back into the names the main component used.

import {
  ROW_HEIGHT,
  HEADER_HEIGHT,
  type BulkProduct,
  type CellChange,
  type CascadeModalState,
  type ApiError,
  type SaveStatus,
  type SelectionState,
  EMPTY_FILTER_STATE,
  type FilterState,
  type HistoryDelta,
  type HistoryEntry,
  type FillState,
  type SelectionMetrics,
} from './lib/types'
import {
  actionsCtxRef,
  editCtxRef,
  hierarchyCtxRef,
  selectCtxRef,
  hasMarketplaceContextRef,
  primaryContextRef,
  columnTonesRef,
  type ColumnTone,
} from './lib/refs'
import NewProductModal from './components/NewProductModal'
import ReplicateModal from './components/ReplicateModal'
import { Copy, Plus, Trash2 } from 'lucide-react'
import { groupForFieldId } from '../products/_shared/attribute-editor'
import { buildColumnFromField } from './lib/grid-columns'
import {
  computeFillExtension,
  computeFillValue,
} from './lib/fill-helpers'
import {
  toTsvCell,
  parseTsv,
  coercePasteValue,
  looselyEqual,
} from './lib/tsv-helpers'
import {
  TableRow,
  SelectionOverlays,
  SkeletonRow,
} from './components/GridRow'
import { StatusBar } from './components/StatusBar'
import {
  DisplayModeToggle,
  ExpandCollapseControls,
} from './components/DisplayControls'

// Re-export BulkProduct so any sibling file (modals, cells, etc.) that
// used to import it from this file still finds it here.
export type { BulkProduct } from './lib/types'

// ── T.3 — column group taxonomy ────────────────────────────────
//
// Two layers feed it: registry FieldDefinition.category for Product-
// column fields, and the schema editor's groupForFieldId() for attr_*
// (which strips the prefix and maps to Identity / Marketing copy /
// etc.). Same colour swatches as the per-product editor so both
// tools share a visual language.

interface GroupTone {
  band: string
  text: string
  ring: string
  /** JJ — soft body-cell tint, mirroring the per-product editor's
   *  TONE_BY_GROUP shape so the two grids share a visual identity. */
  cell: string
}

// W.1 / JJ — schema-style keys only. Master (registry) categories map
// to the same keys so master columns and their attr_* schema
// equivalents bucket together in one chip (e.g. `brand` (universal) +
// `attr_brand` (Identity) → both 'Identity'). Palette mirrors the
// per-product BulkEditClient.tsx TONE_BY_GROUP so users get the same
// colour-per-group identity in either tool.
const GROUP_TONE: Record<string, GroupTone> = {
  Identity: { band: 'bg-slate-100 border-slate-300', text: 'text-slate-900', ring: 'border-slate-300', cell: 'bg-white' },
  Identifiers: { band: 'bg-indigo-50 border-indigo-200', text: 'text-indigo-900', ring: 'border-indigo-200', cell: 'bg-indigo-50/30' },
  'Marketing copy': { band: 'bg-violet-50 border-violet-200', text: 'text-violet-900', ring: 'border-violet-200', cell: 'bg-violet-50/30' },
  'Variation attributes': { band: 'bg-fuchsia-50 border-fuchsia-200', text: 'text-fuchsia-900', ring: 'border-fuchsia-200', cell: 'bg-fuchsia-50/30' },
  Audience: { band: 'bg-cyan-50 border-cyan-200', text: 'text-cyan-900', ring: 'border-cyan-200', cell: 'bg-cyan-50/30' },
  Categorisation: { band: 'bg-rose-50 border-rose-200', text: 'text-rose-900', ring: 'border-rose-200', cell: 'bg-rose-50/30' },
  Pricing: { band: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-900', ring: 'border-emerald-200', cell: 'bg-emerald-50/30' },
  Inventory: { band: 'bg-amber-50 border-amber-200', text: 'text-amber-900', ring: 'border-amber-200', cell: 'bg-amber-50/30' },
  'Pricing & fulfillment': { band: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-900', ring: 'border-emerald-200', cell: 'bg-emerald-50/30' },
  Physical: { band: 'bg-sky-50 border-sky-200', text: 'text-sky-900', ring: 'border-sky-200', cell: 'bg-sky-50/30' },
  'Physical attributes': { band: 'bg-sky-50 border-sky-200', text: 'text-sky-900', ring: 'border-sky-200', cell: 'bg-sky-50/30' },
  'Compliance & safety': { band: 'bg-amber-50 border-amber-200', text: 'text-amber-900', ring: 'border-amber-200', cell: 'bg-amber-50/30' },
  'Other attributes': { band: 'bg-slate-50 border-slate-200', text: 'text-slate-700', ring: 'border-slate-200', cell: 'bg-slate-50/30' },
}

const NEUTRAL_TONE: GroupTone = {
  band: 'bg-slate-100 border-slate-200',
  text: 'text-slate-900',
  ring: 'border-slate-200',
  cell: 'bg-white',
}

// W.1 — keys are now schema-style display names; the label map only
// translates legacy registry keys for backward compat.
const GROUP_LABEL: Record<string, string> = {
  Identity: 'Identity',
  Identifiers: 'Identifiers',
  'Marketing copy': 'Marketing copy',
  Pricing: 'Pricing',
  Inventory: 'Inventory',
  Physical: 'Physical',
  'Variation attributes': 'Variation attributes',
  Audience: 'Audience',
  Categorisation: 'Categorisation',
  'Pricing & fulfillment': 'Pricing & fulfillment',
  'Physical attributes': 'Physical attributes',
  'Compliance & safety': 'Compliance & safety',
  'Other attributes': 'Other attributes',
}

/** W.1 — registry FieldDefinition.category → unified group key.
 *  Master Product columns use registry categories (universal /
 *  pricing / inventory / etc.); attr_* fields use the curated schema
 *  groups (Identity / Marketing copy / etc.). This map normalises
 *  master categories to the same key family so equivalent fields
 *  ('brand' the column + 'attr_brand' the schema attribute) bucket
 *  into ONE chip instead of two. */
const REGISTRY_TO_UNIFIED_KEY: Record<string, string> = {
  universal: 'Identity',
  identifiers: 'Identifiers',
  pricing: 'Pricing',
  inventory: 'Inventory',
  physical: 'Physical',
  content: 'Marketing copy',
  category: 'Other attributes',
  amazon: 'Other attributes',
  ebay: 'Other attributes',
}

// KK — channel-aware default column order. Mirrors the natural
// shelf order of Amazon Seller Central / eBay Seller Hub so users
// see the same column flow they'd see in the source platform's UI.
// Fields not in this list keep their relative insertion order
// (which preserves manual drag-reorders within the unlisted tail).
const CHANNEL_DEFAULT_ORDER: Record<string, string[]> = {
  AMAZON: [
    'sku',
    'amazon_title',
    'amazonAsin',
    'parentAsin',
    'productType',
    'amazon_variationTheme',
    'status',
    'basePrice',
    'buyBoxPrice',
    'competitorPrice',
    'totalStock',
    'fulfillmentChannel',
    'lowStockThreshold',
    'upc',
    'ean',
    'gtin',
    'brand',
    'manufacturer',
    'amazon_description',
    'amazon_bullets',
    'amazon_searchKeywords',
    'amazon_browseNode',
    'weightValue',
    'weightUnit',
    'dimLength',
    'dimWidth',
    'dimHeight',
    'dimUnit',
  ],
  EBAY: [
    'sku',
    'ebay_title',
    'ebayItemId',
    'productType',
    'ebay_variationTheme',
    'ebay_format',
    'ebay_duration',
    'status',
    'basePrice',
    'totalStock',
    'lowStockThreshold',
    'upc',
    'ean',
    'gtin',
    'brand',
    'manufacturer',
    'ebay_description',
    'weightValue',
    'weightUnit',
    'dimLength',
    'dimWidth',
    'dimHeight',
    'dimUnit',
  ],
}

/** KK — reorder a list of column ids into the channel's natural
 *  shelf order, with sensible secondary rules:
 *    1. Explicitly-ordered ids (CHANNEL_DEFAULT_ORDER) come first.
 *    2. Schema attr_* fields next, alphabetised so categories that
 *       share their root (attr_armorType, attr_ceCertification) sit
 *       together regardless of registry insertion order.
 *    3. Other channel-prefixed fields next.
 *    4. Anything left preserves its original index (so user drags
 *       in the unlisted tail aren't clobbered).
 *  Fields no longer in `allFields` are dropped so the reorder also
 *  cleans up stale ids. */
function applyChannelDefaultOrder(
  ids: string[],
  channel: string,
  _allFields: Array<{ id: string; channel?: string }>,
): string[] {
  // KK.2 — DO NOT drop unknown ids. allFields can hydrate after this
  // function runs (multiple async fetches feed the registry); dropping
  // unrecognised ids here silently lost columns when a tab switch
  // raced the schema fetch. Now we just dedupe and reorder; ids that
  // never resolve to a registry entry will simply not render rows
  // (the cell renderer handles missing meta gracefully).
  const order = CHANNEL_DEFAULT_ORDER[channel] ?? []
  const orderRank = new Map(order.map((id, idx) => [id, idx]))
  const dedup: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    dedup.push(id)
  }
  return dedup.slice().sort((a, b) => {
    const ra = orderRank.get(a)
    const rb = orderRank.get(b)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    const aAttr = a.startsWith('attr_')
    const bAttr = b.startsWith('attr_')
    if (aAttr !== bAttr) return aAttr ? -1 : 1
    if (aAttr && bAttr) return a.localeCompare(b)
    const aChannelPrefixed = a.includes('_') && !a.startsWith('attr_')
    const bChannelPrefixed = b.includes('_') && !b.startsWith('attr_')
    if (aChannelPrefixed !== bChannelPrefixed) return aChannelPrefixed ? -1 : 1
    return dedup.indexOf(a) - dedup.indexOf(b)
  })
}

/** Decide which group a FieldDef belongs to. attr_* fields get the
 *  curated schema-editor group; master columns get a normalised key
 *  via REGISTRY_TO_UNIFIED_KEY so they share a bucket with their
 *  schema equivalents. */
function groupKeyForField(field: FieldDef): string {
  if (field.id.startsWith('attr_')) {
    const stripped = field.id.replace(/^attr_/, '')
    return groupForFieldId(stripped)
  }
  return REGISTRY_TO_UNIFIED_KEY[field.category] ?? field.category
}

// LL — placeholder-column helpers for collapsed groups. The id is
// __group_<key> so it's distinct from any real field id (real fields
// come from the registry which never produces underscored prefixes).
// Width matches the existing band-chip collapsed width so the column
// header + band stay aligned visually.
const COLLAPSED_COL_WIDTH = 80
function collapsedColumnId(groupKey: string): string {
  return `__group_${groupKey}`
}
const COLLAPSED_GROUPS_KEY = 'nexus_bulkops_collapsed_groups'

function loadCollapsedGroups(): Set<string> {
  if (typeof window === 'undefined') return new Set()
  try {
    const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY)
    if (!raw) return new Set()
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? new Set(arr) : new Set()
  } catch {
    return new Set()
  }
}

function saveCollapsedGroups(set: Set<string>) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(
      COLLAPSED_GROUPS_KEY,
      JSON.stringify(Array.from(set)),
    )
  } catch {
    /* ignore quota errors */
  }
}

/** T.4 — per-row delete trigger. Reads the latest handler off
 *  actionsCtxRef so dynamicColumns can stay memoised on field changes
 *  only (handler identity changes every render but the ref doesn't). */
function DeleteRowButton({
  id,
  sku,
  isParent,
}: {
  id: string
  sku: string
  isParent: boolean
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        actionsCtxRef.current.onDelete(id, sku, isParent)
      }}
      title={
        isParent
          ? `Delete master ${sku} (cascades to its variants + listings)`
          : `Delete variant ${sku}`
      }
      className="w-full h-full flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50"
    >
      <Trash2 className="w-3 h-3" />
    </button>
  )
}

export default function BulkOperationsClient() {
  const askConfirm = useConfirm()
  const [products, setProducts] = useState<BulkProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchMs, setFetchMs] = useState<number | null>(null)

  const [changes, setChanges] = useState<Map<string, CellChange>>(new Map())
  const [cellErrors, setCellErrors] = useState<Map<string, string>>(new Map())
  const [resetKeys, setResetKeys] = useState<Map<string, number>>(new Map())
  const [cascadeModal, setCascadeModal] = useState<CascadeModalState | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [bulkOpModalOpen, setBulkOpModalOpen] = useState(false)
  const [newProductOpen, setNewProductOpen] = useState(false)
  const [replicateOpen, setReplicateOpen] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(
    () => loadCollapsedGroups(),
  )
  // V.3 — column being dragged (HTML5 DnD source). Null when no drag
  // is in progress. Used by the header cells' onDragOver to draw a
  // drop-target indicator.
  const [draggedColumnId, setDraggedColumnId] = useState<string | null>(null)
  const [dragOverColumnId, setDragOverColumnId] = useState<string | null>(null)
  const [dragOverColumnSide, setDragOverColumnSide] = useState<
    'before' | 'after' | null
  >(null)
  // V.4 — same shape for the group band so dragging a chip moves all
  // its member fields together.
  // V.8 — `dragOverGroupSide` ('before'/'after') tracks which half of
  // the hovered chip the cursor is on, so wide chips become two
  // distinct hit zones with a vertical drop-line indicator. Without
  // this, a wide group like Identity (~600px) would only respond to
  // drops aimed at its centre.
  const [draggedGroupKey, setDraggedGroupKey] = useState<string | null>(null)
  const [dragOverGroupKey, setDragOverGroupKey] = useState<string | null>(null)
  const [dragOverGroupSide, setDragOverGroupSide] = useState<
    'before' | 'after' | null
  >(null)

  // Bridge ref so reorderColumns can read the latest fieldsById map
  // without depending on it (fieldsById is computed later in the
  // render but the callback fires after mount; the ref is updated
  // each render so the callback sees the current value).
  const fieldsByIdRef = useRef<Map<string, FieldDef>>(new Map())

  const reorderColumns = useCallback(
    (sourceId: string, targetId: string) => {
      if (sourceId === targetId) return
      // KK.2 — reordering columns invalidates the rectangle's column
      // indices (rangeBounds is { minCol, maxCol } against the
      // visible column array — those indices now point at different
      // columns). Clear the selection rather than draw it on the
      // wrong cells.
      setSelection({ anchor: null, active: null })
      setVisibleColumnIds((prev) => {
        const fromIdx = prev.indexOf(sourceId)
        const toIdx = prev.indexOf(targetId)
        if (fromIdx === -1 || toIdx === -1) return prev
        const next = prev.slice()
        const [moved] = next.splice(fromIdx, 1)
        next.splice(toIdx, 0, moved!)
        // W.2 — enforce group contiguity. After the splice we re-bucket
        // by group key, preserving within-group order, with group order
        // = first encounter. So a column dropped into another group's
        // territory pulls back to the end of its own group's block —
        // the band stays a clean one-chip-per-group view.
        const fbi = fieldsByIdRef.current
        const buckets = new Map<string, string[]>()
        const firstSeen = new Map<string, number>()
        next.forEach((id, idx) => {
          const f = fbi.get(id)
          if (!f) {
            const k = `__unknown_${idx}`
            buckets.set(k, [id])
            firstSeen.set(k, idx)
            return
          }
          const k = groupKeyForField(f)
          if (!buckets.has(k)) {
            buckets.set(k, [])
            firstSeen.set(k, idx)
          }
          buckets.get(k)!.push(id)
        })
        const groupOrder = Array.from(firstSeen.entries())
          .sort((a, b) => a[1] - b[1])
          .map(([k]) => k)
        const result: string[] = []
        for (const k of groupOrder) {
          result.push(...(buckets.get(k) ?? []))
        }
        return result
      })
    },
    [],
  )

  /** V.4 / V.8 — move every field in `sourceKey` to just before or
   *  just after `targetKey`'s span (per `side`). Preserves within-
   *  group ordering of both source and target so individual column
   *  reorders inside groups don't get clobbered. */
  const reorderGroups = useCallback(
    (
      sourceKey: string,
      targetKey: string,
      side: 'before' | 'after',
      groups: Array<{ key: string; fields: FieldDef[] }>,
    ) => {
      if (sourceKey === targetKey) return
      const source = groups.find((g) => g.key === sourceKey)
      const target = groups.find((g) => g.key === targetKey)
      if (!source || !target) return
      // KK.2 — same as reorderColumns: invalidate the selection
      // rectangle since column indices shift.
      setSelection({ anchor: null, active: null })
      const sourceIds = new Set(source.fields.map((f) => f.id))
      setVisibleColumnIds((prev) => {
        const without = prev.filter((id) => !sourceIds.has(id))
        const anchorId =
          side === 'before'
            ? target.fields[0]?.id
            : target.fields[target.fields.length - 1]?.id
        if (!anchorId) return prev
        const anchorIdx = without.indexOf(anchorId)
        if (anchorIdx === -1) return prev
        const insertAt = side === 'before' ? anchorIdx : anchorIdx + 1
        const moved = source.fields.map((f) => f.id)
        return [
          ...without.slice(0, insertAt),
          ...moved,
          ...without.slice(insertAt),
        ]
      })
    },
    [],
  )
  const toggleGroupCollapse = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      saveCollapsedGroups(next)
      return next
    })
  }, [])
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' })
  const [online, setOnline] = useState(true)

  // ── Dynamic columns state ───────────────────────────────────────────
  const [allFields, setAllFields] = useState<FieldDef[]>([])
  const [enabledChannels, setEnabledChannels] = useState<string[]>([])
  const [enabledProductTypes, setEnabledProductTypes] = useState<string[]>([])
  const [savedViews, setSavedViews] = useState<SavedView[]>(() => [...DEFAULT_VIEWS])
  const [activeViewIdState, setActiveViewIdState] = useState<string>(
    DEFAULT_VIEWS[0].id
  )
  const [visibleColumnIds, setVisibleColumnIds] = useState<string[]>(
    DEFAULT_VIEWS[0].columnIds
  )

  // ── Hierarchy display state ──────────────────────────────────────
  const [displayMode, setDisplayMode] = useState<DisplayMode>('flat')

  // ── D.6: search + filter state ─────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(searchQuery), 150)
    return () => window.clearTimeout(t)
  }, [searchQuery])
  const [filterState, setFilterState] = useState<FilterState>(EMPTY_FILTER_STATE)
  const activeFilterCount =
    filterState.status.length +
    filterState.channels.length +
    (filterState.stockLevel !== 'all' ? 1 : 0) +
    filterState.productTypes.length +
    (filterState.parentage !== 'any' ? 1 : 0) +
    (filterState.hasAsin !== 'any' ? 1 : 0) +
    (filterState.hasGtin !== 'any' ? 1 : 0) +
    (filterState.missingRequired ? 1 : 0)
  const resetFilters = useCallback(
    () => setFilterState(EMPTY_FILTER_STATE),
    [],
  )
  const [filterOpen, setFilterOpen] = useState(false)
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())

  // ── D.3d / R.1: marketplace targets (multi-select) ──────────────
  // R.1 — promoted from a singular MarketplaceContext to an array so
  // channel-field edits can fan out to N marketplaces in one save.
  // The first entry acts as the "primary" — drives the table-view
  // hydration query (?channel=&marketplace=) since the grid still
  // renders one listing's worth of data per row. Edits broadcast to
  // every entry in `marketplaceTargets`.
  const [marketplaceTargets, setMarketplaceTargets] = useState<
    MarketplaceContext[]
  >([])
  const primaryContext: MarketplaceContext | null = marketplaceTargets[0] ?? null
  const [marketplaceOptions, setMarketplaceOptions] = useState<MarketplaceOption[]>([])

  // ── Column resize state (Step 1.5) ─────────────────────────────
  // TanStack v8 stores user-dragged widths as a {[colId]: width} map.
  // We persist it to localStorage so widths survive reloads.
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    if (typeof window === 'undefined') return {}
    try {
      const raw = window.localStorage.getItem('nexus_bulkops_column_widths')
      return raw ? (JSON.parse(raw) as ColumnSizingState) : {}
    } catch {
      return {}
    }
  })
  useEffect(() => {
    try {
      window.localStorage.setItem(
        'nexus_bulkops_column_widths',
        JSON.stringify(columnSizing),
      )
    } catch {
      /* localStorage may be disabled — non-critical */
    }
  }, [columnSizing])
  const resetColumnWidths = useCallback(() => setColumnSizing({}), [])

  // ── Step 1 selection state ──────────────────────────────────────
  const [selection, setSelection] = useState<SelectionState>({
    anchor: null,
    active: null,
  })
  // Mirror selection in a ref so the global keydown listener can read
  // the latest value without re-attaching the document handler each
  // time selection changes.
  const selectionRef = useRef<SelectionState>(selection)
  selectionRef.current = selection

  const select = useCallback(
    (rowIdx: number, colIdx: number, shift: boolean) => {
      // Step 3.5: edit-on-click is covered by onDoubleClick on the
      // EditableCell — within ~500ms the browser groups the second
      // click as a dblclick. Beyond that window, two clicks are
      // intentional re-selection (no edit). So plain click is
      // selection-only here.
      setSelection((s) =>
        shift && s.anchor
          ? { anchor: s.anchor, active: { rowIdx, colIdx } }
          : {
              anchor: { rowIdx, colIdx },
              active: { rowIdx, colIdx },
            },
      )
    },
    [],
  )
  selectCtxRef.current.select = select

  // ── Step 2: click + drag rectangle ─────────────────────────────
  // The drag implementation lives in refs so we don't pay re-render
  // cost on every mousemove. Active updates flow through setSelection
  // (and only the overlays re-render — see SelectionOverlays).
  const dragStateRef = useRef<{
    rafId: number | null
    pendingX: number
    pendingY: number
    didMove: boolean
    startRow: number
    startCol: number
  } | null>(null)
  const beginDrag = useCallback((startRow: number, startCol: number) => {
    dragStateRef.current = {
      rafId: null,
      pendingX: 0,
      pendingY: 0,
      didMove: false,
      startRow,
      startCol,
    }

    const flush = () => {
      const s = dragStateRef.current
      if (!s) return
      s.rafId = null
      const el = document.elementFromPoint(s.pendingX, s.pendingY) as
        | HTMLElement
        | null
      if (!el) return
      const cellEl = el.closest('[data-row-idx]') as HTMLElement | null
      if (!cellEl) return
      const r = parseInt(cellEl.getAttribute('data-row-idx') ?? '', 10)
      const c = parseInt(cellEl.getAttribute('data-col-idx') ?? '', 10)
      if (Number.isNaN(r) || Number.isNaN(c)) return
      if (r !== s.startRow || c !== s.startCol) s.didMove = true
      setSelection((prev) =>
        prev.anchor
          ? { anchor: prev.anchor, active: { rowIdx: r, colIdx: c } }
          : prev,
      )
    }

    const onMove = (e: MouseEvent) => {
      const s = dragStateRef.current
      if (!s) return
      s.pendingX = e.clientX
      s.pendingY = e.clientY
      // Coalesce on rAF — caps work at ~60fps regardless of how fast
      // the mouse moves.
      if (s.rafId === null) {
        s.rafId = requestAnimationFrame(flush)
      }
    }

    const onUp = () => {
      const s = dragStateRef.current
      if (s?.rafId !== null && s?.rafId !== undefined) {
        cancelAnimationFrame(s.rafId)
      }
      // U.40 — removed the document-wide capture-phase click
      // listener that suppressed the next click after a multi-
      // cell drag (intent: prevent the drop-target cell from
      // entering edit mode for what was clearly a select-rect
      // gesture). Even after U.37 scoped its preventDefault to
      // `[data-row-idx]` cells, the listener still attached to
      // document — and the user reported sidebar + Job-History
      // Link clicks failing on /bulk-operations.
      // The consequence (cell may enter edit mode after a drag)
      // is a minor UX nit; navigation must work.
      dragStateRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [])
  selectCtxRef.current.beginDrag = beginDrag
  const rangeBounds = useMemo(() => {
    if (!selection.anchor || !selection.active) return null
    return {
      minRow: Math.min(selection.anchor.rowIdx, selection.active.rowIdx),
      maxRow: Math.max(selection.anchor.rowIdx, selection.active.rowIdx),
      minCol: Math.min(selection.anchor.colIdx, selection.active.colIdx),
      maxCol: Math.max(selection.anchor.colIdx, selection.active.colIdx),
    }
  }, [selection])
  const rangeBoundsRef = useRef(rangeBounds)
  rangeBoundsRef.current = rangeBounds

  // ── Step 5: drag-fill state ────────────────────────────────────
  const [fillState, setFillState] = useState<FillState | null>(null)

  const selectedCellCount = useMemo(() => {
    if (!rangeBounds) return 0
    return (
      (rangeBounds.maxRow - rangeBounds.minRow + 1) *
      (rangeBounds.maxCol - rangeBounds.minCol + 1)
    )
  }, [rangeBounds])

  // Hydrate state on mount. Saved views ship with a hardcoded default
  // set (DEFAULT_VIEWS); user templates come in async from
  // /api/bulk-ops/templates and the nexus:views-changed listener
  // re-renders once the server payload lands.
  useEffect(() => {
    setSavedViews(loadAllViews())
    const id = getActiveViewId()
    setActiveViewIdState(id)
    const view =
      loadAllViews().find((v) => v.id === id) ?? DEFAULT_VIEWS[0]
    setVisibleColumnIds(view.columnIds)
    if (view.channels) setEnabledChannels(view.channels)
    if (view.productTypes) setEnabledProductTypes(view.productTypes)
    if (view.filterState) setFilterState(view.filterState)
    setDisplayMode(loadDisplayMode())
    setExpandedParents(loadExpandedParents())
    const onChange = () => setSavedViews(loadAllViews())
    window.addEventListener('nexus:views-changed', onChange)
    // T.6 — pull server-side templates so they show up in the saved-
    // views dropdown without a manual refresh.
    void hydrateViewsFromServer()
    return () => window.removeEventListener('nexus:views-changed', onChange)
  }, [])

  // Persist hierarchy state when it changes (separate effect — runs
  // after hydrate + every user-driven update).
  useEffect(() => {
    saveDisplayMode(displayMode)
  }, [displayMode])
  useEffect(() => {
    saveExpandedParents(expandedParents)
  }, [expandedParents])

  const toggleExpanded = useCallback((parentId: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev)
      if (next.has(parentId)) next.delete(parentId)
      else next.add(parentId)
      return next
    })
  }, [])

  // Push hierarchy ctx into the module ref so cell renderers see it
  hierarchyCtxRef.current = { mode: displayMode, onToggle: toggleExpanded }

  // Push marketplace presence into the module ref so channel-field
  // cell renderers can show "Select marketplace" placeholder when
  // context is missing.
  hasMarketplaceContextRef.current = marketplaceTargets.length > 0
  // EE.2 — productType cell uses this to dispatch to the right
  // ProductTypePicker mode (search for EBAY, list for AMAZON).
  primaryContextRef.current = primaryContext
    ? {
        channel: primaryContext.channel as
          | 'AMAZON'
          | 'EBAY'
          | 'SHOPIFY'
          | 'WOOCOMMERCE'
          | 'ETSY',
        marketplace: primaryContext.marketplace,
      }
    : null

  // Refs for stable callbacks
  const productsRef = useRef(products)
  const changesRef = useRef(changes)
  const allFieldsRef = useRef<FieldDef[]>([])
  useEffect(() => {
    productsRef.current = products
  }, [products])
  useEffect(() => {
    changesRef.current = changes
  }, [changes])

  // Online / offline
  useEffect(() => {
    if (typeof navigator !== 'undefined') setOnline(navigator.onLine)
    const onOnline = () => setOnline(true)
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  // ── D.6.3: undo / redo history ──────────────────────────────────
  // Capped at 50 entries to bound memory; truncates forward history
  // when the user edits after undoing (standard Excel/Sheets feel).
  const HISTORY_LIMIT = 50
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  // Suppresses re-recording while undo/redo is in flight.
  const isUndoingRef = useRef(false)
  const pushHistoryEntry = useCallback((entry: HistoryEntry) => {
    setHistory((prev) => {
      const next = prev.slice(0, historyIndexRef.current + 1)
      next.push(entry)
      const trimmed =
        next.length > HISTORY_LIMIT
          ? next.slice(next.length - HISTORY_LIMIT)
          : next
      historyIndexRef.current = trimmed.length - 1
      setHistoryIndex(trimmed.length - 1)
      return trimmed
    })
  }, [])
  const historyIndexRef = useRef(historyIndex)
  useEffect(() => {
    historyIndexRef.current = historyIndex
  }, [historyIndex])

  /** Add or update an entry in the changesMap. Drops the entry when the
   * new value matches the original (revert). Updates cascade tracking
   * + clears stale cell errors. Common code path used by both direct
   * commits and the cascade modal's "Apply" handler. */
  const writeChange = useCallback(
    (
      rowId: string,
      columnId: string,
      newValue: unknown,
      cascade: boolean,
      /** D.6.3: when supplied, the delta is appended here instead of
       *  pushing a new history entry. The caller pushes one combined
       *  entry after the batch finishes (paste, drag-fill, etc.). */
      historyBatch?: HistoryDelta[],
    ) => {
      const key = `${rowId}:${columnId}`
      const product = productsRef.current.find((p) => p.id === rowId)
      if (!product) return
      const oldValue = (product as unknown as Record<string, unknown>)[columnId]

      // Compute before/after snapshots for the history delta.
      const before = changesRef.current.get(key) ?? null
      const after: CellChange | null = looselyEqual(newValue, oldValue)
        ? null
        : {
            rowId,
            columnId,
            oldValue,
            newValue,
            cascade,
            timestamp: Date.now(),
          }
      // No-op edits (clean → clean with same value) shouldn't pollute
      // the history stack.
      const isNoOp =
        (before === null && after === null) ||
        (before !== null &&
          after !== null &&
          looselyEqual(before.newValue, after.newValue) &&
          before.cascade === after.cascade)

      setChanges((prev) => {
        const next = new Map(prev)
        if (after === null) {
          next.delete(key)
        } else {
          next.set(key, after)
        }
        return next
      })

      setCellErrors((prev) => {
        if (!prev.has(key)) return prev
        const next = new Map(prev)
        next.delete(key)
        return next
      })

      setSaveStatus((prev) =>
        prev.kind === 'saving' ? prev : { kind: 'dirty' }
      )

      if (!isUndoingRef.current && !isNoOp) {
        const delta: HistoryDelta = {
          rowId,
          columnId,
          before,
          after,
        }
        if (historyBatch) {
          historyBatch.push(delta)
        } else {
          pushHistoryEntry({ cells: [delta], timestamp: Date.now() })
        }
      }
    },
    [pushHistoryEntry]
  )

  // Apply a history entry in either direction. For each cell delta,
  // either set the changes-map entry directly (dirty target value) or
  // delete it and bump resetKey so EditableCell snaps back to its
  // server-side initialValue. isUndoingRef suppresses re-recording.
  const applyEntryDirection = useCallback(
    (entry: HistoryEntry, direction: 'undo' | 'redo') => {
      isUndoingRef.current = true
      try {
        setChanges((prev) => {
          const next = new Map(prev)
          for (const d of entry.cells) {
            const k = `${d.rowId}:${d.columnId}`
            const target = direction === 'undo' ? d.before : d.after
            if (target === null) next.delete(k)
            else next.set(k, target)
          }
          return next
        })
        for (const d of entry.cells) {
          const k = `${d.rowId}:${d.columnId}`
          const target = direction === 'undo' ? d.before : d.after
          const handle = editHandlers.get(k)
          if (target === null) {
            // U.39 — was setResetKeys-only, relying on the resetKey
            // prop change to flow through TableRow → cell renderer →
            // EditableCell's useEffect to revert draftValue. But
            // <TableRow> is memo'd on (row.original, rowIdx, top,
            // columnsKey) — none of which change for an undo, so
            // the row never re-renders and EditableCell never sees
            // the bumped resetKey. Cell stayed yellow with the new
            // value forever.
            // Fix: call applyValue directly with the row's canonical
            // server value (from productsRef), the same path the
            // non-null branch uses. resetKeys still bumps so any
            // virtualized-out cell that re-mounts later picks up
            // the reset.
            setResetKeys((prev) => {
              const next = new Map(prev)
              next.set(k, (next.get(k) ?? 0) + 1)
              return next
            })
            if (handle) {
              const product = productsRef.current.find(
                (p) => p.id === d.rowId,
              )
              if (product) {
                const canonical = (
                  product as unknown as Record<string, unknown>
                )[d.columnId]
                handle.applyValue(canonical)
              }
            }
          } else if (handle) {
            handle.applyValue(target.newValue)
          }
        }
        setSaveStatus((prev) =>
          prev.kind === 'saving' ? prev : { kind: 'dirty' },
        )
      } finally {
        isUndoingRef.current = false
      }
    },
    [],
  )
  const undo = useCallback(() => {
    const idx = historyIndexRef.current
    if (idx < 0) return
    applyEntryDirection(history[idx], 'undo')
    historyIndexRef.current = idx - 1
    setHistoryIndex(idx - 1)
  }, [history, applyEntryDirection])
  const redo = useCallback(() => {
    const idx = historyIndexRef.current
    if (idx >= history.length - 1) return
    applyEntryDirection(history[idx + 1], 'redo')
    historyIndexRef.current = idx + 1
    setHistoryIndex(idx + 1)
  }, [history, applyEntryDirection])
  // Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() !== 'z') return
      const ae = document.activeElement as HTMLElement | null
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable)
      ) {
        // Let the input element handle its own native undo.
        return
      }
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])
  const canUndo = historyIndex >= 0
  const canRedo = historyIndex < history.length - 1

  // Cascade-aware commit. Decides whether to write directly or open
  // the choice modal. Modal appears only when:
  //   - hierarchy or grouped display mode
  //   - target row has children (is a master with kids)
  //   - the cell isn't an aggregate (those aren't editable on parents)
  const handleCommit = useCallback(
    (rowId: string, columnId: string, newValue: unknown) => {
      const product = productsRef.current.find((p) => p.id === rowId)
      if (!product) return

      // D.3j: weight + dim cells render as text inputs ("5kg", "60cm",
      // "5,5"). Smart-parse here and route to the value column + the
      // unit column when the user typed a unit suffix. We bypass the
      // cascade modal for these — the unit change is a side effect
      // tied to the value, not a separate user-initiated edit.
      if (
        typeof newValue === 'string' &&
        (isWeightFieldId(columnId) || isDimFieldId(columnId))
      ) {
        const parsed = isWeightFieldId(columnId)
          ? parseWeight(newValue)
          : parseDimension(newValue)
        if (!parsed) {
          // Surface as a cell error — the typed text is invalid.
          const k = `${rowId}:${columnId}`
          setCellErrors((prev) => {
            const next = new Map(prev)
            next.set(
              k,
              isWeightFieldId(columnId)
                ? 'Invalid weight — try "5", "5kg" or "5.5 lb"'
                : 'Invalid dimension — try "60", "60cm" or "23.6in"',
            )
            return next
          })
          return
        }
        writeChange(rowId, columnId, parsed.value, false)
        if (parsed.unit) {
          const unitField = isWeightFieldId(columnId) ? 'weightUnit' : 'dimUnit'
          const currentUnit = (product as unknown as Record<string, unknown>)[
            unitField
          ]
          if (currentUnit !== parsed.unit) {
            writeChange(rowId, unitField, parsed.unit, false)
          }
        }
        return
      }

      const oldValue = (product as unknown as Record<string, unknown>)[columnId]

      // Quick path: revert. No modal even on parent rows.
      if (looselyEqual(newValue, oldValue)) {
        writeChange(rowId, columnId, newValue, false)
        return
      }

      const inHierarchyMode =
        displayMode === 'hierarchy' || displayMode === 'grouped'
      if (!inHierarchyMode) {
        writeChange(rowId, columnId, newValue, false)
        return
      }

      // Find children of this product
      const children = productsRef.current.filter(
        (p) => p.parentId === rowId
      )
      if (children.length === 0) {
        // Standalone or child row — no cascade choice needed
        writeChange(rowId, columnId, newValue, false)
        return
      }

      // Open modal — don't commit yet
      const fieldDef = allFieldsRef.current.find((f) => f.id === columnId)
      setCascadeModal({
        rowId,
        columnId,
        oldValue,
        newValue,
        parentSku: product.sku,
        fieldLabel: fieldDef?.label ?? columnId,
        children: children.map((c) => ({ id: c.id, sku: c.sku })),
      })
    },
    [displayMode, writeChange]
  )

  // Cascade modal handlers
  const handleCascadeApply = useCallback(
    (cascade: boolean) => {
      const m = cascadeModal
      if (!m) return
      writeChange(m.rowId, m.columnId, m.newValue, cascade)
      setCascadeModal(null)
    },
    [cascadeModal, writeChange]
  )

  const handleCascadeCancel = useCallback(() => {
    const m = cascadeModal
    if (!m) return
    // Force the cell to revert its draftValue to initialValue by bumping
    // its resetKey. The EditableCell's useEffect picks up the change.
    const key = `${m.rowId}:${m.columnId}`
    setResetKeys((prev) => {
      const next = new Map(prev)
      next.set(key, (next.get(key) ?? 0) + 1)
      return next
    })
    setCascadeModal(null)
  }, [cascadeModal])

  // Push the latest commit handler + per-cell maps into the module ref
  // so cell renderers see them. cascadeKeys derives from changesMap.
  const cascadeKeys = useMemo(() => {
    const s = new Set<string>()
    for (const [k, v] of changes) {
      if (v.cascade) s.add(k)
    }
    return s
  }, [changes])
  // P2 #5 — pendingValues derives from the same changes Map. Cells
  // that virtualised out during a paste still get their pending
  // value seeded into draftValue when they re-mount on scroll-back.
  const pendingValues = useMemo(() => {
    const m = new Map<string, unknown>()
    for (const [k, v] of changes) {
      m.set(k, (v as { value?: unknown }).value)
    }
    return m
  }, [changes])
  // Step 3.5: stable wrapper that EditableCell receives as
  // onCommitNavigate. The actual navigation function (moveSelection)
  // is defined further down in this component, so we forward through
  // a ref. The wrapper identity is stable forever, so passing it as a
  // prop never busts EditableCell's memo.
  const commitNavigateRef = useRef<(dRow: number, dCol: number) => void>(
    () => {},
  )
  const onCommitNavigate = useCallback((dRow: number, dCol: number) => {
    commitNavigateRef.current(dRow, dCol)
  }, [])

  editCtxRef.current = {
    onCommit: handleCommit,
    cellErrors,
    resetKeys,
    cascadeKeys,
    pendingValues,
    onCommitNavigate,
  }
  allFieldsRef.current = allFields

  // ── Save flow ──────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    const currentChanges = changesRef.current
    if (currentChanges.size === 0) return
    if (saveStatus.kind === 'saving') return

    setSaveStatus({ kind: 'saving' })
    setCellErrors(new Map())

    const changesArray = Array.from(currentChanges.values()).map((c) => ({
      id: c.rowId,
      field: c.columnId,
      value: c.newValue,
      cascade: c.cascade,
    }))

    // R.1 — body carries `marketplaceContexts` (plural) so the backend
    // can fan out channel-field upserts to every selected target.
    // `marketplaceContext` (singular) is kept as the first entry for
    // backwards compatibility with any older API code paths.
    const body: any = { changes: changesArray }
    if (marketplaceTargets.length > 0) {
      body.marketplaceContexts = marketplaceTargets
      body.marketplaceContext = marketplaceTargets[0]
    }

    try {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const result = (await res.json().catch(() => ({}))) as {
        success?: boolean
        updated?: number
        errors?: ApiError[]
        error?: string
        message?: string
      }

      if (!res.ok) {
        setSaveStatus({
          kind: 'error',
          message: result.error ?? result.message ?? `HTTP ${res.status}`,
        })
        if (Array.isArray(result.errors)) {
          const map = new Map<string, string>()
          for (const e of result.errors) {
            map.set(`${e.id}:${e.field}`, e.error)
          }
          setCellErrors(map)
        }
        return
      }

      const errs: ApiError[] = result.errors ?? []
      const failedKeys = new Set(errs.map((e) => `${e.id}:${e.field}`))
      const succeededChanges = changesArray.filter(
        (c) => !failedKeys.has(`${c.id}:${c.field}`)
      )

      if (succeededChanges.length > 0) {
        setProducts((prev) =>
          produce(prev, (draft) => {
            for (const c of succeededChanges) {
              const product = draft.find((p) => p.id === c.id)
              if (!product) continue
              if (c.field.startsWith('amazon_') || c.field.startsWith('ebay_')) {
                // Channel field — value lives under _channelListing.<stripped>
                const stripped = c.field.replace(/^(amazon|ebay)_/, '')
                if (!(product as any)._channelListing) {
                  ;(product as any)._channelListing = {
                    title: null,
                    description: null,
                    price: null,
                    quantity: null,
                    listingStatus: 'DRAFT',
                  }
                }
                ;((product as any)._channelListing as Record<string, unknown>)[stripped] = c.value
              } else if (c.field.startsWith('attr_')) {
                // Category-attribute field — merge into categoryAttributes
                // mirroring the backend's atomic jsonb || merge.
                const stripped = c.field.replace(/^attr_/, '')
                if (!product.categoryAttributes) {
                  product.categoryAttributes = {}
                }
                ;(product.categoryAttributes as Record<string, unknown>)[stripped] = c.value
              } else {
                ;(product as unknown as Record<string, unknown>)[c.field] = c.value
              }
            }
          })
        )
      }

      setChanges((prev) => {
        if (succeededChanges.length === 0) return prev
        const next = new Map(prev)
        for (const c of succeededChanges) {
          next.delete(`${c.id}:${c.field}`)
        }
        return next
      })

      // D.3j: weight + dim cells edit-mode held the user's raw text
      // ("5kg") but the canonical post-save value is the plain number
      // (5). Bump resetKey for those cells so EditableCell resets its
      // local draft to the new initialValue and isDirty clears.
      if (succeededChanges.length > 0) {
        const reseedFields = new Set([
          'weightValue',
          'dimLength',
          'dimWidth',
          'dimHeight',
        ])
        const reseed = succeededChanges.filter((c) =>
          reseedFields.has(c.field),
        )
        if (reseed.length > 0) {
          setResetKeys((prev) => {
            const next = new Map(prev)
            for (const c of reseed) {
              const k = `${c.id}:${c.field}`
              next.set(k, (next.get(k) ?? 0) + 1)
            }
            return next
          })
        }
      }

      if (errs.length > 0) {
        const map = new Map<string, string>()
        for (const e of errs) {
          map.set(`${e.id}:${e.field}`, e.error)
        }
        setCellErrors(map)
        setSaveStatus({
          kind: 'partial',
          saved: succeededChanges.length,
          failed: errs.length,
        })
      } else {
        setSaveStatus({
          kind: 'saved',
          count: succeededChanges.length,
          at: Date.now(),
        })
        setTimeout(() => {
          setSaveStatus((s) => (s.kind === 'saved' ? { kind: 'idle' } : s))
        }, 3000)
      }

      // Phase 10 — broadcast so /products, /listings, /catalog/organize
      // open in other tabs refresh within ~200ms. The bulk PATCH can
      // touch master fields (basePrice, totalStock — routed through
      // MasterPriceService / applyStockMovement in 13d) AND channel
      // fields (amazon_title, ebay_description) so we emit both
      // product.updated and listing.updated.
      if (succeededChanges.length > 0) {
        const productIds = Array.from(new Set(succeededChanges.map((c) => c.id)))
        const touchedChannelFields = succeededChanges.some(
          (c) => c.field.startsWith('amazon_') || c.field.startsWith('ebay_'),
        )
        const touchedMasterFields = succeededChanges.some(
          (c) => !c.field.startsWith('amazon_') && !c.field.startsWith('ebay_') && !c.field.startsWith('attr_'),
        )
        if (touchedMasterFields) {
          emitInvalidation({
            type: 'product.updated',
            meta: { productIds, count: productIds.length, source: 'bulk-grid' },
          })
        }
        if (touchedChannelFields) {
          emitInvalidation({
            type: 'listing.updated',
            meta: { productIds, count: productIds.length, source: 'bulk-grid' },
          })
        }
      }
      // D.6.3: changes successfully sent to the backend can no longer
      // be undone via the local history stack — clear it so the
      // toolbar buttons disable and Cmd+Z is a no-op until the user
      // makes new edits.
      if (succeededChanges.length > 0) {
        setHistory([])
        setHistoryIndex(-1)
        historyIndexRef.current = -1
      }
    } catch (err: any) {
      setSaveStatus({ kind: 'error', message: err?.message ?? String(err) })
    }
  }, [saveStatus.kind, marketplaceTargets])

  // Cmd/Ctrl+S
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleSave])

  // ── Step 3: copy flash state ────────────────────────────────────
  // The copy listener itself is registered further down (after the
  // table is declared) — this state lives up here so the StatusBar
  // and the copyCtxRef both see it.
  const [copyFlash, setCopyFlash] = useState<{
    count: number
    at: number
  } | null>(null)

  // ── Initial fetch (products + fields + marketplaces in parallel) ──
  useEffect(() => {
    let cancelled = false
    const start = performance.now()
    const backend = getBackendUrl()
    Promise.all([
      fetch(`${backend}/api/products/bulk-fetch`, { cache: 'no-store' }).then(
        async (res) => {
          if (!res.ok) throw new Error(`products: HTTP ${res.status}`)
          return res.json()
        }
      ),
      fetch(`${backend}/api/pim/fields`, { cache: 'no-store' }).then(
        async (res) => {
          if (!res.ok) throw new Error(`fields: HTTP ${res.status}`)
          return res.json()
        }
      ),
      fetch(`${backend}/api/marketplaces/grouped`, { cache: 'no-store' }).then(
        async (res) => (res.ok ? res.json() : {})
      ),
    ])
      .then(([productsData, fieldsData, marketplacesData]) => {
        if (cancelled) return
        setProducts(
          Array.isArray(productsData.products) ? productsData.products : []
        )
        setAllFields(Array.isArray(fieldsData.fields) ? fieldsData.fields : [])
        // Flatten marketplaces grouped object → flat options for the
        // selector, scoped to channels we care about.
        const opts: MarketplaceOption[] = []
        for (const ch of ['AMAZON', 'EBAY'] as const) {
          const list = (marketplacesData?.[ch] ?? []) as Array<any>
          for (const m of list) {
            opts.push({
              channel: ch,
              code: m.code,
              name: m.name,
              currency: m.currency,
              language: m.language,
            })
          }
        }
        setMarketplaceOptions(opts)
        setFetchMs(Math.round(performance.now() - start))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message ?? String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // P.9 — read productIds from the URL so the /products page's
  // bulk-action bar ("Power edit") can deep-link with a pre-selected
  // scope. Empty / missing param = full catalog (existing behaviour).
  // The list is derived during render (no useState) so a router push
  // that changes the param re-runs the reload effect immediately.
  const searchParams = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const scopedProductIds = useMemo(() => {
    const raw = searchParams.get('productIds') ?? ''
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }, [searchParams])
  const scopedProductIdsKey = scopedProductIds.join(',')
  const isScoped = scopedProductIds.length > 0

  const clearScope = useCallback(() => {
    const sp = new URLSearchParams(searchParams.toString())
    sp.delete('productIds')
    const qs = sp.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }, [router, pathname, searchParams])

  // Refetch products when the primary target changes — bulk-fetch
  // hydrates _channelListing for ONE (channel, marketplace) per row,
  // so the table view always reflects the first selected target.
  // Edits still fan out to every target via marketplaceContexts.
  const reloadProducts = useCallback(() => {
    const params = new URLSearchParams()
    if (primaryContext) {
      params.set('channel', primaryContext.channel)
      params.set('marketplace', primaryContext.marketplace)
    }
    if (scopedProductIdsKey) {
      params.set('productIds', scopedProductIdsKey)
    }
    const qs = params.toString()
    return fetch(
      `${getBackendUrl()}/api/products/bulk-fetch${qs ? `?${qs}` : ''}`,
      { cache: 'no-store' },
    )
      .then(async (res) => (res.ok ? res.json() : { products: [] }))
      .then((data) => {
        setProducts(Array.isArray(data.products) ? data.products : [])
      })
      .catch(() => {})
  }, [primaryContext?.channel, primaryContext?.marketplace, scopedProductIdsKey])
  useEffect(() => {
    reloadProducts()
  }, [reloadProducts])

  // Phase 10 — listen for invalidations from other pages / tabs.
  // /products inline edit, /catalog/organize attach, a wizard
  // submission — any of these can change rows visible in the
  // bulk-ops grid; when they do, refetch within ~200ms (debounced).
  useInvalidationChannel(
    [
      'product.updated',
      'product.created',
      'product.deleted',
      'listing.updated',
      'listing.created',
      'wizard.submitted',
      'pim.changed',
      'bulk-job.completed',
    ],
    () => {
      reloadProducts()
    },
  )

  // T.4 — row-level actions wired through actionsCtxRef so the cells
  // in dynamicColumns can stay memoised (the ref's identity doesn't
  // change between renders, only its `.current` payload).
  const handleDeleteRow = useCallback(
    async (id: string, sku: string, isParent: boolean) => {
      const cascadeWarning = isParent
        ? '\n\nThis is a master product. Every variant + ChannelListing + image row underneath will also be deleted. Cannot be undone.'
        : '\n\nIts ChannelListings + offers + image rows will also be deleted. Cannot be undone.'
      if (!(await askConfirm({ title: `Delete ${sku}?`, description: cascadeWarning.trim(), confirmLabel: 'Delete', tone: 'danger' }))) return
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/catalog/products/${id}`,
          { method: 'DELETE' },
        )
        const json = await res.json().catch(() => ({}))
        if (!res.ok) {
          throw new Error(json?.error?.message ?? `HTTP ${res.status}`)
        }
        // Optimistic local update — drop the row + any of its
        // children so the grid reflects the cascade immediately.
        setProducts((prev) =>
          prev.filter((p) => p.id !== id && p.parentId !== id),
        )
      } catch (e) {
        setSaveStatus({
          kind: 'error',
          message: e instanceof Error ? e.message : String(e),
        })
      }
    },
    [askConfirm],
  )
  actionsCtxRef.current = { onDelete: handleDeleteRow }

  // U.2 — batch delete. Reads the active selection rectangle, derives
  // the unique product ids in its row range, fires DELETE in parallel.
  // Confirms with row count + a master-cascade warning when any
  // selected row is a parent. Local state drops rows + any child whose
  // parentId matches a deleted id (mirrors handleDeleteRow's cascade).
  const handleBatchDelete = useCallback(async () => {
    const rb = rangeBoundsRef.current
    if (!rb) return
    const rowModel = tableRef.current.getRowModel().rows
    const selected: Array<{ id: string; sku: string; isParent: boolean }> = []
    for (let r = rb.minRow; r <= rb.maxRow; r++) {
      const row = rowModel[r]
      if (!row) continue
      selected.push({
        id: row.original.id,
        sku: row.original.sku,
        isParent: !!row.original.isParent,
      })
    }
    if (selected.length === 0) return
    const parentCount = selected.filter((s) => s.isParent).length
    const cascadeNote =
      parentCount > 0
        ? `\n\n${parentCount} master product${
            parentCount === 1 ? ' is' : 's are'
          } in the selection — every variant + ChannelListing + image row underneath will cascade. Cannot be undone.`
        : '\n\nChannelListings + offers + image rows for each row will also be deleted. Cannot be undone.'
    if (!(await askConfirm({ title: `Delete ${selected.length} row${selected.length === 1 ? '' : 's'}?`, description: cascadeNote.trim(), confirmLabel: 'Delete', tone: 'danger' }))) return
    setSaveStatus({ kind: 'saving' })
    const failures: string[] = []
    await Promise.all(
      selected.map(async (s) => {
        try {
          const res = await fetch(
            `${getBackendUrl()}/api/catalog/products/${s.id}`,
            { method: 'DELETE' },
          )
          if (!res.ok) {
            const j = await res.json().catch(() => ({}))
            failures.push(s.sku + ': ' + (j?.error?.message ?? `HTTP ${res.status}`))
          }
        } catch (e) {
          failures.push(s.sku + ': ' + (e instanceof Error ? e.message : String(e)))
        }
      }),
    )
    const deletedIds = new Set(selected.map((s) => s.id))
    setProducts((prev) =>
      prev.filter((p) => !deletedIds.has(p.id) && !deletedIds.has(p.parentId ?? '')),
    )
    if (failures.length === 0) {
      setSaveStatus({ kind: 'saved', count: selected.length, at: Date.now() })
      window.setTimeout(() => {
        setSaveStatus((s) => (s.kind === 'saved' ? { kind: 'idle' } : s))
      }, 2000)
    } else {
      setSaveStatus({
        kind: 'error',
        message: `${selected.length - failures.length} deleted, ${failures.length} failed: ${failures.slice(0, 3).join('; ')}`,
      })
    }
  }, [askConfirm])

  // Selected-row count derived from the active selection rectangle —
  // drives whether the "Delete N rows" toolbar button appears.
  const selectedRowCount = useMemo(() => {
    if (!rangeBounds) return 0
    return rangeBounds.maxRow - rangeBounds.minRow + 1
  }, [rangeBounds])

  // T.2 — productTypes seen in the loaded products. Drives the fields
  // fetch so every visible product's required + optional schema
  // attributes land as columns automatically — without the user
  // having to enable channels / productTypes manually first.
  // enabledProductTypes (user-controlled) still drives column visibility,
  // not what's fetched.
  const productTypesInData = useMemo(() => {
    const set = new Set<string>()
    for (const p of products) {
      const t = (p.productType ?? '').trim()
      if (t) set.add(t)
    }
    return Array.from(set).sort()
  }, [products])

  // AA.2 — eBay categoryIds present in the active context's listings.
  // Each product's _channelListing.platformAttributes.productType is
  // the per-listing eBay categoryId (set when the user picks one in
  // the per-product editor's eBay tab). When the active marketplace
  // tab is eBay, we feed these into /api/pim/fields so the registry
  // pulls cached aspects per categoryId and surfaces them as columns.
  const ebayCategoryIdsInData = useMemo(() => {
    if (primaryContext?.channel !== 'EBAY') return [] as string[]
    const set = new Set<string>()
    for (const p of products) {
      const cl = (p as any)._channelListing
      const pa = cl?.platformAttributes
      if (pa && typeof pa === 'object' && typeof pa.productType === 'string') {
        const id = pa.productType.trim()
        if (id) set.add(id)
      }
    }
    return Array.from(set).sort()
  }, [products, primaryContext?.channel])

  // U.1 — pre-warm CategorySchema for productTypes seen in the data.
  // T.2's field-registry call only reads CACHED schemas, so a
  // productType that's never been visited (per-product editor
  // marketplace tab, etc.) won't surface its dynamic attr_* fields
  // in the bulk grid. Here we hit the per-product schema endpoint
  // for one representative product per productType — getSchema()
  // server-side fetches from SP-API on cache miss, then subsequent
  // /api/pim/fields calls pick up the warm cache.
  // Tracks completed (productType, marketplace) pairs in a ref so
  // re-rendering doesn't duplicate fetches.
  const prewarmedRef = useRef<Set<string>>(new Set())
  const [schemaWarmth, setSchemaWarmth] = useState(0)
  useEffect(() => {
    if (productTypesInData.length === 0 || products.length === 0) return
    const marketplace = primaryContext?.marketplace ?? 'IT'
    const channel = primaryContext?.channel ?? 'AMAZON'
    if (channel !== 'AMAZON') return // schema cache only matters for Amazon
    const todo: Array<{ productId: string; productType: string }> = []
    for (const pt of productTypesInData) {
      const key = `${marketplace}:${pt}`
      if (prewarmedRef.current.has(key)) continue
      const rep = products.find((p) => p.productType === pt)
      if (!rep) continue
      todo.push({ productId: rep.id, productType: pt })
      prewarmedRef.current.add(key)
    }
    if (todo.length === 0) return
    let cancelled = false
    Promise.all(
      todo.map((t) =>
        fetch(
          `${getBackendUrl()}/api/products/${t.productId}/listings/AMAZON/${marketplace}/schema?all=1`,
          { cache: 'no-store' },
        ).catch(() => null),
      ),
    ).then(() => {
      if (cancelled) return
      // Bump the warmth counter — drives a refetch of /api/pim/fields
      // so the freshly cached schemas land as columns.
      setSchemaWarmth((v) => v + 1)
    })
    return () => {
      cancelled = true
    }
  }, [productTypesInData, products, primaryContext?.marketplace, primaryContext?.channel])

  // BB.1 — pre-warm eBay aspect cache for visible categoryIds.
  // /api/pim/fields is cache-only on its eBay branch (so cold ids
  // don't block page load); we hit /api/pim/ebay-prewarm out-of-
  // band to populate the cache, then bump schemaWarmth so the
  // existing /api/pim/fields effect re-fetches and sees the warmed
  // entries. Tracked via prewarmedEbayRef to avoid duplicate fetches
  // across re-renders.
  const prewarmedEbayRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (
      primaryContext?.channel !== 'EBAY' ||
      ebayCategoryIdsInData.length === 0 ||
      !primaryContext.marketplace
    ) {
      return
    }
    const marketplace = primaryContext.marketplace
    const todo: string[] = []
    for (const id of ebayCategoryIdsInData) {
      const key = `${marketplace}:${id}`
      if (prewarmedEbayRef.current.has(key)) continue
      todo.push(id)
      prewarmedEbayRef.current.add(key)
    }
    if (todo.length === 0) return
    let cancelled = false
    fetch(`${getBackendUrl()}/api/pim/ebay-prewarm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketplace, categoryIds: todo }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then(() => {
        if (cancelled) return
        setSchemaWarmth((v) => v + 1)
      })
      .catch(() => {
        /* swallow — cache stays cold; user can hit Refresh in the
         * picker / per-product editor to manually warm */
      })
    return () => {
      cancelled = true
    }
  }, [ebayCategoryIdsInData, primaryContext?.channel, primaryContext?.marketplace])

  // Refetch fields when channels/productTypes/marketplace change.
  // D.3g: passing `marketplace` lets the backend pull live category
  // attributes from cached Amazon schemas (CategorySchema). Without
  // it we get the static fallback set only.
  // T.2 — always include the productTypes seen in data so the dynamic-
  // fields branch in field-registry runs and surfaces every cached
  // schema attribute as an attr_* column.
  // V.7 — also include the active marketplace tab's channel
  // (primaryContext.channel) so EBAY fields surface when on an EBAY
  // tab. Defaults to AMAZON when no tab is picked (most common case).
  useEffect(() => {
    const params = new URLSearchParams()
    const channels = new Set<string>(enabledChannels)
    // The currently-active marketplace tab drives which channel's
    // static set + dynamic schema gets pulled. Without a tab, fall
    // back to AMAZON because the registry's dynamic loader is
    // Amazon-only (eBay's CategorySchema pipeline isn't built yet).
    if (primaryContext?.channel) channels.add(primaryContext.channel)
    if (productTypesInData.length > 0 && channels.size === 0) {
      channels.add('AMAZON')
    }
    if (channels.size > 0) params.set('channels', Array.from(channels).join(','))
    // Union of user-enabled types + types actually in the data.
    const typeUnion = Array.from(
      new Set([...enabledProductTypes, ...productTypesInData]),
    )
    if (typeUnion.length > 0) params.set('productTypes', typeUnion.join(','))
    params.set(
      'marketplace',
      primaryContext?.marketplace ?? 'IT',
    )
    // AA.2 — eBay categoryIds from the loaded listings drive the
    // dynamic eBay aspect columns. Only set when on an eBay tab.
    if (ebayCategoryIdsInData.length > 0) {
      params.set('ebayCategoryIds', ebayCategoryIdsInData.join(','))
    }
    const qs = params.toString()
    const url = `${getBackendUrl()}/api/pim/fields${qs ? `?${qs}` : ''}`

    let cancelled = false
    fetch(url, { cache: 'no-store' })
      .then(async (res) => (res.ok ? res.json() : { fields: [] }))
      .then((data) => {
        if (cancelled) return
        setAllFields(Array.isArray(data.fields) ? data.fields : [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [
    enabledChannels,
    enabledProductTypes,
    productTypesInData,
    ebayCategoryIdsInData,
    primaryContext?.channel,
    primaryContext?.marketplace,
    schemaWarmth,
  ])

  // EE.1 / KK — auto-include channel-specific + schema attr_* columns
  // the first time the user lands on a given (channel, marketplace),
  // AND reorder the visible set into the channel's natural shelf
  // order (Amazon Seller Central / eBay Seller Hub style). Without the
  // reorder, eBay landed with [sku, name, brand, …, ebay_title,
  // ebayItemId] which doesn't match users' mental model. Now we
  // produce [sku, ebay_title, ebayItemId, productType, …] for eBay
  // and [sku, amazon_title, amazonAsin, productType, …] for Amazon.
  // The reorder runs ONCE per (channel, marketplace) per session — if
  // the user drags a column afterwards, we don't clobber their layout.
  const autoLoadedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!primaryContext) return
    if (allFields.length === 0) return
    // KK.2 — bail when an explicit view was loaded; the view's column
    // order is the user's deliberate choice and we don't get to
    // override it on subsequent tab switches.
    if (autoLoadedRef.current.has('__view_loaded__')) return
    const tabKey = `${primaryContext.channel}:${primaryContext.marketplace}`
    if (autoLoadedRef.current.has(tabKey)) return
    const missing = allFields.filter((f) => {
      if (visibleColumnIds.includes(f.id)) return false
      if (f.id.startsWith('attr_')) return true
      if (f.channel === primaryContext.channel) return true
      return false
    })
    autoLoadedRef.current.add(tabKey)
    setVisibleColumnIds((prev) => {
      const merged = [...prev, ...missing.map((f) => f.id)]
      return applyChannelDefaultOrder(
        merged,
        primaryContext.channel,
        allFields,
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allFields, primaryContext?.channel, primaryContext?.marketplace])


  // ── Build columns dynamically from registry + visibility ──────────
  const fieldsById = useMemo(() => {
    const m = new Map<string, FieldDef>()
    for (const f of allFields) m.set(f.id, f)
    return m
  }, [allFields])
  fieldsByIdRef.current = fieldsById

  // T.3 — bucket visible fields by group so the band can render colour
  // chips above the column headers. Order is preserved (the buckets
  // come out in the order they're first hit), so user-driven column
  // ordering carries through to the band.
  // V.1 — read user-resized column widths off `columnSizing` so the
  // band chips track the columns underneath in real time. Falls back
  // to the registry default (`field.width ?? 120`) when the user
  // hasn't dragged that column.
  const groupedFields = useMemo(() => {
    const result: Array<{
      key: string
      label: string
      fields: FieldDef[]
      size: number
    }> = []
    const byKey = new Map<string, (typeof result)[number]>()
    for (const id of visibleColumnIds) {
      const field = fieldsById.get(id)
      if (!field) continue
      const key = groupKeyForField(field)
      const label = GROUP_LABEL[key] ?? key
      let bucket = byKey.get(key)
      if (!bucket) {
        bucket = { key, label, fields: [], size: 0 }
        byKey.set(key, bucket)
        result.push(bucket)
      }
      bucket.fields.push(field)
      const userSized = columnSizing[id]
      bucket.size +=
        typeof userSized === 'number' ? userSized : field.width ?? 120
    }
    return result
  }, [visibleColumnIds, fieldsById, columnSizing])

  // KK.2 — prune collapsedGroups when the registry changes. Without
  // this, group keys from a previous catalog (e.g. 'old_category')
  // sit in the Set forever, leaking into localStorage and never
  // matching a real group. We diff against current groupedFields and
  // drop anything that no longer corresponds to a visible bucket.
  useEffect(() => {
    if (collapsedGroups.size === 0) return
    const validKeys = new Set(groupedFields.map((g) => g.key))
    let pruned = false
    const next = new Set<string>()
    for (const k of collapsedGroups) {
      if (validKeys.has(k)) {
        next.add(k)
      } else {
        pruned = true
      }
    }
    if (pruned) setCollapsedGroups(next)
  }, [groupedFields, collapsedGroups])

  // JJ / LL — per-column tone lookup. Includes one entry per real
  // visible column AND one synthetic entry per placeholder column
  // (LL — collapsed groups now keep a single placeholder column so
  // the layout, selection rectangle, drag/drop, and band alignment
  // never have to handle a "this group has zero columns" branch).
  const columnTones = useMemo(() => {
    const m = new Map<string, ColumnTone>()
    for (const g of groupedFields) {
      const tone = GROUP_TONE[g.key] ?? NEUTRAL_TONE
      if (collapsedGroups.has(g.key)) {
        m.set(collapsedColumnId(g.key), {
          band: tone.band,
          text: tone.text,
          cell: tone.cell,
          isGroupEdge: true,
        })
        continue
      }
      g.fields.forEach((f, i) => {
        m.set(f.id, {
          band: tone.band,
          text: tone.text,
          cell: tone.cell,
          isGroupEdge: i === g.fields.length - 1,
        })
      })
    }
    return m
  }, [groupedFields, collapsedGroups])
  columnTonesRef.current = columnTones

  const dynamicColumns = useMemo<ColumnDef<BulkProduct>[]>(() => {
    const out: ColumnDef<BulkProduct>[] = []
    for (const g of groupedFields) {
      // LL — collapsed groups render as ONE placeholder column with
      // the group's tone + a count badge. Keeping a single column
      // (instead of vanishing N columns) means: column count stays
      // stable across collapse/expand, selection-rect indices don't
      // shift, drag/drop hit zones stay aligned, and band-chip
      // widths track 1:1 with the dynamic columns underneath.
      // Click the placeholder header to expand the group again.
      if (collapsedGroups.has(g.key)) {
        const tone = GROUP_TONE[g.key] ?? NEUTRAL_TONE
        const groupKey = g.key
        const groupLabel = g.label
        const fieldCount = g.fields.length
        out.push({
          id: collapsedColumnId(groupKey),
          size: COLLAPSED_COL_WIDTH,
          enableResizing: false,
          header: () => (
            <button
              type="button"
              onClick={() => toggleGroupCollapse(groupKey)}
              title={`Expand ${groupLabel} (${fieldCount} field${
                fieldCount === 1 ? '' : 's'
              })`}
              className="flex items-center gap-1 px-1 w-full text-left"
            >
              <ChevronRight className="w-3 h-3 flex-shrink-0" />
              <span className="truncate normal-case font-semibold text-xs">
                {groupLabel}
              </span>
              <span className="ml-auto text-xs tabular-nums opacity-60">
                {fieldCount}
              </span>
            </button>
          ),
          cell: () => (
            <div
              className={cn(
                'h-full flex items-center justify-center text-sm italic select-none',
                tone.text,
              )}
              aria-hidden="true"
            >
              ⋯
            </div>
          ),
          meta: { collapsedGroupKey: groupKey },
        } as ColumnDef<BulkProduct>)
        continue
      }
      for (const field of g.fields) {
        out.push(buildColumnFromField(field))
      }
    }
    // T.4 — actions column always anchors the right edge. W.3 sets
    // size to defaultColumn.minSize so TanStack doesn't clamp it
    // (and the band's spacer matches at 60).
    out.push({
      id: '__actions',
      header: '',
      size: 60,
      cell: ({ row }) => (
        <DeleteRowButton
          id={row.original.id}
          sku={row.original.sku}
          isParent={!!row.original.isParent}
        />
      ),
    } as ColumnDef<BulkProduct>)
    return out
  }, [groupedFields, collapsedGroups])

  // Bumped whenever the column set actually changes; passed to TableRow
  // so memoized rows know to re-render on column changes. We use a
  // stable string key — when it changes, the memo comparator sees a
  // different value and re-runs.
  // Include columnSizing in the fingerprint so a header drag also
  // re-renders TableRow (whose memo comparator otherwise sees no
  // change in props and keeps the body cells at the old widths).
  // KK — include collapsedGroups in the fingerprint. Without this the
  // memoised TableRow comparator returned true after a collapse
  // toggle (visibleColumnIds + columnSizing didn't change), and rows
  // kept rendering cells from the now-hidden columns. Now any collapse
  // change forces a row re-render so the body matches dynamicColumns.
  const columnsKey = useMemo(
    () =>
      `${visibleColumnIds.join('|')}#${JSON.stringify(
        columnSizing,
      )}#${Array.from(collapsedGroups).sort().join(',')}`,
    [visibleColumnIds, columnSizing, collapsedGroups],
  )

  const tableMinWidth = useMemo(
    () => dynamicColumns.reduce((sum, c) => sum + (c.size ?? 120), 0),
    [dynamicColumns]
  )

  // ── D.6: Search + filter ─────────────────────────────────────────
  // Search runs against the raw products array first, then we feed
  // the filtered set into the existing hierarchy builder. This means
  // a parent whose children all get filtered out simply vanishes
  // from hierarchy view — same as filtering in any spreadsheet.
  // T.5 — required-field set used by the missingRequired filter.
  // Computed once per allFields change; filters by `required: true`.
  const requiredFieldIds = useMemo(() => {
    const out: string[] = []
    for (const f of allFields) {
      if (f.required && f.editable) out.push(f.id)
    }
    return out
  }, [allFields])

  const filteredProducts = useMemo(() => {
    let pool = products
    if (filterState.status.length > 0) {
      const statuses = new Set(filterState.status)
      pool = pool.filter((p) => statuses.has(p.status))
    }
    if (filterState.channels.length > 0) {
      const channels = new Set(filterState.channels)
      pool = pool.filter((p) =>
        (p.syncChannels ?? []).some((c) => channels.has(c)),
      )
    }
    if (filterState.stockLevel !== 'all') {
      pool = pool.filter((p) => {
        const stock = p.totalStock ?? 0
        if (filterState.stockLevel === 'out') return stock === 0
        if (filterState.stockLevel === 'low') return stock > 0 && stock <= 5
        if (filterState.stockLevel === 'in') return stock > 0
        return true
      })
    }
    if (filterState.productTypes.length > 0) {
      const types = new Set(filterState.productTypes)
      pool = pool.filter((p) => p.productType && types.has(p.productType))
    }
    if (filterState.parentage !== 'any') {
      pool = pool.filter((p) =>
        filterState.parentage === 'parent'
          ? p.isParent === true || p.parentId === null
          : p.parentId !== null,
      )
    }
    if (filterState.hasAsin !== 'any') {
      const want = filterState.hasAsin === 'yes'
      pool = pool.filter((p) => !!p.amazonAsin === want)
    }
    if (filterState.hasGtin !== 'any') {
      const want = filterState.hasGtin === 'yes'
      pool = pool.filter((p) => {
        const has = !!(p.gtin || p.upc || p.ean)
        return has === want
      })
    }
    if (filterState.missingRequired && requiredFieldIds.length > 0) {
      pool = pool.filter((p) => {
        for (const id of requiredFieldIds) {
          if (id.startsWith('attr_')) {
            const stripped = id.replace(/^attr_/, '')
            const v = (p.categoryAttributes as Record<string, unknown> | null)?.[
              stripped
            ]
            if (v === null || v === undefined || v === '') return true
          } else {
            const v = (p as Record<string, unknown>)[id]
            if (v === null || v === undefined || v === '') return true
          }
        }
        return false
      })
    }
    const q = debouncedSearch.trim().toLowerCase()
    if (q) {
      pool = pool.filter((p) => {
        if (p.sku?.toLowerCase().includes(q)) return true
        if (p.name?.toLowerCase().includes(q)) return true
        if (p.brand?.toLowerCase().includes(q)) return true
        return false
      })
    }
    return pool
  }, [products, debouncedSearch, filterState, requiredFieldIds])

  // Build display rows based on mode
  const displayRows = useMemo(() => {
    if (displayMode !== 'hierarchy') return filteredProducts
    return buildHierarchy(filteredProducts, expandedParents)
  }, [filteredProducts, displayMode, expandedParents])

  const table = useReactTable({
    data: displayRows as BulkProduct[],
    columns: dynamicColumns,
    getCoreRowModel: getCoreRowModel(),
    // Stable row id keyed off the product id (NOT row position).
    // Without this, collapsing a parent in hierarchy mode shrinks
    // the visible-rows array and React reconciles by position —
    // <TableRow key="3"> at position 3 maps to a different product
    // after the collapse, but its child EditableCell components
    // keep their draftValue state, leaking the previous row's
    // SKU / title into the new one with a yellow dirty tint.
    getRowId: (row) => row.id,
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    state: { columnSizing },
    onColumnSizingChange: setColumnSizing,
    defaultColumn: { minSize: 60, maxSize: 600 },
  })

  const rows = table.getRowModel().rows

  // Mirror table on a ref so the keydown / requestEdit paths read
  // the latest visible-leaf-columns + row model without depending on
  // a particular render's closure.
  const tableRef = useRef(table)
  tableRef.current = table

  // ── Step 3.5: imperative edit + global keyboard nav ─────────────
  // Resolve a (rowIdx, colIdx) selection coord to its real row+column
  // ids and dispatch the edit handler that the EditableCell at those
  // coords registered. Read-only / parent-aggregate cells silently
  // skip — they won't have a registered handler.
  const requestEditAt = useCallback(
    (rowIdx: number, colIdx: number, prefill?: string) => {
      const tbl = tableRef.current
      const row = tbl.getRowModel().rows[rowIdx]
      const col = tbl.getVisibleLeafColumns()[colIdx]
      if (!row || !col) return
      const handle = editHandlers.get(editKey(row.original.id, col.id))
      handle?.enterEdit(prefill)
    },
    [],
  )
  // Move/extend selection by a delta, clamped to the data bounds.
  // Used by Tab / Shift+Tab / arrow keys.
  const moveSelection = useCallback(
    (dRow: number, dCol: number, extend: boolean) => {
      const tbl = tableRef.current
      const rowCount = tbl.getRowModel().rows.length
      const colCount = tbl.getVisibleLeafColumns().length
      if (rowCount === 0 || colCount === 0) return
      setSelection((curr) => {
        const baseAnchor = curr.anchor ?? { rowIdx: 0, colIdx: 0 }
        const baseActive = curr.active ?? baseAnchor
        const nextActive = {
          rowIdx: Math.min(
            Math.max(baseActive.rowIdx + dRow, 0),
            rowCount - 1,
          ),
          colIdx: Math.min(
            Math.max(baseActive.colIdx + dCol, 0),
            colCount - 1,
          ),
        }
        return extend
          ? { anchor: baseAnchor, active: nextActive }
          : { anchor: nextActive, active: nextActive }
      })
    },
    [],
  )
  // Wire the forward ref now that moveSelection exists. EditableCell
  // calls this on Enter / Tab inside the input — Excel semantics:
  // commit + move selection.
  commitNavigateRef.current = (dRow, dCol) => moveSelection(dRow, dCol, false)

  // ── Step 5: drag-fill (Excel autofill) ──────────────────────────
  // The handle on the bottom-right of the selection rectangle starts
  // a fill drag. As the cursor moves we update fillState.target; on
  // mouseup we compute the extension, generate fill values per the
  // detected pattern (linear numeric or cyclic), apply via writeChange
  // + applyValue, and expand the selection over the source + filled
  // region. Escape cancels mid-drag with no changes.
  const commitFill = useCallback(
    (state: FillState) => {
      const ext = computeFillExtension(state.source, state.target)
      if (!ext) return
      const tbl = tableRef.current
      const tableRows = tbl.getRowModel().rows
      const cols = tbl.getVisibleLeafColumns()
      const allFields = allFieldsRef.current
      let appliedAny = false
      // D.6.3: drag-fill is one user action — collect deltas into a
      // single history entry so Cmd+Z reverts the whole fill.
      const batch: HistoryDelta[] = []
      for (let r = ext.minRow; r <= ext.maxRow; r++) {
        const row = tableRows[r]
        if (!row) continue
        for (let c = ext.minCol; c <= ext.maxCol; c++) {
          const col = cols[c]
          if (!col) continue
          const fieldDef = allFields.find((f) => f.id === col.id)
          if (!fieldDef?.editable) continue
          const v = computeFillValue(state.source, ext, {
            rowIdx: r,
            colIdx: c,
          }, tableRows, cols)
          if (v === undefined) continue
          editHandlers
            .get(editKey(row.original.id, col.id))
            ?.applyValue(v)
          writeChange(row.original.id, col.id, v, false, batch)
          appliedAny = true
        }
      }
      if (batch.length > 0) {
        pushHistoryEntry({ cells: batch, timestamp: Date.now() })
      }
      if (appliedAny) {
        setSelection({
          anchor: {
            rowIdx: Math.min(state.source.minRow, ext.minRow),
            colIdx: Math.min(state.source.minCol, ext.minCol),
          },
          active: {
            rowIdx: Math.max(state.source.maxRow, ext.maxRow),
            colIdx: Math.max(state.source.maxCol, ext.maxCol),
          },
        })
      }
    },
    [writeChange, pushHistoryEntry],
  )

  // Clear every editable cell inside the current selection range.
  // Mirrors commitFill's batch-write pattern so a multi-cell delete
  // is a single history entry (Cmd+Z reverts the whole clear).
  // Falls back gracefully on a 1×1 selection — that's just the active
  // cell.
  const clearSelectionRange = useCallback(() => {
    const rb = rangeBoundsRef.current
    if (!rb) return false
    const tbl = tableRef.current
    const tableRows = tbl.getRowModel().rows
    const cols = tbl.getVisibleLeafColumns()
    const allFields = allFieldsRef.current
    const batch: HistoryDelta[] = []
    let appliedAny = false
    for (let r = rb.minRow; r <= rb.maxRow; r++) {
      const row = tableRows[r]
      if (!row) continue
      for (let c = rb.minCol; c <= rb.maxCol; c++) {
        const col = cols[c]
        if (!col) continue
        const fieldDef = allFields.find((f) => f.id === col.id)
        if (!fieldDef?.editable) continue
        editHandlers
          .get(editKey(row.original.id, col.id))
          ?.applyValue('')
        writeChange(row.original.id, col.id, '', false, batch)
        appliedAny = true
      }
    }
    if (batch.length > 0) {
      pushHistoryEntry({ cells: batch, timestamp: Date.now() })
    }
    return appliedAny
  }, [writeChange, pushHistoryEntry])

  const beginFill = useCallback(() => {
    const rb = rangeBoundsRef.current
    if (!rb) return
    setFillState({
      source: { ...rb },
      target: { rowIdx: rb.maxRow, colIdx: rb.maxCol },
    })
    const local = { rafId: null as number | null, x: 0, y: 0 }
    const flush = () => {
      local.rafId = null
      const el = document.elementFromPoint(local.x, local.y) as
        | HTMLElement
        | null
      if (!el) return
      const cellEl = el.closest('[data-row-idx]') as HTMLElement | null
      if (!cellEl) return
      const r = parseInt(cellEl.getAttribute('data-row-idx') ?? '', 10)
      const c = parseInt(cellEl.getAttribute('data-col-idx') ?? '', 10)
      if (Number.isNaN(r) || Number.isNaN(c)) return
      setFillState((curr) =>
        curr ? { ...curr, target: { rowIdx: r, colIdx: c } } : curr,
      )
    }
    const teardown = () => {
      if (local.rafId !== null) cancelAnimationFrame(local.rafId)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('contextmenu', onContext)
    }
    const onMove = (e: MouseEvent) => {
      local.x = e.clientX
      local.y = e.clientY
      if (local.rafId === null) {
        local.rafId = requestAnimationFrame(flush)
      }
    }
    const onUp = () => {
      teardown()
      // Read the latest fillState off the setter so we always commit
      // the final target, not whatever stale value the handler closure
      // captured.
      setFillState((curr) => {
        if (curr) commitFill(curr)
        return null
      })
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        teardown()
        setFillState(null)
      }
    }
    // TECH_DEBT #26 — right-click cancels mid-drag. Same effect as Esc;
    // mouse-driven users get an affordance that doesn't require their
    // other hand on the keyboard. preventDefault suppresses the
    // browser context menu so the cancel feels intentional.
    const onContext = (e: MouseEvent) => {
      e.preventDefault()
      teardown()
      setFillState(null)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('keydown', onKey)
    document.addEventListener('contextmenu', onContext)
  }, [commitFill])
  selectCtxRef.current.beginFill = beginFill
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const sel = selectionRef.current
      if (!sel.active) return
      const ae = document.activeElement as HTMLElement | null
      // While editing or typing in a real input/search, let the
      // browser handle the key naturally — EditableCell's input has
      // its own keydown for Enter/Escape/Tab.
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable)
      ) {
        return
      }
      // Don't swallow modifier-key chords (Cmd+S, Cmd+C, …).
      if (e.metaKey || e.ctrlKey || e.altKey) return

      const key = e.key
      if (key === 'F2' || key === 'Enter') {
        e.preventDefault()
        requestEditAt(sel.active.rowIdx, sel.active.colIdx)
        return
      }
      if (key === 'Escape') {
        e.preventDefault()
        setSelection({ anchor: null, active: null })
        return
      }
      if (key === 'Tab') {
        e.preventDefault()
        moveSelection(0, e.shiftKey ? -1 : 1, false)
        return
      }
      if (key === 'ArrowUp') {
        e.preventDefault()
        moveSelection(-1, 0, e.shiftKey)
        return
      }
      if (key === 'ArrowDown') {
        e.preventDefault()
        moveSelection(1, 0, e.shiftKey)
        return
      }
      if (key === 'ArrowLeft') {
        e.preventDefault()
        moveSelection(0, -1, e.shiftKey)
        return
      }
      if (key === 'ArrowRight') {
        e.preventDefault()
        moveSelection(0, 1, e.shiftKey)
        return
      }
      // Type-to-edit: any single printable character starts a fresh
      // edit on the active cell with the typed character as the new
      // value. Skip control keys (length > 1) and pure whitespace
      // chords.
      if (key.length === 1) {
        e.preventDefault()
        requestEditAt(sel.active.rowIdx, sel.active.colIdx, key)
        return
      }
      if (key === 'Backspace' || key === 'Delete') {
        e.preventDefault()
        // Multi-cell delete: clears every editable cell in the range
        // as one batch history entry. Single-cell selection still
        // works (1×1 range). If the range produced no edits (all
        // cells read-only), fall back to the original active-cell
        // edit-mode-with-empty-string so the user gets feedback.
        const cleared = clearSelectionRange()
        if (!cleared) {
          requestEditAt(sel.active.rowIdx, sel.active.colIdx, '')
        }
        return
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [moveSelection, requestEditAt, clearSelectionRange])

  // ── Step 3: copy selection as TSV ────────────────────────────────
  // The handler is registered once on document; it pulls the latest
  // selection + table refs from copyCtxRef so we don't re-attach the
  // listener every time selection changes.
  const copyCtxRef = useRef<{
    bounds: typeof rangeBounds
    table: typeof table
  }>({ bounds: rangeBounds, table })
  copyCtxRef.current.bounds = rangeBounds
  copyCtxRef.current.table = table
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      const bounds = copyCtxRef.current.bounds
      if (!bounds) return
      // Don't intercept native copy when the user is editing or
      // selected text inside a regular input/textarea.
      const ae = document.activeElement as HTMLElement | null
      if (ae) {
        const tag = ae.tagName
        if (
          tag === 'INPUT' ||
          tag === 'TEXTAREA' ||
          ae.isContentEditable
        ) {
          return
        }
      }
      const tbl = copyCtxRef.current.table
      const tableRows = tbl.getRowModel().rows
      const cols = tbl.getVisibleLeafColumns()
      const tsvRows: string[] = []
      for (let r = bounds.minRow; r <= bounds.maxRow; r++) {
        const row = tableRows[r]
        if (!row) continue
        const cells: string[] = []
        for (let c = bounds.minCol; c <= bounds.maxCol; c++) {
          const col = cols[c]
          if (!col) {
            cells.push('')
            continue
          }
          let v: unknown
          try {
            v = row.getValue(col.id)
          } catch {
            v = undefined
          }
          cells.push(toTsvCell(v))
        }
        tsvRows.push(cells.join('\t'))
      }
      const tsv = tsvRows.join('\n')
      e.clipboardData?.setData('text/plain', tsv)
      e.preventDefault()
      const count =
        (bounds.maxRow - bounds.minRow + 1) *
        (bounds.maxCol - bounds.minCol + 1)
      const at = Date.now()
      setCopyFlash({ count, at })
      // Auto-clear after 2s, but only if no newer copy has happened.
      window.setTimeout(() => {
        setCopyFlash((curr) => (curr && curr.at === at ? null : curr))
      }, 2000)
    }
    document.addEventListener('copy', onCopy)
    return () => document.removeEventListener('copy', onCopy)
  }, [])

  // ── Step 4: paste from clipboard with preview ────────────────────
  // The paste handler reads from the same refs as copy. It builds a
  // "plan" (cells that will change) + "errors" (cells skipped due to
  // read-only / type mismatch / out-of-bounds) and shows the modal
  // before any state mutation. Apply commits via writeChange and uses
  // editHandlers.applyValue to set the visible cells' draftValue so
  // they immediately render with the dirty (yellow) tint.
  const [pastePreview, setPastePreview] = useState<PastePreview | null>(null)
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const sel = selectionRef.current
      if (!sel.active) return
      const ae = document.activeElement as HTMLElement | null
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable)
      ) {
        return
      }
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if (!text) return

      const sourceGrid = parseTsv(text)
      if (sourceGrid.length === 0) return
      e.preventDefault()

      const tbl = tableRef.current
      const tableRows = tbl.getRowModel().rows
      const visibleCols = tbl.getVisibleLeafColumns()
      const startRow = sel.active.rowIdx
      const startCol = sel.active.colIdx

      // 1×1 source + multi-cell selection → fill the entire range
      // with the single value (Excel behaviour).
      const isSingleSource =
        sourceGrid.length === 1 && sourceGrid[0].length === 1
      const rangeRows = rangeBounds
        ? rangeBounds.maxRow - rangeBounds.minRow + 1
        : 1
      const rangeCols = rangeBounds
        ? rangeBounds.maxCol - rangeBounds.minCol + 1
        : 1
      const fillRange =
        isSingleSource && rangeBounds && (rangeRows > 1 || rangeCols > 1)
      const sourceRows = fillRange ? rangeRows : sourceGrid.length
      const sourceCols = fillRange
        ? rangeCols
        : Math.max(...sourceGrid.map((r) => r.length))
      const anchorRow = fillRange ? rangeBounds!.minRow : startRow
      const anchorCol = fillRange ? rangeBounds!.minCol : startCol

      const plan: PasteCell[] = []
      const errors: PasteError[] = []
      for (let dr = 0; dr < sourceRows; dr++) {
        const targetRow = anchorRow + dr
        if (targetRow >= tableRows.length) break
        const row = tableRows[targetRow]
        if (!row) continue
        for (let dc = 0; dc < sourceCols; dc++) {
          const targetCol = anchorCol + dc
          if (targetCol >= visibleCols.length) break
          const col = visibleCols[targetCol]
          if (!col) continue
          const fieldDef = allFieldsRef.current.find((f) => f.id === col.id)
          const sku = row.original.sku ?? ''
          const fieldLabel = fieldDef?.label ?? col.id
          if (!fieldDef?.editable) {
            errors.push({
              rowIdx: targetRow,
              colIdx: targetCol,
              sku,
              fieldLabel,
              reason: 'Read-only',
            })
            continue
          }
          const sourceR = fillRange ? 0 : dr
          const sourceC = fillRange ? 0 : dc
          const raw = sourceGrid[sourceR]?.[sourceC] ?? ''
          const coerced = coercePasteValue(raw, fieldDef)
          if (coerced.error) {
            errors.push({
              rowIdx: targetRow,
              colIdx: targetCol,
              sku,
              fieldLabel,
              reason: coerced.error,
            })
            continue
          }
          let oldValue: unknown
          try {
            oldValue = row.getValue(col.id)
          } catch {
            oldValue = undefined
          }
          // Skip no-op cells from the changes plan but still flow
          // through so applying expands the selection over them.
          plan.push({
            rowIdx: targetRow,
            colIdx: targetCol,
            rowId: row.original.id,
            columnId: col.id,
            oldValue,
            newValue: coerced.value,
            sku,
            fieldLabel,
          })
        }
      }
      if (plan.length === 0 && errors.length === 0) return
      setPastePreview({ plan, errors })
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
  }, [rangeBounds])

  const applyPaste = useCallback(() => {
    setPastePreview((curr) => {
      if (!curr) return null
      // Apply each cell: bump the visible cell's draftValue (yellow
      // tint) AND register the change in the changes Map. Cells that
      // were virtualised out at paste time won't have a registered
      // applyValue handler — the changes Map still picks them up so
      // a save flushes them, but they won't show yellow until the
      // user scrolls back. Tracked in TECH_DEBT.
      let minR = Infinity,
        maxR = -Infinity,
        minC = Infinity,
        maxC = -Infinity
      // D.6.3: paste is one user action — collect every per-cell
      // delta into a single history entry so Cmd+Z reverts the
      // whole paste in one go.
      const batch: HistoryDelta[] = []
      for (const c of curr.plan) {
        editHandlers.get(editKey(c.rowId, c.columnId))?.applyValue(c.newValue)
        writeChange(c.rowId, c.columnId, c.newValue, false, batch)
        if (c.rowIdx < minR) minR = c.rowIdx
        if (c.rowIdx > maxR) maxR = c.rowIdx
        if (c.colIdx < minC) minC = c.colIdx
        if (c.colIdx > maxC) maxC = c.colIdx
      }
      if (batch.length > 0) {
        pushHistoryEntry({ cells: batch, timestamp: Date.now() })
      }
      // Expand the selection over the pasted region so the user can
      // see what just changed. Falls back to current selection if no
      // changes were applied (e.g., pure errors).
      if (curr.plan.length > 0) {
        setSelection({
          anchor: { rowIdx: minR, colIdx: minC },
          active: { rowIdx: maxR, colIdx: maxC },
        })
      }
      return null
    })
  }, [writeChange, pushHistoryEntry])
  const cancelPaste = useCallback(() => setPastePreview(null), [])

  const containerRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: loading ? 20 : rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  // NOT memoized: TanStack's table object is stable across renders by
  // design (it mutates internally). A useMemo([table]) dep would
  // capture an empty headers array on first render (before dynamicColumns
  // is populated) and never recompute. Calling getHeaderGroups() each
  // render is cheap — TanStack returns the cached internal structure.
  const headerCells = table.getHeaderGroups()[0]?.headers ?? []
  const totalSize = rowVirtualizer.getTotalSize()
  const pendingCount = changes.size

  // ── Selection overlay geometry ─────────────────────────────────
  // Compute the (left, width) of every visible column once per render
  // so the selection overlays know where to draw. Cheap — just walks
  // the visible-leaf-columns array.
  const visibleLeafCols = table.getVisibleLeafColumns()
  const colLefts: number[] = []
  {
    let acc = 0
    for (const col of visibleLeafCols) {
      colLefts.push(acc)
      acc += col.getSize()
    }
  }
  const rangeRect = (() => {
    if (!rangeBounds) return null
    const left = colLefts[rangeBounds.minCol] ?? 0
    let width = 0
    for (let i = rangeBounds.minCol; i <= rangeBounds.maxCol; i++) {
      width += visibleLeafCols[i]?.getSize() ?? 0
    }
    return {
      top: rangeBounds.minRow * ROW_HEIGHT,
      left,
      width,
      height:
        (rangeBounds.maxRow - rangeBounds.minRow + 1) * ROW_HEIGHT,
    }
  })()
  const activeRect = (() => {
    if (!selection.active) return null
    const a = selection.active
    return {
      top: a.rowIdx * ROW_HEIGHT,
      left: colLefts[a.colIdx] ?? 0,
      width: visibleLeafCols[a.colIdx]?.getSize() ?? 0,
      height: ROW_HEIGHT,
    }
  })()
  const fillRect = (() => {
    if (!fillState) return null
    const ext = computeFillExtension(fillState.source, fillState.target)
    if (!ext) return null
    const left = colLefts[ext.minCol] ?? 0
    let width = 0
    for (let i = ext.minCol; i <= ext.maxCol; i++) {
      width += visibleLeafCols[i]?.getSize() ?? 0
    }
    return {
      top: ext.minRow * ROW_HEIGHT,
      left,
      width,
      height: (ext.maxRow - ext.minRow + 1) * ROW_HEIGHT,
    }
  })()

  // ── Step 6: status-bar metrics ─────────────────────────────────
  // For numeric ranges, compute Sum/Avg/Min/Max alongside the cell
  // count. Skip the heavy iteration above 1000 cells — the count
  // alone is enough for huge selections, and recomputing on every
  // mousemove during a drag would become noticeable.
  const selectionMetrics = useMemo<SelectionMetrics | null>(() => {
    if (!rangeBounds) return null
    const count =
      (rangeBounds.maxRow - rangeBounds.minRow + 1) *
      (rangeBounds.maxCol - rangeBounds.minCol + 1)
    if (count > 1000) {
      return { count, isLarge: true }
    }
    const tableRows = table.getRowModel().rows
    const cols = visibleLeafCols
    let sum = 0
    let min = Infinity
    let max = -Infinity
    let numericCount = 0
    for (let r = rangeBounds.minRow; r <= rangeBounds.maxRow; r++) {
      const row = tableRows[r]
      if (!row) continue
      for (let c = rangeBounds.minCol; c <= rangeBounds.maxCol; c++) {
        const col = cols[c]
        if (!col) continue
        let v: unknown
        try {
          v = row.getValue(col.id)
        } catch {
          continue
        }
        if (typeof v === 'number' && Number.isFinite(v)) {
          sum += v
          if (v < min) min = v
          if (v > max) max = v
          numericCount++
        }
      }
    }
    if (numericCount === 0) {
      return { count, numericCount: 0 }
    }
    return {
      count,
      numericCount,
      sum,
      avg: sum / numericCount,
      min,
      max,
    }
  }, [rangeBounds, table, visibleLeafCols])

  // D.3d: track which visible columns are channel-prefixed AND
  // whether any pending change targets one. Used to drive the banner
  // and the marketplace-selector pulse animation.
  const channelFieldsVisible = useMemo(() => {
    return visibleColumnIds.some((id) => {
      const f = fieldsById.get(id)
      return !!f?.channel
    })
  }, [visibleColumnIds, fieldsById])

  const pendingChannelChanges = useMemo(() => {
    let n = 0
    for (const [, c] of changes) {
      if (c.columnId.startsWith('amazon_') || c.columnId.startsWith('ebay_')) n++
    }
    return n
  }, [changes])

  const showContextBanner =
    channelFieldsVisible && marketplaceTargets.length === 0

  const hasUnsavablePendingChanges =
    marketplaceTargets.length === 0 && pendingChannelChanges > 0

  const saveLabel =
    saveStatus.kind === 'saving'
      ? 'Saving…'
      : pendingCount === 0
      ? 'No changes'
      : `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}`

  // ── View handlers ────────────────────────────────────────────────
  const handleSelectView = useCallback(
    (id: string) => {
      const view = savedViews.find((v) => v.id === id)
      if (!view) return
      setActiveViewIdState(id)
      setActiveViewId(id)
      // NN.13 — drop columnIds whose registry entry no longer exists
      // (deleted attribute, removed productType, etc.). Without this,
      // a stale view keeps trying to render orphan columns and the
      // grid silently misaligns. When allFields hasn't loaded yet we
      // accept the view as-is and let the registry hydrate later.
      if (allFields.length > 0) {
        const knownIds = new Set(allFields.map((f) => f.id))
        const filtered = view.columnIds.filter((id) => knownIds.has(id))
        const droppedCount = view.columnIds.length - filtered.length
        if (droppedCount > 0) {
          console.warn(
            `[bulk-ops] view "${view.name}" had ${droppedCount} stale column id${
              droppedCount === 1 ? '' : 's'
            } dropped — attributes no longer in the registry.`,
          )
        }
        setVisibleColumnIds(filtered)
      } else {
        setVisibleColumnIds(view.columnIds)
      }
      setEnabledChannels(view.channels ?? [])
      setEnabledProductTypes(view.productTypes ?? [])
      // T.6 — server-backed templates persist filterState too. Restore
      // when present; otherwise leave the user's current filters
      // alone so default views don't blank out a deliberate filter.
      if (view.filterState) setFilterState(view.filterState)
      // W.10 — restore collapsed groups so the user's preferred density
      // tracks with the view.
      if (view.collapsedGroups) {
        setCollapsedGroups(new Set(view.collapsedGroups))
      }
      // KK.2 — explicit-view-load wins over channel auto-load.
      // Mark every (channel, marketplace) pair as already auto-loaded
      // so the EE.1 effect won't reorder the view-supplied columns
      // when the user later clicks a marketplace tab.
      autoLoadedRef.current.add('__view_loaded__')
    },
    [savedViews, allFields],
  )

  const handleSaveAsView = useCallback(
    async (name: string) => {
      // Server assigns the id today; we still pass a draft id for the
      // local fallback path (network failure). The persisted SavedView
      // returned from saveUserView carries the canonical id.
      const draftId = `user_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 7)}`
      const view = await saveUserView({
        id: draftId,
        name,
        columnIds: visibleColumnIds,
        filterState,
        channels: enabledChannels,
        productTypes: enabledProductTypes,
        collapsedGroups: Array.from(collapsedGroups),
      })
      setSavedViews(loadAllViews())
      setActiveViewIdState(view.id)
      setActiveViewId(view.id)
    },
    [
      visibleColumnIds,
      enabledChannels,
      enabledProductTypes,
      filterState,
      collapsedGroups,
    ],
  )

  const handleDeleteView = useCallback(
    async (id: string) => {
      if (isDefaultView(id)) return
      await deleteUserView(id)
      setSavedViews(loadAllViews())
      if (activeViewIdState === id) {
        handleSelectView(DEFAULT_VIEWS[0].id)
      }
    },
    [activeViewIdState, handleSelectView],
  )

  // V.5 — overwrite the active server template with the current grid
  // state. Only valid for server-backed views (DEFAULT_VIEWS are
  // hardcoded). Reuses saveUserView's PATCH branch.
  const [updateFlash, setUpdateFlash] = useState<'idle' | 'saving' | 'saved'>(
    'idle',
  )
  const activeView = useMemo(
    () => savedViews.find((v) => v.id === activeViewIdState),
    [savedViews, activeViewIdState],
  )
  const canUpdateActiveView =
    !!activeView && !!activeView.serverBacked && !isDefaultView(activeView.id)
  const handleUpdateActiveView = useCallback(async () => {
    if (!activeView || !canUpdateActiveView) return
    setUpdateFlash('saving')
    await saveUserView({
      id: activeView.id,
      name: activeView.name,
      columnIds: visibleColumnIds,
      filterState,
      channels: enabledChannels,
      productTypes: enabledProductTypes,
      collapsedGroups: Array.from(collapsedGroups),
    })
    setSavedViews(loadAllViews())
    setUpdateFlash('saved')
    window.setTimeout(() => setUpdateFlash('idle'), 1500)
  }, [
    activeView,
    canUpdateActiveView,
    visibleColumnIds,
    filterState,
    enabledChannels,
    enabledProductTypes,
    collapsedGroups,
  ])

  return (
    // U.38 — was `flex-1 min-h-0 px-6 pb-6 flex flex-col` which
    // depended on the page wrapper being a flex column with an
    // explicit height. After the page wrapper was simplified to
    // remove the negative-margin trickery (so it stops fighting the
    // layout's sidebar / scroll context), this client anchors its
    // own max-height to the viewport via dvh. 12rem accommodates
    // PageHeader + ActiveJobsStrip + the layout's p-3/md:p-6 padding
    // + the mobile top bar; close-enough on every breakpoint.
    <div
      className="flex flex-col"
      style={{ height: 'calc(100dvh - 12rem)' }}
    >
      {!online && (
        <div className="flex-shrink-0 mb-3 flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md text-base text-amber-800">
          <WifiOff className="w-3.5 h-3.5 flex-shrink-0" />
          <span>You're offline. Changes are kept locally and will save when you reconnect.</span>
        </div>
      )}

      {/* P.9 — scope banner. Visible when /products' bulk-action bar
          deep-linked here with ?productIds=... so the operator
          knows they're in a filtered slice rather than the full
          catalog, and can drop back to the full view in one click. */}
      {isScoped && (
        <div className="flex-shrink-0 mb-3 flex items-center justify-between gap-3 px-3 py-2 bg-blue-50 border border-blue-200 rounded-md text-base text-blue-900">
          <div className="flex items-center gap-2 min-w-0">
            <span className="inline-block w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
            <span className="truncate">
              Editing{' '}
              <span className="font-semibold tabular-nums">
                {scopedProductIds.length}
              </span>{' '}
              product{scopedProductIds.length === 1 ? '' : 's'} from your
              /products selection.
              {products.length > 0 && products.length !== scopedProductIds.length && (
                <span className="text-slate-600">
                  {' '}({products.length} loaded
                  {products.length < scopedProductIds.length
                    ? ` — ${scopedProductIds.length - products.length} not found`
                    : ''})
                </span>
              )}
            </span>
          </div>
          <button
            type="button"
            onClick={clearScope}
            className="flex-shrink-0 h-7 px-2 text-sm text-blue-700 hover:text-blue-900 hover:bg-blue-100 rounded inline-flex items-center gap-1"
          >
            <X className="w-3 h-3" />
            Show all products
          </button>
        </div>
      )}

      <MarketplaceContextBanner
        visible={showContextBanner}
        pendingChannelChanges={pendingChannelChanges}
      />

      {/* T.7 — marketplace tab strip. Master tab clears the primary
          context; each marketplace tab sets it to that single (channel,
          marketplace) so _channelListing hydration + channel-prefixed
          column rendering switches in one click. The multi-select
          selector in the toolbar below still drives fan-out edit
          scope (Cmd+S broadcasts to every selected target). */}
      <MarketplaceTabs
        options={marketplaceOptions}
        primaryKey={
          primaryContext
            ? `${primaryContext.channel}:${primaryContext.marketplace}`
            : null
        }
        onSelect={(channel, marketplace) => {
          if (channel === null) {
            setMarketplaceTargets([])
          } else {
            setMarketplaceTargets([{ channel, marketplace }])
          }
        }}
      />

      {/* Two-row toolbar.
          Row 1: scope (mode/expand/search/filter) on the left,
                 marketplace + write actions (Bulk apply / Upload /
                 Preview / Save) on the right — Save is always visible
                 without horizontal scrolling at any reasonable width.
          Row 2: secondary tools (undo/redo, columns, reset widths)
                 on the left, status text on the right.

          `relative z-30` is load-bearing: the table container below
          uses `contain: strict` which creates its own stacking context.
          Without an explicit stacking context here, popovers in the
          toolbar (Filter / Marketplace / Cols) render UNDER the table
          even though they are at z-30 internally. Elevating the whole
          toolbar wrapper above the table's SC keeps the popovers
          visually on top whenever they expand downward over the grid. */}
      <div className="flex-shrink-0 mb-3 flex flex-col gap-1.5 px-1 pb-2 border-b border-slate-200 bg-white relative z-30">
        {/* ── Row 1 — primary scope + write actions ─────────────────── */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Left: scope */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <DisplayModeToggle mode={displayMode} onChange={setDisplayMode} />
            {displayMode === 'hierarchy' && (
              <ExpandCollapseControls
                products={products}
                expandedParents={expandedParents}
                onChange={setExpandedParents}
              />
            )}

            <div className="w-px h-5 bg-slate-200" aria-hidden="true" />

            <div className="relative flex items-center">
              <Search className="absolute left-2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search SKU, name, brand…"
                className="h-7 pl-7 pr-7 text-base border border-slate-200 rounded-md w-40 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-1.5 text-slate-400 hover:text-slate-700"
                  aria-label="Clear search"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
            <FilterDropdown
              open={filterOpen}
              onOpenChange={setFilterOpen}
              value={filterState}
              onChange={setFilterState}
              onReset={resetFilters}
              activeCount={activeFilterCount}
              availableProductTypes={productTypesInData}
            />
          </div>

          {/* Right: marketplace + write actions */}
          <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
            <MarketplaceSelector
              value={marketplaceTargets}
              onChange={setMarketplaceTargets}
              options={marketplaceOptions}
              pulse={showContextBanner}
            />

            <div className="w-px h-5 bg-slate-200" aria-hidden="true" />

            <Button
              variant="secondary"
              size="sm"
              onClick={() => setNewProductOpen(true)}
              title="Create a new master product or a variant of an existing parent"
            >
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              New product
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setReplicateOpen(true)}
              disabled={products.length === 0}
              title="Pull title / description / price / attributes from one marketplace and replicate to others across many products"
            >
              <Copy className="w-3.5 h-3.5 mr-1.5" />
              Replicate
            </Button>
            {selectedRowCount > 1 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleBatchDelete()}
                title={`Delete ${selectedRowCount} selected rows + their cascades`}
                className="text-rose-700 border-rose-200 hover:bg-rose-50"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                Delete {selectedRowCount}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setBulkOpModalOpen(true)}
              title="Apply price / stock / status / attribute changes to a scoped subset of products"
            >
              <Wand2 className="w-3.5 h-3.5 mr-1.5" />
              Bulk apply
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setUploadOpen(true)}
            >
              <Upload className="w-3.5 h-3.5 mr-1.5" />
              Upload
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={pendingCount === 0}
              onClick={() => setPreviewOpen(true)}
            >
              Preview
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={
                pendingCount === 0 ||
                saveStatus.kind === 'saving' ||
                !online ||
                hasUnsavablePendingChanges
              }
              loading={saveStatus.kind === 'saving'}
              onClick={handleSave}
              title={
                hasUnsavablePendingChanges
                  ? `${pendingChannelChanges} channel change${
                      pendingChannelChanges === 1 ? '' : 's'
                    } need a marketplace context to save`
                  : undefined
              }
            >
              {saveLabel}
            </Button>
          </div>
        </div>

        {/* ── Row 2 — secondary tools + status ──────────────────────── */}
        <div className="flex items-center gap-2 flex-wrap text-sm">
          {/* Left: history. V.2 — count badges show stack depth at a
              glance so undo/redo state is visible in real time. */}
          <div className="flex items-center gap-2 flex-shrink-0">
            <div className="flex items-center gap-0.5 border border-slate-200 rounded-md">
              <button
                type="button"
                onClick={undo}
                disabled={!canUndo}
                title={
                  canUndo
                    ? `Undo last edit (⌘Z) — ${historyIndex + 1} step${
                        historyIndex === 0 ? '' : 's'
                      } available`
                    : 'Nothing to undo'
                }
                aria-label="Undo"
                className="h-7 px-1.5 inline-flex items-center gap-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30 disabled:cursor-default rounded-l-md"
              >
                <Undo2 className="w-3.5 h-3.5" />
                {canUndo && (
                  <span className="text-xs tabular-nums text-slate-500">
                    {historyIndex + 1}
                  </span>
                )}
              </button>
              <div className="w-px h-4 bg-slate-200" />
              <button
                type="button"
                onClick={redo}
                disabled={!canRedo}
                title={
                  canRedo
                    ? `Redo (⌘⇧Z) — ${
                        history.length - 1 - historyIndex
                      } step${
                        history.length - 1 - historyIndex === 1 ? '' : 's'
                      } available`
                    : 'Nothing to redo'
                }
                aria-label="Redo"
                className="h-7 px-1.5 inline-flex items-center gap-1 text-slate-600 hover:bg-slate-100 hover:text-slate-900 disabled:opacity-30 disabled:cursor-default rounded-r-md"
              >
                <Redo2 className="w-3.5 h-3.5" />
                {canRedo && (
                  <span className="text-xs tabular-nums text-slate-500">
                    {history.length - 1 - historyIndex}
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* Middle: status, fills available space.
              U.9 — bare "Loading…" replaced with spinner + label so
              the inline status reads as actually-running rather than
              static text on a slow fetch. */}
          <div className="flex-1 min-w-0 text-slate-500 tabular-nums truncate">
            {loading ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Loading…
              </span>
            ) : filteredProducts.length === products.length ? (
              `${products.length.toLocaleString()} rows · ${visibleColumnIds.length}/${allFields.length} cols · ⌘S to save`
            ) : (
              `${filteredProducts.length.toLocaleString()} of ${products.length.toLocaleString()} rows · ${visibleColumnIds.length}/${allFields.length} cols · ⌘S to save`
            )}
          </div>

          {/* Right: view tools. */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* T.2 — surface every dynamic schema attribute (attr_*)
             *  for the productTypes seen in the loaded data. One-shot
             *  append; user can hide individual ones via Cols.
             *  CC.3 — when a marketplace tab is active, the same button
             *  also pulls in channel-specific columns (channel-prefixed
             *  fields whose channel matches the active tab). Label and
             *  tooltip reflect current scope so the click is explicit. */}
            {(() => {
              const onMarketplaceTab = !!primaryContext
              const missingFields = allFields.filter((f) => {
                if (visibleColumnIds.includes(f.id)) return false
                if (f.id.startsWith('attr_')) return true
                if (onMarketplaceTab && f.channel === primaryContext!.channel) {
                  return true
                }
                return false
              })
              if (missingFields.length === 0) return null
              const scopeLabel = onMarketplaceTab
                ? `${primaryContext!.channel}:${primaryContext!.marketplace}`
                : null
              return (
                <button
                  type="button"
                  onClick={() =>
                    setVisibleColumnIds((prev) => [
                      ...prev,
                      ...missingFields.map((f) => f.id),
                    ])
                  }
                  title={
                    scopeLabel
                      ? `Add every schema-driven category attribute plus channel-specific fields for ${scopeLabel} as columns`
                      : 'Add every schema-driven category attribute (attr_*) for the loaded productTypes as columns'
                  }
                  className="inline-flex items-center gap-1 h-7 px-2 text-sm font-medium text-blue-700 border border-blue-200 rounded-md hover:bg-blue-50"
                >
                  + {missingFields.length}
                  {scopeLabel
                    ? ` for ${scopeLabel}`
                    : ` schema field${missingFields.length === 1 ? '' : 's'}`}
                </button>
              )
            })()}
            <ColumnSelector
              allFields={allFields}
              visibleColumnIds={visibleColumnIds}
              onVisibleChange={setVisibleColumnIds}
              enabledChannels={enabledChannels}
              onEnabledChannelsChange={setEnabledChannels}
              enabledProductTypes={enabledProductTypes}
              onEnabledProductTypesChange={setEnabledProductTypes}
              views={savedViews}
              activeViewId={activeViewIdState}
              onSelectView={handleSelectView}
              onSaveAsView={handleSaveAsView}
              onDeleteView={handleDeleteView}
            />
            {/* V.5 — overwrite the active server template with current
                state. Only renders when the active view is server-backed. */}
            {canUpdateActiveView && (
              <button
                type="button"
                onClick={() => void handleUpdateActiveView()}
                disabled={updateFlash === 'saving'}
                title={`Save current columns + filters back to "${activeView?.name}"`}
                className={cn(
                  'inline-flex items-center gap-1 h-7 px-2 text-sm font-medium border rounded-md transition-colors',
                  updateFlash === 'saved'
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : 'border-slate-200 text-slate-700 hover:bg-slate-50',
                )}
              >
                {updateFlash === 'saving'
                  ? 'Updating…'
                  : updateFlash === 'saved'
                  ? 'Updated'
                  : `Update "${activeView?.name}"`}
              </button>
            )}
            {Object.keys(columnSizing).length > 0 && (
              <button
                type="button"
                onClick={resetColumnWidths}
                title="Reset column widths to defaults"
                className="inline-flex items-center gap-1 h-7 px-2 text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50 hover:text-slate-900"
              >
                <RotateCcw className="w-3 h-3" />
                Reset widths
              </button>
            )}
            {/* MM — group expand/collapse-all. Placed in the toolbar so
                it's always reachable; clicking the band chevrons one
                by one is fine for a few groups but tedious past 5+. */}
            {groupedFields.length > 1 && (
              <div className="inline-flex items-center gap-0.5 h-7 px-1 text-sm text-slate-600 border border-slate-200 rounded-md bg-white">
                <span className="px-1.5 text-slate-400">Groups</span>
                <button
                  type="button"
                  onClick={() => {
                    setCollapsedGroups((prev) => {
                      if (prev.size === 0) return prev
                      saveCollapsedGroups(new Set())
                      return new Set()
                    })
                  }}
                  disabled={collapsedGroups.size === 0}
                  title="Expand every group"
                  className={cn(
                    'h-5 px-1.5 rounded transition-colors',
                    collapsedGroups.size === 0
                      ? 'opacity-40 cursor-not-allowed'
                      : 'hover:bg-slate-100 hover:text-slate-900',
                  )}
                >
                  Expand all
                </button>
                <span className="text-slate-300">·</span>
                <button
                  type="button"
                  onClick={() => {
                    const allKeys = new Set(groupedFields.map((g) => g.key))
                    setCollapsedGroups((prev) => {
                      if (prev.size >= allKeys.size) return prev
                      saveCollapsedGroups(allKeys)
                      return allKeys
                    })
                  }}
                  disabled={collapsedGroups.size >= groupedFields.length}
                  title="Collapse every group"
                  className={cn(
                    'h-5 px-1.5 rounded transition-colors',
                    collapsedGroups.size >= groupedFields.length
                      ? 'opacity-40 cursor-not-allowed'
                      : 'hover:bg-slate-100 hover:text-slate-900',
                  )}
                >
                  Collapse all
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
      {/* U.54 (BISECT 5) — render StatusBar + first 4 modals only.
          Skip CascadeChoiceModal, NewProductModal, ReplicateModal. */}
      <div className="p-4 text-base text-slate-500">
        BISECT 5 — grid + last 3 modals (Cascade/New/Replicate) disabled.
      </div>
      <StatusBar
        status={saveStatus}
        pendingCount={pendingCount}
        fetchMs={fetchMs}
        loading={loading}
        selectedCellCount={selectedCellCount}
        selectionMetrics={selectionMetrics}
        copyFlashCount={copyFlash?.count ?? null}
      />

      <PreviewChangesModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        changes={changes}
        products={products}
      />

      <PastePreviewModal
        preview={pastePreview}
        onCancel={cancelPaste}
        onApply={applyPaste}
      />

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        onApplied={() => {
          // Refetch products so the grid reflects the saved changes.
          // Selection + pending edits are local state and unaffected.
          reloadProducts()
        }}
      />

      <BulkOperationModal
        open={bulkOpModalOpen}
        onClose={() => {
          setBulkOpModalOpen(false)
          // Refresh the grid in case the bulk apply changed visible
          // rows (price/stock/status/attribute updates).
          reloadProducts()
        }}
        marketplaceTargets={marketplaceTargets}
        visibleProductIds={products.map((p) => p.id)}
        selectedProductIds={
          // P1 #34e — pass the operator's row-range selection as
          // explicit target IDs so the modal's "Selected rows" scope
          // mode targets exactly what the grid is highlighting.
          rangeBounds
            ? products
                .slice(rangeBounds.minRow, rangeBounds.maxRow + 1)
                .map((p) => p.id)
            : []
        }
        currentFilters={(() => {
          // Map the grid's filterState (status[]/channels[]/stockLevel)
          // to ScopeFilters. Imperfect but covers the common case.
          // Channels intentionally not mapped — Product.syncChannels[]
          // ≠ ChannelListing.marketplace; would need channel-to-marketplace
          // resolution that's not worth the lift for v1.
          const scope: {
            status?: 'DRAFT' | 'ACTIVE' | 'INACTIVE'
            stockMin?: number
            stockMax?: number
          } = {}
          if (filterState.status.length === 1) {
            scope.status = filterState.status[0] as
              | 'DRAFT'
              | 'ACTIVE'
              | 'INACTIVE'
          }
          if (filterState.stockLevel === 'in') scope.stockMin = 1
          else if (filterState.stockLevel === 'low') {
            scope.stockMin = 1
            scope.stockMax = 5
          } else if (filterState.stockLevel === 'out') scope.stockMax = 0
          return scope
        })()}
      />

    </div>
  )
}

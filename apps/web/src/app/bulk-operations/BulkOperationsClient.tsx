'use client'

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type CellContext,
  type ColumnDef,
  type ColumnSizingState,
  type Row,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { produce } from 'immer'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Lock,
  RotateCcw,
  WifiOff,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { EditableCell, type EditableMeta } from './EditableCell'
import PreviewChangesModal from './PreviewChangesModal'
import CascadeChoiceModal from './components/CascadeChoiceModal'
import ColumnSelector, { type FieldDef } from './components/ColumnSelector'
import MarketplaceSelector, {
  MarketplaceContextBanner,
  type MarketplaceContext,
  type MarketplaceOption,
} from './components/MarketplaceSelector'
import {
  loadAllViews,
  saveUserView,
  deleteUserView,
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
  aggregateDisplayValue,
  isAggregatableField,
  type DisplayMode,
  type HierarchyRow,
} from './lib/hierarchy'
import { cn } from '@/lib/utils'

export interface BulkProduct {
  id: string
  sku: string
  name: string
  basePrice: number
  costPrice: number | null
  minMargin: number | null
  minPrice: number | null
  maxPrice: number | null
  totalStock: number
  lowStockThreshold: number
  brand: string | null
  manufacturer: string | null
  upc: string | null
  ean: string | null
  weightValue: number | null
  weightUnit: string | null
  status: string
  fulfillmentChannel: 'FBA' | 'FBM' | null
  isParent: boolean
  parentId: string | null
  amazonAsin: string | null
  ebayItemId: string | null
  syncChannels: string[]
  variantAttributes: unknown
  updatedAt: string
  productType?: string | null
  categoryAttributes?: Record<string, unknown> | null
  buyBoxPrice?: number | null
  competitorPrice?: number | null
  parentAsin?: string | null
  shippingTemplate?: string | null
  dimLength?: number | null
  dimWidth?: number | null
  dimHeight?: number | null
  dimUnit?: string | null
  [k: string]: unknown
}

interface CellChange {
  rowId: string
  columnId: string
  oldValue: unknown
  newValue: unknown
  cascade: boolean
  timestamp: number
}

interface CascadeModalState {
  rowId: string
  columnId: string
  oldValue: unknown
  newValue: unknown
  parentSku: string
  fieldLabel: string
  children: Array<{ id: string; sku: string }>
}

interface ApiError {
  id: string
  field: string
  error: string
}

type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'dirty' }
  | { kind: 'saving' }
  | { kind: 'saved'; count: number; at: number }
  | { kind: 'partial'; saved: number; failed: number }
  | { kind: 'error'; message: string }

const ROW_HEIGHT = 36
const HEADER_HEIGHT = 36

// ── Editable cell ctx ─────────────────────────────────────────────────
interface EditCtx {
  onCommit: (rowId: string, columnId: string, value: unknown) => void
  cellErrors: Map<string, string>
  /** cellKey → bumped each time parent wants to force-revert that cell */
  resetKeys: Map<string, number>
  /** cellKey → true if its pending change is a cascade (orange tint) */
  cascadeKeys: Set<string>
}

const editCtxRef: { current: EditCtx } = {
  current: {
    onCommit: () => {},
    cellErrors: new Map(),
    resetKeys: new Map(),
    cascadeKeys: new Set(),
  },
}

// ── Hierarchy ctx ────────────────────────────────────────────────────
interface HierarchyCtx {
  mode: DisplayMode
  onToggle: (parentId: string) => void
}

const hierarchyCtxRef: { current: HierarchyCtx } = {
  current: {
    mode: 'flat',
    onToggle: () => {},
  },
}

// ── Selection ctx (Step 1) ───────────────────────────────────────────
// Selection lives in React state but we expose the imperative `select`
// callback through a module-level ref so the cell-wrapper handler can
// stay stable across renders (no extra prop on TableRow's memo).
interface SelectCtx {
  select: (rowIdx: number, colIdx: number, shift: boolean) => void
}

const selectCtxRef: { current: SelectCtx } = {
  current: { select: () => {} },
}

interface CellCoord {
  rowIdx: number
  colIdx: number
}

interface SelectionState {
  /** Where the range starts (first click). */
  anchor: CellCoord | null
  /** Active cell — where typing/edits land; the moving end of the range. */
  active: CellCoord | null
}

function makeEditableRenderer(meta: EditableMeta) {
  return function EditableCellRenderer(ctx: CellContext<BulkProduct, unknown>) {
    const value = ctx.getValue()
    const cellKey = `${ctx.row.original.id}:${ctx.column.id}`
    return (
      <EditableCell
        rowId={ctx.row.original.id}
        columnId={ctx.column.id}
        initialValue={value}
        meta={meta}
        onCommit={editCtxRef.current.onCommit}
        cellError={editCtxRef.current.cellErrors.get(cellKey)}
        resetKey={editCtxRef.current.resetKeys.get(cellKey)}
        cellCascading={editCtxRef.current.cascadeKeys.has(cellKey)}
      />
    )
  }
}

// ── FieldDef → ColumnDef conversion ───────────────────────────────────
const PRICE_FIELDS = new Set([
  'basePrice',
  'costPrice',
  'minPrice',
  'maxPrice',
  'buyBoxPrice',
  'competitorPrice',
])
const MONO_FIELDS = new Set([
  'sku',
  'amazonAsin',
  'parentAsin',
  'ebayItemId',
  'upc',
  'ean',
])

function fieldToMeta(field: FieldDef): EditableMeta {
  if (field.type === 'select') {
    return {
      editable: true,
      fieldType: 'select',
      options: field.options ?? [],
    }
  }
  if (field.type === 'number') {
    const isPrice = PRICE_FIELDS.has(field.id)
    const isInt = field.id === 'totalStock' || field.id === 'lowStockThreshold'
    return {
      editable: true,
      fieldType: 'number',
      numeric: true,
      prefix: isPrice ? '€' : undefined,
      format: isPrice
        ? (v) => (v === null || v === undefined ? '' : Number(v).toFixed(2))
        : isInt
        ? (v) =>
            v === null || v === undefined
              ? ''
              : String(Math.floor(Number(v)))
        : (v) => (v === null || v === undefined ? '' : String(v)),
      parse: isInt
        ? (raw) => {
            if (raw === '' || raw === null) return null
            const n = parseInt(raw, 10)
            return Number.isNaN(n) ? raw : n
          }
        : undefined,
    }
  }
  return { editable: true, fieldType: 'text' }
}

function ReadOnlyCell({
  value,
  field,
}: {
  value: unknown
  field: FieldDef
}) {
  if (value === null || value === undefined || value === '') {
    return <span className="text-slate-300 px-2">—</span>
  }
  if (MONO_FIELDS.has(field.id)) {
    return (
      <span className="font-mono text-[11px] text-slate-700 px-2 truncate">
        {String(value)}
      </span>
    )
  }
  if (field.type === 'number') {
    const n = Number(value)
    if (Number.isNaN(n)) {
      return <span className="text-slate-300 px-2">—</span>
    }
    const formatted = PRICE_FIELDS.has(field.id) ? `€${n.toFixed(2)}` : String(n)
    return (
      <span className="text-[12px] tabular-nums text-slate-700 px-2">
        {formatted}
      </span>
    )
  }
  return (
    <span className="text-[12px] text-slate-700 px-2 truncate">
      {String(value)}
    </span>
  )
}

/** For channel-scoped fields (amazon_title, ebay_description, etc.),
 *  the value lives on row._channelListing.<stripped> rather than on
 *  the row itself. Used as the accessorFn so TanStack getValue() and
 *  cell renderers transparently read the right place. */
function channelAccessorFn(field: FieldDef) {
  const channel = field.channel
  if (!channel) return undefined
  const stripped = field.id.replace(/^(amazon|ebay)_/, '')
  return (row: BulkProduct) => {
    const cl = (row as any)._channelListing
    if (!cl) return null
    return cl[stripped] ?? null
  }
}

/** For category-attribute fields (attr_armorType, attr_dotCertification…),
 *  the value lives in row.categoryAttributes[stripped] (jsonb). */
function categoryAttrAccessorFn(field: FieldDef) {
  const stripped = field.id.replace(/^attr_/, '')
  return (row: BulkProduct) => {
    const ca = row.categoryAttributes as Record<string, unknown> | null | undefined
    if (!ca) return null
    return ca[stripped] ?? null
  }
}

/** Whether this product can carry the field's category attribute.
 *  attr_* fields are productType-specific — e.g. attr_dotCertification
 *  only applies to HELMET. For everything else this is true. */
function fieldAppliesToProduct(field: FieldDef, row: BulkProduct): boolean {
  if (!field.productTypes || field.productTypes.length === 0) return true
  const pt = row.productType ?? null
  if (!pt) return false
  return field.productTypes.includes(pt)
}

function buildColumnFromField(field: FieldDef): ColumnDef<BulkProduct> {
  const size = field.width ?? 120
  // Stash the FieldDef on meta so the header row can reach helpText
  // and the editable flag without recomputing per-render.
  const meta = { fieldDef: field }

  const isChannelField = !!field.channel
  const isCategoryAttrField = field.id.startsWith('attr_')

  // ── SKU column gets hierarchy-aware rendering in hierarchy mode ──
  if (field.id === 'sku') {
    return {
      id: field.id,
      accessorKey: field.id as string,
      header: field.label,
      size,
      meta,
      cell: (ctx) => <SkuCell ctx={ctx} field={field} />,
    }
  }

  // For channel-scoped fields, use accessorFn → row._channelListing.<stripped>.
  // For category-attr fields, use accessorFn → row.categoryAttributes[stripped].
  // For regular Product fields, use accessorKey → row[field.id].
  const accessor = isChannelField
    ? { accessorFn: channelAccessorFn(field) }
    : isCategoryAttrField
    ? { accessorFn: categoryAttrAccessorFn(field) }
    : { accessorKey: field.id as string }

  if (field.editable) {
    const editMeta = fieldToMeta(field)
    const editRenderer = makeEditableRenderer(editMeta)
    // For channel fields without marketplace context, show
    // "Select marketplace" placeholder instead of the editable cell.
    if (isChannelField) {
      return {
        id: field.id,
        ...accessor,
        header: field.label,
        size,
        meta,
        cell: (ctx) => {
          if (!hasMarketplaceContextRef.current) {
            return (
              <span className="px-2 text-[11px] italic text-amber-600 truncate">
                Select marketplace
              </span>
            )
          }
          return editRenderer(ctx)
        },
      } as ColumnDef<BulkProduct>
    }
    // For category-attribute fields, gate on productType. Products of
    // a different type (or no type) get a non-editable "—" cell so the
    // column can stay visible for mixed grids without surprising edits.
    if (isCategoryAttrField) {
      return {
        id: field.id,
        ...accessor,
        header: field.label,
        size,
        meta,
        cell: (ctx) => {
          if (!fieldAppliesToProduct(field, ctx.row.original)) {
            return (
              <span className="px-2 text-[12px] text-slate-300 truncate">
                —
              </span>
            )
          }
          return editRenderer(ctx)
        },
      } as ColumnDef<BulkProduct>
    }
    // For aggregatable fields (totalStock, basePrice), parents in
    // hierarchy mode show a computed display instead of the editable
    // cell — children render normally.
    if (isAggregatableField(field.id)) {
      return {
        id: field.id,
        ...accessor,
        header: field.label,
        size,
        meta,
        cell: (ctx) => {
          const row = ctx.row.original as Partial<HierarchyRow>
          const hier = row._hier
          if (
            hierarchyCtxRef.current.mode === 'hierarchy' &&
            hier?.level === 0 &&
            hier.hasChildren
          ) {
            const display = aggregateDisplayValue(row as HierarchyRow, field.id)
            return (
              <span className="px-2 text-[12px] tabular-nums italic text-slate-500 truncate">
                {display ?? '—'}
              </span>
            )
          }
          return editRenderer(ctx)
        },
      } as ColumnDef<BulkProduct>
    }
    return {
      id: field.id,
      ...accessor,
      header: field.label,
      size,
      meta,
      cell: editRenderer,
    } as ColumnDef<BulkProduct>
  }

  return {
    id: field.id,
    ...accessor,
    header: field.label,
    size,
    meta,
    cell: ({ getValue }) => <ReadOnlyCell value={getValue()} field={field} />,
  } as ColumnDef<BulkProduct>
}

// Module-level ref so cell renderers can check marketplace context
// presence without taking it as a prop. Bumped from the component below.
const hasMarketplaceContextRef: { current: boolean } = { current: false }

// ── SKU cell with hierarchy-aware chrome ──────────────────────────────
function SkuCell({
  ctx,
  field,
}: {
  ctx: CellContext<BulkProduct, unknown>
  field: FieldDef
}) {
  const sku = ctx.getValue<string>()
  const row = ctx.row.original as Partial<HierarchyRow>
  const hier = row._hier
  const inHierarchy = hierarchyCtxRef.current.mode === 'hierarchy' && hier
  const isParent = !!hier?.hasChildren
  const indent = (hier?.level ?? 0) * 24

  if (!inHierarchy) {
    return (
      <ReadOnlyCell
        value={sku}
        field={field}
      />
    )
  }

  // For child rows in hierarchy mode, the variation pairs (Size/Color
  // etc.) sit adjacent to the SKU so the SKU truncates first and the
  // badges keep their natural width. Capped at 3 visible; any extras
  // collapse into a +N pill whose title tooltip lists them all.
  const variationPairs =
    hier && hier.level > 0 && hier.variations
      ? Object.entries(hier.variations)
      : []
  const visibleVariations = variationPairs.slice(0, 3)
  const hiddenVariations = variationPairs.slice(3)

  return (
    <div
      className="flex items-center gap-1.5 h-full text-[13px]"
      style={{ paddingLeft: indent + 12 }}
    >
      {isParent ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            hierarchyCtxRef.current.onToggle(row.id ?? '')
          }}
          className="w-5 h-5 flex items-center justify-center rounded hover:bg-slate-200 text-slate-500 hover:text-slate-900 flex-shrink-0"
          title={hier?.isExpanded ? 'Collapse children' : 'Expand children'}
        >
          {hier?.isExpanded ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
        </button>
      ) : hier && hier.level > 0 ? (
        <span className="w-5 flex-shrink-0" />
      ) : null}
      <span
        className={cn(
          'font-mono text-[12px] truncate min-w-0',
          isParent ? 'text-slate-900 font-semibold' : 'text-slate-700'
        )}
      >
        {sku}
      </span>
      {isParent && (
        <Badge variant="default" size="sm" className="ml-auto flex-shrink-0">
          {hier?.childCount}
        </Badge>
      )}
      {visibleVariations.length > 0 && (
        <div className="flex items-center gap-1 flex-shrink-0">
          {visibleVariations.map(([k, v]) => (
            <span
              key={k}
              className="text-[10px] bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded font-medium whitespace-nowrap"
            >
              {k}: {v}
            </span>
          ))}
          {hiddenVariations.length > 0 && (
            <span
              className="text-[10px] bg-slate-200 text-slate-600 px-1.5 py-0.5 rounded font-medium cursor-help whitespace-nowrap"
              title={hiddenVariations
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ')}
            >
              +{hiddenVariations.length}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ── Memoized row ──────────────────────────────────────────────────────
//
// Selection is rendered as TWO absolutely-positioned overlays in the
// virtualized body (see SelectionOverlays below): one thin border for
// the range and one thick border for the active cell. That keeps the
// cells themselves entirely unaware of selection state, so changing
// the selection re-renders only those overlays — not every visible
// row. The cell wrapper just owns the click handler.
const TableRow = memo(
  function TableRow({
    row,
    rowIdx,
    top,
  }: {
    row: Row<BulkProduct>
    rowIdx: number
    top: number
    /** Bumped when the visible-column set OR sizes change; forces a
     *  re-render so body cells track header widths during a drag. */
    columnsKey: string
  }) {
    const hier = (row.original as Partial<HierarchyRow>)._hier
    const isAggregateRow =
      hierarchyCtxRef.current.mode === 'hierarchy' &&
      hier?.level === 0 &&
      hier?.hasChildren
    return (
      <div
        className="absolute left-0 right-0 flex border-b border-slate-100"
        style={{
          height: ROW_HEIGHT,
          transform: `translateY(${top}px)`,
          willChange: 'transform',
        }}
      >
        {row.getVisibleCells().map((cell, colIdx) => {
          const fieldId = (cell.column.columnDef.meta as any)?.fieldDef
            ?.id as string | undefined
          const isParentAggregateCell =
            isAggregateRow &&
            fieldId !== undefined &&
            isAggregatableField(fieldId)
          const selectable = !isParentAggregateCell
          return (
            <div
              key={cell.id}
              onMouseDown={
                selectable
                  ? (e) => {
                      if (e.button !== 0) return
                      // Shift+click extends and must not enter edit
                      // mode; let plain click bubble so EditableCell
                      // still goes into edit on the same gesture.
                      if (e.shiftKey) {
                        e.preventDefault()
                        e.stopPropagation()
                      }
                      selectCtxRef.current.select(rowIdx, colIdx, e.shiftKey)
                    }
                  : undefined
              }
              className={cn(
                'overflow-hidden border-r border-slate-100/60 last:border-r-0 relative select-none',
                selectable && 'hover:bg-slate-50',
              )}
              style={{ width: cell.column.getSize(), flexShrink: 0 }}
            >
              {flexRender(cell.column.columnDef.cell, cell.getContext())}
            </div>
          )
        })}
      </div>
    )
  },
  (prev, next) =>
    prev.row.original === next.row.original &&
    prev.rowIdx === next.rowIdx &&
    prev.top === next.top &&
    (prev as any).columnsKey === (next as any).columnsKey,
)

// Two absolutely-positioned overlays that draw the selection on top
// of the table body. Single-element renders, no per-cell re-paints.
function SelectionOverlays({
  rangeRect,
  activeRect,
}: {
  rangeRect: { top: number; left: number; width: number; height: number } | null
  activeRect: { top: number; left: number; width: number; height: number } | null
}) {
  return (
    <>
      {rangeRect && (
        <div
          className="absolute pointer-events-none border border-blue-400 bg-blue-50/40 z-10"
          style={rangeRect}
        />
      )}
      {activeRect && (
        <div
          className="absolute pointer-events-none border-2 border-blue-600 z-20"
          style={activeRect}
        />
      )}
    </>
  )
}

function SkeletonRow({ top, colCount }: { top: number; colCount: number }) {
  return (
    <div
      className="absolute left-0 right-0 flex border-b border-slate-100 animate-pulse"
      style={{ height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
    >
      {Array.from({ length: colCount }).map((_, i) => (
        <div key={i} className="flex items-center px-3" style={{ width: 120, flexShrink: 0 }}>
          <div className="h-3 bg-slate-200 rounded w-3/4" />
        </div>
      ))}
    </div>
  )
}

export default function BulkOperationsClient() {
  const [products, setProducts] = useState<BulkProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fetchMs, setFetchMs] = useState<number | null>(null)

  const [changes, setChanges] = useState<Map<string, CellChange>>(new Map())
  const [cellErrors, setCellErrors] = useState<Map<string, string>>(new Map())
  const [resetKeys, setResetKeys] = useState<Map<string, number>>(new Map())
  const [cascadeModal, setCascadeModal] = useState<CascadeModalState | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
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
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())

  // ── D.3d: marketplace context state ─────────────────────────────
  const [marketplaceContext, setMarketplaceContext] =
    useState<MarketplaceContext | null>(null)
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
  const select = useCallback(
    (rowIdx: number, colIdx: number, shift: boolean) => {
      setSelection((prev) =>
        shift && prev.anchor
          ? { anchor: prev.anchor, active: { rowIdx, colIdx } }
          : {
              anchor: { rowIdx, colIdx },
              active: { rowIdx, colIdx },
            },
      )
    },
    [],
  )
  selectCtxRef.current.select = select
  const rangeBounds = useMemo(() => {
    if (!selection.anchor || !selection.active) return null
    return {
      minRow: Math.min(selection.anchor.rowIdx, selection.active.rowIdx),
      maxRow: Math.max(selection.anchor.rowIdx, selection.active.rowIdx),
      minCol: Math.min(selection.anchor.colIdx, selection.active.colIdx),
      maxCol: Math.max(selection.anchor.colIdx, selection.active.colIdx),
    }
  }, [selection])
  const selectedCellCount = useMemo(() => {
    if (!rangeBounds) return 0
    return (
      (rangeBounds.maxRow - rangeBounds.minRow + 1) *
      (rangeBounds.maxCol - rangeBounds.minCol + 1)
    )
  }, [rangeBounds])

  // Hydrate localStorage state on mount
  useEffect(() => {
    setSavedViews(loadAllViews())
    const id = getActiveViewId()
    setActiveViewIdState(id)
    const view =
      loadAllViews().find((v) => v.id === id) ?? DEFAULT_VIEWS[0]
    setVisibleColumnIds(view.columnIds)
    if (view.channels) setEnabledChannels(view.channels)
    if (view.productTypes) setEnabledProductTypes(view.productTypes)
    setDisplayMode(loadDisplayMode())
    setExpandedParents(loadExpandedParents())
    const onChange = () => setSavedViews(loadAllViews())
    window.addEventListener('nexus:views-changed', onChange)
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
  hasMarketplaceContextRef.current = marketplaceContext !== null

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

  /** Add or update an entry in the changesMap. Drops the entry when the
   * new value matches the original (revert). Updates cascade tracking
   * + clears stale cell errors. Common code path used by both direct
   * commits and the cascade modal's "Apply" handler. */
  const writeChange = useCallback(
    (rowId: string, columnId: string, newValue: unknown, cascade: boolean) => {
      const key = `${rowId}:${columnId}`
      const product = productsRef.current.find((p) => p.id === rowId)
      if (!product) return
      const oldValue = (product as unknown as Record<string, unknown>)[columnId]

      setChanges((prev) => {
        const next = new Map(prev)
        if (looselyEqual(newValue, oldValue)) {
          next.delete(key)
        } else {
          next.set(key, {
            rowId,
            columnId,
            oldValue,
            newValue,
            cascade,
            timestamp: Date.now(),
          })
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
    },
    []
  )

  // Cascade-aware commit. Decides whether to write directly or open
  // the choice modal. Modal appears only when:
  //   - hierarchy or grouped display mode
  //   - target row has children (is a master with kids)
  //   - the cell isn't an aggregate (those aren't editable on parents)
  const handleCommit = useCallback(
    (rowId: string, columnId: string, newValue: unknown) => {
      const product = productsRef.current.find((p) => p.id === rowId)
      if (!product) return
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
  editCtxRef.current = {
    onCommit: handleCommit,
    cellErrors,
    resetKeys,
    cascadeKeys,
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

    // Body includes marketplaceContext when we have one — needed by
    // backend to upsert ChannelListing rows for channel-prefixed
    // fields.
    const body: any = { changes: changesArray }
    if (marketplaceContext) body.marketplaceContext = marketplaceContext

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
    } catch (err: any) {
      setSaveStatus({ kind: 'error', message: err?.message ?? String(err) })
    }
  }, [saveStatus.kind, marketplaceContext])

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

  // Refetch products when marketplace context changes — bulk-fetch
  // includes _channelListing per row when channel + marketplace params
  // are set, so amazon_*/ebay_* cells render real values.
  useEffect(() => {
    let cancelled = false
    const params = new URLSearchParams()
    if (marketplaceContext) {
      params.set('channel', marketplaceContext.channel)
      params.set('marketplace', marketplaceContext.marketplace)
    }
    const qs = params.toString()
    fetch(
      `${getBackendUrl()}/api/products/bulk-fetch${qs ? `?${qs}` : ''}`,
      { cache: 'no-store' }
    )
      .then(async (res) => (res.ok ? res.json() : { products: [] }))
      .then((data) => {
        if (cancelled) return
        setProducts(Array.isArray(data.products) ? data.products : [])
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketplaceContext?.channel, marketplaceContext?.marketplace])

  // Refetch fields when channels/productTypes/marketplace change.
  // D.3g: passing `marketplace` lets the backend pull live category
  // attributes from cached Amazon schemas (CategorySchema). Without
  // it we get the static fallback set only.
  useEffect(() => {
    const params = new URLSearchParams()
    if (enabledChannels.length) params.set('channels', enabledChannels.join(','))
    if (enabledProductTypes.length)
      params.set('productTypes', enabledProductTypes.join(','))
    if (marketplaceContext?.marketplace) {
      params.set('marketplace', marketplaceContext.marketplace)
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
  }, [enabledChannels, enabledProductTypes, marketplaceContext?.marketplace])

  // ── Build columns dynamically from registry + visibility ──────────
  const fieldsById = useMemo(() => {
    const m = new Map<string, FieldDef>()
    for (const f of allFields) m.set(f.id, f)
    return m
  }, [allFields])

  const dynamicColumns = useMemo<ColumnDef<BulkProduct>[]>(() => {
    const out: ColumnDef<BulkProduct>[] = []
    for (const id of visibleColumnIds) {
      const field = fieldsById.get(id)
      if (!field) continue
      out.push(buildColumnFromField(field))
    }
    return out
  }, [visibleColumnIds, fieldsById])

  // Bumped whenever the column set actually changes; passed to TableRow
  // so memoized rows know to re-render on column changes. We use a
  // stable string key — when it changes, the memo comparator sees a
  // different value and re-runs.
  // Include columnSizing in the fingerprint so a header drag also
  // re-renders TableRow (whose memo comparator otherwise sees no
  // change in props and keeps the body cells at the old widths).
  const columnsKey = useMemo(
    () => `${visibleColumnIds.join('|')}#${JSON.stringify(columnSizing)}`,
    [visibleColumnIds, columnSizing],
  )

  const tableMinWidth = useMemo(
    () => dynamicColumns.reduce((sum, c) => sum + (c.size ?? 120), 0),
    [dynamicColumns]
  )

  // Build display rows based on mode
  const displayRows = useMemo(() => {
    if (displayMode !== 'hierarchy') return products
    return buildHierarchy(products, expandedParents)
  }, [products, displayMode, expandedParents])

  const table = useReactTable({
    data: displayRows as BulkProduct[],
    columns: dynamicColumns,
    getCoreRowModel: getCoreRowModel(),
    enableColumnResizing: true,
    columnResizeMode: 'onChange',
    state: { columnSizing },
    onColumnSizingChange: setColumnSizing,
    defaultColumn: { minSize: 60, maxSize: 600 },
  })

  const rows = table.getRowModel().rows

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
    channelFieldsVisible && marketplaceContext === null

  const hasUnsavablePendingChanges =
    marketplaceContext === null && pendingChannelChanges > 0

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
      setVisibleColumnIds(view.columnIds)
      setEnabledChannels(view.channels ?? [])
      setEnabledProductTypes(view.productTypes ?? [])
    },
    [savedViews]
  )

  const handleSaveAsView = useCallback(
    (name: string) => {
      const id = `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
      const view = saveUserView({
        id,
        name,
        columnIds: visibleColumnIds,
        channels: enabledChannels,
        productTypes: enabledProductTypes,
      })
      setSavedViews(loadAllViews())
      setActiveViewIdState(view.id)
      setActiveViewId(view.id)
    },
    [visibleColumnIds, enabledChannels, enabledProductTypes]
  )

  const handleDeleteView = useCallback(
    (id: string) => {
      if (isDefaultView(id)) return
      deleteUserView(id)
      setSavedViews(loadAllViews())
      if (activeViewIdState === id) {
        handleSelectView(DEFAULT_VIEWS[0].id)
      }
    },
    [activeViewIdState, handleSelectView]
  )

  return (
    <div className="flex-1 min-h-0 px-6 pb-6 flex flex-col">
      {!online && (
        <div className="flex-shrink-0 mb-3 flex items-center gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-md text-[12px] text-amber-800">
          <WifiOff className="w-3.5 h-3.5 flex-shrink-0" />
          <span>You're offline. Changes are kept locally and will save when you reconnect.</span>
        </div>
      )}

      <MarketplaceContextBanner
        visible={showContextBanner}
        pendingChannelChanges={pendingChannelChanges}
      />

      <div className="flex-shrink-0 mb-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <DisplayModeToggle mode={displayMode} onChange={setDisplayMode} />
          {displayMode === 'hierarchy' && (
            <ExpandCollapseControls
              products={products}
              expandedParents={expandedParents}
              onChange={setExpandedParents}
            />
          )}
          <span className="text-[12px] text-slate-500">
            {loading
              ? 'Loading…'
              : `${products.length.toLocaleString()} rows · ${visibleColumnIds.length}/${allFields.length} cols · Cmd+S to save`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <MarketplaceSelector
            value={marketplaceContext}
            onChange={setMarketplaceContext}
            options={marketplaceOptions}
            pulse={showContextBanner}
          />
          {Object.keys(columnSizing).length > 0 && (
            <button
              type="button"
              onClick={resetColumnWidths}
              title="Reset column widths to defaults"
              className="inline-flex items-center gap-1 h-7 px-2 text-[11px] text-slate-600 border border-slate-200 rounded-md hover:bg-slate-50 hover:text-slate-900"
            >
              <RotateCcw className="w-3 h-3" />
              Reset widths
            </button>
          )}
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

      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto bg-white border border-slate-200 rounded-lg select-none"
        style={{ contain: 'strict' }}
      >
        <div
          className="sticky top-0 z-20 bg-slate-50 border-b border-slate-200 flex"
          style={{ height: HEADER_HEIGHT, minWidth: tableMinWidth }}
        >
          {headerCells.map((header) => {
            const fieldDef = (header.column.columnDef.meta as
              | { fieldDef?: FieldDef }
              | undefined)?.fieldDef
            const isReadOnly = fieldDef && !fieldDef.editable
            const isResizing = header.column.getIsResizing()
            return (
              <div
                key={header.id}
                className="relative flex items-center gap-1 px-3 border-r border-slate-200/70 last:border-r-0 text-[11px] font-semibold text-slate-700 uppercase tracking-wider"
                style={{ width: header.getSize(), flexShrink: 0 }}
                title={fieldDef?.helpText}
              >
                <span className="truncate">
                  {flexRender(
                    header.column.columnDef.header,
                    header.getContext()
                  )}
                </span>
                {isReadOnly && (
                  <Lock
                    className="w-2.5 h-2.5 text-slate-400 flex-shrink-0"
                    aria-label="Read-only"
                  />
                )}
                {/* Resize handle — sits on the right border. Calls
                 *  TanStack's getResizeHandler to track mousedown and
                 *  drive column.size via the columnSizing state. */}
                <div
                  onMouseDown={header.getResizeHandler()}
                  onTouchStart={header.getResizeHandler()}
                  onClick={(e) => e.stopPropagation()}
                  className={cn(
                    'absolute top-0 bottom-0 w-1.5 cursor-col-resize select-none touch-none',
                    'right-0 -mr-[3px] z-10',
                    isResizing
                      ? 'bg-blue-500'
                      : 'bg-transparent hover:bg-blue-500/60',
                  )}
                />
              </div>
            )
          })}
        </div>

        <div className="relative" style={{ height: totalSize, minWidth: tableMinWidth }}>
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            if (loading)
              return (
                <SkeletonRow
                  key={vRow.key}
                  top={vRow.start}
                  colCount={dynamicColumns.length || 7}
                />
              )
            const row = rows[vRow.index]
            return (
              <TableRow
                key={row.id}
                row={row}
                rowIdx={vRow.index}
                top={vRow.start}
                columnsKey={columnsKey}
              />
            )
          })}
          <SelectionOverlays rangeRect={rangeRect} activeRect={activeRect} />
        </div>

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/90">
            <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-2">
              Failed to load: {error}
            </div>
          </div>
        )}
      </div>

      <StatusBar
        status={saveStatus}
        pendingCount={pendingCount}
        fetchMs={fetchMs}
        loading={loading}
        selectedCellCount={selectedCellCount}
      />

      <PreviewChangesModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        changes={changes}
        products={products}
      />

      <CascadeChoiceModal
        open={cascadeModal !== null}
        fieldLabel={cascadeModal?.fieldLabel ?? ''}
        oldValue={cascadeModal?.oldValue}
        newValue={cascadeModal?.newValue}
        parentSku={cascadeModal?.parentSku ?? ''}
        children={cascadeModal?.children ?? []}
        onApply={handleCascadeApply}
        onCancel={handleCascadeCancel}
      />
    </div>
  )
}

function StatusBar({
  status,
  pendingCount,
  fetchMs,
  loading,
  selectedCellCount,
}: {
  status: SaveStatus
  pendingCount: number
  fetchMs: number | null
  loading: boolean
  /** 0 when nothing is selected; otherwise how many cells the
   *  current range covers. */
  selectedCellCount: number
}) {
  const left = (() => {
    if (loading) return <span>Fetching…</span>
    if (status.kind === 'saving')
      return (
        <span>
          Saving {pendingCount} change{pendingCount === 1 ? '' : 's'}…
        </span>
      )
    if (status.kind === 'saved')
      return (
        <span className="flex items-center gap-1.5 text-green-700">
          <CheckCircle2 className="w-3 h-3" />
          Saved {status.count} change{status.count === 1 ? '' : 's'}
        </span>
      )
    if (status.kind === 'partial')
      return (
        <span className="flex items-center gap-1.5 text-amber-700">
          <AlertCircle className="w-3 h-3" />
          Saved {status.saved}, {status.failed} failed — see red cells
        </span>
      )
    if (status.kind === 'error')
      return (
        <span className="flex items-center gap-1.5 text-red-700">
          <AlertCircle className="w-3 h-3" />
          Save failed: {status.message}
        </span>
      )
    if (pendingCount > 0)
      return (
        <span>
          {pendingCount} unsaved change{pendingCount === 1 ? '' : 's'} ·{' '}
          <kbd className="text-[10px] bg-slate-100 px-1 rounded">Cmd+S</kbd> to save
        </span>
      )
    return <span>All changes saved</span>
  })()

  return (
    <div
      className={cn(
        'flex-shrink-0 mt-2 flex items-center justify-between text-[11px] px-1',
        status.kind === 'saved' && 'text-green-700',
        status.kind === 'partial' && 'text-amber-700',
        status.kind === 'error' && 'text-red-700',
        status.kind !== 'saved' &&
          status.kind !== 'partial' &&
          status.kind !== 'error' &&
          'text-slate-500'
      )}
    >
      <span className="flex items-center gap-1.5">{left}</span>
      <span className="flex items-center gap-3 text-slate-500">
        {selectedCellCount > 1 && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 border border-blue-200 rounded text-[12px]">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-600" />
            <span className="text-blue-900 tabular-nums">
              {selectedCellCount} cells selected
            </span>
          </span>
        )}
        {fetchMs != null && <span>Initial fetch: {fetchMs}ms</span>}
      </span>
    </div>
  )
}

function looselyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  if (typeof a === 'number' && typeof b === 'number') return a === b
  return String(a) === String(b)
}

function DisplayModeToggle({
  mode,
  onChange,
}: {
  mode: DisplayMode
  onChange: (m: DisplayMode) => void
}) {
  const opts: Array<{ id: DisplayMode; label: string; tooltip: string; disabled?: boolean }> = [
    { id: 'flat', label: 'Flat', tooltip: 'All products in a single list' },
    {
      id: 'hierarchy',
      label: 'Hierarchy',
      tooltip: 'Parents and children grouped — click chevrons to expand',
    },
    {
      id: 'grouped',
      label: 'Grouped Edit',
      tooltip: 'Hierarchical with cascade editing — ships in D.3c',
      disabled: true,
    },
  ]
  return (
    <div className="flex items-center gap-0.5 border border-slate-200 rounded-md p-0.5 bg-white">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          disabled={o.disabled}
          onClick={() => !o.disabled && onChange(o.id)}
          title={o.tooltip}
          className={cn(
            'h-6 px-2.5 text-[11px] rounded transition-colors',
            mode === o.id
              ? 'bg-slate-100 text-slate-900 font-semibold'
              : 'text-slate-600 hover:text-slate-900',
            o.disabled && 'opacity-40 cursor-not-allowed'
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function ExpandCollapseControls({
  products,
  expandedParents,
  onChange,
}: {
  products: BulkProduct[]
  expandedParents: Set<string>
  onChange: (s: Set<string>) => void
}) {
  // Compute parent IDs from products (those that are parented BY children)
  const parentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const p of products) {
      if (p.parentId) ids.add(p.parentId)
    }
    return ids
  }, [products])

  return (
    <div className="flex items-center gap-2 text-[11px] text-slate-500">
      <button
        type="button"
        onClick={() => onChange(new Set(parentIds))}
        className="hover:text-slate-900"
      >
        Expand all
      </button>
      <span className="text-slate-300">·</span>
      <button
        type="button"
        onClick={() => onChange(new Set())}
        className="hover:text-slate-900"
      >
        Collapse all
      </button>
      <span className="text-slate-400 tabular-nums">
        {expandedParents.size}/{parentIds.size} expanded
      </span>
    </div>
  )
}

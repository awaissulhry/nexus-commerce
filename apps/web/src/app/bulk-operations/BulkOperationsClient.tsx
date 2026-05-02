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
import {
  EditableCell,
  editHandlers,
  editKey,
  type EditableMeta,
} from './EditableCell'
import PreviewChangesModal from './PreviewChangesModal'
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
import {
  isDimFieldId,
  isWeightFieldId,
  parseDimension,
  parseWeight,
} from './lib/unit-parsing'
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
  gtin?: string | null
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
  /** Step 3.5: Enter / Tab inside the input commits then moves the
   *  selection by this delta (Excel semantics). */
  onCommitNavigate: (dRow: number, dCol: number) => void
}

const editCtxRef: { current: EditCtx } = {
  current: {
    onCommit: () => {},
    cellErrors: new Map(),
    resetKeys: new Map(),
    cascadeKeys: new Set(),
    onCommitNavigate: () => {},
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

// ── Selection ctx (Step 1 + Step 2) ──────────────────────────────────
// Selection lives in React state but we expose the imperative
// callbacks through a module-level ref so the cell-wrapper handler
// can stay stable across renders (no extra prop on TableRow's memo).
interface SelectCtx {
  select: (rowIdx: number, colIdx: number, shift: boolean) => void
  /** Step 2: arm the document-level mousemove/mouseup listeners
   *  for click+drag rectangle selection. Called on plain mousedown
   *  (not shift-click). */
  beginDrag: (rowIdx: number, colIdx: number) => void
}

const selectCtxRef: { current: SelectCtx } = {
  current: { select: () => {}, beginDrag: () => {} },
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

interface SelectionMetrics {
  /** Total cells in the rectangle (numeric + non-numeric). */
  count: number
  /** True when count > 1000 — the heavy iteration is skipped to keep
   *  drag-selection responsive, only `count` is populated. */
  isLarge?: boolean
  numericCount?: number
  sum?: number
  avg?: number
  min?: number
  max?: number
}

/**
 * Whole numbers render without a decimal; everything else renders to
 * 2 decimals max. Currency-style summaries stay tidy without forcing
 * "5" into "5.00".
 */
function formatMetric(n: number): string {
  if (Number.isInteger(n)) return n.toString()
  return n.toFixed(2)
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
        onCommitNavigate={editCtxRef.current.onCommitNavigate}
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
  // D.3j: weight + dimension fields are typed as 'number' in the
  // registry but rendered as text inputs so the user can type "5kg"
  // or "60cm". The smart-parsing in handleCommit splits the unit
  // suffix into the corresponding *Unit column. defaultParse keeps
  // the raw string in draftValue; the cell renders the plain number
  // returned by the server in read mode.
  if (isWeightFieldId(field.id) || isDimFieldId(field.id)) {
    return {
      editable: true,
      fieldType: 'text',
      numeric: true,
      format: (v) => (v === null || v === undefined ? '' : String(v)),
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
        <div className="ml-auto flex items-center gap-1 flex-shrink-0">
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
              data-row-idx={rowIdx}
              data-col-idx={colIdx}
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
                      // Step 2: arm the document-level drag handlers
                      // for rectangle selection.
                      if (!e.shiftKey) {
                        selectCtxRef.current.beginDrag(rowIdx, colIdx)
                      }
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
      const didMove = !!s?.didMove
      dragStateRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      // If the drag actually moved across cells, suppress the click
      // that follows so EditableCell at the drop target doesn't enter
      // edit mode for what was clearly a select-rectangle gesture.
      if (didMove) {
        const onClickOnce = (ce: MouseEvent) => {
          ce.stopPropagation()
          ce.preventDefault()
          document.removeEventListener('click', onClickOnce, true)
        }
        document.addEventListener('click', onClickOnce, true)
      }
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
        requestEditAt(sel.active.rowIdx, sel.active.colIdx, '')
        return
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [moveSelection, requestEditAt])

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
      for (const c of curr.plan) {
        editHandlers.get(editKey(c.rowId, c.columnId))?.applyValue(c.newValue)
        writeChange(c.rowId, c.columnId, c.newValue, false)
        if (c.rowIdx < minR) minR = c.rowIdx
        if (c.rowIdx > maxR) maxR = c.rowIdx
        if (c.colIdx < minC) minC = c.colIdx
        if (c.colIdx > maxC) maxC = c.colIdx
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
  }, [writeChange])
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
  selectionMetrics,
  copyFlashCount,
}: {
  status: SaveStatus
  pendingCount: number
  fetchMs: number | null
  loading: boolean
  /** 0 when nothing is selected; otherwise how many cells the
   *  current range covers. */
  selectedCellCount: number
  /** Step 6: Sum/Avg/Min/Max etc. Null when no selection or only
   *  the large-selection count is available. */
  selectionMetrics: SelectionMetrics | null
  /** Non-null for ~2s after a successful copy — drives the green
   *  "Copied N cells" pill. */
  copyFlashCount: number | null
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
      <span className="flex items-center gap-2 text-slate-500 text-[12px]">
        {copyFlashCount != null ? (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-green-50 border border-green-200 rounded">
            <CheckCircle2 className="w-3 h-3 text-green-600" />
            <span className="text-green-900 tabular-nums">
              Copied {copyFlashCount} cell{copyFlashCount === 1 ? '' : 's'}
            </span>
          </span>
        ) : selectedCellCount > 0 ? (
          <>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-blue-50 border border-blue-200 rounded">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-600" />
              <span className="text-blue-900 tabular-nums">
                {selectedCellCount === 1
                  ? '1 cell · Enter or type to edit'
                  : `${selectedCellCount} cells`}
              </span>
            </span>
            {selectionMetrics?.isLarge && (
              <span className="text-slate-400 italic">
                large selection — metrics off
              </span>
            )}
            {selectionMetrics &&
              !selectionMetrics.isLarge &&
              selectionMetrics.numericCount !== undefined &&
              selectionMetrics.numericCount > 0 && (
                <>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500">Sum:</span>
                  <span className="font-semibold text-slate-700 tabular-nums">
                    {formatMetric(selectionMetrics.sum!)}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500">Avg:</span>
                  <span className="font-semibold text-slate-700 tabular-nums">
                    {formatMetric(selectionMetrics.avg!)}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500">Min:</span>
                  <span className="font-semibold text-slate-700 tabular-nums">
                    {formatMetric(selectionMetrics.min!)}
                  </span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-500">Max:</span>
                  <span className="font-semibold text-slate-700 tabular-nums">
                    {formatMetric(selectionMetrics.max!)}
                  </span>
                  {selectionMetrics.numericCount <
                    selectionMetrics.count && (
                    <span className="text-slate-400 italic">
                      ({selectionMetrics.numericCount} numeric)
                    </span>
                  )}
                </>
              )}
          </>
        ) : null}
        {fetchMs != null && <span>Initial fetch: {fetchMs}ms</span>}
      </span>
    </div>
  )
}

/**
 * RFC 4180-style escaping applied to TSV. If a cell value contains a
 * tab, newline, or double-quote, the whole cell is wrapped in double
 * quotes and embedded quotes are doubled. Otherwise it's emitted as
 * plain text. Excel, Sheets, Numbers and Notion all paste this format
 * back into their grids correctly.
 */
function toTsvCell(value: unknown): string {
  if (value == null) return ''
  const str = String(value)
  if (/[\t\n"]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

/**
 * Inverse of toTsvCell: parse a TSV string into a 2D grid handling
 * RFC 4180 quoting, escaped "" inside quoted cells, and CRLF / LF /
 * CR as row separators. Tabs separate cells.
 */
function parseTsv(text: string): string[][] {
  const result: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      cell += ch
      i++
      continue
    }
    if (ch === '"' && cell === '') {
      inQuotes = true
      i++
      continue
    }
    if (ch === '\t') {
      row.push(cell)
      cell = ''
      i++
      continue
    }
    if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell)
      result.push(row)
      row = []
      cell = ''
      i += 2
      continue
    }
    if (ch === '\n' || ch === '\r') {
      row.push(cell)
      result.push(row)
      row = []
      cell = ''
      i++
      continue
    }
    cell += ch
    i++
  }
  // Flush trailing cell — but don't push a phantom empty row when the
  // input ended with a final newline.
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    result.push(row)
  }
  return result
}

/** Coerce a raw clipboard string to the target field's value type. */
function coercePasteValue(
  raw: string,
  field: FieldDef | undefined,
): { value: unknown; error?: string } {
  if (!field) return { value: raw }
  const trimmed = raw.trim()
  if (trimmed === '') return { value: null }
  if (field.type === 'number') {
    const num = Number(trimmed)
    if (Number.isNaN(num)) return { value: null, error: 'Not a number' }
    return { value: num }
  }
  if (field.type === 'select' && field.options && field.options.length > 0) {
    if (!field.options.includes(trimmed)) {
      return {
        value: null,
        error: `Must be one of: ${field.options.slice(0, 6).join(', ')}${
          field.options.length > 6 ? '…' : ''
        }`,
      }
    }
    return { value: trimmed }
  }
  return { value: trimmed }
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

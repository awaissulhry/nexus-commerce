'use client'

/**
 * P.1f — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. The biggest single piece of the
 * workspace by far, coupling-wise: TanStack-virtual table rows,
 * the per-cell switch renderer, drag-resize column handles, and the
 * right-click context menu all live together because they share the
 * memo + context boundary.
 *
 * G.0 — the core VirtualizedGrid infrastructure (column resize, row
 * virtualizer, context menu state, flat-row construction, GridRow)
 * has been extracted to @/app/_shared/grid-lens/VirtualizedGrid.
 * This file keeps:
 *   - Product-specific cell renderer (ProductCell + EditableCell + EditSplitButton)
 *   - DraggableHandle + DroppableRowOverlay (@dnd-kit, product-specific)
 *   - RowContextMenu (product actions: status flip, duplicate)
 *   - IT_TERMS Italian glossary
 *   - A VirtualizedGrid re-export wrapper with the SAME props interface as
 *     before so ProductsWorkspace.tsx needs zero changes.
 *
 * Public surface:
 *   - VirtualizedGrid — the only export consumed externally (by
 *     GridLens in ProductsWorkspace.tsx). Accepts the products + a
 *     bag of selection / expand / sort callbacks plus `searchTerm`
 *     and `riskFlaggedSkus` for cell-level highlight + risk badges.
 */

import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  GripVertical,
  Layers,
  Pencil,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react'
import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core'
import { Badge } from '@/components/ui/Badge'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { InlineEditTrigger } from '@/components/ui/InlineEditTrigger'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'
import { useTranslations } from '@/lib/i18n/use-translations'
import {
  type Density,
} from '@/lib/products/theme'
import type { ProductRow as ProductRowType } from '../_types'
import type { ColumnDef } from '../_columns'
import {
  VirtualizedGrid as SharedVirtualizedGrid,
  SearchContext,
  RiskFlaggedContext,
} from '@/app/_shared/grid-lens/VirtualizedGrid'
import { ProductIdentityCell, StockSplit, Thumbnail } from '@/app/_shared/grid-lens'

// Italian terminology lookup — falls back to English when not in the
// glossary. Mirrored from packages/database seed data for the brand
// glossary.
const IT_TERMS: Record<string, string> = {
  OUTERWEAR: 'Giacca',
  PANTS: 'Pantaloni',
  HELMET: 'Casco',
  BOOTS: 'Stivali',
  PROTECTIVE: 'Protezioni',
  GLOVES: 'Guanti',
  BAG: 'Borsa',
}

// ── Original VirtualizedGrid props interface ─────────────────────────────────
// Preserved verbatim so ProductsWorkspace.tsx needs zero changes.
interface VirtualizedGridProps {
  products: ProductRowType[]
  visible: ColumnDef[]
  density: Density
  cellPad: string
  selected: Set<string>
  toggleSelect: (id: string, shiftKey: boolean) => void
  toggleSelectAll: () => void
  allSelected: boolean
  sortBy: string
  onSort: (key: string) => void
  expandedParents: Set<string>
  childrenByParent: Record<string, ProductRowType[]>
  loadingChildren: Set<string>
  onToggleExpand: (parentId: string) => void
  onTagEdit: (id: string) => void
  onChanged: () => void
  focusedRowId: string | null
  /** E.14 — debounced search term, for SKU + name <mark> highlighting. */
  searchTerm: string
  /** R7.2 — set of flagged SKUs (>2σ above productType return-rate mean). */
  riskFlaggedSkus: Set<string>
  /** When true, a GripVertical drag-handle column is prepended to each
   *  row and header. Wired to @dnd-kit DraggableHandle / DroppableRowOverlay.
   *  Safe to omit on /products (no DndContext needed when false). */
  draggable?: boolean
  /** IDs of products that have a pending staged change (teal row tint). */
  stagedProductIds?: Set<string>
  /** ID of the product currently being dragged (opacity-40 row tint). */
  activeProductId?: string | null
  /** PG.6 — freeze the leading column group on horizontal scroll.
   *  Driven by the operator's Preferences-modal toggle (PG.5); default
   *  true so other workspaces inheriting this wrapper get Amazon-parity
   *  freeze for free. */
  stickyLeft?: boolean
  /** PG.6 — same shape for the trailing locked column (actions). */
  stickyRight?: boolean
}

// Sort key map — matches the original hard-coded sortKeys in VirtualizedGrid.
const PRODUCT_SORT_KEYS: Record<string, string> = {
  sku: 'sku',
  name: 'name',
  price: 'price-asc',
  stock: 'stock-asc',
  photos: 'photos-asc',
  coverage: 'channels-asc',
  variants: 'variants-asc',
  completeness: 'completeness-asc',
  updated: 'updated',
}

const noop = () => {}

/**
 * VirtualizedGrid — re-export wrapper with the original props interface.
 *
 * Delegates to the shared VirtualizedGrid from @/app/_shared/grid-lens,
 * injecting product-specific renderers via the render-prop API.
 * ProductsWorkspace.tsx continues to import this and passes the same props
 * as before — no changes required there.
 */
export function VirtualizedGrid({
  products,
  visible,
  density,
  cellPad,
  selected,
  toggleSelect,
  toggleSelectAll,
  allSelected,
  sortBy,
  onSort,
  expandedParents,
  childrenByParent,
  loadingChildren,
  onToggleExpand,
  onTagEdit,
  onChanged,
  focusedRowId,
  searchTerm,
  riskFlaggedSkus,
  draggable = false,
  stagedProductIds,
  activeProductId = null,
  stickyLeft = true,
  stickyRight = true,
}: VirtualizedGridProps) {
  // Stable renderCell so GridRow memo skips re-renders when unrelated
  // selections change. Depends on onTagEdit + onChanged so they're
  // in the dep array; both are stable refs from the workspace.
  const renderCellCb = useCallback(
    (row: ProductRowType, colKey: string, _isChild: boolean) => (
      <ProductCell
        col={colKey}
        product={row}
        onTagEdit={onTagEdit ?? noop}
        onChanged={onChanged}
      />
    ),
    [onTagEdit, onChanged],
  )

  return (
    <SharedVirtualizedGrid<ProductRowType>
      rows={products}
      visible={visible}
      density={density}
      cellPad={cellPad}
      selected={selected}
      toggleSelect={toggleSelect}
      toggleSelectAll={toggleSelectAll}
      allSelected={allSelected}
      sortBy={sortBy}
      onSort={onSort}
      sortKeys={PRODUCT_SORT_KEYS}
      expandedParents={expandedParents}
      childrenByParent={childrenByParent}
      loadingChildren={loadingChildren}
      onToggleExpand={onToggleExpand}
      focusedRowId={focusedRowId}
      searchTerm={searchTerm}
      riskFlaggedSkus={riskFlaggedSkus}
      draggable={draggable}
      stagedIds={stagedProductIds}
      activeId={activeProductId}
      storageKey="products"
      onTagEdit={onTagEdit}
      renderCell={renderCellCb}
      renderRowContextMenu={(row, onClose) => (
        <RowContextMenuContent
          product={row}
          onClose={onClose}
          onChanged={onChanged}
        />
      )}
      renderDragHandle={(row, rowBg) =>
        draggable ? <DraggableHandle product={row} rowBg={rowBg} /> : null
      }
      renderDropOverlay={(row) =>
        draggable ? <DroppableRowOverlay product={row} /> : null
      }
      stickyLeft={stickyLeft}
      stickyRight={stickyRight}
    />
  )
}

// DraggableHandle — rendered in GridRow when isDraggable=true.
// Must be a separate component so useDraggable is called consistently
// (never inside a conditional). Only mounted when isDraggable=true,
// which always means an OrganizeGridTab DndContext is an ancestor.
function DraggableHandle({
  product,
  rowBg,
}: {
  product: ProductRowType
  rowBg: string
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `drag:${product.id}`,
    data: { product },
  })
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`px-1 py-2 flex items-center justify-center touch-none select-none transition-colors ${rowBg} ${
        isDragging
          ? 'cursor-grabbing text-blue-500'
          : 'cursor-grab text-slate-300 hover:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400'
      }`}
      style={{ width: 28, minWidth: 28 }}
      role="cell"
      aria-label="Drag row"
    >
      <GripVertical size={14} />
    </div>
  )
}

// DroppableRowOverlay — absolute overlay covering a parent row's full
// area. Renders a colour-coded ring on hover:
//   green  — dragged product type matches the parent (or either is null)
//   amber  — different product types (allowed, but operator should check)
// pointer-events: none so it doesn't block clicks on row cells.
// useDndContext is safe here because this component is only mounted
// when isDraggable=true, which always means a DndContext is an ancestor.
function DroppableRowOverlay({ product }: { product: ProductRowType }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `drop:${product.id}`,
    data: { product },
  })
  const { active } = useDndContext()
  const draggingType = (active?.data.current?.product as ProductRowType | undefined)?.productType ?? null
  const compatible =
    !draggingType || !product.productType || draggingType === product.productType

  return (
    <div
      ref={setNodeRef}
      aria-hidden="true"
      className={`absolute inset-0 pointer-events-none rounded transition-all duration-100 ${
        !isOver ? '' :
        compatible
          ? 'ring-2 ring-inset ring-green-400 bg-green-50/20 dark:bg-green-950/15'
          : 'ring-2 ring-inset ring-amber-400 bg-amber-50/20 dark:bg-amber-950/15'
      }`}
    />
  )
}

// E.9 — right-click context menu content for a product row.
// The shared VirtualizedGrid handles the fixed-positioned wrapper,
// portal mounting, and dismiss logic. This component renders only
// the menu CONTENT (header + action buttons).
function RowContextMenuContent({
  product,
  onClose,
  onChanged,
}: {
  product: ProductRowType
  onClose: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const flip = async (status: 'ACTIVE' | 'DRAFT' | 'INACTIVE') => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: [product.id], status }),
      })
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'product.updated',
        meta: {
          productIds: [product.id],
          source: 'row-context-menu',
          status,
        },
      })
      onChanged()
    } finally {
      setBusy(false)
      onClose()
    }
  }
  const duplicate = async () => {
    setBusy(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/bulk-duplicate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ productIds: [product.id] }),
        },
      )
      if (!res.ok) throw new Error((await res.json()).error)
      emitInvalidation({
        type: 'product.created',
        meta: {
          sourceProductIds: [product.id],
          source: 'row-context-menu',
        },
      })
      onChanged()
    } finally {
      setBusy(false)
      onClose()
    }
  }
  const item = (
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    disabled = false,
  ) => (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={(e) => {
        e.stopPropagation()
        if (disabled || busy) return
        onClick()
      }}
      className="w-full flex items-center gap-2 h-8 px-2.5 text-base text-left rounded text-slate-700 hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent dark:text-slate-200 dark:hover:bg-slate-800"
    >
      <span
        className="text-slate-500 dark:text-slate-400"
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="flex-1">{label}</span>
    </button>
  )
  return (
    <>
      <div className="px-2.5 py-1.5 text-xs uppercase tracking-wider text-slate-500 font-semibold border-b border-slate-100 mb-1 truncate dark:text-slate-400 dark:border-slate-800">
        {product.sku}
      </div>
      {item(<Eye size={14} />, 'Open in drawer', () => {
        window.dispatchEvent(
          new CustomEvent('nexus:open-product-drawer', {
            detail: { productId: product.id },
          }),
        )
        onClose()
      })}
      {item(<ExternalLink size={14} />, 'Open edit page', () => {
        window.location.href = `/products/${product.id}/edit`
      })}
      {item(<Sparkles size={14} />, 'Open list wizard', () => {
        window.location.href = `/products/${product.id}/list-wizard`
      })}
      <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
      {product.status !== 'ACTIVE' &&
        item(<CheckCircle2 size={14} />, 'Activate', () => flip('ACTIVE'))}
      {product.status !== 'DRAFT' &&
        item(<EyeOff size={14} />, 'Set to draft', () => flip('DRAFT'))}
      {product.status !== 'INACTIVE' &&
        item(<XCircle size={14} />, 'Set to inactive', () =>
          flip('INACTIVE'),
        )}
      <div className="my-1 border-t border-slate-100 dark:border-slate-800" />
      {item(<Copy size={14} />, 'Duplicate', duplicate)}
    </>
  )
}

// R7.2 — small inline badge surfaced on flagged SKUs. Click jumps to
// the returns analytics page where the operator sees the bucket math
// (rate vs mean, σ above) and decides whether to act on the listing
// (size chart, photos, copy).
function RiskBadge({ sku }: { sku: string }) {
  const { t } = useTranslations()
  const flagged = useContext(RiskFlaggedContext)
  if (!flagged.has(sku)) return null
  return (
    <Link
      href="/fulfillment/returns/analytics"
      className="inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wider px-1 py-0.5 bg-rose-50 text-rose-700 border border-rose-200 rounded hover:bg-rose-100"
      title={t('products.grid.returnRate')}
    >
      ↩ HI
    </Link>
  )
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query || !text) return <>{text}</>
  // Case-insensitive split on the query. Escape regex metachars so
  // operators searching for SKUs with `.`, `[`, `(`, etc. don't blow
  // up the regex. Matches stay in the result array as odd-indexed
  // entries when split() includes a capturing group.
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(${escaped})`, 'ig')
  const parts = text.split(re)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark
            key={i}
            className="bg-yellow-100 text-slate-900 rounded-sm px-0.5"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

// F.5 — type-aware inline editor. Eight cells (name, status, price,
// stock, threshold, brand, productType, fulfillment) used to each
// own a ~25-line switch branch with the same editing/draft/blur/
// keyboard pattern. EDITABLE_FIELDS centralises the per-field
// metadata; <EditableCell> renders editor + display from that meta.
//
// Adding a new editable column = one entry in EDITABLE_FIELDS plus a
// case <name> in the ProductCell switch. No more copy-pasted input
// blocks per field.

interface FieldMeta {
  /** PATCH /api/products/:id field name in the request body. */
  apiField:
    | 'name'
    | 'status'
    | 'basePrice'
    | 'totalStock'
    | 'lowStockThreshold'
    | 'brand'
    | 'productType'
    | 'fulfillmentMethod'
  editor: 'text' | 'number' | 'select'
  /** Number-editor step + min. */
  step?: number
  min?: number
  /** Select-editor options (rendered as <option value="">label</option>). */
  options?: Array<{ value: string; label: string }>
  /**
   * Selects commit on change (operator picks one and the value writes
   * immediately). Text + number editors commit on blur or Enter.
   */
  commitOnChange?: boolean
  /** Tailwind classes for the <input>/<select>. Drives width + size + alignment. */
  inputClassName: string
  /** InlineEditTrigger label (read aloud by screen readers). */
  triggerLabel: string
  triggerAlign?: 'left' | 'right'
  triggerSize?: 'sm' | 'md'
  triggerHideIcon?: ((product: ProductRowType) => boolean) | boolean
  triggerWrapClass?: string
  /** Marks the cell as empty so InlineEditTrigger renders the dotted hint. */
  isEmpty?: (product: ProductRowType) => boolean
  /** Initial draft string when entering edit mode. */
  draftOf: (product: ProductRowType) => string
  /** Display rendered when not editing — receives the product + active search query. */
  display: (product: ProductRowType, searchQuery: string) => React.ReactNode
}

const EDITABLE_FIELDS: Record<string, FieldMeta> = {
  name: {
    apiField: 'name',
    editor: 'text',
    inputClassName:
      'w-full h-7 px-1.5 text-md border border-blue-300 rounded',
    triggerLabel: 'name',
    triggerAlign: 'left',
    draftOf: (p) => p.name ?? '',
    display: (p, q) => (
      <span className="text-md text-slate-900">
        <Highlight text={p.name} query={q} />
        {p.isParent && (
          <Layers size={10} className="inline ml-1 text-slate-400" />
        )}
      </span>
    ),
  },
  status: {
    apiField: 'status',
    editor: 'select',
    options: [
      { value: 'ACTIVE', label: 'ACTIVE' },
      { value: 'DRAFT', label: 'DRAFT' },
      { value: 'INACTIVE', label: 'INACTIVE' },
    ],
    commitOnChange: true,
    inputClassName: 'h-6 px-1 text-sm border border-blue-300 rounded',
    triggerLabel: 'status',
    triggerSize: 'sm',
    triggerHideIcon: true,
    triggerWrapClass: 'w-auto',
    draftOf: (p) => p.status,
    display: (p) => <StatusBadge status={p.status} size="sm" />,
  },
  price: {
    apiField: 'basePrice',
    editor: 'number',
    step: 0.01,
    inputClassName:
      'w-20 h-7 px-1.5 text-md text-right tabular-nums border border-blue-300 rounded',
    triggerLabel: 'base price',
    triggerAlign: 'right',
    draftOf: (p) => String(p.basePrice ?? ''),
    display: (p) => (
      <span className="tabular-nums">€{p.basePrice.toFixed(2)}</span>
    ),
  },
  stock: {
    apiField: 'totalStock',
    editor: 'number',
    min: 0,
    inputClassName:
      'w-16 h-7 px-1.5 text-md text-right tabular-nums border border-blue-300 rounded',
    triggerLabel: 'total stock',
    triggerAlign: 'right',
    draftOf: (p) => String(p.totalStock ?? ''),
    display: (p) => {
      const tone =
        p.totalStock === 0
          ? 'text-rose-600'
          : p.totalStock <= p.lowStockThreshold
            ? 'text-amber-600'
            : 'text-slate-900'
      return (
        <span className={`tabular-nums font-semibold ${tone}`}>
          {p.totalStock}
        </span>
      )
    },
  },
  threshold: {
    apiField: 'lowStockThreshold',
    editor: 'number',
    min: 0,
    inputClassName:
      'w-16 h-7 px-1.5 text-md text-right tabular-nums border border-blue-300 rounded',
    triggerLabel: 'low-stock threshold',
    triggerAlign: 'right',
    draftOf: (p) => String(p.lowStockThreshold ?? ''),
    display: (p) => (
      <span className="tabular-nums text-slate-500">
        {p.lowStockThreshold}
      </span>
    ),
  },
  brand: {
    // P.7 — brand is inline-editable. Free-text; datalist suggestions
    // deferred — the filter sidebar already shows the existing brand
    // list so operators have visibility when they want to stay
    // consistent.
    // U.25 — brand was text-base while name/stock/price/threshold use
    // text-md; aligned so adjacent editable cells in the same row read
    // as one type scale.
    apiField: 'brand',
    editor: 'text',
    inputClassName:
      'w-full h-7 px-1.5 text-md border border-blue-300 rounded',
    triggerLabel: 'brand',
    triggerAlign: 'left',
    isEmpty: (p) => !p.brand,
    draftOf: (p) => p.brand ?? '',
    display: (p) => (
      <span className="text-md text-slate-700 dark:text-slate-300">
        {p.brand ?? 'Add brand'}
      </span>
    ),
  },
  productType: {
    // P.7 — productType is inline-editable. The displayed label uses
    // the IT_TERMS glossary lookup; the input edits the raw English/
    // canonical key so saves go to the right value regardless of the
    // displayed translation.
    // U.25 — productType was text-sm; aligned to text-md so the row
    // reads consistently. triggerSize stayed 'sm' (it controls the
    // pencil-icon affordance, not the cell text).
    apiField: 'productType',
    editor: 'text',
    inputClassName:
      'w-full h-7 px-1.5 text-md border border-blue-300 rounded',
    triggerLabel: 'product type',
    triggerAlign: 'left',
    triggerSize: 'sm',
    isEmpty: (p) => !p.productType,
    draftOf: (p) => p.productType ?? '',
    display: (p) => (
      <span className="text-md text-slate-700 dark:text-slate-300">
        {p.productType
          ? (IT_TERMS[p.productType] ?? p.productType)
          : 'Add type'}
      </span>
    ),
  },
  fulfillment: {
    apiField: 'fulfillmentMethod',
    editor: 'select',
    options: [
      { value: '', label: '—' },
      { value: 'FBA', label: 'FBA' },
      { value: 'FBM', label: 'FBM' },
    ],
    commitOnChange: true,
    inputClassName: 'h-6 px-1 text-sm border border-blue-300 rounded',
    triggerLabel: 'fulfillment method',
    triggerSize: 'sm',
    triggerHideIcon: (p) => !!p.fulfillmentMethod,
    triggerWrapClass: 'w-auto',
    isEmpty: (p) => !p.fulfillmentMethod,
    draftOf: (p) => p.fulfillmentMethod ?? '',
    display: (p) =>
      p.fulfillmentMethod ? (
        <Badge
          variant={p.fulfillmentMethod === 'FBA' ? 'warning' : 'info'}
          size="sm"
        >
          {p.fulfillmentMethod}
        </Badge>
      ) : (
        <span className="text-sm">Set FBA/FBM</span>
      ),
  },
}

/**
 * One unified inline-edit cell. Renders the editor (input or select)
 * when in edit mode, an InlineEditTrigger wrapping the display
 * otherwise. Owns its own editing/draft/cellError state so per-cell
 * edits don't leak across rows or columns.
 *
 * The PATCH itself goes through P.7's If-Match optimistic-concurrency
 * flow — version conflicts surface as an inline rose banner under the
 * cell + a refresh trigger; transport / 5xx errors surface the same
 * way without auto-refresh.
 */
function EditableCell({
  field,
  product,
  onChanged,
}: {
  field: string
  product: ProductRowType
  onChanged: () => void
}) {
  const meta = EDITABLE_FIELDS[field]
  const searchQuery = useContext(SearchContext)
  const { t } = useTranslations()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>('')
  const [cellError, setCellError] = useState<string | null>(null)

  if (!meta) return null

  const startEdit = () => {
    setDraft(meta.draftOf(product))
    setEditing(true)
    setCellError(null)
  }

  const commit = async (rawValue?: string) => {
    const value = (rawValue ?? draft).trim()
    setEditing(false)
    // Empty values are dropped for required fields; for optional
    // (brand, productType, fulfillmentMethod, name) we send null /
    // empty string so clears go through.
    const isOptionalText =
      meta.apiField === 'brand' ||
      meta.apiField === 'productType' ||
      meta.apiField === 'fulfillmentMethod' ||
      meta.apiField === 'name'
    if (value === '' && !isOptionalText) return

    const body: Record<string, any> = {}
    if (meta.editor === 'number') {
      body[meta.apiField] = Number(value)
    } else if (
      meta.apiField === 'brand' ||
      meta.apiField === 'productType' ||
      meta.apiField === 'fulfillmentMethod'
    ) {
      // Optional string — empty becomes null so the cell can be cleared.
      body[meta.apiField] = value || null
    } else {
      body[meta.apiField] = value
    }

    try {
      // P.7 — If-Match optimistic-concurrency.
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }
      if (typeof product.version === 'number')
        headers['If-Match'] = String(product.version)
      const res = await fetch(
        `${getBackendUrl()}/api/products/${product.id}`,
        {
          method: 'PATCH',
          headers,
          body: JSON.stringify(body),
        },
      )
      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}))
        if (res.status === 409 && errJson?.code === 'VERSION_CONFLICT') {
          setCellError(
            `Another change landed first (version ${errJson.currentVersion ?? '?'}) — refreshing.`,
          )
          onChanged()
          return
        }
        throw new Error(errJson?.error ?? `Update failed (${res.status})`)
      }
      // basePrice + totalStock cascade to ChannelListing — broadcast
      // both invalidations so /listings + /bulk-operations refresh.
      const cascadesToListings =
        meta.apiField === 'basePrice' || meta.apiField === 'totalStock'
      emitInvalidation({
        type: 'product.updated',
        id: product.id,
        fields: [field],
        meta: { source: 'products-inline-edit' },
      })
      if (cascadesToListings) {
        emitInvalidation({
          type: 'listing.updated',
          meta: {
            productIds: [product.id],
            source: 'products-inline-edit',
            field,
          },
        })
      }
      setCellError(null)
      onChanged()
    } catch (e: any) {
      setCellError(e instanceof Error ? e.message : String(e))
    }
  }

  const errorBanner = cellError ? (
    <div className="mt-0.5 inline-flex items-start gap-1 px-1.5 py-0.5 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded max-w-full">
      <AlertCircle size={10} className="mt-0.5 flex-shrink-0" />
      <span className="truncate" title={cellError}>
        {cellError}
      </span>
      <button
        onClick={() => setCellError(null)}
        className="hover:bg-rose-100 rounded px-0.5"
        aria-label={t('products.grid.dismissError')}
      >
        <X size={10} />
      </button>
    </div>
  ) : null

  if (editing) {
    if (meta.editor === 'select') {
      return (
        <>
          <select
            autoFocus
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              if (meta.commitOnChange) commit(e.target.value)
            }}
            onBlur={() => setEditing(false)}
            className={meta.inputClassName}
          >
            {meta.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {errorBanner}
        </>
      )
    }
    return (
      <>
        <input
          autoFocus
          type={meta.editor === 'number' ? 'number' : 'text'}
          step={meta.step}
          min={meta.min}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
          }}
          className={meta.inputClassName}
        />
        {errorBanner}
      </>
    )
  }

  const hideIcon =
    typeof meta.triggerHideIcon === 'function'
      ? meta.triggerHideIcon(product)
      : meta.triggerHideIcon
  return (
    <>
      <InlineEditTrigger
        onClick={startEdit}
        label={meta.triggerLabel}
        align={meta.triggerAlign}
        size={meta.triggerSize}
        hideIcon={hideIcon}
        empty={meta.isEmpty?.(product)}
        className={meta.triggerWrapClass}
      >
        {meta.display(product, searchQuery)}
      </InlineEditTrigger>
      {errorBanner}
    </>
  )
}

// AM.1 — "Edit ▼" split button. Extracted as its own component so
// it can hold its own useState (calling useState inside a switch case
// in ProductCell would violate the rules of hooks).
// Parent: 4 actions. Child/standalone: 10 actions.
// Dropdown renders via portal so it escapes overflow:hidden on grid cells/rows.
// Smooth delete: inline confirm → spinner → POST bulk-soft-delete → onChanged().
function EditSplitButton({
  product,
  onChanged,
}: {
  product: ProductRowType
  onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null)
  const chevronRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { toast } = useToast()

  const needsFix = !product.isParent && product.status === 'ACTIVE' && (product.channelCount ?? 0) === 0
  const label = needsFix ? 'Fix' : 'Edit'
  // PG.8 — promoted inline icon buttons sit BEFORE the Edit label so
  // the operator's most-common follow-ups (peek in drawer, duplicate)
  // are one click, not a chevron+scan. Borders join the cluster into
  // a single segmented control.
  const inlineIconCls = 'h-7 w-7 inline-flex items-center justify-center bg-white dark:bg-slate-800 border-l-0 first:border-l first:rounded-l-md border-y border-slate-300 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700 hover:text-slate-700 transition-colors'
  const splitBtnCls = 'h-7 px-3 text-sm font-medium bg-white dark:bg-slate-800 border-l-0 border-y border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-700 inline-flex items-center transition-colors'
  const itemCls = 'w-full text-left px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed'
  const linkCls = 'block px-3 py-1.5 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'
  const deleteCls = 'w-full text-left px-3 py-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 disabled:cursor-not-allowed'

  // Close on outside click or scroll
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        chevronRef.current && !chevronRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
        setConfirmDelete(false)
      }
    }
    const closeOnScroll = () => { setOpen(false); setConfirmDelete(false) }
    document.addEventListener('mousedown', close)
    window.addEventListener('scroll', closeOnScroll, true)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('scroll', closeOnScroll, true)
    }
  }, [open])

  const handleChevron = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (open) {
      setOpen(false)
      setConfirmDelete(false)
      return
    }
    const rect = chevronRef.current?.getBoundingClientRect()
    if (rect) {
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    }
    setOpen(true)
    setConfirmDelete(false)
  }

  const handleDelete = async () => {
    setIsDeleting(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk-soft-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: [product.id] }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      emitInvalidation({ type: 'product.updated', meta: { productIds: [product.id], source: 'delete' } })
      onChanged()
    } catch (e) {
      toast.error(`Delete failed: ${e instanceof Error ? e.message : String(e)}`)
      setIsDeleting(false)
      setConfirmDelete(false)
    }
  }

  const handleClose = async () => {
    setOpen(false)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/${product.id}/offer-availability`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offerActive: false }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      emitInvalidation({ type: 'product.updated', meta: { productIds: [product.id], source: 'close-listing' } })
      onChanged()
    } catch (e) {
      toast.error(`Close failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const handleCopy = async () => {
    setOpen(false)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/bulk-duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productIds: [product.id] }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      onChanged()
      toast.success('Product copied')
    } catch (e) {
      toast.error(`Copy failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const divider = <div className="border-t border-slate-100 dark:border-slate-800 my-1" />

  const deleteBlock = confirmDelete ? (
    <div className="px-3 py-1.5 space-y-1.5">
      <p className="text-xs text-slate-500 dark:text-slate-400">Delete this product?</p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={isDeleting}
          onClick={handleDelete}
          className="flex-1 text-xs h-6 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 inline-flex items-center justify-center gap-1"
        >
          {isDeleting && <span className="animate-spin inline-block w-3 h-3 border border-white border-t-transparent rounded-full" />}
          Yes, delete
        </button>
        <button
          type="button"
          onClick={() => setConfirmDelete(false)}
          className="flex-1 text-xs h-6 rounded border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </div>
  ) : (
    <button type="button" className={deleteCls} onClick={() => setConfirmDelete(true)}>
      Delete
    </button>
  )

  const menu = open && menuPos ? createPortal(
    <div
      ref={menuRef}
      style={{ position: 'fixed', top: menuPos.top, right: menuPos.right, zIndex: 9999 }}
      className="w-52 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md shadow-xl py-1 text-sm"
    >
      {product.isParent ? (
        // ── Parent: 4 actions ──────────────────────────────────────
        <>
          <Link href={`/products/${product.id}/edit?tab=images`} className={linkCls} onClick={() => setOpen(false)}>
            Edit images
          </Link>
          <button type="button" className={itemCls} onClick={handleCopy}>
            Copy
          </button>
          {divider}
          <Link href={`/marketing/content?productId=${product.id}`} className={linkCls} onClick={() => setOpen(false)}>
            Create ad
          </Link>
          {divider}
          {deleteBlock}
        </>
      ) : (
        // ── Child / standalone: 10 actions ────────────────────────
        <>
          <Link href={`/products/${product.id}/edit`} className={linkCls} onClick={() => setOpen(false)}>
            Edit
          </Link>
          <Link href={`/products/${product.id}/edit?tab=images`} className={linkCls} onClick={() => setOpen(false)}>
            Edit images
          </Link>
          <button type="button" className={itemCls} onClick={handleCopy}>
            Copy
          </button>
          {divider}
          <Link href={`/products/${product.id}/edit?tab=condition`} className={linkCls} onClick={() => setOpen(false)}>
            Add condition
          </Link>
          <Link href={`/products/${product.id}/edit?tab=fulfillment`} className={linkCls} onClick={() => setOpen(false)}>
            Switch to FBA
          </Link>
          <Link href={`/products/${product.id}/edit?tab=labels`} className={linkCls} onClick={() => setOpen(false)}>
            Print labels
          </Link>
          <button type="button" className={itemCls} onClick={handleClose}>
            Close
          </button>
          {divider}
          <Link href={`/marketing/content?productId=${product.id}`} className={linkCls} onClick={() => setOpen(false)}>
            Create ad
          </Link>
          <Link href={`/products/${product.id}/edit?tab=shipping`} className={linkCls} onClick={() => setOpen(false)}>
            Edit shipping
          </Link>
          {divider}
          {deleteBlock}
        </>
      )}
    </div>,
    document.body,
  ) : null

  const handlePeek = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    window.dispatchEvent(
      new CustomEvent('nexus:open-product-drawer', {
        detail: { productId: product.id },
      }),
    )
  }

  // PG.8 — listen for the workspace's Cmd+. shortcut. When fired with
  // a matching productId, open this row's chevron menu programmatically
  // (positioned next to the row's chevron). Lets keyboard-driven
  // operators reach the long-tail action menu without leaving J/K.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { productId?: string } | undefined
      if (!detail?.productId || detail.productId !== product.id) return
      const rect = chevronRef.current?.getBoundingClientRect()
      if (!rect) return
      setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
      setOpen(true)
      setConfirmDelete(false)
    }
    window.addEventListener('nexus:open-product-actions', onOpen as EventListener)
    return () => window.removeEventListener('nexus:open-product-actions', onOpen as EventListener)
  }, [product.id])

  return (
    <div className="inline-flex rounded-md shadow-sm">
      <button
        type="button"
        onClick={handlePeek}
        className={inlineIconCls}
        title="Open in drawer"
        aria-label="Open in drawer"
      >
        <Eye size={13} />
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); void handleCopy() }}
        className={inlineIconCls}
        title="Duplicate"
        aria-label="Duplicate product"
      >
        <Copy size={13} />
      </button>
      <Link href={`/products/${product.id}/edit`} className={splitBtnCls}>
        {label}
      </Link>
      <button
        ref={chevronRef}
        type="button"
        onClick={handleChevron}
        className="h-7 px-1.5 bg-white dark:bg-slate-800 border border-l-0 border-slate-300 dark:border-slate-600 rounded-r-md text-slate-500 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-700 inline-flex items-center transition-colors"
        aria-label="More actions"
        title="More actions (⌘ .)"
      >
        <ChevronDown size={12} />
      </button>
      {menu}
    </div>
  )
}

// the workspace, so they're stable across renders.
const ProductCell = memo(function ProductCell({
  col,
  product,
  onTagEdit,
  onChanged,
}: {
  col: string
  product: ProductRowType
  onTagEdit: (id: string) => void
  onChanged: () => void
}) {
  // F.5 — inline-edit state + the PATCH commit logic now live inside
  // <EditableCell>. ProductCell only routes the col key + product into
  // the right cell. The 8 editable columns share a single multi-case
  // dispatch; read-only cells keep their bespoke renderers.
  const searchQuery = useContext(SearchContext)
  // U.22 — inline tag-remove now surfaces failures via toast instead
  // of swallowing the error. useToast returns a stable object so the
  // hook call doesn't bust ProductCell's React.memo.
  const { toast } = useToast()
  const { t } = useTranslations()
  const p = product

  // PG.9 — drag-drop upload from the grid. POSTs each file to the same
  // multipart endpoint the per-product images tab uses; the server
  // emits IMAGES_UPDATED, the cache refreshes via the read-cache
  // queue, and the thumbnail catches up within ~2s. Parent rows skip
  // (Amazon-parity: galleries live on the variant, not the parent).
  const handleThumbUpload = useCallback(
    async (files: File[]) => {
      if (p.isParent && !p.parentId) return
      let okCount = 0
      let failCount = 0
      for (const file of files) {
        const fd = new FormData()
        fd.append('file', file, file.name)
        try {
          const res = await fetch(
            `${getBackendUrl()}/api/products/${p.id}/images?type=ALT`,
            { method: 'POST', body: fd },
          )
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          okCount++
        } catch (err) {
          failCount++
          toast.error(
            `Upload failed for ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
      if (okCount > 0) {
        toast.success(
          okCount === 1
            ? 'Photo uploaded'
            : `${okCount} photos uploaded${failCount > 0 ? ` (${failCount} failed)` : ''}`,
        )
        emitInvalidation({
          type: 'product.updated',
          meta: { productIds: [p.id], source: 'grid-thumb-drop' },
        })
        onChanged()
      }
    },
    [p.id, p.isParent, p.parentId, toast, onChanged],
  )

  switch (col) {
    // AM.1 — Product cell: matches Amazon exactly per row type.
    // Parent: thumbnail + name + ASIN (grey) + product-type link.
    // Child:  thumbnail + name + ASIN | SKU (grey) + "Variation details" link.
    // Standalone: thumbnail + name + SKU (grey).
    case 'product':
      return (
        <ProductIdentityCell
          id={p.id}
          name={p.name}
          sku={p.sku}
          amazonAsin={p.amazonAsin}
          productType={p.productType}
          isParent={p.isParent}
          parentId={p.parentId}
          childCount={p.childCount}
          imageUrl={p.imageUrl}
          photoCount={p.photoCount}
          searchQuery={searchQuery}
          showThumb
          fulfillmentMethod={p.fulfillmentMethod}
          onUploadFiles={handleThumbUpload}
        />
      )

    // AM.1 — Listing status.
    // Parent: "Variations (N)" blue outlined pill only — no other content.
    // Child/standalone: status pill + "⚠ Improve listing quality" link when no channel.
    case 'listing-status': {
      const childCount = p.childCount ?? 0
      const isParentRow = p.isParent && !p.parentId
      const channelCount = p.channelCount ?? 0
      const needsFix = p.status === 'ACTIVE' && channelCount === 0
      // PG.9 — surface a parallel "Add photos" pill when the product
      // has zero images. Catches the 11 imageless rows in the Xavia
      // catalog (and any future operator-onboarded SKU that lands
      // without a gallery). Same amber treatment as the existing
      // "Improve listing quality" link so the operator scans both
      // hints with one glance.
      const needsPhotos = !p.isParent && (p.photoCount ?? 0) === 0
      const statusBg =
        p.status === 'ACTIVE'
          ? 'bg-blue-50 text-blue-700 border border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-800'
          : p.status === 'INACTIVE'
          ? 'bg-slate-100 text-slate-500 border border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'
          : 'bg-amber-50 text-amber-700 border border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800'
      if (isParentRow) {
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-300 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700">
            Variations ({childCount})
          </span>
        )
      }
      return (
        <div className="space-y-1">
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${statusBg}`}>
            {p.status === 'ACTIVE' ? 'Active' : p.status === 'INACTIVE' ? 'Inactive' : 'Draft'}
          </span>
          {needsFix && (
            <Link
              href={`/products/${p.id}/edit`}
              className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 hover:underline"
            >
              <AlertCircle size={10} className="flex-shrink-0" />
              Improve listing quality
            </Link>
          )}
          {needsPhotos && (
            <Link
              href={`/products/${p.id}/edit?tab=images`}
              className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 hover:underline"
              title="No images yet — channel listings need photos before they ship"
            >
              <AlertCircle size={10} className="flex-shrink-0" />
              Add photos
            </Link>
          )}
        </div>
      )
    }

    // AM.1 — Sales (Last 30 days).
    // Parent rows are blank; children show "—" until we aggregate order data.
    case 'sales':
      if (p.isParent && !p.parentId) return null
      return <span className="text-sm text-slate-600 dark:text-slate-300">—</span>

    // AM.1 — Inventory (Available units). Splits FBA + FBM as two
    // stacked lines so the operator sees method-specific stock at a
    // glance. FBA is read-only (Amazon owns it); the lock icon
    // surfaces that intent. M.3 will add inline editing on the FBM row.
    case 'inventory': {
      if (p.isParent && !p.parentId) return null
      return (
        <div className="space-y-0.5">
          <StockSplit
            fba={p.fbaStock}
            fbm={p.fbmStock}
            fbmLowThreshold={p.lowStockThreshold ?? 10}
            onAdjustFbm={async (value) => {
              const res = await fetch(`${getBackendUrl()}/api/products/${p.id}/fbm-stock`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ value }),
              })
              if (!res.ok) {
                const err = await res.json().catch(() => ({ error: `${res.status}` }))
                throw new Error(err?.error ?? `${res.status}`)
              }
              const data = await res.json()
              emitInvalidation({ type: 'stock.adjusted', meta: { productId: p.id, source: 'products-grid-fbm-inline' } })
              return { fbaStock: data.fbaStock, fbmStock: data.fbmStock }
            }}
          />
          <Link
            href={`/products/${p.id}/edit?tab=matrix`}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            Edit prices
          </Link>
        </div>
      )
    }

    // AM.1 — Price + shipping (Featured Offer).
    // Parent rows: blank. Children: price + ✏ + ✅ price + €0.00 + Edit prices link.
    case 'price-shipping': {
      if (p.isParent && !p.parentId) return null
      const bp = p.basePrice
      const formatted = bp != null && Number.isFinite(bp) && bp > 0
        ? `€${Number(bp).toFixed(2)}`
        : null
      return formatted ? (
        <div className="space-y-0.5">
          <div className="flex items-center gap-1">
            <span className="text-sm font-medium text-slate-800 dark:text-slate-100 tabular-nums">
              {formatted}
            </span>
            <Pencil size={10} className="text-slate-400 flex-shrink-0" />
          </div>
          <div className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 size={10} strokeWidth={2.5} />
            <span className="tabular-nums">{formatted} + €0.00</span>
          </div>
          <Link
            href={`/products/${p.id}/edit?tab=matrix`}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            Edit prices
          </Link>
        </div>
      ) : (
        <span className="text-sm text-slate-400 dark:text-slate-500">—</span>
      )
    }

    // AM.1 — Estimated fees (Per unit).
    // Parent rows: blank. Children: "—" + Calculate revenue link.
    case 'estimated-fees':
      if (p.isParent && !p.parentId) return null
      return (
        <div className="space-y-0.5">
          <span className="text-sm text-slate-600 dark:text-slate-300">—</span>
          <Link
            href={`/products/${p.id}/edit`}
            className="block text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            Calculate revenue
          </Link>
        </div>
      )

    case 'thumb':
      // PG.7 — the standalone thumb column now uses the shared
      // Thumbnail component so it shares hover preview + multi-image
      // dot + Cloudinary transform + onError + density sizing with
      // the Product column's inline thumb. PG.9 — wired with the same
      // drag-drop upload callback as the inline thumb.
      return (
        <Thumbnail
          src={p.imageUrl ?? null}
          photoCount={p.photoCount}
          alt={p.name}
          onUpload={handleThumbUpload}
        />
      )

    case 'sku':
      return (
        <div className="inline-flex items-center gap-1.5 min-w-0">
          <Link
            href={`/products/${p.id}/edit`}
            className="text-base font-mono text-slate-700 hover:text-blue-600 truncate"
          >
            <Highlight text={p.sku} query={searchQuery} />
          </Link>
          {/* R7.2 — high-return-rate badge. */}
          <RiskBadge sku={p.sku} />
        </div>
      )
    // F.5 — eight editable columns share one EditableCell. Per-field
    // editor type, options, and display logic live in EDITABLE_FIELDS.
    case 'name':
    case 'status':
    case 'price':
    case 'stock':
    case 'threshold':
    case 'brand':
    case 'productType':
    case 'fulfillment':
      return <EditableCell field={col} product={p} onChanged={onChanged} />
    // W2.12 — PIM family chip. Click → settings/pim/families/:id editor.
    // Empty state is a small italic hint so the column never shows
    // a confusing blank.
    case 'family': {
      if (!p.family) {
        return (
          <span
            className="text-xs italic text-slate-400 dark:text-slate-500"
            title={t('products.grid.noFamily')}
          >
            —
          </span>
        )
      }
      return (
        <Link
          href={`/settings/pim/families/${p.family.id}`}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs bg-slate-100 dark:bg-slate-800 rounded text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 max-w-full truncate"
          title={t('products.grid.familyTooltip', { label: p.family.label, code: p.family.code })}
        >
          <span className="truncate">{p.family.label}</span>
        </Link>
      )
    }
    // W3.9 — Workflow stage chip. Tone reflects stage role: amber
    // for publishable, emerald for terminal, blue otherwise.
    // Click opens the drawer at the workflow tab.
    case 'workflowStage': {
      if (!p.workflowStage) {
        return (
          <span
            className="text-xs italic text-slate-400 dark:text-slate-500"
            title={t('products.grid.noWorkflow')}
          >
            —
          </span>
        )
      }
      const tone = p.workflowStage.isPublishable
        ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
        : p.workflowStage.isTerminal
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
          : 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
      return (
        <Link
          href={`/products?drawer=${p.id}&drawerTab=workflow`}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded hover:opacity-80 max-w-full truncate ${tone}`}
          title={`${p.workflowStage.label} · ${p.workflowStage.workflow.label}`}
        >
          <span className="truncate">{p.workflowStage.label}</span>
        </Link>
      )
    }
    case 'coverage': {
      // F8 — surface ALL canonical channels per row, not just the ones
      // already listed. Missing channels render as a gray "+"
      // placeholder that deep-links into the listing wizard with that
      // channel pre-selected.
      // U.30 — active scope: Amazon + eBay + Shopify only.
      // WooCommerce + Etsy intentionally excluded.
      const ALL_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const
      const covered = p.coverage ?? {}
      const coveredCount = Object.keys(covered).length
      return (
        <div className="flex items-center gap-1 flex-wrap">
          <span
            className="text-xs text-slate-400 mr-0.5 tabular-nums"
            title={t('products.grid.coverageTooltip', { covered: coveredCount, total: ALL_CHANNELS.length })}
          >
            {coveredCount}/{ALL_CHANNELS.length}
          </span>
          {ALL_CHANNELS.map((ch) => {
            const c = covered[ch]
            if (c) {
              const tone =
                c.error > 0
                  ? 'border-rose-300 bg-rose-50 text-rose-700'
                  : c.live > 0
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                    : c.draft > 0
                      ? 'border-slate-200 bg-slate-50 text-slate-600'
                      : 'border-slate-200 bg-white text-slate-400'
              return (
                <Link
                  key={ch}
                  href={`/listings/${ch.toLowerCase()}?search=${encodeURIComponent(p.sku)}`}
                  title={t('products.grid.channelTooltip', { channel: ch, live: c.live, draft: c.draft, error: c.error, total: c.total })}
                  className={`inline-flex items-center gap-1 px-1.5 h-5 text-xs font-mono border rounded ${tone} hover:opacity-80`}
                >
                  {ch.slice(0, 3)}
                  <span className="opacity-60">{c.total}</span>
                </Link>
              )
            }
            return (
              <Link
                key={ch}
                href={`/products/${p.id}/list-wizard?channel=${ch}`}
                title={t('products.grid.notListedOn', { channel: ch })}
                className="inline-flex items-center gap-0.5 px-1.5 h-5 text-xs font-mono border border-dashed border-slate-300 bg-white text-slate-400 rounded hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50"
              >
                {ch.slice(0, 3)}
                <span className="text-xs leading-none">+</span>
              </Link>
            )
          })}
        </div>
      )
    }
    case 'tags': {
      // E.17 — inline tag remove + overflow indicator.
      const tags = p.tags ?? []
      const visibleTags = tags.slice(0, 3)
      const overflow = tags.length - visibleTags.length
      const removeTag = async (tagId: string) => {
        try {
          const res = await fetch(
            `${getBackendUrl()}/api/products/bulk-tag`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                productIds: [p.id],
                tagIds: [tagId],
                mode: 'remove',
              }),
            },
          )
          if (!res.ok) {
            const j = await res.json().catch(() => ({}))
            throw new Error(j.error ?? `HTTP ${res.status}`)
          }
          emitInvalidation({
            type: 'product.updated',
            meta: { productIds: [p.id], source: 'inline-tag-remove' },
          })
          onChanged()
        } catch (e) {
          // U.22 — toast the failure so the operator gets a signal;
          // the next refetch will restore the row's tag list anyway.
          toast.error(
            `Remove tag failed: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
      return (
        <div className="flex items-center gap-1 flex-wrap">
          {visibleTags.map((t) => (
            // U.25 — was `color: t.color` which rendered light tags
            // (yellow / pale blue / lime) as unreadable text on a
            // near-white background. The chip now uses theme text
            // (slate-700 / slate-300) regardless; the tag's identity
            // shows through the bg-tint + the colored dot below.
            <span
              key={t.id}
              className="group/tag inline-flex items-center gap-1 px-1.5 py-0.5 text-xs rounded text-slate-700 dark:text-slate-200"
              style={{
                background: t.color ? `${t.color}20` : '#f1f5f9',
              }}
            >
              {t.color && (
                <span
                  className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: t.color }}
                />
              )}
              {t.name}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  void removeTag(t.id)
                }}
                aria-label={`Remove tag ${t.name}`}
                // U.22 — was `opacity-0 group-hover/tag:opacity-100` which
                // hid the affordance entirely on touch devices (no hover).
                // Always visible on mobile/tablet (where ops happens by
                // touch); hover-reveal stays on desktop (sm: with @media
                // hover guard would be ideal but breakpoint-based is fine
                // for our usage where mobile + touch overlap heavily).
                className="opacity-60 sm:opacity-0 sm:group-hover/tag:opacity-100 inline-flex items-center justify-center w-3 h-3 rounded-full hover:bg-rose-100 hover:text-rose-700 transition-opacity"
              >
                <X size={10} />
              </button>
            </span>
          ))}
          {overflow > 0 && (
            <button
              type="button"
              onClick={() => onTagEdit(p.id)}
              title={tags
                .slice(3)
                .map((t) => t.name)
                .join(', ')}
              className="inline-flex items-center px-1.5 py-0.5 text-xs rounded bg-slate-100 text-slate-600 hover:bg-slate-200"
            >
              +{overflow} more
            </button>
          )}
          <button
            onClick={() => onTagEdit(p.id)}
            aria-label={t('products.grid.editTags')}
            title={t('products.grid.editTags')}
            // U.22 — was `h-4 w-4 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0`
            // which collapsed the desktop hit zone to 4×4 (visible icon
            // mismatched click area). Desktop now uses h-5/w-5; mobile
            // expands to 44×44 via the standard pattern.
            className="min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 sm:h-5 sm:w-5 inline-flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded text-xs"
          >
            +
          </button>
        </div>
      )
    }
    case 'photos': {
      const tone =
        p.photoCount === 0
          ? 'text-rose-600'
          : p.photoCount < 3
            ? 'text-amber-600'
            : 'text-emerald-600'
      return (
        <span className={`text-base tabular-nums font-semibold ${tone}`}>
          {p.photoCount}
        </span>
      )
    }
    case 'variants':
      return (
        <span className="text-base tabular-nums text-slate-600">
          {p.variantCount}
        </span>
      )
    case 'completeness': {
      // F.2 — completeness % from 6 dimensions.
      const checks: Array<[string, boolean]> = [
        [
          'name',
          !!(
            p.name &&
            p.name.trim().length > 0 &&
            p.name !== 'Untitled product'
          ),
        ],
        ['brand', !!p.brand],
        ['type', !!p.productType],
        ['photos', p.photoCount > 0],
        ['channels', p.channelCount > 0],
        ['tags', (p.tags?.length ?? 0) > 0],
      ]
      const passed = checks.filter(([, ok]) => ok).length
      const score = Math.round((passed / checks.length) * 100)
      const missing = checks.filter(([, ok]) => !ok).map(([k]) => k)
      const tone =
        score >= 80
          ? 'bg-emerald-500'
          : score >= 50
            ? 'bg-amber-500'
            : 'bg-rose-500'
      const textTone =
        score >= 80
          ? 'text-emerald-700'
          : score >= 50
            ? 'text-amber-700'
            : 'text-rose-700'
      return (
        <div
          className="flex items-center gap-2 w-full"
          title={
            missing.length === 0
              ? t('products.grid.qualityPass')
              : t('products.grid.qualityMissing', { fields: missing.join(', ') })
          }
        >
          <span
            className={`text-sm tabular-nums font-semibold ${textTone}`}
          >
            {score}%
          </span>
          <div className="flex-1 h-1.5 bg-slate-100 rounded overflow-hidden">
            <div
              className={`h-full ${tone}`}
              style={{ width: `${score}%` }}
            />
          </div>
        </div>
      )
    }
    case 'familyCompleteness': {
      // W5.1 — family-driven completeness (W2.14). Three states:
      //   undefined → loading (workspace hasn't fetched yet)
      //   score=-1  → product has no family ("not scoreable" signal)
      //   0..100    → real score with tone-coded chip
      const fc = p.familyCompleteness
      if (fc === undefined) {
        return (
          <span className="inline-block w-12 h-3 bg-slate-100 dark:bg-slate-800 rounded animate-pulse" />
        )
      }
      if (fc.score === -1) {
        return (
          <span
            className="text-xs italic text-slate-400 dark:text-slate-500"
            title={t('products.grid.notFamilyScoreable')}
          >
            —
          </span>
        )
      }
      const fcTone =
        fc.score >= 90
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
          : fc.score >= 70
            ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'
            : 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300'
      return (
        <span
          className={`inline-flex items-center px-1.5 py-0.5 text-xs font-medium rounded tabular-nums ${fcTone}`}
          title={t('products.grid.familyScore', { filled: fc.filled, total: fc.totalRequired })}
        >
          {fc.score}%
        </span>
      )
    }
    case 'sync-status': {
      // P-RT.5 — per-row outbound state chip. Reads the API's
      // syncQueue rollup (populated when ?coverage=true). State
      // precedence: dead > failed > pending > succeeded. The chip
      // updates real-time because ProductsWorkspace already feeds
      // listing.* and product.* SSE events into usePolledList's
      // invalidationTypes — a worker flipping a row from PENDING
      // to SUCCEEDED triggers a refetch within ~250ms.
      const q = p.syncQueue
      if (!q || q.mostUrgentStatus == null) {
        return <span className="text-xs text-slate-400">—</span>
      }
      const ch = q.mostUrgentChannel?.slice(0, 3) ?? '???'
      if (q.mostUrgentStatus === 'DEAD') {
        return (
          <span
            className="inline-flex items-center gap-1 px-1.5 h-5 text-xs font-mono border border-rose-400 bg-rose-100 text-rose-800 rounded"
            title={t('products.grid.syncDead', { channel: q.mostUrgentChannel ?? '', count: q.dead })}
            data-testid="sync-status-dead"
          >
            <span aria-hidden>💀</span>
            {ch}
          </span>
        )
      }
      if (q.mostUrgentStatus === 'FAILED') {
        return (
          <span
            className="inline-flex items-center gap-1 px-1.5 h-5 text-xs font-mono border border-amber-300 bg-amber-50 text-amber-800 rounded"
            title={t('products.grid.syncFailed', { channel: q.mostUrgentChannel ?? '', count: q.failed })}
            data-testid="sync-status-failed"
          >
            <span aria-hidden>⚠</span>
            {ch}
          </span>
        )
      }
      if (q.mostUrgentStatus === 'PENDING') {
        return (
          <span
            className="inline-flex items-center gap-1 px-1.5 h-5 text-xs font-mono border border-sky-300 bg-sky-50 text-sky-700 rounded"
            title={t('products.grid.syncPending', { channel: q.mostUrgentChannel ?? '', count: q.pending })}
            data-testid="sync-status-pending"
          >
            <span aria-hidden className="animate-pulse">⟳</span>
            {ch}
          </span>
        )
      }
      // SYNCED — show relative time. Suppress when older than 24h to
      // keep the column tidy: chip only "earns its space" when recent.
      if (q.syncedAt) {
        const ageMs = Date.now() - new Date(q.syncedAt).getTime()
        if (ageMs > 24 * 60 * 60_000) {
          return <span className="text-xs text-slate-400">—</span>
        }
        const ageMin = Math.max(1, Math.floor(ageMs / 60_000))
        const label =
          ageMin < 60
            ? `${ageMin}m`
            : `${Math.floor(ageMin / 60)}h`
        return (
          <span
            className="inline-flex items-center gap-1 px-1.5 h-5 text-xs font-mono border border-emerald-200 bg-emerald-50 text-emerald-700 rounded"
            title={t('products.grid.syncOk', { channel: q.mostUrgentChannel ?? '', when: label })}
            data-testid="sync-status-ok"
          >
            <span aria-hidden>✓</span>
            {ch} <span className="opacity-60">{label}</span>
          </span>
        )
      }
      return <span className="text-xs text-slate-400">—</span>
    }
    case 'updated':
      return (
        <span className="text-sm text-slate-500">
          {new Date(p.updatedAt).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'short',
          })}
        </span>
      )
    case 'actions':
      return (
        <div className="flex items-center justify-end">
          <EditSplitButton product={p} onChanged={onChanged} />
        </div>
      )
    default:
      return null
  }
})

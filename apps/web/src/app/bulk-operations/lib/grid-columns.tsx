// Column definitions for the bulk-ops TanStack table — turns each
// FieldDef from the column registry into a ColumnDef with the right
// renderer (read-only / editable / SKU-with-hierarchy / channel-gated /
// productType-gated / aggregate-display).

import { ChevronDown, ChevronRight } from 'lucide-react'
import type { CellContext, ColumnDef } from '@tanstack/react-table'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import { EditableCell, type EditableMeta } from '../EditableCell'
import type { FieldDef } from '../components/ColumnSelector'
import {
  aggregateDisplayValue,
  isAggregatableField,
  type HierarchyRow,
} from './hierarchy'
import { isDimFieldId, isWeightFieldId } from './unit-parsing'
import {
  editCtxRef,
  hasMarketplaceContextRef,
  hierarchyCtxRef,
} from './refs'
import { ProductTypeCell } from './ProductTypeCell'
import type { BulkProduct } from './types'

// ── Constants ─────────────────────────────────────────────────────

export const PRICE_FIELDS = new Set([
  'basePrice',
  'costPrice',
  'minPrice',
  'maxPrice',
  'buyBoxPrice',
  'competitorPrice',
])

export const MONO_FIELDS = new Set([
  'sku',
  'amazonAsin',
  'parentAsin',
  'ebayItemId',
  'upc',
  'ean',
])

// ── formatters ────────────────────────────────────────────────────

/** Whole numbers render without a decimal; everything else renders to
 *  2 decimals max. Currency-style summaries stay tidy without forcing
 *  "5" into "5.00". */
export function formatMetric(n: number): string {
  if (Number.isInteger(n)) return n.toString()
  return n.toFixed(2)
}

// ── Cell renderers ────────────────────────────────────────────────

export function ReadOnlyCell({
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

/** Builds the FieldDef→EditableMeta translation used by every editable
 *  column. */
export function fieldToMeta(field: FieldDef): EditableMeta {
  if (field.type === 'select') {
    return {
      editable: true,
      fieldType: 'select',
      options: field.options ?? [],
    }
  }
  // Weight + dimension fields are typed as 'number' in the registry
  // but rendered as text inputs so the user can type "5kg" or "60cm".
  // The smart-parsing in handleCommit splits the unit suffix into the
  // corresponding *Unit column.
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

export function makeEditableRenderer(meta: EditableMeta) {
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

// ── Accessors ─────────────────────────────────────────────────────

/** For channel-scoped fields (amazon_title, ebay_description, etc.),
 *  the value lives on row._channelListing.<stripped> rather than on
 *  the row itself. Used as the accessorFn so TanStack getValue() and
 *  cell renderers transparently read the right place. */
export function channelAccessorFn(field: FieldDef) {
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
export function categoryAttrAccessorFn(field: FieldDef) {
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
export function fieldAppliesToProduct(
  field: FieldDef,
  row: BulkProduct,
): boolean {
  if (!field.productTypes || field.productTypes.length === 0) return true
  const pt = row.productType ?? null
  if (!pt) return false
  return field.productTypes.includes(pt)
}

// ── SKU cell (hierarchy-aware) ────────────────────────────────────

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
    return <ReadOnlyCell value={sku} field={field} />
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
          isParent ? 'text-slate-900 font-semibold' : 'text-slate-700',
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

// ── Column builder ────────────────────────────────────────────────

export function buildColumnFromField(field: FieldDef): ColumnDef<BulkProduct> {
  const size = field.width ?? 120
  // Stash the FieldDef on meta so the header row can reach helpText
  // and the editable flag without recomputing per-render.
  const meta = { fieldDef: field }

  const isChannelField = !!field.channel
  const isCategoryAttrField = field.id.startsWith('attr_')

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

  // EE.2 — productType uses a channel-aware picker (list for AMAZON,
  // search for EBAY) instead of plain text input. Picks
  // ProductTypePicker mode off the active marketplace tab.
  if (field.id === 'productType') {
    return {
      id: field.id,
      accessorKey: field.id as string,
      header: field.label,
      size,
      meta,
      cell: (ctx) => <ProductTypeCell ctx={ctx} />,
    } as ColumnDef<BulkProduct>
  }

  const accessor = isChannelField
    ? { accessorFn: channelAccessorFn(field) }
    : isCategoryAttrField
    ? { accessorFn: categoryAttrAccessorFn(field) }
    : { accessorKey: field.id as string }

  if (field.editable) {
    const editMeta = fieldToMeta(field)
    const editRenderer = makeEditableRenderer(editMeta)
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

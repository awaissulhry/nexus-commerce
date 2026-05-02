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
  type Row,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { EditableCell, type EditableMeta } from './EditableCell'

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
}

interface CellChange {
  rowId: string
  columnId: string
  oldValue: unknown
  newValue: unknown
  timestamp: number
}

const ROW_HEIGHT = 36
const HEADER_HEIGHT = 36

// ── Editable column metas (module scope = stable identity) ────────────
const META_NAME: EditableMeta = { editable: true, fieldType: 'text' }
const META_BRAND: EditableMeta = { editable: true, fieldType: 'text' }
const META_STATUS: EditableMeta = {
  editable: true,
  fieldType: 'select',
  options: ['ACTIVE', 'DRAFT', 'INACTIVE'],
}
const META_CHANNEL: EditableMeta = {
  editable: true,
  fieldType: 'select',
  options: ['FBA', 'FBM'],
}
const META_PRICE: EditableMeta = {
  editable: true,
  fieldType: 'number',
  numeric: true,
  prefix: '€',
  format: (v) =>
    v === null || v === undefined ? '' : Number(v).toFixed(2),
}
const META_STOCK: EditableMeta = {
  editable: true,
  fieldType: 'number',
  numeric: true,
  format: (v) =>
    v === null || v === undefined ? '' : String(Math.floor(Number(v))),
  parse: (raw) => {
    if (raw === '' || raw === null) return null
    const n = parseInt(raw, 10)
    return Number.isNaN(n) ? raw : n
  },
}

// ── Helpers passed to all editable cells via closure ──────────────────
interface EditCtx {
  serverVersion: number
  onCommit: (rowId: string, columnId: string, value: unknown) => void
}

function fmtMargin(cost: number | null, price: number): string {
  if (cost == null || price <= 0) return ''
  return `${((1 - cost / price) * 100).toFixed(0)}%`
}

// Cell renderers reference editCtxRef so that the renderers stay stable
// (no new ColumnDef array per render) while still seeing latest commit
// callbacks. The ref is set once per render before useReactTable runs.
const editCtxRef: { current: EditCtx } = {
  current: {
    serverVersion: 0,
    onCommit: () => {
      /* no-op until parent wires it */
    },
  },
}

function makeEditableRenderer(meta: EditableMeta) {
  // Inner function is stable — captured from module scope.
  return function EditableCellRenderer(ctx: CellContext<BulkProduct, unknown>) {
    const value = ctx.getValue()
    return (
      <EditableCell
        rowId={ctx.row.original.id}
        columnId={ctx.column.id}
        initialValue={value}
        serverVersion={editCtxRef.current.serverVersion}
        meta={meta}
        onCommit={editCtxRef.current.onCommit}
      />
    )
  }
}

const columns: ColumnDef<BulkProduct>[] = [
  {
    id: 'sku',
    accessorKey: 'sku',
    header: 'SKU',
    size: 220,
    cell: ({ getValue }) => (
      <span className="font-mono text-[12px] text-slate-900 px-2">
        {getValue<string>()}
      </span>
    ),
  },
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    size: 380,
    cell: makeEditableRenderer(META_NAME),
  },
  {
    id: 'brand',
    accessorKey: 'brand',
    header: 'Brand',
    size: 160,
    cell: makeEditableRenderer(META_BRAND),
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    size: 110,
    // Status uses a dedicated renderer so the *display* shows a Badge
    // when not editing, but clicking it switches to the select. Wrap
    // EditableCell in a render that picks display vs edit by checking
    // isEditing through CSS — simpler: always use EditableCell which
    // shows raw text when not editing. Acceptable for Phase B.
    cell: makeEditableRenderer(META_STATUS),
  },
  {
    id: 'fulfillmentChannel',
    accessorKey: 'fulfillmentChannel',
    header: 'Channel',
    size: 100,
    cell: makeEditableRenderer(META_CHANNEL),
  },
  {
    id: 'basePrice',
    accessorKey: 'basePrice',
    header: 'Price',
    size: 100,
    cell: makeEditableRenderer(META_PRICE),
  },
  {
    id: 'costPrice',
    accessorKey: 'costPrice',
    header: 'Cost',
    size: 100,
    cell: makeEditableRenderer(META_PRICE),
  },
  {
    id: 'margin',
    header: 'Margin',
    size: 80,
    accessorFn: (row) => fmtMargin(row.costPrice, row.basePrice),
    cell: ({ getValue }) => {
      const v = getValue<string>()
      return v ? (
        <span className="text-[13px] tabular-nums text-slate-700 px-2">{v}</span>
      ) : (
        <span className="text-slate-300 px-2">—</span>
      )
    },
  },
  {
    id: 'totalStock',
    accessorKey: 'totalStock',
    header: 'Stock',
    size: 90,
    cell: makeEditableRenderer(META_STOCK),
  },
  {
    id: 'amazonAsin',
    accessorKey: 'amazonAsin',
    header: 'ASIN',
    size: 110,
    cell: ({ getValue }) => {
      const v = getValue<string | null>()
      return v ? (
        <span className="font-mono text-[11px] text-slate-700 px-2">{v}</span>
      ) : (
        <span className="text-slate-300 px-2">—</span>
      )
    },
  },
]

const TABLE_MIN_WIDTH = columns.reduce((sum, c) => sum + (c.size ?? 100), 0)

// ── Memoized row ──────────────────────────────────────────────────────
const TableRow = memo(
  function TableRow({ row, top }: { row: Row<BulkProduct>; top: number }) {
    return (
      <div
        className="absolute left-0 right-0 flex border-b border-slate-100 hover:bg-slate-50/70"
        style={{
          height: ROW_HEIGHT,
          transform: `translateY(${top}px)`,
          willChange: 'transform',
        }}
      >
        {row.getVisibleCells().map((cell) => (
          <div
            key={cell.id}
            className="overflow-hidden border-r border-slate-100/60 last:border-r-0"
            style={{ width: cell.column.getSize(), flexShrink: 0 }}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </div>
        ))}
      </div>
    )
  },
  (prev, next) => prev.row.original === next.row.original && prev.top === next.top
)

function SkeletonRow({ top }: { top: number }) {
  return (
    <div
      className="absolute left-0 right-0 flex border-b border-slate-100 animate-pulse"
      style={{ height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
    >
      {columns.map((c) => (
        <div
          key={c.id}
          className="flex items-center px-3"
          style={{ width: c.size ?? 100, flexShrink: 0 }}
        >
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

  // Phase B state
  const [changes, setChanges] = useState<Map<string, CellChange>>(new Map())
  // Phase C will bump this after successful save to clear yellow highlights.
  const [serverVersion] = useState(0)

  // Stable onCommit — use a ref to avoid recreating on every render
  // while still picking up the latest products array for old-value lookup.
  const productsRef = useRef(products)
  useEffect(() => {
    productsRef.current = products
  }, [products])

  const handleCommit = useCallback(
    (rowId: string, columnId: string, newValue: unknown) => {
      const key = `${rowId}:${columnId}`
      const product = productsRef.current.find((p) => p.id === rowId)
      if (!product) return
      const oldValue = (product as unknown as Record<string, unknown>)[columnId]

      setChanges((prev) => {
        const next = new Map(prev)
        // If the new value matches original, drop the change entry
        if (looselyEqual(newValue, oldValue)) {
          next.delete(key)
        } else {
          next.set(key, {
            rowId,
            columnId,
            oldValue,
            newValue,
            timestamp: Date.now(),
          })
        }
        return next
      })
    },
    []
  )

  // Push the latest commit handler + serverVersion into the module-level
  // ref so cell renderers see them. This intentionally does NOT cause
  // memoized cells to re-render — the renderer reads from the ref each
  // time it's invoked, but the renderer itself is stable.
  editCtxRef.current = { serverVersion, onCommit: handleCommit }

  useEffect(() => {
    let cancelled = false
    const start = performance.now()
    fetch(`${getBackendUrl()}/api/products/bulk-fetch`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        setProducts(Array.isArray(data.products) ? data.products : [])
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

  const table = useReactTable({
    data: products,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  const rows = table.getRowModel().rows

  const containerRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: loading ? 20 : rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  const headerCells = useMemo(() => table.getHeaderGroups()[0]?.headers ?? [], [table])
  const totalSize = rowVirtualizer.getTotalSize()
  const pendingCount = changes.size

  return (
    <div className="flex-1 min-h-0 px-6 pb-6 flex flex-col">
      {/* Phase B status bar — pending count + (disabled) Save */}
      <div className="flex-shrink-0 mb-3 flex items-center justify-between">
        <div className="text-[12px] text-slate-500">
          {loading
            ? 'Loading…'
            : `${products.length.toLocaleString()} rows · click any cell to edit · Tab to next, Enter to commit, Esc to cancel`}
        </div>
        <div className="flex items-center gap-3">
          {pendingCount > 0 && (
            <span className="text-[12px] text-amber-700">
              {pendingCount} unsaved change{pendingCount === 1 ? '' : 's'}
            </span>
          )}
          <Button
            variant="primary"
            size="sm"
            disabled={pendingCount === 0}
            onClick={() => {
              // Phase C: real save flow. For now just simulate clearing
              // by bumping serverVersion, which would happen after a
              // successful PATCH response.
              alert(
                `Phase C will POST ${pendingCount} change${
                  pendingCount === 1 ? '' : 's'
                } to /api/products/bulk and clear yellow highlights on success.`
              )
            }}
          >
            {pendingCount === 0
              ? 'No changes'
              : `Save ${pendingCount} change${pendingCount === 1 ? '' : 's'}`}
          </Button>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto bg-white border border-slate-200 rounded-lg"
        style={{ contain: 'strict' }}
      >
        <div
          className="sticky top-0 z-10 bg-slate-50 border-b border-slate-200 flex"
          style={{ height: HEADER_HEIGHT, minWidth: TABLE_MIN_WIDTH }}
        >
          {headerCells.map((header) => (
            <div
              key={header.id}
              className="flex items-center px-3 text-[11px] font-semibold text-slate-700 uppercase tracking-wider"
              style={{ width: header.getSize(), flexShrink: 0 }}
            >
              {flexRender(header.column.columnDef.header, header.getContext())}
            </div>
          ))}
        </div>

        <div className="relative" style={{ height: totalSize, minWidth: TABLE_MIN_WIDTH }}>
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            if (loading) return <SkeletonRow key={vRow.key} top={vRow.start} />
            const row = rows[vRow.index]
            return <TableRow key={row.id} row={row} top={vRow.start} />
          })}
        </div>

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/90">
            <div className="text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-md px-4 py-2">
              Failed to load: {error}
            </div>
          </div>
        )}
      </div>

      <div className="flex-shrink-0 mt-2 flex items-center justify-between text-[11px] text-slate-500 px-1">
        <span>
          {fetchMs != null
            ? `Fetched in ${fetchMs}ms`
            : loading
            ? 'Fetching…'
            : ''}
        </span>
        <span>Phase B (editing) · save (C), filters (D), polish (E) coming next</span>
      </div>
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

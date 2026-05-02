'use client'

import { memo, useMemo, useRef } from 'react'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type Row,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Badge } from '@/components/ui/Badge'

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

const ROW_HEIGHT = 36
const HEADER_HEIGHT = 36

// ── Pure cell formatters (no React state, cheap to call) ──────────────
function fmtMoney(v: number | null): string {
  if (v == null) return ''
  return v.toFixed(2)
}
function fmtMargin(cost: number | null, price: number): string {
  if (cost == null || price <= 0) return ''
  return `${((1 - cost / price) * 100).toFixed(0)}%`
}

// ── Memoized status / channel badges ──────────────────────────────────
const StatusBadge = memo(function StatusBadge({ value }: { value: string }) {
  const variant =
    value === 'ACTIVE'
      ? 'success'
      : value === 'DRAFT'
      ? 'default'
      : value === 'INACTIVE'
      ? 'default'
      : 'warning'
  return (
    <Badge variant={variant} size="sm">
      {value}
    </Badge>
  )
})

const ChannelBadge = memo(function ChannelBadge({
  value,
}: {
  value: 'FBA' | 'FBM' | null
}) {
  if (!value) return <span className="text-slate-300">—</span>
  return (
    <Badge variant="default" size="sm" mono>
      {value}
    </Badge>
  )
})

// ── Column definitions ────────────────────────────────────────────────
// Phase A: read-only render. Phase B replaces these cell renderers with
// the EditableCell component. Stable identity (defined at module scope)
// so React Table doesn't think columns changed every render.
const columns: ColumnDef<BulkProduct>[] = [
  {
    id: 'sku',
    accessorKey: 'sku',
    header: 'SKU',
    size: 220,
    cell: ({ getValue }) => (
      <span className="font-mono text-[12px] text-slate-900">
        {getValue<string>()}
      </span>
    ),
  },
  {
    id: 'name',
    accessorKey: 'name',
    header: 'Name',
    size: 380,
    cell: ({ getValue }) => (
      <span className="text-[13px] text-slate-900 truncate block">
        {getValue<string>()}
      </span>
    ),
  },
  {
    id: 'brand',
    accessorKey: 'brand',
    header: 'Brand',
    size: 120,
    cell: ({ getValue }) => {
      const v = getValue<string | null>()
      return v ? (
        <span className="text-[13px] text-slate-700">{v}</span>
      ) : (
        <span className="text-slate-300">—</span>
      )
    },
  },
  {
    id: 'status',
    accessorKey: 'status',
    header: 'Status',
    size: 90,
    cell: ({ getValue }) => <StatusBadge value={getValue<string>()} />,
  },
  {
    id: 'fulfillmentChannel',
    accessorKey: 'fulfillmentChannel',
    header: 'Channel',
    size: 80,
    cell: ({ getValue }) => (
      <ChannelBadge value={getValue<'FBA' | 'FBM' | null>()} />
    ),
  },
  {
    id: 'basePrice',
    accessorKey: 'basePrice',
    header: 'Price',
    size: 90,
    cell: ({ getValue }) => (
      <span className="text-[13px] tabular-nums text-slate-900">
        €{fmtMoney(getValue<number>())}
      </span>
    ),
  },
  {
    id: 'costPrice',
    accessorKey: 'costPrice',
    header: 'Cost',
    size: 90,
    cell: ({ getValue }) => {
      const v = getValue<number | null>()
      return v == null ? (
        <span className="text-slate-300">—</span>
      ) : (
        <span className="text-[13px] tabular-nums text-slate-700">€{v.toFixed(2)}</span>
      )
    },
  },
  {
    id: 'margin',
    header: 'Margin',
    size: 80,
    accessorFn: (row) => fmtMargin(row.costPrice, row.basePrice),
    cell: ({ getValue }) => {
      const v = getValue<string>()
      return v ? (
        <span className="text-[13px] tabular-nums text-slate-700">{v}</span>
      ) : (
        <span className="text-slate-300">—</span>
      )
    },
  },
  {
    id: 'totalStock',
    accessorKey: 'totalStock',
    header: 'Stock',
    size: 80,
    cell: ({ row, getValue }) => {
      const v = getValue<number>()
      const low = v <= row.original.lowStockThreshold
      return (
        <span
          className={`text-[13px] tabular-nums ${
            low ? 'text-amber-700 font-semibold' : 'text-slate-900'
          }`}
        >
          {v}
        </span>
      )
    },
  },
  {
    id: 'amazonAsin',
    accessorKey: 'amazonAsin',
    header: 'ASIN',
    size: 110,
    cell: ({ getValue }) => {
      const v = getValue<string | null>()
      return v ? (
        <span className="font-mono text-[11px] text-slate-700">{v}</span>
      ) : (
        <span className="text-slate-300">—</span>
      )
    },
  },
]

// Total of all column sizes — used to enforce min table width so columns
// stay aligned with their headers when the viewport is narrower.
const TABLE_MIN_WIDTH = columns.reduce((sum, c) => sum + (c.size ?? 100), 0)

// ── Memoized row — re-renders only when its row data changes ──────────
const TableRow = memo(
  function TableRow({
    row,
    top,
  }: {
    row: Row<BulkProduct>
    top: number
  }) {
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
            className="flex items-center px-3 overflow-hidden"
            style={{ width: cell.column.getSize(), flexShrink: 0 }}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </div>
        ))}
      </div>
    )
  },
  // Custom equality — row data is immutable from the server fetch in
  // Phase A, so reference equality is enough. The `top` prop changes
  // on every scroll frame for visible rows; that's expected.
  (prev, next) => prev.row.original === next.row.original && prev.top === next.top
)

interface Props {
  initialProducts: BulkProduct[]
}

export default function BulkOperationsClient({ initialProducts }: Props) {
  const products = initialProducts

  const table = useReactTable({
    data: products,
    columns,
    getCoreRowModel: getCoreRowModel(),
    // No filter / sort state in Phase A; comes in Phase D.
  })

  const rows = table.getRowModel().rows

  const containerRef = useRef<HTMLDivElement>(null)
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  const headerCells = useMemo(() => table.getHeaderGroups()[0]?.headers ?? [], [table])
  const totalSize = rowVirtualizer.getTotalSize()

  return (
    <div className="flex-1 min-h-0 px-6 pb-6 flex flex-col">
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto bg-white border border-slate-200 rounded-lg"
        // Helps the browser create a dedicated layer for smoother scroll
        style={{ contain: 'strict' }}
      >
        {/* Sticky header */}
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

        {/* Virtualized rows */}
        <div
          className="relative"
          style={{ height: totalSize, minWidth: TABLE_MIN_WIDTH }}
        >
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            const row = rows[vRow.index]
            return (
              <TableRow key={row.id} row={row} top={vRow.start} />
            )
          })}
        </div>
      </div>

      <div className="flex-shrink-0 mt-2 flex items-center justify-between text-[11px] text-slate-500 px-1">
        <span>
          {products.length.toLocaleString()} rows · Phase A: read-only · scroll test
        </span>
        <span>
          Phase B (editable cells), C (save), D (filters) coming next
        </span>
      </div>
    </div>
  )
}

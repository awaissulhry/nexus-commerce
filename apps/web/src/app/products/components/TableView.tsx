'use client'

import { useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table'
import { Package } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ProductRow } from '../ProductsClient'

interface Props {
  products: ProductRow[]
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onSelectAll: () => void
  onClearSelection: () => void
}

const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-500',
  EBAY: 'bg-blue-600',
  SHOPIFY: 'bg-emerald-600',
  WOOCOMMERCE: 'bg-purple-600',
}

export default function TableView({
  products,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
}: Props) {
  const router = useRouter()

  const allSelected =
    products.length > 0 && products.every((p) => selectedIds.has(p.id))
  const someSelected =
    !allSelected && products.some((p) => selectedIds.has(p.id))

  const columns = useMemo<ColumnDef<ProductRow>[]>(
    () => [
      {
        id: 'select',
        size: 36,
        header: () => (
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => {
              if (el) el.indeterminate = someSelected
            }}
            onChange={() => (allSelected ? onClearSelection() : onSelectAll())}
            className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            aria-label={allSelected ? 'Clear selection' : 'Select all on page'}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={selectedIds.has(row.original.id)}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleSelect(row.original.id)}
            className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            aria-label={`Select ${row.original.sku}`}
          />
        ),
      },
      {
        id: 'image',
        size: 56,
        header: '',
        cell: ({ row }) => (
          <Thumb src={row.original.imageUrl} alt={row.original.name} />
        ),
      },
      {
        accessorKey: 'sku',
        header: 'SKU',
        size: 140,
        cell: ({ getValue }) => (
          <span className="font-mono text-[12px] text-slate-700 truncate block">
            {getValue<string>()}
          </span>
        ),
      },
      {
        accessorKey: 'name',
        header: 'Name',
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="text-[13px] text-slate-900 truncate">
              {row.original.name}
            </div>
            {row.original.brand && (
              <div className="text-[11px] text-slate-500 truncate">
                {row.original.brand}
              </div>
            )}
          </div>
        ),
      },
      {
        accessorKey: 'status',
        header: 'Status',
        size: 90,
        cell: ({ getValue }) => <StatusBadge status={getValue<string>()} />,
      },
      {
        accessorKey: 'totalStock',
        header: () => <div className="text-right">Stock</div>,
        size: 90,
        cell: ({ getValue }) => <StockCell stock={getValue<number>()} />,
      },
      {
        accessorKey: 'basePrice',
        header: () => <div className="text-right">Price</div>,
        size: 100,
        cell: ({ getValue }) => (
          <div className="text-right tabular-nums text-[13px] text-slate-900">
            €{getValue<number>().toFixed(2)}
          </div>
        ),
      },
      {
        accessorKey: 'syncChannels',
        header: 'Channels',
        size: 130,
        cell: ({ getValue }) => <ChannelDots channels={getValue<string[]>()} />,
      },
      {
        accessorKey: 'updatedAt',
        header: 'Updated',
        size: 110,
        cell: ({ getValue }) => (
          <span className="text-[12px] text-slate-500 tabular-nums">
            {formatRelative(getValue<string>())}
          </span>
        ),
      },
    ],
    [
      allSelected,
      someSelected,
      selectedIds,
      onToggleSelect,
      onSelectAll,
      onClearSelection,
    ],
  )

  const table = useReactTable({
    data: products,
    columns,
    getCoreRowModel: getCoreRowModel(),
  })

  return (
    <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-[13px]">
          <thead className="bg-slate-50 border-b border-slate-200">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    style={{ width: h.column.columnDef.size }}
                    className="text-left px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
                  >
                    {h.isPlaceholder
                      ? null
                      : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const isSelected = selectedIds.has(row.original.id)
              return (
                <tr
                  key={row.id}
                  onClick={(e) => {
                    // Middle-click / cmd-click → new tab. Plain click →
                    // same-tab navigation.
                    if (e.metaKey || e.ctrlKey || e.button === 1) {
                      window.open(
                        `/products/${row.original.id}/edit`,
                        '_blank',
                      )
                      return
                    }
                    router.push(`/products/${row.original.id}/edit`)
                  }}
                  className={cn(
                    'border-b border-slate-100 last:border-b-0 cursor-pointer hover:bg-blue-50/40 transition-colors',
                    isSelected && 'bg-blue-50/60',
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 align-middle">
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Thumb({ src, alt }: { src: string | null; alt: string }) {
  if (!src) {
    return (
      <div className="w-10 h-10 bg-slate-100 rounded flex items-center justify-center text-slate-300">
        <Package className="w-4 h-4" />
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={(e) => {
        const img = e.currentTarget
        img.style.display = 'none'
      }}
      className="w-10 h-10 object-cover rounded bg-slate-100"
    />
  )
}

function StatusBadge({ status }: { status: string }) {
  const tone = (() => {
    switch (status) {
      case 'ACTIVE':
        return 'bg-emerald-100 text-emerald-800 border-emerald-200'
      case 'DRAFT':
        return 'bg-amber-100 text-amber-800 border-amber-200'
      case 'INACTIVE':
        return 'bg-slate-100 text-slate-600 border-slate-200'
      default:
        return 'bg-slate-100 text-slate-600 border-slate-200'
    }
  })()
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-medium',
        tone,
      )}
    >
      {status}
    </span>
  )
}

function StockCell({ stock }: { stock: number }) {
  const tone =
    stock === 0
      ? 'text-red-700'
      : stock <= 5
      ? 'text-amber-700'
      : 'text-slate-900'
  return (
    <div className={cn('text-right tabular-nums text-[13px]', tone)}>
      {stock === 0 ? 'Out' : stock.toLocaleString()}
    </div>
  )
}

function ChannelDots({ channels }: { channels: string[] }) {
  if (!channels || channels.length === 0) {
    return <span className="text-[11px] text-slate-400 italic">—</span>
  }
  return (
    <div className="flex items-center gap-1">
      {channels.slice(0, 4).map((c) => (
        <span
          key={c}
          title={c}
          className={cn(
            'w-2.5 h-2.5 rounded-full',
            CHANNEL_TONE[c] ?? 'bg-slate-400',
          )}
        />
      ))}
      {channels.length > 4 && (
        <span className="text-[10px] text-slate-500 tabular-nums ml-0.5">
          +{channels.length - 4}
        </span>
      )}
    </div>
  )
}

function formatRelative(iso: string): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const diffMs = Date.now() - then
  const sec = Math.floor(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  const yr = Math.floor(day / 365)
  return `${yr}y ago`
}

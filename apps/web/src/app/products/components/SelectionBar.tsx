'use client'

import { Download, X } from 'lucide-react'
import type { ProductRow } from '../ProductsClient'

interface Props {
  count: number
  products: ProductRow[]
  onClear: () => void
}

export default function SelectionBar({ count, products, onClear }: Props) {
  if (count === 0) return null

  const exportCsv = () => {
    const header = [
      'id',
      'sku',
      'name',
      'brand',
      'status',
      'basePrice',
      'totalStock',
      'syncChannels',
      'imageUrl',
      'updatedAt',
      'createdAt',
    ]
    const escape = (v: unknown): string => {
      if (v === null || v === undefined) return ''
      const s = String(v)
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
      return s
    }
    const rows = products.map((p) =>
      [
        p.id,
        p.sku,
        p.name,
        p.brand ?? '',
        p.status,
        p.basePrice,
        p.totalStock,
        (p.syncChannels ?? []).join('|'),
        p.imageUrl ?? '',
        p.updatedAt,
        p.createdAt,
      ]
        .map(escape)
        .join(','),
    )
    const csv = [header.join(','), ...rows].join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    a.download = `products-export-${stamp}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-slate-900 text-white rounded-full shadow-xl px-4 py-2"
      role="region"
      aria-label="Selection actions"
    >
      <span className="text-[13px] tabular-nums">
        <span className="font-semibold">{count.toLocaleString()}</span> selected
      </span>
      <div className="w-px h-5 bg-slate-700" />
      <button
        type="button"
        onClick={exportCsv}
        className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full text-[12px] font-medium bg-white text-slate-900 hover:bg-slate-100"
      >
        <Download className="w-3.5 h-3.5" />
        Export CSV
      </button>
      <button
        type="button"
        onClick={onClear}
        className="inline-flex items-center gap-1 h-7 px-2 rounded-full text-[12px] text-slate-300 hover:text-white hover:bg-slate-800"
        aria-label="Clear selection"
      >
        <X className="w-3.5 h-3.5" />
        Cancel
      </button>
    </div>
  )
}

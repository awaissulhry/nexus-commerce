'use client'

import { memo, useContext, createContext } from 'react'
import Link from 'next/link'
import { ChevronRight } from 'lucide-react'
import type { ProductRow } from '../../_types'
import type { ContentLocale } from './types'

// ── ContentLocaleContext ─────────────────────────────────────────────
// Scoped inside StatusMatrixLens, NOT at workspace root.
// Only MatrixMasterCells subscribes; channel cells don't, so locale
// changes never trigger a channel-cell re-render.
export const ContentLocaleContext = createContext<ContentLocale>('en')

interface Props {
  product: ProductRow
  isExpanded: boolean
  onToggleExpand: (id: string) => void
  rowHeight: number
}

export const MatrixMasterCells = memo(function MatrixMasterCells({
  product,
  isExpanded,
  onToggleExpand,
  rowHeight,
}: Props) {
  const locale = useContext(ContentLocaleContext)

  // Locale-aware name: prefer translation → fall back to master name.
  const displayName =
    product.translations?.[locale]?.name ?? product.name

  const cellClass = `flex items-center border-r border-slate-200 dark:border-slate-700 shrink-0 overflow-hidden`
  const textClass = `text-sm text-slate-700 dark:text-slate-300 truncate`

  return (
    <>
      {/* Expand chevron — only for parents with children */}
      <div
        className={`${cellClass} w-8 justify-center cursor-pointer`}
        style={{ height: rowHeight }}
        onClick={() => product.isParent && product.childCount ? onToggleExpand(product.id) : undefined}
      >
        {product.isParent && (product.childCount ?? 0) > 0 ? (
          <ChevronRight
            size={14}
            className={`text-slate-400 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
          />
        ) : null}
      </div>

      {/* Thumbnail */}
      <div
        className={`${cellClass} w-10 justify-center`}
        style={{ height: rowHeight }}
      >
        {product.imageUrl ? (
          <img
            src={product.imageUrl}
            alt=""
            className="w-7 h-7 object-cover rounded"
            loading="lazy"
          />
        ) : (
          <div className="w-7 h-7 rounded bg-slate-200 dark:bg-slate-700" />
        )}
      </div>

      {/* SKU */}
      <div
        className={`${cellClass} w-32 px-2`}
        style={{ height: rowHeight }}
      >
        <Link
          href={`/products/${product.id}/edit`}
          className="text-xs font-mono text-slate-600 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 truncate"
          title={product.sku}
        >
          {product.sku}
        </Link>
      </div>

      {/* Name (locale-aware) */}
      <div
        className={`${cellClass} w-56 px-2`}
        style={{ height: rowHeight }}
      >
        <span className={textClass} title={displayName}>
          {displayName}
        </span>
      </div>

      {/* Base price */}
      <div
        className={`${cellClass} w-24 px-2 justify-end`}
        style={{ height: rowHeight }}
      >
        <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">
          {product.basePrice != null
            ? new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(product.basePrice)
            : '—'}
        </span>
      </div>

      {/* Master stock */}
      <div
        className={`${cellClass} w-20 px-2 justify-end`}
        style={{ height: rowHeight }}
      >
        <span
          className={`text-sm tabular-nums ${
            product.totalStock === 0
              ? 'text-red-600 dark:text-red-400'
              : product.totalStock <= product.lowStockThreshold
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-slate-700 dark:text-slate-300'
          }`}
        >
          {product.totalStock}
        </span>
      </div>

      {/* Status badge */}
      <div
        className={`${cellClass} w-20 px-2`}
        style={{ height: rowHeight }}
      >
        <span
          className={`text-xs px-1.5 py-0.5 rounded font-medium ${
            product.status === 'ACTIVE'
              ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
              : product.status === 'DRAFT'
              ? 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-400'
              : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
          }`}
        >
          {product.status}
        </span>
      </div>
    </>
  )
})

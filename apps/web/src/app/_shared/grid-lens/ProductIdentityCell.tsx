'use client'

import Link from 'next/link'
import { Image as ImageIcon } from 'lucide-react'

export type ProductIdentityCellProps = {
  id: string
  name: string
  sku: string
  amazonAsin?: string | null
  productType?: string | null
  isParent: boolean
  parentId?: string | null
  childCount?: number
  imageUrl?: string | null
  searchQuery?: string
  onThumbClick?: (productId: string) => void
  productHref?: string
  variantDetailHref?: string
  variantDetailLabel?: string
  showThumb?: boolean
}

function Highlight({ text, query }: { text: string; query?: string }) {
  if (!query || !text) return <>{text}</>
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

export function ProductIdentityCell(props: ProductIdentityCellProps) {
  const {
    id, name, sku, amazonAsin, productType,
    isParent, parentId, childCount,
    imageUrl, searchQuery,
    onThumbClick, productHref, variantDetailHref, variantDetailLabel,
    showThumb = false,
  } = props

  const isParentRow = isParent && !parentId
  const isChildRow = !!parentId
  const count = childCount ?? 0
  const editHref = productHref ?? `/products/${id}/edit`
  const childDetailHref = variantDetailHref ?? `/products/${id}/edit`

  const handleThumbClick = () => {
    if (onThumbClick) {
      onThumbClick(id)
      return
    }
    window.dispatchEvent(
      new CustomEvent('nexus:open-product-drawer', { detail: { productId: id } }),
    )
  }

  return (
    <div className="flex items-start gap-2.5 min-w-0 py-0.5">
      {showThumb && (
        <button
          type="button"
          className="flex-shrink-0 mt-0.5 cursor-pointer rounded focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
          title="Open product drawer"
          aria-label={`Open drawer for ${name}`}
          onClick={handleThumbClick}
        >
          {imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt=""
              className="w-10 h-10 rounded object-cover bg-slate-100 dark:bg-slate-800"
            />
          ) : (
            <div className="w-10 h-10 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-300 dark:text-slate-600 flex-shrink-0">
              <ImageIcon size={14} />
            </div>
          )}
        </button>
      )}
      <div className="min-w-0 flex-1">
        <Link
          href={editHref}
          className="block text-sm font-medium text-blue-600 dark:text-blue-400 hover:underline leading-snug"
          title={name}
        >
          <Highlight text={name} query={searchQuery} />
        </Link>
        <div className="flex items-center gap-1 mt-0.5 flex-wrap text-xs">
          {amazonAsin && (
            <span className="font-mono text-slate-500 dark:text-slate-400">{amazonAsin}</span>
          )}
          {amazonAsin && sku && (
            <span className="text-slate-300 dark:text-slate-600">|</span>
          )}
          {sku && (
            <span className="font-mono text-slate-400 dark:text-slate-500">
              <Highlight text={sku} query={searchQuery} />
            </span>
          )}
          {isParentRow && productType && (amazonAsin || sku) && (
            <span className="text-slate-300 dark:text-slate-600">·</span>
          )}
          {isParentRow && productType && (
            <Link
              href={editHref}
              className="text-blue-500 dark:text-blue-400 hover:underline"
            >
              {productType.toLowerCase().replace(/_/g, '-')}
            </Link>
          )}
          {isParentRow && count > 0 && (amazonAsin || sku || productType) && (
            <span className="text-slate-300 dark:text-slate-600">·</span>
          )}
          {isParentRow && count > 0 && (
            <span className="text-slate-400 dark:text-slate-500">
              {count} variation{count !== 1 ? 's' : ''}
            </span>
          )}
          {isChildRow && (amazonAsin || sku) && (
            <span className="text-slate-300 dark:text-slate-600">·</span>
          )}
          {isChildRow && (
            <Link
              href={childDetailHref}
              className="text-blue-500 dark:text-blue-400 hover:underline"
            >
              {variantDetailLabel ?? 'Variation details'}
            </Link>
          )}
        </div>
      </div>
    </div>
  )
}

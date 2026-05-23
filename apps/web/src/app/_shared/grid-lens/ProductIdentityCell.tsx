'use client'

import { useState } from 'react'
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
  /** Derived FBA/FBM/BOTH chip — render only when set */
  fulfillmentMethod?: 'FBA' | 'FBM' | 'BOTH' | string | null
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

const FULFILLMENT_CHIP_CLASS: Record<string, string> = {
  FBA:  'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300 dark:border-orange-800',
  FBM:  'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-900/30 dark:text-sky-300 dark:border-sky-800',
  BOTH: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-900/30 dark:text-violet-300 dark:border-violet-800',
}

export function ProductIdentityCell(props: ProductIdentityCellProps) {
  const {
    id, name, sku, amazonAsin, productType,
    isParent, parentId, childCount,
    imageUrl, searchQuery,
    onThumbClick, productHref, variantDetailHref, variantDetailLabel,
    showThumb = false,
    fulfillmentMethod,
  } = props

  const isParentRow = isParent && !parentId
  const isChildRow = !!parentId
  const count = childCount ?? 0
  const editHref = productHref ?? `/products/${id}/edit`
  const childDetailHref = variantDetailHref ?? `/products/${id}/edit`

  // PG.1c — track broken image URLs so we fall back to the placeholder
  // instead of an empty <img>. Amazon CDN URLs occasionally 404 when an
  // ASIN's image set is rotated; without this, the row showed a blank
  // box and looked indistinguishable from "no image at all".
  const [imgFailed, setImgFailed] = useState(false)
  const showImage = imageUrl && !imgFailed

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
          {showImage ? (
            // PG.1c — bumped from w-10/h-10 to w-12/h-12 so the inline
            // thumbnail matches the standalone 'thumb' column (48 px).
            // loading=lazy + decoding=async keep the initial paint snappy
            // when 100+ rows render at once.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setImgFailed(true)}
              className="w-12 h-12 rounded object-cover bg-slate-100 dark:bg-slate-800"
            />
          ) : (
            <div className="w-12 h-12 rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-300 dark:text-slate-600 flex-shrink-0">
              <ImageIcon size={16} />
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
          {fulfillmentMethod && (
            <span
              className={`ml-1 inline-block font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded text-[10px] leading-none ${FULFILLMENT_CHIP_CLASS[fulfillmentMethod] ?? 'bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700'}`}
              title={
                fulfillmentMethod === 'BOTH'
                  ? 'Has FBA and FBM offers'
                  : `${fulfillmentMethod} fulfillment`
              }
            >
              {fulfillmentMethod}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

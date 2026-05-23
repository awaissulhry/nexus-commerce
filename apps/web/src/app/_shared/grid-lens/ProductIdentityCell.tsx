'use client'

import Link from 'next/link'
import { Thumbnail } from './Thumbnail'

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
  /** PG.7 — drives the multi-image dot on the thumbnail. */
  photoCount?: number
  searchQuery?: string
  onThumbClick?: (productId: string) => void
  productHref?: string
  variantDetailHref?: string
  variantDetailLabel?: string
  showThumb?: boolean
  /** Derived FBA/FBM/BOTH chip — render only when set */
  fulfillmentMethod?: 'FBA' | 'FBM' | 'BOTH' | string | null
  /** PG.9 — when set, the thumbnail accepts file drops and forwards
   *  them to this callback. Caller owns the actual upload. */
  onUploadFiles?: (files: File[]) => Promise<void>
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
    imageUrl, photoCount, searchQuery,
    onThumbClick, productHref, variantDetailHref, variantDetailLabel,
    showThumb = false,
    fulfillmentMethod,
    onUploadFiles,
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
    <div className="flex items-center gap-2.5 min-w-0 py-0.5">
      {showThumb && (
        // PG.7 — the inline thumb routes through the shared Thumbnail
        // component (hover preview, multi-image dot, Cloudinary
        // transform, blur-up, onError, density-aware sizing all live
        // there). Was previously a bespoke <img> path; refactor keeps
        // every catalog surface consistent.
        <Thumbnail
          src={imageUrl ?? null}
          photoCount={photoCount}
          alt={name}
          title={`Open drawer for ${name}`}
          onClick={handleThumbClick}
          onUpload={onUploadFiles}
        />
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

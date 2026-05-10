'use client'

import Link from 'next/link'
import { GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface FamilySibling {
  id: string
  sku: string
  name: string
  variations?: Record<string, string> | null
  variantAttributes?: Record<string, unknown> | null
}

export interface FamilyParent {
  id: string
  sku: string
  name: string
}

interface Props {
  currentProductId: string
  /** Amazon parent ASIN (non-buyable parent listing) — lives on the child product */
  currentParentAsin?: string | null
  parentProduct: FamilyParent
  siblings: FamilySibling[]
  /** Listings of the parent product, keyed by channel (AMAZON / EBAY / SHOPIFY) */
  parentListings: Record<string, Array<{ channel: string; marketplace: string; externalListingId: string | null }>>
  /** Optional CSS class override for the outer container */
  className?: string
}

function variantLabel(s: FamilySibling): string {
  const axes = s.variations ?? (s.variantAttributes as Record<string, string> | null)
  if (axes && Object.keys(axes).length > 0) {
    return Object.values(axes)
      .filter((v) => typeof v === 'string' && v.length > 0)
      .join(' / ')
  }
  return s.sku
}

export function VariationFamilyBanner({
  currentProductId,
  currentParentAsin,
  parentProduct,
  siblings,
  parentListings,
  className,
}: Props) {
  const ebayId = (parentListings.EBAY ?? []).find((l) => l.externalListingId)
    ?.externalListingId ?? null
  const shopifyId = (parentListings.SHOPIFY ?? []).find((l) => l.externalListingId)
    ?.externalListingId ?? null

  return (
    <div
      className={cn(
        'border-b border-blue-100 dark:border-slate-700 bg-blue-50/70 dark:bg-slate-800/60 px-6 py-2 text-sm',
        className,
      )}
    >
      {/* Row 1 — parent identity + channel parent IDs */}
      <div className="flex items-center gap-2.5 flex-wrap max-w-7xl mx-auto">
        <GitBranch className="w-3.5 h-3.5 text-blue-400 dark:text-blue-500 flex-shrink-0" />
        <span className="text-slate-500 dark:text-slate-400 flex-shrink-0 text-xs">
          Variant of
        </span>
        <Link
          href={`/products/${parentProduct.id}/edit`}
          className="font-semibold text-slate-800 dark:text-slate-200 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          {parentProduct.name}
        </Link>
        <span className="font-mono text-slate-400 dark:text-slate-500 text-xs">
          {parentProduct.sku}
        </span>

        {/* Channel parent ID badges */}
        {currentParentAsin && (
          <ChannelIdBadge label="Amazon ASIN" value={currentParentAsin} />
        )}
        {ebayId && <ChannelIdBadge label="eBay" value={ebayId} />}
        {shopifyId && <ChannelIdBadge label="Shopify" value={shopifyId} />}
      </div>

      {/* Row 2 — sibling variant chips (scrollable) */}
      {siblings.length > 0 && (
        <div className="mt-1.5 max-w-7xl mx-auto flex items-center gap-1.5 overflow-x-auto pb-0.5 scroll-smooth">
          {siblings.map((s) => {
            const isCurrent = s.id === currentProductId
            return (
              <Link
                key={s.id}
                href={`/products/${s.id}/edit`}
                onClick={(e) => {
                  if (isCurrent) e.preventDefault()
                }}
                aria-current={isCurrent ? 'page' : undefined}
                title={s.sku}
                className={cn(
                  'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border whitespace-nowrap transition-colors flex-shrink-0',
                  isCurrent
                    ? 'bg-blue-600 text-white border-blue-700 dark:bg-blue-500 dark:border-blue-400 cursor-default pointer-events-none'
                    : 'bg-white dark:bg-slate-700 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-600 hover:border-blue-300 hover:text-blue-600 dark:hover:border-blue-500 dark:hover:text-blue-400',
                )}
              >
                {isCurrent && (
                  <span className="w-1.5 h-1.5 rounded-full bg-white/80 flex-shrink-0" />
                )}
                {variantLabel(s)}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ChannelIdBadge({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-700 px-1.5 py-0.5 text-xs">
      <span className="font-medium text-slate-400 dark:text-slate-500">{label}:</span>
      <span className="font-mono text-slate-700 dark:text-slate-200 max-w-[140px] truncate">
        {value}
      </span>
    </span>
  )
}

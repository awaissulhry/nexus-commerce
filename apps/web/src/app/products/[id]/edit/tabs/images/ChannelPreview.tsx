'use client'

// IR.5.3 / IR.5.4 — Channel storefront preview.
//
// Renders a stylised mockup of what the listing will look like to a
// buyer on each channel — hero image, thumbnail rail, title, price,
// add-to-cart. Pulls images from the same resolved set the publish
// flow uses so the preview lines up with what actually goes live.
//
// The preview is intentionally stylised, not pixel-perfect — it's a
// composition aid ("would the operator be happy if a customer saw
// this?"), not a screenshot. Each channel uses its own layout:
//
//   - Amazon: detail-page strip (left image stack, right CTA panel)
//   - eBay: listing card (carousel + price stack)
//   - Shopify: PDP (gallery rail + variant picker)
//
// Data:
//   - product → workspace.product (name, sku, brand-derivable)
//   - images → ListingImage[] resolved for the platform (with master
//     gallery as fallback so master-tab edits show through)

import { useState } from 'react'
import { cn } from '@/lib/utils'
import type { ListingImage, ProductImage, VariantSummary, WorkspaceProduct } from './types'

type PlatformKey = 'AMAZON' | 'EBAY' | 'SHOPIFY'

interface Props {
  platform: PlatformKey
  product: WorkspaceProduct
  masterImages: ProductImage[]
  listingImages: ListingImage[]
  variants: VariantSummary[]
  /** Optional marketplace narrowing for Amazon — IT/DE/FR/ES/UK. When set,
   *  prefers MARKETPLACE-scoped rows over PLATFORM-scoped fallbacks. */
  marketplace?: string
}

/** Resolve the gallery for the given channel: prefer channel-specific
 *  ListingImage rows, fall back to the master gallery so the preview
 *  isn't empty before any cross-channel sync has run. */
function resolveGallery(
  platform: PlatformKey,
  masterImages: ProductImage[],
  listingImages: ListingImage[],
  marketplace?: string,
): { url: string; alt: string | null }[] {
  const channelImages = listingImages.filter((i) => i.platform === platform)
  if (channelImages.length > 0) {
    const sorted = channelImages
      .filter((i) => !i.variantGroupKey) // gallery only, not variation-set
      .filter((i) => marketplace ? (i.marketplace === marketplace || i.marketplace === null) : true)
      .sort((a, b) => a.position - b.position)
    if (sorted.length > 0) return sorted.map((i) => ({ url: i.url, alt: null }))
  }
  return masterImages.map((m) => ({ url: m.url, alt: m.alt }))
}

// ── Channel layouts ─────────────────────────────────────────────────

function AmazonDetail({ product, gallery }: { product: WorkspaceProduct; gallery: { url: string; alt: string | null }[] }) {
  const [activeIdx, setActiveIdx] = useState(0)
  const active = gallery[activeIdx] ?? gallery[0]

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-5">
      {/* Image stack */}
      <div className="flex gap-2">
        {/* Thumbnail rail */}
        <div className="flex flex-col gap-1.5">
          {gallery.slice(0, 7).map((img, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActiveIdx(i)}
              className={cn(
                'w-9 h-9 rounded border-2 bg-white overflow-hidden flex-shrink-0',
                i === activeIdx ? 'border-orange-500' : 'border-slate-200 dark:border-slate-700 hover:border-orange-400',
              )}
              title={`Image ${i + 1}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt={img.alt ?? ''} className="w-full h-full object-contain" loading="lazy" />
            </button>
          ))}
        </div>
        {/* Hero */}
        <div className="flex-1 aspect-square rounded border border-slate-200 dark:border-slate-700 bg-white overflow-hidden">
          {active ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={active.url} alt={active.alt ?? ''} className="w-full h-full object-contain" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-slate-300">No images</div>
          )}
        </div>
      </div>

      {/* Right panel */}
      <div className="space-y-3">
        <h1 className="text-base font-medium text-slate-800 dark:text-slate-100 leading-snug">
          {product.name || <span className="text-slate-400 italic">[Product title from Master tab]</span>}
        </h1>
        <div className="text-xs text-slate-500">
          Brand: <span className="text-blue-600 dark:text-blue-400 hover:underline cursor-default">—</span>
          <span className="mx-2 text-amber-500">★★★★★</span>
          <span className="text-slate-400">(0 ratings)</span>
        </div>
        <div className="text-2xl text-rose-600 font-medium">€—</div>
        <ul className="text-xs text-slate-600 dark:text-slate-300 space-y-1 list-disc pl-4">
          <li className="text-slate-400 italic">Bullet 1 — pulled from Master tab</li>
          <li className="text-slate-400 italic">Bullet 2 — pulled from Master tab</li>
          <li className="text-slate-400 italic">Bullet 3 — pulled from Master tab</li>
        </ul>
        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded p-2.5 space-y-1.5">
          <div className="text-xs text-slate-700 dark:text-slate-200">Acquista Ora · 1-Click</div>
          <button type="button" disabled className="w-full bg-amber-300/70 text-slate-800 text-xs py-1.5 rounded font-medium">
            Add to Cart
          </button>
          <button type="button" disabled className="w-full bg-orange-400/70 text-white text-xs py-1.5 rounded font-medium">
            Buy Now
          </button>
        </div>
      </div>
    </div>
  )
}

function EbayCard({ product, gallery }: { product: WorkspaceProduct; gallery: { url: string; alt: string | null }[] }) {
  const [activeIdx, setActiveIdx] = useState(0)
  const active = gallery[activeIdx] ?? gallery[0]
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5">
      <div className="space-y-2">
        <div className="aspect-square rounded border border-slate-200 dark:border-slate-700 bg-white overflow-hidden">
          {active ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={active.url} alt={active.alt ?? ''} className="w-full h-full object-contain" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-slate-300">No images</div>
          )}
        </div>
        <div className="flex gap-1.5 overflow-x-auto">
          {gallery.slice(0, 8).map((img, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActiveIdx(i)}
              className={cn(
                'w-10 h-10 rounded border-2 bg-white overflow-hidden flex-shrink-0',
                i === activeIdx ? 'border-blue-500' : 'border-slate-200 dark:border-slate-700',
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt="" className="w-full h-full object-contain" loading="lazy" />
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h1 className="text-base font-medium text-slate-800 dark:text-slate-100 leading-snug">
          {product.name || <span className="text-slate-400 italic">[Product title from Master tab]</span>}
        </h1>
        <div className="text-xs text-slate-500 flex items-center gap-2">
          <span className="text-emerald-600 dark:text-emerald-400">Brand new</span>
          <span>·</span>
          <span>Free shipping</span>
        </div>
        <div className="text-2xl text-slate-800 dark:text-slate-100 font-medium">EUR —</div>
        <div className="flex gap-2">
          <button type="button" disabled className="bg-blue-600/70 text-white text-xs py-2 px-4 rounded-full font-medium">
            Buy It Now
          </button>
          <button type="button" disabled className="border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 text-xs py-2 px-4 rounded-full font-medium">
            Add to Cart
          </button>
        </div>
        <div className="text-xs text-slate-500 space-y-0.5">
          <div>Item: {product.ebayItemId ?? '—'}</div>
          <div>SKU: {product.sku}</div>
        </div>
      </div>
    </div>
  )
}

function ShopifyPDP({
  product,
  gallery,
  variants,
}: {
  product: WorkspaceProduct
  gallery: { url: string; alt: string | null }[]
  variants: VariantSummary[]
}) {
  const [activeIdx, setActiveIdx] = useState(0)
  const active = gallery[activeIdx] ?? gallery[0]
  const colors = Array.from(
    new Set(
      variants
        .map((v) => (v.variantAttributes as Record<string, string> | null)?.['Color']
          ?? (v.variantAttributes as Record<string, string> | null)?.['Colore'])
        .filter(Boolean) as string[],
    ),
  )
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
      <div className="space-y-2">
        <div className="aspect-[4/5] rounded border border-slate-200 dark:border-slate-700 bg-white overflow-hidden">
          {active ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={active.url} alt={active.alt ?? ''} className="w-full h-full object-contain" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-xs text-slate-300">No images</div>
          )}
        </div>
        <div className="flex gap-1.5 overflow-x-auto">
          {gallery.slice(0, 8).map((img, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setActiveIdx(i)}
              className={cn(
                'w-12 h-15 rounded border-2 bg-white overflow-hidden flex-shrink-0',
                i === activeIdx ? 'border-emerald-500' : 'border-slate-200 dark:border-slate-700',
              )}
              style={{ aspectRatio: '4/5' }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={img.url} alt="" className="w-full h-full object-contain" loading="lazy" />
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100 leading-tight">
          {product.name || <span className="text-slate-400 italic">[Product title from Master tab]</span>}
        </h1>
        <div className="text-base text-slate-700 dark:text-slate-200 font-medium">€—</div>
        {colors.length > 0 && (
          <div>
            <div className="text-xs text-slate-500 mb-1.5">Color · <span className="text-slate-700 dark:text-slate-200">{colors[0]}</span></div>
            <div className="flex flex-wrap gap-1.5">
              {colors.map((c, i) => (
                <button
                  key={c}
                  type="button"
                  disabled
                  className={cn(
                    'px-2.5 py-1 text-xs border rounded',
                    i === 0
                      ? 'border-slate-900 dark:border-slate-100 bg-slate-50 dark:bg-slate-800'
                      : 'border-slate-200 dark:border-slate-700 text-slate-500',
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-1.5 pt-2">
          <button type="button" disabled className="w-full bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs py-2.5 rounded font-medium">
            Add to cart
          </button>
          <button type="button" disabled className="w-full border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 text-xs py-2.5 rounded font-medium">
            Buy with ●●●
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ChannelPreview({
  platform,
  product,
  masterImages,
  listingImages,
  variants,
  marketplace,
}: Props) {
  const gallery = resolveGallery(platform, masterImages, listingImages, marketplace)

  return (
    <div className="bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-700 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          Buyer preview · {platform.toLowerCase()}{marketplace ? ` · ${marketplace}` : ''}
        </span>
        <span className="text-[10px] text-slate-400 dark:text-slate-500">
          {gallery.length} image{gallery.length === 1 ? '' : 's'} resolved
        </span>
      </div>
      {platform === 'AMAZON' && <AmazonDetail product={product} gallery={gallery} />}
      {platform === 'EBAY' && <EbayCard product={product} gallery={gallery} />}
      {platform === 'SHOPIFY' && <ShopifyPDP product={product} gallery={gallery} variants={variants} />}
    </div>
  )
}

'use client'

// AC.2 — Live Amazon PDP preview.
//
// Renders an approximation of how the listing will look on Amazon, in
// either the mobile app skin or the desktop web skin. Updates from the
// ComposedAmazonListing prop on every render — no internal data state
// beyond the skin toggle and the current gallery slot.
//
// Fidelity goal: "if you squint, that's an Amazon PDP". Not pixel-
// perfect — AC.14 could swap to Amazon's actual rendering service if
// gated access is granted — but dense enough to catch the obvious
// problems pre-publish:
//
//   * title that wraps awkwardly on mobile (>200 chars)
//   * bullets that don't read like Amazon bullets
//   * a price block that looks broken because qty/quantity is empty
//   * a hero image that's clearly not white-background
//   * a variation strip with empty axis values
//   * Prime / FBA stamps that surprise the operator
//
// The buy-box-style buttons here are visual only.

import { useState } from 'react'
import {
  Heart,
  ShoppingCart,
  Truck,
  ShieldCheck,
  ChevronLeft,
  ChevronRight,
  Smartphone,
  Monitor,
  Star,
  MapPin,
  Recycle,
} from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import type { ComposedAmazonListing } from './types'

interface Props {
  composed: ComposedAmazonListing
  className?: string
}

type Skin = 'mobile' | 'desktop'

const MARKET_FLAG: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', UK: '🇬🇧',
  US: '🇺🇸', JP: '🇯🇵', NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪',
}

const MARKET_TLD: Record<string, string> = {
  IT: 'amazon.it',
  DE: 'amazon.de',
  FR: 'amazon.fr',
  ES: 'amazon.es',
  UK: 'amazon.co.uk',
  US: 'amazon.com',
  JP: 'amazon.co.jp',
  NL: 'amazon.nl',
  SE: 'amazon.se',
  PL: 'amazon.pl',
  BE: 'amazon.com.be',
}

export default function AmazonLivePreview({ composed, className }: Props) {
  const [skin, setSkin] = useState<Skin>('mobile')
  const [galleryIdx, setGalleryIdx] = useState(0)

  const gallery =
    composed.galleryUrls.value.length > 0
      ? composed.galleryUrls.value
      : composed.primaryImageUrl.value
      ? [composed.primaryImageUrl.value]
      : []
  const currentImg = gallery[galleryIdx] ?? composed.primaryImageUrl.value
  const flag = MARKET_FLAG[composed.marketplace.code] ?? '🌐'
  const tld = MARKET_TLD[composed.marketplace.code] ?? 'amazon'

  return (
    <div
      className={cn(
        'rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900',
        className,
      )}
    >
      {/* Header strip — amazon wordmark + market chip + skin toggle */}
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-[#232f3e] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-bold text-[15px] tracking-tight text-white leading-none">
            amazon
            <span className="text-[#ff9900]">.</span>
          </span>
          <span className="text-[11px] text-slate-300 font-mono truncate">
            {tld}
          </span>
          <span className="text-[11px] text-slate-400">
            {flag} {composed.marketplace.code}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSkin('mobile')}
            className={cn(
              'inline-flex items-center gap-1 h-6 px-2 text-[11px] rounded border transition-colors',
              skin === 'mobile'
                ? 'border-[#ff9900] bg-[#ff9900]/15 text-white'
                : 'border-transparent text-slate-300 hover:text-white',
            )}
            title="Mobile preview"
          >
            <Smartphone className="w-3 h-3" /> Mobile
          </button>
          <button
            type="button"
            onClick={() => setSkin('desktop')}
            className={cn(
              'inline-flex items-center gap-1 h-6 px-2 text-[11px] rounded border transition-colors',
              skin === 'desktop'
                ? 'border-[#ff9900] bg-[#ff9900]/15 text-white'
                : 'border-transparent text-slate-300 hover:text-white',
            )}
            title="Desktop preview"
          >
            <Monitor className="w-3 h-3" /> Desktop
          </button>
        </div>
      </div>

      {skin === 'mobile' ? (
        <MobileSkin
          composed={composed}
          currentImg={currentImg}
          gallery={gallery}
          galleryIdx={galleryIdx}
          setGalleryIdx={setGalleryIdx}
        />
      ) : (
        <DesktopSkin
          composed={composed}
          currentImg={currentImg}
          gallery={gallery}
          galleryIdx={galleryIdx}
          setGalleryIdx={setGalleryIdx}
        />
      )}

      {/* Footer health hints — fast read-out of what the preview is
          showing, mirrors EbayLivePreview's strip. AC.4 promotes this
          to the real health score; the strip here stays as a fast
          glance counter beside the score. */}
      <div className="px-3 py-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-3 flex-wrap">
          <span>Title {composed.healthHints.titleLength}/200</span>
          <span>Bullets {composed.healthHints.bulletCount}/5</span>
          <span>Desc {composed.healthHints.descriptionLength}</span>
          <span>Images {composed.galleryUrls.value.length}/9</span>
          {composed.variationSummary.variantCount > 0 && (
            <span>
              Variants {composed.variationSummary.publishedVariantCount}/
              {composed.variationSummary.variantCount}
            </span>
          )}
        </div>
        {composed.healthHints.masterIsNewer && (
          <Badge variant="warning">Master is newer</Badge>
        )}
      </div>
    </div>
  )
}

interface SkinProps {
  composed: ComposedAmazonListing
  currentImg: string | null
  gallery: string[]
  galleryIdx: number
  setGalleryIdx: (n: number) => void
}

// ── Mobile skin — single column, sticky CTA at bottom ──────────────────
function MobileSkin(props: SkinProps) {
  const { composed, currentImg, gallery, galleryIdx, setGalleryIdx } = props
  const isFba = composed.fulfillmentChannel.value === 'FBA'
  return (
    <div className="mx-auto bg-white dark:bg-slate-950" style={{ maxWidth: 400 }}>
      {/* Image with wishlist heart + gallery nav */}
      <div className="relative aspect-square bg-white dark:bg-slate-900">
        {currentImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={currentImg}
            alt={composed.title.value}
            className="w-full h-full object-contain"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-300 text-xs">
            No image
          </div>
        )}
        {gallery.length > 1 && (
          <GalleryNav idx={galleryIdx} setIdx={setGalleryIdx} total={gallery.length} />
        )}
        <button
          type="button"
          className="absolute top-2 right-2 w-9 h-9 rounded-full bg-white/95 border border-slate-200 flex items-center justify-center text-slate-500 hover:text-rose-500 shadow-sm"
          title="Add to List"
        >
          <Heart className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-2.5">
        {/* Brand link (blue, Amazon's "Visit the X Store" style) */}
        {composed.brand.value ? (
          <div className="text-xs text-[#007185] dark:text-[#4ec5e0]">
            Visit the {composed.brand.value} Store
          </div>
        ) : (
          <div className="text-xs text-slate-400 italic">No brand set</div>
        )}

        {/* Title */}
        <div className="text-[16px] leading-snug font-medium text-slate-900 dark:text-slate-100">
          {composed.title.value || (
            <em className="text-slate-400">No title set</em>
          )}
        </div>

        {/* Ratings placeholder — real stars come in AC.10 from Reviews */}
        <FakeRating />

        {/* Price block + Prime stamp */}
        <div className="pt-1 pb-2 border-t border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-baseline gap-1">
            <span className="text-[11px] font-medium text-slate-700 dark:text-slate-300 self-start mt-1">
              {composed.currency === 'EUR' ? '€' : composed.currency === 'GBP' ? '£' : composed.currency === 'USD' ? '$' : composed.currency}
            </span>
            <span className="text-3xl font-medium text-slate-900 dark:text-slate-100 leading-none">
              {composed.price.value != null ? composed.price.value.toFixed(2).split('.')[0] : '—'}
            </span>
            {composed.price.value != null && (
              <span className="text-[13px] font-medium text-slate-700 dark:text-slate-300 self-start mt-1">
                {composed.price.value.toFixed(2).split('.')[1]}
              </span>
            )}
          </div>
          {isFba && (
            <div className="mt-1 flex items-center gap-1.5 text-[11px]">
              <PrimeBadge />
              <span className="text-slate-600 dark:text-slate-300">
                FREE delivery
              </span>
              <span className="text-slate-400">·</span>
              <span className="text-slate-600 dark:text-slate-300">FREE Returns</span>
            </div>
          )}
        </div>

        {/* Variation chips */}
        {composed.variationSummary.variantCount > 0 && (
          <VariationStrip composed={composed} compact />
        )}

        {/* CTAs */}
        <div className="space-y-1.5 pt-1">
          <button
            type="button"
            className="w-full h-10 rounded-full bg-[#ffd814] hover:bg-[#f7ca00] text-slate-900 text-sm font-medium border border-[#fcd200] shadow-sm"
          >
            Add to Cart
          </button>
          <button
            type="button"
            className="w-full h-10 rounded-full bg-[#ffa41c] hover:bg-[#fa8900] text-slate-900 text-sm font-medium border border-[#ff8f00] shadow-sm"
          >
            Buy Now
          </button>
        </div>

        {/* Delivery / Ships from */}
        <DeliveryRow composed={composed} />

        {/* About this item */}
        <BulletBlock composed={composed} />

        {/* Description preview */}
        <DescriptionBlock composed={composed} />

        {/* Compliance footers — placeholder; AC.4 fills with real GPSR/hazmat */}
        <ComplianceFooter />
      </div>
    </div>
  )
}

// ── Desktop skin — 3-column with buy box on the right ──────────────────
function DesktopSkin(props: SkinProps) {
  const { composed, currentImg, gallery, galleryIdx, setGalleryIdx } = props
  const isFba = composed.fulfillmentChannel.value === 'FBA'
  return (
    <div className="p-4 grid grid-cols-[40px_240px_1fr_220px] gap-4 max-w-[920px] mx-auto bg-white dark:bg-slate-950">
      {/* Far-left vertical thumbnail rail (Amazon desktop pattern) */}
      <div className="flex flex-col gap-1.5">
        {gallery.slice(0, 7).map((url, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setGalleryIdx(i)}
            onMouseEnter={() => setGalleryIdx(i)}
            className={cn(
              'aspect-square rounded border overflow-hidden bg-white dark:bg-slate-800',
              i === galleryIdx
                ? 'border-[#e77600] ring-2 ring-[#e77600]/40'
                : 'border-slate-200 dark:border-slate-700',
            )}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt="" className="w-full h-full object-cover" />
          </button>
        ))}
      </div>

      {/* Main image */}
      <div>
        <div className="relative aspect-square bg-white dark:bg-slate-900 rounded">
          {currentImg ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={currentImg}
              alt={composed.title.value}
              className="w-full h-full object-contain"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-slate-300 text-xs">
              No image
            </div>
          )}
          {gallery.length > 1 && (
            <GalleryNav idx={galleryIdx} setIdx={setGalleryIdx} total={gallery.length} />
          )}
        </div>
        {/* Climate Pledge chip — placeholder until AC.4 wires real attribute */}
        <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 text-[10.5px] text-emerald-800 dark:text-emerald-300">
          <Recycle className="w-3 h-3" />
          Climate Pledge Friendly (preview)
        </div>
      </div>

      {/* Middle: title / brand / bullets */}
      <div className="space-y-2 min-w-0">
        {composed.brand.value ? (
          <div className="text-[13px] text-[#007185] dark:text-[#4ec5e0] hover:underline cursor-pointer">
            Visit the {composed.brand.value} Store
          </div>
        ) : (
          <div className="text-[13px] text-slate-400 italic">No brand set</div>
        )}
        <div className="text-[20px] leading-snug font-medium text-slate-900 dark:text-slate-100">
          {composed.title.value || (
            <em className="text-slate-400">No title set</em>
          )}
        </div>
        <FakeRating />

        <div className="border-t border-slate-200 dark:border-slate-800 pt-2">
          {composed.variationSummary.variantCount > 0 && (
            <VariationStrip composed={composed} />
          )}
        </div>

        <BulletBlock composed={composed} />
        <DescriptionBlock composed={composed} />
        <ComplianceFooter />
      </div>

      {/* Right: buy box */}
      <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2 h-fit">
        <div className="flex items-baseline gap-1">
          <span className="text-[11px] font-medium text-slate-700 dark:text-slate-300 self-start mt-1">
            {composed.currency === 'EUR' ? '€' : composed.currency === 'GBP' ? '£' : composed.currency === 'USD' ? '$' : composed.currency}
          </span>
          <span className="text-2xl font-medium text-slate-900 dark:text-slate-100 leading-none">
            {composed.price.value != null ? composed.price.value.toFixed(2).split('.')[0] : '—'}
          </span>
          {composed.price.value != null && (
            <span className="text-[12px] font-medium text-slate-700 dark:text-slate-300 self-start mt-1">
              {composed.price.value.toFixed(2).split('.')[1]}
            </span>
          )}
        </div>
        {isFba && (
          <div className="flex items-center gap-1.5 text-[11px]">
            <PrimeBadge />
            <span className="text-slate-600 dark:text-slate-300">
              FREE delivery
            </span>
          </div>
        )}
        <div className="text-[11.5px]">
          {composed.quantity.value != null && composed.quantity.value > 0 ? (
            <span className="text-emerald-700 dark:text-emerald-400 font-medium">
              In Stock
            </span>
          ) : (
            <span className="text-rose-700 dark:text-rose-400 font-medium">
              Currently unavailable
            </span>
          )}
          {composed.quantity.value != null && composed.quantity.value > 0 && composed.quantity.value < 5 && (
            <span className="text-rose-700 dark:text-rose-400 ml-1">
              · Only {composed.quantity.value} left
            </span>
          )}
        </div>
        <div className="text-[11px] text-slate-600 dark:text-slate-400 space-y-0.5">
          <div className="flex items-center gap-1">
            <MapPin className="w-3 h-3 text-slate-400" />
            Deliver to {composed.marketplace.code}
          </div>
          <div>
            Ships from{' '}
            <span className="text-slate-700 dark:text-slate-300 font-medium">
              {isFba ? 'Amazon' : 'Xavia'}
            </span>
          </div>
          <div>
            Sold by{' '}
            <span className="text-slate-700 dark:text-slate-300 font-medium">
              Xavia
            </span>
          </div>
        </div>
        {/* Quantity dropdown stub */}
        <div className="flex items-center gap-1 text-[11.5px]">
          <span className="text-slate-600 dark:text-slate-400">Quantity:</span>
          <span className="inline-flex items-center px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-800 text-slate-900 dark:text-slate-100 font-medium">
            1 ▾
          </span>
        </div>
        <div className="space-y-1.5 pt-1">
          <button
            type="button"
            className="w-full h-9 rounded-full bg-[#ffd814] hover:bg-[#f7ca00] text-slate-900 text-[13px] font-medium border border-[#fcd200] shadow-sm inline-flex items-center justify-center gap-1.5"
          >
            <ShoppingCart className="w-3.5 h-3.5" /> Add to Cart
          </button>
          <button
            type="button"
            className="w-full h-9 rounded-full bg-[#ffa41c] hover:bg-[#fa8900] text-slate-900 text-[13px] font-medium border border-[#ff8f00] shadow-sm"
          >
            Buy Now
          </button>
        </div>
        <div className="pt-1.5 border-t border-slate-100 dark:border-slate-800 text-[10.5px] text-slate-500 space-y-0.5">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-3 h-3 text-slate-400" /> Secure transaction
          </div>
          <div className="flex items-center gap-1.5">
            <Truck className="w-3 h-3 text-slate-400" />
            {isFba ? 'Fulfilled by Amazon' : 'Ships from Xavia'}
          </div>
        </div>
        {/* Add to List */}
        <button
          type="button"
          className="w-full h-7 mt-1 rounded text-[11px] border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 inline-flex items-center justify-center gap-1"
        >
          <Heart className="w-3 h-3" /> Add to List
        </button>
      </div>
    </div>
  )
}

// ── Shared inner blocks ────────────────────────────────────────────────

function GalleryNav({
  idx,
  setIdx,
  total,
}: {
  idx: number
  setIdx: (n: number) => void
  total: number
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => setIdx((idx - 1 + total) % total)}
        className="absolute top-1/2 -translate-y-1/2 left-1 w-7 h-7 rounded-full bg-white/90 border border-slate-200 flex items-center justify-center text-slate-600"
        aria-label="Previous image"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={() => setIdx((idx + 1) % total)}
        className="absolute top-1/2 -translate-y-1/2 right-1 w-7 h-7 rounded-full bg-white/90 border border-slate-200 flex items-center justify-center text-slate-600"
        aria-label="Next image"
      >
        <ChevronRight className="w-4 h-4" />
      </button>
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full bg-black/60 text-[10px] text-white">
        {idx + 1} / {total}
      </div>
    </>
  )
}

function FakeRating() {
  // Placeholder until AC.10 + Reviews wire real star data. Visually
  // anchors the title so operators can sanity-check title spacing.
  return (
    <div className="flex items-center gap-1.5 text-[11.5px]">
      <span className="flex items-center text-[#ffa41c]">
        {[0, 1, 2, 3, 4].map((i) => (
          <Star
            key={i}
            className="w-3 h-3"
            fill={i < 4 ? 'currentColor' : 'none'}
            strokeWidth={1.5}
          />
        ))}
      </span>
      <span className="text-[#007185] dark:text-[#4ec5e0] hover:underline cursor-pointer">
        4.3
      </span>
      <span className="text-slate-400">·</span>
      <span className="text-[#007185] dark:text-[#4ec5e0] hover:underline cursor-pointer">
        Ratings TBD
      </span>
    </div>
  )
}

function PrimeBadge() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="text-[#00a8e1] font-bold text-[11px] leading-none">
        prime
      </span>
    </span>
  )
}

function VariationStrip({
  composed,
  compact = false,
}: {
  composed: ComposedAmazonListing
  compact?: boolean
}) {
  // AC.2 surfaces a flat variation chip row built from the axes the
  // compositor saw on the master record. AC.6 replaces this with the
  // real per-axis selector + live image swap.
  const axes = composed.variationSummary.axes
  if (axes.length === 0) return null
  return (
    <div className={cn('space-y-1.5', compact ? 'pt-1' : 'pt-0')}>
      {axes.map((axis) => (
        <div key={axis} className="flex items-center gap-2 flex-wrap">
          <span className="text-[11.5px] text-slate-600 dark:text-slate-400 min-w-[60px]">
            {axis}:
          </span>
          <div className="flex items-center gap-1 flex-wrap">
            {/* Placeholder chips — AC.6 reads real Variant.options. */}
            {['1', '2', '3'].map((slot) => (
              <span
                key={slot}
                className="inline-flex items-center px-2 py-0.5 rounded border border-slate-300 dark:border-slate-600 text-[11px] text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-800"
              >
                Option {slot}
              </span>
            ))}
          </div>
        </div>
      ))}
      <div className="text-[10.5px] text-slate-400 italic">
        AC.6 — real per-axis values + image swap.
      </div>
    </div>
  )
}

function DeliveryRow({ composed }: { composed: ComposedAmazonListing }) {
  const isFba = composed.fulfillmentChannel.value === 'FBA'
  return (
    <div className="text-[11.5px] text-slate-700 dark:text-slate-300 space-y-0.5 pt-1">
      <div className="flex items-center gap-1.5">
        <Truck className="w-3.5 h-3.5 text-slate-400" />
        <span>
          {isFba ? (
            <>
              <span className="font-medium">FREE delivery</span> tomorrow
            </>
          ) : (
            <>
              <span className="font-medium">Ships from</span> Xavia
            </>
          )}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5 text-slate-400" />
        <span>30-day returns</span>
      </div>
    </div>
  )
}

function BulletBlock({ composed }: { composed: ComposedAmazonListing }) {
  const bullets = composed.bullets.value
  if (bullets.length === 0) {
    return (
      <div className="text-xs text-rose-600 dark:text-rose-400 italic pt-2 border-t border-slate-100 dark:border-slate-800">
        No bullet points set — Amazon expects 5 short feature bullets.
      </div>
    )
  }
  return (
    <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
      <div className="text-[13px] font-semibold text-slate-900 dark:text-slate-100 mb-1.5">
        About this item
      </div>
      <ul className="list-disc list-outside pl-4 space-y-1 text-[12px] text-slate-700 dark:text-slate-300">
        {bullets.slice(0, 5).map((b, i) => (
          <li key={i} className="leading-snug">
            {b}
          </li>
        ))}
        {bullets.length < 5 && (
          <li className="text-rose-600 dark:text-rose-400 italic list-none">
            {5 - bullets.length} more bullet{5 - bullets.length === 1 ? '' : 's'} expected by Amazon
          </li>
        )}
      </ul>
    </div>
  )
}

function DescriptionBlock({ composed }: { composed: ComposedAmazonListing }) {
  const desc = composed.description.value
  if (!desc) {
    return (
      <div className="text-xs text-slate-400 italic pt-2 border-t border-slate-100 dark:border-slate-800">
        No description set — buyers will see a sparse PDP on Amazon{' '}
        {composed.marketplace.code}.
      </div>
    )
  }
  return (
    <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
      <div className="text-[13px] font-semibold text-slate-900 dark:text-slate-100 mb-1.5">
        Product description
      </div>
      <div className="text-[12px] text-slate-700 dark:text-slate-300 line-clamp-4 whitespace-pre-wrap leading-snug">
        {desc}
      </div>
    </div>
  )
}

function ComplianceFooter() {
  // Placeholder — AC.4 wires the real GPSR / hazmat / battery / CoO
  // checks here once the compliance manifest is plumbed through.
  return (
    <div className="pt-2 border-t border-slate-100 dark:border-slate-800 text-[10.5px] text-slate-500 dark:text-slate-400">
      <span className="font-medium">Safety & Compliance:</span>{' '}
      <span className="italic">GPSR / hazmat / battery checks land in AC.4.</span>
    </div>
  )
}

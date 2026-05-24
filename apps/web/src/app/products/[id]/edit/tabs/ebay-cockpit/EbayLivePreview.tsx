'use client'

// EC.1.3 — Live eBay preview.
//
// Renders an approximation of how the listing will look on eBay, in
// either the mobile app skin or the desktop web skin. Updates from the
// ComposedListing prop on every render — no internal data state.
//
// Visual fidelity is approximate (not pixel-perfect to eBay's real
// rendering); EC.14 would swap to eBay's actual preview API if/when
// gated access is granted. Today this surface is enough for operators
// to catch obvious problems pre-publish.

import { useState } from 'react'
import { Heart, ShoppingCart, Truck, Shield, ChevronLeft, ChevronRight, Smartphone, Monitor } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import type { ComposedListing } from './types'

interface Props {
  composed: ComposedListing
  className?: string
}

type Skin = 'mobile' | 'desktop'

const MARKET_FLAG: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', UK: '🇬🇧', US: '🇺🇸',
}

function formatPrice(value: number | null, currency: string): string {
  if (value == null) return '—'
  const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'USD' ? '$' : `${currency} `
  return `${symbol}${value.toFixed(2)}`
}

export default function EbayLivePreview({ composed, className }: Props) {
  const [skin, setSkin] = useState<Skin>('mobile')
  const [galleryIdx, setGalleryIdx] = useState(0)

  const gallery = composed.galleryUrls.value.length > 0
    ? composed.galleryUrls.value
    : composed.primaryImageUrl.value
    ? [composed.primaryImageUrl.value]
    : []
  const currentImg = gallery[galleryIdx] ?? composed.primaryImageUrl.value

  const flag = MARKET_FLAG[composed.marketplace.code] ?? '🌐'
  const priceStr = formatPrice(composed.price.value, composed.currency)

  return (
    <div className={cn('rounded-xl border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900', className)}>
      {/* Header strip ─ skin toggle, market chip, eBay nub */}
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs font-semibold tracking-tight text-slate-700 dark:text-slate-300">
            <span className="text-rose-600">e</span>
            <span className="text-blue-600">b</span>
            <span className="text-amber-500">a</span>
            <span className="text-emerald-600">y</span>
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {flag} {composed.marketplace.code} preview
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setSkin('mobile')}
            className={cn(
              'inline-flex items-center gap-1 h-6 px-2 text-[11px] rounded border transition-colors',
              skin === 'mobile'
                ? 'border-slate-400 dark:border-slate-500 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800',
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
                ? 'border-slate-400 dark:border-slate-500 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100'
                : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800',
            )}
            title="Desktop preview"
          >
            <Monitor className="w-3 h-3" /> Desktop
          </button>
        </div>
      </div>

      {/* Body — switches between skins */}
      {skin === 'mobile' ? (
        <MobileSkin
          composed={composed}
          currentImg={currentImg}
          gallery={gallery}
          galleryIdx={galleryIdx}
          setGalleryIdx={setGalleryIdx}
          priceStr={priceStr}
        />
      ) : (
        <DesktopSkin
          composed={composed}
          currentImg={currentImg}
          gallery={gallery}
          galleryIdx={galleryIdx}
          setGalleryIdx={setGalleryIdx}
          priceStr={priceStr}
        />
      )}

      {/* Footer health hints */}
      <div className="px-3 py-2 border-t border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
        <div className="flex items-center gap-3 flex-wrap">
          <span>Title {composed.healthHints.titleLength}/80</span>
          <span>Desc {composed.healthHints.descriptionLength} chars</span>
          <span>Images {composed.galleryUrls.value.length}</span>
          {composed.variationSummary.variantCount > 0 && (
            <span>Variants {composed.variationSummary.variantCount}</span>
          )}
        </div>
        {composed.healthHints.masterIsNewer && (
          <Badge variant="warning">Master is newer</Badge>
        )}
      </div>
    </div>
  )
}

// ── Mobile skin ────────────────────────────────────────────────────────
function MobileSkin(props: SkinProps) {
  const { composed, currentImg, gallery, galleryIdx, setGalleryIdx, priceStr } = props
  return (
    <div className="mx-auto" style={{ maxWidth: 380 }}>
      {/* Image */}
      <div className="relative aspect-square bg-slate-100 dark:bg-slate-800">
        {currentImg ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={currentImg} alt={composed.title.value} className="w-full h-full object-contain" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-300 text-xs">
            No image
          </div>
        )}
        {gallery.length > 1 && <GalleryNav idx={galleryIdx} setIdx={setGalleryIdx} total={gallery.length} />}
        <button
          type="button"
          className="absolute top-2 right-2 w-8 h-8 rounded-full bg-white/90 border border-slate-200 flex items-center justify-center text-slate-500 hover:text-rose-500"
          title="Add to watchlist"
        >
          <Heart className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-2">
        <div className="text-[15px] leading-snug font-medium text-slate-900 dark:text-slate-100 line-clamp-3">
          {composed.title.value || <em className="text-slate-400">No title set</em>}
        </div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{priceStr}</span>
          <span className="text-xs text-slate-500">+ shipping</span>
        </div>
        <ConditionRow composed={composed} />
        <div className="grid grid-cols-2 gap-2 pt-2">
          <button className="h-10 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">
            Buy It Now
          </button>
          <button className="h-10 rounded-full border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 text-sm font-medium">
            Add to cart
          </button>
        </div>
        <ShippingRow />
        <DescriptionRow composed={composed} />
      </div>
    </div>
  )
}

// ── Desktop skin ───────────────────────────────────────────────────────
function DesktopSkin(props: SkinProps) {
  const { composed, currentImg, gallery, galleryIdx, setGalleryIdx, priceStr } = props
  return (
    <div className="p-4 grid grid-cols-[280px_1fr] gap-5 max-w-[820px] mx-auto">
      {/* Left: image + thumbs */}
      <div>
        <div className="relative aspect-square bg-slate-100 dark:bg-slate-800 rounded">
          {currentImg ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={currentImg} alt={composed.title.value} className="w-full h-full object-contain" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-slate-300 text-xs">
              No image
            </div>
          )}
          {gallery.length > 1 && <GalleryNav idx={galleryIdx} setIdx={setGalleryIdx} total={gallery.length} />}
        </div>
        {gallery.length > 1 && (
          <div className="mt-2 grid grid-cols-5 gap-1.5">
            {gallery.slice(0, 5).map((url, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setGalleryIdx(i)}
                className={cn(
                  'aspect-square rounded border overflow-hidden bg-white dark:bg-slate-800',
                  i === galleryIdx ? 'border-blue-500 ring-1 ring-blue-300' : 'border-slate-200 dark:border-slate-700',
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt="" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Right: title, price, actions */}
      <div className="space-y-2 min-w-0">
        <div className="text-lg leading-snug font-semibold text-slate-900 dark:text-slate-100">
          {composed.title.value || <em className="text-slate-400">No title set</em>}
        </div>
        <ConditionRow composed={composed} />
        <div className="pt-1 pb-2 border-t border-b border-slate-200 dark:border-slate-800">
          <div className="text-[28px] font-semibold leading-tight text-slate-900 dark:text-slate-100">
            {priceStr}
          </div>
          <div className="text-xs text-slate-500">
            or Best Offer · Free returns
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 pt-1 max-w-md">
          <button className="h-10 rounded-full bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">
            Buy It Now
          </button>
          <button className="h-10 rounded-full border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 text-sm font-medium inline-flex items-center justify-center gap-1.5">
            <ShoppingCart className="w-3.5 h-3.5" /> Add to cart
          </button>
        </div>
        <ShippingRow />
        <DescriptionRow composed={composed} />
      </div>
    </div>
  )
}

// ── Shared inner blocks ────────────────────────────────────────────────
interface SkinProps {
  composed: ComposedListing
  currentImg: string | null
  gallery: string[]
  galleryIdx: number
  setGalleryIdx: (n: number) => void
  priceStr: string
}

function GalleryNav({ idx, setIdx, total }: { idx: number; setIdx: (n: number) => void; total: number }) {
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

function ConditionRow({ composed }: { composed: ComposedListing }) {
  return (
    <div className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-2 flex-wrap">
      <span className="font-medium text-slate-700 dark:text-slate-300">Condition:</span>
      <span>{composed.conditionLabel.value}</span>
      {composed.brand.value && (
        <>
          <span className="text-slate-300">·</span>
          <span>Brand: {composed.brand.value}</span>
        </>
      )}
      <span className="text-slate-300">·</span>
      <span className="font-mono text-[10.5px]">{composed.sku}</span>
    </div>
  )
}

function ShippingRow() {
  return (
    <div className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-2 flex-wrap pt-1">
      <Truck className="w-3.5 h-3.5 text-slate-400" />
      <span>Standard shipping</span>
      <span className="text-slate-300">·</span>
      <Shield className="w-3.5 h-3.5 text-slate-400" />
      <span>30-day returns</span>
    </div>
  )
}

function DescriptionRow({ composed }: { composed: ComposedListing }) {
  const desc = composed.description.value
  if (!desc) {
    return (
      <div className="text-xs text-slate-400 italic pt-2 border-t border-slate-100 dark:border-slate-800">
        No description set — operators will see a sparse listing on eBay.
      </div>
    )
  }
  return (
    <div className="text-xs text-slate-700 dark:text-slate-300 pt-2 border-t border-slate-100 dark:border-slate-800 line-clamp-4 whitespace-pre-wrap">
      {desc}
    </div>
  )
}

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
import { Heart, ShoppingCart, Truck, Shield, ChevronLeft, ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import { PreviewSkinToggle, type Skin } from '../../_shared/cockpit-preview'
import type { ComposedListing } from './types'

interface Props {
  composed: ComposedListing
  className?: string
  childrenList?: Array<{ id: string; variations?: Record<string, string> | null; totalStock?: number | null }>
  platformAttributes?: Record<string, unknown>
}

const MARKET_FLAG: Record<string, string> = {
  IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', UK: '🇬🇧', US: '🇺🇸',
}

const COLOR_AXIS_NAMES = ['color', 'colour', 'colore', 'farbe', 'couleur', 'color']

function isColorAxis(name: string): boolean {
  return COLOR_AXIS_NAMES.includes(name.toLowerCase())
}

function formatPrice(value: number | null, currency: string): string {
  if (value == null) return '—'
  const symbol = currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : currency === 'USD' ? '$' : `${currency} `
  return `${symbol}${value.toFixed(2)}`
}

// ── Variation Selector ─────────────────────────────────────────────────
interface VariationSelectorProps {
  composed: ComposedListing
  childrenList: Array<{ id: string; variations?: Record<string, string> | null; totalStock?: number | null }>
  platformAttributes: Record<string, unknown>
  selectedValues: Record<string, string>
  onSelect: (axis: string, value: string) => void
}

function VariationSelector({ composed, childrenList, platformAttributes, selectedValues, onSelect }: VariationSelectorProps) {
  // Resolve axis names: prefer platformAttributes._variationAxes, fall back to composed
  const rawAxes = platformAttributes._variationAxes
  const axes: string[] = Array.isArray(rawAxes) && rawAxes.length > 0
    ? (rawAxes as string[])
    : (composed.variationSummary?.axes ?? [])

  if (axes.length === 0 || childrenList.length === 0) return null

  // eBay display name overrides (e.g. "Color" → "Colour" on UK)
  const axisNameLabels = (platformAttributes._axisNameLabels as Record<string, string> | undefined) ?? {}

  return (
    <div className="space-y-2">
      {axes.map((axis) => {
        const displayName = axisNameLabels[axis] ?? axis
        // Collect unique values: try both the canonical axis name and the display name
        const valueSet = new Set<string>()
        for (const child of childrenList) {
          const v = child.variations?.[axis] ?? child.variations?.[displayName]
          if (v) valueSet.add(v)
        }
        const values = Array.from(valueSet)
        if (values.length === 0) return null

        const selected = selectedValues[axis] ?? values[0]

        return (
          <div key={axis}>
            <div className="text-[11px] font-medium text-slate-600 dark:text-slate-400 mb-1">
              Select {displayName}:
            </div>
            <div className="flex flex-wrap gap-1.5">
              {values.map((val) => {
                const isSelected = val === selected
                if (isColorAxis(axis)) {
                  return (
                    <button
                      key={val}
                      type="button"
                      title={val}
                      onClick={() => onSelect(axis, val)}
                      className={cn(
                        'w-5 h-5 rounded bg-slate-300 dark:bg-slate-600 border border-default text-[0px] overflow-hidden flex-shrink-0 transition-all',
                        isSelected
                          ? 'ring-2 ring-blue-500 ring-offset-1'
                          : 'hover:ring-1 hover:ring-slate-400',
                      )}
                      aria-label={val}
                      aria-pressed={isSelected}
                    >
                      {val}
                    </button>
                  )
                }
                return (
                  <button
                    key={val}
                    type="button"
                    onClick={() => onSelect(axis, val)}
                    className={cn(
                      'px-2 py-0.5 rounded border text-[11px] font-medium transition-all',
                      isSelected
                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 ring-2 ring-blue-500'
                        : 'border-default dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                    )}
                    aria-pressed={isSelected}
                  >
                    {val}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function EbayLivePreview({ composed, className, childrenList = [], platformAttributes = {} }: Props) {
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

  // Resolve axes for initial selected values
  const rawAxes = platformAttributes._variationAxes
  const axes: string[] = Array.isArray(rawAxes) && rawAxes.length > 0
    ? (rawAxes as string[])
    : (composed.variationSummary?.axes ?? [])

  const [selectedValues, setSelectedValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    const axisNameLabels = (platformAttributes._axisNameLabels as Record<string, string> | undefined) ?? {}
    for (const axis of axes) {
      const displayName = axisNameLabels[axis] ?? axis
      for (const child of childrenList) {
        const v = child.variations?.[axis] ?? child.variations?.[displayName]
        if (v) { init[axis] = v; break }
      }
    }
    return init
  })

  function handleSelect(axis: string, value: string) {
    setSelectedValues((prev) => ({ ...prev, [axis]: value }))
  }

  return (
    <div className={cn('rounded-xl border border-default dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-900', className)}>
      {/* Header strip ─ skin toggle, market chip, eBay nub */}
      <div className="px-3 py-2 border-b border-default dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 flex items-center justify-between gap-2">
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
        <PreviewSkinToggle
          skin={skin}
          onChange={setSkin}
          activeClass="border-slate-400 dark:border-slate-500 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
          inactiveClass="border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800"
        />
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
          childrenList={childrenList}
          platformAttributes={platformAttributes}
          selectedValues={selectedValues}
          onSelect={handleSelect}
        />
      ) : (
        <DesktopSkin
          composed={composed}
          currentImg={currentImg}
          gallery={gallery}
          galleryIdx={galleryIdx}
          setGalleryIdx={setGalleryIdx}
          priceStr={priceStr}
          childrenList={childrenList}
          platformAttributes={platformAttributes}
          selectedValues={selectedValues}
          onSelect={handleSelect}
        />
      )}

      {/* Footer health hints */}
      <div className="px-3 py-2 border-t border-default dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/40 flex items-center justify-between gap-2 text-[11px] text-slate-500 dark:text-slate-400">
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
  const { composed, currentImg, gallery, galleryIdx, setGalleryIdx, priceStr, childrenList, platformAttributes, selectedValues, onSelect } = props
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
          className="absolute top-2 right-2 w-8 h-8 rounded-full bg-white/90 border border-default flex items-center justify-center text-slate-500 hover:text-rose-500"
          title="Add to watchlist"
        >
          <Heart className="w-4 h-4" />
        </button>
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-2">
        <div className="text-[15px] leading-snug font-medium text-slate-900 dark:text-slate-100 line-clamp-3">
          {composed.title.value || <em className="text-tertiary">No title set</em>}
        </div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-2xl font-semibold text-slate-900 dark:text-slate-100">{priceStr}</span>
          <span className="text-xs text-slate-500">+ shipping</span>
        </div>
        <ConditionRow composed={composed} />
        {childrenList.length > 0 && (
          <VariationSelector
            composed={composed}
            childrenList={childrenList}
            platformAttributes={platformAttributes}
            selectedValues={selectedValues}
            onSelect={onSelect}
          />
        )}
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
  const { composed, currentImg, gallery, galleryIdx, setGalleryIdx, priceStr, childrenList, platformAttributes, selectedValues, onSelect } = props
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
                  i === galleryIdx ? 'border-blue-500 ring-1 ring-blue-300' : 'border-default dark:border-slate-700',
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
          {composed.title.value || <em className="text-tertiary">No title set</em>}
        </div>
        <ConditionRow composed={composed} />
        <div className="pt-1 pb-2 border-t border-b border-default dark:border-slate-800">
          <div className="text-[28px] font-semibold leading-tight text-slate-900 dark:text-slate-100">
            {priceStr}
          </div>
          <div className="text-xs text-slate-500">
            or Best Offer · Free returns
          </div>
        </div>
        {childrenList.length > 0 && (
          <VariationSelector
            composed={composed}
            childrenList={childrenList}
            platformAttributes={platformAttributes}
            selectedValues={selectedValues}
            onSelect={onSelect}
          />
        )}
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
  childrenList: Array<{ id: string; variations?: Record<string, string> | null; totalStock?: number | null }>
  platformAttributes: Record<string, unknown>
  selectedValues: Record<string, string>
  onSelect: (axis: string, value: string) => void
}

function GalleryNav({ idx, setIdx, total }: { idx: number; setIdx: (n: number) => void; total: number }) {
  return (
    <>
      <button
        type="button"
        onClick={() => setIdx((idx - 1 + total) % total)}
        className="absolute top-1/2 -translate-y-1/2 left-1 w-7 h-7 rounded-full bg-white/90 border border-default flex items-center justify-center text-slate-600"
        aria-label="Previous image"
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <button
        type="button"
        onClick={() => setIdx((idx + 1) % total)}
        className="absolute top-1/2 -translate-y-1/2 right-1 w-7 h-7 rounded-full bg-white/90 border border-default flex items-center justify-center text-slate-600"
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
      <Truck className="w-3.5 h-3.5 text-tertiary" />
      <span>Standard shipping</span>
      <span className="text-slate-300">·</span>
      <Shield className="w-3.5 h-3.5 text-tertiary" />
      <span>30-day returns</span>
    </div>
  )
}

function DescriptionRow({ composed }: { composed: ComposedListing }) {
  const desc = composed.description.value
  if (!desc) {
    return (
      <div className="text-xs text-tertiary italic pt-2 border-t border-subtle dark:border-slate-800">
        No description set — operators will see a sparse listing on eBay.
      </div>
    )
  }
  return (
    <div className="text-xs text-slate-700 dark:text-slate-300 pt-2 border-t border-subtle dark:border-slate-800 line-clamp-4 whitespace-pre-wrap">
      {desc}
    </div>
  )
}

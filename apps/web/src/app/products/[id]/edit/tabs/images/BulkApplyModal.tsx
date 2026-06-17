'use client'

// IE.12 — Smart bulk apply for master images.
//
// Right-click a master image → "Apply to…" opens this modal. Operator
// picks variant axis values (multi-select), an Amazon slot, and a
// marketplace target. A live preview counts how many cells will
// populate vs how many will overwrite existing rows so the operator
// commits with their eyes open.
//
// On submit we fan into `addPendingUpsert` once per target cell —
// the existing save pipeline batches them into a single bulk-save
// when the operator hits Save.
//
// Scoped to Amazon for IE.12. eBay + Shopify bulk apply lands in
// IE.12b once we settle on the right "target picker" shape for
// gallery / pool layouts.

import { useMemo, useState } from 'react'
import { Layers, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'
import type { ListingImage, PendingUpsert, ProductImage, VariantSummary } from './types'

const AMAZON_SLOTS = ['MAIN', 'PT01', 'PT02', 'PT03', 'PT04', 'PT05', 'PT06', 'PT07', 'PT08', 'SWCH'] as const
type AmazonSlot = typeof AMAZON_SLOTS[number]

const AMAZON_MARKETPLACES = ['ALL', 'IT', 'DE', 'FR', 'ES', 'UK'] as const
type AmazonMarketplace = typeof AMAZON_MARKETPLACES[number]

const TYPE_TO_DEFAULT_SLOT: Record<string, AmazonSlot> = {
  MAIN: 'MAIN',
  SWATCH: 'SWCH',
  LIFESTYLE: 'PT01',
  ALT: 'PT01',
  DIAGRAM: 'PT01',
}

interface Props {
  open: boolean
  image: ProductImage | null
  variants: VariantSummary[]
  listingImages: ListingImage[]
  activeAxis: string
  addPendingUpsert: (u: Omit<PendingUpsert, '_tempId'>) => void
  onClose: () => void
  onToast?: (msg: string) => void
}

interface TargetCell {
  groupValue: string | null
  slot: AmazonSlot
  marketplace: string | null   // null = All Markets (PLATFORM scope)
  existingId?: string          // present = overwrite
}

export default function BulkApplyModal({
  open,
  image,
  variants,
  listingImages,
  activeAxis,
  addPendingUpsert,
  onClose,
  onToast,
}: Props) {
  // Variant axis values for this product, derived once per render.
  const axisValues = useMemo(() => {
    const vs = new Set<string>()
    for (const v of variants) {
      const a = (v.variantAttributes as Record<string, string> | null)?.[activeAxis]
      if (a) vs.add(a)
    }
    return Array.from(vs).sort()
  }, [variants, activeAxis])

  // State — defaults: all axis values selected, slot mapped from
  // image.type, marketplace=ALL.
  const [selectedValues, setSelectedValues] = useState<Set<string>>(() => new Set(axisValues))
  const [selectedSlot, setSelectedSlot] = useState<AmazonSlot>(() => {
    if (!image) return 'PT01'
    return TYPE_TO_DEFAULT_SLOT[image.type] ?? 'PT01'
  })
  const [selectedMarketplace, setSelectedMarketplace] = useState<AmazonMarketplace>('ALL')
  // Reset when modal reopens with a different image.
  useMemo(() => {
    if (!open || !image) return
    setSelectedValues(new Set(axisValues))
    setSelectedSlot(TYPE_TO_DEFAULT_SLOT[image.type] ?? 'PT01')
    setSelectedMarketplace('ALL')
  }, [open, image?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Compute target cells + which would overwrite an existing row.
  const targets = useMemo<TargetCell[]>(() => {
    if (!image) return []
    const out: TargetCell[] = []
    const marketplace = selectedMarketplace === 'ALL' ? null : selectedMarketplace
    const scope: 'PLATFORM' | 'MARKETPLACE' = selectedMarketplace === 'ALL' ? 'PLATFORM' : 'MARKETPLACE'
    for (const v of selectedValues) {
      const existing = listingImages.find((li) =>
        li.platform === 'AMAZON' &&
        li.amazonSlot === selectedSlot &&
        li.scope === scope &&
        li.marketplace === marketplace &&
        li.variantGroupKey === activeAxis &&
        li.variantGroupValue === v,
      )
      out.push({ groupValue: v, slot: selectedSlot, marketplace, existingId: existing?.id })
    }
    return out
  }, [image, selectedValues, selectedSlot, selectedMarketplace, listingImages, activeAxis])

  const overwriteCount = targets.filter((t) => t.existingId).length
  const newCount = targets.length - overwriteCount

  function toggleValue(v: string) {
    const next = new Set(selectedValues)
    if (next.has(v)) next.delete(v)
    else next.add(v)
    setSelectedValues(next)
  }

  function selectAll() { setSelectedValues(new Set(axisValues)) }
  function selectNone() { setSelectedValues(new Set()) }

  function handleSubmit() {
    if (!image) return
    for (const target of targets) {
      addPendingUpsert({
        id: target.existingId,
        scope: target.marketplace ? 'MARKETPLACE' : 'PLATFORM',
        platform: 'AMAZON',
        marketplace: target.marketplace,
        amazonSlot: target.slot,
        variantGroupKey: activeAxis,
        variantGroupValue: target.groupValue,
        url: image.url,
        sourceProductImageId: image.id,
        role: target.slot === 'MAIN' ? 'MAIN' : target.slot === 'SWCH' ? 'SWATCH' : 'GALLERY',
        position: target.slot === 'MAIN' ? 0 : target.slot === 'SWCH' ? 9 : parseInt(target.slot.slice(2), 10),
      })
    }
    onToast?.(
      `${targets.length} cell${targets.length === 1 ? '' : 's'} queued (${newCount} new, ${overwriteCount} overwriting) — save to commit`,
    )
    onClose()
  }

  if (!open || !image) return null
  const canSubmit = targets.length > 0
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden">
        <div className="flex items-start justify-between px-5 py-4 border-b border-default dark:border-slate-700">
          <div className="flex items-start gap-3">
            <Layers className="w-5 h-5 text-blue-500 mt-0.5" />
            <div>
              <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                Apply image to multiple variants
              </h2>
              <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                Pick the variant values, Amazon slot, and marketplace. The image is queued for every matching cell.
              </p>
            </div>
          </div>
          <IconButton size="sm" onClick={onClose} aria-label="Close">
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* Image preview */}
          <div className="flex items-center gap-3">
            <div className="w-20 h-20 rounded-lg bg-slate-100 dark:bg-slate-800 overflow-hidden border border-default dark:border-slate-700 flex-shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.url} alt={image.alt ?? ''} className="w-full h-full object-contain" />
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 space-y-0.5">
              <div className="font-medium text-slate-700 dark:text-slate-200">{image.type}</div>
              {image.width && image.height && <div>{image.width}×{image.height}</div>}
              {image.alt && <div className="truncate max-w-xs" title={image.alt}>{image.alt}</div>}
            </div>
          </div>

          {/* Variant value picker */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
                {activeAxis} values ({selectedValues.size} / {axisValues.length})
              </span>
              <div className="flex gap-2 text-[11px]">
                <button type="button" onClick={selectAll} className="text-blue-600 hover:underline">All</button>
                <button type="button" onClick={selectNone} className="text-slate-500 hover:underline">None</button>
              </div>
            </div>
            <div className="flex items-center gap-1 flex-wrap">
              {axisValues.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => toggleValue(v)}
                  className={cn(
                    'text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                    selectedValues.has(v)
                      ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-400 text-blue-700 dark:text-blue-300'
                      : 'border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                  )}
                >
                  {v}
                </button>
              ))}
              {axisValues.length === 0 && (
                <span className="text-xs text-tertiary italic">No values for axis "{activeAxis}"</span>
              )}
            </div>
          </div>

          {/* Slot picker */}
          <div>
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1.5">
              Amazon slot
            </span>
            <div className="flex items-center gap-1 flex-wrap">
              {AMAZON_SLOTS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSelectedSlot(s)}
                  className={cn(
                    'text-[11px] px-2 py-0.5 rounded-full border transition-colors font-mono',
                    selectedSlot === s
                      ? 'bg-orange-50 dark:bg-orange-950/40 border-orange-400 text-orange-700 dark:text-orange-300'
                      : 'border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Marketplace picker */}
          <div>
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300 block mb-1.5">
              Marketplace
            </span>
            <div className="flex items-center gap-1 flex-wrap">
              {AMAZON_MARKETPLACES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setSelectedMarketplace(m)}
                  className={cn(
                    'text-[11px] px-2 py-0.5 rounded-full border transition-colors',
                    selectedMarketplace === m
                      ? 'bg-purple-50 dark:bg-purple-950/40 border-purple-400 text-purple-700 dark:text-purple-300'
                      : 'border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                  )}
                >
                  {m === 'ALL' ? 'All Markets' : m}
                </button>
              ))}
            </div>
          </div>

          {/* Preview */}
          <div className="px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 text-sm">
            {targets.length === 0 ? (
              <span className="text-slate-500 dark:text-slate-400">No cells selected</span>
            ) : (
              <>
                <span className="font-medium text-blue-700 dark:text-blue-300">
                  {targets.length} cell{targets.length === 1 ? '' : 's'} will be queued
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400 ml-2">
                  ({newCount} new, {overwriteCount} replacing existing)
                </span>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-subtle dark:border-slate-800">
          <Button size="sm" variant="ghost" onClick={onClose} className="text-xs">Cancel</Button>
          <Button size="sm" onClick={handleSubmit} disabled={!canSubmit} className="text-xs gap-1.5">
            <Layers className="w-3 h-3" />
            Queue {targets.length} cell{targets.length === 1 ? '' : 's'}
          </Button>
        </div>
      </div>
    </div>
  )
}

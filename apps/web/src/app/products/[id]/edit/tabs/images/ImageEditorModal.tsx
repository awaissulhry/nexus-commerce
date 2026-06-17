'use client'

// IR.4.3 — In-app image editor.
//
// Crops, rotates, or flips an existing master ProductImage and saves
// the result as a NEW ProductImage row (derivedFromImageId →
// source.id). No re-upload — the new URL is a Cloudinary transformation
// of the source bytes.
//
// Three operation modes (mutually exclusive per save):
//   - Crop with aspect-ratio preset (Free / 1:1 Amazon / 4:3 eBay /
//     4:5 Shopify portrait)
//   - Rotate ±90°
//   - Flip horizontal / vertical
//
// Operator picks one operation per Save. Chaining is a feature of the
// server endpoint, not the editor, so the editor stays focused —
// each save creates one cleanly-named derivative in the version chain.

import { useEffect, useRef, useState } from 'react'
import ReactCrop, { type Crop } from 'react-image-crop'
import 'react-image-crop/dist/ReactCrop.css'
import { Loader2, RotateCcw, RotateCw, FlipHorizontal2, FlipVertical2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { beFetch } from './api'
import { useTranslations } from '@/lib/i18n/use-translations'
import type { ProductImage } from './types'

type AspectMode = 'free' | 'square' | 'ebay' | 'shopify'

const ASPECT: Record<AspectMode, { ratio: number | undefined; key: string; hint: string }> = {
  free:    { ratio: undefined, key: 'products.edit.images.editor.free',         hint: 'No constraint' },
  square:  { ratio: 1,         key: 'products.edit.images.editor.aspectAmazon', hint: 'Amazon main + most channels' },
  ebay:    { ratio: 4 / 3,     key: 'products.edit.images.editor.aspectEbay',   hint: 'eBay gallery default' },
  shopify: { ratio: 4 / 5,     key: 'products.edit.images.editor.aspectShopify', hint: 'Shopify product page portrait' },
}

interface Props {
  productId: string
  image: ProductImage
  onClose: () => void
  /** Called after a successful save with the new derivative ProductImage. */
  onSaved: (derivative: ProductImage) => void
}

export default function ImageEditorModal({ productId, image, onClose, onSaved }: Props) {
  const { t } = useTranslations()
  const [aspect, setAspect] = useState<AspectMode>('square')
  const [crop, setCrop] = useState<Crop>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  // Esc closes the editor.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Reset crop when the aspect mode changes — drop the operator into a
  // centered default rather than letting them carry a stale region.
  useEffect(() => {
    const ratio = ASPECT[aspect].ratio
    if (!ratio) {
      setCrop(undefined)
      return
    }
    // Centered 70% box that respects the chosen ratio.
    setCrop({
      unit: '%',
      x: 15,
      y: 15,
      width: 70,
      height: 70 / ratio,
    })
  }, [aspect])

  async function callDerive(body: Record<string, unknown>) {
    setSaving(true)
    setError(null)
    try {
      const res = await beFetch(`/api/products/${productId}/images/${image.id}/derive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `Derive failed: ${res.status}`)
      }
      const derivative: ProductImage = await res.json()
      onSaved(derivative)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  function saveCrop() {
    if (!crop || !imgRef.current) return
    // Scale displayed-pixel crop coords back to natural-image coords —
    // Cloudinary c_crop works in source-image pixel space.
    const img = imgRef.current
    const scaleX = img.naturalWidth / img.width
    const scaleY = img.naturalHeight / img.height
    const px = crop.unit === '%'
      ? {
        x: (crop.x / 100) * img.naturalWidth,
        y: (crop.y / 100) * img.naturalHeight,
        width: (crop.width / 100) * img.naturalWidth,
        height: (crop.height / 100) * img.naturalHeight,
      }
      : {
        x: crop.x * scaleX,
        y: crop.y * scaleY,
        width: crop.width * scaleX,
        height: crop.height * scaleY,
      }
    void callDerive({ crop: px })
  }

  function quickRotate(deg: number) { void callDerive({ rotate: deg }) }
  function quickFlip(axis: 'H' | 'V') {
    void callDerive(axis === 'H' ? { flipH: true } : { flipV: true })
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image editor"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 backdrop-blur-sm p-4"
    >
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col overflow-hidden max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-default dark:border-slate-700 flex-shrink-0">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {t('products.edit.images.editor.title')}
            <span className="ml-2 text-xs font-mono text-tertiary">{image.type}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close editor"
            className="p-1 text-tertiary hover:text-slate-700 dark:hover:text-slate-200"
            disabled={saving}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Aspect-ratio toolbar */}
        <div className="flex items-center gap-2 px-5 py-2.5 border-b border-subtle dark:border-slate-800 flex-wrap">
          <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mr-1">{t('products.edit.images.editor.crop')}</span>
          {(Object.keys(ASPECT) as AspectMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setAspect(mode)}
              disabled={saving}
              title={ASPECT[mode].hint}
              className={cn(
                'text-xs px-2.5 py-1 rounded border transition-colors',
                aspect === mode
                  ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-400 text-blue-700 dark:text-blue-300'
                  : 'border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
              )}
            >
              {t(ASPECT[mode].key)}
            </button>
          ))}

          <span className="ml-auto" />

          <span className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mr-1">{t('products.edit.images.editor.quick')}</span>
          <button
            type="button"
            onClick={() => quickRotate(-90)}
            disabled={saving}
            title="Rotate counter-clockwise 90°"
            className="text-xs px-2 py-1 rounded border border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1"
          >
            <RotateCcw className="w-3.5 h-3.5" /> 90°
          </button>
          <button
            type="button"
            onClick={() => quickRotate(90)}
            disabled={saving}
            title="Rotate clockwise 90°"
            className="text-xs px-2 py-1 rounded border border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 flex items-center gap-1"
          >
            <RotateCw className="w-3.5 h-3.5" /> 90°
          </button>
          <button
            type="button"
            onClick={() => quickFlip('H')}
            disabled={saving}
            title="Flip horizontally"
            className="text-xs px-2 py-1 rounded border border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <FlipHorizontal2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => quickFlip('V')}
            disabled={saving}
            title="Flip vertically"
            className="text-xs px-2 py-1 rounded border border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800"
          >
            <FlipVertical2 className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Crop canvas */}
        <div className="flex-1 overflow-auto bg-slate-100 dark:bg-slate-950 flex items-center justify-center p-6">
          <ReactCrop
            crop={crop}
            onChange={(_, percentCrop) => setCrop(percentCrop)}
            aspect={ASPECT[aspect].ratio}
            keepSelection
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={image.url}
              alt={image.alt ?? image.type}
              className="max-w-full max-h-[60vh] object-contain"
              crossOrigin="anonymous"
            />
          </ReactCrop>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-default dark:border-slate-700 flex-shrink-0 gap-3">
          <div className="text-xs text-slate-500 dark:text-slate-400 min-w-0 truncate">
            {error ? (
              <span className="text-red-600 dark:text-red-400">{error}</span>
            ) : (
              <span>
                {t('products.edit.images.editor.saveCreatesDerivative')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button size="sm" variant="ghost" onClick={onClose} disabled={saving} className="text-xs h-8">
              {t('products.edit.images.editor.cancel')}
            </Button>
            <Button size="sm" onClick={saveCrop} disabled={saving || !crop} className="text-xs h-8 gap-1.5">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              {t('products.edit.images.editor.saveCrop')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

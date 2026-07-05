'use client'

// IR.3.1–IR.3.5 — Lightbox modal.
//
// Full-screen image preview with a 320-px right-side detail drawer.
// Keyboard: Esc closes, ← / → walk the siblings list the opener
// passed in.
//
// Drawer surfaces:
//   - asset metadata (dim/format/size)
//   - alt text (master) or channel placement (listing) + publish status
//   - "used in N channels" back-references (master)
//   - "derived from master" forward-reference (listing)
//   - inline alt + type edit (IR.3.5 — master only)

import { useEffect, useState } from 'react'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import { ChevronLeft, ChevronRight, Crop as CropIcon, FolderUp, Library, Loader2, Pencil, Sparkles, Wand2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { beFetch } from './api'
import { useTranslations } from '@/lib/i18n/use-translations'
import type { LightboxState } from './useLightbox'
import type { ListingImage, ProductImage } from './types'
import { Listbox } from '@/design-system/components/Listbox'

const MASTER_TYPES = ['MAIN', 'ALT', 'LIFESTYLE', 'SWATCH', 'DIAGRAM'] as const
type MasterType = typeof MASTER_TYPES[number]

interface Props {
  state: LightboxState
  // Workspace payload — read-only — so the drawer can compute
  // "used in" back-references (listing rows whose
  // sourceProductImageId === current master image id).
  masterImages: ProductImage[]
  listingImages: ListingImage[]
  /** IR.7.2 — map productImage.id → DigitalAsset.id from workspace.damLinks. */
  damLinks: Record<string, string>
  // IR.3.5 — required for inline alt/type edit on master images.
  // Identifies which product the PATCH endpoint should target.
  productId: string
  /** Called after a successful alt/type save so the parent can update
   *  its local images list without a full workspace reload. */
  onMasterImageUpdated?: (updated: ProductImage) => void
  /** IR.4.4 — open the in-app image editor for a master ProductImage. */
  onEditMaster?: (img: ProductImage) => void
  /** IR.4.5 — switch the focused image to a different master without
   *  closing the lightbox. Used by the derivation chain section. */
  onSwitchToMaster?: (img: ProductImage) => void
  /** IR.7.3 — after push-to-DAM completes; parent typically reloads
   *  workspace so damLinks refreshes. */
  onPushToDam?: () => void
  onClose: () => void
  onNavigate: (dir: 'prev' | 'next') => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function platformLabel(platform: string | null | undefined, marketplace: string | null | undefined): string {
  if (!platform) return 'Master'
  const base = platform.charAt(0) + platform.slice(1).toLowerCase()
  return marketplace ? `${base} ${marketplace}` : base
}

export default function LightboxModal({
  state,
  masterImages,
  listingImages,
  productId,
  damLinks,
  onMasterImageUpdated,
  onEditMaster,
  onSwitchToMaster,
  onPushToDam,
  onClose,
  onNavigate,
}: Props) {
  const { t } = useTranslations()
  const { image, siblings } = state

  // IR.3.5 — inline edit state for alt + type on master images.
  // Reset whenever the focused image changes.
  const [editing, setEditing] = useState(false)
  const [editAlt, setEditAlt] = useState('')
  const [editType, setEditType] = useState<MasterType>('ALT')
  const [savingEdit, setSavingEdit] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  // IR.6.3 — Gemini Vision analysis state.
  const [analyzing, setAnalyzing] = useState(false)
  const [analyzeError, setAnalyzeError] = useState<string | null>(null)

  // IR.6.4 — Auto-enhance state.
  const [enhancing, setEnhancing] = useState<null | 'AMAZON_MAIN' | 'EBAY_MAIN' | 'SHOPIFY_PORTRAIT'>(null)
  const [enhanceError, setEnhanceError] = useState<string | null>(null)

  // IR.7.3 — DAM push state.
  const [pushingDam, setPushingDam] = useState(false)
  const [damError, setDamError] = useState<string | null>(null)

  useEffect(() => {
    setEditing(false)
    setEditError(null)
    setEditAlt(image.alt ?? '')
    setEditType((image.type as MasterType) ?? 'ALT')
  }, [image.id, image.alt, image.type])

  async function saveEdit() {
    if (image.kind !== 'master') return
    setSavingEdit(true)
    setEditError(null)
    try {
      const res = await beFetch(`/api/products/${productId}/images/${image.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alt: editAlt || null, type: editType }),
      })
      if (!res.ok) throw new Error(`Save failed: ${res.status}`)
      const updated: ProductImage = await res.json()
      onMasterImageUpdated?.(updated)
      setEditing(false)
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSavingEdit(false)
    }
  }

  async function analyze() {
    if (image.kind !== 'master') return
    setAnalyzing(true)
    setAnalyzeError(null)
    try {
      const res = await beFetch(`/api/products/${productId}/images/${image.id}/analyze`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message ?? body?.error ?? `Analyze failed: ${res.status}`)
      }
      const { image: updated } = await res.json() as { image: ProductImage }
      onMasterImageUpdated?.(updated)
    } catch (err) {
      setAnalyzeError(err instanceof Error ? err.message : 'Analyze failed')
    } finally {
      setAnalyzing(false)
    }
  }

  async function pushToDam() {
    if (image.kind !== 'master') return
    setPushingDam(true)
    setDamError(null)
    try {
      const res = await beFetch(`/api/products/${productId}/images/${image.id}/push-to-dam`, {
        method: 'POST',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message ?? body?.error ?? `Push to DAM failed: ${res.status}`)
      }
      onPushToDam?.()
    } catch (err) {
      setDamError(err instanceof Error ? err.message : 'Push to DAM failed')
    } finally {
      setPushingDam(false)
    }
  }

  async function autoEnhance(preset: 'AMAZON_MAIN' | 'EBAY_MAIN' | 'SHOPIFY_PORTRAIT') {
    if (image.kind !== 'master') return
    setEnhancing(preset)
    setEnhanceError(null)
    try {
      const res = await beFetch(`/api/products/${productId}/images/${image.id}/auto-enhance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message ?? body?.error ?? `Auto-enhance failed: ${res.status}`)
      }
      const { image: updated } = await res.json() as { image: ProductImage }
      onMasterImageUpdated?.(updated)
    } catch (err) {
      setEnhanceError(err instanceof Error ? err.message : 'Auto-enhance failed')
    } finally {
      setEnhancing(null)
    }
  }

  // Esc + ← / → keyboard handling. Esc cancels edit mode if open; only
  // closes the modal when not editing so the operator doesn't lose
  // pending alt text by mistake.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (editing) setEditing(false)
        else onClose()
        return
      }
      // Don't navigate siblings mid-edit.
      if (editing) return
      if (e.key === 'ArrowLeft')  { e.preventDefault(); onNavigate('prev'); return }
      if (e.key === 'ArrowRight') { e.preventDefault(); onNavigate('next'); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNavigate, editing])

  // Listing rows that came from the current master image (or vice versa).
  const usedIn = image.kind === 'master'
    ? listingImages.filter((l) => l.sourceProductImageId === image.id)
    : []
  const masterSource = image.kind === 'listing' && image.sourceProductImageId
    ? masterImages.find((m) => m.id === image.sourceProductImageId)
    : null

  // IR.4.5 — derivation chain (master only). Parent + children of the
  // currently-focused master image, lifted out of the workspace payload.
  const derivationParent = image.kind === 'master' && image.derivedFromImageId
    ? masterImages.find((m) => m.id === image.derivedFromImageId)
    : null
  const derivationChildren = image.kind === 'master'
    ? masterImages.filter((m) => m.derivedFromImageId === image.id)
    : []

  const hasSiblings = siblings.length > 1
  const idx = siblings.findIndex((s) => s.id === image.id)

  const metaLines: string[] = []
  if (image.width && image.height) metaLines.push(`${image.width}×${image.height}`)
  if (image.mimeType) metaLines.push(image.mimeType.replace(/^image\//, '').toUpperCase())
  if (image.fileSize) metaLines.push(formatBytes(image.fileSize))

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      className="fixed inset-0 z-50 flex"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label={t('products.edit.images.lightbox.close')}
        onClick={onClose}
        className="absolute inset-0 bg-black/85 backdrop-blur-sm"
      />

      {/* Image pane */}
      <div className="relative flex-1 flex items-center justify-center p-8">
        {/* Prev */}
        {hasSiblings && (
          <button
            type="button"
            onClick={() => onNavigate('prev')}
            aria-label={t('products.edit.images.lightbox.prev')}
            className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        )}

        {/* Image */}
        <div className="relative max-w-full max-h-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={image.url}
            alt={image.alt ?? ''}
            className="max-w-[calc(100vw-320px-4rem)] max-h-[calc(100vh-4rem)] object-contain"
            decoding="async"
            fetchPriority="high"
          />
        </div>

        {/* Next */}
        {hasSiblings && (
          <button
            type="button"
            onClick={() => onNavigate('next')}
            aria-label={t('products.edit.images.lightbox.next')}
            className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        )}

        {/* Sibling counter */}
        {hasSiblings && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-white/60 font-mono">
            {idx + 1} / {siblings.length}
          </div>
        )}
      </div>

      {/* Detail drawer */}
      <aside className="relative w-80 bg-white dark:bg-slate-900 border-l border-default dark:border-slate-700 overflow-y-auto flex flex-col">
        {/* Drawer header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-default dark:border-slate-700">
          <div className="flex items-center gap-2 min-w-0">
            <span className={cn(
              'text-[10px] font-mono uppercase tracking-wide px-1.5 py-0.5 rounded',
              image.kind === 'master'
                ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
            )}>
              {image.kind === 'master' ? 'Master' : platformLabel(image.platform, image.marketplace)}
            </span>
            {image.type && (
              <span className="text-[10px] font-mono uppercase text-slate-500 dark:text-slate-400 truncate">
                {image.type}
              </span>
            )}
            {image.amazonSlot && (
              <span className="text-[10px] font-mono uppercase text-slate-500 dark:text-slate-400 truncate">
                {image.amazonSlot}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('products.edit.images.lightbox.close')}
            className="p-1 text-tertiary hover:text-slate-700 dark:hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Metadata */}
        <div className="px-5 py-4 space-y-3 text-sm">
          {metaLines.length > 0 && (
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">{t('products.edit.images.lightbox.assetSection')}</h4>
              <p className="font-mono text-xs text-slate-700 dark:text-slate-200">{metaLines.join(' · ')}</p>
            </div>
          )}

          {image.kind === 'master' && !editing && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{t('products.edit.images.lightbox.masterAttributes')}</h4>
                <div className="flex items-center gap-2">
                  {onEditMaster && (
                    <button
                      type="button"
                      onClick={() => {
                        const full = masterImages.find((m) => m.id === image.id)
                        if (full) onEditMaster(full)
                      }}
                      className="flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
                      title="Crop, rotate, or flip — saves as a new derivative"
                    >
                      <CropIcon className="w-3 h-3" /> {t('products.edit.images.lightbox.cropAndRotate')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setEditing(true)}
                    className="flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
                  >
                    <Pencil className="w-3 h-3" /> {t('products.edit.images.lightbox.edit')}
                  </button>
                </div>
              </div>
              <dl className="text-xs grid grid-cols-[60px_1fr] gap-y-0.5 text-slate-700 dark:text-slate-200">
                <dt className="text-slate-500 dark:text-slate-400">{t('products.edit.images.lightbox.type')}</dt>
                <dd>{image.type ?? '—'}</dd>
                <dt className="text-slate-500 dark:text-slate-400">{t('products.edit.images.lightbox.alt')}</dt>
                <dd className="break-words">{image.alt || <span className="text-tertiary italic">{t('products.edit.images.lightbox.notSet')}</span>}</dd>
              </dl>
            </div>
          )}

          {image.kind === 'master' && editing && (
            <div className="space-y-2">
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Master attributes</h4>
              <label className="block">
                <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase">Type</span>
                <Listbox
                  value={editType}
                  onChange={(v) => setEditType(v as MasterType)}
                  ariaLabel="Type"
                  className="mt-1 w-full"
                  disabled={savingEdit}
                  options={MASTER_TYPES.map((mt) => ({ value: mt, label: mt }))}
                />
              </label>
              <label className="block">
                <span className="text-[10px] text-slate-500 dark:text-slate-400 uppercase">Alt text</span>
                <textarea
                  value={editAlt}
                  onChange={(e) => setEditAlt(e.target.value)}
                  disabled={savingEdit}
                  rows={3}
                  placeholder="Describe the image for screen readers + SEO…"
                  className="mt-1 w-full text-xs border border-default dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 focus:outline-none focus:ring-1 focus:ring-blue-400 resize-none"
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveEdit() }}
                />
              </label>
              {editError && (
                <p className="text-[11px] text-red-600 dark:text-red-400">{editError}</p>
              )}
              <div className="flex gap-2">
                <Button size="sm" onClick={saveEdit} disabled={savingEdit} className="text-xs h-7 gap-1">
                  {savingEdit ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={savingEdit} className="text-xs h-7">
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* IR.6.3 — AI vision analysis (master only). Shows results
              when they exist, with a button to re-run. */}
          {image.kind === 'master' && (() => {
            const currentMaster = masterImages.find((m) => m.id === image.id)
            const analyzed = currentMaster?.aiAnalyzedAt != null
            const failed = analyzed && currentMaster?.aiNotes && 'error' in currentMaster.aiNotes
            const ai = currentMaster
            return (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{t('products.edit.images.lightbox.aiCheck')}</h4>
                  <button
                    type="button"
                    onClick={analyze}
                    disabled={analyzing}
                    className="flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
                  >
                    {analyzing
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <Sparkles className="w-3 h-3" />}
                    {analyzed ? t('products.edit.images.lightbox.reanalyze') : t('products.edit.images.lightbox.analyze')}
                  </button>
                </div>

                {analyzeError && (
                  <p className="text-[11px] text-red-600 dark:text-red-400">{analyzeError}</p>
                )}

                {!analyzed && !analyzing && !analyzeError && (
                  <p className="text-[11px] text-tertiary dark:text-slate-500 italic">
                    {t('products.edit.images.lightbox.aiPrompt')}
                  </p>
                )}

                {failed && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400">
                    {t('products.edit.images.lightbox.aiLastFailed')} {String(currentMaster?.aiNotes?.error ?? 'unknown error')}
                  </p>
                )}

                {analyzed && !failed && ai && (
                  <dl className="text-xs grid grid-cols-[100px_1fr] gap-y-0.5 text-slate-700 dark:text-slate-200">
                    <dt className="text-slate-500 dark:text-slate-400">{t('products.edit.images.lightbox.aiWhiteBg')}</dt>
                    <dd className={cn(ai.aiHasWhiteBackground ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400')}>
                      {ai.aiHasWhiteBackground ? t('products.edit.images.lightbox.aiYes') : t('products.edit.images.lightbox.aiNo')}
                    </dd>
                    <dt className="text-slate-500 dark:text-slate-400">{t('products.edit.images.lightbox.aiFrameFill')}</dt>
                    <dd className={cn(
                      (ai.aiFrameFillPct ?? 0) >= 85
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : (ai.aiFrameFillPct ?? 0) >= 60
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-red-600 dark:text-red-400',
                    )}>
                      {ai.aiFrameFillPct ?? '—'}% {(ai.aiFrameFillPct ?? 0) < 85 && t('products.edit.images.lightbox.aiAmazonHint')}
                    </dd>
                    <dt className="text-slate-500 dark:text-slate-400">{t('products.edit.images.lightbox.aiTextOverlay')}</dt>
                    <dd className={cn(ai.aiHasTextOverlay ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400')}>
                      {ai.aiHasTextOverlay ? t('products.edit.images.lightbox.aiTextDetected') : t('products.edit.images.lightbox.aiTextNone')}
                    </dd>
                    <dt className="text-slate-500 dark:text-slate-400">{t('products.edit.images.lightbox.aiCentered')}</dt>
                    <dd className={cn(
                      (ai.aiOffCenterScore ?? 0) <= 0.15
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : (ai.aiOffCenterScore ?? 0) <= 0.3
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-red-600 dark:text-red-400',
                    )}>
                      {ai.aiOffCenterScore != null
                        ? `${Math.round((1 - ai.aiOffCenterScore) * 100)}%`
                        : '—'}
                    </dd>
                    {/* IR.10.4 — Italian-text overlay warning when re-using on non-IT marketplaces */}
                    {ai.aiHasTextOverlay && (
                      <dd className="col-span-2 mt-1 text-[11px] text-amber-700 dark:text-amber-300 italic">
                        ⚠ {t('products.edit.images.lightbox.aiLocaleWarning')}
                      </dd>
                    )}
                    {ai.aiNotes?.rationale && (
                      <>
                        <dt className="text-slate-500 dark:text-slate-400 col-span-2 mt-1">{t('products.edit.images.lightbox.aiRationale')}</dt>
                        <dd className="text-[11px] text-slate-500 dark:text-slate-400 italic col-span-2">{ai.aiNotes.rationale}</dd>
                      </>
                    )}
                  </dl>
                )}
              </div>
            )
          })()}

          {/* IR.6.4 — Auto-enhance presets (master only). One click → derivative
              with background removal + white pad sized for the target channel. */}
          {image.kind === 'master' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{t('products.edit.images.lightbox.autoEnhance')}</h4>
                <span className="text-[10px] text-tertiary">{t('products.edit.images.lightbox.autoEnhanceHint')}</span>
              </div>
              {enhanceError && (
                <p className="text-[11px] text-red-600 dark:text-red-400">{enhanceError}</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => autoEnhance('AMAZON_MAIN')}
                  disabled={enhancing !== null}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-orange-200 dark:border-orange-800 text-orange-700 dark:text-orange-300 hover:bg-orange-50 dark:hover:bg-orange-950/30 disabled:opacity-50"
                >
                  {enhancing === 'AMAZON_MAIN'
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Wand2 className="w-3 h-3" />}
                  {t('products.edit.images.lightbox.autoEnhanceAmazon')}
                </button>
                <button
                  type="button"
                  onClick={() => autoEnhance('EBAY_MAIN')}
                  disabled={enhancing !== null}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950/30 disabled:opacity-50"
                >
                  {enhancing === 'EBAY_MAIN'
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Wand2 className="w-3 h-3" />}
                  {t('products.edit.images.lightbox.autoEnhanceEbay')}
                </button>
                <button
                  type="button"
                  onClick={() => autoEnhance('SHOPIFY_PORTRAIT')}
                  disabled={enhancing !== null}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 disabled:opacity-50"
                >
                  {enhancing === 'SHOPIFY_PORTRAIT'
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Wand2 className="w-3 h-3" />}
                  {t('products.edit.images.lightbox.autoEnhanceShopify')}
                </button>
              </div>
              <p className="text-[10px] text-tertiary dark:text-slate-500">
                {t('products.edit.images.lightbox.autoEnhanceDesc')}
              </p>
            </div>
          )}

          {/* IR.7.3 — DAM library linkage (master only). */}
          {image.kind === 'master' && (() => {
            const linkedAssetId = damLinks[image.id]
            return (
              <div className="space-y-2">
                <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{t('products.edit.images.lightbox.damSection')}</h4>
                {damError && (
                  <p className="text-[11px] text-red-600 dark:text-red-400">{damError}</p>
                )}
                {linkedAssetId ? (
                  <div className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                      <Library className="w-3 h-3" />
                      {t('products.edit.images.lightbox.damLinked')}
                    </span>
                    <a
                      href={`/marketing/content?asset=${encodeURIComponent(linkedAssetId)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {t('products.edit.images.lightbox.damOpenInLibrary')}
                    </a>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={pushToDam}
                    disabled={pushingDam}
                    className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-default dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
                  >
                    {pushingDam
                      ? <Loader2 className="w-3 h-3 animate-spin" />
                      : <FolderUp className="w-3 h-3" />}
                    {t('products.edit.images.lightbox.damPush')}
                  </button>
                )}
                <p className="text-[10px] text-tertiary dark:text-slate-500">
                  {t('products.edit.images.lightbox.damHint')}
                </p>
              </div>
            )
          })()}

          {image.kind === 'listing' && (
            <div className="space-y-1.5">
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Channel placement</h4>
              <dl className="text-xs grid grid-cols-[80px_1fr] gap-y-0.5 text-slate-700 dark:text-slate-200">
                {image.variantGroupKey && (
                  <>
                    <dt className="text-slate-500 dark:text-slate-400">{image.variantGroupKey}</dt>
                    <dd>{image.variantGroupValue}</dd>
                  </>
                )}
                {image.publishStatus && (
                  <>
                    <dt className="text-slate-500 dark:text-slate-400">Status</dt>
                    <dd className={cn(
                      image.publishStatus === 'PUBLISHED' && 'text-emerald-600 dark:text-emerald-400',
                      image.publishStatus === 'ERROR' && 'text-red-600 dark:text-red-400',
                      image.publishStatus === 'OUTDATED' && 'text-amber-600 dark:text-amber-400',
                    )}>
                      {image.publishStatus}
                    </dd>
                  </>
                )}
                {image.publishError && (
                  <>
                    <dt className="text-slate-500 dark:text-slate-400">Error</dt>
                    <dd className="text-red-600 dark:text-red-400 text-[11px]">{image.publishError}</dd>
                  </>
                )}
              </dl>
            </div>
          )}

          {/* IR.4.5 — Version chain (master only). Shows parent in the
              derivation tree + any children created by the editor. */}
          {image.kind === 'master' && (derivationParent || derivationChildren.length > 0) && (
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1.5">Version chain</h4>
              {derivationParent && (
                <div className="text-xs text-slate-700 dark:text-slate-200 mb-1.5">
                  <span className="text-slate-500 dark:text-slate-400">↑ derived from </span>
                  <button
                    type="button"
                    onClick={() => onSwitchToMaster?.(derivationParent)}
                    disabled={!onSwitchToMaster}
                    className="font-mono text-blue-600 dark:text-blue-400 hover:underline disabled:no-underline disabled:text-slate-700 dark:disabled:text-slate-200"
                  >
                    {derivationParent.type}
                  </button>
                  {derivationParent.width && derivationParent.height && (
                    <span className="text-tertiary ml-1">({derivationParent.width}×{derivationParent.height})</span>
                  )}
                </div>
              )}
              {derivationChildren.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {derivationChildren.length} derivative{derivationChildren.length === 1 ? '' : 's'}:
                  </p>
                  <ul className="space-y-1 text-xs">
                    {derivationChildren.map((child) => (
                      <li key={child.id} className="flex items-center gap-2">
                        <span className="text-tertiary">↓</span>
                        <button
                          type="button"
                          onClick={() => onSwitchToMaster?.(child)}
                          disabled={!onSwitchToMaster}
                          className="font-mono text-blue-600 dark:text-blue-400 hover:underline disabled:no-underline disabled:text-slate-700 dark:disabled:text-slate-200"
                        >
                          {child.type}
                        </button>
                        {child.width && child.height && (
                          <span className="text-tertiary text-[11px]">{child.width}×{child.height}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* "Used in" — for master images, list all listing rows that derived from this one */}
          {image.kind === 'master' && usedIn.length > 0 && (
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1.5">
                Used in {usedIn.length} channel listing{usedIn.length === 1 ? '' : 's'}
              </h4>
              <ul className="space-y-1 text-xs text-slate-700 dark:text-slate-200">
                {usedIn.map((l) => (
                  <li key={l.id} className="flex items-center justify-between gap-2 py-0.5">
                    <span className="truncate">
                      {platformLabel(l.platform, l.marketplace)}
                      {l.amazonSlot && <span className="text-tertiary ml-1">· {l.amazonSlot}</span>}
                      {l.variantGroupValue && <span className="text-tertiary ml-1">· {l.variantGroupValue}</span>}
                    </span>
                    {l.publishStatus === 'PUBLISHED' && (
                      <span className="text-[10px] text-emerald-500 flex-shrink-0">live</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* "Source" — for listing images, link back to the master they came from */}
          {image.kind === 'listing' && masterSource && (
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1.5">Derived from</h4>
              <p className="text-xs text-slate-700 dark:text-slate-200">
                Master {masterSource.type}
                {masterSource.alt && <span className="text-slate-500 ml-1">— {masterSource.alt}</span>}
              </p>
            </div>
          )}
        </div>

        {/* Footer keyboard hint */}
        <div className="mt-auto px-5 py-3 border-t border-subtle dark:border-slate-800 text-[10px] text-tertiary dark:text-slate-500 font-mono">
          {hasSiblings
            ? t('products.edit.images.lightbox.escNavHint')
            : t('products.edit.images.lightbox.escHint')}
        </div>
      </aside>
    </div>
  )
}

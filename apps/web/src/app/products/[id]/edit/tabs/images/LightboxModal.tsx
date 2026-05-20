'use client'

// IR.3.1 — Lightbox modal.
//
// Full-screen image preview with a 320-px right-side detail drawer.
// Keyboard: Esc closes, ← / → walk the siblings list the opener
// passed in, F (later) will toggle pure-fullscreen.
//
// The drawer content is intentionally minimal in this commit — just
// the asset metadata and any "used in" cross-channel back-references
// derivable from the workspace payload the parent already holds.
// Inline alt/type edit + delete + per-channel validation land in
// IR.3.4 / IR.3.5.

import { useEffect } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { LightboxState } from './useLightbox'
import type { ListingImage, ProductImage } from './types'

interface Props {
  state: LightboxState
  // Workspace payload — read-only — so the drawer can compute
  // "used in" back-references (listing rows whose
  // sourceProductImageId === current master image id).
  masterImages: ProductImage[]
  listingImages: ListingImage[]
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
  onClose,
  onNavigate,
}: Props) {
  const { image, siblings } = state

  // Esc + ← / → keyboard handling.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); onNavigate('prev'); return }
      if (e.key === 'ArrowRight') { e.preventDefault(); onNavigate('next'); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNavigate])

  // Listing rows that came from the current master image (or vice versa).
  const usedIn = image.kind === 'master'
    ? listingImages.filter((l) => l.sourceProductImageId === image.id)
    : []
  const masterSource = image.kind === 'listing' && image.sourceProductImageId
    ? masterImages.find((m) => m.id === image.sourceProductImageId)
    : null

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
        aria-label="Close lightbox"
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
            aria-label="Previous image"
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
          />
        </div>

        {/* Next */}
        {hasSiblings && (
          <button
            type="button"
            onClick={() => onNavigate('next')}
            aria-label="Next image"
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
      <aside className="relative w-80 bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-700 overflow-y-auto flex flex-col">
        {/* Drawer header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 dark:border-slate-700">
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
            aria-label="Close lightbox"
            className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Metadata */}
        <div className="px-5 py-4 space-y-3 text-sm">
          {metaLines.length > 0 && (
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">Asset</h4>
              <p className="font-mono text-xs text-slate-700 dark:text-slate-200">{metaLines.join(' · ')}</p>
            </div>
          )}

          {image.kind === 'master' && image.alt && (
            <div>
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1">Alt text</h4>
              <p className="text-xs text-slate-700 dark:text-slate-200">{image.alt}</p>
            </div>
          )}

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
                      {l.amazonSlot && <span className="text-slate-400 ml-1">· {l.amazonSlot}</span>}
                      {l.variantGroupValue && <span className="text-slate-400 ml-1">· {l.variantGroupValue}</span>}
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
        <div className="mt-auto px-5 py-3 border-t border-slate-100 dark:border-slate-800 text-[10px] text-slate-400 dark:text-slate-500 font-mono">
          Esc to close{hasSiblings ? ' · ← → to navigate' : ''}
        </div>
      </aside>
    </div>
  )
}

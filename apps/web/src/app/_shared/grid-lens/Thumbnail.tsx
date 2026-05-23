'use client'

/**
 * PG.7 — Shared catalog thumbnail.
 *
 * Used by ProductIdentityCell (the combined Product column) and the
 * standalone 'thumb' column in /products. Consolidates four polish
 * features that were either missing or duplicated across the two
 * previous render paths:
 *
 *   1. Density-aware sizing (PG.3) via DensityContext → DENSITY_THUMB_PX.
 *   2. onError fallback (PG.1c) — broken Amazon CDN URLs swap to the
 *      placeholder instead of leaving an empty box.
 *   3. Hover preview at 320 px after a 400 ms dwell. Portal-rendered
 *      so virtualized rows can't clip it; auto-positions above the
 *      thumb but flips below when within ~360 px of the viewport top.
 *   4. (Removed) — the multi-image dot used to show a Layers icon +
 *      count in the corner when photoCount > 1; the hover preview
 *      already surfaces "1 of N" so the badge was redundant clutter.
 *
 * Cloudinary URLs (`res.cloudinary.com/<cloud>/image/upload/...`) are
 * rewritten with a per-density transform so a 32 px compact thumb
 * actually requests a 32 px asset instead of the full-res master
 * (4× bandwidth savings on the 100-row paint). Non-Cloudinary URLs
 * (Amazon CDN, eBay, Shopify) pass through unchanged — they self-size
 * via their own URL conventions.
 */

import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Image as ImageIcon, Loader2, Upload } from 'lucide-react'
import {
  DENSITY_THUMB_ICON_PX,
  DENSITY_THUMB_PX,
} from '@/lib/theme'
import { useTranslations } from '@/lib/i18n/use-translations'
import { DensityContext } from './VirtualizedGrid'

export interface ThumbnailProps {
  src: string | null
  /** Total master-gallery image count. When >1, renders a small
   *  badge in the corner. Pass 0 / 1 to hide. */
  photoCount?: number
  /** Alt text for screen readers. */
  alt?: string
  /** When true, hovering the thumbnail opens a 320 px preview popover
   *  after a 400 ms dwell. Default true. Skip for surfaces where the
   *  thumb already has a richer interaction (e.g. drag-to-reorder
   *  galleries inside the per-product editor). */
  hoverPreview?: boolean
  /** Optional click handler. Used by ProductIdentityCell to open the
   *  drawer; the standalone 'thumb' column passes nothing and renders
   *  a div (no click). */
  onClick?: () => void
  /** Override the auto-derived button title / aria-label. */
  title?: string
  /** PG.9 — when set, dragging image files over the thumbnail shows
   *  a "Drop to upload" overlay; drop fires the callback. The caller
   *  owns the actual upload (POST /api/products/:id/images per file)
   *  so this component stays free of product-specific endpoints. */
  onUpload?: (files: File[]) => Promise<void>
}

const HOVER_DELAY_MS = 400
const PREVIEW_SIZE_PX = 320

/** Insert a Cloudinary delivery transform into the URL if applicable. */
function withCloudinaryTransform(url: string, transform: string): string {
  if (!url.includes('res.cloudinary.com')) return url
  // Match the canonical `/image/upload/` segment. Any existing
  // transforms (e.g. operator already applied a crop) stay intact
  // because we splice in front of them as a new transform layer.
  return url.replace(/\/image\/upload\//, `/image/upload/${transform}/`)
}

function thumbTransformFor(px: number): string {
  // f_auto: serve webp/avif when the browser supports it.
  // q_auto: per-image quality tuning (smaller files at same SSIM).
  // c_fill: cover the bounding box; matches the object-cover CSS.
  // dpr_2.0: respect retina so the 32 px thumb isn't fuzzy on macOS.
  return `w_${px},h_${px},c_fill,f_auto,q_auto,dpr_2.0`
}

function previewTransform(): string {
  return `w_${PREVIEW_SIZE_PX},c_fit,f_auto,q_auto`
}

function ThumbnailImpl({
  src,
  photoCount = 0,
  alt = '',
  hoverPreview = true,
  onClick,
  title,
  onUpload,
}: ThumbnailProps) {
  const { t } = useTranslations()
  const density = useContext(DensityContext)
  const thumbPx = DENSITY_THUMB_PX[density]
  const iconPx = DENSITY_THUMB_ICON_PX[density]

  const [imgFailed, setImgFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewPos, setPreviewPos] = useState<{
    top: number
    left: number
  } | null>(null)
  // PG.9 — drag-drop upload state. dragOver is the "highlight the drop
  // target" flag (transient on dragenter/leave); uploading is the
  // "show a spinner instead of the thumb" flag (active during the
  // onUpload promise).
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)

  const hostRef = useRef<HTMLElement | null>(null)
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Memoise the transformed URLs so onLoad / onError keep referring to
  // the same src string and React doesn't bounce the <img> on re-render.
  const thumbSrc = src ? withCloudinaryTransform(src, thumbTransformFor(thumbPx * 2)) : null
  const previewSrc = src ? withCloudinaryTransform(src, previewTransform()) : null

  const showImage = thumbSrc && !imgFailed

  const clearDwell = useCallback(() => {
    if (dwellTimerRef.current) {
      clearTimeout(dwellTimerRef.current)
      dwellTimerRef.current = null
    }
  }, [])

  const openPreview = useCallback(() => {
    if (!hoverPreview || !showImage) return
    const el = hostRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Default position: above + horizontally aligned with the thumb's
    // top-left. Flip below if too close to the viewport top so the
    // preview doesn't get clipped by the sticky header.
    const wantsAbove = rect.top > PREVIEW_SIZE_PX + 16
    const top = wantsAbove
      ? rect.top - PREVIEW_SIZE_PX - 12
      : rect.bottom + 8
    // Clamp horizontally so the preview never falls off the right edge.
    const maxLeft = window.innerWidth - PREVIEW_SIZE_PX - 8
    const left = Math.min(Math.max(rect.left, 8), Math.max(8, maxLeft))
    setPreviewPos({ top, left })
    setPreviewOpen(true)
  }, [hoverPreview, showImage])

  const handleMouseEnter = useCallback(() => {
    if (!hoverPreview || !showImage) return
    clearDwell()
    dwellTimerRef.current = setTimeout(openPreview, HOVER_DELAY_MS)
  }, [hoverPreview, showImage, openPreview, clearDwell])

  const handleMouseLeave = useCallback(() => {
    clearDwell()
    setPreviewOpen(false)
  }, [clearDwell])

  // Close preview when the user scrolls the page — bounding-rect
  // calculation is captured at mouseenter, not live-tracked.
  useEffect(() => {
    if (!previewOpen) return
    const onScroll = () => {
      setPreviewOpen(false)
      clearDwell()
    }
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [previewOpen, clearDwell])

  // Cleanup the dwell timer if the row unmounts mid-hover (virtualized
  // grids recycle rows aggressively on fast scroll).
  useEffect(() => () => clearDwell(), [clearDwell])

  const style: React.CSSProperties = { width: thumbPx, height: thumbPx }

  // Choose between <button> (clickable) and <div> (decorative) so
  // keyboard + a11y semantics match the surrounding cell.
  const Tag = (onClick ? 'button' : 'div') as 'button' | 'div'

  const content = showImage ? (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={thumbSrc}
        alt={alt}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setImgFailed(true)}
        style={style}
        className={`rounded object-cover bg-slate-100 dark:bg-slate-800 transition-opacity duration-150 ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
      {/* Skeleton underlay — visible until <img> onLoad fires. Same
          rounded corner + bg so the swap reads as a "fade in" rather
          than a layout shift. */}
      {!loaded && (
        <div
          aria-hidden="true"
          style={style}
          className="absolute inset-0 rounded bg-slate-100 dark:bg-slate-800 animate-pulse"
        />
      )}
    </>
  ) : (
    <div
      role="img"
      aria-label={alt || 'No image'}
      style={style}
      className="rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500"
    >
      <ImageIcon size={iconPx} aria-hidden="true" />
    </div>
  )

  // PG.9 — drag-drop upload wiring. Only active when onUpload is set;
  // otherwise the handlers are no-ops so existing surfaces (e.g. the
  // gallery editor) don't accidentally intercept their own drag-drop.
  // dragenter/dragover both preventDefault — without it the browser
  // refuses to fire drop.
  const handleDragEnter = (e: React.DragEvent) => {
    if (!onUpload || uploading) return
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    setDragOver(true)
  }
  const handleDragOver = (e: React.DragEvent) => {
    if (!onUpload || uploading) return
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'copy'
  }
  const handleDragLeave = (e: React.DragEvent) => {
    if (!onUpload) return
    // Ignore leave events firing from descendants of the host (the
    // overlay div, image, etc.); only clear when the cursor actually
    // exits the bounding rect.
    if (e.currentTarget === e.target) setDragOver(false)
  }
  const handleDrop = async (e: React.DragEvent) => {
    if (!onUpload || uploading) return
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('image/'),
    )
    if (files.length === 0) return
    setUploading(true)
    try {
      await onUpload(files)
    } finally {
      setUploading(false)
    }
  }

  return (
    <>
      <Tag
        ref={hostRef as React.Ref<HTMLButtonElement & HTMLDivElement>}
        {...(Tag === 'button'
          ? {
              type: 'button',
              onClick,
              title,
              'aria-label': title,
              className:
                'relative flex-shrink-0 cursor-pointer rounded focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none',
            }
          : {
              className: 'relative flex-shrink-0',
            })}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onDragEnter={onUpload ? handleDragEnter : undefined}
        onDragOver={onUpload ? handleDragOver : undefined}
        onDragLeave={onUpload ? handleDragLeave : undefined}
        onDrop={onUpload ? handleDrop : undefined}
      >
        {content}
        {/* PG.9 — drag-over overlay. Same square as the thumb so the
            operator sees the exact drop zone. Only visible while a
            file drag is hovering AND onUpload is wired. */}
        {dragOver && onUpload && (
          <div
            role="status"
            aria-live="polite"
            aria-label={t('products.thumb.dropToUpload')}
            title={t('products.thumb.dropToUpload')}
            style={{ width: thumbPx, height: thumbPx }}
            className="absolute inset-0 rounded bg-blue-500/20 border-2 border-dashed border-blue-500 flex items-center justify-center text-blue-700 dark:text-blue-300 pointer-events-none"
          >
            <Upload size={Math.max(iconPx, 14)} strokeWidth={2.5} />
          </div>
        )}
        {/* PG.9 — upload-in-flight spinner. Replaces the thumb until
            the onUpload promise resolves so the operator sees that
            their drop landed and the network request is in motion. */}
        {uploading && (
          <div
            role="status"
            aria-live="polite"
            aria-busy="true"
            aria-label={t('products.thumb.uploading')}
            title={t('products.thumb.uploading')}
            style={{ width: thumbPx, height: thumbPx }}
            className="absolute inset-0 rounded bg-slate-900/70 flex items-center justify-center text-white"
          >
            <Loader2 size={Math.max(iconPx, 14)} className="animate-spin" />
          </div>
        )}
      </Tag>
      {previewOpen && previewPos && previewSrc &&
        createPortal(
          <div
            role="tooltip"
            style={{ top: previewPos.top, left: previewPos.left }}
            className="fixed z-[60] rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-1 pointer-events-none"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewSrc}
              alt={alt}
              decoding="async"
              style={{ maxWidth: PREVIEW_SIZE_PX, maxHeight: PREVIEW_SIZE_PX }}
              className="rounded"
            />
            {photoCount > 1 && (
              <div className="text-[10px] text-slate-500 dark:text-slate-400 px-1 py-0.5">
                1 of {photoCount}
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
  )
}

// PG.11 — memoise to skip re-renders when only sibling rows change.
// At page size 250 with virtualization, J/K navigation re-renders ~12
// rows × 2 thumbs = 24 Thumbnail evaluations per keystroke; the
// component does Cloudinary URL parsing + hover-timer plumbing on
// every mount. Default shallow compare is enough because every
// caller passes string / number primitives (src, photoCount, alt,
// title) and stable callback refs (handleThumbClick + handleThumbUpload
// are both useCallback-wrapped in GridView).
export const Thumbnail = memo(ThumbnailImpl)

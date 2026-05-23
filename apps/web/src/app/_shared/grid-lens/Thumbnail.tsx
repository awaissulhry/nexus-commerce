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
 *   4. Multi-image dot — small badge in the corner when photoCount > 1
 *      so the operator sees at a glance which SKUs have a full gallery
 *      vs. a single hero.
 *
 * Cloudinary URLs (`res.cloudinary.com/<cloud>/image/upload/...`) are
 * rewritten with a per-density transform so a 32 px compact thumb
 * actually requests a 32 px asset instead of the full-res master
 * (4× bandwidth savings on the 100-row paint). Non-Cloudinary URLs
 * (Amazon CDN, eBay, Shopify) pass through unchanged — they self-size
 * via their own URL conventions.
 */

import {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { Image as ImageIcon, Layers as ImagesIcon } from 'lucide-react'
import {
  DENSITY_THUMB_ICON_PX,
  DENSITY_THUMB_PX,
} from '@/lib/theme'
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

export function Thumbnail({
  src,
  photoCount = 0,
  alt = '',
  hoverPreview = true,
  onClick,
  title,
}: ThumbnailProps) {
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

  const hostRef = useRef<HTMLElement | null>(null)
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Memoise the transformed URLs so onLoad / onError keep referring to
  // the same src string and React doesn't bounce the <img> on re-render.
  const thumbSrc = src ? withCloudinaryTransform(src, thumbTransformFor(thumbPx * 2)) : null
  const previewSrc = src ? withCloudinaryTransform(src, previewTransform()) : null

  const showImage = thumbSrc && !imgFailed
  const showDot = photoCount > 1

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
      {showDot && (
        <span
          aria-label={`${photoCount} photos`}
          title={`${photoCount} photos`}
          className="absolute bottom-0.5 right-0.5 inline-flex items-center justify-center gap-0.5 px-1 py-px rounded text-[9px] font-semibold bg-slate-900/75 text-white leading-none"
        >
          <ImagesIcon size={8} strokeWidth={2.5} />
          {photoCount}
        </span>
      )}
    </>
  ) : (
    <div
      style={style}
      className="rounded bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-slate-400 dark:text-slate-500"
    >
      <ImageIcon size={iconPx} />
    </div>
  )

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
      >
        {content}
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

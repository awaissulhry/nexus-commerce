'use client'

/**
 * Thumbnail — a product image in a cell, sized by the grid's density.
 *
 * Lifted into the design system from `app/_shared/grid-lens/Thumbnail.tsx` (GDS Phase 2): the DS
 * grid imported the Tailwind kit it retires for exactly this one component. Same behaviour, DS
 * classes and tokens:
 *
 *   1. Density-aware sizing — reads `useGridDensity()` (compact 32 / cozy 40 / spacious 56, from
 *      `tokens/grid.ts`), so a modal grid's thumbs follow the page's density with nothing passed.
 *   2. onError fallback — a broken CDN URL swaps to the placeholder instead of an empty box.
 *   3. Hover preview at 320px after a 400ms dwell, portal-rendered so a virtualised row cannot
 *      clip it; sits above the thumb, flips below near the viewport top.
 *   4. CDN-sized requests. A Cloudinary URL gets a `w_,h_,c_fill` transform; an Amazon URL gets the
 *      size in its FILENAME (`<id>._SL112_.jpg`) — a bare Amazon URL serves the 2560×2560 master,
 *      measured at 2112ms to paint a 56px box vs 264ms sized. eBay/Shopify pass through.
 *
 * Not carried over: the drag-to-upload overlay. It has no consumer on a DS grid; the grid-lens
 * copy keeps it for the workspaces that still use that kit.
 */
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { Image as ImageIcon } from 'lucide-react'

import { useGridDensity } from '../grid/hooks/useGridDensity'
import { gridDensity } from '../tokens/grid'

export interface ThumbnailProps {
  src: string | null
  /** Total gallery image count; the hover preview says "1 of N" when > 1. */
  photoCount?: number
  alt?: string
  /** Hovering opens a 320px preview after a 400ms dwell. Default true. */
  hoverPreview?: boolean
  /** When set the thumb is a button; otherwise a plain box. */
  onClick?: () => void
  /** Overrides the button's title / aria-label. */
  title?: string
}

const HOVER_DELAY_MS = 400
const PREVIEW_SIZE_PX = 320

/** The empty-placeholder icon per density — scaled with the box it sits in. */
const ICON_PX = { compact: 12, cozy: 14, spacious: 18 } as const

function withCloudinaryTransform(url: string, transform: string): string {
  if (!url.includes('res.cloudinary.com')) return url
  return url.replace(/\/image\/upload\//, `/image/upload/${transform}/`)
}

/**
 * Ask Amazon's CDN for a sized rendition. The size is a filename segment, not a query param:
 * `<id>.jpg` → `<id>._SL112_.jpg`. Any modifier block already present (`._AC_SX679_`) is REPLACED
 * rather than appended — Amazon honours the last one, and stacking them is how you get a 404.
 */
function withAmazonTransform(url: string, px: number): string {
  if (!/(?:m\.media-amazon|images-amazon|ssl-images-amazon)\.com/.test(url)) return url
  return url.replace(
    /(\._[A-Za-z0-9,]+_)?\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i,
    (_m, _mod, ext: string, qs: string | undefined) => `._SL${px}_.${ext}${qs ?? ''}`,
  )
}

const sizedFor = (url: string, px: number): string =>
  withAmazonTransform(withCloudinaryTransform(url, `w_${px},h_${px},c_fill,f_auto,q_auto,dpr_2.0`), px)

const previewFor = (url: string): string =>
  withAmazonTransform(withCloudinaryTransform(url, `w_${PREVIEW_SIZE_PX},c_fit,f_auto,q_auto`), PREVIEW_SIZE_PX)

function ThumbnailImpl({ src, photoCount = 0, alt = '', hoverPreview = true, onClick, title }: ThumbnailProps) {
  const density = useGridDensity()
  const px = gridDensity[density].thumb
  const iconPx = ICON_PX[density]
  const [imgFailed, setImgFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [previewPos, setPreviewPos] = useState<{ top: number; left: number } | null>(null)
  const hostRef = useRef<HTMLElement | null>(null)
  const dwellTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Twice the box for a crisp thumb on a 2× display; the preview is its own size.
  const thumbSrc = src ? sizedFor(src, px * 2) : null
  const previewSrc = src ? previewFor(src) : null
  const showImage = !!thumbSrc && !imgFailed

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
    const wantsAbove = rect.top > PREVIEW_SIZE_PX + 16
    const top = wantsAbove ? rect.top - PREVIEW_SIZE_PX - 12 : rect.bottom + 8
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
  useEffect(() => {
    if (!previewOpen) return
    const onScroll = () => {
      setPreviewOpen(false)
      clearDwell()
    }
    window.addEventListener('scroll', onScroll, true)
    return () => window.removeEventListener('scroll', onScroll, true)
  }, [previewOpen, clearDwell])
  useEffect(() => () => clearDwell(), [clearDwell])

  const box: CSSProperties = { width: px, height: px }
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
        style={box}
        className={loaded ? 'nds-thumb-img is-loaded' : 'nds-thumb-img'}
      />
      {/* Skeleton underlay until onLoad fires — the swap reads as a fade, not a layout shift. */}
      {!loaded && <div aria-hidden="true" style={box} className="nds-thumb-skel" />}
    </>
  ) : (
    <div role="img" aria-label={alt || 'No image'} style={box} className="nds-thumb-empty">
      <ImageIcon size={iconPx} aria-hidden="true" />
    </div>
  )

  const shared = { onMouseEnter: handleMouseEnter, onMouseLeave: handleMouseLeave }
  const host = onClick ? (
    <button
      ref={hostRef as Ref<HTMLButtonElement>}
      type="button"
      className="nds-thumb nds-thumb-btn"
      onClick={onClick}
      title={title}
      aria-label={title}
      {...shared}
    >
      {content}
    </button>
  ) : (
    <div ref={hostRef as Ref<HTMLDivElement>} className="nds-thumb" {...shared}>
      {content}
    </div>
  )

  return (
    <>
      {host}
      {previewOpen && previewPos && previewSrc &&
        createPortal(
          <div role="tooltip" className="nds-thumb-preview" style={{ top: previewPos.top, left: previewPos.left }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={previewSrc} alt={alt} decoding="async" style={{ maxWidth: PREVIEW_SIZE_PX, maxHeight: PREVIEW_SIZE_PX }} />
            {photoCount > 1 && <div className="nds-thumb-preview-count">1 of {photoCount}</div>}
          </div>,
          document.body,
        )}
    </>
  )
}

export const Thumbnail = memo(ThumbnailImpl)

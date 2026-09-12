'use client'

/**
 * PES.7 — crop, rotate and flip a master image.
 *
 * The result is a NEW row (`derivedFromImageId` → the source), not an edit in place: the original
 * bytes stay, and a derivative is a Cloudinary transformation URL over them. Nothing is re-uploaded
 * and nothing is destroyed, which is why this needs no confirmation.
 *
 * 🔴 The preview is GEOMETRIC, done with CSS, and deliberately not a reproduction of the server's
 * Cloudinary URL. `buildDerivedUrl` lives in `cloudinary.service.ts`; a client-side copy of it
 * would be a second implementation of the same rule, and the day the two drift the preview starts
 * lying about what will be saved. Geometry is what the operator is actually choosing here — the
 * crop rectangle, the quarter-turn, the mirror — and CSS shows that exactly.
 *
 * 🔴 A derivative cannot itself be derived from: the server needs the source's Cloudinary
 * `publicId`, and a derived row's is NULL by design. The control says so up front instead of
 * letting the operator do the work and collect a 400.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Modal } from '@/design-system/components'
import { Button, SegmentedControl } from '@/design-system/primitives'
import { cdnFit } from '@/design-system/lib/cdn-image'

import { apiSend, routes, type ApiResult } from '../api'
import { writeSubject } from '../imageWrites'
import {
  cropFromDrag, cropToSourcePixels, FULL_CROP, isFullCrop, paintedRect, pointToFraction,
  type CropFrac, type Rect,
} from './cropGeometry'
import type { MasterAsset } from '../types'
import styles from './editor.module.css'

export interface ImageEditorProps {
  productId: string
  asset: MasterAsset | null
  onClose(): void
  /** The server's created row, appended to the gallery. */
  onDerived(created: MasterAsset): void
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}

const ASPECTS = [
  { value: 'free', label: 'Free', ratio: null },
  { value: '1', label: '1:1', ratio: 1 },
  { value: '4x3', label: '4:3', ratio: 4 / 3 },
  { value: '4x5', label: '4:5', ratio: 4 / 5 },
] as const

const VIEW_PX = 1200

export function ImageEditor({ productId, asset, onClose, onDerived, write }: ImageEditorProps) {
  const [rotate, setRotate] = useState(0)
  const [flipH, setFlipH] = useState(false)
  const [flipV, setFlipV] = useState(false)
  const [aspect, setAspect] = useState<string>('free')
  const [crop, setCrop] = useState<CropFrac>(FULL_CROP)
  const [saving, setSaving] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{ x: number; y: number } | null>(null)
  /** Where the picture actually is inside the image element, in element-box pixels. */
  const [painted, setPainted] = useState<Rect>({ left: 0, top: 0, width: 0, height: 0 })

  /**
   * `object-fit: contain` letterboxes the picture inside the element box, so the two are different
   * rectangles and the crop must be measured against the PAINTED one. Recomputed on load and on
   * every layout change — the modal is viewport-sized, so a window resize moves it.
   */
  const measure = useCallback(() => {
    const frame = frameRef.current
    const img = imgRef.current
    if (!frame || !img) return
    const next = paintedRect(
      frame.getBoundingClientRect(), img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight)
    if (next) setPainted(next)
  }, [])

  useEffect(() => {
    // A CACHED image is already `complete` at mount and never fires `onLoad`, so measuring only
    // there would leave the crop dead on exactly the images an operator revisits. Measure now, on
    // the next frame (after layout settles), on load, and on every resize.
    measure()
    const raf = requestAnimationFrame(measure)
    const el = frameRef.current
    const ro = el ? new ResizeObserver(measure) : null
    if (el && ro) ro.observe(el)
    return () => { cancelAnimationFrame(raf); ro?.disconnect() }
  }, [measure, asset?.id])

  const reset = useCallback(() => {
    setRotate(0); setFlipH(false); setFlipV(false); setAspect('free'); setCrop(FULL_CROP); setRefusal(null)
  }, [])

  const close = useCallback(() => { reset(); onClose() }, [onClose, reset])

  const cropped = !isFullCrop(crop)
  const dirty = cropped || rotate !== 0 || flipH || flipV

  /** Drag a new crop rectangle across the image. Fractions, clamped to the frame. */
  /** Pointer position as a fraction of the PAINTED picture, clamped to it. */
  const fracAt = useCallback((clientX: number, clientY: number) => {
    const box = frameRef.current?.getBoundingClientRect()
    if (!box) return null
    return pointToFraction(clientX, clientY, box, painted)
  }, [painted])

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const p = fracAt(e.clientX, e.clientY)
    if (!p) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = p
  }, [fracAt])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const start = dragRef.current
    const cur = fracAt(e.clientX, e.clientY)
    if (!start || !cur) return
    const next = cropFromDrag(start, cur, painted, ASPECTS.find((a) => a.value === aspect)?.ratio ?? null)
    if (next) setCrop(next)
  }, [aspect, fracAt, painted])

  const onPointerUp = useCallback(() => { dragRef.current = null }, [])

  const save = useCallback(async () => {
    if (!asset) return
    setSaving(true)
    setRefusal(null)
    // Fractions → source pixels, which is what the API's crop takes.
    const body: Record<string, unknown> = {}
    if (cropped && asset.width != null && asset.height != null) {
      body.crop = cropToSourcePixels(crop, asset.width, asset.height)
    }
    if (rotate !== 0) body.rotate = rotate
    if (flipH) body.flipH = true
    if (flipV) body.flipV = true

    const res = await write(writeSubject.asset(asset.id), () => apiSend<MasterAsset>(routes.derive(productId, asset.id), 'POST', body))
    setSaving(false)
    if (!res.ok) { setRefusal(res.message); return }
    if (res.data?.id) { onDerived(res.data); reset(); onClose() }
  }, [asset, crop, cropped, flipH, flipV, onClose, onDerived, productId, reset, rotate, write])

  const transform = useMemo(
    () => `rotate(${rotate}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})`,
    [flipH, flipV, rotate],
  )

  if (!asset) return null

  // A crop needs source pixels to convert into; without them only rotate/flip are offered.
  const canCrop = asset.width != null && asset.height != null
  // The server derives from the source's Cloudinary publicId, which a derivative does not have.
  const canDerive = asset.publicId != null

  return (
    <Modal
      open
      onClose={close}
      size="full"
      title="Edit image"
      subtitle={`${asset.type} · saved as a new image, the original is kept`}
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={close}>Cancel</Button>
          {dirty && <Button size="sm" variant="ghost" onClick={reset}>Reset</Button>}
          <Button size="sm" variant="primary" disabled={!dirty || saving || !canDerive} onClick={() => void save()}>
            {saving ? 'Saving…' : 'Save as new image'}
          </Button>
        </>
      }
    >
      <div className={styles.layout}>
        <div className={styles.stage}>
          <div
            ref={frameRef}
            className={styles.frame}
            style={{ transform }}
            onPointerDown={canCrop ? onPointerDown : undefined}
            onPointerMove={canCrop ? onPointerMove : undefined}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              className={styles.img}
              src={cdnFit(asset.url, VIEW_PX)}
              alt=""
              draggable={false}
              onLoad={measure}
            />
            {cropped && painted.width > 0 && (() => {
              // Overlay geometry in PAINTED-rect pixels, so the dimming and the selection sit on
              // the picture rather than on the letterbox around it.
              const L = painted.left, T = painted.top, W = painted.width, H = painted.height
              const cx = L + crop.x * W, cy = T + crop.y * H, cw = crop.w * W, ch = crop.h * H
              return (
                <>
                  {/* The discarded area, dimmed, so the crop reads as a subtraction from the whole. */}
                  <div className={styles.shade} style={{ left: L, top: T, width: W, height: cy - T }} />
                  <div className={styles.shade} style={{ left: L, top: cy + ch, width: W, height: T + H - (cy + ch) }} />
                  <div className={styles.shade} style={{ left: L, top: cy, width: cx - L, height: ch }} />
                  <div className={styles.shade} style={{ left: cx + cw, top: cy, width: L + W - (cx + cw), height: ch }} />
                  <div className={styles.cropBox} style={{ left: cx, top: cy, width: cw, height: ch }} />
                </>
              )
            })()}
          </div>
        </div>

        <aside className={styles.pane}>
          {!canDerive && (
            <p className={styles.warn} role="alert">
              This image is itself an edit of another one, so it has no stored original to transform.
              Edit the image it came from instead.
            </p>
          )}

          <section className={styles.block}>
            <span className={styles.label}>Rotate</span>
            <div className={styles.row}>
              <Button size="sm" variant="secondary" onClick={() => setRotate((r) => (r - 90 + 360) % 360)}>↺ 90°</Button>
              <Button size="sm" variant="secondary" onClick={() => setRotate((r) => (r + 90) % 360)}>↻ 90°</Button>
              <span className={styles.value}>{rotate}°</span>
            </div>
          </section>

          <section className={styles.block}>
            <span className={styles.label}>Flip</span>
            <div className={styles.row}>
              <Button size="sm" variant={flipH ? 'primary' : 'secondary'} onClick={() => setFlipH((v) => !v)}>Horizontal</Button>
              <Button size="sm" variant={flipV ? 'primary' : 'secondary'} onClick={() => setFlipV((v) => !v)}>Vertical</Button>
            </div>
          </section>

          <section className={styles.block}>
            <span className={styles.label}>Crop</span>
            {canCrop ? (
              <>
                <SegmentedControl
                  ariaLabel="Crop aspect ratio"
                  size="sm"
                  value={aspect}
                  onChange={(v) => { setAspect(v); setCrop(FULL_CROP) }}
                  options={ASPECTS.map((a) => ({ value: a.value, label: a.label }))}
                />
                <p className={styles.hint}>Drag across the image to choose the area to keep.</p>
                {cropped && (
                  <div className={styles.row}>
                    <span className={styles.value}>
                      {Math.round(crop.w * asset.width!)}×{Math.round(crop.h * asset.height!)} px
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setCrop(FULL_CROP)}>Clear crop</Button>
                  </div>
                )}
              </>
            ) : (
              /* Cropping converts fractions into source pixels; without recorded dimensions there
                 is nothing to convert into, and guessing them would save the wrong rectangle. */
              <p className={styles.hint}>
                This image has no recorded dimensions, so a crop cannot be measured. Rotate and flip
                still work.
              </p>
            )}
          </section>

          {refusal && <p className={styles.warn} role="alert">{refusal}</p>}

          <p className={styles.hint}>
            The preview shows the geometry. The saved image is produced by the image CDN from the
            original, so its pixels come from the source rather than from this preview.
          </p>
        </aside>
      </div>
    </Modal>
  )
}

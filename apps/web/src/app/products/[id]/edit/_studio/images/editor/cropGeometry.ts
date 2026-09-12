/**
 * PES.7 — the crop's arithmetic, extracted so it can be PROVEN rather than dragged at.
 *
 * 🔴 There are three rectangles in the editor and they are all different:
 *
 *   frame    the positioned container the overlay is drawn in
 *   element  the `<img>` box inside it — not necessarily the same size, and not at its origin
 *   picture  what `object-fit: contain` actually painted inside the element, letterboxed
 *
 * Measured on a 2250×2250 photo: frame 1319×742, element 742×742 sitting ~288px in from the
 * frame's left edge, picture 742×742. Mixing those spaces is what made a SQUARE drag on a SQUARE
 * photo report 866×1401 — a crop the operator never drew. Three separate attempts to fix it by
 * arranging CSS produced three different wrong answers, because the bug was arithmetic, not layout.
 *
 * So the conversion happens once, here, in frame coordinates, with tests. The component only wires
 * DOM rects into these functions.
 */

export interface Rect { left: number; top: number; width: number; height: number }
export interface CropFrac { x: number; y: number; w: number; h: number }

export const FULL_CROP: CropFrac = { x: 0, y: 0, w: 1, h: 1 }

/**
 * Where `object-fit: contain` painted the picture, in FRAME coordinates.
 *
 * Returns null when nothing can be measured yet — a natural size of 0 (image not loaded) or a
 * collapsed element box. Callers must treat null as "not ready", never as a zero-sized picture:
 * dividing by a zero width is how the crop silently stopped responding.
 */
export function paintedRect(
  frame: Rect,
  element: Rect,
  naturalWidth: number,
  naturalHeight: number,
): Rect | null {
  if (naturalWidth <= 0 || naturalHeight <= 0) return null
  if (element.width <= 0 || element.height <= 0) return null
  const scale = Math.min(element.width / naturalWidth, element.height / naturalHeight)
  const width = naturalWidth * scale
  const height = naturalHeight * scale
  return {
    // the element's offset within the frame, PLUS the letterbox within the element
    left: (element.left - frame.left) + (element.width - width) / 2,
    top: (element.top - frame.top) + (element.height - height) / 2,
    width,
    height,
  }
}

/** A viewport point as a fraction of the picture, clamped to it. Null when not measurable. */
export function pointToFraction(
  clientX: number,
  clientY: number,
  frame: Rect,
  painted: Rect,
): { x: number; y: number } | null {
  if (painted.width <= 0 || painted.height <= 0) return null
  const x = (clientX - frame.left - painted.left) / painted.width
  const y = (clientY - frame.top - painted.top) / painted.height
  return { x: clamp01(x), y: clamp01(y) }
}

const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1)

/**
 * The rectangle between two dragged corners, optionally forced to an aspect RATIO OF THE SOURCE.
 *
 * The fractions are of the picture, and the picture has the source's aspect, so a target ratio
 * converts through the picture's own ratio — not through the frame's, which is a different shape
 * entirely and was the second wrong answer.
 */
export function cropFromDrag(
  start: { x: number; y: number },
  current: { x: number; y: number },
  painted: Rect,
  aspectRatio: number | null,
): CropFrac | null {
  let x = Math.min(start.x, current.x)
  let y = Math.min(start.y, current.y)
  let w = Math.abs(current.x - start.x)
  let h = Math.abs(current.y - start.y)

  if (aspectRatio && aspectRatio > 0 && w > 0 && h > 0 && painted.height > 0) {
    const pictureRatio = painted.width / painted.height
    const targetH = w * (pictureRatio / aspectRatio)
    if (targetH <= 1) h = targetH
    else { h = 1; w = h * (aspectRatio / pictureRatio) }
    if (y + h > 1) y = Math.max(0, 1 - h)
    if (x + w > 1) x = Math.max(0, 1 - w)
  }

  // Below this a "crop" is a stray click, not an intent.
  if (w <= 0.01 || h <= 0.01) return null
  return { x, y, w, h }
}

/** Fractions of the picture → pixels of the SOURCE, which is what the API's crop takes. */
export function cropToSourcePixels(
  crop: CropFrac,
  sourceWidth: number,
  sourceHeight: number,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(crop.x * sourceWidth),
    y: Math.round(crop.y * sourceHeight),
    width: Math.round(crop.w * sourceWidth),
    height: Math.round(crop.h * sourceHeight),
  }
}

export const isFullCrop = (c: CropFrac) => c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1

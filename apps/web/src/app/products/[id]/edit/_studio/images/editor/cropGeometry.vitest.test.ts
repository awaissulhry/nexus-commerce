/**
 * PES.7 — the crop arithmetic. These exist because the bug they pin down survived three attempts
 * to fix it in CSS: a square drag on a square photo reported 866×1401.
 */
import { describe, expect, it } from 'vitest'

import {
  cropFromDrag, cropToSourcePixels, paintedRect, pointToFraction, type Rect,
} from './cropGeometry'

/** The real geometry measured in the browser: frame wider than the element, picture square. */
const FRAME: Rect = { left: 55, top: 119, width: 1319, height: 742 }
const ELEMENT: Rect = { left: 343, top: 119, width: 742, height: 742 }

describe('paintedRect', () => {
  it('locates a square picture inside a wider frame, in FRAME coordinates', () => {
    const p = paintedRect(FRAME, ELEMENT, 2250, 2250)!
    expect(p.width).toBeCloseTo(742, 0)
    expect(p.height).toBeCloseTo(742, 0)
    // 343 - 55 = 288: the element's own offset within the frame, which the first fix ignored.
    expect(p.left).toBeCloseTo(288, 0)
    expect(p.top).toBeCloseTo(0, 0)
  })

  it('accounts for the letterbox when the element is wider than the picture', () => {
    // A square photo in a 1000x500 element: painted 500x500, 250px of letterbox each side.
    const p = paintedRect({ left: 0, top: 0, width: 1000, height: 500 },
                          { left: 0, top: 0, width: 1000, height: 500 }, 2000, 2000)!
    expect(p.width).toBeCloseTo(500, 0)
    expect(p.left).toBeCloseTo(250, 0)
    expect(p.top).toBeCloseTo(0, 0)
  })

  it('accounts for the letterbox when the element is taller than the picture', () => {
    const p = paintedRect({ left: 0, top: 0, width: 500, height: 1000 },
                          { left: 0, top: 0, width: 500, height: 1000 }, 2000, 2000)!
    expect(p.height).toBeCloseTo(500, 0)
    expect(p.top).toBeCloseTo(250, 0)
  })

  it('returns null rather than a zero-sized picture when nothing is measurable', () => {
    // A cached image measured before layout, and an unloaded one, both mean "not ready".
    expect(paintedRect(FRAME, ELEMENT, 0, 0)).toBeNull()
    expect(paintedRect(FRAME, { ...ELEMENT, width: 0, height: 0 }, 2250, 2250)).toBeNull()
  })
})

describe('pointToFraction', () => {
  it('maps the picture corners to 0 and 1', () => {
    const p = paintedRect(FRAME, ELEMENT, 2250, 2250)!
    expect(pointToFraction(343, 119, FRAME, p)).toEqual({ x: 0, y: 0 })
    expect(pointToFraction(343 + 742, 119 + 742, FRAME, p)).toEqual({ x: 1, y: 1 })
  })

  it('clamps a point dragged out over the letterbox', () => {
    const p = paintedRect(FRAME, ELEMENT, 2250, 2250)!
    expect(pointToFraction(60, 130, FRAME, p)!.x).toBe(0)
    expect(pointToFraction(1370, 130, FRAME, p)!.x).toBe(1)
  })

  it('returns null when the picture has not been measured', () => {
    expect(pointToFraction(400, 300, FRAME, { left: 0, top: 0, width: 0, height: 0 })).toBeNull()
  })
})

describe('the bug this file exists for', () => {
  it('reports a SQUARE crop for a square drag on a square photo', () => {
    const p = paintedRect(FRAME, ELEMENT, 2250, 2250)!
    // The exact drag that produced 866x1401 before the fix.
    const a = pointToFraction(443, 219, FRAME, p)!
    const b = pointToFraction(843, 619, FRAME, p)!
    const crop = cropFromDrag(a, b, p, null)!
    const px = cropToSourcePixels(crop, 2250, 2250)
    expect(Math.abs(px.width - px.height)).toBeLessThanOrEqual(1)
    // 400 screen px of a 742px picture over a 2250px source.
    expect(px.width).toBeCloseTo(Math.round(400 / 742 * 2250), -1)
  })
})

describe('cropFromDrag', () => {
  it('normalises a drag made right-to-left and bottom-to-top', () => {
    const p: Rect = { left: 0, top: 0, width: 100, height: 100 }
    const forward = cropFromDrag({ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 }, p, null)!
    const backward = cropFromDrag({ x: 0.8, y: 0.8 }, { x: 0.2, y: 0.2 }, p, null)!
    expect(backward).toEqual(forward)
  })

  it('holds a 1:1 ratio against a square picture', () => {
    const p: Rect = { left: 0, top: 0, width: 500, height: 500 }
    const c = cropFromDrag({ x: 0.1, y: 0.1 }, { x: 0.6, y: 0.9 }, p, 1)!
    expect(c.w).toBeCloseTo(c.h, 5)
  })

  it('holds a 1:1 ratio against a NON-square picture, where the frame ratio would not', () => {
    // 1000x500 picture: equal FRACTIONS are not equal pixels, so the ratio must convert through
    // the picture's own aspect. w:h fractions should be 1:2 for a square result.
    const p: Rect = { left: 0, top: 0, width: 1000, height: 500 }
    const c = cropFromDrag({ x: 0, y: 0 }, { x: 0.4, y: 0.9 }, p, 1)!
    expect(c.h / c.w).toBeCloseTo(2, 3)
  })

  it('keeps a ratio-locked crop inside the picture', () => {
    const p: Rect = { left: 0, top: 0, width: 500, height: 500 }
    const c = cropFromDrag({ x: 0.7, y: 0.7 }, { x: 1, y: 1 }, p, 1)!
    expect(c.x + c.w).toBeLessThanOrEqual(1.0001)
    expect(c.y + c.h).toBeLessThanOrEqual(1.0001)
  })

  it('rejects a stray click as not a crop', () => {
    const p: Rect = { left: 0, top: 0, width: 500, height: 500 }
    expect(cropFromDrag({ x: 0.5, y: 0.5 }, { x: 0.502, y: 0.502 }, p, null)).toBeNull()
  })
})

describe('cropToSourcePixels', () => {
  it('converts fractions of the picture into pixels of the SOURCE, not the preview', () => {
    // The preview was 742px wide; the crop must be expressed against the 2250px original.
    expect(cropToSourcePixels({ x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, 2250, 2250))
      .toEqual({ x: 563, y: 1125, width: 1125, height: 563 })
  })
})

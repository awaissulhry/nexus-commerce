import { describe, expect, it } from 'vitest'
import type { PrintPreview } from '../api'
import { againFormOnlyOf, againPagesOf, againPagesWith } from '../model'
import {
  clampPlace,
  dragged,
  isPdfBytes,
  keyed,
  maxSizeOf,
  MIN_CODE_MM,
  mmToPx,
  pageMmOfImage,
  placeBodyOf,
  placeKeyOf,
  pxPerMmOf,
  pxToMm,
  quickPlaceOf,
  resized,
  saveHeldOf,
  savedOf,
  sized,
  startPlaceOf,
  stoppedWhy,
  usualPlaceOf,
  withSaved,
  type SavedPlace,
} from './model'

/**
 * owb-ss4b step 4.4 (design plan § 5f; settle L8; server owb-ss2b) — Place the scan code, pure: the square kept on the page and never
 * under 20 mm (the line says why it stopped), millimetres ↔ pixels, the drag, the corner, the slider, the keys, the six quick places, the
 * PUT body, and "Print this page again…" with only that page ticked. Made-up data only.
 */

const A4 = { widthMm: 210, heightMm: 297 }
const ACROSS = { widthMm: 297, heightMm: 210 }

describe('kept on the page, never under 20 mm', () => {
  it('clamp: a square that runs off an edge comes back onto the page; under 20 mm grows to 20; over the shorter side shrinks to it', () => {
    expect(clampPlace({ xMm: 200, yMm: 290, sizeMm: 30 }, A4)).toEqual({ xMm: 180, yMm: 267, sizeMm: 30 })
    expect(clampPlace({ xMm: -4, yMm: -1, sizeMm: 12 }, A4)).toEqual({ xMm: 0, yMm: 0, sizeMm: MIN_CODE_MM })
    expect(clampPlace({ xMm: 0, yMm: 0, sizeMm: 400 }, A4)).toEqual({ xMm: 0, yMm: 0, sizeMm: 210 })
    expect(maxSizeOf(ACROSS)).toBe(210)
  })

  it('the line says why it stopped: under 20 mm · the edge · bigger than the page', () => {
    expect(stoppedWhy({ xMm: 10, yMm: 10, sizeMm: 15 }, A4)).toEqual({ key: 'place.why.min', params: { min: 20 } })
    expect(stoppedWhy({ xMm: 195, yMm: 10, sizeMm: 20 }, A4)).toEqual({ key: 'place.why.edge' })
    expect(stoppedWhy({ xMm: 10, yMm: -1, sizeMm: 20 }, A4)).toEqual({ key: 'place.why.edge' })
    expect(stoppedWhy({ xMm: 0, yMm: 0, sizeMm: 300 }, A4)).toEqual({ key: 'place.why.max' })
    expect(stoppedWhy({ xMm: 10, yMm: 10, sizeMm: 20 }, A4)).toBeNull()
  })

  it('the usual place: top right, 20 mm, 10 mm from the edges (the domain\'s); an image\'s size by its shape', () => {
    expect(usualPlaceOf(A4)).toEqual({ xMm: 180, yMm: 10, sizeMm: 20 })
    expect(usualPlaceOf(ACROSS)).toEqual({ xMm: 267, yMm: 10, sizeMm: 20 })
    expect(pageMmOfImage(1000, 1414)).toEqual({ widthMm: (297 * 1000) / 1414, heightMm: 297 })
    expect(pageMmOfImage(1414, 1000)).toEqual({ widthMm: 297, heightMm: (297 * 1000) / 1414 })
  })
})

describe('millimetres ↔ pixels, the drag, the corner, the slider, the keys', () => {
  it('mm ↔ px by the page as drawn (630 px wide for 210 mm = 3 px a mm)', () => {
    const pxPerMm = pxPerMmOf(A4, 630)
    expect(pxPerMm).toBe(3)
    expect(mmToPx(20, pxPerMm)).toBe(60)
    expect(pxToMm(60, pxPerMm)).toBe(20)
    expect(pxToMm(10, 0)).toBe(0)
  })

  it('a drag moves by the pixels in mm and stops at the edge (with why)', () => {
    const start = { xMm: 100, yMm: 100, sizeMm: 20 }
    expect(dragged(start, 30, -15, 3, A4)).toEqual({ place: { xMm: 110, yMm: 95, sizeMm: 20 }, why: null })
    expect(dragged(start, 600, 0, 3, A4)).toEqual({ place: { xMm: 190, yMm: 100, sizeMm: 20 }, why: { key: 'place.why.edge' } })
  })

  it('the corner: the larger pull resizes, the top left stays; never under 20 mm (with why)', () => {
    const start = { xMm: 10, yMm: 10, sizeMm: 30 }
    expect(resized(start, 30, 6, 3, A4)).toEqual({ place: { xMm: 10, yMm: 10, sizeMm: 40 }, why: null })
    expect(resized(start, -60, 0, 3, A4)).toEqual({ place: { xMm: 10, yMm: 10, sizeMm: 20 }, why: { key: 'place.why.min', params: { min: 20 } } })
    // Bigger near the edge: the square moves back onto the page.
    expect(sized({ xMm: 180, yMm: 10, sizeMm: 20 }, 40, A4).place).toEqual({ xMm: 170, yMm: 10, sizeMm: 40 })
  })

  it('the keys: arrows 1 mm, Shift + arrows 5 mm, + / − the size; with ⌘, Ctrl or Alt: nothing', () => {
    expect(placeKeyOf({ key: 'ArrowRight', shiftKey: false })).toEqual({ kind: 'move', dxMm: 1, dyMm: 0 })
    expect(placeKeyOf({ key: 'ArrowUp', shiftKey: true })).toEqual({ kind: 'move', dxMm: 0, dyMm: -5 })
    expect(placeKeyOf({ key: '+', shiftKey: false })).toEqual({ kind: 'size', dMm: 1 })
    expect(placeKeyOf({ key: '-', shiftKey: true })).toEqual({ kind: 'size', dMm: -5 })
    expect(placeKeyOf({ key: 'ArrowLeft', shiftKey: false, metaKey: true })).toBeNull()
    expect(placeKeyOf({ key: 'a', shiftKey: false })).toBeNull()
    expect(keyed({ xMm: 0, yMm: 0, sizeMm: 20 }, { kind: 'move', dxMm: -1, dyMm: 0 }, A4)).toEqual({ place: { xMm: 0, yMm: 0, sizeMm: 20 }, why: { key: 'place.why.edge' } })
    expect(keyed({ xMm: 0, yMm: 0, sizeMm: 20 }, { kind: 'size', dMm: -1 }, A4).why).toEqual({ key: 'place.why.min', params: { min: 20 } })
  })

  it('six quick places at the code\'s size, 10 mm from the edges (the middle centred)', () => {
    expect(quickPlaceOf('TOP_LEFT', 20, A4)).toEqual({ xMm: 10, yMm: 10, sizeMm: 20 })
    expect(quickPlaceOf('TOP_MIDDLE', 20, A4)).toEqual({ xMm: 95, yMm: 10, sizeMm: 20 })
    expect(quickPlaceOf('BOTTOM_RIGHT', 30, A4)).toEqual({ xMm: 170, yMm: 257, sizeMm: 30 })
    expect(quickPlaceOf('BOTTOM_LEFT', 5, A4)).toEqual({ xMm: 10, yMm: 267, sizeMm: 20 })
  })
})

describe('the save', () => {
  const row = (page: number, over: Partial<SavedPlace> = {}): SavedPlace => ({ salesOrderLineId: 'line-1', fileId: 'file-1', page, xMm: 10, yMm: 10, sizeMm: 25, version: 2, placedAt: '2026-11-28T09:00:00.000Z', placedBy: { name: 'Dina Designer' }, ...over })

  it('the body: the file, the page, the square and the page\'s sides in mm (2 decimals), the version of a saved place', () => {
    expect(placeBodyOf({ fileId: 'file-1', page: 2, place: { xMm: 12.345, yMm: 8, sizeMm: 24 }, pageMm: { widthMm: 210.0016, heightMm: 297.0001 }, saved: null })).toEqual({ fileId: 'file-1', page: 2, xMm: 12.3, yMm: 8, sizeMm: 24, pageWidthMm: 210, pageHeightMm: 297 })
    expect(placeBodyOf({ fileId: 'file-1', page: 1, place: { xMm: 10, yMm: 10, sizeMm: 25 }, pageMm: A4, saved: { version: 2 } }).version).toBe(2)
    // A square off the page is never sent: the body is clamped.
    expect(placeBodyOf({ fileId: 'file-1', page: 1, place: { xMm: 205, yMm: 0, sizeMm: 10 }, pageMm: A4, saved: null })).toMatchObject({ xMm: 190, sizeMm: 20 })
  })

  it('the saved place of a page; it starts there, else at the usual place; a save puts its row in place', () => {
    const rows = [row(1), row(2, { xMm: 50 })]
    expect(savedOf(rows, 'line-1', 'file-1', 2)?.xMm).toBe(50)
    expect(savedOf(rows, 'line-1', 'file-2', 1)).toBeNull()
    expect(startPlaceOf(row(1), A4)).toEqual({ xMm: 10, yMm: 10, sizeMm: 25 })
    expect(startPlaceOf(null, A4)).toEqual({ xMm: 180, yMm: 10, sizeMm: 20 })
    expect(withSaved(rows, row(2, { xMm: 60, version: 3 })).map((entry) => [entry.page, entry.xMm])).toEqual([[1, 10], [2, 60]])
  })

  it('"Save the place" waits: the right, the page still drawing, nothing moved since it was saved, a run', () => {
    const place = { xMm: 10, yMm: 10, sizeMm: 25 }
    expect(saveHeldOf({ may: false, drawn: true, place, saved: null, busy: false })).toEqual({ key: 'place.held.noRight' })
    expect(saveHeldOf({ may: true, drawn: false, place, saved: null, busy: false })).toEqual({ key: 'place.held.drawing' })
    expect(saveHeldOf({ may: true, drawn: true, place, saved: row(1), busy: false })).toEqual({ key: 'place.held.unchanged' })
    expect(saveHeldOf({ may: true, drawn: true, place: { ...place, xMm: 11 }, saved: row(1), busy: false })).toBeNull()
    expect(saveHeldOf({ may: true, drawn: true, place, saved: null, busy: true })).toEqual({ key: 'held.busy' })
    // Never placed: the usual place may be saved as it is (a person chose it).
    expect(saveHeldOf({ may: true, drawn: true, place: usualPlaceOf(A4), saved: null, busy: false })).toBeNull()
  })

  it('a PDF is told by its first bytes', () => {
    expect(isPdfBytes(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe(true)
    expect(isPdfBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false)
    expect(isPdfBytes(new Uint8Array([0x25]))).toBe(false)
  })
})

describe('"Print this page again…": only that page ticked', () => {
  const pieces: PrintPreview['pages'] = [
    { salesOrderLineId: 'line-1', label: 'Race suit', fileId: 'file-1', pageCount: null, placed: true },
    { salesOrderLineId: 'line-2', label: 'Gloves', fileId: 'file-2', pageCount: null, placed: false },
  ]
  it('the page asked for joins the pages offered when the preview did not count it; only it is ticked, no card', () => {
    const pages = againPagesWith(againPagesOf(pieces), pieces, { salesOrderLineId: 'line-1', page: 2 })
    expect(pages.map((page) => page.key)).toEqual(['line-1:1', 'line-1:2', 'line-2:1'])
    const form = againFormOnlyOf(pages, { salesOrderLineId: 'line-1', page: 2 })
    expect([...form.pages]).toEqual(['line-1:2'])
    expect(form.cards.size).toBe(0)
    expect(form.reason).toBeNull()
    expect(againPagesWith(againPagesOf(pieces), pieces, null).map((page) => page.key)).toEqual(['line-1:1', 'line-2:1'])
    expect([...againFormOnlyOf(pages, { salesOrderLineId: 'line-9', page: 1 }).pages]).toEqual([])
  })
})

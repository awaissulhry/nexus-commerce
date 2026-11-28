import { MIN_CODE_MM, USUAL_PLACE } from '@nexus/factory-domain/production/print-start/placement'

/**
 * owb-ss4b step 4.4 (design plan § 5f "Place the code": drag, pull the corner, a slider in mm, six quick places, never under 20 mm, it
 * stays on the page; § 5zj B "Print this page again…"; settle L8; server owb-ss2b) — the window "Place the scan code", pure: a page's
 * size in mm, the code's square kept on the page and never under 20 mm (the drag, the corner, the slider and the keys all stop there, and
 * the line says why), millimetres ↔ pixels of the page drawn on screen, the six quick places, the keys (arrows 1 mm, Shift + arrows
 * 5 mm, + / − the size), and the body of `PUT /production/orders/:orderId/placements/:salesOrderLineId`. The domain's own numbers
 * (factory-domain production/print-start/placement: 20 mm, the usual place top right 10 mm from the edges). The words are `print-start`.
 */

export { MIN_CODE_MM }

/** A PDF point in millimetres (1 pt = 1/72 inch). */
export const PT_TO_MM = 25.4 / 72
/** An A4's longer side: an image file has no size of its own, so its longer side is taken as this. */
export const IMAGE_LONG_SIDE_MM = 297

export interface PageMm {
  readonly widthMm: number
  readonly heightMm: number
}

/** The code's square on the page: its top left corner from the page's top left corner, and its side, in mm. */
export interface Place {
  readonly xMm: number
  readonly yMm: number
  readonly sizeMm: number
}

export interface Said {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** An image's size in mm by its shape: its longer side 297 mm (an A4 upright or across). */
export function pageMmOfImage(widthPx: number, heightPx: number): PageMm {
  const w = Math.max(1, widthPx)
  const h = Math.max(1, heightPx)
  return h >= w ? { widthMm: (IMAGE_LONG_SIDE_MM * w) / h, heightMm: IMAGE_LONG_SIDE_MM } : { widthMm: IMAGE_LONG_SIDE_MM, heightMm: (IMAGE_LONG_SIDE_MM * h) / w }
}

const round1 = (value: number): number => Math.round(value * 10) / 10

/** The biggest code that fits the page (its shorter side). */
export const maxSizeOf = (page: PageMm): number => Math.max(MIN_CODE_MM, Math.min(page.widthMm, page.heightMm))

/** The square kept on the page and never under 20 mm (never over the page's shorter side), to a tenth of a mm. */
export function clampPlace(place: Place, page: PageMm): Place {
  const sizeMm = round1(Math.min(Math.max(MIN_CODE_MM, place.sizeMm), maxSizeOf(page)))
  const xMm = round1(Math.min(Math.max(0, place.xMm), Math.max(0, page.widthMm - sizeMm)))
  const yMm = round1(Math.min(Math.max(0, place.yMm), Math.max(0, page.heightMm - sizeMm)))
  return { xMm, yMm, sizeMm }
}

/** Why an asked place was stopped (null: it was taken as asked): under 20 mm, or off the page. */
export function stoppedWhy(asked: Place, page: PageMm): Said | null {
  if (asked.sizeMm < MIN_CODE_MM) return { key: 'place.why.min', params: { min: MIN_CODE_MM } }
  if (asked.sizeMm > maxSizeOf(page)) return { key: 'place.why.max' }
  if (asked.xMm < 0 || asked.yMm < 0 || asked.xMm + asked.sizeMm > page.widthMm || asked.yMm + asked.sizeMm > page.heightMm) return { key: 'place.why.edge' }
  return null
}

/** The usual place: top right, 20 mm, 10 mm from the edges (where the print puts a code nobody placed). */
export function usualPlaceOf(page: PageMm): Place {
  const size = USUAL_PLACE.sizeMm
  return clampPlace({ xMm: page.widthMm - USUAL_PLACE.marginMm - size, yMm: USUAL_PLACE.marginMm, sizeMm: size }, page)
}

export const QUICK_PLACES = ['TOP_LEFT', 'TOP_MIDDLE', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_MIDDLE', 'BOTTOM_RIGHT'] as const
export type QuickPlace = (typeof QUICK_PLACES)[number]

/** A quick place at the code's size, 10 mm from the edges (the middle: centred). */
export function quickPlaceOf(spot: QuickPlace, sizeMm: number, page: PageMm): Place {
  const margin = USUAL_PLACE.marginMm
  const size = Math.min(Math.max(MIN_CODE_MM, sizeMm), maxSizeOf(page))
  const xMm = spot.endsWith('LEFT') ? margin : spot.endsWith('MIDDLE') ? (page.widthMm - size) / 2 : page.widthMm - margin - size
  const yMm = spot.startsWith('TOP') ? margin : page.heightMm - margin - size
  return clampPlace({ xMm, yMm, sizeMm: size }, page)
}

// ---- millimetres ↔ pixels of the page drawn on screen ----------------------------------------------------------------------------

/** Pixels per millimetre of the page as drawn (its width on screen over its width in mm). */
export const pxPerMmOf = (page: PageMm, drawnWidthPx: number): number => (page.widthMm > 0 ? drawnWidthPx / page.widthMm : 1)
export const mmToPx = (mm: number, pxPerMm: number): number => mm * pxPerMm
export const pxToMm = (px: number, pxPerMm: number): number => (pxPerMm > 0 ? px / pxPerMm : 0)

/** A drag of the square by pixels: moved, kept on the page. */
export function dragged(start: Place, dxPx: number, dyPx: number, pxPerMm: number, page: PageMm): { readonly place: Place; readonly why: Said | null } {
  const asked = { ...start, xMm: start.xMm + pxToMm(dxPx, pxPerMm), yMm: start.yMm + pxToMm(dyPx, pxPerMm) }
  return { place: clampPlace(asked, page), why: stoppedWhy(asked, page) }
}

/** A pull of the square's corner by pixels: bigger or smaller (the larger of the two moves), the top left corner stays. */
export function resized(start: Place, dxPx: number, dyPx: number, pxPerMm: number, page: PageMm): { readonly place: Place; readonly why: Said | null } {
  const grow = pxToMm(Math.abs(dxPx) >= Math.abs(dyPx) ? dxPx : dyPx, pxPerMm)
  return sized(start, start.sizeMm + grow, page)
}

/** A new size (the slider, + / −): the top left corner stays while it fits, else the square moves back onto the page. */
export function sized(start: Place, sizeMm: number, page: PageMm): { readonly place: Place; readonly why: Said | null } {
  const asked = { ...start, sizeMm }
  const why = sizeMm < MIN_CODE_MM ? stoppedWhy(asked, page) : sizeMm > maxSizeOf(page) ? { key: 'place.why.max' } : null
  return { place: clampPlace(asked, page), why }
}

// ---- the keys -----------------------------------------------------------------------------------------------------------------------

export type PlaceKey = { readonly kind: 'move'; readonly dxMm: number; readonly dyMm: number } | { readonly kind: 'size'; readonly dMm: number }

/** Arrows move 1 mm (Shift: 5 mm); + / − change the size by 1 mm (Shift: 5 mm). Any other key: null. */
export function placeKeyOf(event: { readonly key: string; readonly shiftKey: boolean; readonly metaKey?: boolean; readonly ctrlKey?: boolean; readonly altKey?: boolean }): PlaceKey | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  const step = event.shiftKey ? 5 : 1
  switch (event.key) {
    case 'ArrowLeft':
      return { kind: 'move', dxMm: -step, dyMm: 0 }
    case 'ArrowRight':
      return { kind: 'move', dxMm: step, dyMm: 0 }
    case 'ArrowUp':
      return { kind: 'move', dxMm: 0, dyMm: -step }
    case 'ArrowDown':
      return { kind: 'move', dxMm: 0, dyMm: step }
    case '+':
    case '=':
      return { kind: 'size', dMm: step }
    case '-':
    case '_':
      return { kind: 'size', dMm: -step }
    default:
      return null
  }
}

/** A key applied to the square. */
export function keyed(start: Place, key: PlaceKey, page: PageMm): { readonly place: Place; readonly why: Said | null } {
  if (key.kind === 'size') return sized(start, start.sizeMm + key.dMm, page)
  const asked = { ...start, xMm: start.xMm + key.dxMm, yMm: start.yMm + key.dyMm }
  return { place: clampPlace(asked, page), why: stoppedWhy(asked, page) }
}

/** A PDF starts with "%PDF" (the preview names no content type: the file's first bytes say it). */
export const isPdfBytes = (bytes: Uint8Array): boolean => bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46

/** The saved places with one row put in its place (one row per line, file and page). */
export const withSaved = <T extends Pick<SavedPlace, 'salesOrderLineId' | 'fileId' | 'page'>>(rows: readonly T[], row: T): T[] => [...rows.filter((entry) => !(entry.salesOrderLineId === row.salesOrderLineId && entry.fileId === row.fileId && entry.page === row.page)), row]

// ---- the saved places and the save ---------------------------------------------------------------------------------------------

export interface SavedPlace extends Place {
  readonly salesOrderLineId: string
  readonly fileId: string
  readonly page: number
  readonly version: number
  readonly placedAt: string
  readonly placedBy: { readonly name: string }
}

/** The saved place of one page of a line's file (one row per line, file and page), or null. */
export const savedOf = (placements: readonly SavedPlace[], salesOrderLineId: string, fileId: string, page: number): SavedPlace | null =>
  placements.find((row) => row.salesOrderLineId === salesOrderLineId && row.fileId === fileId && row.page === page) ?? null

/** Where the window starts: the saved place, else the usual place. */
export const startPlaceOf = (saved: Place | null, page: PageMm): Place => (saved ? clampPlace(saved, page) : usualPlaceOf(page))

/** Two places alike to a tenth of a mm. */
export const samePlace = (a: Place, b: Place): boolean => round1(a.xMm) === round1(b.xMm) && round1(a.yMm) === round1(b.yMm) && round1(a.sizeMm) === round1(b.sizeMm)

const mm2 = (value: number): number => Math.round(value * 100) / 100

/** The PUT body: the file, the page, the square and the page's sides (mm, 2 decimals), and the saved place's version (a move). */
export function placeBodyOf(input: { readonly fileId: string; readonly page: number; readonly place: Place; readonly pageMm: PageMm; readonly saved: Pick<SavedPlace, 'version'> | null }): { fileId: string; page: number; xMm: number; yMm: number; sizeMm: number; pageWidthMm: number; pageHeightMm: number; version?: number } {
  const place = clampPlace(input.place, input.pageMm)
  return {
    fileId: input.fileId,
    page: input.page,
    xMm: mm2(place.xMm),
    yMm: mm2(place.yMm),
    sizeMm: mm2(place.sizeMm),
    pageWidthMm: mm2(input.pageMm.widthMm),
    pageHeightMm: mm2(input.pageMm.heightMm),
    ...(input.saved ? { version: input.saved.version } : {}),
  }
}

/** Why "Save the place" waits (null: it may go): the right, the page still drawing, nothing moved since it was saved, a run. */
export function saveHeldOf(input: { readonly may: boolean; readonly drawn: boolean; readonly place: Place | null; readonly saved: Place | null; readonly busy: boolean }): Said | null {
  if (!input.may) return { key: 'place.held.noRight' }
  if (!input.drawn || !input.place) return { key: 'place.held.drawing' }
  if (input.saved && samePlace(input.place, input.saved)) return { key: 'place.held.unchanged' }
  if (input.busy) return { key: 'held.busy' }
  return null
}

/** The place in words: "12 mm from the left · 8 mm from the top · 20 mm". */
export const placeWordsOf = (place: Place): Said => ({ key: 'place.at', params: { x: Math.round(place.xMm), y: Math.round(place.yMm), size: Math.round(place.sizeMm) } })

import type { Issue } from '../../core/errors'

/**
 * Where the scan code sits on a design page (owb- order workflow, S3 ss2b; settle L8; design plan § 5f "Place the scan code"; factory-db
 * ScanCodePlacement, wave owb-ssw). The office (production.print.start) or the Factory designer ON the order places the work order's QR
 * on a page of the line's design file: a square of at least 20 mm (the floor's cameras read it), wholly inside the page, its top left
 * corner measured from the page's top left corner, in millimetres. One place per line, file and page; left unplaced, the print puts it
 * at the usual place (top right, 20 mm). Pure: apps/factory-api modules/production/prints/placements.ts reads and writes the rows.
 */

/** The smallest code the floor's cameras read, in millimetres. */
export const MIN_CODE_MM = 20
/** The largest page side taken (an A0 is 1189 mm), in millimetres. */
export const MAX_PAGE_MM = 2000
/** The usual place when none is saved: top right, 20 mm, 10 mm from the edges. */
export const USUAL_PLACE = Object.freeze({ corner: 'TOP_RIGHT' as const, sizeMm: MIN_CODE_MM, marginMm: 10 })

export interface PlacementAsk {
  readonly page: number
  readonly xMm: number
  readonly yMm: number
  readonly sizeMm: number
  readonly pageWidthMm: number
  readonly pageHeightMm: number
}

const finite = (value: number): boolean => Number.isFinite(value)

/** Why the place is refused, field by field (empty: it may be saved). */
export function placementProblems(ask: PlacementAsk): Issue[] {
  const problems: Issue[] = []
  if (!Number.isSafeInteger(ask.page) || ask.page < 1) problems.push({ path: 'body/page', message: 'A page is a number from 1.' })
  for (const [field, value] of [['pageWidthMm', ask.pageWidthMm], ['pageHeightMm', ask.pageHeightMm]] as const) {
    if (!finite(value) || value <= 0 || value > MAX_PAGE_MM) problems.push({ path: `body/${field}`, message: `A page side is above 0 and at most ${MAX_PAGE_MM} mm.` })
  }
  if (!finite(ask.sizeMm) || ask.sizeMm < MIN_CODE_MM) problems.push({ path: 'body/sizeMm', message: `The code is at least ${MIN_CODE_MM} mm: smaller, the floor's cameras do not read it.` })
  if (!finite(ask.xMm) || ask.xMm < 0) problems.push({ path: 'body/xMm', message: 'The code starts inside the page (0 mm or more from the left edge).' })
  if (!finite(ask.yMm) || ask.yMm < 0) problems.push({ path: 'body/yMm', message: 'The code starts inside the page (0 mm or more from the top edge).' })
  if (problems.length > 0) return problems
  if (ask.xMm + ask.sizeMm > ask.pageWidthMm) problems.push({ path: 'body/xMm', message: 'The code runs off the right edge of the page: move it left or make it smaller.' })
  if (ask.yMm + ask.sizeMm > ask.pageHeightMm) problems.push({ path: 'body/yMm', message: 'The code runs off the bottom edge of the page: move it up or make it smaller.' })
  return problems
}

/** Millimetres as the row keeps them (2 decimals). */
export const mmOf = (value: number): string => (Math.round(value * 100) / 100).toFixed(2)

/** How many of an order's design pages carry a place ("0 of 3 placed": never a stop). */
export function placedCount(pages: readonly { readonly placed: boolean }[]): { done: number; of: number } {
  return { done: pages.filter((page) => page.placed).length, of: pages.length }
}

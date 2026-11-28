import type { PictureView, StylePicturesView } from '@nexus/factory-domain/product/images/contracts'
import type { ProductView, RouteSummaryStep, StyleOrderLine, StyleView } from '../api'
import { departmentToneOf, type Department } from '../../../../lib/department/model'
import { pictureSrc, ordered } from './gallery/gallery-model'
import type { Grains, StyleAbilities } from '../model'

/**
 * owb-pd4 (steps 4.2–4.4; design § 5q, § 5r, prototype prod.js prodBand / prodBody / prodSizesTab) — the product page's own rules,
 * pure: the band's picture and "made for", the Product sheet's address, which Overview sections a person gets, "How it is made" as
 * departments (never a minute), Where it is used, the riders' measurement sheets and How to measure. The views draw these; the tests
 * hold them.
 */

// ---- the band (step 4.2) --------------------------------------------------------------------------------------------------------

/** The design pictures: the main one first, then the next in the gallery's order (front and back); only pictures with an address. */
export function mainPicturesOf(view: StylePicturesView | null | undefined, count = 2): PictureView[] {
  if (!view) return []
  const all = ordered(view).filter((picture) => picture.look !== null)
  const main = all.find((picture) => picture.isMain) ?? all[0]
  if (!main) return []
  return [main, ...all.filter((picture) => picture.id !== main.id)].slice(0, count)
}

/** The band's picture: the main design picture's address, or null (the band then draws none). */
export const bandPictureOf = (view: StylePicturesView | null | undefined): string | null => {
  const main = mainPicturesOf(view, 1)[0]
  return main ? pictureSrc(main) : null
}

/** "Made for ⟨customer⟩" / "Our range" — the band's and the facts' family words. */
export const madeForOf = (style: Pick<StyleView, 'brand'>): { key: string; params?: Record<string, string> } =>
  style.brand ? { key: 'family.madeFor', params: { customer: style.brand.name } } : { key: 'family.ourRange' }

/** The Product sheet: the product page itself for paper (`sheet=1`), in the Office's print view (`print=1`), in a new tab. */
export function sheetHref(prefix: string, styleId: string, revisionId: string | null): string {
  const terms = new URLSearchParams({ sheet: '1', print: '1' })
  if (revisionId) terms.set('rev', revisionId)
  return `${prefix}/products/styles/${encodeURIComponent(styleId)}?${terms.toString()}`
}

/** The address asks for the Product sheet. */
export const isSheet = (search: { get(name: string): string | null } | null | undefined): boolean => search?.get('sheet') === '1'

// ---- the Overview (step 4.3) ----------------------------------------------------------------------------------------------------

/** The Overview's sections in the design's order (answer line first, "Variants and markets" closed at the bottom). */
export type OverviewSection = 'design' | 'facts' | 'sizes' | 'release' | 'prices' | 'made' | 'used' | 'variants'

/**
 * Which sections a person gets (design § 5q "Who"): Agreed prices only with the price grain; How it is made for every office
 * reader (department names, never minutes); Where it is used with an orders read (orders.view or the designer's own orders);
 * Variants and markets for every reader (its own parts ask their rights).
 */
export function overviewSectionsFor(can: Pick<StyleAbilities, 'view'>, grains: Pick<Grains, 'price'>, reads: { orders: boolean }): OverviewSection[] {
  if (!can.view) return []
  return ['design', 'facts', 'sizes', 'release', ...(grains.price ? (['prices'] as const) : []), 'made', ...(reads.orders ? (['used'] as const) : []), 'variants']
}

/** "How it is made": the route's steps as department chips, in order. A summary step carries no minutes (the API sends none). */
export function howItIsMadeOf(summary: readonly RouteSummaryStep[] | null | undefined): Department[] {
  return (summary ?? []).map((step) => ({ no: step.number, tone: departmentToneOf(step.tone), icon: step.icon, name: step.shortName, shortName: step.shortName, id: step.departmentId }))
}

/** The route summary as the product page reads it: absent (an API before pd1) or empty → null, "no route yet". */
export const routeSummaryOf = (style: Pick<ProductView, 'routeSummary'> | null): RouteSummaryStep[] | null => (style?.routeSummary && style.routeSummary.length > 0 ? style.routeSummary : null)

/** Where it is used: one row per open order (its lines summed), newest number first; the pieces of all its lines with this product. */
export interface UsedRow {
  orderId: string
  orderNumber: string
  customer: string | null
  pieces: number
  life: StyleOrderLine['life']
}
export function whereUsedOf(lines: readonly StyleOrderLine[]): UsedRow[] {
  const byOrder = new Map<string, UsedRow>()
  for (const line of lines) {
    const row = byOrder.get(line.orderId)
    if (row) row.pieces += line.quantity
    else byOrder.set(line.orderId, { orderId: line.orderId, orderNumber: line.orderNumber, customer: line.customer?.name ?? null, pieces: line.quantity, life: line.life })
  }
  return [...byOrder.values()].sort((a, b) => b.orderNumber.localeCompare(a.orderNumber))
}

// ---- the Sizes tab (step 4.4) ---------------------------------------------------------------------------------------------------

/** A rider's measurement sheet of a made-to-measure order line: here as a file, typed, or not here yet. */
export interface RiderRow {
  orderId: string
  orderNumber: string
  lineId: string
  customer: string | null
  state: 'FILE' | 'TYPED' | 'MISSING'
}
/** The riders' sheets: one row per open order line that is made to measure (the API marks only those), the missing ones first. */
export function ridersOf(lines: readonly StyleOrderLine[]): RiderRow[] {
  const rank = { MISSING: 0, TYPED: 1, FILE: 2 } as const
  return lines
    .filter((line): line is StyleOrderLine & { measurement: 'FILE' | 'TYPED' | 'MISSING' } => line.measurement !== null)
    .map((line) => ({ orderId: line.orderId, orderNumber: line.orderNumber, lineId: line.lineId, customer: line.customer?.name ?? null, state: line.measurement }))
    .sort((a, b) => rank[a.state] - rank[b.state] || a.orderNumber.localeCompare(b.orderNumber))
}

/** How to measure: one plain sentence per point (the point's how-to text in the page's language), in the spec's order. */
export interface HowToRow {
  code: string
  name: string
  text: string | null
}
export function howToOf(points: ReadonlyArray<{ code: string; name: string; nameI18n: Record<string, string> | null; howTo: string | null; seq: number; status: string }>, locale: 'it' | 'en'): HowToRow[] {
  return [...points]
    .filter((point) => point.status !== 'ARCHIVED')
    .sort((a, b) => a.seq - b.seq)
    .map((point) => ({ code: point.code, name: point.nameI18n?.[locale]?.trim() || point.name, text: point.howTo?.trim() || null }))
}

/** The Sizes section's answer: "S to XXL. The base size is L.", "Made to measure.", or none chosen yet (a key and its params). */
export function sizesAnswerOf(style: Pick<StyleView, 'sizes' | 'baseSize' | 'mtmAllowed'>): { key: string; params?: Record<string, string> } {
  if (style.sizes.length === 0) return style.mtmAllowed ? { key: 'sizes.answer.mtm' } : { key: 'sizes.answer.none' }
  const range = { from: style.sizes[0]!, to: style.sizes[style.sizes.length - 1]! }
  if (!style.baseSize) return { key: style.mtmAllowed ? 'sizes.answer.rangeMtmNoBase' : 'sizes.answer.rangeNoBase', params: range }
  return { key: style.mtmAllowed ? 'sizes.answer.rangeMtm' : 'sizes.answer.range', params: { ...range, base: style.baseSize } }
}

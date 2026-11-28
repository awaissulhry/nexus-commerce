import type { Locale } from '../../../../lib/i18n/locales'
import type { StyleDetail } from '../api'
import { sizeMatrix, styleName } from '../model'
import { storeUrl } from '../../../../record-panels/store'
import type { PortalOrderRow, PortalProductSizes } from './api'

/**
 * owb-pd4 step 4.5 (design § 5q "Customer", § 5r "Customer"; gap G9; prototype prod.js prodTabs / prodBody / prodSizesTab, door
 * portal) — the customer's product page, pure: two tabs, Overview (facts, Your price — only with the price grain —, Your orders with
 * it, Ask for a change) and Sizes (the range and its base size, the sizes each colour offers; nothing to type). Built only from the
 * customer's own reads: the catalogue's style read (its own designs and the range priced for it — another customer's product
 * answers 404) and its own orders. Never a cost, a revision, a route or the factory's product code.
 */

export type ProductTab = 'overview' | 'sizes'
export const PRODUCT_TABS: readonly ProductTab[] = ['overview', 'sizes']
export const productTabOf = (value: string | null | undefined): ProductTab => (value === 'sizes' ? 'sizes' : 'overview')

/** `/p/<party>/catalogue/<styleId>` (the Overview) or `?tab=sizes`. */
export const productHref = (prefix: string, styleId: string, tab: ProductTab = 'overview'): string => `${prefix}/catalogue/${encodeURIComponent(styleId)}${tab === 'sizes' ? '?tab=sizes' : ''}`

export interface PortalProductPage {
  name: string
  /** Their own design (private label) or the factory's range priced for them. */
  family: 'OWN' | 'RANGE'
  type: string
  season: string | null
  description: string | null
  ppe: StyleDetail['style']['ppe']
  sizes: { range: string; base: string | null; matrix: ReturnType<typeof sizeMatrix> }
  /** Your price per colour (decimal strings) — only for a person with the price grain; null otherwise (never a 0). */
  price: { currency: string; from: string | null; byColour: Array<{ colour: string; price: string | null }> } | null
  /** Your orders with it; null: not read (no orders right). */
  orders: Array<{ id: string; href: string; label: string; state: string; pieces: number; on: string | null }> | null
  // ---- owb-pd5 (step 5.0; pd4s s.3): the product's own Sizes read (its newest released revision) ----
  /** The main picture's address; null: none, or the read not answered. */
  picture: string | null
  /** The size table, how to measure and the protectors; null: the read failed or is not there yet (the page says so). */
  measures: PortalMeasures | null
}

export interface PortalMeasures {
  mode: 'SIZES' | 'MADE_TO_MEASURE'
  sizes: string[]
  base: string | null
  /** One row per point: its values in mm, in the sizes' order (null: no value for that size). */
  rows: Array<{ code: string; name: string; values: Array<number | null> }>
  howTo: Array<{ code: string; name: string; text: string }>
  protectors: Array<{ zone: string; level: 'LEVEL_2' | 'LEVEL_1' | 'NONE' }>
}

/** The Sizes read as the page draws it: the table in the sizes' order, only the points that say how to measure, the protectors. */
export function measuresOf(read: PortalProductSizes): PortalMeasures {
  return {
    mode: read.mode,
    sizes: read.sizes,
    base: read.baseSize,
    rows: read.points.map((point) => ({ code: point.code, name: point.name, values: read.sizes.map((size) => point.values[size] ?? null) })),
    howTo: read.points.flatMap((point) => (point.howTo?.trim() ? [{ code: point.code, name: point.name, text: point.howTo.trim() }] : [])),
    protectors: read.protectors,
  }
}

/** The picture's address through this app (the API's own path); null: none, or an address this app does not show. */
export function pictureOf(read: PortalProductSizes | null): string | null {
  if (!read?.picture) return null
  if (read.picture.url.startsWith('data:image/')) return read.picture.url
  try {
    return storeUrl(read.picture.url)
  } catch {
    return null
  }
}

/** The order's own words in the customer's language: its number ("Your order 12"), else its PO, else the request's subject. */
function orderLabel(row: PortalOrderRow, locale: Locale): string {
  return row.yourNumber?.words[locale] ?? row.customerRef ?? row.subject ?? '—'
}

export function portalProductOf(detail: StyleDetail, orders: readonly PortalOrderRow[] | null, prefix: string, locale: Locale, sizes: PortalProductSizes | null = null): PortalProductPage {
  const style = detail.style
  return {
    name: styleName(style, locale),
    family: style.ownLabel ? 'OWN' : 'RANGE',
    type: style.productType,
    season: style.season,
    description: style.description,
    ppe: style.ppe,
    sizes: { range: style.range, base: style.baseSize, matrix: sizeMatrix(style) },
    price: detail.seesPrices
      ? { currency: detail.currency, from: style.priceFrom ?? null, byColour: style.colourways.map((colourway) => ({ colour: `${colourway.name} (${colourway.code})`, price: colourway.price ?? null })) }
      : null,
    orders:
      orders === null
        ? null
        : orders.map((row) => ({
            id: row.id,
            href: row.kind === 'ORDER' ? `${prefix}/orders/${encodeURIComponent(row.id)}` : `${prefix}/orders/requests/${encodeURIComponent(row.id)}`,
            label: orderLabel(row, locale),
            state: row.words[locale],
            pieces: row.pieces.ordered,
            on: row.orderedOn,
          })),
    picture: pictureOf(sizes),
    measures: sizes ? measuresOf(sizes) : null,
  }
}

/** What the page shows for a read that failed: another customer's product, or one gone, is "not in your catalogue" — never its data. */
export const readStateOf = (error: { kind?: string } | null): 'missing' | 'error' => (error?.kind === 'not_found' || error?.kind === 'forbidden' ? 'missing' : 'error')

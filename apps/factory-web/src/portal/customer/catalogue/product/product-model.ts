import type { Locale } from '../../../../lib/i18n/locales'
import type { StyleDetail } from '../api'
import { sizeMatrix, styleName } from '../model'
import type { PortalOrderRow } from './api'

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
}

/** The order's own words in the customer's language: its number ("Your order 12"), else its PO, else the request's subject. */
function orderLabel(row: PortalOrderRow, locale: Locale): string {
  return row.yourNumber?.words[locale] ?? row.customerRef ?? row.subject ?? '—'
}

export function portalProductOf(detail: StyleDetail, orders: readonly PortalOrderRow[] | null, prefix: string, locale: Locale): PortalProductPage {
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
  }
}

/** What the page shows for a read that failed: another customer's product, or one gone, is "not in your catalogue" — never its data. */
export const readStateOf = (error: { kind?: string } | null): 'missing' | 'error' => (error?.kind === 'not_found' || error?.kind === 'forbidden' ? 'missing' : 'error')

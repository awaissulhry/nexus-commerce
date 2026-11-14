/**
 * Shipment search (B-W2b-386; LOG-120 "search by order, tracking number, SSCC, customer PO or serial, and the history
 * export"; design warehouse.shipments sh-grid "search by order, tracking number, SSCC, customer PO or serial (W2b)"), pure.
 * One box: what was typed is looked up as a shipment number, an order number, the customer's PO, the customer, a tracking
 * number (a carrier label's or one typed by hand), a carton's marks code (`<shipment number>-<n>`, B-W2b-384) and a garment
 * serial. Each hit says what it matched by. An SSCC is not kept yet (pallet and carton SSCCs come with LOG-021/022): a
 * search that looks like one says so instead of finding nothing silently.
 */

export const SEARCH_MATCHES = ['NUMBER', 'ORDER', 'CUSTOMER_PO', 'CUSTOMER', 'TRACKING', 'CARTON', 'SERIAL'] as const
export type SearchMatch = (typeof SEARCH_MATCHES)[number]

export const SEARCH_LIMITS = Object.freeze({ min: 2, max: 80 })

/** What the box holds, cleaned: one line, trimmed, at most 80 characters (null: too short to search). */
export function searchTerm(value: string | null | undefined): string | null {
  const text = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, SEARCH_LIMITS.max)
  return text.length >= SEARCH_LIMITS.min ? text : null
}

const CARTON = /^(.+)-(\d{1,4})$/
/** An SSCC (GS1): 18 digits, written with its application identifier (00) or without. */
const SSCC = /^(?:\(?00\)?)?\s?(\d{18})$/

/** A carton's marks code split into its shipment number and carton number (null: not shaped like one). */
export function cartonCodeOf(term: string): { readonly shipmentNumber: string; readonly cartonNumber: number } | null {
  const match = CARTON.exec(term)
  if (!match) return null
  const cartonNumber = Number(match[2])
  return cartonNumber >= 1 ? { shipmentNumber: match[1]!, cartonNumber } : null
}

/** The term looks like an SSCC (which is not kept yet). */
export const looksLikeSscc = (term: string): boolean => SSCC.test(term.replace(/\s+/g, ''))

/** The order the matches are listed in (the most exact first). */
export const matchRank = (match: SearchMatch): number => ['NUMBER', 'CARTON', 'SERIAL', 'TRACKING', 'ORDER', 'CUSTOMER_PO', 'CUSTOMER'].indexOf(match)

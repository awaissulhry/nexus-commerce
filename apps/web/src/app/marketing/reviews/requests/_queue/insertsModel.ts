/**
 * Reviews › Requests › Package inserts — the card maths and the held reasons. The PDF (`POST /api/review-inserts/bulk`)
 * has one A6 page per product with an ASIN: the card's honest-review text in the market's language and a QR code to
 * Amazon's own "write a review" page for that ASIN. More copies of each card = the PDF printed that many times; four A6
 * pages go on one A4 sheet. Pure; tested in insertsModel.vitest.test.ts.
 */

/** The markets a card can be made for: the QR code's Amazon site and the card's language. */
export const INSERT_MARKETS = [
  { code: 'IT', label: 'Italy', site: 'amazon.it', language: 'Italian' },
  { code: 'DE', label: 'Germany', site: 'amazon.de', language: 'German' },
  { code: 'FR', label: 'France', site: 'amazon.fr', language: 'French' },
  { code: 'ES', label: 'Spain', site: 'amazon.es', language: 'Spanish' },
  { code: 'UK', label: 'United Kingdom', site: 'amazon.co.uk', language: 'English' },
] as const

export type InsertMarket = (typeof INSERT_MARKETS)[number]['code']

export const CARDS_PER_SHEET = 4
export const MAX_COPIES = 50
/** The PDF holds at most this many products (the API's cap). */
export const MAX_PRODUCTS = 500

export function insertMarket(code: string): (typeof INSERT_MARKETS)[number] {
  return INSERT_MARKETS.find((m) => m.code === code) ?? INSERT_MARKETS[0]
}

/** Where the card's QR code goes, without the scheme: "amazon.it/review/create-review?asin=B0…". */
export function qrTarget(market: string, asin: string | null): string {
  return `${insertMarket(market).site}/review/create-review?asin=${asin ?? '…'}`
}

export interface InsertProduct {
  id: string
  name: string
  sku: string
  amazonAsin: string | null
  /** Variations under it (a family); 0 for a single product. */
  childCount: number
}

export interface CardsPlan {
  /** Products that get a card (with an ASIN). */
  products: number
  cards: number
  sheets: number
  words: string
}

const n = (v: number) => v.toLocaleString('en-IE')

/** "24 cards on 6 A4 sheets — print the PDF 2 times, 4 pages per sheet". */
export function cardsPlan(products: number, copies: number): CardsPlan {
  const c = Math.max(1, Math.min(MAX_COPIES, Math.floor(copies) || 1))
  const p = Math.max(0, Math.min(MAX_PRODUCTS, Math.floor(products)))
  const cards = p * c
  const sheets = Math.ceil(cards / CARDS_PER_SHEET)
  const cardWords = `${n(cards)} ${cards === 1 ? 'card' : 'cards'} on ${n(sheets)} A4 ${sheets === 1 ? 'sheet' : 'sheets'}`
  const how = c === 1 ? `print the PDF at ${CARDS_PER_SHEET} pages per sheet` : `print the PDF ${c} times, ${CARDS_PER_SHEET} pages per sheet`
  return { products: p, cards, sheets, words: `${cardWords} — ${how}` }
}

export interface InsertsPick {
  /** "All product families": every product with an ASIN (the server picks them). */
  all: boolean
  picked: readonly string[]
}

/** How many products get a card: all with an ASIN, or the picked ones that have one. */
export function cardProducts(pick: InsertsPick, products: readonly InsertProduct[], countWithAsin: number | null): number | null {
  if (pick.all) return countWithAsin == null ? null : Math.min(countWithAsin, MAX_PRODUCTS)
  const set = new Set(pick.picked)
  return products.filter((p) => set.has(p.id) && p.amazonAsin).length
}

/** Why Download PDF is held, or null. */
export function downloadHeld(pick: InsertsPick, products: readonly InsertProduct[], countWithAsin: number | null): string | null {
  if (!pick.all && pick.picked.length === 0) return 'Pick at least one product family.'
  const count = cardProducts(pick, products, countWithAsin)
  if (count === 0) {
    return pick.all ? 'No product has an Amazon ASIN yet — there is nothing to print.' : 'None of the picked products has an Amazon ASIN — they get no card.'
  }
  return null
}

/** "12 of 40 picked · 3 without an ASIN get no card". */
export function pickedWords(pick: InsertsPick, products: readonly InsertProduct[], countWithAsin: number | null): string {
  if (pick.all) return countWithAsin == null ? 'Every product with an ASIN' : `Every product with an ASIN (${n(Math.min(countWithAsin, MAX_PRODUCTS))})`
  const set = new Set(pick.picked)
  const picked = products.filter((p) => set.has(p.id))
  const missing = picked.filter((p) => !p.amazonAsin).length
  const head = `${n(picked.length)} of ${n(products.length)} picked`
  return missing ? `${head} · ${n(missing)} without an ASIN ${missing === 1 ? 'gets' : 'get'} no card` : head
}

/** Toggle one product; picking any product leaves "All". */
export function togglePick(pick: InsertsPick, id: string): InsertsPick {
  const picked = pick.picked.includes(id) ? pick.picked.filter((p) => p !== id) : [...pick.picked, id]
  return { all: false, picked }
}

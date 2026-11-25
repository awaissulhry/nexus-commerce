import type { ProductRow } from '../../../../lib/order-draft/model'
import type { ConfirmBody } from './api'

/**
 * The Confirm window (THE SIMPLE ORDER START, od-w2.2; R1; 10-design-r1 § 4), pure: the order needs a style, a colourway and pieces by
 * size per row (and a price where the reader holds the price grain); the window asks for whatever the draft left open — it may be
 * everything. A row with its style, its colour and its own size run is a line as it is (no map); any other row is mapped into ONE
 * style line typed here. A custom-size row makes the draft a QUOTE (today's GATE-MTM rule). "Missing" lives only here.
 */

export interface ConfirmEntry {
  readonly rowId: string
  /** The row is mapped here (it lacks its style, its colour or its own size run). */
  readonly needs: boolean
  readonly styleId: string | null
  readonly colourwayId: string | null
  /** Pieces by size as typed: "48:2 50:3" (or "48 × 2 · 50 × 3"). */
  readonly sizesText: string
  /** The unit price as typed (the price grain only; blank: the list price). */
  readonly unitPrice: string
}

/** What a row is: one that is a line as it is, or one the window maps. */
const readyRow = (row: ProductRow): boolean => row.style !== null && row.colourwayId !== null && row.pieces.mode === 'SIZES' && row.pieces.sizes.length > 0

export function confirmRowsOf(rows: readonly ProductRow[]): ConfirmEntry[] {
  return rows.map((row) => ({
    rowId: row.id,
    needs: !readyRow(row),
    styleId: row.style?.id ?? null,
    colourwayId: row.colourwayId,
    sizesText: row.pieces.mode === 'SIZES' ? row.pieces.sizes.map((entry) => `${entry.size}:${entry.quantity}`).join(' ') : '',
    unitPrice: '',
  }))
}

/** Pieces by size as typed → the body's sizes (a size once, whole pieces above 0); a part that does not read is left out. */
export function sizesOf(text: string): { size: string; quantity: number }[] {
  const out = new Map<string, number>()
  for (const part of text.split(/[\s·,;]+/)) {
    const found = /^([^:×x]+)[:×x](\d+)$/i.exec(part.trim())
    if (!found) continue
    const quantity = Number(found[2])
    if (quantity > 0) out.set(found[1]!.trim(), quantity)
  }
  return [...out].map(([size, quantity]) => ({ size, quantity }))
}

/** od-w2.5: the size grid's cells from the typed run, and back ("48:2 50:3"; empty cells left out). */
export const cellsOf = (text: string): Record<string, number> => Object.fromEntries(sizesOf(text).map((entry) => [entry.size, entry.quantity]))
export const sizesTextOf = (cells: Readonly<Record<string, number>>): string =>
  Object.entries(cells)
    .filter(([, quantity]) => quantity > 0)
    .map(([size, quantity]) => `${size}:${Math.trunc(quantity)}`)
    .join(' ')

/** What a row still needs before the order takes it (the part's `need.*` keys): style, colour, pieces by size. */
export function missingOf(row: ProductRow, entry: ConfirmEntry | undefined): string[] {
  if (!entry) return []
  const out: string[] = []
  if (!entry.styleId) out.push('need.style')
  if (!entry.colourwayId) out.push('need.colour')
  // A row's own size run or its people (every person sized) carry the pieces of ONE line; else they are typed here.
  if (sizesOf(entry.sizesText).length === 0 && row.pieces.mode !== 'PEOPLE') out.push('need.pieces')
  return out
}

/** The window's final button waits while a row still needs something (its words name the first such row). */
export function confirmHeldOf(rows: readonly ProductRow[], entries: Readonly<Record<string, ConfirmEntry>>): { seq: number; needs: string[] } | null {
  if (rows.length === 0) return { seq: 0, needs: [] }
  for (const row of rows) {
    const needs = missingOf(row, entries[row.id])
    if (needs.length > 0) return { seq: row.seq, needs }
  }
  return null
}

/** ORDER, or QUOTE while a row is a custom size (made to measure starts as a quote: GATE-MTM). */
export const confirmAsOf = (rows: readonly ProductRow[]): 'ORDER' | 'QUOTE' => (rows.some((row) => row.sizing === 'MADE_TO_MEASURE') ? 'QUOTE' : 'ORDER')

const priceOf = (typed: string): string | null => {
  const text = typed.replace(/[\s€]/g, '').replace(',', '.')
  return /^\d{1,12}(\.\d{1,6})?$/.test(text) ? text : null
}

/** today's accept body: the rows mapped (their style line), the prices typed (the price grain only), as ORDER or QUOTE. */
export function confirmBodyOf(rows: readonly ProductRow[], entries: Readonly<Record<string, ConfirmEntry>>, seesPrices: boolean): Omit<ConfirmBody, 'version'> {
  const map: NonNullable<ConfirmBody['map']> = []
  const lines: NonNullable<ConfirmBody['lines']> = []
  for (const row of rows) {
    const entry = entries[row.id]
    if (!entry) continue
    const price = seesPrices ? priceOf(entry.unitPrice) : null
    if (!entry.needs) {
      if (price) lines.push({ lineId: row.id, unitPrice: price })
      continue
    }
    if (!entry.styleId || !entry.colourwayId) continue
    const sizes = sizesOf(entry.sizesText)
    map.push({ lineId: row.id, into: [{ styleId: entry.styleId, colourwayId: entry.colourwayId, ...(sizes.length > 0 ? { sizes } : {}), ...(price ? { unitPrice: price } : {}) }] })
  }
  return { as: confirmAsOf(rows), ...(map.length > 0 ? { map } : {}), ...(lines.length > 0 ? { lines } : {}) }
}

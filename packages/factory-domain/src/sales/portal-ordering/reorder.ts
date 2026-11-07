import type { LineFacts, SizeAsk, Words } from './rules'
import { priceShown, samePrice } from './rules'

/**
 * Reorder a past order (B-W2b-190, SAL-072; design portal.customer.neworder reorder "Copy a past order at today's prices
 * with every difference spelled out": "Price now 195.00 (was 189.00)", "Brown is discontinued — choose another colour").
 * A past order's size-grid line is copied into the draft at today's price; every difference from what was ordered is
 * named before anything is added, and again whenever the draft is read (the draft line keeps the order line it came from):
 *
 *   PRICE_CHANGED        today's price is not the price on the order (price grain only)
 *   REVISION_CHANGED     the style is made to a newer released revision than the one on the order
 *   SIZES_DROPPED        sizes on the order the colourway no longer offers: the line keeps the others
 *   COLOUR_DISCONTINUED  the colourway is no longer active: the customer chooses another colour of the style to add it
 *   STYLE_NOT_SOLD       the style is no longer in the customer's catalogue: the line cannot be copied
 *   MADE_TO_MEASURE      a made-to-measure unit is not reordered here (it comes with the rider's measurements, Later)
 *   NO_SIZES_LEFT        none of its sizes is offered any more
 *
 * A line is `addable` when it can go into the draft as it is (perhaps with sizes dropped); one with a discontinued colour
 * is addable once another colour is chosen (`needsColour`).
 */

export const REORDER_NOTICES = ['PRICE_CHANGED', 'REVISION_CHANGED', 'SIZES_DROPPED', 'COLOUR_DISCONTINUED', 'STYLE_NOT_SOLD', 'MADE_TO_MEASURE', 'NO_SIZES_LEFT'] as const
export type ReorderNoticeCode = (typeof REORDER_NOTICES)[number]

export interface ReorderNotice {
  readonly code: ReorderNoticeCode
  readonly words: Words
}

export interface PastLine {
  readonly kind: 'SIZE_GRID' | 'MADE_TO_MEASURE'
  /** The unit price on the order (price grain). */
  readonly unitPrice: string
  /** The revision number the order line was made to (null: none named). */
  readonly revision: number | null
  readonly sizes: readonly SizeAsk[]
}

export interface ReorderFacts extends LineFacts {
  /** The style's RELEASED revision number today (null: none). */
  readonly revisionNow: number | null
}

export interface ReorderPlan {
  readonly addable: boolean
  /** The colourway is discontinued: the line is added once another colour is chosen. */
  readonly needsColour: boolean
  /** The sizes that go into the draft (the order's, less those no longer offered). */
  readonly sizes: readonly SizeAsk[]
  readonly notices: readonly ReorderNotice[]
}

export function reorderPlan(past: PastLine, facts: ReorderFacts | null, seesPrices: boolean): ReorderPlan {
  const notices: ReorderNotice[] = []
  if (past.kind === 'MADE_TO_MEASURE') {
    return { addable: false, needsColour: false, sizes: [], notices: [{ code: 'MADE_TO_MEASURE', words: { it: 'Un capo su misura non si riordina da qui: chiedetecelo.', en: 'A made-to-measure unit is not reordered here: ask us.' } }] }
  }
  if (facts === null || !facts.sold) {
    const code = facts?.styleCode ?? 'This style'
    return { addable: false, needsColour: false, sizes: [], notices: [{ code: 'STYLE_NOT_SOLD', words: { it: `${code} non è più in vendita.`, en: `${code} is no longer sold.` } }] }
  }
  if (seesPrices && facts.priceNow !== null && !samePrice(facts.priceNow, past.unitPrice)) {
    notices.push({ code: 'PRICE_CHANGED', words: { it: `Prezzo ora ${priceShown(facts.priceNow)} (era ${priceShown(past.unitPrice)})`, en: `Price now ${priceShown(facts.priceNow)} (was ${priceShown(past.unitPrice)})` } })
  }
  if (facts.revisionNow !== null && past.revision !== null && facts.revisionNow !== past.revision) {
    notices.push({ code: 'REVISION_CHANGED', words: { it: `Ora prodotto alla revisione ${facts.revisionNow} (era ${past.revision})`, en: `Now made to revision ${facts.revisionNow} (was ${past.revision})` } })
  }
  if (!facts.colourwayActive) {
    notices.push({ code: 'COLOUR_DISCONTINUED', words: { it: `${facts.colourwayName} non è più disponibile: scegliete un altro colore`, en: `${facts.colourwayName} is discontinued: choose another colour` } })
    return { addable: false, needsColour: true, sizes: past.sizes, notices }
  }
  const kept = past.sizes.filter((row) => facts.offered.includes(row.size))
  const dropped = past.sizes.filter((row) => !facts.offered.includes(row.size)).map((row) => row.size)
  if (dropped.length > 0) {
    notices.push({ code: 'SIZES_DROPPED', words: { it: `Taglie non più offerte, lasciate fuori: ${dropped.join(', ')}`, en: `Sizes no longer offered, left out: ${dropped.join(', ')}` } })
  }
  if (kept.length === 0) {
    notices.push({ code: 'NO_SIZES_LEFT', words: { it: 'Nessuna delle sue taglie è ancora offerta.', en: 'None of its sizes is offered any more.' } })
    return { addable: false, needsColour: false, sizes: [], notices }
  }
  return { addable: true, needsColour: false, sizes: kept, notices }
}

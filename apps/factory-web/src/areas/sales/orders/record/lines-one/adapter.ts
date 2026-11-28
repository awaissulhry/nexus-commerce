import type { LineRow, LinesMode } from '../../../../../lib/order-lines'
import type { Order } from '../../api'
import { isFinal, isShippedInFull } from '../../model'

/**
 * owb-of6 step 0 (of5 step 3's text; the seam S1 po3 → S2: "an order host writes its own adapter to LineRow") — a confirmed order's
 * lines as rows of S1's ONE lines table (`lib/order-lines`): one row per line, the style as its model (fixed: a catalogue line keeps its
 * style), the colourway as its material, the sizes in words, the pieces. NEVER a price (the table's money is the host's `prices`, and
 * this host passes none: the Lines tab's read face shows no price to anybody). Pure.
 */
export function orderLineRowsOf(order: Pick<Order, 'lines'>): LineRow[] {
  return [...order.lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line): LineRow => {
      const sized = line.sizes.filter((entry) => entry.size !== null && entry.quantity > 0)
      const run = sized.length > 0 ? sized.map((entry) => `${entry.size} × ${entry.quantity}`).join(' · ') : null
      return {
        id: line.id,
        seq: line.seq,
        model: { kind: 'RANGE', value: `style:${line.styleId}`, words: line.style ? `${line.style.code} ${line.style.name}`.trim() : (line.description ?? null), styleId: line.styleId, garmentType: null, fixed: true },
        material: { how: 'COLOURWAY', words: line.colourway?.name ?? null, value: line.colourwayId, options: line.colourway ? [{ value: line.colourwayId, words: line.colourway.name }] : [], topic: null },
        sizes: { mode: line.kind === 'MADE_TO_MEASURE' ? 'MTM' : run ? 'SIZES' : 'TOTAL', run, people: 0 },
        pieces: { count: line.quantity, typed: false },
        own: {},
        ownVersions: {},
      }
    })
}

/**
 * When the Lines tab draws the ONE table (its read face) instead of today's editor: the order left the factory (shipped, delivered,
 * closed) or was cancelled — "It left the factory. A change now is a return." — or the reader may not change lines (the designer
 * reads and attaches a mockup; a reader). Everyone who may change a confirmed order keeps today's editor (the save bar, Review and
 * save with its ONE tick "Ask the customer to accept the new order").
 */
export function oneTableModeOf(order: Pick<Order, 'status'>, writes: boolean): LinesMode | null {
  if (isShippedInFull(order) || isFinal(order)) return 'shipped'
  return writes ? null : 'confirmed'
}

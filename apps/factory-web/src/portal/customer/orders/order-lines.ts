import type { LineRow, LinesMode, LinePrices } from '../../../lib/order-lines'
import type { OrderRecord } from './api'
import { shownLinesOf } from './model'

/**
 * owb-po6.1 (plan § 5j, design `linesTab`, `lineMay`) — the portal order's lines on the ONE lines table (lib/order-lines, web A's): the
 * order host's own adapter to `LineRow` (the table never holds a price: money is only the host's `prices`, for a price holder), the
 * table's mode by the order's state, and the customer's ASKS after Confirm. Pure.
 *
 *   mode      confirmed (REQUESTED … PARTLY_SHIPPED: typing a line makes an ask, nothing changes before the factory answers) ·
 *             shipped (SHIPPED, DELIVERED, CANCELLED: it reads "It left the factory. A change now is a return.")
 *   asks      the lines' new pieces, kept by the page until "Review and ask…": the ask goes through today's change-request path
 *             (`fa/modules/sales/change-requests`): the Ask window at its change step, the asks written in its note (a material is a note
 *             ask too) — the factory answers yes or no
 *   own       the customer's own columns' values apply at once, also after Confirm (no price, no promise moves): `PUT /portal/own-values`
 */

/** The table's mode for an order's state. */
export function linesModeOf(status: OrderRecord['order']['status']): Extract<LinesMode, 'confirmed' | 'shipped'> {
  return status === 'SHIPPED' || status === 'DELIVERED' || status === 'CANCELLED' ? 'shipped' : 'confirmed'
}

/** A line's size run in words ("50 × 2 · 52 × 3"); one size without a name: none (a total). */
function runOf(sizes: OrderRecord['lines'][number]['sizes']): string | null {
  const named = sizes.filter((size) => size.size !== null && size.ordered > 0)
  return named.length > 0 ? named.map((size) => `${size.size} × ${size.ordered}`).join(' · ') : null
}

/** The order's lines as the table's rows (a charge line is not a row). */
export function orderLineRowsOf(record: Pick<OrderRecord, 'lines'> & { readonly ownColumns?: OrderRecord['ownColumns'] }): LineRow[] {
  const values = record.ownColumns?.values ?? {}
  return shownLinesOf(record.lines).map((line) => {
    const own = values[line.id] ?? {}
    const run = runOf(line.sizes)
    return {
      id: line.id,
      seq: line.seq,
      // A confirmed line keeps its model: a change of model is an ask in words (the Ask window's note).
      model: { kind: line.style ? null : 'TEXT', value: '', words: line.style ? line.style.name.trim() || line.style.code : line.description, styleId: null, garmentType: null, fixed: true },
      material: { how: 'NONE', words: line.colourway?.name ?? null, value: '', options: [], topic: null },
      sizes: { mode: line.measurement ? 'MTM' : run ? 'SIZES' : 'TOTAL', run, people: 0 },
      pieces: { count: line.quantity, typed: true },
      own: Object.fromEntries(Object.entries(own).map(([columnId, value]) => [columnId, value.value])),
      ownVersions: Object.fromEntries(Object.entries(own).map(([columnId, value]) => [columnId, value.version])),
    }
  })
}

/** The Your price column for a price holder (our unit price as "agreed"; the customer's own is the Money tab's price check); else null. */
export function orderLinePricesOf(record: Pick<OrderRecord, 'lines' | 'seesPrices' | 'order'>): LinePrices | null {
  if (!record.seesPrices) return null
  return { currency: record.order.currency, edit: false, byLine: Object.fromEntries(shownLinesOf(record.lines).map((line) => [line.id, { list: line.unitPrice ?? null, own: null }])) }
}

/** The asks typed and not sent yet: line id → the pieces asked; `order` keeps the typing order (Undo takes the last one back). */
export interface LineAsks {
  readonly pieces: Readonly<Record<string, number>>
  readonly order: readonly string[]
}
export const NO_ASKS: LineAsks = { pieces: {}, order: [] }

/** A typed value on a confirmed line: a number of pieces (a whole number ≥ 0) becomes an ask; the line's own number takes it away. */
export function askTyped(asks: LineAsks, rows: readonly Pick<LineRow, 'id' | 'pieces'>[], rowId: string, text: string): LineAsks {
  const value = Number(text)
  if (!Number.isInteger(value) || value < 0) return asks
  const row = rows.find((entry) => entry.id === rowId)
  const { [rowId]: _was, ...rest } = asks.pieces
  const order = asks.order.filter((id) => id !== rowId)
  if (!row || row.pieces.count === value) return { pieces: rest, order }
  return { pieces: { ...rest, [rowId]: value }, order: [...order, rowId] }
}

/** Undo the last typed ask. */
export function undoAsk(asks: LineAsks): LineAsks {
  const last = asks.order[asks.order.length - 1]
  if (!last) return asks
  const { [last]: _gone, ...pieces } = asks.pieces
  return { pieces, order: asks.order.slice(0, -1) }
}

/** The asks in the note of the Ask window, one line each ("Line 2: 12 pieces (now 10)"), in the reader's words. */
export function askNoteOf(asks: LineAsks, rows: readonly Pick<LineRow, 'id' | 'seq' | 'pieces'>[], line: (input: { seq: number; pieces: number; now: number }) => string): string {
  return asks.order
    .flatMap((id) => {
      const row = rows.find((entry) => entry.id === id)
      const pieces = asks.pieces[id]
      return row && pieces !== undefined ? [line({ seq: row.seq, pieces, now: row.pieces.count ?? 0 })] : []
    })
    .join('\n')
}

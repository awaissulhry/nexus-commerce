import type { Words } from '../../approvals/rules'
import type { Issue } from '../../core/errors'
import { Dec, type Decimal } from '../../tax/decimal'

/**
 * Customer-owned materials on the order (B-W2b-309; SAL-306; design order.lines.owned "Customer-supplied materials":
 * Material · Colour · Expected · Received · Used · Left; follow-up SO2:01), pure. A brand sends us leather, trims or labels
 * for its own orders (a BOM line customer-supplied by the order's party, B-W2b-228). Per order line and such BOM line one
 * CustomerMaterial row (factory-db, B-W2b-281):
 *
 *   expected   from the explosion per size: the line's pieces of each size × what one garment of that size takes of the
 *              material (B-W2b-223's multi-level walk, its gross quantity in the material's base unit), rounded once per size
 *              to 4 decimals; the whole is the sum of the sizes (the database checks they add up)
 *   received   the customer's own stock: lots it sent with a CUSTOMER_SUPPLIED goods receipt (Lot.ownerPartyId = the
 *              customer), never valued, bought or used for another customer's order (the database's guards)
 *   used       what was issued of those lots to work orders making the row's line (net of returns to stock and reversals),
 *              shared among the rows of the lines one work order makes by what each expects
 *   returned   what went back to the customer (SUPPLIER_RETURN moves of its lots), first to the order it names
 *   left       received − used − returned
 *
 * Received is not tied to one order by the stock (a lot belongs to its owner, B-W2b-281): the module shares what the
 * customer sent of a material among its open rows — first what each row already used and returned (the database keeps
 * used + returned ≤ received), then up to what each expects, oldest order first; what is more stays on the newest row.
 */

export const MATERIAL_SCALE = 4
export const CUSTOMER_MATERIAL_LIMITS = Object.freeze({ note: 2000, receiptLines: 100, returnLines: 100, sizes: 200 })

const ZERO = new Dec(0)
const text = (value: Decimal): string => value.toDecimalPlaces(MATERIAL_SCALE, Dec.ROUND_HALF_UP).toFixed(MATERIAL_SCALE)
const dec = (value: string): Decimal => new Dec(value)

/** One customer-supplied material of one garment of one size (a row of the explosion, per piece). */
export interface NeedPerPiece {
  readonly bomRevisionId: string
  readonly bomLineId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly uom: string
  /** What one garment of the size takes, in the base unit (a decimal string). */
  readonly perPiece: string
}

/** An order line: its pieces per size and what one garment of each size takes of the customer's materials. */
export interface LineNeeds {
  readonly orderLineId: string
  readonly sizes: readonly { readonly size: string; readonly pieces: number }[]
  readonly needsBySize: ReadonlyMap<string, readonly NeedPerPiece[]>
}

/** A row as it should be: the key, the expected whole and per size. */
export interface ExpectedRow {
  readonly orderLineId: string
  readonly bomRevisionId: string
  readonly bomLineId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly uom: string
  readonly expectedQuantity: string
  readonly expectedBySize: Readonly<Record<string, string>>
}

export const rowKey = (row: { readonly orderLineId: string; readonly bomLineId: string; readonly itemId: string; readonly itemColourId: string | null }): string => `${row.orderLineId}|${row.bomLineId}|${row.itemId}|${row.itemColourId ?? '-'}`

/** The rows a line's sizes ask (one per BOM line and colour), each size rounded once, the whole their sum. */
export function expectedRows(lines: readonly LineNeeds[]): ExpectedRow[] {
  const rows = new Map<string, { base: Omit<ExpectedRow, 'expectedQuantity' | 'expectedBySize'>; bySize: Map<string, Decimal> }>()
  for (const line of lines) {
    for (const { size, pieces } of line.sizes) {
      if (pieces <= 0) continue
      for (const need of line.needsBySize.get(size) ?? []) {
        const quantity = dec(need.perPiece).times(pieces)
        if (quantity.lte(0)) continue
        const key = rowKey({ orderLineId: line.orderLineId, bomLineId: need.bomLineId, itemId: need.itemId, itemColourId: need.itemColourId })
        const entry = rows.get(key) ?? { base: { orderLineId: line.orderLineId, bomRevisionId: need.bomRevisionId, bomLineId: need.bomLineId, itemId: need.itemId, itemColourId: need.itemColourId, uom: need.uom }, bySize: new Map() }
        entry.bySize.set(size, (entry.bySize.get(size) ?? ZERO).plus(quantity))
        rows.set(key, entry)
      }
    }
  }
  return [...rows.values()].map(({ base, bySize }) => {
    const sizes: Record<string, string> = {}
    for (const [size, quantity] of bySize) if (dec(text(quantity)).gt(0)) sizes[size] = text(quantity)
    let whole: Decimal = ZERO
    for (const quantity of Object.values(sizes)) whole = whole.plus(dec(quantity))
    return { ...base, expectedQuantity: text(whole), expectedBySize: sizes }
  })
}

/** A row as the recount reads it. */
export interface CountRow {
  readonly id: string
  readonly itemId: string
  readonly itemColourId: string | null
  /** Oldest order first: the order's creation, then the line's seq (the caller sorts). */
  readonly expected: string
  readonly used: string
  readonly returned: string
}

/** What each row received, from what the customer sent of each material (key item|colour), oldest row first. */
export function shareReceived(rows: readonly CountRow[], received: ReadonlyMap<string, string>): { received: Map<string, string>; short: string[] } {
  const out = new Map<string, string>()
  const short: string[] = []
  const groups = new Map<string, CountRow[]>()
  for (const row of rows) {
    const key = `${row.itemId}|${row.itemColourId ?? '-'}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  for (const [key, group] of groups) {
    let left = dec(received.get(key) ?? '0')
    // First what each row used and returned (never less: used + returned ≤ received).
    const share = new Map(group.map((row) => [row.id, dec(row.used).plus(dec(row.returned))]))
    for (const value of share.values()) left = left.minus(value)
    if (left.lt(0)) short.push(key)
    // Then up to what each expects, oldest first.
    for (const row of group) {
      if (left.lte(0)) break
      const room = dec(row.expected).minus(share.get(row.id)!)
      if (room.lte(0)) continue
      const take = room.lt(left) ? room : left
      share.set(row.id, share.get(row.id)!.plus(take))
      left = left.minus(take)
    }
    // What is more stays on the newest row.
    if (left.gt(0)) {
      const last = group[group.length - 1]!
      share.set(last.id, share.get(last.id)!.plus(left))
    }
    for (const row of group) out.set(row.id, text(share.get(row.id)!))
  }
  return { received: out, short }
}

/** A total shared among rows by weight (what each expects), rounded so the parts add up to the whole. */
export function apportion(total: string, weights: readonly { readonly id: string; readonly weight: string }[]): Map<string, string> {
  const out = new Map<string, string>()
  if (weights.length === 0) return out
  const whole = dec(total)
  const sum = weights.reduce((acc, entry) => acc.plus(dec(entry.weight)), ZERO)
  let given = ZERO
  weights.forEach((entry, index) => {
    const part = index === weights.length - 1 ? whole.minus(given) : sum.gt(0) ? whole.times(dec(entry.weight)).dividedBy(sum).toDecimalPlaces(MATERIAL_SCALE, Dec.ROUND_HALF_UP) : index === 0 ? whole : ZERO
    given = given.plus(part)
    out.set(entry.id, text(part))
  })
  return out
}

/** received − used − returned (never shown below 0). */
export function leftOf(row: { readonly received: string; readonly used: string; readonly returned: string }): string {
  const left = dec(row.received).minus(dec(row.used)).minus(dec(row.returned))
  return text(left.lt(0) ? ZERO : left)
}

/** A positive decimal of at most 4 places (a quantity received or returned). */
export function quantityProblem(value: string, path: string): Issue | null {
  if (!/^\d{1,14}(\.\d{1,4})?$/.test(value) || dec(value).lte(0)) return { path, message: 'A quantity above 0 with at most 4 decimals.' }
  return null
}

export const EMPTY_WORDS: Words = Object.freeze({ en: 'The customer supplies nothing for this order', it: 'Il cliente non fornisce nulla per questo ordine' })
export const NOT_PLANNED_WORDS: Words = Object.freeze({ en: 'Expected from the BOM, not kept on the order yet: plan it', it: "Previsto dalla distinta, non ancora sull'ordine: pianificarlo" })

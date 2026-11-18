import { CHANGE_WORDS, type Words } from '@nexus/factory-domain/order-apply/rules'
import { Dec, ZERO, type Decimal } from '@nexus/factory-domain/tax/decimal'
import { storedGapLines, workCellsOf } from '../../production/work-order-changes/propose'
import type { Reader } from './store'

/**
 * B-SA-043 (sales page plan, lead pick R1; review 17-review P6-3, P6-4, P6-5): extra pieces told honestly, OFFICE ONLY. Once a
 * change has lowered an order under what was already cut (B-SA-042), its work orders keep those pieces (Lower to the order never
 * goes below cut): they are the order's "made extra" — per line and size, the pieces cut of the order's OWN cells (work orders not
 * cancelled; the database's floor, as the cell guard reads it) beyond what the line now wants (a line closed short: what shipped).
 * Never in a portal answer: the customer reads at most its ordered figure (sales/portal-orders progress caps every stage at it).
 *
 *   madeExtraOf          per line and size: ordered (wanted now), cut, extra, "Made extra: 4 M" / "Fatti in più: 4 M"
 *   materialUsedForExtra per customer-supplied material row: what of it the extra pieces took (the line's planned need per piece
 *                        on its work orders × the extra pieces), "Used for extra pieces" / "Usato per pezzi in più"
 */

export interface MadeExtra {
  readonly lineId: string
  readonly size: string
  readonly wanted: number
  readonly cut: number
  readonly count: number
  readonly words: Words
}

export const MADE_EXTRA_WORDS = {
  madeExtra: (count: number, size: string): Words => ({ en: `Made extra: ${count} ${size}`, it: `Fatti in più: ${count} ${size}` }),
  usedForExtra: (): Words => ({ en: 'Used for extra pieces', it: 'Usato per pezzi in più' }),
} as const

/** The order's extra pieces per line and size (none: nothing cut beyond what it wants). */
export async function madeExtraOf(db: Reader, tenantId: string, order: { readonly id: string; readonly status: string }): Promise<MadeExtra[]> {
  const lines = await storedGapLines(db, order)
  const cells = (await workCellsOf(db, tenantId, lines.map((line) => line.id))).filter((cell) => cell.status !== 'CANCELLED')
  const out: MadeExtra[] = []
  for (const line of lines) {
    const sizes = new Set([...line.sizes.keys(), ...cells.filter((cell) => cell.salesOrderLineId === line.id).map((cell) => cell.size)])
    for (const size of sizes) {
      const wanted = line.sizes.get(size) ?? 0
      const cut = cells.filter((cell) => cell.salesOrderLineId === line.id && cell.size === size).reduce((sum, cell) => sum + cell.cut, 0)
      if (cut > wanted) out.push({ lineId: line.id, size, wanted, cut, count: cut - wanted, words: MADE_EXTRA_WORDS.madeExtra(cut - wanted, size) })
    }
  }
  return out
}

/** The words of an order's extra pieces in one sentence ("Extra pieces: 2 M already cut"), for a card that has room for one. */
export const extraSentence = (extra: readonly MadeExtra[]): Words | null => {
  if (extra.length === 0) return null
  const parts = extra.map((entry) => CHANGE_WORDS.extra(entry.count, entry.size))
  return { en: parts.map((part) => part.en).join(' · '), it: parts.map((part) => part.it).join(' · ') }
}

/**
 * What of a customer-supplied material the extra pieces took, per material row (orderLineId · item · colour), in the item's base
 * unit, 4 places: the line's planned need per piece on its work orders (their planned materials of that item and colour over
 * the pieces their cells make) × the line's extra pieces. Rows with none are left out.
 */
export async function materialUsedForExtra(
  db: Reader,
  extra: readonly MadeExtra[],
  rows: readonly { readonly id: string; readonly orderLineId: string; readonly itemId: string; readonly itemColourId: string | null }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const byLine = new Map<string, number>()
  for (const entry of extra) byLine.set(entry.lineId, (byLine.get(entry.lineId) ?? 0) + entry.count)
  const lineIds = [...byLine.keys()]
  if (lineIds.length === 0 || rows.length === 0) return out
  const cells = await db.workOrderSize.findMany({ where: { salesOrderLineId: { in: lineIds }, workOrder: { is: { status: { not: 'CANCELLED' } } } }, select: { id: true, salesOrderLineId: true, quantity: true } })
  const planned = cells.length === 0 ? [] : await db.workOrderMaterial.findMany({ where: { workOrderSizeId: { in: cells.map((cell) => cell.id) } }, select: { workOrderSizeId: true, itemId: true, itemColourId: true, baseQuantity: true } })
  for (const row of rows) {
    const count = byLine.get(row.orderLineId) ?? 0
    if (count === 0) continue
    const mine = cells.filter((cell) => cell.salesOrderLineId === row.orderLineId)
    const pieces = mine.reduce((sum, cell) => sum + cell.quantity, 0)
    const need: Decimal = planned
      .filter((entry) => mine.some((cell) => cell.id === entry.workOrderSizeId) && entry.itemId === row.itemId && entry.itemColourId === row.itemColourId)
      .reduce((sum, entry) => sum.plus(new Dec(entry.baseQuantity.toString())), ZERO)
    if (pieces === 0 || need.lte(0)) continue
    out.set(row.id, need.dividedBy(pieces).times(count).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4))
  }
  return out
}

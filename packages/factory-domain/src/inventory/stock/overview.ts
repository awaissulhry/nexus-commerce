import { ZERO, type Decimal } from '../../tax/decimal'
import { locatedKeyOf, quantityText, type Balance } from '../ledger/moves'

/**
 * The stock overview (SCM-190, SCM-198, SCM-258, SCM-280, QHS-073; A2 SCR-060), pure: the balances of the ledger per
 * location and stock key, with what of them is held. A lot's quality status holds all of its stock (and its hides'):
 * only a RELEASED lot is usable (planning nets it, issues take it); QUARANTINE, BLOCKED and REJECTED stock is on hand
 * but held. An item that is not tracked by lot is never held by a lot. Ported from the old app's four-column stock
 * (materials/stock.ts: in stock, committed, available): reservations and expected receipts come with planning
 * (B-W1-29, B-W1-30), so here available = on hand − held.
 */

export const LOT_QUALITY_STATUSES = ['QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED'] as const
export type LotQualityStatus = (typeof LOT_QUALITY_STATUSES)[number]

/** A lot's stock is held unless the lot is RELEASED; stock without a lot is never held by one. */
export const isHeld = (lotStatus: LotQualityStatus | null | undefined): boolean => lotStatus !== null && lotStatus !== undefined && lotStatus !== 'RELEASED'

export interface StockFigures {
  readonly onHand: Decimal
  readonly held: Decimal
  readonly available: Decimal
}

/** On hand, held and available of one balance. */
export function figuresOf(onHand: Decimal, lotStatus: LotQualityStatus | null | undefined): StockFigures {
  const held = isHeld(lotStatus) ? onHand : ZERO
  return { onHand, held, available: onHand.minus(held) }
}

/** The totals of an item in one colour (SCM-258: hides and area side by side). */
export interface ItemTotals {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly onHand: string
  readonly held: string
  readonly available: string
  /** Distinct hides with stock (items tracked by HIDE); 0 otherwise. */
  readonly hides: number
  /** Of them, the hides whose lot holds them. */
  readonly heldHides: number
  readonly locations: number
}

/** Totals per item and colour, from the balances and each lot's status. */
export function itemTotals(balances: readonly Balance[], lotStatusOf: (lotId: string) => LotQualityStatus | null | undefined): ItemTotals[] {
  const totals = new Map<string, { itemId: string; itemColourId: string | null; onHand: Decimal; held: Decimal; hides: Set<string>; heldHides: Set<string>; locations: Set<string> }>()
  for (const balance of balances) {
    if (balance.onHand.isZero()) continue
    const id = `${balance.itemId}|${balance.itemColourId ?? '-'}`
    const entry = totals.get(id) ?? { itemId: balance.itemId, itemColourId: balance.itemColourId, onHand: ZERO, held: ZERO, hides: new Set<string>(), heldHides: new Set<string>(), locations: new Set<string>() }
    const status = balance.lotId ? lotStatusOf(balance.lotId) : null
    const figures = figuresOf(balance.onHand, status)
    entry.onHand = entry.onHand.plus(figures.onHand)
    entry.held = entry.held.plus(figures.held)
    if (balance.hideId && balance.onHand.greaterThan(0)) {
      entry.hides.add(balance.hideId)
      if (isHeld(status)) entry.heldHides.add(balance.hideId)
    }
    entry.locations.add(balance.locationId)
    totals.set(id, entry)
  }
  return [...totals.values()]
    .map((entry) => ({
      itemId: entry.itemId,
      itemColourId: entry.itemColourId,
      onHand: quantityText(entry.onHand),
      held: quantityText(entry.held),
      available: quantityText(entry.onHand.minus(entry.held)),
      hides: entry.hides.size,
      heldHides: entry.heldHides.size,
      locations: entry.locations.size,
    }))
    .sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : (a.itemColourId ?? '') < (b.itemColourId ?? '') ? -1 : 1))
}

// ---- reconciliation ---------------------------------------------------------------------------------------------------

/** One stock key whose two computations disagree. */
export interface BalanceMismatch {
  readonly key: string
  readonly folded: string
  readonly summed: string
}

/**
 * The ledger reconciles (PLAN §4.7 end check): the balances folded move by move equal the balances the database sums
 * per location and key, and no balance is below zero. Returns what disagrees.
 */
export function reconcileBalances(folded: readonly Balance[], summed: readonly Balance[]): { readonly mismatches: BalanceMismatch[]; readonly negative: string[] } {
  const a = new Map(folded.map((balance) => [locatedKeyOf(balance), balance.onHand]))
  const b = new Map(summed.map((balance) => [locatedKeyOf(balance), balance.onHand]))
  const mismatches: BalanceMismatch[] = []
  for (const key of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const left = a.get(key) ?? ZERO
    const right = b.get(key) ?? ZERO
    if (!left.equals(right)) mismatches.push({ key, folded: quantityText(left), summed: quantityText(right) })
  }
  const negative = [...a.entries(), ...b.entries()].filter(([, value]) => value.isNegative()).map(([key]) => key)
  return { mismatches, negative: [...new Set(negative)].sort() }
}

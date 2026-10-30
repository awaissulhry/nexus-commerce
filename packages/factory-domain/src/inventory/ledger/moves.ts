import type { Issue } from '../../core/errors'
import { Dec, parseDecimal, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'

/**
 * The stock ledger's rules (plan A1 §2.1 "Quantities", "Append-only"; SCM-184, SCM-189, SCM-192, SCM-194), pure.
 * Ported from the old app's movement ledger (apps/factory src/lib/ledger.ts, materials/stock.ts: "stock is DERIVED,
 * never stored", corrections are compensating moves) onto the factory's ledger (factory-db inventory.prisma StockMove):
 * every move carries a quantity above 0 and the locations give its direction; a move enters a location, leaves one, or
 * both (a transfer); balances are sums of the ledger per location and stock key (site, item, colour, lot, hide).
 *
 * The API (modules/inventory/ledger postMoves) checks every move here BEFORE its insert: the …_supply_guards trigger
 * holds the same rules for every login, but a trigger's refusal can lose its message on the way through a Prisma model
 * call, so the caller gets this module's words instead. Decimals only (decimal.js), never a float.
 */

// W2a wave 5 (factory-db inventory.prisma): PRODUCTION_RECEIPT, finished garments of a work order into finished-goods stock.
export const STOCK_MOVE_REASONS = ['OPENING', 'RECEIPT', 'ISSUE', 'RETURN', 'TRANSFER', 'ADJUSTMENT', 'COUNT', 'SCRAP', 'PRODUCTION_RECEIPT'] as const
export type StockMoveReason = (typeof STOCK_MOVE_REASONS)[number]

export const ITEM_TRACKINGS = ['NONE', 'LOT', 'HIDE', 'SERIAL'] as const
export type ItemTracking = (typeof ITEM_TRACKINGS)[number]

/**
 * The sides a reason's move has: IN enters one location from outside the site's stock (a supplier, a work order, the
 * opening count), OUT leaves one to outside it (a work order, the bin), INSIDE leaves one and enters another (a
 * transfer), ONE_SIDE enters or leaves one (a correction up or down). A reversal has its original's locations swapped.
 */
export const REASON_SIDES = Object.freeze({
  OPENING: 'IN',
  RECEIPT: 'IN',
  RETURN: 'IN',
  ISSUE: 'OUT',
  SCRAP: 'OUT',
  TRANSFER: 'INSIDE',
  ADJUSTMENT: 'ONE_SIDE',
  COUNT: 'ONE_SIDE',
  PRODUCTION_RECEIPT: 'IN',
} as const satisfies Record<StockMoveReason, 'IN' | 'OUT' | 'INSIDE' | 'ONE_SIDE'>)

/** The reasons that say why (SCM-192: an adjustment, a count difference, a scrap); a reversal says why too. */
export const REASONS_WITH_NOTE: readonly StockMoveReason[] = Object.freeze(['ADJUSTMENT', 'COUNT', 'SCRAP'])

/** Quantities are Decimal(18,4) (factory-db): at most 14 digits before the point and 4 after it. */
export const QUANTITY_SCALE = 4
const MAX_QUANTITY = new Dec('99999999999999.9999')

/** Where a move goes, from its locations. */
export type Direction = 'IN' | 'OUT' | 'INSIDE'

export function directionOf(move: { readonly fromLocationId?: string | null; readonly toLocationId?: string | null }): Direction | null {
  const from = move.fromLocationId ?? null
  const to = move.toLocationId ?? null
  if (from !== null && to !== null) return from === to ? null : 'INSIDE'
  if (to !== null) return 'IN'
  if (from !== null) return 'OUT'
  return null
}

/** The decimal of a quantity, or null when it is not a plain decimal. */
export const quantityOf = (value: DecimalInput | null | undefined): Decimal | null => (value === null || value === undefined ? null : parseDecimal(value))

/** A quantity as stored and answered: four decimals ("12.5000"). */
export const quantityText = (value: DecimalInput): string => new Dec(value).toFixed(QUANTITY_SCALE)

/** What a move draft says, with the facts of its item that decide the rules. */
export interface MoveFacts {
  readonly reason: StockMoveReason
  readonly fromLocationId?: string | null
  readonly toLocationId?: string | null
  /** As entered, in `uom`. */
  readonly quantity: DecimalInput
  readonly uom: string
  /** In the item's base unit. */
  readonly baseQuantity: DecimalInput
  readonly lotId?: string | null
  readonly hideId?: string | null
  readonly receiptLineId?: string | null
  readonly workOrderId?: string | null
  readonly note?: string | null
  /** The move this one reverses: then the reason's sides are its original's, swapped. */
  readonly reversalOfId?: string | null
  readonly item: { readonly tracking: ItemTracking; readonly baseUom: string }
}

/** A positive decimal that fits Decimal(18,4), or the problem with it. */
function positiveQuantityProblem(value: DecimalInput, path: string): Issue | null {
  const quantity = quantityOf(value)
  if (quantity === null) return { path, message: 'Expected a plain decimal such as 12.5.' }
  if (quantity.lessThanOrEqualTo(0)) return { path, message: 'A move moves a quantity above 0; its locations give the direction.' }
  if (quantity.decimalPlaces() > QUANTITY_SCALE) return { path, message: `At most ${QUANTITY_SCALE} decimals.` }
  if (quantity.greaterThan(MAX_QUANTITY)) return { path, message: 'The quantity is too large.' }
  return null
}

/**
 * Every rule a move breaks on its own (paths relative to the move: `quantity`, `toLocationId`, …), in the trigger's
 * order. The facts that need other rows (the lot's colour and status, the location's status, the balance) are the
 * API's, checked with what it reads.
 */
export function moveProblems(move: MoveFacts): Issue[] {
  const problems: Issue[] = []
  const quantity = positiveQuantityProblem(move.quantity, 'quantity')
  if (quantity) problems.push(quantity)
  const base = positiveQuantityProblem(move.baseQuantity, 'baseQuantity')
  if (base) problems.push(base)
  if (!quantity && !base && move.uom === move.item.baseUom && !new Dec(move.quantity).equals(new Dec(move.baseQuantity))) {
    problems.push({ path: 'baseQuantity', message: `Entered in the item's base unit ${move.item.baseUom}: the base quantity is the quantity.` })
  }

  const direction = directionOf(move)
  if (direction === null) {
    problems.push({ path: 'toLocationId', message: 'A move leaves a location, enters one, or both (two different ones).' })
  } else if (!move.reversalOfId) {
    const sides = REASON_SIDES[move.reason]
    const fits =
      (sides === 'IN' && direction === 'IN') ||
      (sides === 'OUT' && direction === 'OUT') ||
      (sides === 'INSIDE' && direction === 'INSIDE') ||
      (sides === 'ONE_SIDE' && direction !== 'INSIDE')
    if (!fits) problems.push({ path: sides === 'OUT' ? 'fromLocationId' : 'toLocationId', message: SIDE_RULES[sides] })
  }

  if ((move.reason === 'RECEIPT') !== Boolean(move.receiptLineId)) {
    problems.push({ path: 'receiptLineId', message: 'A RECEIPT, and only it, names its goods receipt line.' })
  }
  if ((move.reason === 'ISSUE' || move.reason === 'RETURN') && !move.workOrderId) {
    problems.push({ path: 'workOrderId', message: `An ${move.reason} names its work order.` })
  }
  if (REASONS_WITH_NOTE.includes(move.reason) && !move.reversalOfId && !(move.note ?? '').trim()) {
    problems.push({ path: 'note', message: `An ${move.reason} says why (SCM-192).` })
  }

  const { tracking } = move.item
  if ((tracking === 'LOT' || tracking === 'HIDE') && !move.lotId) problems.push({ path: 'lotId', message: `The item is tracked by ${tracking}: name the lot.` })
  if (tracking === 'HIDE' && !move.hideId) problems.push({ path: 'hideId', message: 'The item is tracked hide by hide: name the hide.' })
  if (tracking !== 'HIDE' && move.hideId) problems.push({ path: 'hideId', message: `The item is tracked by ${tracking}: it has no hides.` })
  if (tracking === 'NONE' && move.lotId) problems.push({ path: 'lotId', message: 'The item is not tracked by lot: it has no lots.' })
  return problems
}

const SIDE_RULES = {
  IN: 'An OPENING, RECEIPT or RETURN enters one location (no location it leaves).',
  OUT: 'An ISSUE or SCRAP leaves one location (no location it enters).',
  INSIDE: 'A TRANSFER leaves one location and enters another.',
  ONE_SIDE: 'An ADJUSTMENT or COUNT enters one location or leaves one, not both.',
} as const

// ---- stock keys and balances ------------------------------------------------------------------------------------------

/** What a balance is kept per, at one location: the site's item, colour, lot and hide. */
export interface StockKey {
  readonly siteId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly lotId: string | null
  readonly hideId: string | null
}

/** A stock key at one location. */
export interface LocatedKey extends StockKey {
  readonly locationId: string
}

/** A balance: the quantity on hand of a stock key at a location, in the item's base unit. */
export interface Balance extends LocatedKey {
  readonly onHand: Decimal
}

/** A move as the balances read it. */
export interface LedgerMove extends StockKey {
  readonly fromLocationId: string | null
  readonly toLocationId: string | null
  readonly baseQuantity: DecimalInput
}

const part = (value: string | null): string => value ?? '-'

/** One string per stock key: the map key of the balances, and the order of the locks (sorted). */
export const stockKeyOf = (key: StockKey): string => [key.siteId, key.itemId, part(key.itemColourId), part(key.lotId), part(key.hideId)].join('|')
export const locatedKeyOf = (key: LocatedKey): string => `${key.locationId}|${stockKeyOf(key)}`

const keyFields = (move: StockKey): StockKey => ({
  siteId: move.siteId,
  itemId: move.itemId,
  itemColourId: move.itemColourId ?? null,
  lotId: move.lotId ?? null,
  hideId: move.hideId ?? null,
})

/** What a move does to one location's balance of its key: + when it enters it, − when it leaves it, else 0. */
export function locationDelta(move: LedgerMove, locationId: string): Decimal {
  const quantity = new Dec(move.baseQuantity)
  if (move.toLocationId === locationId) return quantity
  if (move.fromLocationId === locationId) return quantity.negated()
  return ZERO
}

/** What a move does to the site's stock: + when it enters it, − when it leaves it, 0 for a transfer inside it. */
export function siteDelta(move: Pick<LedgerMove, 'fromLocationId' | 'toLocationId' | 'baseQuantity'>): Decimal {
  const direction = directionOf(move)
  const quantity = new Dec(move.baseQuantity)
  return direction === 'IN' ? quantity : direction === 'OUT' ? quantity.negated() : ZERO
}

/** A move changes the site's stock value exactly when it enters or leaves the site's stock (not a transfer). */
export const changesSiteStock = (move: Pick<LedgerMove, 'fromLocationId' | 'toLocationId'>): boolean => {
  const direction = directionOf(move)
  return direction === 'IN' || direction === 'OUT'
}

/**
 * The balances of the ledger (the old app's foldMovements, per location and stock key): Σ in − Σ out. Zero balances are
 * left out unless `keepZero`. Sorted by location, then stock key.
 */
export function foldBalances(moves: Iterable<LedgerMove>, options: { readonly keepZero?: boolean } = {}): Balance[] {
  const totals = new Map<string, { key: LocatedKey; onHand: Decimal }>()
  const add = (locationId: string, move: LedgerMove, delta: Decimal) => {
    const key = { ...keyFields(move), locationId }
    const id = locatedKeyOf(key)
    const entry = totals.get(id)
    totals.set(id, { key, onHand: (entry?.onHand ?? ZERO).plus(delta) })
  }
  for (const move of moves) {
    const quantity = new Dec(move.baseQuantity)
    if (move.toLocationId) add(move.toLocationId, move, quantity)
    if (move.fromLocationId) add(move.fromLocationId, move, quantity.negated())
  }
  return sortBalances(
    [...totals.values()].filter((entry) => options.keepZero || !entry.onHand.isZero()).map((entry) => ({ ...entry.key, onHand: entry.onHand })),
  )
}

/** One side's sum of the ledger per location and key (what a `GROUP BY` of the moves into, or out of, locations gives). */
export interface SideSum extends LocatedKey {
  readonly quantity: DecimalInput
}

/** The balances from the sums of the moves into locations and out of them (the database's way of folding). */
export function balancesFromSums(into: readonly SideSum[], outOf: readonly SideSum[], options: { readonly keepZero?: boolean } = {}): Balance[] {
  const totals = new Map<string, { key: LocatedKey; onHand: Decimal }>()
  const add = (sum: SideSum, sign: 1 | -1) => {
    const key: LocatedKey = { ...keyFields(sum), locationId: sum.locationId }
    const id = locatedKeyOf(key)
    const quantity = new Dec(sum.quantity)
    totals.set(id, { key, onHand: (totals.get(id)?.onHand ?? ZERO).plus(sign === 1 ? quantity : quantity.negated()) })
  }
  for (const sum of into) add(sum, 1)
  for (const sum of outOf) add(sum, -1)
  return sortBalances(
    [...totals.values()].filter((entry) => options.keepZero || !entry.onHand.isZero()).map((entry) => ({ ...entry.key, onHand: entry.onHand })),
  )
}

const sortBalances = (balances: Balance[]): Balance[] => balances.sort((a, b) => compare(locatedKeyOf(a), locatedKeyOf(b)))
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/** A move of a batch that takes more than its location holds. */
export interface Shortfall extends LocatedKey {
  /** The move's index in the batch. */
  readonly index: number
  /** What it takes, in the base unit. */
  readonly takes: Decimal
  /** What the location holds of the key before it (after the batch's earlier moves). */
  readonly holds: Decimal
}

/**
 * The moves of a batch that would take a location below zero (SCM-194: never), applied in order on the balances read
 * under the stock locks: an earlier move of the batch may bring what a later one takes, or take it first.
 */
export function shortfalls(onHand: (key: LocatedKey) => DecimalInput, moves: readonly LedgerMove[]): Shortfall[] {
  const running = new Map<string, Decimal>()
  const current = (key: LocatedKey): Decimal => {
    const id = locatedKeyOf(key)
    let value = running.get(id)
    if (value === undefined) {
      value = new Dec(onHand(key))
      running.set(id, value)
    }
    return value
  }
  const found: Shortfall[] = []
  moves.forEach((move, index) => {
    const quantity = new Dec(move.baseQuantity)
    if (move.fromLocationId) {
      const key: LocatedKey = { ...keyFields(move), locationId: move.fromLocationId }
      const holds = current(key)
      if (holds.lessThan(quantity)) found.push({ ...key, index, takes: quantity, holds })
      running.set(locatedKeyOf(key), holds.minus(quantity))
    }
    if (move.toLocationId) {
      const key: LocatedKey = { ...keyFields(move), locationId: move.toLocationId }
      running.set(locatedKeyOf(key), current(key).plus(quantity))
    }
  })
  return found
}

/** A move with its running balance (the stock card, SCM-191 "why is it this number"). */
export interface CardLine<Move> {
  readonly move: Move
  /** + or − for the card's scope (a location, or the whole site). */
  readonly delta: Decimal
  readonly balance: Decimal
}

/**
 * The stock card: each move's effect and the balance after it, from an opening balance (the moves before the first
 * one shown). With `locationId` the card is that location's; without, the site's stock (transfers inside it move 0).
 */
export function stockCard<Move extends LedgerMove>(opening: DecimalInput, moves: readonly Move[], locationId?: string | null): CardLine<Move>[] {
  let balance = new Dec(opening)
  return moves.map((move) => {
    const delta = locationId ? locationDelta(move, locationId) : siteDelta(move)
    balance = balance.plus(delta)
    return { move, delta, balance }
  })
}

// ---- reversals --------------------------------------------------------------------------------------------------------

/** A posted move, as a reversal reads it. */
export interface PostedMove extends StockKey {
  readonly id: string
  readonly reason: StockMoveReason
  readonly fromLocationId: string | null
  readonly toLocationId: string | null
  readonly quantity: DecimalInput
  readonly uom: string
  readonly baseQuantity: DecimalInput
  readonly receiptLineId: string | null
  readonly workOrderId: string | null
  readonly reference: string | null
  readonly reversalOfId: string | null
}

/**
 * Why a move cannot be reversed, or [] (A1 §2.1: a mistake is fixed by a new row): a reversal is never reversed (post
 * the move again instead); a move has at most one reversal; a RECEIPT is reversed with its goods receipt (B-W1-32: the
 * receipt moves to REVERSED in the same transaction), never on its own: only the receipts module passes `withReceipt`.
 */
export function reversalProblems(
  move: Pick<PostedMove, 'id' | 'reason' | 'reversalOfId'>,
  reversedBy: string | null,
  options: { readonly withReceipt?: boolean } = {},
): string[] {
  const problems: string[] = []
  if (move.reversalOfId) problems.push('This move is itself a reversal; it is not reversed (post the move again instead).')
  if (reversedBy) problems.push('This move was reversed already; a move has at most one reversal.')
  if (move.reason === 'RECEIPT' && !options.withReceipt) problems.push('A receipt move is reversed with its goods receipt, never on its own.')
  return problems
}

/** The reversal of a move: the same move with its locations swapped, saying why. */
export function reversalOf(move: PostedMove, note: string) {
  return {
    siteId: move.siteId,
    reason: move.reason,
    itemId: move.itemId,
    itemColourId: move.itemColourId,
    lotId: move.lotId,
    hideId: move.hideId,
    fromLocationId: move.toLocationId,
    toLocationId: move.fromLocationId,
    quantity: quantityText(move.quantity),
    uom: move.uom,
    baseQuantity: quantityText(move.baseQuantity),
    receiptLineId: move.receiptLineId,
    workOrderId: move.workOrderId,
    reference: move.reference,
    note: note.trim(),
    reversalOfId: move.id,
  }
}

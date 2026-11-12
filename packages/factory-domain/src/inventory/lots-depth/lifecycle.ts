import { Dec, ZERO, type Decimal } from '../../tax/decimal'

/**
 * A lot's lifecycle (B-W2b-313; SCM-236; design warehouse.lots "Lifecycle (W2b)" column, "Depleted (W2b)" view, lt-stock
 * "depleted: 'Nothing left · depleted 3 Nov'"). Pure. Lot.lifecycle (schema wave 36/44, B-W2b-277) sits beside the W1
 * quality status, which still holds the stock: QUARANTINE → RELEASED → IN_USE (the first issue) → DEPLETED (the last unit
 * out); BLOCKED; RETURNED (back to its supplier). The database keeps it fitting the quality status and moves it itself
 * when a quality decision leaves it unfitting (…_warehouse_depth_w2b_guards: to QUARANTINE, RELEASED or BLOCKED); the
 * inventory module moves it further from the ledger, here: what the lot's moves at its site say.
 *
 *   quality QUARANTINE            QUARANTINE (always)
 *   quality RELEASED              stock left: IN_USE once something of it was issued (and not all undone), else RELEASED;
 *                                 nothing left after it held stock: RETURNED when what went out went back to its supplier
 *                                 and nothing was issued, else DEPLETED; never held stock: RELEASED
 *   quality BLOCKED, REJECTED     stock left: BLOCKED; nothing left after it held stock: RETURNED (sent back, nothing
 *                                 issued) or DEPLETED; never held stock: BLOCKED
 *
 * So a lot comes back from DEPLETED when stock returns to it (a return from a work order, a reversal, a count that finds
 * some), and an issue undone takes an IN_USE lot back to RELEASED. Every move names its cause (LIFECYCLE_CAUSES).
 */

export const LOT_LIFECYCLES = ['QUARANTINE', 'RELEASED', 'IN_USE', 'DEPLETED', 'BLOCKED', 'RETURNED'] as const
export type LotLifecycle = (typeof LOT_LIFECYCLES)[number]

export const LOT_QUALITY = ['QUARANTINE', 'RELEASED', 'REJECTED', 'BLOCKED'] as const
export type LotQuality = (typeof LOT_QUALITY)[number]

/**
 * What moved a lot in its life (the plan's events): its receipt (or opening stock, a split, a transfer: the lot is made),
 * its release, the first issue, the last unit out, a block or rejection, the goods sent back to the supplier, stock back
 * into it, an issue undone.
 */
export const LIFECYCLE_CAUSES = ['RECEIPT', 'RELEASE', 'FIRST_ISSUE', 'LAST_UNIT_OUT', 'BLOCK', 'RETURN', 'STOCK_BACK', 'ISSUE_UNDONE'] as const
export type LifecycleCause = (typeof LIFECYCLE_CAUSES)[number]

/** The lifecycles a quality status allows (as the database's Lot_lifecycle trigger). */
export const LIFECYCLES_OF: Readonly<Record<LotQuality, readonly LotLifecycle[]>> = Object.freeze({
  QUARANTINE: ['QUARANTINE'],
  RELEASED: ['RELEASED', 'IN_USE', 'DEPLETED', 'RETURNED'],
  BLOCKED: ['BLOCKED', 'DEPLETED', 'RETURNED'],
  REJECTED: ['BLOCKED', 'DEPLETED', 'RETURNED'],
})

export const lifecycleFits = (quality: LotQuality, lifecycle: LotLifecycle): boolean => LIFECYCLES_OF[quality].includes(lifecycle)

/** What the ledger says of a lot at its site (base unit; signed sums of the moves). */
export interface LedgerFacts {
  /** Σ in − Σ out over every location of the site. */
  readonly onHand: Decimal
  /** Some move ever put stock into it. */
  readonly everHeld: boolean
  /** ISSUE less its reversals, and less what came back from work orders (RETURN, REMNANT, net of reversals). */
  readonly issuedNet: Decimal
  /** SUPPLIER_RETURN less its reversals. */
  readonly returnedToSupplier: Decimal
}

/** One move of the ledger as the facts need it. */
export interface LedgerMove {
  readonly reason: string
  readonly baseQuantity: string
  readonly reversalOfId: string | null
  readonly fromLocationId: string | null
  readonly toLocationId: string | null
}

/** The ledger facts of one lot from its moves (every move of the lot at its site). */
export function ledgerFacts(moves: readonly LedgerMove[]): LedgerFacts {
  let onHand = ZERO
  let everHeld = false
  let issuedNet = ZERO
  let returnedToSupplier = ZERO
  for (const move of moves) {
    const quantity = new Dec(move.baseQuantity)
    const enters = move.toLocationId !== null && move.fromLocationId === null
    const leaves = move.fromLocationId !== null && move.toLocationId === null
    if (enters) onHand = onHand.plus(quantity)
    if (leaves) onHand = onHand.minus(quantity)
    if (enters && move.reversalOfId === null) everHeld = true
    // A reversal swaps the locations: it counts against the move it undoes.
    const sign = move.reversalOfId === null ? 1 : -1
    if (move.reason === 'ISSUE') issuedNet = issuedNet.plus(quantity.times(sign))
    if (move.reason === 'RETURN' || move.reason === 'REMNANT') issuedNet = issuedNet.minus(quantity.times(sign))
    if (move.reason === 'SUPPLIER_RETURN') returnedToSupplier = returnedToSupplier.plus(quantity.times(sign))
  }
  return { onHand, everHeld, issuedNet, returnedToSupplier }
}

/** Whether something of the lot was issued and is still out: a lot issued and returned in full is RELEASED again. */
const issued = (facts: LedgerFacts): boolean => facts.issuedNet.greaterThan(0)

/** The lifecycle the lot should be in. */
export function lifecycleFor(quality: LotQuality, facts: LedgerFacts): LotLifecycle {
  if (quality === 'QUARANTINE') return 'QUARANTINE'
  const empty = !facts.onHand.greaterThan(0)
  if (empty && facts.everHeld) return facts.returnedToSupplier.greaterThan(0) && !issued(facts) ? 'RETURNED' : 'DEPLETED'
  if (quality === 'RELEASED') return issued(facts) && !empty ? 'IN_USE' : 'RELEASED'
  return 'BLOCKED'
}

/** Why a lot moved from one lifecycle to another (the history's words come from the cause). */
export function lifecycleCause(from: LotLifecycle, to: LotLifecycle): LifecycleCause {
  switch (to) {
    case 'QUARANTINE':
      return 'RECEIPT'
    case 'RELEASED':
      if (from === 'QUARANTINE' || from === 'BLOCKED') return 'RELEASE'
      if (from === 'IN_USE') return 'ISSUE_UNDONE'
      return 'STOCK_BACK'
    case 'IN_USE':
      if (from === 'RELEASED') return 'FIRST_ISSUE'
      if (from === 'BLOCKED') return 'RELEASE'
      return 'STOCK_BACK'
    case 'DEPLETED':
      return 'LAST_UNIT_OUT'
    case 'RETURNED':
      return 'RETURN'
    case 'BLOCKED':
      return from === 'DEPLETED' || from === 'RETURNED' ? 'STOCK_BACK' : 'BLOCK'
  }
}

/** English words of a cause (the API's history; the screens carry their own it/en). */
export const CAUSE_WORDS: Readonly<Record<LifecycleCause, string>> = Object.freeze({
  RECEIPT: 'Received: in quarantine until released.',
  RELEASE: 'Released by quality: usable stock.',
  FIRST_ISSUE: 'First issue to a work order.',
  LAST_UNIT_OUT: 'The last unit went out: nothing is left.',
  BLOCK: 'Blocked or rejected by quality.',
  RETURN: 'Sent back to the supplier.',
  STOCK_BACK: 'Stock came back into the lot.',
  ISSUE_UNDONE: 'Its issues were undone or returned: nothing of it is at a work order.',
})

/** The lifecycles a list shows by default: every one but DEPLETED (SCM-236: depleted lots hidden by default, still found). */
export const DEFAULT_LIST_LIFECYCLES: readonly LotLifecycle[] = Object.freeze(LOT_LIFECYCLES.filter((value) => value !== 'DEPLETED'))

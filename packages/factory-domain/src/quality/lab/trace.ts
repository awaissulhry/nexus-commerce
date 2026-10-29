import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'
import { QUANTITY_SCALE } from '../../inventory/ledger/moves'

/**
 * Where a lot went (B-W1-34; design ts-later-fail "a later failing result traces to every garment and customer"; A1
 * §2.5), pure: from the issue ledger, the work orders that took stock of the lot. An ISSUE gives to a work order, a
 * RETURN brings back from it, and a reversal (or undo) of either cancels it. A work order that took any stock of the
 * lot is listed, also when all of it came back: its garments may hold a piece cut from it. Per work order: issued,
 * returned and what is still there (issued − returned), in the item's base unit. Garments, shipments and customers
 * follow from the work orders (B-W1-43's register trace, B-W1-45's releases).
 */

export interface TraceMove {
  readonly id: string
  readonly reason: string
  readonly workOrderId: string | null
  readonly baseQuantity: DecimalInput
  readonly reversalOfId: string | null
  readonly hideId: string | null
}

export interface WorkOrderUse {
  readonly workOrderId: string
  /** Issued less its reversals, base unit, four decimals. */
  readonly issued: string
  readonly returned: string
  /** Still at the work order: issued − returned. */
  readonly atWorkOrder: string
  /** The hides of the lot it took (hide-tracked leather), ids sorted. */
  readonly hideIds: string[]
}

const fixed = (value: Decimal): string => value.toFixed(QUANTITY_SCALE)

/** The work orders a lot's stock went to, in the order they first took it (moves in ledger order). */
export function workOrderUses(moves: readonly TraceMove[]): WorkOrderUse[] {
  const reversed = new Set(moves.filter((move) => move.reversalOfId !== null).map((move) => move.reversalOfId!))
  const uses = new Map<string, { issued: Decimal; returned: Decimal; hides: Set<string> }>()
  for (const move of moves) {
    if (move.workOrderId === null || move.reversalOfId !== null || reversed.has(move.id)) continue
    if (move.reason !== 'ISSUE' && move.reason !== 'RETURN') continue
    const use = uses.get(move.workOrderId) ?? { issued: ZERO, returned: ZERO, hides: new Set<string>() }
    if (move.reason === 'ISSUE') {
      use.issued = use.issued.plus(new Dec(move.baseQuantity))
      if (move.hideId) use.hides.add(move.hideId)
    } else {
      use.returned = use.returned.plus(new Dec(move.baseQuantity))
    }
    uses.set(move.workOrderId, use)
  }
  return [...uses.entries()]
    .filter(([, use]) => use.issued.greaterThan(0))
    .map(([workOrderId, use]) => ({
      workOrderId,
      issued: fixed(use.issued),
      returned: fixed(use.returned),
      atWorkOrder: fixed(use.issued.minus(use.returned)),
      hideIds: [...use.hides].sort(),
    }))
}

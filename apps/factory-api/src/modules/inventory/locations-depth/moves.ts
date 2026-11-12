import type { ItemKind, LocationBlockReason, LocationKind, StockMoveReason } from '@nexus/factory-db'
import { DomainError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { blockHolds } from '@nexus/factory-domain/inventory/locations-depth/blocks'
import { holdRefusal } from '@nexus/factory-domain/inventory/locations-depth/kinds'
import { databaseWarehouseRefusal, WAREHOUSE_REFUSAL_ISSUES } from '@nexus/factory-domain/inventory/warehouse/refusals'
import { blockToday, dayOf } from './places'

/**
 * The places of a batch of stock moves, checked in words before the database's guard (B-W2b-289; SCM-177, SCM-181), for
 * the ledger's one writer (modules/inventory/ledger post-moves.ts: every module's moves pass there):
 *
 *   holds    a move INTO a place of a kind that does not hold the item (a finished garment on a line-side rack, a
 *            material at a customer's or in finished goods; factory-domain inventory/locations-depth kinds.ts) is a 400
 *            at `<move>/toLocationId`. A reversal takes goods back where they were: not checked.
 *   blocked  a move in or out of a blocked place but a COUNT is a 409 in the database's own words (issue
 *            warehouse/LOCATION_BLOCKED; factory-domain inventory/warehouse/refusals), read on the database's clock.
 */

interface MovePlaces {
  readonly reason: StockMoveReason
  readonly itemId: string
  readonly fromLocationId?: string | null
  readonly toLocationId?: string | null
  readonly reversalOfId?: string | null
}

interface PlaceFacts {
  readonly items: ReadonlyMap<string, { readonly code: string; readonly kind: ItemKind }>
  readonly locations: ReadonlyMap<string, { readonly code: string; readonly kind: LocationKind; readonly blockedAt: Date | null; readonly blockReason: LocationBlockReason | null; readonly blockedUntil: Date | null }>
}

export function placeRefusals(moves: readonly MovePlaces[], facts: PlaceFacts, at: (index: number) => string): void {
  const holds: Issue[] = []
  moves.forEach((move, index) => {
    const item = facts.items.get(move.itemId)
    const into = move.toLocationId ? facts.locations.get(move.toLocationId) : undefined
    if (!item || !into || move.reversalOfId) return
    const refusal = holdRefusal(into, item.kind, item.kind === 'FINISHED' ? `finished garments (${item.code})` : `materials (${item.code})`)
    if (refusal) holds.push({ path: `${at(index)}/toLocationId`, message: refusal })
  })
  if (holds.length > 0) throw new ValidationError(holds.length === 1 ? holds[0]!.message : 'These moves put goods where they do not belong.', holds)

  const today = blockToday()
  for (const move of moves) {
    if (move.reason === 'COUNT') continue
    for (const id of [move.fromLocationId, move.toLocationId]) {
      const place = id ? facts.locations.get(id) : undefined
      if (!place || place.blockedAt === null || place.blockReason === null) continue
      if (!blockHolds({ blockedAt: place.blockedAt, blockReason: place.blockReason, blockNote: null, blockedUntil: dayOf(place.blockedUntil) }, today)) continue
      // The database's words, so the screens show one sentence whichever said it first.
      const words = databaseWarehouseRefusal(`inventory: location ${place.code} is blocked (${place.blockReason})`)!
      throw new DomainError('conflict', words.message, [{ path: WAREHOUSE_REFUSAL_ISSUES.blocked, message: words.message }])
    }
  }
}

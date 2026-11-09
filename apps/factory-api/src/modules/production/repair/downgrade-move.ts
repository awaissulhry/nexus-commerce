import { downgradeMoveKey } from '@nexus/factory-domain/production/repair/rules'
import type { Reader } from './store'
import { downgradeMoves } from './store'

/**
 * The second-quality move of a downgrade by its key (B-W2b-219; the follow-up of B-W2b-85 and -126 on B-W2b-204's
 * GarmentDowngrade.moveId): the downgrade posts its ADJUSTMENT first (key `production.downgrade:<id>:1`, the id chosen before
 * the insert) and inserts its row naming that move (`moveId`; the database checks the move is the downgrade's:
 * GarmentDowngrade_move_check). The withdrawal and the views read the move by `moveId`; a row made before the column has
 * none and is found by its key as before (the database lets the office fill it once: a backfill).
 */

export type DowngradeMove = Awaited<ReturnType<typeof downgradeMoves>>[number]

/** The downgrade's own move among these: the one it names, else (a row before the column) the original by its key. */
export function originalAmong(moves: readonly DowngradeMove[], row: { readonly id: string; readonly moveId: string | null }): DowngradeMove | null {
  if (row.moveId) return moves.find((move) => move.id === row.moveId) ?? null
  return moves.find((move) => move.idempotencyKey === downgradeMoveKey(row.id) && move.reversalOfId === null) ?? null
}

/** The moves of these downgrades: by their keys, and the moves they name (a named move need not carry the key). */
export async function movesOfDowngrades(db: Reader, rows: readonly { readonly id: string; readonly moveId: string | null }[]): Promise<DowngradeMove[]> {
  const byKey = await downgradeMoves(
    db,
    rows.map((row) => row.id),
  )
  const named = rows.flatMap((row) => (row.moveId && !byKey.some((move) => move.id === row.moveId) ? [row.moveId] : []))
  if (named.length === 0) return byKey
  const extra = await db.stockMove.findMany({
    where: { id: { in: named } },
    select: { id: true, idempotencyKey: true, itemId: true, toLocationId: true, fromLocationId: true, quantity: true, uom: true, baseQuantity: true, reversalOfId: true, siteId: true, workOrderId: true, reference: true, lotId: true, hideId: true, itemColourId: true },
  })
  return [...byKey, ...extra]
}

/** The original move of one downgrade (by moveId, else by its key). */
export async function originalMoveOf(db: Reader, row: { readonly id: string; readonly moveId: string | null }): Promise<DowngradeMove | null> {
  return originalAmong(await movesOfDowngrades(db, [row]), row)
}

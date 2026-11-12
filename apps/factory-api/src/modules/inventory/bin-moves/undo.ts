import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { UNDO_NOTE, undoRefusal } from '@nexus/factory-domain/inventory/bin-moves/rules'
import { reversalOf } from '@nexus/factory-domain/inventory/ledger/moves'
import { INVENTORY_TRANSFER } from '@nexus/factory-domain/inventory/permissions'
import { DomainError } from '@nexus/factory-domain/core/errors'
import { command, type CommandCaller } from '../../../core/command'
import { mayAt, stockContextOf, type StockContext } from '../ledger/access'
import { LEDGER_SELECT, postMoves, type LedgerRow } from '../ledger/post-moves'
import { askAgainAfterUndoInCommand } from '../tasks/lifecycle'
import { namesOf, taskView } from '../tasks/store'

/**
 * Undo a move by scan (B-W2b-292; design floor.move "The move posts on the scan; Undo for 2 minutes"): POST
 * /inventory/bin-moves/:moveId/undo, office and floor (inventory.transfer). Every move of that put-away or bin move (one per
 * hide of a lot tracked hide by hide), by the same tablet and worker or the same office user, within 2 minutes, not undone
 * yet: the same moves with the places swapped (reversals through postMoves, saying why), in ONE command; the put-away and
 * move tasks the move had done are asked again (lifecycle askAgainAfterUndoInCommand). A roll's move is its own (rolls):
 * moved back by a scan. Older moves are the office's reversal (inventory.reverse).
 */

const SCAN_KEY = /^(inventory\.(?:binMove|putAway):.+):\d+$/

const own = (context: StockContext, move: Pick<LedgerRow, 'createdById' | 'deviceId'>): boolean =>
  context.audience === 'floor' ? move.deviceId === context.deviceId && move.createdById === context.actorId : context.audience === 'office' && move.deviceId === null && move.createdById === context.actorId

export async function undoMove(caller: CommandCaller, moveId: string, idempotencyKey?: string) {
  const context = stockContextOf(caller)
  const original = isUuid(moveId) ? await caller.withClient((db) => db.stockMove.findUnique({ where: { id: moveId }, select: LEDGER_SELECT })) : null
  if (!original || !mayAt(context, INVENTORY_TRANSFER, original)) throw new NotFoundError('Move not found.')
  const group = SCAN_KEY.exec(original.idempotencyKey)?.[1] ?? null
  if (!group || original.reason !== 'TRANSFER' || original.reversalOfId) {
    const message = original.reference?.startsWith('Roll ') ? 'A roll moves back with a scan of it and of its place.' : 'Only a put-away or a move made by scan is undone here; ask the office to reverse another move.'
    throw new DomainError('conflict', message, [{ path: 'refusal/NOT_A_MOVE', message }])
  }
  const { result } = await command(caller, { name: 'inventory.undoBinMove', idempotencyKey, input: { moveId } }, async (tools) => {
    const { tx, now } = tools
    const moves = await tx.stockMove.findMany({ where: { siteId: original.siteId, idempotencyKey: { startsWith: `${group}:` } }, select: LEDGER_SELECT, orderBy: [{ idempotencyKey: 'asc' }, { id: 'asc' }] })
    const undone = (await tx.stockMove.count({ where: { reversalOfId: { in: moves.map((move) => move.id) } } })) > 0
    const refusal = undoRefusal({ own: moves.every((move) => own(context, move)), postedAt: original.createdAt, undone, transfer: moves.every((move) => move.reason === 'TRANSFER' && !move.reversalOfId) }, now)
    if (refusal) throw new DomainError('conflict', refusal.message, [{ path: `refusal/${refusal.code}`, message: refusal.message }])
    const posted = await postMoves(
      tools,
      moves.map((move) => ({ ...reversalOf({ ...move, quantity: move.quantity.toString(), baseQuantity: move.baseQuantity.toString() }, UNDO_NOTE), uom: move.uom })),
      { key: `inventory.undoBinMove:${idempotencyKey ?? moveId}`, issuePath: () => 'body' },
    )
    const again = await askAgainAfterUndoInCommand(
      tools,
      original.siteId,
      moves.map((move) => ({ itemId: move.itemId, lotId: move.lotId, hideId: move.hideId, fromLocationId: move.fromLocationId!, toLocationId: move.toLocationId!, postedAt: move.createdAt })),
    )
    const names = again.length > 0 ? await namesOf(tx, again) : null
    return { undoneIds: moves.map((move) => move.id), moveIds: posted.map((move) => move.id), tasks: names ? again.map((row) => taskView(row, names)) : [] }
  })
  return result
}

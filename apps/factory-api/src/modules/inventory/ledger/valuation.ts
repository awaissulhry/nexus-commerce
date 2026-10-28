import { valuationKey } from '@nexus/factory-domain/inventory/ledger/valuation'
import { command, type CommandCaller } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { stockContextOf } from './access'
import { LEDGER_SELECT, valueMovesInCommand } from './post-moves'

/**
 * The floor's moves get their value afterwards (plan A1 §2.6: the floor never sees or writes a cost; factory-db
 * StockValuation is office only). On `inventory.moved` with `valued: false` and `changesValue: true` (a floor receipt,
 * issue, return), the worker values the move as the event's tenant's system caller, through command() (audited, the
 * event as its cause), with the same basis as an office move (the lot's cost, else the item's standard cost). Once:
 * the valuation's key is `move:<moveId>` and the command's Idempotency-Key is the move's, so a repeated event or a
 * retried job finds it valued and writes nothing. A move with no cost basis stays unvalued (the stock overview and the
 * ledger check say so).
 *
 * Listed in background.ts HANDLERS for the worker: floorMoveValuationHandler().
 */
export function floorMoveValuationHandler(): EventHandler {
  return defineHandler({
    name: 'inventory.valueFloorMoves',
    events: ['inventory.moved'],
    async handle(event, { caller }) {
      const payload = event.payload as { moveId: string; valued: boolean; changesValue: boolean }
      if (payload.valued || !payload.changesValue) return
      await valueMove(caller, payload.moveId, event.eventId)
    },
  })
}

/** Values one move that has no value yet (system callers only). Answers whether it is valued now. */
export async function valueMove(caller: CommandCaller, moveId: string, causationId?: string): Promise<boolean> {
  const context = stockContextOf(caller)
  if (context.audience !== 'system') throw new Error('valueMove runs as the system (the worker)')
  const before = await caller.withClient(async (client) => ({
    move: await client.stockMove.findUnique({ where: { id: moveId }, select: LEDGER_SELECT }),
    valued: (await client.stockValuation.findUnique({ where: { tenantId_idempotencyKey: { tenantId: context.tenantId, idempotencyKey: valuationKey(moveId) } }, select: { id: true } })) !== null,
  }))
  if (!before.move) return false
  if (before.valued) return true
  const { result } = await command(
    caller,
    { name: 'inventory.valueMove', idempotencyKey: `inventory-value:${moveId}`, input: { moveId }, ...(causationId ? { causationId } : {}) },
    async (tools) => {
      const move = before.move!
      const valued = await valueMovesInCommand(tools, [{ ...move, baseQuantity: move.baseQuantity.toString() }])
      if (!valued.has(move.id)) {
        // Nothing gives it a cost: recorded, so the attempt is audited and a repeat answers from the receipt.
        tools.audit({ action: 'inventory.value', recordType: 'StockMove', recordId: move.id, companyId: move.companyId, siteId: move.siteId, after: { valued: false }, reason: 'No cost basis: the lot has no value and the item no standard cost.' })
      }
      return { valued: valued.has(move.id) }
    },
  )
  return result.valued
}

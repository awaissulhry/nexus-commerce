import { INVENTORY_TRANSFER } from '@nexus/factory-domain/inventory/permissions'
import { OPEN_TASK_STATUSES } from '@nexus/factory-domain/inventory/tasks/rules'
import type { CommandCaller } from '../../../core/command'
import { stockContextOf } from '../ledger/access'
import type { Reader } from '../issue/store'
import { namesOf, TASK_COLUMNS, taskView } from '../tasks/store'
import { handOf, handView, type Hand } from './hand'

/**
 * GET /inventory/bin-moves/scan (B-W2b-292; design floor.move sec:what "In your hands"): what a label names, where it lies,
 * its quality state, and the open put-away, move and quarantine tasks that name it (the put-away's scan adds its suggestion:
 * modules/inventory/putaway).
 */

/** The open put-away, move and quarantine tasks that name what is in hand (its lot or hide, or a hold of it). */
export async function tasksOfHand(db: Reader, hand: Hand) {
  const rows = await db.warehouseTask.findMany({
    where: {
      siteId: hand.siteId,
      status: { in: [...OPEN_TASK_STATUSES] },
      OR: [
        { lotId: hand.lot?.id ?? null, ...(hand.hide ? { OR: [{ hideId: null }, { hideId: hand.hide.id }] } : {}) },
        ...(hand.holds.length > 0 ? [{ kind: 'QUARANTINE' as const, sourceType: 'QualityHold', sourceId: { in: hand.holds.map((hold) => hold.id) } }] : []),
      ],
    },
    select: TASK_COLUMNS,
    orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }, { id: 'asc' }],
  })
  const names = await namesOf(db, rows)
  return rows.map((row) => taskView(row, names))
}

export async function scanInHand(caller: CommandCaller, code: string) {
  const context = stockContextOf(caller)
  return caller.withClient(async (db) => {
    const hand = await handOf(db, context, code, INVENTORY_TRANSFER)
    return { hand: handView(hand), tasks: await tasksOfHand(db, hand) }
  })
}

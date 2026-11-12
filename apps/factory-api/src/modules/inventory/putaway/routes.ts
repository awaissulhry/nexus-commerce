import { usable } from '@nexus/factory-domain/inventory/bin-moves/rules'
import { INVENTORY_TRANSFER } from '@nexus/factory-domain/inventory/permissions'
import { PUT_AWAY_FROM_KINDS } from '@nexus/factory-domain/inventory/tasks/sources'
import { idempotencyKeyFrom, type CommandCaller } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { stockContextOf } from '../ledger/access'
import { handOf, handView } from '../bin-moves/hand'
import { moveBodyProblems, moveByScan } from '../bin-moves/move'
import { tasksOfHand } from '../bin-moves/scan'
import { putAwayContract, scanContract } from './contract'
import { manifest } from './manifest'
import { suggestedPlace } from './suggest'

/**
 * Put away by scan (B-W2b-292; SCM-202; design floor.move "Two scans and no taps for a put-away"): GET …/scan "In your hands"
 * with the suggested place (./suggest.ts) and its put-away task, POST the put-away by its two scans (the bin label is the
 * confirmation: modules/inventory/bin-moves move.ts with the purpose PUT_AWAY; its tasks are done once nothing is left on the
 * dock). Undo: POST /inventory/bin-moves/:moveId/undo.
 */

async function putAwayScan(caller: CommandCaller, code: string) {
  const context = stockContextOf(caller)
  return caller.withClient(async (db) => {
    const hand = await handOf(db, context, code, INVENTORY_TRANSFER)
    const from = hand.lying.find((entry) => (PUT_AWAY_FROM_KINDS as readonly string[]).includes(entry.location.kind)) ?? hand.lying[0]
    const suggestion = from ? await suggestedPlace(db, { siteId: hand.siteId, itemId: hand.item.id, itemKind: hand.item.kind, lotId: hand.lot?.id ?? null, fromId: from.location.id, released: usable(hand.quality) }) : null
    return { hand: handView(hand), from: from ? { locationId: from.location.id, code: from.location.code } : null, suggestion, tasks: await tasksOfHand(db, hand) }
  })
}

export default defineRoutes('inventory.putaway', manifest, async (app) => {
  app.get('/inventory/putaway/scan', { schema: scanContract }, async (request) => putAwayScan(request, request.query.code))

  app.post('/inventory/putaway', { schema: putAwayContract }, async (request, reply) => {
    moveBodyProblems(request.body)
    return reply.code(201).send(await moveByScan(request, request.body, 'PUT_AWAY', idempotencyKeyFrom(request)))
  })
})

import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { moveContract, scanContract, undoContract } from './contract'
import { manifest } from './manifest'
import { moveBodyProblems, moveByScan } from './move'
import { scanInHand } from './scan'
import { undoMove } from './undo'

/**
 * Moves between bins by scan (B-W2b-292; SCM-218; design floor.move): GET …/scan "In your hands" (what a label names, where it
 * lies, its quality state, the open tasks that name it), POST the move by its two scans (./move.ts), POST …/:moveId/undo
 * within 2 minutes (./undo.ts). The put-away (modules/inventory/putaway) is the same move with its suggested place.
 */

export default defineRoutes('inventory.bin-moves', manifest, async (app) => {
  app.get('/inventory/bin-moves/scan', { schema: scanContract }, async (request) => scanInHand(request, request.query.code))

  app.post('/inventory/bin-moves', { schema: moveContract }, async (request, reply) => {
    moveBodyProblems(request.body)
    return reply.code(201).send(await moveByScan(request, request.body, 'MOVE', idempotencyKeyFrom(request)))
  })

  app.post('/inventory/bin-moves/:moveId/undo', { schema: undoContract }, async (request, reply) => reply.code(201).send(await undoMove(request, request.params.moveId, idempotencyKeyFrom(request))))
})

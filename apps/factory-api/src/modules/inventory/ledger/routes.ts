import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { adjustContract, countContract, listMovesContract, reverseContract, scrapContract, transferContract } from './contract'
import { manifest } from './manifest'
import { adjust, listMoves, postCount, reverse, scrap, transfer } from './moves'

/**
 * The append-only stock ledger (B-W1-22; SCM-189, SCM-191, SCM-192, SCM-193, SCM-194, SCM-195): adjustments, counts,
 * transfers, scraps and reversals, each posted through postMoves (post-moves.ts, the one writer every module uses), and
 * the moves list. The worker values the floor's moves (valuation.ts).
 */
export default defineRoutes('inventory.ledger', manifest, async (app) => {
  app.get('/inventory/moves', { schema: listMovesContract }, async (request) => listMoves(request, request.query))

  app.post('/inventory/adjustments', { schema: adjustContract }, async (request, reply) => reply.code(201).send(await adjust(request, request.body, idempotencyKeyFrom(request))))

  app.post('/inventory/counts', { schema: countContract }, async (request, reply) => reply.code(201).send(await postCount(request, request.body, idempotencyKeyFrom(request))))

  app.post('/inventory/transfers', { schema: transferContract }, async (request, reply) => reply.code(201).send(await transfer(request, request.body, idempotencyKeyFrom(request))))

  app.post('/inventory/scraps', { schema: scrapContract }, async (request, reply) => reply.code(201).send(await scrap(request, request.body, idempotencyKeyFrom(request))))

  app.post('/inventory/moves/:moveId/reverse', { schema: reverseContract }, async (request, reply) =>
    reply.code(201).send(await reverse(request, request.params.moveId, request.body, idempotencyKeyFrom(request))),
  )
})

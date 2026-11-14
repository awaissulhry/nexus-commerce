import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { changeLanded, prepareLanded, removeLanded } from './allocate'
import { landedChangeContract, landedCreateContract, landedDetailContract, landedListContract, landedPostContract, landedRemoveContract, landedReverseContract } from './contract'
import { manifest } from './manifest'
import { postLanded, reverseLanded } from './post'
import { landedCharges, landedDetail } from './reads'

/**
 * Landed cost over the received lots (B-W2b-407; FIN-044; SCM-126, SCM-127): the supplier invoices' charge lines and where
 * each stands, one landed cost with its shares per lot, prepare a draft (basis, the receipts whose lots it lands on,
 * weights), change or remove it, post it (the lots' cost moves; GATE-ACCOUNTANT) and reverse it with a reason. A repeated
 * Idempotency-Key answers 200 from its receipt.
 */
export default defineRoutes('costing.landed', manifest, async (app) => {
  app.get('/costing/landed', { schema: landedListContract }, async (request) => landedCharges(request, request.query))

  app.get('/costing/landed/:allocationId', { schema: landedDetailContract }, async (request) => ({ allocation: await landedDetail(request, request.params.allocationId) }))

  app.post('/costing/landed', { schema: landedCreateContract }, async (request, reply) => {
    const result = await prepareLanded(request, request.body, idempotencyKeyFrom(request))
    return reply.code(result.replayed ? 200 : 201).send({ allocation: result.allocation })
  })

  app.patch('/costing/landed/:allocationId', { schema: landedChangeContract }, async (request) => ({ allocation: (await changeLanded(request, request.params.allocationId, request.body, idempotencyKeyFrom(request))).allocation }))

  app.delete('/costing/landed/:allocationId', { schema: landedRemoveContract }, async (request) => {
    await removeLanded(request, request.params.allocationId, request.query.version, idempotencyKeyFrom(request))
    return { id: request.params.allocationId, removed: true as const }
  })

  app.post('/costing/landed/:allocationId/post', { schema: landedPostContract }, async (request) => ({ allocation: (await postLanded(request, request.params.allocationId, request.body.version, idempotencyKeyFrom(request))).allocation }))

  app.post('/costing/landed/:allocationId/reverse', { schema: landedReverseContract }, async (request) => ({
    allocation: (await reverseLanded(request, request.params.allocationId, request.body.version, request.body.reason, idempotencyKeyFrom(request))).allocation,
  }))
})

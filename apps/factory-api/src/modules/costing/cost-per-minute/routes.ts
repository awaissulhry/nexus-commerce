import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { applyCalc, createCalc, removeCalc, updateCalc } from './calculator'
import { applyCalcContract, calcContract, createCalcContract, listCalcsContract, prefillContract, removeCalcContract, updateCalcContract } from './contract'
import { manifest } from './manifest'
import { calcRecord, listCalcs, prefill } from './reads'

/**
 * The cost-per-minute calculator (B-W2b-419; FIN-005; design finance.settings › Costing): the calculations per company,
 * department (or work centre) and whole months; the prefill of a department's available minutes from its calendars and
 * planned seats; make, correct or remove a calculation while it is not applied; apply it as the company's labour rate of the
 * department from a day (the rate and the applied calculation in one command). A repeated Idempotency-Key answers from its
 * receipt.
 */
export default defineRoutes('costing.cost-per-minute', manifest, async (app) => {
  app.get('/costing/cost-per-minute', { schema: listCalcsContract }, async (request) => listCalcs(request, request.query))

  app.get('/costing/cost-per-minute/prefill', { schema: prefillContract }, async (request) => ({ prefill: await prefill(request, request.query) }))

  app.get('/costing/cost-per-minute/:calcId', { schema: calcContract }, async (request) => ({ calc: await calcRecord(request, request.params.calcId) }))

  app.post('/costing/cost-per-minute', { schema: createCalcContract }, async (request, reply) => reply.code(201).send({ calc: await createCalc(request, request.body, idempotencyKeyFrom(request)) }))

  app.patch('/costing/cost-per-minute/:calcId', { schema: updateCalcContract }, async (request) => ({ calc: await updateCalc(request, request.params.calcId, request.body, idempotencyKeyFrom(request)) }))

  app.delete('/costing/cost-per-minute/:calcId', { schema: removeCalcContract }, async (request) => {
    await removeCalc(request, request.params.calcId, request.query.version, idempotencyKeyFrom(request))
    return { id: request.params.calcId, removed: true as const }
  })

  app.post('/costing/cost-per-minute/:calcId/apply', { schema: applyCalcContract }, async (request) => applyCalc(request, request.params.calcId, request.body, idempotencyKeyFrom(request)))
})

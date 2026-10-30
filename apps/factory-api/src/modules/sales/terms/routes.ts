import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createTermsContract, getTermsContract, listTermsContract, moveTermsContract, updateTermsContract } from './contract'
import { manifest } from './manifest'
import { createTerms, getTerms, listTerms, moveTerms, updateTerms } from './terms'

/**
 * The payment terms library (B-W2a-19; FIN-075; design finance.settings "Payment terms"): the entries with their printed
 * names, FatturaPA payment method, instalments (what share falls due when: on the order, before shipping, on delivery,
 * from the invoice, end of month) and early-payment discount; add, edit, archive, reactivate. A customer's default terms
 * are set on the customer (PATCH /parties/:partyId/commercial-terms); a new quote copies them.
 */
export default defineRoutes('sales.terms', manifest, async (app) => {
  app.get('/sales/payment-terms', { schema: listTermsContract }, async (request) => listTerms(request, request.query))

  app.get('/sales/payment-terms/:termsId', { schema: getTermsContract }, async (request) => getTerms(request, request.params.termsId))

  app.post('/sales/payment-terms', { schema: createTermsContract }, async (request, reply) => reply.code(201).send(await createTerms(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/sales/payment-terms/:termsId', { schema: updateTermsContract }, async (request) => updateTerms(request, request.params.termsId, request.body, idempotencyKeyFrom(request)))

  app.post('/sales/payment-terms/:termsId/archive', { schema: moveTermsContract }, async (request) => moveTerms(request, request.params.termsId, 'archive', request.body, idempotencyKeyFrom(request)))

  app.post('/sales/payment-terms/:termsId/reactivate', { schema: moveTermsContract }, async (request) => moveTerms(request, request.params.termsId, 'reactivate', request.body, idempotencyKeyFrom(request)))
})

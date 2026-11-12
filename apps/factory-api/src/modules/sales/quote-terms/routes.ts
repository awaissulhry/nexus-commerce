import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { getTermsContract, saveScheduleContract, saveTermsContract } from './contract'
import { manifest } from './manifest'
import { getTerms, saveSchedule, saveTerms } from './terms'

/**
 * A quote's Terms & delivery (B-W2b-294; SAL-162 Incoterm and place, ship complete or as ready, the acceptance mode; SAL-151 a
 * delivery schedule per line; SAL-145 the validity with its reminder and expiry). The validity job is ./validity.ts (cron
 * `sales.quoteValidity`); what the terms and schedule carry to a new version and to the order is ./carry.ts.
 */
export default defineRoutes('sales.quoteTerms', manifest, async (app) => {
  app.get('/sales/quotes/:quoteId/terms', { schema: getTermsContract }, async (request) => getTerms(request, request.params.quoteId))

  app.put('/sales/quotes/:quoteId/terms', { schema: saveTermsContract }, async (request) => saveTerms(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))

  app.put('/sales/quotes/:quoteId/lines/:lineId/deliveries', { schema: saveScheduleContract }, async (request) => saveSchedule(request, request.params.quoteId, request.params.lineId, request.body, idempotencyKeyFrom(request)))
})

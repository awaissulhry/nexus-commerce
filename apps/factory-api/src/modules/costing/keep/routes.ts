import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { keepContract } from './contract'
import { keepCost } from './keep'
import { manifest } from './manifest'

/**
 * owb-pd3 (S4 settle 9): Keep — the cost now as the product's standard cost, kept at once by the same person where the company allows
 * it, else sent for approval (four eyes); its standard costs follow on the approval (keep.ts, standards.ts).
 */
export default defineRoutes('costing.keep', manifest, async (app) => {
  app.post('/costing/styles/:styleId/revisions/:revisionId/keep', { schema: keepContract }, async (request) => keepCost(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)))
})

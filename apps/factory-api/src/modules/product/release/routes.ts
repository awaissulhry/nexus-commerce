import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { getGateContract, releasedScopeContract, setScopeContract, summaryContract } from './contract'
import { gateFor } from './gate'
import { manifest } from './manifest'
import { releasedScopeFor, setScope } from './scope'
import { releaseSummary } from './summary'

/**
 * The release gate of a style revision (product module, B-W2b-231; features PRD-190 release gate, PRD-191 release by colourway
 * and size, PRD-197 release event, PRD-232 completeness score): one checklist (the BOM check, the routing with its approved
 * SMV, materials approved and costed, the label, the certificate coverage of every switched-on colourway × size the release
 * takes, the measurement spec, the product type's attributes, open change orders, the scope, what stays on the old revision),
 * the completeness score from the same list, what a revision is released for and a later release of more of it. W1's release
 * route (modules/product/bom revisions.ts) asks the same gate (`releaseGateInCommand`), stores the score and says the scope in
 * style.revision_released; the work-order release refuses a cell outside it (production/work-orders facts.ts).
 */
export default defineRoutes('product.release', manifest, async (app) => {
  app.get('/product/styles/:styleId/revisions/:revisionId/release-gate', { schema: getGateContract }, async (request) => ({
    gate: await gateFor(request, request.params.styleId, request.params.revisionId, request.query),
  }))

  app.put('/product/styles/:styleId/revisions/:revisionId/release-scope', { schema: setScopeContract }, async (request) => ({
    gate: await setScope(request, request.params.styleId, request.params.revisionId, request.body, idempotencyKeyFrom(request)),
  }))

  app.get('/product/styles/:styleId/release-scope', { schema: releasedScopeContract }, async (request) => ({ released: await releasedScopeFor(request, request.params.styleId) }))

  app.get('/product/release-gate', { schema: summaryContract }, async (request) => releaseSummary(request, request.query))
})

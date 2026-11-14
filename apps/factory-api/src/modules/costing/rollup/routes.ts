import { defineRoutes } from '../../../core/manifest'
import { rollupContract } from './contract'
import { manifest } from './manifest'
import { revisionRollup } from './rollup'

/**
 * The multi-level cost roll-up (B-W2b-423; FIN-019, KS4:02): a revision's components with every sub-assembly line at its own
 * cost, and the tree of its sub-assemblies, each one's cost per output batch. A read: nothing is written.
 */
export default defineRoutes('costing.rollup', manifest, async (app) => {
  app.get('/costing/styles/:styleId/revisions/:revisionId/rollup', { schema: rollupContract }, async (request) => revisionRollup(request, request.params.styleId, request.params.revisionId, request.query))
})

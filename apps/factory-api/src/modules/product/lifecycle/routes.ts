import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { moveLifecycleContract, readLifecycleContract, replacementContract } from './contract'
import { moveLifecycle, readLifecycle, setReplacement } from './lifecycle'
import { manifest } from './manifest'

/**
 * A style's lifecycle (B-W2b-221; PRD-007 lifecycle states, PRD-182 the edit rule per state): the read, one move per command,
 * and the replacing style (./lifecycle.ts). The edit rule every product write asks is ./edit-rule.ts.
 */
export default defineRoutes('product.lifecycle', manifest, async (app) => {
  app.get('/product/styles/:styleId/lifecycle', { schema: readLifecycleContract }, async (request) => ({ lifecycle: await readLifecycle(request, request.params.styleId) }))
  app.post('/product/styles/:styleId/lifecycle', { schema: moveLifecycleContract }, async (request) => ({
    lifecycle: await moveLifecycle(request, request.params.styleId, request.body, idempotencyKeyFrom(request)),
  }))
  app.put('/product/styles/:styleId/replaced-by', { schema: replacementContract }, async (request) => ({
    lifecycle: await setReplacement(request, request.params.styleId, request.body, idempotencyKeyFrom(request)),
  }))
})

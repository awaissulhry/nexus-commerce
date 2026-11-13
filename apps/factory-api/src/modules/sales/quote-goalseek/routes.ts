import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { goalSeekContract } from './contract'
import { goalSeek } from './goalseek'
import { manifest } from './manifest'

/**
 * Target price goal-seek (B-W2b-302; SAL-150): a target unit price, discount, margin or total for chosen lines, shown first
 * (`preview: true`: the waterfall each line would get, the discount needed, the margin against the floor, the totals) and then
 * written the same way in one command through B-W2b-330's line price writer.
 */
export default defineRoutes('sales.quoteGoalSeek', manifest, async (app) => {
  app.post('/sales/quotes/:quoteId/goal-seek', { schema: goalSeekContract }, async (request) => goalSeek(request, request.params.quoteId, request.body, idempotencyKeyFrom(request)))
})

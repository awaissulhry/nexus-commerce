import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { manifest } from './manifest'
// ---- server B (owb-fl3/fl4) imports ----
import { setFlags } from './flags'
import { sayLate } from './late'
import { flagsContract, lateContract } from './signals-contract'
// ---- end server B imports ----

/**
 * Baskets on the floor (owb- order workflow, S5): server A's block (fl1/fl2) and server B's block (fl3/fl4) — see ./manifest.ts.
 * Each write is one command with an Idempotency-Key (a floor act keyed `<device>.<clientEventId>` when none is sent).
 */
export default defineRoutes('production.baskets', manifest, async (app) => {
  // ---- server B (owb-fl3/fl4): flags, late, team, board, from the floor ----
  app.post('/production/baskets/flags', { schema: flagsContract }, async (request) => setFlags(request, request.body, idempotencyKeyFrom(request)))

  app.post('/production/baskets/late', { schema: lateContract }, async (request, reply) => {
    const answer = await sayLate(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  // ---- end server B ----
})

import type { AbusePolicyName } from '@nexus/factory-domain/abuse/policies'
import { defineRoutes } from '../../core/manifest'
import { AUTH_RATE_LIMITS } from '../auth/sessions/office-auth'
import { challengeContract } from './contract'
import { abuseGuardOf } from './guard'
import { manifest } from './manifest'

/**
 * GET /abuse/challenge?policy=<policy>   a self-hosted proof-of-work challenge (factory-domain abuse/pow.ts) for the
 *                                        caller's network, as hard as its traffic asks now. Public, stateless (signed by
 *                                        the server), valid 5 minutes, used once; rate-limited per address.
 * A public route asks for one by answering 429 with the issue `challenge` (platform/abuse/guard.ts); the page solves it
 * and sends the request again with `proof: { challenge, nonce }`. No third party, no cost (PLT-066, GATE-SPEND).
 */
export default defineRoutes('abuse', manifest, async (app) => {
  const limit = app.officeAuth?.rateLimits.linkUse ?? AUTH_RATE_LIMITS.linkUse
  app.get('/abuse/challenge', { schema: challengeContract, config: { rateLimit: { max: limit.max, timeWindow: limit.timeWindowMs } } }, async (request) =>
    abuseGuardOf(app).challenge(request, request.query.policy as AbusePolicyName),
  )
})

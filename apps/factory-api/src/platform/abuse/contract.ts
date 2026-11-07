import { z } from 'zod'
import { ABUSE_POLICY_NAMES } from '@nexus/factory-domain/abuse/policies'
import { POW } from '@nexus/factory-domain/abuse/pow'
import { defineContract, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The abuse guard's contracts (B-W2b-159; PLT-066). A guarded public route takes `proof` in its body: the challenge it got
 * from GET /abuse/challenge and the nonce that solves it (abuse/pow.ts). Only needed after the route answered 429 with
 * the issue `challenge`; never by default.
 */
export const proofBody = input({ challenge: z.string().min(1).max(200), nonce: z.string().min(1).max(32) })

export const challengeContract = defineContract({
  querystring: input({ policy: z.enum(ABUSE_POLICY_NAMES as [string, ...string[]]) }),
  response: {
    200: output({
      /** Send it back with the nonce in the body's `proof`, within its 5 minutes, once. */
      challenge: z.string(),
      policy: z.string(),
      /** SHA-256 of `<challenge>:<nonce>` must start with this many zero bits. */
      bits: z.number().int(),
      algorithm: z.literal(POW.algorithm),
      expiresAt: instant(),
    }),
  },
})

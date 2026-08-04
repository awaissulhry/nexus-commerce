/**
 * ADX G2 — validation for the campaign bid bounds (minBidCents / maxBidCents).
 *
 * Pure, so it can be tested without a server. The route is 10k lines long and pure
 * validation has no business living in it.
 *
 * The subtle case is the one-sided update. "Set max to 50" across a selection looks
 * harmless until it lands on a campaign whose min is already 80 — the result is a
 * campaign no engine can write to at all, because every bid is simultaneously below
 * the floor and above the ceiling. So a partial update is validated against the values
 * the campaign ALREADY has, not just against the values in the request.
 */

/** Ceilings are sanity bounds, not policy: €1,000 a click and 1000% ACOS are absurd. */
export const MAX_BID_CENTS_CEILING = 100_000

/**
 * NOT handled here: target ACOS. `Campaign.targetAcosPct` was added in A1 and is a
 * mistake — `dynamicBidding.targetAcos` already exists and is read by five services
 * including ads-bid-optimizer. Wiring a second source of truth for the same number is
 * exactly the class of bug this programme keeps uncovering, so the column is left
 * deliberately unused pending a destructive migration to drop it.
 *
 * These bounds ARE new. The account already had two bid guardrails and neither does
 * this job: `maxBidChangePct` clamps how far one move may swing, and `cpcCeiling`
 * caps a bid at a multiple of the target's HISTORICAL CPC — which cannot express
 * "never above EUR 2", and does nothing at all for a keyword with no history yet.
 * An absolute bound is the missing third.
 */

export interface Bound {
  value: number | null
  error: string | null
}

/**
 * `null` = explicit clear, `undefined` = field not supplied. Both yield a null value;
 * callers distinguish them by checking `body.field !== undefined`.
 */
export function parseBound(v: unknown, ceiling: number): Bound {
  if (v === null || v === undefined) return { value: null, error: null }
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return { value: null, error: 'must be a non-negative number' }
  if (n > ceiling) return { value: null, error: `must be <= ${ceiling}` }
  return { value: Math.round(n), error: null }
}

export interface GuardrailPatch {
  minBidCents?: number | null
  maxBidCents?: number | null
}

/** The campaign's guardrails as they stand, for validating a partial update. */
export interface ExistingGuardrails {
  name: string
  minBidCents: number | null
  maxBidCents: number | null
}

/**
 * Flat rather than a discriminated union: `ok` plus an always-present `error`. The
 * union form reads better but narrowing it across a dynamic `await import()` boundary
 * proved unreliable here, and a validator that needs a type-assertion at every call
 * site is not doing its job.
 */
export interface GuardrailValidation {
  ok: boolean
  data: Record<string, number | null>
  error: string | null
}

/**
 * Validate a patch and return the exact field set to write. `existing` is every
 * campaign the patch will land on — all of them are checked, so a bulk update fails
 * whole rather than leaving some campaigns in an unwritable state.
 */
export function validateGuardrails(patch: GuardrailPatch, existing: ExistingGuardrails[]): GuardrailValidation {
  const min = parseBound(patch.minBidCents, MAX_BID_CENTS_CEILING)
  const max = parseBound(patch.maxBidCents, MAX_BID_CENTS_CEILING)
  const fail = (error: string): GuardrailValidation => ({ ok: false, data: {}, error })
  if (min.error) return fail(`minBidCents ${min.error}`)
  if (max.error) return fail(`maxBidCents ${max.error}`)

  if (min.value != null && max.value != null && min.value > max.value) {
    return fail('minBidCents cannot exceed maxBidCents')
  }

  const data: Record<string, number | null> = {}
  if (patch.minBidCents !== undefined) data.minBidCents = min.value
  if (patch.maxBidCents !== undefined) data.maxBidCents = max.value
  if (Object.keys(data).length === 0) return fail('no guardrail fields supplied')

  // The one-sided case: check the resulting pair per campaign, not just the request.
  for (const c of existing) {
    const nextMin = data.minBidCents !== undefined ? data.minBidCents : c.minBidCents
    const nextMax = data.maxBidCents !== undefined ? data.maxBidCents : c.maxBidCents
    if (nextMin != null && nextMax != null && nextMin > nextMax) {
      return fail(`would leave "${c.name}" with min ${nextMin}¢ > max ${nextMax}¢`)
    }
  }
  return { ok: true, data, error: null }
}

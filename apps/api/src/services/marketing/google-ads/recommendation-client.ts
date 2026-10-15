/**
 * Google Ads changes, G5 (2026-10-15) — applying and dismissing Google's recommendations: RecommendationService through
 * the channel gateway (`googleCall`, channel GOOGLE: the account's token and state, the rate bucket, one ledger row).
 *
 *   POST {GOOGLE_ADS_API_BASE}/customers/{customerId}/recommendations:apply     body { operations, partialFailure: false }
 *   POST {GOOGLE_ADS_API_BASE}/customers/{customerId}/recommendations:dismiss   body { operations, partialFailure: false }
 *
 * Checked 2026-10-15 in the v25 reference (developers.google.com/google-ads/api/reference/rpc/v25/ApplyRecommendationRequest
 * and DismissRecommendationRequest): the request has customer_id, operations (at most 100) and partial_failure — NO
 * validate_only, so Google cannot check an apply or a dismiss first. With partial_failure false Google applies all or
 * none, and every recommendation of one request must be of the same type (RecommendationError
 * DIFFERENT_TYPES_NOT_SUPPORTED otherwise). The answer is `results[]`, one per operation, each with the recommendation's
 * resource_name (ApplyRecommendationResult / DismissRecommendationResult).
 *
 * Like a real mutate (write-client.ts): the operations are reserved on the account's change allowance first; a "slow
 * down" is sent again once (Google changed nothing); no answer, or a failure on Google's side, is an UNKNOWN outcome that
 * Nexus never sends again by itself. Never logs a token, a request body or a row.
 */
import { googleCall } from '../../gateway/google.js'
import type { GatewayNoAnswer, GatewayRefusal } from '../../gateway/gateway.js'
import { GOOGLE_RECOMMENDATION_MAX_OPERATIONS } from '../../gateway/channels.js'
import { GOOGLE_ADS_API_BASE } from '../../google/api-version.js'
import { failureFromGatewayRefusal, failureFromNoAnswer, localFailure, parseGoogleAdsFailure, type GoogleAdsFailure } from './errors.js'
import { customerIdDigits } from './mappers.js'
import { addSpentOps, markQuotaExhausted, releaseOps, reserveOps } from './ops-budget.js'
import { customerResource, GoogleAdsWriteError, UNKNOWN_OUTCOME, type GoogleMutateOperation, type GoogleMutateResponse } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

const TIMEOUT_MS = 120_000
const MAX_JITTER_MS = 1_000

export type RecommendationAction = 'apply' | 'dismiss'

/** The result key a run reads for each operation (`{ recommendationResult: { resourceName } }`). */
export const RECOMMENDATION_RESULT = 'recommendationResult'

const isRefusal = (err: unknown): err is GatewayRefusal => err instanceof Error && err.name === 'GatewayRefusal'
const isNoAnswer = (err: unknown): err is GatewayNoAnswer => err instanceof Error && err.name === 'GatewayNoAnswer'
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Apply or dismiss recommendations of ONE account, all or nothing. `operations` are ApplyRecommendationOperation /
 * DismissRecommendationOperation objects in Google's JSON (`{ resourceName, campaignBudget?: { … } }`). Resolves with
 * one response per operation; rejects with a GoogleAdsWriteError whose `outcome` says whether anything can have changed.
 */
export async function sendRecommendations(
  target: GoogleAdsTarget,
  action: RecommendationAction,
  operations: GoogleMutateOperation[],
  options: { sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
): Promise<{ responses: GoogleMutateResponse[]; ops: number }> {
  const operation = `ads.recommendations.${action}`
  const notSent = (sentence: string, code: string) => new GoogleAdsWriteError(localFailure(sentence, code), operation, 'not_sent')
  if (operations.length === 0) throw notSent('The change holds no recommendation. Nothing was sent.', 'EMPTY_CHANGE')
  if (operations.length > GOOGLE_RECOMMENDATION_MAX_OPERATIONS) {
    throw notSent(`Google takes at most ${GOOGLE_RECOMMENDATION_MAX_OPERATIONS} recommendations in one request. Nothing was sent.`, 'TOO_MANY_OPERATIONS')
  }
  const customer = customerResource(target)
  const login = target.loginCustomerId ? customerIdDigits(target.loginCustomerId) : null
  if (target.loginCustomerId && !login) throw notSent('The manager account id is not a customer id. Nothing was sent.', 'INVALID_CUSTOMER_ID')
  const customerId = customer.slice('customers/'.length)

  const reservation = await reserveOps(customerId, operations.length, new Date(), 'write')
  if (!reservation.ok) throw notSent(reservation.sentence, reservation.reason ?? 'OPS_REFUSED')
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  const body = { operations, partialFailure: false }
  let reached = 0
  let slowDowns = 0
  const settle = async () => {
    if (reached === 0) await releaseOps(customerId, operations.length, reservation.reservedAt, 'write')
    else if (reached > 1) await addSpentOps(customerId, (reached - 1) * operations.length, reservation.reservedAt, 'write')
  }
  for (;;) {
    let failure: GoogleAdsFailure
    let answered = false
    try {
      const response = await googleCall({
        connectionId: target.connectionId,
        operation,
        method: 'POST',
        url: `${GOOGLE_ADS_API_BASE}/${customer}/recommendations:${action}`,
        body,
        loginCustomerId: login,
        maxTransientRetries: 0,
        max429Retries: 0,
        timeoutMs: TIMEOUT_MS,
      })
      reached += 1
      answered = true
      const text = await response.text()
      if (response.ok) {
        await settle()
        let parsed: { results?: unknown } = {}
        try { parsed = text ? JSON.parse(text) : {} } catch { /* nothing to read */ }
        const results = Array.isArray(parsed.results) ? (parsed.results as Array<{ resourceName?: string }>) : []
        return { responses: results.map((r) => ({ [RECOMMENDATION_RESULT]: { resourceName: typeof r?.resourceName === 'string' ? r.resourceName : undefined } })), ops: reached * operations.length }
      }
      failure = parseGoogleAdsFailure(response.status, text, response.headers)
    } catch (err) {
      if (isRefusal(err)) {
        await settle()
        throw new GoogleAdsWriteError(failureFromGatewayRefusal(err), operation, 'not_sent', reached * operations.length)
      }
      if (!isNoAnswer(err)) {
        await settle()
        throw err
      }
      reached += 1
      failure = failureFromNoAnswer(err)
    }
    if (failure.quotaExhausted) await markQuotaExhausted()
    if (failure.retryKind === 'slow_down' && slowDowns < 1 && answered) {
      // Google refused it before changing anything: safe to send again once.
      slowDowns += 1
      await sleep((failure.retryAfterMs ?? 30_000) + Math.floor(random() * MAX_JITTER_MS))
      continue
    }
    await settle()
    const spent = reached * operations.length
    if (!answered || failure.retryKind === 'transient') {
      throw new GoogleAdsWriteError({ ...failure, sentence: UNKNOWN_OUTCOME }, operation, 'unknown', spent)
    }
    throw new GoogleAdsWriteError(failure, operation, 'refused', spent)
  }
}

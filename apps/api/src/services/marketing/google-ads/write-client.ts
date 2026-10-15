/**
 * Google Ads changes (2026-10-15) — the write client: GoogleAdsService.Mutate through the channel gateway (`googleCall`,
 * channel GOOGLE: the account's token and state, the rate bucket, one ledger row per call), and the live reads a change
 * stands on.
 *
 *   POST {GOOGLE_ADS_API_BASE}/customers/{customerId}/googleAds:mutate
 *        body { mutateOperations, partialFailure: false, validateOnly, responseContentType: 'RESOURCE_NAME_ONLY' }
 *
 * - ONE request per change, all or nothing (partialFailure false): Google applies every operation or none. Operations
 *   may point at what an earlier operation of the same request creates through a temporary id (a negative number in its
 *   resource name, `customers/1/campaignBudgets/-1`).
 * - `validateOnly: true` is Google's check: it answers whether it would accept the change and changes nothing. A
 *   preview is built on it; the gateway lets it through even with Google Ads writes switched off.
 * - Operations: Google counts each operation of a mutate, and a refused request counts too. A change reserves them on
 *   the account's change allowance (ops-budget.ts, lane write) before it sends anything; a refused reservation sends
 *   nothing.
 * - Retries: a check is retried like a read (temporary problem: 3 times; slow down: once). A real change is retried
 *   only when Google said "slow down" (it applied nothing). When Google does not answer at all, nobody knows whether
 *   the change happened, nor when Google fails on its side (5xx): `GoogleAdsWriteError.outcome` is `unknown` — never
 *   sent again by Nexus; a second approval reads the account first and sends only what is not there.
 * Never logs a token, a request body or a row.
 */
import { googleCall } from '../../gateway/google.js'
import type { GatewayNoAnswer, GatewayRefusal } from '../../gateway/gateway.js'
import { GOOGLE_ADS_API_BASE } from '../../google/api-version.js'
import {
  failureFromGatewayRefusal, failureFromNoAnswer, GoogleAdsReadError, localFailure, parseGoogleAdsFailure, type GoogleAdsFailure,
} from './errors.js'
import { customerIdDigits } from './mappers.js'
import { addSpentOps, markQuotaExhausted, releaseOps, reserveOps } from './ops-budget.js'
import { searchRows } from './read-client.js'
import type { GoogleAdsTarget } from './types.js'

/** The most operations one change sends (Google allows 10,000 per request; a change this big is not one a person reads). */
export const MAX_MUTATE_OPERATIONS = 5000
const MUTATE_TIMEOUT_MS = 120_000
const CHECK_RETRIES = 3
const CHECK_BACKOFF_MS = [5_000, 10_000, 20_000] as const
const MAX_JITTER_MS = 1_000

/** One Google Ads MutateOperation, in Google's JSON (`{ campaignBudgetOperation: { create: { … } } }`). */
export type GoogleMutateOperation = Record<string, unknown>

/** One MutateOperationResponse: the operation's result by its kind (`{ campaignBudgetResult: { resourceName } }`). */
export type GoogleMutateResponse = Record<string, { resourceName?: string } | undefined>

export interface GoogleAdsMutateOptions {
  /** true = Google only checks the change (validate-only) and changes nothing. */
  validateOnly: boolean
  /** The ledger's operation name (default 'ads.mutate' / 'ads.mutate.check'). */
  operation?: string
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

export interface GoogleAdsMutateResult {
  /** One per operation, in order; empty for a check (Google returns nothing for validate-only). */
  responses: GoogleMutateResponse[]
  /** Operations spent (counted as Google counts them). */
  ops: number
  requestId: string | null
}

/**
 * A change Google did not make, or one nobody knows the outcome of:
 *   not_sent   Nexus sent nothing (the allowance, the gateway's rules, a lost sign-in, writes switched off)
 *   refused    Google answered with an error; the request was all or nothing, so it changed nothing
 *   unknown    Google did not answer, or failed on its side: the change may or may not have happened (UNKNOWN_OUTCOME)
 */
export class GoogleAdsWriteError extends Error {
  constructor(
    readonly failure: GoogleAdsFailure,
    readonly operation: string,
    readonly outcome: 'not_sent' | 'refused' | 'unknown',
    readonly opsSpent: number = 0,
  ) {
    super(failure.sentence)
    this.name = 'GoogleAdsWriteError'
  }
}

/** What a person reads when nobody knows whether Google made a change. */
export const UNKNOWN_OUTCOME = 'Sent to Google, but Google did not confirm whether it made the change. Nexus never sends it again '
  + 'by itself. Approving this request again first reads the account: the change is sent only if it is not there. '
  + 'google-ads-live shows the account now.'

const isRefusal = (err: unknown): err is GatewayRefusal => err instanceof Error && err.name === 'GatewayRefusal'
const isNoAnswer = (err: unknown): err is GatewayNoAnswer => err instanceof Error && err.name === 'GatewayNoAnswer'
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** `customers/{digits}` for a target, or a refusal before anything is sent. */
export function customerResource(target: GoogleAdsTarget): string {
  const digits = customerIdDigits(target.customerId)
  if (!digits) throw new GoogleAdsWriteError(localFailure('The Google Ads account id is not a customer id. Nothing was sent.', 'INVALID_CUSTOMER_ID'), 'ads.mutate', 'not_sent')
  return `customers/${digits}`
}

/**
 * Send one change (or Google's check of it) to one account. Resolves with Google's results; rejects with a
 * GoogleAdsWriteError whose `outcome` says whether anything can have changed.
 */
export async function mutateGoogleAds(
  target: GoogleAdsTarget,
  operations: GoogleMutateOperation[],
  options: GoogleAdsMutateOptions,
): Promise<GoogleAdsMutateResult> {
  const operation = options.operation ?? (options.validateOnly ? 'ads.mutate.check' : 'ads.mutate')
  const notSent = (sentence: string, code: string) => new GoogleAdsWriteError(localFailure(sentence, code), operation, 'not_sent')
  if (operations.length === 0) throw notSent('The change holds no operation. Nothing was sent.', 'EMPTY_CHANGE')
  if (operations.length > MAX_MUTATE_OPERATIONS) {
    throw notSent(`The change holds ${operations.length} operations, more than the ${MAX_MUTATE_OPERATIONS} Nexus sends at once. Split it. Nothing was sent.`, 'TOO_MANY_OPERATIONS')
  }
  const customer = customerResource(target)
  const login = target.loginCustomerId ? customerIdDigits(target.loginCustomerId) : null
  if (target.loginCustomerId && !login) throw notSent('The manager account id is not a customer id. Nothing was sent.', 'INVALID_CUSTOMER_ID')
  const customerId = customer.slice('customers/'.length)

  const reservation = await reserveOps(customerId, operations.length, new Date(), 'write')
  if (!reservation.ok) throw notSent(reservation.sentence, reservation.reason ?? 'OPS_REFUSED')

  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  const body = { mutateOperations: operations, partialFailure: false, validateOnly: options.validateOnly, responseContentType: 'RESOURCE_NAME_ONLY' }
  let attempts = 0
  let reached = 0
  let slowDowns = 0
  let transient = 0
  const settle = async () => {
    // Every attempt that reached Google counts every operation; the first was reserved.
    if (reached === 0) await releaseOps(customerId, operations.length, reservation.reservedAt, 'write')
    else if (reached > 1) await addSpentOps(customerId, (reached - 1) * operations.length, reservation.reservedAt, 'write')
  }
  for (;;) {
    attempts += 1
    let failure: GoogleAdsFailure
    let answered = false
    try {
      const response = await googleCall({
        connectionId: target.connectionId,
        operation,
        method: 'POST',
        url: `${GOOGLE_ADS_API_BASE}/${customer}/googleAds:mutate`,
        body,
        loginCustomerId: login,
        maxTransientRetries: 0,
        max429Retries: 0,
        timeoutMs: MUTATE_TIMEOUT_MS,
      })
      reached += 1
      answered = true
      const text = await response.text()
      if (response.ok) {
        await settle()
        let parsed: { mutateOperationResponses?: unknown } = {}
        try { parsed = text ? JSON.parse(text) : {} } catch { /* a check answers with nothing to read */ }
        const responses = Array.isArray(parsed.mutateOperationResponses) ? (parsed.mutateOperationResponses as GoogleMutateResponse[]) : []
        return { responses, ops: reached * operations.length, requestId: response.headers.get('request-id') }
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
      // No answer: the request may have reached Google, so it is counted.
      reached += 1
      failure = failureFromNoAnswer(err)
    }
    if (failure.quotaExhausted) await markQuotaExhausted()
    if (failure.retryKind === 'slow_down' && slowDowns < 1 && answered) {
      // Google refused it before changing anything: safe to send again, for a check and for a change.
      slowDowns += 1
      await sleep((failure.retryAfterMs ?? 30_000) + Math.floor(random() * MAX_JITTER_MS))
      continue
    }
    if (options.validateOnly && failure.retryKind === 'transient' && transient < CHECK_RETRIES) {
      await sleep(CHECK_BACKOFF_MS[transient] + Math.floor(random() * MAX_JITTER_MS))
      transient += 1
      continue
    }
    await settle()
    const spent = reached * operations.length
    // A real change with no answer, or a server-side failure (5xx, INTERNAL, DEADLINE_EXCEEDED …): Google may have
    // committed it before failing to say so. Nobody knows; it is never sent again by Nexus.
    if (!options.validateOnly && (!answered || failure.retryKind === 'transient')) {
      const unknown: GoogleAdsFailure = { ...failure, sentence: UNKNOWN_OUTCOME }
      throw new GoogleAdsWriteError(unknown, operation, 'unknown', spent)
    }
    throw new GoogleAdsWriteError(failure, operation, answered ? 'refused' : 'not_sent', spent)
  }
}

/**
 * A live read a change stands on (its "now"), on the account's change allowance: one operation per query, reserved
 * first. Rows as Google sends them.
 */
export async function liveRows<Row>(target: GoogleAdsTarget, query: string, operation = 'ads.search.live'): Promise<Row[]> {
  const customerId = customerIdDigits(target.customerId)
  if (!customerId) throw new GoogleAdsReadError(localFailure('The Google Ads account id is not a customer id. Nothing was sent.', 'INVALID_CUSTOMER_ID'), operation)
  const reservation = await reserveOps(customerId, 1, new Date(), 'write')
  if (!reservation.ok) throw new GoogleAdsReadError(localFailure(reservation.sentence, reservation.reason ?? 'OPS_REFUSED'), operation)
  let spent = 0
  try {
    const { rows, ops } = await searchRows<Row>(target, query, { operation })
    spent = ops
    return rows
  } catch (err) {
    spent = err instanceof GoogleAdsReadError ? err.opsSpent : 1
    throw err
  } finally {
    if (spent === 0) await releaseOps(customerId, 1, reservation.reservedAt, 'write')
    else if (spent > 1) await addSpentOps(customerId, spent - 1, reservation.reservedAt, 'write')
  }
}

/** The sentence a person reads for a refused change, with the first place Google named. */
export function writeErrorSentence(err: unknown): string {
  if (err instanceof GoogleAdsWriteError || err instanceof GoogleAdsReadError) {
    const first = err.failure.errors.find((e) => e.path || e.message)
    const where = first?.path ? ` (at ${first.path}${first.trigger ? `, value "${first.trigger}"` : ''})` : ''
    if (err instanceof GoogleAdsWriteError && err.outcome === 'refused' && first?.message && !err.failure.permissionDenied && !err.failure.authLost) {
      const more = err.failure.errors.length > 1 ? ` (${err.failure.errors.length - 1} more error${err.failure.errors.length === 2 ? '' : 's'})` : ''
      return `Google Ads refused it: ${first.message}${where}${more}. Nothing was changed.`
    }
    return err.message
  }
  return err instanceof Error ? err.message : String(err)
}

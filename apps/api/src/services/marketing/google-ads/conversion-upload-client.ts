/**
 * Google Ads programme 2, G8a (2026-10-15) — the two calls that send sales to Google, through the channel gateway
 * (`googleCall`, channel GOOGLE: the account's token and state, the rate bucket, one ledger row per call; the gateway
 * judges each body: gateway/channels.ts googleDataManagerBodyOf, googleAdjustmentBodyOf):
 *
 *   POST https://datamanager.googleapis.com/v1/events:ingest
 *        { destinations: [{ operatingAccount: { accountType: GOOGLE_ADS, accountId }, loginAccount?, productDestinationId }],
 *          events, encoding: HEX, validateOnly }
 *        Data Manager API (developers.google.com/data-manager/api/reference/rest/v1/events/ingest): all or nothing
 *        (an invalid field refuses the request), validateOnly = Google's check; the answer is { requestId, fieldWarnings }
 *        and the events are processed in the background. Scope https://www.googleapis.com/auth/datamanager. Not a Google
 *        Ads API call: it spends none of the Google Ads operations allowance.
 *   POST {GOOGLE_ADS_API_BASE}/customers/{id}:uploadConversionAdjustments
 *        { conversionAdjustments, partialFailure: true, validateOnly }
 *        Google Ads API ConversionAdjustmentUploadService (…/rpc/v25/UploadConversionAdjustmentsRequest): each adjustment
 *        is taken or refused on its own (partial_failure "should always be set to true"); the refused ones are in
 *        partialFailureError, located by conversion_adjustments[index]. One request = one operation of the Google Ads
 *        allowance (…/docs/best-practices/quotas: "any request that is not a Mutate, Search or SearchStream counts as one").
 *
 * Retries as write-client.ts: a check is retried like a read (temporary problem: 3 times); a real send only after a
 * "slow down" (Google took nothing). No answer, or a failure on Google's side, is an UNKNOWN outcome Nexus never sends
 * again by itself. Never logs a token, a request body or a row.
 */
import { googleCall } from '../../gateway/google.js'
import type { GatewayNoAnswer, GatewayRefusal } from '../../gateway/gateway.js'
import { DATA_MANAGER_INGEST_URL } from '../../gateway/channels.js'
import { GOOGLE_ADS_API_BASE } from '../../google/api-version.js'
import { failureFromGatewayRefusal, failureFromNoAnswer, localFailure, parseGoogleAdsFailure, type GoogleAdsFailure } from './errors.js'
import { customerIdDigits } from './mappers.js'
import { addSpentOps, markQuotaExhausted, releaseOps, reserveOps } from './ops-budget.js'
import { customerResource, GoogleAdsWriteError, UNKNOWN_OUTCOME, type GoogleMutateOperation } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

export const DATA_MANAGER_SCOPE = 'https://www.googleapis.com/auth/datamanager'
/** Google's limit per request (events, adjustments). */
export const MAX_EVENTS_PER_REQUEST = 2000

const TIMEOUT_MS = 120_000
const CHECK_RETRIES = 3
const CHECK_BACKOFF_MS = [5_000, 10_000, 20_000] as const
const MAX_JITTER_MS = 1_000
const SLOW_DOWN_MS = 30_000

const isRefusal = (err: unknown): err is GatewayRefusal => err instanceof Error && err.name === 'GatewayRefusal'
const isNoAnswer = (err: unknown): err is GatewayNoAnswer => err instanceof Error && err.name === 'GatewayNoAnswer'
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

export interface SendOptions { validateOnly: boolean; sleep?: (ms: number) => Promise<void>; random?: () => number }

/**
 * A Data Manager API error → a failure a person reads. Google's envelope is the standard one; its details hold
 * google.rpc.ErrorInfo (reason) and google.rpc.BadRequest (fieldViolations: field, description, reason).
 */
export function dataManagerFailure(httpStatus: number, text: string, headers?: Headers | null): GoogleAdsFailure {
  const out = parseGoogleAdsFailure(httpStatus, text, headers)
  let error: Record<string, unknown> | null = null
  try { const parsed = text ? JSON.parse(text) : null; error = record(parsed) && record(parsed.error) ? parsed.error : null } catch { error = null }
  const details = error && Array.isArray(error.details) ? error.details.filter(record) : []
  const reason = details.map((d) => (String(d['@type'] ?? '').endsWith('google.rpc.ErrorInfo') ? d.reason : null)).find((r) => typeof r === 'string') as string | undefined
  const violations = details.flatMap((d) => (String(d['@type'] ?? '').endsWith('google.rpc.BadRequest') && Array.isArray(d.fieldViolations) ? d.fieldViolations.filter(record) : []))
  for (const v of violations) {
    out.errors.push({ group: 'dataManager', code: typeof v.reason === 'string' ? v.reason : 'INVALID_ARGUMENT', message: typeof v.description === 'string' ? v.description : (typeof v.reason === 'string' ? v.reason : null), path: typeof v.field === 'string' ? v.field : null })
  }
  const message = typeof error?.message === 'string' ? error.message : ''
  if (reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' || /insufficient authentication scopes/i.test(message)) {
    out.permissionDenied = true
    out.sentence = `The Google sign-in has not given Nexus the Data Manager permission (${DATA_MANAGER_SCOPE}): Nexus must ask for it when Google is connected, and a person signs in to Google again. Nothing was sent.`
  } else if (reason === 'SERVICE_DISABLED' || /has not been used in project|is disabled/i.test(message)) {
    out.permissionDenied = true
    out.sentence = 'The Data Manager API is not enabled in Nexus\'s Google Cloud project: enable it (Google Cloud console › APIs & Services › Data Manager API), then ask again. Nothing was sent.'
  } else if (violations.length) {
    const first = out.errors.find((e) => e.group === 'dataManager')!
    out.sentence = `Google's Data Manager API refused it: ${first.message}${first.path ? ` (at ${first.path})` : ''}${violations.length > 1 ? ` (${violations.length - 1} more)` : ''}. Nothing was sent.`
  } else if (out.sentence.startsWith('Google Ads')) {
    out.sentence = out.sentence.replace(/^Google Ads/, 'Google\'s Data Manager API')
  }
  return out
}

/**
 * Send sales (Data Manager events) to ONE conversion action of ONE account, or let Google check them (validateOnly).
 * Resolves with Google's request id; rejects with a GoogleAdsWriteError whose `outcome` says whether anything can have
 * been taken.
 */
export async function ingestSales(
  target: GoogleAdsTarget,
  conversionActionId: string,
  events: GoogleMutateOperation[],
  options: SendOptions,
): Promise<{ requestId: string | null; warnings: string[] }> {
  const operation = options.validateOnly ? 'datamanager.events.ingest.check' : 'datamanager.events.ingest'
  const notSent = (sentence: string, code: string) => new GoogleAdsWriteError(localFailure(sentence, code), operation, 'not_sent')
  if (!events.length) throw notSent('The upload holds no sale. Nothing was sent.', 'EMPTY_CHANGE')
  if (events.length > MAX_EVENTS_PER_REQUEST) throw notSent(`Google takes at most ${MAX_EVENTS_PER_REQUEST} sales in one request. Nothing was sent.`, 'TOO_MANY_OPERATIONS')
  if (!/^\d{1,20}$/.test(conversionActionId)) throw notSent('The conversion action id is not a Google id. Nothing was sent.', 'INVALID_ID')
  const customerId = customerResource(target).slice('customers/'.length)
  const login = target.loginCustomerId ? customerIdDigits(target.loginCustomerId) : null
  if (target.loginCustomerId && !login) throw notSent('The manager account id is not a customer id. Nothing was sent.', 'INVALID_CUSTOMER_ID')
  const body = {
    destinations: [{
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: customerId },
      ...(login && login !== customerId ? { loginAccount: { accountType: 'GOOGLE_ADS', accountId: login } } : {}),
      productDestinationId: conversionActionId,
    }],
    events,
    encoding: 'HEX',
    validateOnly: options.validateOnly,
  }
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  let slowDowns = 0
  let transient = 0
  for (;;) {
    let failure: GoogleAdsFailure
    let answered = false
    try {
      const response = await googleCall({ connectionId: target.connectionId, operation, method: 'POST', url: DATA_MANAGER_INGEST_URL, body, maxTransientRetries: 0, max429Retries: 0, timeoutMs: TIMEOUT_MS })
      answered = true
      const text = await response.text()
      if (response.ok) {
        let parsed: Record<string, unknown> = {}
        try { parsed = text ? JSON.parse(text) : {} } catch { /* an answer without a body */ }
        const warnings = Array.isArray(parsed.fieldWarnings)
          ? parsed.fieldWarnings.filter(record).map((w) => `${typeof w.description === 'string' ? w.description : w.reason ?? 'warning'}${typeof w.field === 'string' ? ` (at ${w.field})` : ''}`)
          : []
        return { requestId: typeof parsed.requestId === 'string' ? parsed.requestId : null, warnings }
      }
      failure = dataManagerFailure(response.status, text, response.headers)
    } catch (err) {
      if (isRefusal(err)) throw new GoogleAdsWriteError(failureFromGatewayRefusal(err), operation, 'not_sent')
      if (!isNoAnswer(err)) throw err
      failure = failureFromNoAnswer(err)
    }
    if (failure.retryKind === 'slow_down' && slowDowns < 1 && answered) {
      slowDowns += 1
      await sleep(Math.max(SLOW_DOWN_MS, failure.retryAfterMs ?? 0) + Math.floor(random() * MAX_JITTER_MS))
      continue
    }
    if (options.validateOnly && failure.retryKind === 'transient' && transient < CHECK_RETRIES) {
      await sleep(CHECK_BACKOFF_MS[transient] + Math.floor(random() * MAX_JITTER_MS))
      transient += 1
      continue
    }
    if (!options.validateOnly && (!answered || failure.retryKind === 'transient')) {
      throw new GoogleAdsWriteError({ ...failure, sentence: UNKNOWN_OUTCOME }, operation, 'unknown')
    }
    throw new GoogleAdsWriteError(failure, operation, answered ? 'refused' : 'not_sent')
  }
}

/** Google's time format for adjustments ("yyyy-mm-dd hh:mm:ss+|-hh:mm"), in UTC. */
export const googleDateTime = (d: Date): string => `${d.toISOString().slice(0, 19).replace('T', ' ')}+00:00`

/** The result of one adjustment: taken, or refused with Google's words. */
export type AdjustmentResult = { ok: true } | { ok: false; why: string }

/**
 * Upload conversion adjustments (retractions, restatements) to ONE account, or let Google check them (validateOnly).
 * Each gets its adjustment time now (the time is not part of what a person approves). Resolves with one result per
 * adjustment; rejects with a GoogleAdsWriteError when the whole request failed.
 */
export async function uploadAdjustments(
  target: GoogleAdsTarget,
  adjustments: GoogleMutateOperation[],
  options: SendOptions & { now?: Date },
): Promise<{ results: AdjustmentResult[] }> {
  const operation = options.validateOnly ? 'ads.conversionAdjustments.check' : 'ads.conversionAdjustments'
  const notSent = (sentence: string, code: string) => new GoogleAdsWriteError(localFailure(sentence, code), operation, 'not_sent')
  if (!adjustments.length) throw notSent('The change holds no adjustment. Nothing was sent.', 'EMPTY_CHANGE')
  if (adjustments.length > MAX_EVENTS_PER_REQUEST) throw notSent(`Google takes at most ${MAX_EVENTS_PER_REQUEST} adjustments in one request. Nothing was sent.`, 'TOO_MANY_OPERATIONS')
  const customer = customerResource(target)
  const customerId = customer.slice('customers/'.length)
  const login = target.loginCustomerId ? customerIdDigits(target.loginCustomerId) : null
  if (target.loginCustomerId && !login) throw notSent('The manager account id is not a customer id. Nothing was sent.', 'INVALID_CUSTOMER_ID')
  const reservation = await reserveOps(customerId, 1, new Date(), 'write')
  if (!reservation.ok) throw notSent(reservation.sentence, reservation.reason ?? 'OPS_REFUSED')
  const at = googleDateTime(options.now ?? new Date())
  const body = { conversionAdjustments: adjustments.map((a) => ({ ...a, adjustmentDateTime: at })), partialFailure: true, validateOnly: options.validateOnly }
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  let reached = 0
  let slowDowns = 0
  let transient = 0
  const settle = async () => {
    if (reached === 0) await releaseOps(customerId, 1, reservation.reservedAt, 'write')
    else if (reached > 1) await addSpentOps(customerId, reached - 1, reservation.reservedAt, 'write')
  }
  for (;;) {
    let failure: GoogleAdsFailure
    let answered = false
    try {
      const response = await googleCall({
        connectionId: target.connectionId, operation, method: 'POST', url: `${GOOGLE_ADS_API_BASE}/${customer}:uploadConversionAdjustments`,
        body, loginCustomerId: login, maxTransientRetries: 0, max429Retries: 0, timeoutMs: TIMEOUT_MS,
      })
      reached += 1
      answered = true
      const text = await response.text()
      if (response.ok) {
        await settle()
        let parsed: Record<string, unknown> = {}
        try { parsed = text ? JSON.parse(text) : {} } catch { /* nothing to read */ }
        const refused = new Map<number, string>()
        if (record(parsed.partialFailureError)) {
          const partial = parseGoogleAdsFailure(400, JSON.stringify({ error: parsed.partialFailureError }))
          for (const e of partial.errors) {
            if (e.operationIndex === null || e.operationIndex === undefined || refused.has(e.operationIndex)) continue
            refused.set(e.operationIndex, `${e.message ?? e.code} (${e.code})`)
          }
          // A partial failure that names no adjustment refuses them all.
          if (!refused.size) adjustments.forEach((_, i) => refused.set(i, partial.sentence))
        }
        return { results: adjustments.map((_, i) => (refused.has(i) ? { ok: false as const, why: refused.get(i)! } : { ok: true as const })) }
      }
      failure = parseGoogleAdsFailure(response.status, text, response.headers)
    } catch (err) {
      if (isRefusal(err)) {
        await settle()
        throw new GoogleAdsWriteError(failureFromGatewayRefusal(err), operation, 'not_sent', reached)
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
      slowDowns += 1
      await sleep((failure.retryAfterMs ?? SLOW_DOWN_MS) + Math.floor(random() * MAX_JITTER_MS))
      continue
    }
    if (options.validateOnly && failure.retryKind === 'transient' && transient < CHECK_RETRIES) {
      await sleep(CHECK_BACKOFF_MS[transient] + Math.floor(random() * MAX_JITTER_MS))
      transient += 1
      continue
    }
    await settle()
    if (!options.validateOnly && (!answered || failure.retryKind === 'transient')) {
      throw new GoogleAdsWriteError({ ...failure, sentence: UNKNOWN_OUTCOME }, operation, 'unknown', reached)
    }
    throw new GoogleAdsWriteError(failure, operation, answered ? 'refused' : 'not_sent', reached)
  }
}

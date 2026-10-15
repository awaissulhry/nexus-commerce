/**
 * Google Ads changes, G9 (2026-10-15) — the actions of ExperimentService and CampaignDraftService that are not a
 * GoogleAdsService.Mutate, through the channel gateway (`googleCall`, channel GOOGLE: the account's token and state, the
 * rate bucket, one ledger row per call):
 *
 *   POST {GOOGLE_ADS_API_BASE}/customers/{id}/experiments/{experimentId}:scheduleExperiment   body { validateOnly }
 *   POST {GOOGLE_ADS_API_BASE}/customers/{id}/experiments/{experimentId}:endExperiment        body { validateOnly }
 *   POST {GOOGLE_ADS_API_BASE}/customers/{id}/experiments/{experimentId}:promoteExperiment    body { validateOnly }
 *   POST {GOOGLE_ADS_API_BASE}/customers/{id}/experiments/{experimentId}:graduateExperiment   body { campaignBudgetMappings, validateOnly }
 *   POST {GOOGLE_ADS_API_BASE}/customers/{id}/campaignDrafts/{baseId}~{draftId}:promote        body { validateOnly }
 *
 * Checked 2026-10-15 in the v25 protos the v25 reference links (googleapis google/ads/googleads/v25/services/
 * experiment_service.proto, campaign_draft_service.proto): each request has `validate_only` (Google checks it and
 * changes nothing); ScheduleExperiment, PromoteExperiment and PromoteCampaignDraft answer a long-running operation
 * (`google.longrunning.Operation`, its `name` is `customers/{id}/operations/{…}`): Google goes on working after it
 * answered, and the work is done only when Google says so (experiment.status / promote_status, campaign_draft.status, or
 * the operation's `done`). EndExperiment and GraduateExperiment answer Empty: done when Google answered.
 *
 * A change is one pseudo-operation in the draft (`{ scheduleExperiment: { resourceName } }`, `{ graduateExperiment:
 * { resourceName, campaignBudgetMappings } }`, `{ promoteCampaignDraft: { resourceName } }` …): the plan the person
 * approves, sent as exactly one request. Like a mutate (write-client.ts): one operation is reserved on the account's
 * change allowance first; a check is retried like a read; a real change only after Google said "slow down"; no answer,
 * or a failure on Google's side, is an UNKNOWN outcome that Nexus never sends again by itself. Never logs a token, a
 * request body or a row.
 */
import { googleCall } from '../../gateway/google.js'
import type { GatewayNoAnswer, GatewayRefusal } from '../../gateway/gateway.js'
import type { GoogleExperimentAction } from '../../gateway/channels.js'
import { GOOGLE_ADS_API_BASE } from '../../google/api-version.js'
import {
  failureFromGatewayRefusal, failureFromNoAnswer, GoogleAdsReadError, localFailure, parseGoogleAdsFailure, type GoogleAdsFailure,
} from './errors.js'
import { customerIdDigits } from './mappers.js'
import { addSpentOps, markQuotaExhausted, releaseOps, reserveOps, type OpsLane } from './ops-budget.js'
import { customerResource, GoogleAdsWriteError, UNKNOWN_OUTCOME, type GoogleMutateOperation, type GoogleMutateResponse } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

const TIMEOUT_MS = 120_000
const MAX_JITTER_MS = 1_000
const CHECK_RETRIES = 3
const CHECK_BACKOFF_MS = [5_000, 10_000, 20_000] as const

export const EXPERIMENT_ACTIONS: readonly GoogleExperimentAction[] = ['scheduleExperiment', 'endExperiment', 'promoteExperiment', 'graduateExperiment', 'promoteCampaignDraft']

/** The result keys a run reads: what was acted on, and Google's long-running operation when it gave one. */
export const EXPERIMENT_ACTION_RESULT = 'experimentActionResult'
export const LONG_RUNNING_OPERATION = 'longRunningOperation'

const isRefusal = (err: unknown): err is GatewayRefusal => err instanceof Error && err.name === 'GatewayRefusal'
const isNoAnswer = (err: unknown): err is GatewayNoAnswer => err instanceof Error && err.name === 'GatewayNoAnswer'
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface ActionCall { action: GoogleExperimentAction; resourceName: string; body: Record<string, unknown> }

/** The one action a draft's pseudo-operation names, or why it is not one. */
export function experimentActionOf(customer: string, operation: GoogleMutateOperation): ActionCall | { refusal: string } {
  const keys = Object.keys(operation)
  const action = keys[0] as GoogleExperimentAction
  if (keys.length !== 1 || !EXPERIMENT_ACTIONS.includes(action)) return { refusal: `not an experiment or draft action (${keys.join(', ') || 'none'})` }
  const value = (operation[action] ?? {}) as { resourceName?: unknown; campaignBudgetMappings?: unknown }
  const name = typeof value.resourceName === 'string' ? value.resourceName : ''
  const pattern = action === 'promoteCampaignDraft' ? new RegExp(`^${customer}/campaignDrafts/\\d{1,20}~\\d{1,20}$`) : new RegExp(`^${customer}/experiments/\\d{1,20}$`)
  if (!pattern.test(name)) return { refusal: 'it does not name an experiment or a draft of this account' }
  const body: Record<string, unknown> = action === 'graduateExperiment' ? { campaignBudgetMappings: value.campaignBudgetMappings } : {}
  return { action, resourceName: name, body }
}

const pathOf = (call: ActionCall) => `${call.resourceName}:${call.action === 'promoteCampaignDraft' ? 'promote' : call.action}`

/**
 * Send ONE experiment or campaign draft action (or Google's check of it: `validateOnly`) to one account. Resolves with
 * one response: `{ experimentActionResult: { resourceName } }` and, for a long-running one, `{ longRunningOperation:
 * { resourceName: <operation name> } }`; rejects with a GoogleAdsWriteError whose `outcome` says whether anything can
 * have changed.
 */
export async function sendExperimentAction(
  target: GoogleAdsTarget,
  operations: GoogleMutateOperation[],
  options: { validateOnly: boolean; sleep?: (ms: number) => Promise<void>; random?: () => number },
): Promise<{ responses: GoogleMutateResponse[]; ops: number }> {
  const label = (a: string) => `ads.experiments.${a}${options.validateOnly ? '.check' : ''}`
  const notSent = (sentence: string, code: string, op = label('action')) => new GoogleAdsWriteError(localFailure(sentence, code), op, 'not_sent')
  if (operations.length !== 1) throw notSent('An experiment or draft action is one request of one action. Nothing was sent.', 'ONE_ACTION')
  const customer = customerResource(target)
  const call = experimentActionOf(customer, operations[0])
  if ('refusal' in call) throw notSent(`Not sent: ${call.refusal}. Nothing was sent.`, 'NOT_AN_ACTION')
  const operation = label(call.action)
  const login = target.loginCustomerId ? customerIdDigits(target.loginCustomerId) : null
  if (target.loginCustomerId && !login) throw notSent('The manager account id is not a customer id. Nothing was sent.', 'INVALID_CUSTOMER_ID', operation)
  const customerId = customer.slice('customers/'.length)

  const reservation = await reserveOps(customerId, 1, new Date(), 'write')
  if (!reservation.ok) throw notSent(reservation.sentence, reservation.reason ?? 'OPS_REFUSED', operation)
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  const body = { ...call.body, validateOnly: options.validateOnly }
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
        connectionId: target.connectionId,
        operation,
        method: 'POST',
        url: `${GOOGLE_ADS_API_BASE}/${pathOf(call)}`,
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
        let parsed: { name?: unknown } = {}
        try { parsed = text ? JSON.parse(text) : {} } catch { /* Empty answers with nothing to read */ }
        const longRunning = typeof parsed.name === 'string' && parsed.name.startsWith(`${customer}/operations/`) ? parsed.name : null
        return {
          responses: [{ [EXPERIMENT_ACTION_RESULT]: { resourceName: call.resourceName }, ...(longRunning ? { [LONG_RUNNING_OPERATION]: { resourceName: longRunning } } : {}) }],
          ops: reached,
        }
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
      // Google refused it before changing anything: safe to send again once, a check or a change.
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
    if (!options.validateOnly && (!answered || failure.retryKind === 'transient')) {
      throw new GoogleAdsWriteError({ ...failure, sentence: UNKNOWN_OUTCOME }, operation, 'unknown', reached)
    }
    throw new GoogleAdsWriteError(failure, operation, answered ? 'refused' : 'not_sent', reached)
  }
}

// ── reads: a long-running operation, the async errors of an experiment or a draft ─────────────────────────────

/**
 * One GET to Google Ads (a read: the gateway lets every GET through as one), on the given allowance lane, one operation
 * reserved first. `path` is a resource of THIS account (`customers/{id}/…`).
 */
async function getJson<T>(target: GoogleAdsTarget, path: string, operation: string, lane: OpsLane): Promise<T> {
  const customer = customerResource(target)
  if (!path.startsWith(`${customer}/`) || /[?#\s]/.test(path)) throw new GoogleAdsReadError(localFailure('Not read: the path is not of this account. Nothing was sent.', 'NOT_THIS_ACCOUNT'), operation)
  const customerId = customer.slice('customers/'.length)
  const login = target.loginCustomerId ? customerIdDigits(target.loginCustomerId) : null
  const reservation = await reserveOps(customerId, 1, new Date(), lane)
  if (!reservation.ok) throw new GoogleAdsReadError(localFailure(reservation.sentence, reservation.reason ?? 'OPS_REFUSED'), operation)
  let reached = 0
  try {
    const response = await googleCall({ connectionId: target.connectionId, operation, method: 'GET', url: `${GOOGLE_ADS_API_BASE}/${path}`, loginCustomerId: login, maxTransientRetries: 1, max429Retries: 1, timeoutMs: 30_000 })
    reached = 1
    const text = await response.text()
    if (!response.ok) throw new GoogleAdsReadError(parseGoogleAdsFailure(response.status, text, response.headers), operation, 1)
    try { return (text ? JSON.parse(text) : {}) as T } catch { throw new GoogleAdsReadError(localFailure('Google Ads answered with something Nexus cannot read.', 'UNREADABLE_ANSWER'), operation, 1) }
  } catch (err) {
    if (err instanceof GoogleAdsReadError) throw err
    if (isRefusal(err)) throw new GoogleAdsReadError(failureFromGatewayRefusal(err), operation)
    if (isNoAnswer(err)) { reached = 1; throw new GoogleAdsReadError(failureFromNoAnswer(err), operation, 1) }
    throw err
  } finally {
    if (reached === 0) await releaseOps(customerId, 1, reservation.reservedAt, lane)
  }
}

export interface LongRunningState {
  name: string
  /** Google says the work is over (then `error` says whether it failed). */
  done: boolean
  error: string | null
}

/** A long-running operation as Google has it now (google.longrunning.Operation: name, done, error). */
export async function readLongRunningOperation(target: GoogleAdsTarget, name: string, lane: OpsLane = 'live'): Promise<LongRunningState> {
  const answer = await getJson<{ name?: unknown; done?: unknown; error?: { message?: unknown } }>(target, name, 'ads.operations.get', lane)
  return { name, done: answer.done === true, error: answer.error && typeof answer.error.message === 'string' ? answer.error.message : answer.error ? 'Google reported an error.' : null }
}

/**
 * The async errors Google kept for an experiment's schedule or promote (ListExperimentAsyncErrors) or a draft's promote
 * (ListCampaignDraftAsyncErrors): the first page, at most `max` sentences.
 */
export async function readAsyncErrors(target: GoogleAdsTarget, resourceName: string, kind: 'experiment' | 'draft', max = 20, lane: OpsLane = 'live'): Promise<string[]> {
  const path = `${resourceName}:${kind === 'experiment' ? 'listExperimentAsyncErrors' : 'listAsyncErrors'}`
  const answer = await getJson<{ errors?: Array<{ message?: unknown }> }>(target, path, `ads.${kind}s.asyncErrors`, lane)
  return (Array.isArray(answer.errors) ? answer.errors : []).slice(0, max).map((e) => (typeof e?.message === 'string' ? e.message : 'Google reported an error without a message.'))
}

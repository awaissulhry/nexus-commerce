/**
 * Google Ads programme 2, G8b (2026-10-15) — the account calls: who may use the account, its links and its billing, each
 * its own Google Ads service method (gateway/google-account-calls.ts lists the paths and the bodies the gateway lets
 * through), sent through the channel gateway (`googleCall`, channel GOOGLE: the account's token and state, the rate
 * bucket, one ledger row).
 *
 *   POST {GOOGLE_ADS_API_BASE}/customers/{customerId}/{path}     body: the request message without customer_id
 *
 * One call is ONE operation (each of these methods takes one), reserved on the account's change allowance first, like a
 * mutate (write-client.ts). A "slow down" is sent again once (Google changed nothing); no answer, or a failure on Google's
 * side, is an UNKNOWN outcome Nexus never sends again by itself. Two methods have validate_only (RemoveProductLink,
 * MutateAccountBudgetProposal): their check goes as a read and changes nothing.
 *
 * Answers (v25 service protos): MutateCustomerUserAccess(Invitation)Response { result { resource_name,
 * multi_party_auth_review } } — Google may hold a user change for a second administrator (multi-party approval: then
 * resource_name is empty and multi_party_auth_review names the review, developers.google.com/google-ads/api/docs/
 * account-management/managing-users); MutateBillingSetupResponse / MutateAccountBudgetProposalResponse { result {
 * resource_name } }; the link methods answer { resource_name }.
 *
 * Access: Google's Explorer access level does not allow CustomerUserAccessService, CustomerUserAccessInvitationService,
 * BillingSetupService or AccountBudgetProposalService (developers.google.com/google-ads/api/docs/api-policy/access-levels,
 * "Restricted Services and Methods", read 2026-10-15). A refusal of these for access is said plainly, with Google's own
 * code and words — never a success. Never logs a token, a request body or a row.
 */
import { googleCall } from '../../gateway/google.js'
import type { GatewayNoAnswer, GatewayRefusal } from '../../gateway/gateway.js'
import { GOOGLE_ACCOUNT_CHECKABLE, type GoogleAccountCallPath } from '../../gateway/google-account-calls.js'
import { GOOGLE_ADS_API_BASE } from '../../google/api-version.js'
import { failureFromGatewayRefusal, failureFromNoAnswer, localFailure, parseGoogleAdsFailure, type GoogleAdsFailure } from './errors.js'
import { customerIdDigits } from './mappers.js'
import { addSpentOps, markQuotaExhausted, releaseOps, reserveOps } from './ops-budget.js'
import { customerResource, GoogleAdsWriteError, UNKNOWN_OUTCOME, type GoogleMutateOperation, type GoogleMutateResponse } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

const TIMEOUT_MS = 120_000
const MAX_JITTER_MS = 1_000

/** The key of an account call in a change's operations (`{ accountCall: { path, body } }`): ONE per change. */
export const ACCOUNT_CALL = 'accountCall'
/** The result keys a run reads (`{ accountResult: { resourceName }, accountReview?: { resourceName } }`). */
export const ACCOUNT_RESULT = 'accountResult'
export const ACCOUNT_REVIEW = 'accountReview'

export interface AccountCall { path: GoogleAccountCallPath; body: Record<string, unknown> }

/** The services Google refuses at the Explorer access level, and where a person does the same in Google Ads. */
const RESTRICTED: Partial<Record<GoogleAccountCallPath, { what: string; where: string }>> = {
  'customerUserAccessInvitations:mutate': { what: 'user management', where: 'Google Ads › Admin › Access and security' },
  'customerUserAccesses:mutate': { what: 'user management', where: 'Google Ads › Admin › Access and security' },
  'billingSetups:mutate': { what: 'billing setups', where: 'Google Ads › Billing › Settings' },
  'accountBudgetProposals:mutate': { what: 'account budgets', where: 'Google Ads › Billing › Account budgets' },
}

const isRefusal = (err: unknown): err is GatewayRefusal => err instanceof Error && err.name === 'GatewayRefusal'
const isNoAnswer = (err: unknown): err is GatewayNoAnswer => err instanceof Error && err.name === 'GatewayNoAnswer'
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The account call of a change's operations, or a refusal before anything is sent. */
export function accountCallOf(operations: GoogleMutateOperation[], operation = 'ads.account'): AccountCall {
  const call = operations.length === 1 ? (operations[0][ACCOUNT_CALL] as AccountCall | undefined) : undefined
  if (!call || typeof call.path !== 'string' || !call.body || typeof call.body !== 'object') {
    throw new GoogleAdsWriteError(localFailure('An account change is ONE call. Nothing was sent.', 'NOT_ONE_ACCOUNT_CALL'), operation, 'not_sent')
  }
  return call
}

/**
 * Google's refusal for access, in words: its own code and message, and — for the services the Explorer access level
 * does not allow — what that means and where a person does it instead. Anything else stays Google's sentence.
 */
export function accessRefusal(path: GoogleAccountCallPath, failure: GoogleAdsFailure): GoogleAdsFailure {
  const restricted = RESTRICTED[path]
  if (!failure.permissionDenied || !restricted) return failure
  const first = failure.errors.find((e) => e.message) ?? failure.errors[0]
  const google = first ? `${first.code}${first.message ? `: ${first.message}` : ''}` : (failure.status ?? `HTTP ${failure.httpStatus}`)
  return {
    ...failure,
    sentence: `Google refused it (${google}). Either the Google login Nexus uses is not an administrator of this Google Ads account, `
      + `or Nexus's Google Cloud project is still at the Explorer access level, at which Google does not allow ${restricted.what} through the API `
      + `(developers.google.com/google-ads/api/docs/api-policy/access-levels: Basic or Standard access is needed). Do it in ${restricted.where}. Nothing was changed.`,
  }
}

/**
 * Send ONE account call (or Google's check of it: `validateOnly`, only on the methods that have it). Resolves with the
 * resource name Google gave back and, for a user change Google holds for a second administrator, the review's name;
 * rejects with a GoogleAdsWriteError whose `outcome` says whether anything can have changed.
 */
export async function sendAccountCall(
  target: GoogleAdsTarget,
  call: AccountCall,
  options: { validateOnly?: boolean; sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
): Promise<{ resourceName: string | null; review: string | null }> {
  const check = options.validateOnly === true
  const operation = `ads.account.${call.path.replace(':', '.')}${check ? '.check' : ''}`
  const notSent = (sentence: string, code: string) => new GoogleAdsWriteError(localFailure(sentence, code), operation, 'not_sent')
  if (check && !GOOGLE_ACCOUNT_CHECKABLE.has(call.path)) throw notSent('Google cannot check this account change first (its method has no validate_only). Nothing was sent.', 'NO_CHECK')
  const customer = customerResource(target)
  const login = target.loginCustomerId ? customerIdDigits(target.loginCustomerId) : null
  if (target.loginCustomerId && !login) throw notSent('The manager account id is not a customer id. Nothing was sent.', 'INVALID_CUSTOMER_ID')
  const customerId = customer.slice('customers/'.length)
  // A check costs an operation like the change itself (write-client.ts): both on the change allowance.
  const lane = 'write' as const
  const reservation = await reserveOps(customerId, 1, new Date(), lane)
  if (!reservation.ok) throw notSent(reservation.sentence, reservation.reason ?? 'OPS_REFUSED')
  const sleep = options.sleep ?? defaultSleep
  const random = options.random ?? Math.random
  const body = check ? { ...call.body, validateOnly: true } : call.body
  let reached = 0
  let slowDowns = 0
  const settle = async () => {
    if (reached === 0) await releaseOps(customerId, 1, reservation.reservedAt, lane)
    else if (reached > 1) await addSpentOps(customerId, reached - 1, reservation.reservedAt, lane)
  }
  for (;;) {
    let failure: GoogleAdsFailure
    let answered = false
    try {
      const response = await googleCall({
        connectionId: target.connectionId,
        operation,
        method: 'POST',
        url: `${GOOGLE_ADS_API_BASE}/${customer}/${call.path}`,
        body,
        loginCustomerId: login,
        maxTransientRetries: 0,
        max429Retries: 0,
        timeoutMs: TIMEOUT_MS,
      })
      reached += 1
      answered = true
      const textBody = await response.text()
      if (response.ok) {
        await settle()
        let parsed: { resourceName?: unknown; result?: { resourceName?: unknown; multiPartyAuthReview?: unknown } } = {}
        try { parsed = textBody ? JSON.parse(textBody) : {} } catch { /* a check answers with nothing to read */ }
        const name = parsed.result?.resourceName ?? parsed.resourceName
        const review = parsed.result?.multiPartyAuthReview
        return { resourceName: typeof name === 'string' && name ? name : null, review: typeof review === 'string' && review ? review : null }
      }
      failure = accessRefusal(call.path, parseGoogleAdsFailure(response.status, textBody, response.headers))
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
      // Google refused it before changing anything: safe to send again once.
      slowDowns += 1
      await sleep((failure.retryAfterMs ?? 30_000) + Math.floor(random() * MAX_JITTER_MS))
      continue
    }
    await settle()
    // A check that got no answer judged nothing; a real change with no answer (or a failure on Google's side) may have
    // happened: nobody knows, and Nexus never sends it again by itself.
    if (!answered || failure.retryKind === 'transient') {
      if (check) throw new GoogleAdsWriteError(failure, operation, 'not_sent', reached)
      throw new GoogleAdsWriteError({ ...failure, sentence: UNKNOWN_OUTCOME }, operation, 'unknown', reached)
    }
    throw new GoogleAdsWriteError(failure, operation, 'refused', reached)
  }
}

/** The run's answer for a change of ONE account call, in the shape runGoogleChange hands `finish`. */
export async function sendAccountOperations(target: GoogleAdsTarget, operations: GoogleMutateOperation[]): Promise<{ responses: GoogleMutateResponse[] }> {
  const result = await sendAccountCall(target, accountCallOf(operations))
  return {
    responses: [{
      [ACCOUNT_RESULT]: { resourceName: result.resourceName ?? undefined },
      ...(result.review ? { [ACCOUNT_REVIEW]: { resourceName: result.review } } : {}),
    }],
  }
}

/** Google's check of a change of ONE account call (its method's validate_only). */
export const checkAccountOperations = (target: GoogleAdsTarget, operations: GoogleMutateOperation[]) =>
  sendAccountCall(target, accountCallOf(operations, 'ads.account.check'), { validateOnly: true })

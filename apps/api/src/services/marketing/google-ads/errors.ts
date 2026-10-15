/**
 * Google Ads step 1a — what a failed Google Ads call means, in one place: retry or not, the day's allowance used
 * up, the sign-in lost, an expired page token, a Cloud project approved for test accounts only, Google's request
 * id, and one plain sentence for a person.
 *
 * Google's REST error (the standard Google API error, the Google Ads failure inside it):
 *   { "error": { "code": 400, "message": "…", "status": "INVALID_ARGUMENT",
 *       "details": [ { "@type": "type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure",
 *                      "errors": [ { "errorCode": { "queryError": "…" }, "message": "…" } ], "requestId": "…" } ] } }
 * The error codes are the v25 enums (QuotaError, AuthenticationError, AuthorizationError, RequestError,
 * InternalError — developers.google.com/google-ads/api/reference/rpc/v25, checked 2026-10-13). The parse is
 * tolerant: a body without the wrapper, or without a failure, still gives a sentence from the HTTP status.
 */
import type { GatewayNoAnswer, GatewayRefusal } from '../../gateway/gateway.js'

export interface GoogleAdsErrorCode {
  /** The ErrorCode field, e.g. "quotaError", "authorizationError". */
  group: string
  /** The enum value, e.g. "RESOURCE_EXHAUSTED". */
  code: string
  message: string | null
  /**
   * A change (mutate): where in the request Google found it, as Google names the fields
   * ("mutate_operations[3].ad_group_ad_operation.create.ad.responsive_search_ad.headlines[2].text"); null when Google
   * names no place (a read, or a failure of the whole request).
   */
  path?: string | null
  /** A change: the index of the operation it is about (the first `[n]` of the path); null when none. */
  operationIndex?: number | null
  /** A change: the value Google refused, when it says (`trigger`). */
  trigger?: string | null
}

export interface GoogleAdsFailure {
  /** Where the failure came from: Google's answer, the Nexus gateway (nothing sent), or no answer at all. */
  origin: 'google' | 'gateway' | 'network'
  /** Google's HTTP status; 0 when Google did not answer. */
  httpStatus: number
  /** google.rpc status name (INVALID_ARGUMENT, RESOURCE_EXHAUSTED, …), or the gateway's refusal code. */
  status: string | null
  errors: GoogleAdsErrorCode[]
  /** The deciding code: the first Google Ads error code, else the status. */
  code: string | null
  requestId: string | null
  /** transient: retry after 5 s, 10 s, 20 s (+ jitter); slow_down: one retry after at least `retryAfterMs`. */
  retryKind: 'transient' | 'slow_down' | null
  retryable: boolean
  retryAfterMs: number | null
  /** The Cloud project's daily Google Ads operations are used up: no retry until Google's day turns. */
  quotaExhausted: boolean
  /** The Google sign-in no longer works: a person reconnects Google. */
  authLost: boolean
  pageTokenExpired: boolean
  /** The Nexus Cloud project is approved for test accounts only (v25 CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION). */
  notApprovedForProduction: boolean
  /** The login cannot reach this account (no access, wrong manager, account not enabled, …). */
  permissionDenied: boolean
  /** One plain sentence for a person. Never a token or a request body. */
  sentence: string
}

/** A Google Ads read that did not succeed. `message` is the failure's sentence. */
export class GoogleAdsReadError extends Error {
  constructor(readonly failure: GoogleAdsFailure, readonly operation: string, readonly opsSpent: number = 0) {
    super(failure.sentence)
    this.name = 'GoogleAdsReadError'
  }
}

const SLOW_DOWN_MS = 30_000
const MAX_GOOGLE_MESSAGE = 300

const AUTH_LOST = new Set([
  'OAUTH_TOKEN_REVOKED', 'OAUTH_TOKEN_EXPIRED', 'OAUTH_TOKEN_INVALID', 'OAUTH_TOKEN_DISABLED', 'OAUTH_TOKEN_HEADER_INVALID',
  'GOOGLE_ACCOUNT_DELETED', 'GOOGLE_ACCOUNT_AUTHENTICATION_FAILED', 'AUTHENTICATION_ERROR',
])
const TRANSIENT_CODES = new Set(['TRANSIENT_ERROR', 'INTERNAL_ERROR', 'DEADLINE_EXCEEDED'])
const TRANSIENT_STATUSES = new Set(['UNAVAILABLE', 'DEADLINE_EXCEEDED', 'INTERNAL', 'ABORTED'])

/** Sentences for the codes a person can act on. */
const SENTENCES: Readonly<Record<string, string>> = {
  RESOURCE_EXHAUSTED: 'Nexus has used up today\'s Google Ads API allowance. The read waits until Google\'s day turns; nothing was changed.',
  RESOURCE_TEMPORARILY_EXHAUSTED: 'Google Ads asked Nexus to slow down. Nexus tries again shortly.',
  EXCESSIVE_SHORT_TERM_QUERY_RESOURCE_CONSUMPTION: 'Google Ads asked Nexus to slow down. Nexus tries again shortly.',
  EXCESSIVE_LONG_TERM_QUERY_RESOURCE_CONSUMPTION: 'Google Ads says Nexus has sent too many heavy reports for this account lately. Nexus reads again tomorrow.',
  CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION: 'Google has approved the Nexus Google Cloud project for test accounts only. Apply for Explorer or Basic access in the Google Ads API Center, then read again.',
  DEVELOPER_TOKEN_NOT_APPROVED: 'Google has approved the Nexus Google Cloud project for test accounts only. Apply for Explorer or Basic access in the Google Ads API Center, then read again.',
  USER_PERMISSION_DENIED: 'This Google login has no access to this Google Ads account. If you reach it through a manager account, choose that manager.',
  INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION: 'The chosen manager account does not manage this Google Ads account. Choose the account again.',
  CUSTOMER_NOT_ENABLED: 'This Google Ads account is not active (not yet enabled, or closed).',
  ACCESS_DENIED_FOR_ACCOUNT_TYPE: 'This account is not a Google Ads account Nexus can read.',
  NOT_ADS_USER: 'This Google login does not use any Google Ads account. Sign in with a login that does.',
  CUSTOMER_NOT_FOUND: 'Google Ads found no account with this id for this login.',
  TWO_STEP_VERIFICATION_NOT_ENROLLED: 'The Google Ads account requires 2-Step Verification on this Google login. Turn it on, then reconnect Google.',
  ADVANCED_PROTECTION_NOT_ENROLLED: 'The Google Ads account requires Advanced Protection on this Google login. Turn it on, then reconnect Google.',
  PROJECT_DISABLED: 'The Nexus Google Cloud project cannot use the Google Ads API. Enable the Google Ads API in that project.',
  MISSING_TOS: 'The Google Ads API terms of service have not been accepted for the Nexus Google Cloud project.',
  METRIC_ACCESS_DENIED: 'Google Ads does not let this login read these numbers.',
  EXPIRED_PAGE_TOKEN: 'Google\'s page token expired while Nexus was reading. The read starts again.',
  INVALID_PAGE_TOKEN: 'Google\'s page token was refused while Nexus was reading. The read starts again.',
  UNSUPPORTED_VERSION: 'Google no longer supports the Google Ads API version Nexus uses. Nexus needs an update.',
}
const PERMISSION = new Set([
  'USER_PERMISSION_DENIED', 'INVALID_LOGIN_CUSTOMER_ID_SERVING_CUSTOMER_ID_COMBINATION', 'CUSTOMER_NOT_ENABLED', 'ACCESS_DENIED_FOR_ACCOUNT_TYPE',
  'NOT_ADS_USER', 'CUSTOMER_NOT_FOUND', 'TWO_STEP_VERIFICATION_NOT_ENROLLED', 'ADVANCED_PROTECTION_NOT_ENROLLED', 'PROJECT_DISABLED', 'MISSING_TOS',
  'METRIC_ACCESS_DENIED', 'SERVICE_ACCESS_DENIED', 'ACTION_NOT_PERMITTED', 'CLOUD_PROJECT_NOT_UNDER_ORGANIZATION', 'ORGANIZATION_NOT_APPROVED',
  'ORGANIZATION_NOT_RECOGNIZED',
])

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** "86400s" / "1.5s" (a protobuf Duration in JSON) → ms. */
function durationMs(value: unknown): number | null {
  const match = typeof value === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(value.trim()) : null
  return match ? Math.round(Number(match[1]) * 1000) : null
}

const clip = (message: string): string => (message.length > MAX_GOOGLE_MESSAGE ? `${message.slice(0, MAX_GOOGLE_MESSAGE - 1)}…` : message)

function base(origin: GoogleAdsFailure['origin'], httpStatus: number): GoogleAdsFailure {
  return {
    origin, httpStatus, status: null, errors: [], code: null, requestId: null, retryKind: null, retryable: false, retryAfterMs: null,
    quotaExhausted: false, authLost: false, pageTokenExpired: false, notApprovedForProduction: false, permissionDenied: false,
    sentence: '',
  }
}

/**
 * Where a change's error is (GoogleAdsError.location.fieldPathElements[{ fieldName, index }]) and the value it refused
 * (GoogleAdsError.trigger, a Value: `{ stringValue }`, `{ int64Value }` …).
 */
function errorPlace(item: Record<string, unknown>): { path: string | null; operationIndex: number | null; trigger: string | null } {
  const elements = record(item.location) && Array.isArray(item.location.fieldPathElements) ? item.location.fieldPathElements : []
  const parts: string[] = []
  let operationIndex: number | null = null
  for (const element of elements) {
    if (!record(element) || typeof element.fieldName !== 'string') continue
    const index = element.index === undefined || element.index === null ? null : Number(element.index)
    if (operationIndex === null && index !== null && Number.isInteger(index)) operationIndex = index
    parts.push(index !== null && Number.isInteger(index) ? `${element.fieldName}[${index}]` : element.fieldName)
  }
  const trigger = record(item.trigger) ? Object.values(item.trigger).find((v) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') : undefined
  return { path: parts.length ? parts.join('.') : null, operationIndex, trigger: trigger === undefined ? null : clip(String(trigger)) }
}

/** Google's error answer → what it means. `body` is the answer's text; `headers` give the request-id when the body has none. */
export function parseGoogleAdsFailure(httpStatus: number, body: string, headers?: Headers | null): GoogleAdsFailure {
  const out = base('google', httpStatus)
  let parsed: unknown = null
  try { parsed = body ? JSON.parse(body) : null } catch { parsed = null }
  if (Array.isArray(parsed)) parsed = parsed[0]
  const error = record(parsed) ? (record(parsed.error) ? parsed.error : parsed) : null
  const googleMessage = error && typeof error.message === 'string' ? error.message : null
  if (error && typeof error.status === 'string') out.status = error.status
  let retryDelayMs: number | null = null
  const details = error && Array.isArray(error.details) ? error.details : []
  for (const detail of details) {
    if (!record(detail)) continue
    const type = typeof detail['@type'] === 'string' ? detail['@type'] : ''
    if (type.endsWith('google.rpc.RetryInfo')) retryDelayMs = durationMs(detail.retryDelay) ?? retryDelayMs
    if (!type.endsWith('GoogleAdsFailure')) continue
    if (typeof detail.requestId === 'string' && detail.requestId) out.requestId = detail.requestId
    for (const item of Array.isArray(detail.errors) ? detail.errors : []) {
      if (!record(item) || !record(item.errorCode)) continue
      const [group, code] = Object.entries(item.errorCode).find(([, v]) => typeof v === 'string') ?? []
      if (typeof group === 'string' && typeof code === 'string') {
        const place = errorPlace(item)
        // A read's errors name no place: their shape stays { group, code, message }.
        out.errors.push({ group, code, message: typeof item.message === 'string' ? item.message : null, ...(place.path || place.trigger ? place : {}) })
      }
      const quotaDetails = record(item.details) && record(item.details.quotaErrorDetails) ? item.details.quotaErrorDetails : null
      if (quotaDetails) retryDelayMs = durationMs(quotaDetails.retryDelay) ?? retryDelayMs
    }
  }
  out.requestId ??= headers?.get('request-id') ?? null
  out.code = out.errors[0]?.code ?? out.status
  const codes = new Set(out.errors.map((e) => e.code))
  const has = (...names: string[]) => names.some((name) => codes.has(name))

  if (has('RESOURCE_EXHAUSTED')) {
    out.quotaExhausted = true
    out.retryAfterMs = retryDelayMs
  } else if (has('RESOURCE_TEMPORARILY_EXHAUSTED', 'EXCESSIVE_SHORT_TERM_QUERY_RESOURCE_CONSUMPTION') || (httpStatus === 429 && !has('EXCESSIVE_LONG_TERM_QUERY_RESOURCE_CONSUMPTION'))) {
    out.retryKind = 'slow_down'
    out.retryAfterMs = Math.max(SLOW_DOWN_MS, retryDelayMs ?? 0)
  } else if (has(...TRANSIENT_CODES) || TRANSIENT_STATUSES.has(out.status ?? '') || [500, 502, 503, 504].includes(httpStatus)) {
    out.retryKind = 'transient'
  }
  out.retryable = out.retryKind !== null
  out.authLost = httpStatus === 401 || out.errors.some((e) => e.group === 'authenticationError' && AUTH_LOST.has(e.code))
  out.pageTokenExpired = has('EXPIRED_PAGE_TOKEN', 'INVALID_PAGE_TOKEN')
  out.notApprovedForProduction = has('CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION', 'DEVELOPER_TOKEN_NOT_APPROVED')
  out.permissionDenied = !out.authLost && !out.notApprovedForProduction && (has(...PERMISSION) || (httpStatus === 403 && out.errors.length === 0))

  const known = out.errors.map((e) => SENTENCES[e.code]).find(Boolean)
  const firstMessage = out.errors.find((e) => e.message)?.message ?? googleMessage
  if (out.authLost) out.sentence = 'The Google sign-in no longer works (revoked or expired). Reconnect Google in Settings, Channels.'
  else if (known) out.sentence = known
  else if (out.retryKind === 'transient') out.sentence = 'Google Ads had a temporary problem. Nexus tries again.'
  else if (out.retryKind === 'slow_down') out.sentence = SENTENCES.RESOURCE_TEMPORARILY_EXHAUSTED
  else if (out.permissionDenied) out.sentence = 'Google Ads refused this login access to the account.'
  else if (firstMessage) out.sentence = `Google Ads refused the request: ${clip(firstMessage)}`
  else out.sentence = `Google Ads answered with an error (HTTP ${httpStatus}).`
  return out
}

/** The gateway sent nothing (account needs sign-in, local rate limit, read-only rule, …). */
export function failureFromGatewayRefusal(refusal: Pick<GatewayRefusal, 'code' | 'message' | 'statusCode' | 'retryAfterMs'>): GoogleAdsFailure {
  const out = base('gateway', 0)
  out.status = refusal.code
  out.code = refusal.code
  out.authLost = refusal.code === 'ACCOUNT_NEEDS_SIGNIN' || refusal.code === 'TOKEN_UNAVAILABLE'
  if (refusal.code === 'RATE_LIMITED_LOCAL') {
    out.retryKind = 'slow_down'
    out.retryable = true
    out.retryAfterMs = Math.max(1000, refusal.retryAfterMs ?? SLOW_DOWN_MS)
  }
  out.sentence = refusal.message
  return out
}

/** Google did not answer (network error or timeout): a transient failure. */
export function failureFromNoAnswer(error: Pick<GatewayNoAnswer, 'errorClass'>): GoogleAdsFailure {
  const out = base('network', 0)
  out.status = error.errorClass === 'timeout' ? 'TIMEOUT' : 'NETWORK'
  out.code = out.status
  out.retryKind = 'transient'
  out.retryable = true
  out.sentence = error.errorClass === 'timeout' ? 'Google Ads did not answer in time. Nexus tries again.' : 'Nexus could not reach Google Ads. Nexus tries again.'
  return out
}

/** A failure Nexus itself decides (an answer it cannot read, too many pages). Never retried. */
export function localFailure(sentence: string, code: string): GoogleAdsFailure {
  const out = base('google', 0)
  out.code = code
  out.status = code
  out.sentence = sentence
  return out
}

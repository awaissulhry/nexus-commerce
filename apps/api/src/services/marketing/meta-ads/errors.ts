/**
 * Meta ads M1 — what a failed Meta read means, in one place, and one plain sentence for a person. The classes come
 * from the gateway's one vocabulary (gateway/vocabulary.ts `meta()`: Graph `error.code` / `error_subcode`, checked
 * 2026-10-20 against developers.facebook.com/docs/graph-api/guides/error-handling and the Marketing API error
 * reference); this adds what the read does with each.
 */
import { GatewayNoAnswer, GatewayRefusal, type GatewayResponse } from '../../gateway/gateway.js'

export interface MetaFailure {
  /** Meta's answer, the Nexus gateway (nothing sent), no answer at all, or Nexus itself. */
  origin: 'meta' | 'gateway' | 'network' | 'nexus'
  httpStatus: number
  /** Meta's "code" or "code/subcode", or the gateway's refusal code. */
  code: string | null
  /** The token no longer works: a person makes a new one. */
  authLost: boolean
  /** Meta (or Nexus's own back-off) says to stop for now: the read ends and tries again at the next run. */
  throttled: boolean
  /** The system user may not read this (permission or asset not assigned). */
  permissionDenied: boolean
  notFound: boolean
  /**
   * Review B4 — Meta could not answer so many days or rows at once (an insights timeout or its data limit): the read
   * asks again for half the days, down to one day.
   */
  shrink?: boolean
  /**
   * Step 6 review fix A5 — Meta (or the network) failed on its side: no answer, a 5xx, a timeout or Meta's own "temporary"
   * error. Asking again for less (a field group at a time) does not help; only a refused field does.
   */
  transient?: boolean
  /** One plain sentence for a person. Never a token or a request body. */
  sentence: string
}

/**
 * Review B4 — Meta's codes for "too much at once" on insights: the request timed out (100/1504018, 2/1504038) or asked
 * for more data than Meta answers in one go (100/1487534, "Please reduce the amount of data you're asking for").
 */
export const META_SHRINK_CODES: ReadonlySet<string> = new Set(['100/1504018', '2/1504038', '100/1487534'])
/** Review B4 — 100/3191001: Meta refuses this read for the account (no access to its insights): a permission refusal. */
export const META_FORBIDDEN_CODES: ReadonlySet<string> = new Set(['100/3191001'])
/** Gateway refusals that mean the token is gone (a person signs in again); a KMS or app-secret read failure is not one. */
const SIGN_IN_CODES: ReadonlySet<string> = new Set(['ACCOUNT_NEEDS_SIGNIN'])
const TOKEN_GONE = /needs[_ ]reauth|revoked|auth_expired|auth_revoked|expired|disconnected|no credentials/i

export class MetaReadError extends Error {
  constructor(readonly failure: MetaFailure, readonly operation: string, readonly callsSpent: number = 0) {
    super(failure.sentence)
    this.name = 'MetaReadError'
  }
}

const MAX_META_WORDS = 300
const cut = (words: string | null | undefined) => (words ? (words.length > MAX_META_WORDS ? `${words.slice(0, MAX_META_WORDS - 1)}…` : words) : null)

/** A failure Nexus itself found (an answer it cannot use). */
export function localFailure(sentence: string, code: string): MetaFailure {
  return { origin: 'nexus', httpStatus: 0, code, authLost: false, throttled: false, permissionDenied: false, notFound: false, sentence }
}

/** The failure of an answer that is not ok. */
export function failureOfAnswer(answer: Pick<GatewayResponse, 'status' | 'verdict'>): MetaFailure {
  if (answer.status === 0) {
    return { origin: 'network', httpStatus: 0, code: null, authLost: false, throttled: false, permissionDenied: false, notFound: false, transient: true, sentence: 'Meta did not answer. Nexus tries again at the next read.' }
  }
  const cls = answer.verdict?.errorClass ?? 'unknown'
  const code = answer.verdict?.channelCode ?? null
  const words = cut(answer.verdict?.channelMessage)
  const base = { origin: 'meta' as const, httpStatus: answer.status, code, authLost: false, throttled: false, permissionDenied: false, notFound: false }
  if (code && META_SHRINK_CODES.has(code)) {
    return { ...base, shrink: true, sentence: `Meta could not answer that many days at once (${code}${words ? `: ${words}` : ''}). Nexus asks for fewer days.` }
  }
  if (code && META_FORBIDDEN_CODES.has(code)) {
    return { ...base, permissionDenied: true, sentence: `Meta does not let this system user read these numbers${words ? `: ${words}` : '.'} Check that the ad account is assigned to the system user and the token carries ads_read.` }
  }
  switch (cls) {
    case 'auth_expired':
    case 'auth_revoked':
      return { ...base, authLost: true, sentence: `Meta no longer accepts this business's system-user token${words ? ` (${words})` : ''}. Make a new token in Meta Business settings and enter it in Settings → Channels → Meta.` }
    case 'rate_limited':
      return { ...base, throttled: true, sentence: `Meta asked Nexus to slow down (${code ?? 'rate limit'}). Nexus stopped this read and reads again at the next run; nothing was changed.` }
    case 'forbidden':
      return { ...base, permissionDenied: true, sentence: `Meta does not let this system user read this${words ? `: ${words}` : '.'} Check that the ad account is assigned to the system user and the token carries ads_read.` }
    case 'not_found':
      return { ...base, notFound: true, sentence: `Meta says this does not exist or is not visible to the system user${words ? `: ${words}` : '.'}` }
    case 'configuration':
      return { ...base, sentence: `Nexus asked Meta in a way Meta no longer accepts${words ? `: ${words}` : '.'} This is for Nexus to fix; nothing was changed.` }
    case 'transient':
    case 'timeout':
      return { ...base, transient: true, sentence: `Meta had a temporary problem${words ? ` (${words})` : ''}. Nexus tries again at the next read.` }
    default:
      return { ...base, sentence: `Meta refused the read${words ? `: ${words}` : ` (${answer.status}).`}` }
  }
}

/** The failure of a gateway refusal or of no answer at all. */
export function failureOfThrow(err: unknown): MetaFailure | null {
  if (err instanceof GatewayRefusal) {
    const held = err.outcome === 'held'
    const throttled = err.code === 'RATE_LIMITED_LOCAL'
    // Review A2 — only a token that is gone is "auth lost": a held call because the stored token, app secret or KMS could
    // not be read (META_TOKEN_UNAVAILABLE, META_APP_SECRET_UNAVAILABLE, a decrypt failure) is Nexus's own problem.
    const tokenGone = held && (SIGN_IN_CODES.has(err.code) || (err.code === 'TOKEN_UNAVAILABLE' && TOKEN_GONE.test(err.message)))
    return {
      origin: 'gateway', httpStatus: 0, code: err.code, authLost: tokenGone, throttled, permissionDenied: false, notFound: false,
      sentence: throttled ? 'Nexus is holding back Meta calls for this account for a while (Meta said it was near its limit). It reads again at the next run.' : err.message,
    }
  }
  if (err instanceof GatewayNoAnswer) {
    return { origin: 'network', httpStatus: 0, code: err.errorClass, authLost: false, throttled: false, permissionDenied: false, notFound: false, transient: true, sentence: 'Meta did not answer. Nexus tries again at the next read.' }
  }
  return null
}

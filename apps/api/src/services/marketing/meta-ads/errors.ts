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
  /** One plain sentence for a person. Never a token or a request body. */
  sentence: string
}

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
    return { origin: 'network', httpStatus: 0, code: null, authLost: false, throttled: false, permissionDenied: false, notFound: false, sentence: 'Meta did not answer. Nexus tries again at the next read.' }
  }
  const cls = answer.verdict?.errorClass ?? 'unknown'
  const code = answer.verdict?.channelCode ?? null
  const words = cut(answer.verdict?.channelMessage)
  const base = { origin: 'meta' as const, httpStatus: answer.status, code, authLost: false, throttled: false, permissionDenied: false, notFound: false }
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
      return { ...base, sentence: `Meta had a temporary problem${words ? ` (${words})` : ''}. Nexus tries again at the next read.` }
    default:
      return { ...base, sentence: `Meta refused the read${words ? `: ${words}` : ` (${answer.status}).`}` }
  }
}

/** The failure of a gateway refusal or of no answer at all. */
export function failureOfThrow(err: unknown): MetaFailure | null {
  if (err instanceof GatewayRefusal) {
    const held = err.outcome === 'held'
    const throttled = err.code === 'RATE_LIMITED_LOCAL'
    return {
      origin: 'gateway', httpStatus: 0, code: err.code, authLost: held && err.code !== 'META_APP_SECRET_UNAVAILABLE', throttled, permissionDenied: false, notFound: false,
      sentence: throttled ? 'Nexus is holding back Meta calls for this account for a while (Meta said it was near its limit). It reads again at the next run.' : err.message,
    }
  }
  if (err instanceof GatewayNoAnswer) {
    return { origin: 'network', httpStatus: 0, code: err.errorClass, authLost: false, throttled: false, permissionDenied: false, notFound: false, sentence: 'Meta did not answer. Nexus tries again at the next read.' }
  }
  return null
}

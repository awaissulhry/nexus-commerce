/**
 * Meta (M1, 2026-10-20) — the token check: `debug_token`, through the gateway, with the business's own Meta app token.
 *
 * Checked 2026-10-20 on developers.facebook.com/docs/graph-api/reference/debug_token: `GET /debug_token?input_token=`
 * needs "an app access token or an app developer's user access token for the app associated with the input_token"; the
 * answer's `data` holds app_id, application, expires_at (unixtime; 0 = never), data_access_expires_at, is_valid,
 * issued_at, scopes, granular_scopes, user_id and, when the token is broken, error { code, message, subcode }. Meta's
 * login-security page asks servers to check tokens with it and never assume a token belongs to their app.
 * A `type` field (USER / SYSTEM_USER / PAGE / APP) appears in Meta's answers but is not on the reference page: it is
 * read when present and never required.
 *
 * Nothing here stores anything: the connect service and the heartbeat decide what to keep (connectionMetadata.metaToken,
 * never the token).
 */
import { metaCall } from '../../../gateway/meta.js'
import { GatewayNoAnswer, GatewayRefusal, type GatewayResponse } from '../../../gateway/gateway.js'
import { metaPermissionGaps, type MetaPermissionGap } from './scopes.js'

/** What Nexus keeps of a token check (connectionMetadata.metaToken) and shows. Never the token. */
export interface MetaTokenHealth {
  checkedAt: string
  isValid: boolean
  /** The Meta app the token belongs to, as Meta says. */
  appId: string | null
  /** False when the token belongs to another app than the one entered for this business. */
  appMatches: boolean
  /** SYSTEM_USER, USER, PAGE, APP — when Meta says. */
  type: string | null
  /** The system user the token acts as. */
  userId: string | null
  /** ISO; null with neverExpires = a token that does not expire by date. */
  expiresAt: string | null
  neverExpires: boolean
  dataAccessExpiresAt: string | null
  scopes: string[]
  missing: MetaPermissionGap[]
  /** Meta's own words when the token is not valid (never the token). */
  problem: string | null
}

export class MetaTokenCheckError extends Error {
  constructor(readonly reason: 'refused' | 'no_answer' | 'meta_error', message: string) {
    super(message)
    this.name = 'MetaTokenCheckError'
  }
}

const unix = (value: unknown): string | null => {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}

/** The health of a debug_token answer's `data`, for the app the business entered. Pure. */
export function tokenHealthOf(data: Record<string, unknown> | null | undefined, expectedAppId: string | null, now: Date = new Date()): MetaTokenHealth {
  const d = data ?? {}
  const scopes = Array.isArray(d.scopes) ? d.scopes.filter((s): s is string => typeof s === 'string') : []
  const appId = d.app_id == null ? null : String(d.app_id)
  const expiresRaw = Number(d.expires_at)
  const neverExpires = d.expires_at === 0 || d.expires_at === '0' || (Number.isFinite(expiresRaw) && expiresRaw === 0)
  const expiresAt = neverExpires ? null : unix(d.expires_at)
  const error = d.error && typeof d.error === 'object' ? d.error as Record<string, unknown> : null
  const appMatches = !expectedAppId || appId === expectedAppId
  const isValid = d.is_valid === true && appMatches && (!expiresAt || Date.parse(expiresAt) > now.getTime())
  let problem: string | null = null
  if (d.is_valid !== true) problem = typeof error?.message === 'string' && error.message ? `Meta says the token is not valid: ${error.message}` : 'Meta says the token is not valid.'
  else if (!appMatches) problem = 'This token belongs to another Meta app than the app id entered for this business.'
  else if (expiresAt && Date.parse(expiresAt) <= now.getTime()) problem = `The token expired on ${expiresAt.slice(0, 10)}.`
  return {
    checkedAt: now.toISOString(),
    isValid,
    appId,
    appMatches,
    type: typeof d.type === 'string' ? d.type : null,
    userId: d.user_id == null ? null : String(d.user_id),
    expiresAt,
    neverExpires,
    dataAccessExpiresAt: unix(d.data_access_expires_at),
    scopes,
    missing: metaPermissionGaps(scopes),
    problem,
  }
}

/**
 * Ask Meta about a token. `connectionId` set: the connection's own app token (the token service holds it) inspects
 * `token`; `app` set instead: the app id and secret just entered (the connect-time check, no connection yet).
 */
export async function checkMetaToken(input: { token: string; connectionId: string; expectedAppId: string | null } | { token: string; app: { appId: string; appSecret: string } }): Promise<MetaTokenHealth> {
  const connectionId = 'connectionId' in input ? input.connectionId : null
  const expectedAppId = 'app' in input ? input.app.appId : input.expectedAppId
  let answer: GatewayResponse
  try {
    answer = await metaCall({
      connectionId,
      operation: 'token.debug',
      path: 'debug_token',
      query: { input_token: input.token },
      auth: 'app' in input ? { token: `${input.app.appId}|${input.app.appSecret}`, appSecret: input.app.appSecret } : 'app',
      timeoutMs: 20_000,
    })
  } catch (err) {
    if (err instanceof GatewayRefusal) throw new MetaTokenCheckError('refused', err.message)
    if (err instanceof GatewayNoAnswer) throw new MetaTokenCheckError('no_answer', err.message)
    throw err
  }
  if (answer.status === 0) throw new MetaTokenCheckError('no_answer', 'Meta did not answer the token check.')
  const body = answer.json<{ data?: Record<string, unknown> }>()
  if (!answer.ok || !body?.data) {
    const words = answer.verdict?.channelMessage ?? `Meta answered ${answer.status}`
    // An app token Meta refuses (wrong app id or secret) is the app's problem, not the system user's token.
    throw new MetaTokenCheckError('meta_error', `Meta refused the token check: ${words}`)
  }
  return tokenHealthOf(body.data, expectedAppId)
}

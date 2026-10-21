/**
 * Meta on the gateway (Meta ads M1, 2026-10-20): the ONE way Nexus calls Meta (Graph and Marketing API at
 * graph.facebook.com). Reads are GETs (metaCall); a change (step 17) is a POST of a form body (metaWriteCall) that the
 * gateway lets through only when it is on its write allow-list and its object is of the business's chosen ad account
 * (meta-calls.ts metaWriteVerdict, gateway.ts 3b).
 *
 * - `path` is below the pinned version (services/meta/api-version.ts): `me`, `act_123/campaigns`, `debug_token`.
 * - `query` values are sent as Meta reads them: text as is, a list or an object as JSON (`fields` may be a list).
 * - Auth: the account's own system-user token ('account', the default — the token service holds it and its app
 *   secret, the gateway adds `access_token` + `appsecret_proof`); the account's Meta app token ('app', for
 *   `debug_token`); a token and app secret the caller holds (the connect-time check, before a connection holds them);
 *   or none (the token renewal, which carries the app's id and secret itself).
 * - Paging: follow `paging.cursors.after` with the same path and query (`after=`), never `paging.next` — Meta's next
 *   link carries the token, and the gateway refuses a URL that names one.
 * - A read is retried once after a network error or a 5xx (the gateway's rule for reads); a throttle is never retried
 *   here: Meta answers it with HTTP 400 and a code, and asks callers to stop (rate-readings.ts metaRateReading).
 */
import { gatewayCall, type GatewayResponse } from './gateway.js'
import { metaGraphBase } from '../meta/api-version.js'
import { META_REST_HOST } from './meta-calls.js'

export type MetaQueryValue = string | number | boolean | null | undefined | readonly unknown[] | Record<string, unknown>

export interface MetaCallRequest {
  /** The META connection the call is for; null only for the connect-time check (auth with a caller-held token). */
  connectionId: string | null
  /** Stable operation name for the ledger, e.g. 'adAccount.read', 'campaigns.list', 'insights.campaignDays'. */
  operation: string
  path: string
  query?: Record<string, MetaQueryValue>
  auth?: 'account' | 'app' | 'none' | { token: string; appSecret: string }
  timeoutMs?: number
  maxTransientRetries?: number
  triggeredBy?: 'cron' | 'manual' | 'api' | 'webhook'
}

/** The absolute Graph URL of a call (no credentials on it: the gateway adds them to the URL it sends). */
export function metaUrl(path: string, query: Record<string, MetaQueryValue> = {}): string {
  const clean = path.replace(/^\/+/, '')
  const url = new URL(`${metaGraphBase()}/${clean}`)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  return url.toString()
}

/** One Meta read through the gateway. A refusal throws GatewayRefusal; an answer (ok or not) comes back with its verdict. */
export async function metaCall(req: MetaCallRequest): Promise<GatewayResponse> {
  const auth = req.auth ?? 'account'
  return gatewayCall({
    channel: 'META',
    operation: req.operation,
    kind: 'read',
    connectionId: req.connectionId,
    appLevel: req.connectionId === null,
    url: metaUrl(req.path, req.query),
    method: 'GET',
    auth,
    maxTransientRetries: req.maxTransientRetries,
    // Meta's throttle is a 400 with a code; a real 429 is not waited out either: Meta asks to stop, not to retry.
    max429Retries: 0,
    timeoutMs: req.timeoutMs ?? 60_000,
    ledger: req.triggeredBy ? { triggeredBy: req.triggeredBy } : undefined,
  })
}

export interface MetaWriteRequest {
  /** The META connection the change is for (required: a change always names its account). */
  connectionId: string
  /** Stable operation name for the ledger, e.g. 'status.change', 'status.check'. */
  operation: string
  /** The object changed: its id, digits only (`POST /<id>`). */
  objectId: string
  /** Its kind: the gateway confirms it before anything is sent (stored row, or a field only that kind has). */
  objectKind: 'campaign' | 'adset' | 'ad' | 'highdemandperiod'
    // Step 28 — act_<id> (an apply), a business portfolio (a new study), a study, a Page, a Page video test.
    | 'adaccount' | 'business' | 'adstudy' | 'page' | 'pagevideotest'
  /** The form fields, as Meta reads them (`status`, `fields`, …): sent as the body, never on the URL. */
  params: Record<string, string>
  /** Meta's check of the change (adds `execution_options=["validate_only"]`): Meta changes nothing, so it goes as a read. */
  check: boolean
  timeoutMs?: number
  /** How long the call may wait for a slot of the account's rate bucket (a change waits longer than a read). */
  maxRateWaitMs?: number
  triggeredBy?: 'cron' | 'manual' | 'api' | 'webhook'
  /** Step 18 — a create on the object's own edge (`POST /<id>/budget_schedules`); default: the object itself. */
  edge?: 'budget_schedules'
    // Step 28 — POST /act_<id>/recommendations (an apply), /<business>/ad_studies (a study), /<page>/ab_tests (a video test).
    | 'recommendations' | 'ad_studies' | 'ab_tests'
  /** Step 18 — DELETE (a budget schedule's, no body); default POST. */
  method?: 'POST' | 'DELETE'
  /** Step 18 — a budget schedule's campaign or ad set (the gateway confirms the period is one of its own). */
  parent?: { kind: 'campaign' | 'adset'; id: string }
}

/**
 * One Meta change (or Meta's check of one) through the gateway. A change is never retried (`maxTransientRetries 0`):
 * when Meta does not answer, or fails on its side, nobody knows whether it applied — the caller says so and never sends it
 * again by itself. A check changes nothing and may be retried once after a network error, like a read. A refusal throws
 * GatewayRefusal; an answer (ok or not) comes back with its verdict.
 */
export async function metaWriteCall(req: MetaWriteRequest): Promise<GatewayResponse> {
  const remove = req.method === 'DELETE'
  const body = remove ? undefined : new URLSearchParams({ ...req.params, ...(req.check ? { execution_options: '["validate_only"]' } : {}) }).toString()
  return gatewayCall({
    channel: 'META',
    operation: req.operation,
    kind: req.check ? 'read' : 'write',
    connectionId: req.connectionId,
    url: metaUrl(req.edge ? `${req.objectId}/${req.edge}` : req.objectId),
    method: remove ? 'DELETE' : 'POST',
    body,
    metaObjectKind: req.objectKind,
    ...(req.parent ? { metaParent: req.parent } : {}),
    maxTransientRetries: req.check ? 1 : 0,
    max429Retries: 0,
    maxRateWaitMs: req.maxRateWaitMs,
    timeoutMs: req.timeoutMs ?? 60_000,
    ledger: req.triggeredBy ? { triggeredBy: req.triggeredBy } : undefined,
  })
}

// ── Meta's REST host (step 16, 2026-10-21) ─────────────────────────────────────────────────────────────────────────

/** The absolute URL of a read on Meta's REST host (`https://api.facebook.com/<path>`; meta-calls.ts metaRestVerdict). */
export function metaRestUrl(path: string, query: Record<string, MetaQueryValue> = {}): string {
  const url = new URL(`https://${META_REST_HOST}/${path.replace(/^\/+/, '')}`)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  return url.toString()
}

/**
 * One read of Meta's REST host through the gateway (GET only; the account's own system-user token, which the gateway puts
 * in the Authorization header with Meta's API version header). Same answer and refusals as metaCall.
 */
export async function metaRestCall(req: Omit<MetaCallRequest, 'auth'>): Promise<GatewayResponse> {
  return gatewayCall({
    channel: 'META',
    operation: req.operation,
    kind: 'read',
    connectionId: req.connectionId,
    url: metaRestUrl(req.path, req.query),
    method: 'GET',
    auth: 'account',
    maxTransientRetries: req.maxTransientRetries,
    max429Retries: 0,
    timeoutMs: req.timeoutMs ?? 60_000,
    ledger: req.triggeredBy ? { triggeredBy: req.triggeredBy } : undefined,
  })
}

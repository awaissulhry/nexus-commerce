/**
 * Meta on the gateway (Meta ads M1, 2026-10-20): the ONE way Nexus calls Meta (Graph and Marketing API at
 * graph.facebook.com). Reads are GETs (metaCall); a change (step 17) is a POST of a form body (metaWriteCall) that the
 * gateway lets through only when it is on its write allow-list and its object is of the business's chosen ad account
 * (meta-calls.ts metaWriteVerdict, gateway.ts 3b).
 * Step 23: a video's link handed to Meta's resumable upload host (metaRuploadCall, rupload.facebook.com — judged in
 * meta-media-rules.ts; Nexus sends no video byte).
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
import { META_REST_HOST, type MetaLabelsKind, type MetaOptimizeKind, type MetaRemoveKind } from './meta-calls.js'
import { metaRuploadUrl } from './meta-media-rules.js'

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
  objectKind: 'campaign' | 'adset' | 'ad' | 'highdemandperiod' | 'adaccount' | MetaRemoveKind | MetaLabelsKind
    // Step 28 — a business portfolio (a new study), a study, a Page, a Page video test (an apply names act_<id>).
    | MetaOptimizeKind
  /** The form fields, as Meta reads them (`status`, `fields`, …): sent as the body, never on the URL. */
  params: Record<string, string>
  /** Meta's check of the change (adds `execution_options=["validate_only"]`): Meta changes nothing, so it goes as a read. */
  check: boolean
  timeoutMs?: number
  /** How long the call may wait for a slot of the account's rate bucket (a change waits longer than a read). */
  maxRateWaitMs?: number
  triggeredBy?: 'cron' | 'manual' | 'api' | 'webhook'
  /** Step 18 — a create on the object's own edge (`POST /<id>/budget_schedules`); default: the object itself. */
  edge?: MetaWriteEdge
  /** Step 18 — DELETE (a budget schedule's, no body; step 22: an image's or a video's carries its key as the body); default POST. */
  method?: 'POST' | 'DELETE'
  /** Step 18 — a budget schedule's campaign or ad set (the gateway confirms the period is one of its own). */
  parent?: { kind: 'campaign' | 'adset'; id: string }
  /** Step 19 — Meta's check of a create asks its setup recommendations too (`["validate_only","include_recommendations"]`). */
  recommendations?: boolean
}

/**
 * The edges a change posts to: a budget schedule (step 18); a campaign's or ad set's create on the ad account (`act_<id>`),
 * a copy of a campaign, ad set or ad, a background copy and an asynchronous ad copy (step 19).
 */
export type MetaWriteEdge = 'budget_schedules' | 'campaigns' | 'adsets' | 'copies' | 'async_batch_requests' | 'asyncadcopies' | MetaRemoveEdge | MetaLabelsEdge | MetaOptimizeEdge
  | MetaMediaEdge
/** Step 28 — an apply (`act_<id>/recommendations`), a new study (`<business>/ad_studies`), a new Page video test (`<page>/ab_tests`). */
export type MetaOptimizeEdge = 'recommendations' | 'ad_studies' | 'ab_tests'
/** Step 22 — remove-meta-ads-items: an image or a video out of the ad account's library, a video's caption languages. */
export type MetaRemoveEdge = 'adimages' | 'advideos' | 'captions'
/**
 * Step 21 — set-meta-labels (a label made on the ad account, labels added to a campaign), set-meta-value-rules (a value rule
 * set made, deleted or translated) and create-meta-reach-frequency (a prediction, a reservation, a cancel).
 */
export type MetaLabelsEdge = 'adlabels' | 'value_rule_set' | 'delete_rule_set' | 'value_rule_set_translation' | 'reachfrequencypredictions'
/**
 * Step 23 — create-meta-media's edges beyond step 22's (its uploads also post to adimages, advideos and captions): Meta's
 * video-ads upload on the ad account, a folder on its business portfolio.
 */
export type MetaMediaEdge = 'video_ads' | 'creative_folders'

/**
 * One Meta change (or Meta's check of one) through the gateway. A change is never retried (`maxTransientRetries 0`):
 * when Meta does not answer, or fails on its side, nobody knows whether it applied — the caller says so and never sends it
 * again by itself. A check changes nothing and may be retried once after a network error, like a read. A refusal throws
 * GatewayRefusal; an answer (ok or not) comes back with its verdict.
 */
export async function metaWriteCall(req: MetaWriteRequest): Promise<GatewayResponse> {
  const remove = req.method === 'DELETE'
  const check = req.recommendations ? '["validate_only","include_recommendations"]' : '["validate_only"]'
  // Step 22 — a DELETE with parameters (an image's hash, a video's id) sends them as its form body, as a POST does.
  const body = remove
    ? (Object.keys(req.params).length ? new URLSearchParams(req.params).toString() : undefined)
    : new URLSearchParams({ ...req.params, ...(req.check ? { execution_options: check } : {}) }).toString()
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

export interface MetaUploadRequest {
  connectionId: string
  operation: string
  /** The video upload THIS connection started on the chosen ad account (video_ads upload_phase=start answered it). */
  videoId: string
  /** The public https link Meta fetches the file from (Nexus sends no byte of it). */
  fileUrl: string
  timeoutMs?: number
  maxRateWaitMs?: number
}

/**
 * Meta step 23 (MD-016) — hand Meta a video's public link on its resumable upload host:
 * `POST https://rupload.facebook.com/video-ads-upload/<version>/<video id>` with the link as Meta's `file_url` header
 * (the gateway judges it from this form body and adds `Authorization: OAuth <token>` itself; meta-media-rules.ts). Never
 * retried: Meta may have started fetching.
 */
export async function metaRuploadCall(req: MetaUploadRequest): Promise<GatewayResponse> {
  return gatewayCall({
    channel: 'META',
    operation: req.operation,
    kind: 'write',
    connectionId: req.connectionId,
    url: metaRuploadUrl(req.videoId),
    method: 'POST',
    body: new URLSearchParams({ file_url: req.fileUrl }).toString(),
    metaObjectKind: 'startedvideo',
    maxTransientRetries: 0,
    max429Retries: 0,
    maxRateWaitMs: req.maxRateWaitMs,
    timeoutMs: req.timeoutMs ?? 120_000,
  })
}

// ── report runs (step 7, 2026-10-21) ─────────────────────────────────────────────────────────────────────────────────

/**
 * One report run of the chosen ad account's numbers: `POST /act_<id>/insights` with the read's parameters as a form body
 * (Meta makes an AdReportRun and answers `{ report_run_id }`; nothing on the account changes). It goes as a READ: never
 * braked, held or retried like a change; the gateway judges every key and value (meta-calls.ts reportRunProblem) and
 * checks the ad account is the one this business chose through this connection. Not retried after no answer: Meta may
 * have started it (a second run would only cost a read).
 */
export async function metaReportRunCall(req: { connectionId: string; operation: string; adAccountId: string; params: Record<string, MetaQueryValue>; triggeredBy?: 'cron' | 'manual' | 'api' }): Promise<GatewayResponse> {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(req.params)) {
    if (value === undefined || value === null) continue
    body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  return gatewayCall({
    channel: 'META',
    operation: req.operation,
    kind: 'read',
    connectionId: req.connectionId,
    url: metaUrl(`act_${req.adAccountId}/insights`),
    method: 'POST',
    body: body.toString(),
    maxTransientRetries: 0,
    max429Retries: 0,
    timeoutMs: 60_000,
    ledger: req.triggeredBy ? { triggeredBy: req.triggeredBy } : undefined,
  })
}

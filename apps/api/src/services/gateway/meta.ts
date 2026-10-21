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
import { META_REST_HOST, type MetaBoostWriteKind, type MetaBrandSafetyKind, type MetaPageKind, type MetaLabelsKind, type MetaOptimizeKind, type MetaRemoveKind } from './meta-calls.js'
import { metaRuploadUrl } from './meta-media-rules.js'
import type { MetaSignalsKind } from './meta-signals-rules.js'

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
    // Step 29 — one of the chosen ad account's automated rules.
    | 'adrule'
    // Step 39 — an ad set's targeting, a publisher or content block list (brand safety).
    | MetaBrandSafetyKind
    // Step 31 — one of the chosen ad account's own custom audiences.
    | 'customaudience'
    // Step 36 — a lead form of the chosen Page, a test lead Nexus made on it.
    | MetaPageKind
    // Step 26 — the chosen Instagram account or a media of it (set-meta-partnership-access; its Page is step 28's `page`).
    | MetaBoostWriteKind
    // Step 32 — a dataset, its business portfolio, a custom conversion, an event source group, an Instagram account.
    | MetaSignalsKind
  /** The form fields, as Meta reads them (`status`, `fields`, …): sent as the body, never on the URL. */
  params: Record<string, string>
  /** Meta's check of the change (adds `execution_options=["validate_only"]`): Meta changes nothing, so it goes as a read. */
  check: boolean
  timeoutMs?: number
  /** How long the call may wait for a slot of the account's rate bucket (a change waits longer than a read). */
  maxRateWaitMs?: number
  triggeredBy?: 'cron' | 'manual' | 'api' | 'webhook'
  /**
   * Step 18 — a create on the object's own edge (`POST /<id>/budget_schedules`); default: the object itself. Step 29 — a
   * rule made on the ad account's rule library (`POST /act_<id>/adrules_library`) and a rule's run now (`POST /<rule
   * id>/execute`, no body).
   * Step 39: the brand-safety edges (a block list's draft, list, shares, people, ad accounts and posts; the account's
   * inventory filter). Step 31: an ad account's audiences, an audience's people and shares. Step 32: a dataset's and a
   * custom conversion's creates, a dataset's ad account, an event source group and its share, a claim (MetaSignalsEdge).
   */
  edge?: MetaWriteEdge
  /** Step 18 — DELETE (a budget schedule's, no body; step 22: an image's or a video's carries its key as the body; step 39: a share's agency, a list's posts; step 31: an audience's people or share); default POST. */
  method?: 'POST' | 'DELETE'
  /** Step 39 (review A9) — the run of the change this request belongs to (a block-list draft is used only by its own run). */
  run?: string
  /** Step 18 — a budget schedule's campaign or ad set (the gateway confirms the period is one of its own). */
  parent?: { kind: 'campaign' | 'adset'; id: string }
  /** Step 19 — Meta's check of a create asks its setup recommendations too (`["validate_only","include_recommendations"]`). */
  recommendations?: boolean
  /**
   * Step 27 — a new ad's check (POST /act_<id>/ads) runs Meta's synchronous integrity review with it (`synchronous_ad_review`,
   * documented only beside validate_only; AD-026 … AD-028). The gateway's ad-create rule judges the exact value.
   */
  adReview?: boolean
}

/**
 * The edges a change posts to: a budget schedule (step 18); a campaign's or ad set's create on the ad account (`act_<id>`),
 * a copy of a campaign, ad set or ad, a background copy and an asynchronous ad copy (step 19).
 */
export type MetaWriteEdge = 'budget_schedules' | 'campaigns' | 'adsets' | 'copies' | 'async_batch_requests' | 'asyncadcopies' | MetaRemoveEdge | MetaLabelsEdge | MetaOptimizeEdge
  | MetaMediaEdge | MetaCreativeEdge | MetaRuleEdge | MetaBrandSafetyEdge | MetaAudienceEdge | MetaPageEdge | MetaBoostEdge | MetaSignalsEdge | MetaAdEdge
/** Step 27 — create-meta-ad: a new ad on the chosen ad account (an ad's labels: step 21's `adlabels`). */
export type MetaAdEdge = 'ads'
/** Step 26 — set-meta-partnership-access: the chosen Instagram account's partnership edges and a media's ad code. */
export type MetaBoostEdge = 'branded_content_ad_permissions' | 'branded_content_tag_approval' | 'collaboration_invites' | 'partnership_ad_code'
/**
 * Step 32 — a dataset made on the ad account or the business portfolio (`adspixels`) or for a Page / Instagram account
 * (`dataset`), a custom conversion (`customconversions`), a dataset's or an event source group's ad account
 * (`shared_accounts`), an event source group (`event_source_groups`), a claim (`claim_custom_conversions`).
 */
export type MetaSignalsEdge = 'adspixels' | 'dataset' | 'customconversions' | 'shared_accounts' | 'event_source_groups' | 'claim_custom_conversions'
/** Step 31 — an ad account's new audiences and product audiences, its opt-outs; an audience's people and its shares. */
export type MetaAudienceEdge = 'customaudiences' | 'product_audiences' | 'usersofanyaudience' | 'users' | 'ad_accounts'
/** Step 29 — a rule made on the ad account's rule library (`act_<id>/adrules_library`), a rule's run now (`<rule id>/execute`). */
export type MetaRuleEdge = 'adrules_library' | 'execute'
/** Step 39 — the brand-safety edges (the account's filter, a block list's draft, list, shares, people, ad accounts and posts). */
export type MetaBrandSafetyEdge = 'brand_safety_content_filter_levels' | 'block_list_drafts' | 'publisher_block_lists' | 'agencies'
  | 'assigned_users' | 'auto_applied_ad_accounts' | 'content_block_lists' | 'content' | 'applied_ad_accounts'
/** Step 36 — a lead form on the chosen Page, a test lead on a form of it. */
export type MetaPageEdge = 'leadgen_forms' | 'test_leads'
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
/** Step 25 — create-meta-creative: a creative and an async creative job on the chosen ad account (a creative's labels: step 21's `adlabels`). */
export type MetaCreativeEdge = 'adcreatives' | 'asyncadcreatives'

/**
 * One Meta change (or Meta's check of one) through the gateway. A change is never retried (`maxTransientRetries 0`):
 * when Meta does not answer, or fails on its side, nobody knows whether it applied — the caller says so and never sends it
 * again by itself. A check changes nothing and may be retried once after a network error, like a read. A refusal throws
 * GatewayRefusal; an answer (ok or not) comes back with its verdict.
 */
export async function metaWriteCall(req: MetaWriteRequest): Promise<GatewayResponse> {
  const remove = req.method === 'DELETE'
  // Step 27 — a new ad's check adds Meta's synchronous integrity review (adReview); step 19's recommendations come last.
  const check = JSON.stringify(['validate_only', ...(req.adReview ? ['synchronous_ad_review'] : []), ...(req.recommendations ? ['include_recommendations'] : [])])
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
    ...(req.run ? { metaRun: req.run } : {}),
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
 * Step 39 (BS-033) — the CSV export of a content block list: `PUT https://api.facebook.com/content_block_lists/<id>/file_download`
 * (Meta makes a new file each call), through the gateway as a read (meta-calls.ts metaRestFileExportOf: the list must be
 * the chosen portfolio's). Never retried: a second call would make a second file.
 */
export async function metaRestFileExport(req: { connectionId: string; operation: string; contentBlockListId: string; triggeredBy?: 'cron' | 'manual' | 'api' | 'webhook' }): Promise<GatewayResponse> {
  return gatewayCall({
    channel: 'META',
    operation: req.operation,
    kind: 'read',
    connectionId: req.connectionId,
    url: metaRestUrl(`content_block_lists/${req.contentBlockListId}/file_download`),
    method: 'PUT',
    auth: 'account',
    maxTransientRetries: 0,
    max429Retries: 0,
    timeoutMs: 60_000,
    ledger: req.triggeredBy ? { triggeredBy: req.triggeredBy } : undefined,
  })
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

export interface MetaRestWriteRequest {
  connectionId: string
  operation: string
  /** The path below the host, e.g. `partnership-ads/fb-account-level-permissions/<page id>` (the gateway confirms the Page is the chosen one). */
  path: string
  method: 'POST' | 'PUT' | 'DELETE'
  query?: Record<string, string>
  /** The JSON body as text, in Nexus's one spelling (meta-boost-rules.ts). */
  body?: string
  maxRateWaitMs?: number
}

/**
 * Step 26 (review B1) — one change on Meta's partnership REST host (api.facebook.com) through the gateway: the account's
 * system-user token as `Authorization: Bearer` with `X-API-Version: 1.0.0` (the gateway adds both), the chosen Page in the
 * path, a JSON body or a judged query (meta-boost-rules.ts metaRestWriteVerdict). Never retried.
 */
export async function metaRestWriteCall(req: MetaRestWriteRequest): Promise<GatewayResponse> {
  return gatewayCall({
    channel: 'META',
    operation: req.operation,
    kind: 'write',
    connectionId: req.connectionId,
    url: metaRestUrl(req.path, req.query ?? {}),
    method: req.method,
    ...(req.body ? { body: req.body } : {}),
    metaObjectKind: 'page',
    maxTransientRetries: 0,
    max429Retries: 0,
    maxRateWaitMs: req.maxRateWaitMs,
    timeoutMs: 60_000,
  })
}

// ── Meta's preview of an automated rule (step 29, 2026-10-21) ─────────────────────────────────────────────────────────

/**
 * Meta's preview of a schedule rule: `POST /<rule id>/preview` with no parameter (ad-rules/guides/api-calls "Preview a
 * rule": it "returns a list of objects that satisfy all specified filters of the rule at that time"; SDK
 * AdRule.create_preview, POST, no params). A POST that only reads: the gateway's write allow-list judges it
 * (meta-ad-rule-rules.ts `adRule.preview`, kind read), confirms the rule is of the chosen ad account and sends it only while
 * Meta changes are switched on, like Meta's check. Retried once after a network error, like a read.
 */
export async function metaRulePreviewCall(req: { connectionId: string; ruleId: string; timeoutMs?: number }): Promise<GatewayResponse> {
  return gatewayCall({
    channel: 'META',
    operation: 'rules.preview',
    kind: 'read',
    connectionId: req.connectionId,
    url: metaUrl(`${req.ruleId}/preview`),
    method: 'POST',
    body: '',
    metaObjectKind: 'adrule',
    maxTransientRetries: 1,
    max429Retries: 0,
    timeoutMs: req.timeoutMs ?? 60_000,
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

/**
 * Meta step 17 (write base) — the write client: a change of ONE Meta object (or Meta's check of it), through the channel
 * gateway (`metaWriteCall`, channel META: the write allow-list, the chosen-account check, the account's token and
 * appsecret_proof, the rate bucket, Meta's per-object limits, one ledger row per call).
 *
 *   POST https://graph.facebook.com/<version>/<object id>   form: status=… [&fields=…] [&execution_options=["validate_only"]]
 *
 * - Meta's check (`execution_options=["validate_only"]`) "will not perform the mutation but will run through the
 *   validation rules"; success answers {"success": true} (checked 2026-10-21, reference/ad-campaign-group.md "Updating").
 *   Meta documents it on campaign updates and on creates only — never asked for anything else (the gateway refuses it too).
 * - Read-after-write (master ACC-030): a campaign update asks for `fields=id,status,effective_status` in the same POST
 *   (it "will read the node to which you POSTed"); an ad set or ad update has no documented return type, so it is read
 *   back with one GET (LIVE-PROBE ST17-05), and so is a campaign whose answer holds no status.
 * - An answer that is not a plain success is no proof nothing changed (review fix B1): the object is read once and judged
 *   by what it is now (metaSendChange).
 * - Meta's per-object limit: a change waits (up to 30 s) until 30 s after the last change or check of the same object
 *   (613/4841018); a longer hold (an ad set's budget hour, 613/1487632) is refused in words, nothing sent.
 * - Retries: a check is a read (retried once after a network error). A change is NEVER retried: when nobody knows
 *   whether it applied (`outcome: 'unknown'`), Nexus never sends it again by itself, and asking again reads the object
 *   first.
 * Never logs a token, a request body or an answer.
 */
import { metaRestWriteCall, metaRuploadCall, metaWriteCall, type MetaRestWriteRequest, type MetaWriteEdge } from '../../gateway/meta.js'
import type { GatewayResponse } from '../../gateway/gateway.js'
import { metaObjectState, metaObjectWait, META_OBJECT_EDIT_GAP_MS } from '../../gateway/meta-object-limits.js'
import { failureOfAnswer, failureOfThrow, localFailure, type MetaFailure } from './errors.js'
import { metaReadOne } from './read-client.js'

/** The fields a change reads back (gateway meta-calls.ts META_READ_BACK_FIELDS holds the allow-list). */
export const READ_BACK = 'id,status,effective_status'

/** Waits longer than this are not waited out: the change is refused in words (nothing sent). */
const MAX_WAIT_MS = META_OBJECT_EDIT_GAP_MS + 1_000
/** A change may wait this long for a slot of the account's rate bucket (Meta scores a write 3 points). */
const WRITE_RATE_WAIT_MS = 60_000

/**
 * A change Meta did not make, or one nobody knows the outcome of:
 *   not_sent   Nexus sent nothing (the gateway's rules, the chosen-account check, a hold, writes switched off, the token)
 *   refused    Meta answered with an error: it changed nothing for this object
 *   unknown    Meta did not answer, or failed on its side: the change may or may not have happened
 */
export class MetaWriteError extends Error {
  constructor(readonly failure: MetaFailure, readonly operation: string, readonly outcome: 'not_sent' | 'refused' | 'unknown') {
    super(failure.sentence)
    this.name = 'MetaWriteError'
  }
}

/** What a person reads when nobody knows whether Meta made a change. */
export const META_UNKNOWN_OUTCOME = 'Sent to Meta, but Meta did not confirm whether it made the change. Nexus never sends it again '
  + 'by itself; meta-ads-live shows the object now, and asking again reads it first and sends only what is not there.'

export interface MetaWriteTarget { connectionId: string; adAccountId: string }
export interface MetaObjectChange {
  objectId: string
  /** The kind of object (the gateway confirms it before anything is sent). */
  kind: 'campaign' | 'adset' | 'ad' | 'highdemandperiod' | 'adaccount' | 'portfolio' | 'libraryvideo' | 'creative' | 'iguser' | 'igmedia' | 'page'
  params: Record<string, string>
  operation: string
  budget?: boolean
  /** Ask the read-back in the same POST (documented for a campaign update only); else a GET reads it back. */
  readBackInPost?: boolean
  /**
   * Step 18 — what the read-back must show (field → value as Meta writes it). Default: `status` as sent. A field Meta does
   * not send back is not judged.
   */
  expect?: Record<string, string>
  /** Step 18 — the fields read back (default id,status,effective_status); on the POST only when `readBackInPost`. */
  readBackFields?: string
  /** Step 18 — a create on the object's edge (POST /<id>/budget_schedules): the new object is read back, not the parent. */
  edge?: MetaWriteEdge
  /** Step 18 — DELETE (a budget schedule's): Meta's {"success": true} is the answer, nothing is read back. */
  method?: 'POST' | 'DELETE'
  /** Step 18 — a budget schedule's campaign or ad set (the gateway checks the period is one of its own). */
  parent?: { kind: 'campaign' | 'adset'; id: string }
  /** Step 23 — how long the call may take (an image's bytes: longer than the 60 s default). */
  timeoutMs?: number
  /** Step 27 — a check's execution_options when not Meta's plain check (a new ad's: with its synchronous integrity review). */
  checkOptions?: string
}

/** Step 18 — what the read-back must show: the request's own `expect`, else its status. */
export const expectedOf = (change: Pick<MetaObjectChange, 'params' | 'expect'>): Record<string, string> =>
  change.expect ?? (change.params.status ? { status: change.params.status } : {})

/** Step 18 — what the object reads now, for the fields a change asked (`daily_budget 5000, bid_strategy COST_CAP`). */
export function readsOf(node: Record<string, unknown>, expected: Record<string, string>): string {
  const parts = Object.keys(expected).map((field) => {
    const got = node[field]
    return `${field} ${got === undefined || got === null ? '(not sent back)' : typeof got === 'object' ? JSON.stringify(got) : String(got)}`
  })
  return parts.length ? parts.join(', ') : 'as before'
}

/** Step 18 review A7 — times are sent as UTC Unix seconds and read back as ISO 8601: both judged as Unix seconds (step 27: an ad's own schedule too). */
const TIME_FIELDS = new Set(['start_time', 'end_time', 'time_start', 'time_end', 'ad_schedule_start_time', 'ad_schedule_end_time'])
const unixOf = (v: unknown): string => {
  const text = String(v)
  if (/^\d{1,11}$/.test(text)) return text
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : text
}

/** Step 18 — the fields of a read-back that do not show what was asked (a field not sent back is not judged). */
export function readBackMismatch(node: Record<string, unknown> | null, expected: Record<string, string>): string[] {
  if (!node) return []
  return Object.entries(expected).filter(([field, value]) => {
    const got = node[field]
    if (got === undefined || got === null) return false
    if (TIME_FIELDS.has(field)) return unixOf(got) !== unixOf(value)
    return (typeof got === 'string' || typeof got === 'number' || typeof got === 'boolean' ? String(got) : JSON.stringify(got)) !== value
  }).map(([field]) => field)
}

const MAX_WORDS = 300
const cut = (words: string | null | undefined) => (words ? (words.length > MAX_WORDS ? `${words.slice(0, MAX_WORDS - 1)}…` : words) : null)

/** The failure of a change's answer, in words about a CHANGE (errors.ts says them about a read). */
function changeFailure(answer: Pick<GatewayResponse, 'status' | 'verdict'>): MetaFailure {
  const failure = failureOfAnswer(answer)
  if (failure.origin !== 'meta') return failure
  const words = cut(answer.verdict?.channelMessage)
  const code = failure.code ? ` (${failure.code})` : ''
  if (failure.authLost) return failure
  if (failure.throttled) return { ...failure, sentence: `Meta asked Nexus to slow down${code}${words ? `: ${words}` : ''}. Nothing was changed; ask again in a few minutes.` }
  if (failure.permissionDenied) return { ...failure, sentence: `Meta does not let this system user change this${words ? `: ${words}` : ''}. Check that the ad account is assigned to the system user and its token carries ads_management.` }
  if (failure.notFound) return { ...failure, sentence: `Meta says this object does not exist or the system user cannot see it${words ? `: ${words}` : ''}.` }
  return { ...failure, sentence: `Meta refused it${code}${words ? `: ${words}` : ''}. Nothing was changed.` }
}

/**
 * Meta's check (validate_only) of one change: resolves when Meta would accept it — with Meta's answer (step 27: a new ad's
 * check may carry Meta's recommendations) — and rejects with a MetaWriteError.
 */
export async function metaCheckChange(target: MetaWriteTarget, change: MetaObjectChange): Promise<Record<string, unknown> | null> {
  const operation = `${change.operation}.check`
  let answer: GatewayResponse
  try {
    // Step 25 — a create on an edge is checked on that edge (POST /act_<id>/adcreatives with validate_only).
    answer = await metaWriteCall({ connectionId: target.connectionId, operation, objectId: change.objectId, objectKind: change.kind, params: change.params, check: true, ...(change.parent ? { parent: change.parent } : {}), ...(change.edge ? { edge: change.edge } : {}), ...(change.checkOptions ? { checkOptions: change.checkOptions } : {}) })
  } catch (err) {
    const failure = failureOfThrow(err) ?? localFailure(`Nexus could not ask Meta's check (${err instanceof Error ? err.message : String(err)}).`, 'NEXUS_ERROR')
    throw new MetaWriteError(failure, operation, 'not_sent')
  }
  if (answer.ok) {
    const body = answer.json<{ success?: unknown }>()
    if (body && body.success === false) throw new MetaWriteError(localFailure('Meta answered its check with success: false and gave no reason.', 'CHECK_FAILED'), operation, 'refused')
    return body && typeof body === 'object' ? body : null
  }
  const failure = changeFailure(answer)
  // No answer, Meta unwell or a throttle: nothing was judged (the change itself was never sent: nothing can have moved).
  const judged = answer.status !== 0 && answer.status < 500 && !failure.throttled && !failure.authLost
  throw new MetaWriteError(failure, operation, judged ? 'refused' : 'not_sent')
}

export interface MetaChangeResult {
  /** The object as Meta read it back after the change (id, status, effective_status), or null when it could not be read. */
  node: Record<string, unknown> | null
  /** How it was read back: in the same POST, by a GET after it, or not at all (Meta said success). */
  readBack: 'same-request' | 'second-read' | 'none'
  /** How long the change waited for Meta's per-object limit. */
  waitedMs: number
  /** Meta answered with an error, yet the object reads back as asked: Meta made it. Meta's words, for the step's sentence. */
  afterError?: string
}

/** One GET of the object (id, status, effective_status — or the change's own read-back fields), or null when it cannot be read — never throws. */
async function readObject(target: MetaWriteTarget, objectId: string, operation: string, fields: string = READ_BACK): Promise<Record<string, unknown> | null> {
  try {
    const read = await metaReadOne({ connectionId: target.connectionId }, { operation, path: objectId, query: { fields } })
    return read.body && typeof read.body === 'object' ? read.body as Record<string, unknown> : null
  } catch {
    // A Meta refusal, a gateway refusal or a problem of Nexus's own: the object is not read (the caller says so).
    return null
  }
}

/**
 * Send one change. Waits out Meta's 30-s per-object limit first (a longer hold refuses it, nothing sent); reads the object
 * back. Rejects with a MetaWriteError whose `outcome` says whether anything can have changed.
 *
 * Review fix B1 — an error answer to a change is NOT proof nothing changed (the read part of a read-after-write can fail
 * after the write applied; Meta marks some errors is_transient; codes 1 and 2 come with a 4xx). So after ANY answer that is
 * not a plain success, Nexus reads the object once: as asked → done (Meta made it, whatever it answered); readable and not
 * as asked → refused when Meta answered with an error (it changed nothing), not confirmed when Meta did not answer or failed
 * on its side (it may still apply it); unreadable → not confirmed. Not confirmed is never sent again by Nexus.
 * The read-back fields ride on the POST only for a campaign update (documented); an ad set or ad is read back with a GET
 * (its update has no documented return type — LIVE-PROBE ST17-05).
 */
export async function metaSendChange(
  target: MetaWriteTarget,
  change: MetaObjectChange,
  options: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<MetaChangeResult> {
  const operation = change.operation
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const wait = metaObjectWait(await metaObjectState(target.connectionId, change.objectId, now()), change.budget === true, now())
  let waitedMs = 0
  if (wait) {
    if (wait.waitMs > MAX_WAIT_MS) {
      const until = new Date(now() + wait.waitMs).toISOString().slice(11, 16)
      throw new MetaWriteError(localFailure(`Not sent: ${wait.why}; Meta takes it again after ${until} UTC. Nothing was changed.`, 'META_OBJECT_HELD'), operation, 'not_sent')
    }
    waitedMs = wait.waitMs + 250
    await sleep(waitedMs)
  }
  let answer: GatewayResponse
  const fields = change.readBackFields ?? READ_BACK
  try {
    answer = await metaWriteCall({
      connectionId: target.connectionId, operation, objectId: change.objectId, objectKind: change.kind,
      params: { ...change.params, ...(change.readBackInPost ? { fields } : {}) }, check: false, maxRateWaitMs: WRITE_RATE_WAIT_MS,
      ...(change.edge ? { edge: change.edge } : {}), ...(change.method === 'DELETE' ? { method: 'DELETE' as const } : {}), ...(change.parent ? { parent: change.parent } : {}),
      ...(change.timeoutMs ? { timeoutMs: change.timeoutMs } : {}),
    })
  } catch (err) {
    // The gateway throws only before it sends (a refusal, or a problem of Nexus's own such as the database): nothing left.
    const failure = failureOfThrow(err) ?? localFailure(`Nexus could not send it (${err instanceof Error ? err.message : String(err)}). Nothing was sent.`, 'NEXUS_ERROR')
    throw new MetaWriteError(failure, operation, 'not_sent')
  }
  const body = answer.ok ? answer.json<Record<string, unknown>>() : null
  if (answer.ok && !(body && body.success === false)) {
    if (body && typeof body.status === 'string') return { node: body, readBack: 'same-request', waitedMs }
    // Step 18 — a DELETE answers {"success": true}: the object is gone, nothing to read back.
    if (change.method === 'DELETE') return { node: body, readBack: 'none', waitedMs }
    // Step 18 — a create on an edge answers the NEW object (read-after-write): read back that one, never the parent.
    if (change.edge) {
      const created = body && (typeof body.id === 'string' || typeof body.id === 'number') ? String(body.id) : null
      if (body && created && Object.keys(body).length > 1) return { node: body, readBack: 'same-request', waitedMs }
      const node = created ? await readObject(target, created, `${operation}.readBack`, fields) : null
      return { node: node ?? body, readBack: node ? 'second-read' : 'none', waitedMs }
    }
    if (change.expect && change.readBackInPost && body && (typeof body.id === 'string' || typeof body.id === 'number')) return { node: body, readBack: 'same-request', waitedMs }
    const node = await readObject(target, change.objectId, `${operation}.readBack`, fields)
    return { node, readBack: node ? 'second-read' : 'none', waitedMs }
  }
  // Not a plain success: what Meta answered, then what the object is now.
  const failure = answer.ok ? localFailure('Meta answered success: false and gave no reason.', 'CHANGE_FAILED') : changeFailure(answer)
  const unanswered = answer.status === 0 || answer.status >= 500
  const wanted = expectedOf(change)
  // Step 18 — an edge create or a DELETE cannot be judged by reading the object: Meta's answer is all there is.
  const node = change.edge || change.method === 'DELETE' ? null : await readObject(target, change.objectId, `${operation}.readAfterError`, fields)
  if (node && Object.keys(wanted).length && Object.keys(wanted).every((f) => node[f] !== undefined && node[f] !== null) && !readBackMismatch(node, wanted).length) {
    return { node, readBack: 'second-read', waitedMs, afterError: unanswered ? 'Meta did not answer, or failed on its side' : failure.sentence }
  }
  // Step 18 — a create on an edge or a DELETE that Meta answered with an error made nothing (Meta judged it).
  if ((change.edge || change.method === 'DELETE') && !unanswered) throw new MetaWriteError(failure, operation, 'refused')
  if (!node) {
    const sentence = unanswered
      ? META_UNKNOWN_OUTCOME
      : `${failure.sentence.replace(/ Nothing was changed\.$/, '')} — and Nexus could not read the object back to see whether it changed. Nexus never sends it again by itself; meta-ads-live shows it now.`
    throw new MetaWriteError({ ...failure, sentence }, operation, 'unknown')
  }
  const reads = change.expect ? `it reads ${readsOf(node, wanted)}` : `it still reads ${typeof node.status === 'string' ? node.status : 'unchanged'}`
  if (unanswered) {
    throw new MetaWriteError({ ...failure, sentence: `Meta did not confirm it; ${reads}, but Meta may still apply it. Nexus never sends it again by itself; meta-ads-live shows it.` }, operation, 'unknown')
  }
  throw new MetaWriteError({ ...failure, sentence: `${failure.sentence.replace(/\.$/, '')} (${reads}).` }, operation, 'refused')
}

/**
 * Meta step 23 (MD-016) — hand Meta the public link of a video upload THIS change started (video_ads upload_phase=start),
 * on Meta's resumable upload host: Meta fetches the file itself (Nexus relays no byte). Resolves when Meta answered a
 * success; rejects with a MetaWriteError: not_sent (the gateway refused it, nothing left), refused (Meta answered an error:
 * it took no file), unknown (no answer, or Meta failed on its side: it may be fetching it). Never retried.
 */
export async function metaSendRupload(target: MetaWriteTarget, upload: { videoId: string; fileUrl: string; operation: string }): Promise<{ node: Record<string, unknown> | null }> {
  let answer: GatewayResponse
  try {
    answer = await metaRuploadCall({ connectionId: target.connectionId, operation: upload.operation, videoId: upload.videoId, fileUrl: upload.fileUrl, maxRateWaitMs: WRITE_RATE_WAIT_MS })
  } catch (err) {
    const failure = failureOfThrow(err) ?? localFailure(`Nexus could not send it (${err instanceof Error ? err.message : String(err)}). Nothing was sent.`, 'NEXUS_ERROR')
    throw new MetaWriteError(failure, upload.operation, 'not_sent')
  }
  const body = answer.ok ? answer.json<Record<string, unknown>>() : null
  if (answer.ok && !(body && body.success === false)) return { node: body }
  const failure = answer.ok ? localFailure('Meta answered success: false and gave no reason.', 'CHANGE_FAILED') : changeFailure(answer)
  if (answer.status === 0 || answer.status >= 500) throw new MetaWriteError({ ...failure, sentence: META_UNKNOWN_OUTCOME }, upload.operation, 'unknown')
  throw new MetaWriteError(failure, upload.operation, 'refused')
}

/** Big integers (Page and post ids on Meta's partnership host come as JSON numbers) kept exact as text before parsing. */
function parseExactJson(raw: string): unknown {
  try { return JSON.parse(raw.replace(/([:[,]\s*)(\d{16,})(?=\s*[,\]}])/g, '$1"$2"')) } catch { return null }
}

/**
 * Step 26 (review B1) — one change on Meta's partnership REST host (metaRestWriteCall). Resolves with Meta's answer (a list of
 * per-item results, or an object) as `node`; rejects with a MetaWriteError: not_sent (the gateway refused it, nothing left),
 * refused (Meta answered an error: it changed nothing), unknown (no answer, or Meta failed on its side). Never retried. Meta
 * answers each item of a list on its own (not all or nothing): the caller reads them.
 */
export async function metaSendRest(target: MetaWriteTarget, change: Omit<MetaRestWriteRequest, 'connectionId'>): Promise<MetaChangeResult> {
  let answer: GatewayResponse
  try {
    answer = await metaRestWriteCall({ ...change, connectionId: target.connectionId, maxRateWaitMs: WRITE_RATE_WAIT_MS })
  } catch (err) {
    const failure = failureOfThrow(err) ?? localFailure(`Nexus could not send it (${err instanceof Error ? err.message : String(err)}). Nothing was sent.`, 'NEXUS_ERROR')
    throw new MetaWriteError(failure, change.operation, 'not_sent')
  }
  if (answer.ok) {
    const body = parseExactJson(answer.text)
    return { node: Array.isArray(body) ? { items: body } : body && typeof body === 'object' ? body as Record<string, unknown> : null, readBack: 'same-request', waitedMs: 0 }
  }
  const failure = changeFailure(answer)
  if (answer.status === 0 || answer.status >= 500) throw new MetaWriteError({ ...failure, sentence: META_UNKNOWN_OUTCOME }, change.operation, 'unknown')
  throw new MetaWriteError(failure, change.operation, 'refused')
}

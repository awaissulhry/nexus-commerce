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
 * - Read-after-write (master ACC-030): a change asks for `fields=id,status,effective_status` in the same POST (the campaign
 *   update "will read the node to which you POSTed"); when Meta answers only {"success": true} (an ad set or ad update has
 *   no documented return type), Nexus reads the object once with a GET.
 * - Meta's per-object limit: a change waits (up to 30 s) until 30 s after the last change or check of the same object
 *   (613/4841018); a longer hold (an ad set's budget hour, 613/1487632) is refused in words, nothing sent.
 * - Retries: a check is a read (retried once after a network error). A change is NEVER retried: when Meta does not
 *   answer, or fails on its side (5xx), nobody knows whether it applied (`outcome: 'unknown'`) — Nexus never sends it again
 *   by itself, and asking again reads the object first.
 * Never logs a token, a request body or an answer.
 */
import { metaWriteCall } from '../../gateway/meta.js'
import type { GatewayResponse } from '../../gateway/gateway.js'
import { metaObjectState, metaObjectWait, META_OBJECT_EDIT_GAP_MS } from '../../gateway/meta-object-limits.js'
import { failureOfAnswer, failureOfThrow, localFailure, MetaReadError, type MetaFailure } from './errors.js'
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
export interface MetaObjectChange { objectId: string; params: Record<string, string>; operation: string; budget?: boolean }

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

/** Meta's check (validate_only) of one change: resolves when Meta would accept it; rejects with a MetaWriteError. */
export async function metaCheckChange(target: MetaWriteTarget, change: MetaObjectChange): Promise<void> {
  const operation = `${change.operation}.check`
  let answer: GatewayResponse
  try {
    answer = await metaWriteCall({ connectionId: target.connectionId, operation, objectId: change.objectId, params: change.params, check: true })
  } catch (err) {
    const failure = failureOfThrow(err)
    if (failure) throw new MetaWriteError(failure, operation, 'not_sent')
    throw err
  }
  if (answer.ok) {
    const body = answer.json<{ success?: unknown }>()
    if (body && body.success === false) throw new MetaWriteError(localFailure('Meta answered its check with success: false and gave no reason.', 'CHECK_FAILED'), operation, 'refused')
    return
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
}

/**
 * Send one change. Waits out Meta's 30-s per-object limit first (a longer hold refuses it, nothing sent); reads the object
 * back. Rejects with a MetaWriteError whose `outcome` says whether anything can have changed.
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
  try {
    answer = await metaWriteCall({ connectionId: target.connectionId, operation, objectId: change.objectId, params: { ...change.params, fields: READ_BACK }, check: false, maxRateWaitMs: WRITE_RATE_WAIT_MS })
  } catch (err) {
    const failure = failureOfThrow(err)
    if (failure) throw new MetaWriteError(failure, operation, 'not_sent')
    throw err
  }
  if (!answer.ok) {
    const failure = changeFailure(answer)
    // No answer, or a failure on Meta's side: Meta may have made it before failing to say so.
    if (answer.status === 0 || answer.status >= 500) throw new MetaWriteError({ ...failure, sentence: META_UNKNOWN_OUTCOME }, operation, 'unknown')
    throw new MetaWriteError(failure, operation, 'refused')
  }
  const body = answer.json<Record<string, unknown>>()
  if (body && body.success === false) throw new MetaWriteError(localFailure('Meta answered success: false and gave no reason. Nothing was changed, as far as Meta said.', 'CHANGE_FAILED'), operation, 'refused')
  if (body && typeof body.status === 'string') return { node: body, readBack: 'same-request', waitedMs }
  try {
    const read = await metaReadOne({ connectionId: target.connectionId }, { operation: `${operation}.readBack`, path: change.objectId, query: { fields: READ_BACK } })
    return { node: read.body as Record<string, unknown>, readBack: 'second-read', waitedMs }
  } catch (err) {
    if (err instanceof MetaReadError) return { node: null, readBack: 'none', waitedMs }
    throw err
  }
}

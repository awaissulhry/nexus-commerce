/**
 * Meta step 33 (lane C3, 2026-10-21) — one Conversions API request through the channel gateway (`metaWriteCall`, channel
 * META: the write allow-list's `pixel.events` rule, the business's switch and the pixel rule, the account's token and
 * appsecret_proof, the rate bucket, one ledger row that keeps no body):
 *
 *   POST https://graph.facebook.com/<version>/<pixel id>/events   form: data=[…] &partner_agent=nexus [&test_event_code=…]
 *
 * Meta answers {events_received, messages, fbtrace_id} (Meta's Python SDK serverside/event_response.py). What an answer
 * means for the sales it carried (conversions-api/using-the-api.md "Batch Requests": "If any event in a batch is invalid,
 * the request returns an error — but valid events with an event_id are still accepted"):
 *   done        Meta received every event: confirmed.
 *   maybe       Meta received fewer than sent, refused the request for its content, did not answer or failed on its
 *               side: some or all may be in Meta. Never sent again by Nexus by itself; asked again within 46 hours the
 *               same event_ids go (Meta drops a copy it has), never later.
 *   none        Meta took nothing: a throttle, a lost token, no permission, an unknown pixel (rejected before any event).
 *   not_sent    Nexus sent nothing (a gateway refusal: its rules, the switch, the pixel rule, writes switched off). Any
 *               other error of Nexus's own during the call counts as maybe (review F1: it may have come after the send).
 * A request is never retried here. Never logs a request body or an answer; Meta's words come scrubbed of hashes.
 */
import { metaWriteCall } from '../../gateway/meta.js'
import { GatewayRefusal, type GatewayResponse } from '../../gateway/gateway.js'
import { failureOfAnswer, failureOfThrow } from './errors.js'
import type { MetaWriteTarget } from './write-client.js'

export interface EventsSendResult {
  outcome: 'done' | 'maybe' | 'none' | 'not_sent'
  /** Meta's events_received (null when Meta gave none). */
  received: number | null
  sentence: string
}

const MAX_WORDS = 300
const cut = (words: string | null | undefined) => (words ? (words.length > MAX_WORDS ? `${words.slice(0, MAX_WORDS - 1)}…` : words) : null)
/** A request may wait this long for a slot of the account's rate bucket. */
const RATE_WAIT_MS = 60_000

const MAYBE = 'Meta keeps the valid events of a request that carry an event_id (every Nexus event does), so some or all of these may be in Meta: Nexus records them as not confirmed and never sends them again by itself; asked again within 46 hours the same event_ids go (Meta drops a copy it already has), never later.'

/** Send one request of events to the pixel; `expected` is how many events it carries. Never throws. */
export async function metaSendEvents(target: MetaWriteTarget, pixelId: string, params: Record<string, string>, expected: number): Promise<EventsSendResult> {
  let answer: GatewayResponse
  try {
    answer = await metaWriteCall({ connectionId: target.connectionId, operation: 'events.send', objectId: pixelId, objectKind: 'pixel', params, check: false, edge: 'events', maxRateWaitMs: RATE_WAIT_MS })
  } catch (err) {
    // A gateway refusal comes before anything is sent: nothing went.
    if (err instanceof GatewayRefusal) {
      const failure = failureOfThrow(err)
      return { outcome: 'not_sent', received: null, sentence: `Not sent: ${failure?.sentence ?? err.message}`.replace(/\.?$/, '.') }
    }
    // Review F1 — any other problem of Nexus's own may have come after the request left: it may be in Meta.
    return { outcome: 'maybe', received: null, sentence: `Nexus hit a problem of its own during the request (${err instanceof Error ? err.message : String(err)}). ${MAYBE}` }
  }
  if (answer.ok) {
    const body = answer.json<{ events_received?: unknown; messages?: unknown }>()
    const received = typeof body?.events_received === 'number' && Number.isInteger(body.events_received) ? body.events_received : null
    const messages = Array.isArray(body?.messages) ? body!.messages.filter((m): m is string => typeof m === 'string').map((m) => cut(m)).slice(0, 5) : []
    const said = messages.length ? ` Meta's notes: ${messages.join(' · ')}` : ''
    if (received === expected) return { outcome: 'done', received, sentence: `Meta received all ${expected} event${expected === 1 ? '' : 's'}.${said}` }
    return { outcome: 'maybe', received, sentence: `Meta answered with ${received === null ? 'no count' : `${received} of ${expected} events received`}.${said} ${MAYBE}` }
  }
  const failure = failureOfAnswer(answer)
  const words = cut(answer.verdict?.channelMessage)
  const code = failure.code ? ` (${failure.code})` : ''
  if (answer.status === 0 || answer.status >= 500) {
    return { outcome: 'maybe', received: null, sentence: `Meta did not answer, or failed on its side${code}. ${MAYBE}` }
  }
  if (failure.throttled) return { outcome: 'none', received: null, sentence: `Meta asked Nexus to slow down${code}${words ? `: ${words}` : ''}. Meta took none of these events; ask again in a few minutes.` }
  if (failure.authLost) return { outcome: 'none', received: null, sentence: failure.sentence }
  if (failure.permissionDenied) return { outcome: 'none', received: null, sentence: `Meta does not let this system user send events to this pixel${words ? `: ${words}` : ''}. Meta took none of them. Assign the pixel to the system user in Meta Business settings.` }
  if (failure.notFound) return { outcome: 'none', received: null, sentence: `Meta says this pixel does not exist or the system user cannot see it${words ? `: ${words}` : ''}. Meta took none of these events.` }
  return { outcome: 'maybe', received: null, sentence: `Meta refused the request${code}${words ? `: ${words}` : ''}. ${MAYBE}` }
}

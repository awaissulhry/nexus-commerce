/**
 * Meta step 36 (2026-10-21) — THE Page token mode (cross-lane question Q1, lane C2's proposal, built once here; lanes C2
 * — steps 24, 27 — and C4 — steps 37, 38 — reuse it, never a second one).
 *
 * Some Meta changes are made AS the Page and take the Page's own access token: lead forms and test leads (step 36), the
 * app installed on the Page (step 30 part 3), and later Page posts, comments, messages. Nexus holds no Page token. For a
 * write rule marked `auth: 'page'` (meta-calls.ts MetaWriteRule), and only for one — and for the ONE read Meta answers
 * only to a Page token, the Page's connected apps (`<page>/subscribed_apps`, meta-calls.ts metaCallVerdict `pageRead`,
 * step 30 part 3: what install-page and remove-page stand on and put back) — the gateway itself reads the token of the
 * business's CHOSEN Facebook Page (its PAGE MetaAccountLink — never a Page a caller names), for that one call:
 *
 *   GET https://graph.facebook.com/<version>/<chosen page id>?fields=access_token   with the business's system-user token
 *   and its appsecret_proof — master ACC-014. The field IS on the v26 Page reference (checked 2026-10-21,
 *   developers.facebook.com/docs/graph-api/reference/page/, Fields › access_token: "The Page's access token. Only returned
 *   if the User making the request has a role (other than Live Contributor) on the Page. If your business requires
 *   two-factor authentication, the User must also be authenticated"); Meta's access-tokens guide says system-user tokens act
 *   "on Ad objects or Pages". Whether a SYSTEM user's token gets it this way is LIVE-PROBES PG-01.
 *
 * The rules (binding):
 *   - This read never goes through the caller path. The caller path refuses every token read as before (meta-calls.ts
 *     metaCallVerdict: a field naming `token`, `accounts` without its own list, a bare node without fields), and every
 *     Meta answer a caller gets is scrubbed (scrubMetaAnswer) — unchanged. Only services/gateway/gateway.ts imports this
 *     file (a test holds that).
 *   - The token lives in memory only, for the one call: it is returned to gateway.ts, which puts it on the URL it sends
 *     (never on `url`, which the ledger, the trace and the answer carry) with its own appsecret_proof, and drops it.
 *     Nothing is cached, stored, logged or traced. Its own ledger row keeps the path only (`graph.facebook.com/v26.0/<page
 *     id>`), never a body that went well; a failure keeps Meta's words, which carry no token, and are scrubbed anyway.
 *   - No Page token from Meta (refused, or the Page answers none: the system user has no task on it) → nothing is sent,
 *     and the sentence says what the Page needs in Meta Business settings, with Meta's own words.
 */
import { metaGraphBase } from '../meta/api-version.js'
import { metaChosenPageOf } from './account.js'
import { writeLedgerRow } from './ledger.js'
import { metaSendUrl, scrubMetaAnswer } from './meta-calls.js'
import { bucketKey, observeRate, takeToken } from './rate.js'
import { apiVersionOf, metaAdsWritesMode, rateReadingOf } from './channels.js'
import { classifyChannelAnswer } from './vocabulary.js'

/** Why there is no Page token for this call: nothing is sent, and the sentence says what the Page needs. */
export class MetaPageTokenUnavailable extends Error {
  constructor(readonly code: 'META_PAGE_NOT_CHOSEN' | 'META_PAGE_TOKEN_UNAVAILABLE' | 'RATE_LIMITED_LOCAL' | 'PUBLISH_GATED', message: string, readonly retryAfterMs: number | null = null) {
    super(message)
    this.name = 'MetaPageTokenUnavailable'
  }
}

/**
 * What a Page needs so the system user gets its token: Meta's own condition on the Page reference's access_token field (a
 * role other than Live Contributor on the Page; when the business requires two-factor authentication, an authenticated
 * user), the task the change needs (lead forms and test leads: Advertise, create guide) and the token's permissions.
 */
export const META_PAGE_TOKEN_NEEDS = 'Meta answers a Page\'s own token only to someone with a role on the Page other than Live Contributor (and, when the business requires two-factor authentication, one who is authenticated): the system user needs the business\'s chosen Facebook Page assigned to it in Meta Business settings (Users › System users › Assign assets) with the task this change needs — lead forms and test leads: Advertise ("Create ads"); the app installed on the Page and its connected apps read (set-meta-webhooks): Manage, Create content or Moderate — and its token needs ads_management, business_management, pages_manage_ads, pages_read_engagement and pages_show_list (the app on the Page: pages_manage_metadata and pages_show_list, Messenger fields also pages_messaging).'

/**
 * Review A1 — one exact secret (the Page's token, the system-user token) out of a text: as written, and — when the text is
 * JSON — out of every DECODED string value and key too (an echo Meta writes with JSON \u escapes is the same token once
 * parsed). Returns the text as it may travel and how many were removed.
 */
export function scrubExactToken(text: string, secret: string): { text: string; removed: number } {
  if (!secret) return { text, removed: 0 }
  // Step 36 rebase fix — and the token as a URL writes it (encodeURIComponent: an app token's `|` as %7C, also %7c).
  const encoded = encodeURIComponent(secret)
  const forms = [...new Set([secret, encoded, encoded.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())])]
  const strip = (v: string): { text: string; n: number } => {
    let n = 0
    let t = v
    for (const form of forms) {
      if (!t.includes(form)) continue
      n += t.split(form).length - 1
      t = t.split(form).join('[removed]')
    }
    return { text: t, n }
  }
  const first = strip(text)
  const removed = first.n
  const out = first.text
  let parsed: unknown
  try { parsed = JSON.parse(out) } catch { return { text: out, removed } }
  let found = 0
  const clean = (v: string) => { const c = strip(v); found += c.n; return c.text }
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 64) return null
    if (typeof value === 'string') return clean(value)
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1))
    if (value && typeof value === 'object') {
      const o: Record<string, unknown> = {}
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        // defineProperty: a key named "__proto__" stays an own key.
        Object.defineProperty(o, clean(key), { value: walk(child, depth + 1), enumerable: true, writable: true, configurable: true })
      }
      return o
    }
    return value
  }
  const walked = walk(parsed, 0)
  return found ? { text: JSON.stringify(walked), removed: removed + found } : { text: out, removed }
}

const MAX_WORDS = 300
/** The words of a failed token read, scrubbed (they carry no token; scrubbed all the same) and cut. */
function wordsOf(text: string, status: number, timedOut: boolean): { words: string | null; code: string | null; errorClass: string } {
  const clean = scrubMetaAnswer(text).text
  const verdict = classifyChannelAnswer('META', status, clean, { timedOut })
  const said = verdict.channelMessage ? scrubMetaAnswer(verdict.channelMessage).text : null
  return { words: said && said.length > MAX_WORDS ? `${said.slice(0, MAX_WORDS - 1)}…` : said, code: verdict.channelCode === null ? null : String(verdict.channelCode), errorClass: verdict.errorClass }
}

/**
 * The chosen Page's own token for ONE call of a rule marked `auth: 'page'`, read by the gateway with the system-user
 * token. Throws MetaPageTokenUnavailable (nothing sent) when there is none. Called only by gateway.ts, after the change
 * was judged (meta-calls.ts) and its object confirmed as the chosen Page or a child of it (meta-page-owner.ts).
 */
export async function metaPageTokenFor(connectionId: string, deps: { timeoutMs?: number } = {}): Promise<string> {
  // Review A7 — defence in depth: with Meta changes switched off no Page token is read, whatever the caller did before.
  if (metaAdsWritesMode() !== 'live') throw new MetaPageTokenUnavailable('PUBLISH_GATED', 'Nothing was sent to Meta: Meta changes are switched off in Nexus (NEXUS_META_ADS_WRITES), so Nexus reads no Page token either.')
  const pageId = await metaChosenPageOf(connectionId)
  if (!pageId) throw new MetaPageTokenUnavailable('META_PAGE_NOT_CHOSEN', 'Held, nothing sent: this business has no Facebook Page chosen through this Meta connection, so Nexus has no Page to act as. A person chooses it in Settings › Channels › Meta (or Claude asks for it with set-meta-connection).')
  const { getAccessToken, metaRequestProof } = await import('../cx/token.service.js')
  let systemToken: string
  let proof: { appsecret_proof: string; appsecret_time: string }
  try {
    systemToken = await getAccessToken(connectionId)
    proof = await metaRequestProof(connectionId, systemToken)
  } catch (err) {
    throw new MetaPageTokenUnavailable('META_PAGE_TOKEN_UNAVAILABLE', `Held, nothing sent: Nexus could not read the business's Meta system-user token or its app secret, which it needs to ask Meta for the Page's token (${err instanceof Error ? scrubMetaAnswer(err.message).text : 'unknown'}).`)
  }
  const read = new URL(`${metaGraphBase()}/${pageId}`)
  read.searchParams.set('fields', 'access_token')
  const sendUrl = metaSendUrl(read.toString(), systemToken, proof)
  const endpoint = `${read.host}${read.pathname}`
  const key = bucketKey('META', connectionId, 'ads')
  const slot = await takeToken('META', key, 30_000, undefined, 1)
  if (!slot.ok) throw new MetaPageTokenUnavailable('RATE_LIMITED_LOCAL', `Not sent yet: the Meta rate limit for this account needs ${Math.ceil(slot.waitMs / 1000)} s more before Nexus may ask for the Page's token. Retry later; nothing was changed.`, slot.waitMs)
  const started = Date.now()
  let status = 0
  let text = ''
  let timedOut = false
  let headers = new Headers()
  try {
    // Never follow a redirect: the system-user token is on this URL.
    const res = await fetch(sendUrl, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000) })
    status = res.status
    headers = res.headers
    text = await res.text()
  } catch (err) {
    timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    text = err instanceof Error ? err.message : String(err)
  }
  const reading = status ? rateReadingOf('META', headers, status) : null
  await observeRate('META', key, reading)
  let token: string | null = null
  let answerProblem: string | null = null
  if (status >= 200 && status < 300) {
    let body: unknown = null
    try { body = JSON.parse(text) } catch { body = null }
    const row = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
    const id = row && (typeof row.id === 'string' || typeof row.id === 'number') ? String(row.id) : null
    const value = row?.access_token
    if (id !== pageId) answerProblem = 'Meta answered for another object than the chosen Page'
    else if (typeof value !== 'string' || !/^[A-Za-z0-9_.|-]{20,2000}$/.test(value)) answerProblem = 'Meta answered the chosen Page without a token for the system user (it has no task on the Page)'
    else token = value
  }
  // The token is never in the text kept from here on: a 2xx answer (with or without a token) is dropped, a failure keeps
  // Meta's words only — and never the system-user token, even echoed (review A1).
  if (status >= 200 && status < 300) text = ''
  else text = scrubExactToken(text, systemToken).text
  const failed = token ? null : status && !(status >= 200 && status < 300) ? wordsOf(text, status, timedOut) : null
  await writeLedgerRow({
    channel: 'META', marketplace: null, connectionId, operation: 'page.token', endpoint, method: 'GET', idempotencyKey: null,
    apiVersion: apiVersionOf('META', read.toString()), productId: null, listingId: null, orderId: null,
    statusCode: status || null, success: token !== null, latencyMs: Date.now() - started, outcome: 'sent',
    errorClass: token ? null : failed?.errorClass ?? (status ? 'unknown' : timedOut ? 'timeout' : 'network'),
    errorCode: token ? null : failed?.code ?? (answerProblem ? 'NO_PAGE_TOKEN' : null),
    errorMessage: token ? null : failed?.words ?? answerProblem ?? (status ? null : 'Meta did not answer.'),
    rateLimitRemaining: reading?.remaining ?? null, rateLimitLimit: reading?.limit ?? null, attempts: 1,
  })
  if (token) return token
  if (!status) throw new MetaPageTokenUnavailable('META_PAGE_TOKEN_UNAVAILABLE', `Held, nothing sent: Meta did not answer Nexus's request for the chosen Page's token${timedOut ? ' in time' : ''}. Nothing was changed; ask again later.`)
  const why = failed?.words ? `Meta's words: ${failed.words}${failed.code ? ` (${failed.code})` : ''}` : answerProblem ?? `Meta answered ${status}`
  throw new MetaPageTokenUnavailable('META_PAGE_TOKEN_UNAVAILABLE', `Held, nothing sent: Meta gave Nexus no token for the business's chosen Facebook Page (${why}). ${META_PAGE_TOKEN_NEEDS}`)
}

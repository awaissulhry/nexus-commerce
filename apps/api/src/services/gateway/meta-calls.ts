/**
 * Meta on the gateway (Meta ads M1, 2026-10-20) — what a Meta call may be, judged before the token or the network.
 *
 * M1 is READ ONLY by construction: the only Meta call the gateway lets through is a GET, with no body, to
 * `https://graph.facebook.com/<the pinned version>/…` (services/meta/api-version.ts). Everything else is refused with
 * its ledger row (`META_READ_ONLY`), whatever kind the caller declared. On top of the method, the URL itself:
 *   - `method` / `_method` in the query (Graph's method override: a GET that acts as a POST or DELETE) — refused;
 *   - `batch` (a batch request carries its own methods) and the root path (the batch endpoint) — refused;
 *   - `oauth/revoke` (a GET that ends a token) — refused;
 *   - `oauth/access_token` only as the system-user token renewal Meta documents (grant_type=fb_exchange_token), with no
 *     account token on it (`auth: 'none'`): it hands out a new 60-day token and the old one keeps working until its own
 *     expiry (checked 2026-10-20: developers.facebook.com/docs/marketing-api/businessmanager/systemuser/
 *     install-apps-and-generate-tokens, "Refresh Access Token" and "Access Token Rotation");
 *   - `access_token`, `appsecret_proof` and `appsecret_time` are the gateway's own: a caller that names one is refused,
 *     so no call can carry a token the gateway did not choose;
 *   - ONE canonical parse of the URL (review 2): the path as written has no percent-encoding, no empty, `.` or `..`
 *     segment; a query key is lower-case snake_case and named once;
 *   - a read never brings a token back: `fields` is split on anything but letters, digits and `_`, and a name holding
 *     `token` (`access_token`, `page_access_token`, also nested or JSON-listed) is refused; `fields` must name a field;
 *     an `accounts` field (a person's or system user's Pages: Meta answers each Page's access_token by default) only with
 *     its own `{…}` list; an `accounts` edge or a bare object node (a Page node can carry its token) only with `fields`;
 *   - and the other side (defence in depth): every `access_token` key, secret query parameter and token shape in a Meta
 *     answer is removed before it leaves the gateway (scrubMetaAnswer), except in the renewal's own answer, and the
 *     ledger counts what it removed;
 *   - query keys are an ALLOW-list (review 3): fields, limit, after, before, summary, plus input_token on debug_token and
 *     business on an app's authorized_adaccounts; anything else (metadata, debug, pretty, …) is refused by name; every
 *     `{…}` in fields names a field;
 *   - the renewal must be exactly Meta's documented call: grant_type, client_id, client_secret and
 *     set_token_expires_in_60_days, each once, nothing else; the gateway fills fb_exchange_token from the connection's
 *     stored token (a caller that names one is refused); the verdict hands its client_id back and gateway.ts sends it
 *     only when that is the connection's own app;
 *   - a caller's own headers are refused (no method override or other header travels on a Meta call).
 * Writes come in M3, by an allow-list of exact paths and methods.
 *
 * Every call with a token carries `appsecret_proof` = HMAC-SHA256(key = the app secret, message = `<token>|<time>`) and
 * `appsecret_time` = that time in seconds, as Meta's Login Security page asks today (checked 2026-10-20:
 * developers.facebook.com/documentation/facebook-login/security, "Secure Server-side Calls with appsecret_proof": a
 * time-stamped proof is valid 5 minutes, so it is made per call). The token travels as the `access_token` parameter,
 * the form every Graph example uses; the ledger and traces keep the path only (gateway.ts `safePath`).
 */
import { createHmac } from 'node:crypto'
import { META_GRAPH_HOST, metaGraphApiVersion } from '../meta/api-version.js'

/** Query keys only the gateway sets. */
const GATEWAY_OWNED_KEYS = new Set(['access_token', 'appsecret_proof', 'appsecret_time'])
/** Graph's method override and batch: a GET that is not a read. */
const NOT_A_READ_KEYS = /^(_?method|batch)$/i

export type MetaCallGroup = 'ads' | 'insights' | 'auth'

/**
 * A Graph URL as the gateway judges it — ONE canonical parse that every rule below and the renewal check read, so what is
 * judged is what Meta reads (review 2, 2026-10-20). The path as written must be plain: no percent-encoding (`%6Fauth`,
 * `me/%61ccounts`), no empty segment (`oauth//access_token`), no `.` or `..` segment, only letters, digits and `_` per
 * segment (the version `vNN.N` apart). Null when it is not a Graph URL at all; `{ problem }` when it is one the gateway
 * will not judge.
 */
interface GraphRoute { version: string | null; segments: string[]; route: string; search: URLSearchParams }

function graphRouteOf(url: string): GraphRoute | { problem: string } | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'https:' || parsed.hostname !== META_GRAPH_HOST || parsed.username || parsed.password || parsed.hash || parsed.port) return null
  // The path as written, before the URL parser folds "." and ".." segments away.
  const raw = url.replace(/^https:\/\/[^/?#]*/i, '').split(/[?#]/)[0] || '/'
  if (raw.includes('%') || parsed.pathname.includes('%')) return { problem: 'a Meta path is never percent-encoded' }
  const pieces = raw.split('/').slice(1)
  if (pieces.some((piece) => piece === '')) return { problem: 'a Meta path has no empty segment' }
  if (pieces.some((piece) => piece === '.' || piece === '..')) return { problem: 'a Meta path has no . or .. segment' }
  const version = /^v\d+\.\d+$/.test(pieces[0]) ? pieces[0] : null
  const segments = version ? pieces.slice(1) : pieces
  if (segments.some((piece) => !/^[A-Za-z0-9_]+$/.test(piece))) return { problem: 'a Meta path segment is letters, digits and _ only' }
  return { version, segments, route: segments.join('/').toLowerCase(), search: parsed.searchParams }
}

/**
 * The exact query keys a caller gives the system-user token renewal (Meta's "Refresh Access Token", system-user guide).
 * The fifth, `fb_exchange_token` (the token renewed), the gateway fills itself from the connection's stored token
 * (review 3): a caller can never exchange another token.
 */
export const META_RENEWAL_KEYS = ['client_id', 'client_secret', 'grant_type', 'set_token_expires_in_60_days'] as const

/**
 * Review 3 — the query keys a read may carry: an ALLOW-list, not a block-list. Every key Meta reads that is not here
 * (`metadata`, `debug`, `method`, `pretty`, …) is refused with its name. Each later step adds only the keys its own
 * reads need, with a test (meta.vitest.test.ts).
 *   - any read: fields, limit, after, before, summary;
 *   - debug_token: input_token (the token inspected);
 *   - <app>/authorized_adaccounts: business (the business portfolio asked about; meta-connection view app);
 *   - step 2, the ad account's lists act_<id>/campaigns | adsets | ads: effective_status, filtering (the daily read and
 *     meta-ads-live);
 *   - step 2, insights (act_<id>/insights, <object>/insights): level, time_range, time_increment, filtering — never
 *     use_unified_attribution_setting or action_report_time (Meta ignores both since 2025-06-10, facts F2 T1);
 *   - step 2, act_<id>/async_requests: status, type (master ACC-028, SDK only: a refusal from Meta answers plainly;
 *     LIVE-PROBES.md).
 */
const READ_KEYS = new Set(['fields', 'limit', 'after', 'before', 'summary'])
const ROUTE_KEYS: Array<{ route: RegExp; keys: ReadonlySet<string> }> = [
  { route: /^debug_token$/, keys: new Set(['input_token']) },
  { route: /^\d+\/authorized_adaccounts$/, keys: new Set(['business']) },
  { route: /^act_\d+\/(campaigns|adsets|ads)$/, keys: new Set(['effective_status', 'filtering']) },
  { route: /^(act_)?\d+\/insights$/, keys: new Set(['level', 'time_range', 'time_increment', 'filtering']) },
  { route: /^act_\d+\/async_requests$/, keys: new Set(['status', 'type']) },
]
/** May a read of this route (the canonical one: lower case, no version) carry this query key? (meta-ads-graph-read asks.) */
export function metaQueryKeyAllowed(route: string, key: string): boolean {
  return READ_KEYS.has(key) || ROUTE_KEYS.some((r) => r.route.test(route) && r.keys.has(key))
}
const keyAllowed = metaQueryKeyAllowed
/** At most this long, a `fields` value (the longest Nexus asks is far shorter). */
const MAX_FIELDS_LENGTH = 4000
/** A field name that is (or holds) a token: `access_token`, `page_access_token`, … — never asked for. */
const TOKEN_NAME = /token/i
/** `accounts` as a field (a person's or system user's Pages; Meta answers each Page's token by default). */
const ACCOUNTS_FIELD = /(?<![A-Za-z0-9_])accounts(?![A-Za-z0-9_])/gi
/** Field modifiers that may sit between a field and its own `{…}` list: `.limit(100)`, `.summary(true)`. */
const MODIFIERS = /^(?:\s*\.\s*[A-Za-z_]+\s*\([^(){}]*\))*\s*/

/** A real field name: a letter first. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/

/**
 * Review 3 — does every `{…}` list, at any depth, name at least one field of its own (and are the braces balanced)?
 * Modifier arguments (`.limit(5)`) and modifier names (the word after a `.`) are not fields.
 */
function bracesProblem(value: string): string | null {
  const lists: number[] = []
  let paren = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '(') { paren++; continue }
    if (c === ')') { paren = Math.max(0, paren - 1); continue }
    if (paren > 0) continue
    if (c === '{') { lists.push(0); continue }
    if (c === '}') {
      const named = lists.pop()
      if (named === undefined) return 'fields has a } with no {'
      if (named === 0) return 'every {…} in fields names a field'
      continue
    }
    const startsName = /[A-Za-z]/.test(c) && (i === 0 || !/[A-Za-z0-9_]/.test(value[i - 1]))
    if (startsName && lists.length > 0 && value[i - 1] !== '.') lists[lists.length - 1]++
  }
  return lists.length > 0 ? 'fields has a { with no }' : null
}

/** Why a `fields` value is refused, or null. Names are what is left when the value is split on anything but A–Z, 0–9, _. */
function fieldsProblem(value: string): string | null {
  if (value.length > MAX_FIELDS_LENGTH) return `fields is at most ${MAX_FIELDS_LENGTH} characters`
  if (value.includes('%')) return 'fields is never percent-encoded twice'
  // A field list is plain ASCII: no look-alike letter (а for a), no tab or other control character.
  if (!/^[\x20-\x7e]*$/.test(value)) return 'fields is plain ASCII letters, digits and punctuation'
  const names = value.split(/[^A-Za-z0-9_]+/).filter(Boolean)
  if (names.some((name) => TOKEN_NAME.test(name))) return 'a read never asks Meta for a token'
  if (!names.some((name) => FIELD_NAME.test(name))) return 'fields names no field'
  const braces = bracesProblem(value)
  if (braces) return braces
  for (const match of value.matchAll(ACCOUNTS_FIELD)) {
    const after = value.slice((match.index ?? 0) + match[0].length).replace(MODIFIERS, '')
    if (!after.startsWith('{')) return 'an accounts field names its own fields ({…}): Meta answers each Page\'s token by default'
  }
  return null
}

/** The gateway's verdict on a Meta call: why it is refused (null: it may go), and the renewal's client_id when it is one. */
export interface MetaCallVerdict { problem: string | null; renewalClientId: string | null }

/**
 * The verdict on one Meta call, judged on the canonical parse. `auth` is how the caller asked the call to be authorised
 * (gateway.ts `GatewayRequest.auth`): only the token renewal goes without one. For a renewal the verdict also hands back
 * its client_id: the gateway sends it only when that is the connection's own Meta app (gateway.ts, step 1d).
 */
export function metaCallVerdict(input: { method: string; url: string; kind: string; body?: unknown; auth?: unknown; headers?: Record<string, string> }): MetaCallVerdict {
  const refuse = (problem: string): MetaCallVerdict => ({ problem, renewalClientId: null })
  const method = input.method.toUpperCase()
  if (method !== 'GET') return refuse(`Nexus only reads Meta for now, and this call would change something (${method})`)
  if (input.kind !== 'read') return refuse('Nexus only reads Meta for now, and this call is not declared a read')
  if (input.body !== undefined && input.body !== null && input.body !== '') return refuse('a read of Meta carries no body')
  if (input.headers && Object.keys(input.headers).length > 0) return refuse('a Meta call carries no header of the caller\'s own')
  const graph = graphRouteOf(input.url)
  if (!graph) return refuse('Nexus calls Meta only at https://graph.facebook.com')
  if ('problem' in graph) return refuse(graph.problem)
  const pinned = metaGraphApiVersion()
  if (graph.version !== pinned) return refuse(`Nexus calls Meta only on API version ${pinned} (this call: ${graph.version ?? 'no version'})`)
  const { segments, route, search } = graph
  if (segments.length === 0) return refuse('the Graph root (batch requests) is not a read')
  const seen = new Set<string>()
  for (const key of search.keys()) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) return refuse(`the query key "${key}" is not one Meta reads (lower-case letters, digits and _)`)
    if (seen.has(key)) return refuse(`the query names "${key}" more than once`)
    seen.add(key)
    if (NOT_A_READ_KEYS.test(key)) return refuse(`the query names "${key}", which turns a GET into a change or a batch`)
    if (GATEWAY_OWNED_KEYS.has(key)) return refuse(`the query names "${key}", which only the gateway sets`)
  }
  if (route === 'oauth/revoke') return refuse('oauth/revoke ends a token: Nexus never sends it')
  if (segments[0].toLowerCase() === 'oauth') {
    if (seen.has('fb_exchange_token')) return refuse('a token renewal names no fb_exchange_token: the gateway fills it from the connection\'s own stored token')
    const keys = [...seen].sort()
    const exact = keys.length === META_RENEWAL_KEYS.length && keys.every((k, i) => k === META_RENEWAL_KEYS[i])
    if (route !== 'oauth/access_token' || !exact || search.get('grant_type') !== 'fb_exchange_token' || input.auth !== 'none') {
      return refuse('the only Meta sign-in call Nexus sends is the system-user token renewal, exactly as Meta documents it (grant_type=fb_exchange_token, client_id, client_secret, set_token_expires_in_60_days; the gateway adds fb_exchange_token)')
    }
    return { problem: null, renewalClientId: search.get('client_id') ?? '' }
  }
  for (const key of seen) {
    if (!keyAllowed(route, key)) return refuse(`the query key "${key}" is not one a Nexus read of Meta uses here`)
  }
  const fields = search.get('fields')
  if (fields !== null) {
    const problem = fieldsProblem(fields)
    if (problem) return refuse(problem)
  }
  if (segments.some((segment) => segment.toLowerCase() === 'accounts') && fields === null) {
    return refuse('a read of Pages (accounts) names its fields: Meta answers each Page\'s token by default')
  }
  if (segments.length === 1 && /^\d+$/.test(segments[0]) && fields === null) return refuse('a read of one object names its fields (a Page node can carry its token)')
  return { problem: null, renewalClientId: null }
}

/** Why the gateway refuses this Meta call, in words, or null when it may go (metaCallVerdict's problem). */
export function metaReadOnlyProblem(input: Parameters<typeof metaCallVerdict>[0]): string | null {
  return metaCallVerdict(input).problem
}

/** Is this the token renewal (the only sign-in call), and with which client_id? Null when it is not one (same parse). */
export function metaRenewalOf(url: string): { clientId: string } | null {
  const verdict = metaCallVerdict({ method: 'GET', url, kind: 'read', auth: 'none' })
  return verdict.renewalClientId === null ? null : { clientId: verdict.renewalClientId }
}

/** Query parameters that carry a secret, wherever a string names them (paging links, connection links, a message). */
const SECRET_NAMES = 'access_token|appsecret_proof|appsecret_time|client_secret|fb_exchange_token|input_token'
/** In a query string, with the separator before it. */
const SECRET_IN_QUERY = new RegExp(`([?&])(?:${SECRET_NAMES})=[^&#\\s"'<>]*`, 'gi')
/** Anywhere else in a string (`see access_token=…`, a form body `access_token=…&…`), with one `&` after it. */
const SECRET_BARE = new RegExp(`\\b(?:${SECRET_NAMES})=[^&#\\s"'<>]*&?`, 'gi')
/** Marks where a `?` stood before a dropped parameter, so the next parameter takes its place. */
const QUERY_START = '\u0000q'
/**
 * Token shapes, anywhere in a string (a value or a key): a user or system-user token (EAA…), an app token
 * (`<app id>|<app secret>`), also URL-encoded (`<app id>%7C<app secret>`).
 */
const TOKEN_SHAPES = /EAA[A-Za-z0-9]{20,}|\b\d{6,}(?:\||%7[Cc])[A-Za-z0-9_-]{16,}/g

/** A string with every secret parameter dropped and every token shape masked, and how many were removed. */
function scrubString(value: string): { text: string; removed: number } {
  let removed = 0
  const text = value
    // `?a=T&b` → `?b`, `?b&a=T&c` → `?b&c`, `?b&a=T` → `?b`, `?a=T` → `` (several in a row too).
    .replace(SECRET_IN_QUERY, (_m, lead: string) => { removed++; return lead === '?' ? QUERY_START : '' })
    .replace(new RegExp(`${QUERY_START}&`, 'g'), '?').replace(new RegExp(QUERY_START, 'g'), '')
    .replace(SECRET_BARE, () => { removed++; return '' })
    .replace(TOKEN_SHAPES, () => { removed++; return '[removed]' })
  return { text, removed }
}

/**
 * Defence in depth (review 2, widened in review 3): nothing that is or carries a token leaves the gateway in a Meta
 * answer — to the ledger, the caller or a tool — except the renewal's own answer, which IS the new token. The answer is
 * ALWAYS parsed (a JSON-escaped key like `access\u005ftoken` is read as Meta means it): every key named `access_token`
 * (any case, any depth) is dropped; in every string value the secret query parameters (access_token, appsecret_proof,
 * appsecret_time, client_secret, fb_exchange_token, input_token — `paging.next` / `previous` carry the token, an app-token
 * read carries `app id|app secret`) are dropped and token shapes masked. An answer that is not JSON is treated as one
 * string. Returns the text as it may travel and how many things were removed (the ledger counts them).
 */
export function scrubMetaAnswer(text: string): { text: string; scrubbed: number } {
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    const clean = scrubString(text)
    return { text: clean.text, scrubbed: clean.removed }
  }
  let scrubbed = 0
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 64) return null
    if (typeof value === 'string') {
      const clean = scrubString(value)
      scrubbed += clean.removed
      return clean.text
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [rawKey, child] of Object.entries(value as Record<string, unknown>)) {
        if (rawKey.toLowerCase() === 'access_token') { scrubbed++; continue }
        // A key can carry a token too (an answer keyed by token): it is masked like a value, and kept apart if two clash.
        const masked = scrubString(rawKey)
        scrubbed += masked.removed
        let key = masked.text
        for (let n = 2; masked.removed && Object.prototype.hasOwnProperty.call(out, key); n++) key = `${masked.text}-${n}`
        // defineProperty: a key named "__proto__" stays an own key (an assignment would set the prototype and lose it).
        Object.defineProperty(out, key, { value: walk(child, depth + 1), enumerable: true, writable: true, configurable: true })
      }
      return out
    }
    return value
  }
  const clean = walk(parsed, 0)
  return scrubbed ? { text: JSON.stringify(clean), scrubbed } : { text, scrubbed: 0 }
}

/** Meta counts Business Use Case quotas per kind of call (ads management, insights) and the sign-in apart. */
export function metaCallGroup(url: string): MetaCallGroup {
  const graph = graphRouteOf(url)
  const route = graph && !('problem' in graph) ? graph.route : ''
  if (/^(oauth\/|debug_token$)/.test(route)) return 'auth'
  if (/(^|\/)insights$/.test(route)) return 'insights'
  return 'ads'
}

/** appsecret_proof for one call: HMAC-SHA256 of `<token>|<time>` keyed with the app secret, hex. */
export function metaAppSecretProof(token: string, appSecret: string, timeSec: number = Math.floor(Date.now() / 1000)): { appsecret_proof: string; appsecret_time: string } {
  const time = String(Math.floor(timeSec))
  return { appsecret_proof: createHmac('sha256', appSecret).update(`${token}|${time}`).digest('hex'), appsecret_time: time }
}

/** The URL as it is sent: the caller's URL with the token and its proof added (the ledger never sees this one). */
export function metaSendUrl(url: string, token: string, proof: { appsecret_proof: string; appsecret_time: string }): string {
  const parsed = new URL(url)
  parsed.searchParams.set('access_token', token)
  parsed.searchParams.set('appsecret_proof', proof.appsecret_proof)
  parsed.searchParams.set('appsecret_time', proof.appsecret_time)
  return parsed.toString()
}

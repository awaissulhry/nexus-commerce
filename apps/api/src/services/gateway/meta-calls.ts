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
 *   - a read never brings a token back: `access_token` named anywhere in `fields` (also nested, `accounts{access_token}`)
 *     is refused, and so is a read of an `accounts` edge (a person's or system user's Pages: Meta answers each Page's
 *     access_token by default) or of a bare object node that names no `fields` (a Page node can carry its token);
 *   - the renewal must be exactly Meta's documented call: grant_type, client_id, client_secret, fb_exchange_token and
 *     set_token_expires_in_60_days, each once, nothing else (gateway.ts also checks client_id is the connection's app);
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

/** The pieces of a Meta URL the gateway judges, or null when it is not a Graph URL at all. */
function graphPathOf(url: string): { path: string; version: string | null; search: URLSearchParams } | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol !== 'https:' || parsed.hostname !== META_GRAPH_HOST || parsed.username || parsed.password || parsed.hash || parsed.port) return null
  const match = /^\/(v\d+\.\d+)(\/.*)?$/.exec(parsed.pathname)
  return { path: match ? (match[2] ?? '/') : parsed.pathname, version: match ? match[1] : null, search: parsed.searchParams }
}

/**
 * Why the gateway refuses this Meta call, in words, or null when it may go. `auth` is how the caller asked the call to
 * be authorised (gateway.ts `GatewayRequest.auth`): only the token renewal goes without one.
 */
/** The exact query keys of the system-user token renewal (Meta's "Refresh Access Token", system-user guide). */
export const META_RENEWAL_KEYS = ['client_id', 'client_secret', 'fb_exchange_token', 'grant_type', 'set_token_expires_in_60_days'] as const
/** `access_token` as a field, at any depth of a field list (`id,access_token`, `accounts{id,access_token}`). */
const TOKEN_FIELD = /(^|[,{(\s])access_token\s*($|[,}{.(\s])/i

/** Is this the token renewal (the only sign-in call), and with which client_id? Null when it is not one. */
export function metaRenewalOf(url: string): { clientId: string } | null {
  const graph = graphPathOf(url)
  if (!graph || graph.path.replace(/^\/+|\/+$/g, '').toLowerCase() !== 'oauth/access_token') return null
  return { clientId: graph.search.get('client_id') ?? '' }
}

export function metaReadOnlyProblem(input: { method: string; url: string; kind: string; body?: unknown; auth?: unknown; headers?: Record<string, string> }): string | null {
  const method = input.method.toUpperCase()
  if (method !== 'GET') return `Nexus only reads Meta for now, and this call would change something (${method})`
  if (input.kind !== 'read') return 'Nexus only reads Meta for now, and this call is not declared a read'
  if (input.body !== undefined && input.body !== null && input.body !== '') return 'a read of Meta carries no body'
  if (input.headers && Object.keys(input.headers).length > 0) return 'a Meta call carries no header of the caller\'s own'
  const graph = graphPathOf(input.url)
  if (!graph) return 'Nexus calls Meta only at https://graph.facebook.com'
  const pinned = metaGraphApiVersion()
  if (graph.version !== pinned) return `Nexus calls Meta only on API version ${pinned} (this call: ${graph.version ?? 'no version'})`
  const segments = graph.path.split('/').filter(Boolean)
  if (segments.length === 0) return 'the Graph root (batch requests) is not a read'
  for (const key of graph.search.keys()) {
    if (NOT_A_READ_KEYS.test(key)) return `the query names "${key}", which turns a GET into a change or a batch`
    if (GATEWAY_OWNED_KEYS.has(key.toLowerCase())) return `the query names "${key}", which only the gateway sets`
  }
  const route = segments.join('/').toLowerCase()
  if (route === 'oauth/revoke') return 'oauth/revoke ends a token: Nexus never sends it'
  if (route.startsWith('oauth/')) {
    const keys = [...graph.search.keys()]
    const exact = keys.length === META_RENEWAL_KEYS.length && [...keys].sort().every((k, i) => k === META_RENEWAL_KEYS[i])
    if (route !== 'oauth/access_token' || !exact || graph.search.get('grant_type') !== 'fb_exchange_token' || input.auth !== 'none') {
      return 'the only Meta sign-in call Nexus sends is the system-user token renewal, exactly as Meta documents it (grant_type=fb_exchange_token, client_id, client_secret, fb_exchange_token, set_token_expires_in_60_days)'
    }
    return null
  }
  const fields = graph.search.getAll('fields').join(',')
  if (TOKEN_FIELD.test(fields)) return 'a read never asks Meta for an access_token'
  const last = segments[segments.length - 1].toLowerCase()
  if (last === 'accounts' && !fields) return 'a read of Pages (accounts) names its fields: Meta answers each Page\'s token by default'
  if (segments.length === 1 && /^\d+$/.test(segments[0]) && !fields) return 'a read of one object names its fields (a Page node can carry its token)'
  return null
}

/** Meta counts Business Use Case quotas per kind of call (ads management, insights) and the sign-in apart. */
export function metaCallGroup(url: string): MetaCallGroup {
  const graph = graphPathOf(url)
  const path = (graph?.path ?? '').toLowerCase()
  if (/^\/(oauth\/|debug_token(\/|$))/.test(path)) return 'auth'
  if (/\/insights\/?$/.test(path)) return 'insights'
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

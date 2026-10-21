/**
 * Meta on the gateway (Meta ads M1, 2026-10-20) — what a Meta call may be, judged before the token or the network.
 *
 * A READ (M1) is a GET, with no body, to `https://graph.facebook.com/<the pinned version>/…`
 * (services/meta/api-version.ts); a GET that is not one is refused with its ledger row (`META_READ_ONLY`), whatever kind
 * the caller declared, and anything but a GET goes to the write allow-list (metaWriteVerdict, below). On top of the
 * method, the URL itself:
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
 * Writes (step 17, 2026-10-21) are judged apart, by metaWriteVerdict below: an ALLOW-list of exact (method, path shape,
 * body keys and values) that Nexus's own change tools send — today a status change of one campaign, ad set or ad, and
 * Meta's check of it (validate_only, a campaign's only). Every other non-GET is refused; so is every batch (no Nexus
 * change sends one yet: metaBatchProblem).
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
 *   - step 2, the ad account's lists act_<id>/campaigns | adsets | ads, and a campaign's or ad set's own
 *     <id>/adsets | ads (meta-ads-live, review B5: Meta documents these, not `filtering` on act_<id>/adsets | ads):
 *     effective_status;
 *   - step 2, a portfolio's <id>/owned_ad_accounts and <id>/client_ad_accounts: search_query (AA-002; pending has none);
 *   - step 2, insights (act_<id>/insights, <object>/insights): level, time_range, time_increment, filtering — never
 *     use_unified_attribution_setting or action_report_time (Meta ignores both since 2025-06-10, facts F2 T1);
 *   - step 2, act_<id>/async_requests: status, type (master ACC-028, SDK only: a refusal from Meta answers plainly;
 *     LIVE-PROBES.md).
 */
const READ_KEYS = new Set(['fields', 'limit', 'after', 'before', 'summary'])
/**
 * Step 9 review fix A1 — the exact field list of the ONE read that carries a custom audience's special-ad-category
 * parameters (live-targeting.ts, check audience-special-category): those keys go on a bare object id only with it.
 */
export const META_AUDIENCE_SAC_FIELDS = 'id,name,is_eligible_for_sac_campaigns'
/** A route's own keys; `when`: they go only on a read whose query also passes this (review fix A1, step 9). */
const ROUTE_KEYS: Array<{ route: RegExp; keys: ReadonlySet<string>; when?: (query: URLSearchParams) => boolean }> = [
  { route: /^debug_token$/, keys: new Set(['input_token']) },
  { route: /^\d+\/authorized_adaccounts$/, keys: new Set(['business']) },
  { route: /^act_\d+\/(campaigns|adsets|ads)$/, keys: new Set(['effective_status']) },
  { route: /^\d+\/(adsets|ads)$/, keys: new Set(['effective_status']) },
  { route: /^\d+\/(owned|client)_ad_accounts$/, keys: new Set(['search_query']) },
  { route: /^(act_)?\d+\/insights$/, keys: new Set(['level', 'time_range', 'time_increment', 'filtering']) },
  { route: /^act_\d+\/async_requests$/, keys: new Set(['status', 'type']) },
  // Step 9 (meta-targeting-search / meta-targeting-check, live-targeting.ts) — each key only on its own path:
  //   - Graph's targeting search /search (not an account path; `type` only from META_SEARCH_TYPES, below);
  //   - the chosen account's targeting edges and estimates, an ad set's delivery / message estimate and plain words;
  //   - a custom audience's special-ad-category eligibility (GET /<audience id>, audiences/special-ad-category).
  {
    route: /^search$/,
    keys: new Set([
      'type', 'q', 'class', 'location_types', 'country_code', 'region_id', 'match_country_code', 'locale', 'interest_list', 'interest_fbid_list',
      'countries', 'regions', 'cities', 'zips', 'country_groups', 'latitude', 'longitude', 'distance_unit', 'targeting_option_list',
    ]),
  },
  { route: /^act_\d+\/targetingsearch$/, keys: new Set(['q', 'limit_type', 'locale', 'objective', 'regulated_categories', 'allow_only_fat_head_interests']) },
  { route: /^act_\d+\/targetingsuggestions$/, keys: new Set(['targeting_list', 'limit_type', 'locale', 'regulated_categories']) },
  { route: /^act_\d+\/targetingbrowse$/, keys: new Set(['limit_type', 'locale', 'regulated_categories']) },
  { route: /^act_\d+\/targetingvalidation$/, keys: new Set(['targeting_list', 'id_list', 'name_list', 'is_exclusion', 'locale']) },
  { route: /^act_\d+\/broadtargetingcategories$/, keys: new Set(['custom_categories_only']) },
  { route: /^act_\d+\/deprecatedtargetingadsets$/, keys: new Set(['type']) },
  { route: /^act_\d+\/reachestimate$/, keys: new Set(['targeting_spec']) },
  { route: /^(act_)?\d+\/delivery_estimate$/, keys: new Set(['optimization_goal', 'targeting_spec', 'promoted_object']) },
  // Review fix B1 — both marketing-message estimates also take a daily budget and a direct send (SDK adaccount.py and
  // adset.py get_message_delivery_estimate).
  { route: /^(act_)?\d+\/message_delivery_estimate$/, keys: new Set(['targeting_spec', 'promoted_object', 'optimization_goal', 'bid_amount', 'lifetime_budget', 'lifetime_in_days', 'pacing_type', 'daily_budget', 'is_direct_send_campaign']) },
  { route: /^act_\d+\/targetingsentencelines$/, keys: new Set(['targeting_spec', 'hide_targeting_spec_from_return']) },
  // Review fix A1 — only on the audience-eligibility read itself (its exact field list), never on another object read.
  { route: /^\d+$/, keys: new Set(['ad_account_id', 'special_ad_categories', 'special_ad_category_countries']), when: (query) => query.get('fields') === META_AUDIENCE_SAC_FIELDS },
]
/**
 * Step 9 — the `type` values a /search read may carry: targeting options only (targeting-search reference), never
 * people, Pages or places. live-targeting.ts SEARCH_TYPE_OF sends exactly these.
 */
export const META_SEARCH_TYPES: ReadonlySet<string> = new Set([
  'adgeolocation', 'adgeolocationmeta', 'adradiussuggestion', 'adinterest', 'adinterestsuggestion', 'adinterestvalid', 'adTargetingCategory',
  'adeducationschool', 'adeducationmajor', 'adworkemployer', 'adworkposition', 'adlocale', 'targetingoptionstatus',
])
/**
 * May a read of this route (the canonical one: lower case, no version), with this query, carry this key? Gateway only:
 * meta-ads-graph-read keeps its own, narrower list (graph-allow.ts GRAPH_EDGE_PARAMS, step 9 review fix A1).
 */
function keyAllowed(route: string, key: string, query: URLSearchParams): boolean {
  return READ_KEYS.has(key) || ROUTE_KEYS.some((r) => r.route.test(route) && r.keys.has(key) && (!r.when || r.when(query)))
}
/** At most this long, a `fields` value (the longest Nexus asks is far shorter). */
const MAX_FIELDS_LENGTH = 4000
/** A field name that is (or holds) a token: `access_token`, `page_access_token`, … — never asked for. */
const TOKEN_NAME = /token/i
/** `accounts` as a field (a person's or system user's Pages; Meta answers each Page's token by default). */
const ACCOUNTS_FIELD = /(?<![A-Za-z0-9_])accounts(?![A-Za-z0-9_])/gi
/** Field modifiers that may sit between a field and its own `{…}` list: `.limit(100)`, `.summary(true)`. */
const MODIFIERS = /^(?:\s*\.\s*[A-Za-z_]+\s*\([^(){}]*\))*\s*/

/**
 * Step 2 review A1 (defence in depth under meta-ads-graph-read's own guard): names no Nexus read asks inside `fields` —
 * other businesses' ad accounts and Pages, people, buyers' messages and lead-form answers. Nexus reads its own lists
 * through their edge (the path), never by expanding them into another object.
 */
const FIELD_DENIED = new Set([
  'owned_ad_accounts', 'client_ad_accounts', 'pending_owned_ad_accounts', 'pending_client_ad_accounts', 'owned_pages', 'client_pages',
  'users', 'assigned_users', 'system_users', 'business_users', 'agencies', 'leadgen_forms', 'leads', 'conversations', 'messages', 'comments',
])

/** Review 2 — never inside an expansion (`{…}` or `.fields(…)`): another object's Instagram account, owner, ratings, feed. */
const NESTED_DENIED = new Set(['instagram_business_account', 'owner_business', 'ratings', 'feed', 'blocked'])

/** A real field name: a letter first. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]*$/

/**
 * Review 3 — does every `{…}` list, at any depth, name at least one field of its own (and are the braces balanced)?
 * Modifier arguments (`.limit(5)`) and modifier names (the word after a `.`) are not fields.
 */
function bracesProblem(value: string): string | null {
  // Each open list: how many field names it holds so far. A "(" is either a `.fields(` list (review 2: exactly like
  // `{…}`) or a modifier's argument (skipped, but balanced).
  const lists: number[] = []
  const parens: Array<'list' | 'argument'> = []
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    const inArgument = parens.length > 0 && parens[parens.length - 1] === 'argument'
    if (c === '(') {
      const isFields = !inArgument && /\.\s*fields\s*$/.test(value.slice(0, i))
      parens.push(isFields ? 'list' : 'argument')
      if (isFields) lists.push(0)
      continue
    }
    if (c === ')') {
      const kind = parens.pop()
      if (kind === undefined) return 'fields has a ) with no ('
      if (kind === 'list') {
        const named = lists.pop()
        if (!named) return 'every .fields(…) in fields names a field'
      }
      continue
    }
    if (inArgument) continue
    if (c === '{') { lists.push(0); continue }
    if (c === '}') {
      const named = lists.pop()
      if (named === undefined) return 'fields has a } with no {'
      if (named === 0) return 'every {…} in fields names a field'
      continue
    }
    const startsName = /[A-Za-z]/.test(c) && (i === 0 || !/[A-Za-z0-9_]/.test(value[i - 1]))
    if (!startsName || /\.\s*$/.test(value.slice(0, i))) continue
    const name = /^[A-Za-z][A-Za-z0-9_]*/.exec(value.slice(i))![0]
    if (lists.length > 0) {
      lists[lists.length - 1]++
      // Review 2 — inside any expansion, never another object's Instagram account, owner, ratings, feed or blocked list.
      if (NESTED_DENIED.has(name.toLowerCase())) return `a read never expands "${name}" inside another field`
    }
    i += name.length - 1
  }
  if (parens.length > 0) return 'fields has a ( with no )'
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
  const denied = names.find((name) => FIELD_DENIED.has(name.toLowerCase()))
  if (denied) return `a read never expands "${denied}" inside fields (another business's assets, people or messages)`
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
  if (method !== 'GET') return refuse(`this call is not a read (${method}): a Meta change goes only through the write allow-list`)
  if (input.kind !== 'read') return refuse('a GET of Meta is a read, and this call is not declared a read')
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
    if (!keyAllowed(route, key, search)) return refuse(`the query key "${key}" is not one a Nexus read of Meta uses here`)
  }
  // Step 9 — /search reads targeting options only (META_SEARCH_TYPES), never a person, a Page or a place.
  if (route === 'search' && !META_SEARCH_TYPES.has(search.get('type') ?? '')) return refuse('a Meta search reads targeting options only: its type is one Nexus names (META_SEARCH_TYPES)')
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

// ── writes (step 17, 2026-10-21) ────────────────────────────────────────────────────────────────────────────────────

/**
 * The statuses a Nexus change writes on a campaign, ad set or ad (set-meta-status). Checked 2026-10-21 on
 * developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-campaign-group.md ("Updating", `status`
 * enum ACTIVE, PAUSED, DELETED, ARCHIVED) and best-practices/manage-your-ad-object-status.md (ARCHIVED can only go to
 * DELETED; DELETED cannot change). DELETED is not one: deleting is its own tool (not built yet), so no Nexus change sends
 * it today.
 */
export const META_WRITE_STATUSES = ['ACTIVE', 'PAUSED', 'ARCHIVED'] as const
export type MetaWriteStatus = typeof META_WRITE_STATUSES[number]

/**
 * What a change may read back in the same POST (read-after-write, master ACC-030: the campaign update "supports
 * read-after-write and will read the node to which you POSTed"; Meta's Python SDK sends `fields` on every api_update).
 */
export const META_READ_BACK_FIELDS: ReadonlySet<string> = new Set(['id', 'status', 'configured_status', 'effective_status', 'updated_time'])

/** The ONE value of `execution_options` Nexus sends: Meta's check (validate_only), which changes nothing. */
export const META_VALIDATE_ONLY = '["validate_only"]'

/**
 * Review fix A2 (2026-10-21) — Meta documents validate_only on a campaign UPDATE (reference/ad-campaign-group.md
 * "Updating"), but Nexus has not seen it honoured live yet. Until LIVE-PROBE ST17-01 shows Meta checks an update and
 * changes nothing, Nexus asks Meta's check ONLY of a change to PAUSED: had Meta wrongly applied it, a pause is harmless
 * and undoable. A change to ACTIVE or ARCHIVED is then previewed without Meta's check ("Meta's check is not used for this
 * change yet"). THE LEADER FLIPS THIS TO true after ST17-01 (meta-writes.vitest.test.ts tests both states).
 */
export const META_UPDATE_CHECK_PROVEN = false

/** May Nexus ask Meta's check (validate_only) of a status change to `status`? (Both states: see META_UPDATE_CHECK_PROVEN.) */
export function metaCheckAllowed(status: string, proven: boolean = META_UPDATE_CHECK_PROVEN): boolean {
  return proven ? (META_WRITE_STATUSES as readonly string[]).includes(status) : status === 'PAUSED'
}

/**
 * One kind of Meta change Nexus sends: the method, the path's shape, the body keys it must and may carry and a judge of
 * their values. `budget`: it moves an ad set's daily or lifetime budget (Meta's 4-an-hour limit, meta-object-limits.ts).
 * Each later step adds only the rules its own tools send, with tests (meta.vitest.test.ts).
 */
interface MetaWriteRule {
  name: string
  method: 'POST'
  /** The route, lower case, without the version (`120000000000001`). */
  path: RegExp
  required: readonly string[]
  optional: readonly string[]
  /** Why a value is refused, or null. */
  values: (params: ReadonlyMap<string, string>) => string | null
  budget: boolean
}

const fieldsValueProblem = (value: string): string | null => {
  const names = value.split(',')
  if (!names.length || names.length > META_READ_BACK_FIELDS.size) return 'fields names the fields a change reads back, each once'
  if (names.some((name) => !META_READ_BACK_FIELDS.has(name))) return `a change reads back only ${[...META_READ_BACK_FIELDS].join(', ')}`
  if (new Set(names).size !== names.length) return 'fields names each field once'
  return null
}

// Review fix A5 — exactly the string judged is the string sent: no other spelling of the same list.
const executionProblem = (value: string): string | null =>
  value === META_VALIDATE_ONLY ? null : `the only execution_options Nexus sends is exactly ${META_VALIDATE_ONLY} (Meta's check, which changes nothing)`

/** Step 17 — the write allow-list. */
const META_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // set-meta-status: POST /{campaign_id | ad_set_id | ad_id} status=ACTIVE|PAUSED|ARCHIVED, optionally Meta's check
    // (execution_options) or the read-back (fields).
    name: 'object.status',
    method: 'POST',
    path: /^\d{1,20}$/,
    required: ['status'],
    optional: ['execution_options', 'fields'],
    values: (params) => {
      const status = params.get('status') ?? ''
      if (status === 'DELETED') return 'Nexus deletes nothing on Meta yet: deleting is its own tool, not built yet'
      if (!(META_WRITE_STATUSES as readonly string[]).includes(status)) return `status is ${META_WRITE_STATUSES.join(', ')}`
      if (params.has('execution_options')) {
        const problem = executionProblem(params.get('execution_options')!)
        if (problem) return problem
        if (params.has('fields')) return 'Meta\'s check (validate_only) changes nothing, so it reads nothing back (no fields)'
        if (!metaCheckAllowed(status)) return `Nexus does not use Meta's check for a change to ${status} yet (only for a pause, until a live probe shows Meta honours validate_only on updates)`
      }
      if (params.has('fields')) return fieldsValueProblem(params.get('fields')!)
      return null
    },
    budget: false,
  },
]

/** The longest body a Nexus change sends (a status change is a few dozen characters). */
const MAX_WRITE_BODY = 2000

/** A Meta change the gateway may send, as it judged it. */
export interface MetaJudgedWrite {
  /** The allow-list entry it matched. */
  rule: string
  /** The object the change is for (the path's id): the gateway checks it is of the business's chosen ad account. */
  objectId: string
  /** Meta's check (validate_only): Meta changes nothing, so it goes as a read; else a write under the publish mode. */
  check: boolean
  /** The body as it is sent: the judged keys, written again in one order (what was judged is what goes). */
  body: string
  /** It moves an ad set's budget (Meta's 4-an-hour limit). */
  budget: boolean
}

/** The gateway's verdict on a Meta call that is not a GET: why it is refused (and whether as a batch), or the judged write. */
export type MetaWriteVerdict = { problem: string; batch?: true } | { write: MetaJudgedWrite }

/**
 * Step 17 — the verdict on one Meta call that is not a GET, judged on the same canonical parse as a read (graphRouteOf):
 * the exact allow-list above, the declared kind equal to the body's (a check = read, a change = write), the account's own
 * token, no caller headers, no query string (a change carries its parameters in its body only, so the body judged is the
 * one sent), each key named once. Whether the object is of the business's chosen ad account is the gateway's next step
 * (it needs the database or one live read), and so are Meta's per-object limits.
 */
export function metaWriteVerdict(input: { method: string; url: string; kind: string; body?: unknown; auth?: unknown; headers?: Record<string, string> }): MetaWriteVerdict {
  const refuse = (problem: string): MetaWriteVerdict => ({ problem })
  const method = input.method.toUpperCase()
  if (input.headers && Object.keys(input.headers).length > 0) return refuse('a Meta call carries no header of the caller\'s own')
  if (input.auth !== undefined && input.auth !== 'account') return refuse('a Meta change goes only with the account\'s own system-user token')
  // The Graph root with its version (`…/v26.0/`, Meta's batch endpoint) is judged as the root, so a batch is named as one.
  const graph = graphRouteOf(input.url.replace(/^(https:\/\/graph\.facebook\.com\/v\d+\.\d+)\/(?=$|[?#])/i, '$1'))
  if (!graph) return refuse('Nexus calls Meta only at https://graph.facebook.com')
  if ('problem' in graph) return refuse(graph.problem)
  const pinned = metaGraphApiVersion()
  if (graph.version !== pinned) return refuse(`Nexus calls Meta only on API version ${pinned} (this call: ${graph.version ?? 'no version'})`)
  if ([...graph.search.keys()].length > 0) return refuse('a Meta change carries its parameters in its body, never in the URL')
  const batch = metaBatchProblem(method, graph.route, input.body)
  if (batch) return { problem: batch, batch: true }
  if (method === 'DELETE') return refuse('Nexus deletes nothing on Meta yet (deleting is its own tool, not built yet), and cancels no async batch')
  if (method !== 'POST') return refuse(`Nexus sends Meta no ${method}`)
  const parsed = writeParams(input.body)
  if ('problem' in parsed) return refuse(parsed.problem)
  const keys = [...parsed.params.keys()]
  const rule = META_WRITE_RULES.find((r) => r.method === method && r.path.test(graph.route)
    && r.required.every((k) => parsed.params.has(k)) && keys.every((k) => r.required.includes(k) || r.optional.includes(k)))
  if (!rule) {
    return refuse(`the only Meta change Nexus sends is a status change of one campaign, ad set or ad (POST /<id> with status); this one is POST /${graph.segments.join('/')} with ${keys.join(', ') || 'no parameters'}`)
  }
  const problem = rule.values(parsed.params)
  if (problem) return refuse(problem)
  const check = parsed.params.has('execution_options')
  if (input.kind !== (check ? 'read' : 'write')) {
    return refuse(check ? 'Meta\'s check (validate_only) changes nothing and goes as a read; this one is declared otherwise' : 'a Meta change goes as a write; this one is declared otherwise')
  }
  const order = [...rule.required, ...rule.optional].filter((k) => parsed.params.has(k))
  const body = new URLSearchParams(order.map((k): [string, string] => [k, parsed.params.get(k)!])).toString()
  return { write: { rule: rule.name, objectId: graph.segments[0], check, body, budget: rule.budget } }
}

/** A change's body, form-encoded (Meta's `-F` fields): each key lower snake_case, named once, never a gateway key. */
function writeParams(body: unknown): { params: Map<string, string> } | { problem: string } {
  if (typeof body !== 'string' || !body) return { problem: 'a Meta change carries its parameters as a form body' }
  if (body.length > MAX_WRITE_BODY) return { problem: `a Meta change body is at most ${MAX_WRITE_BODY} characters` }
  const params = new Map<string, string>()
  for (const [key, value] of new URLSearchParams(body)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key)) return { problem: `the body key "${key.slice(0, 40)}" is not one Meta reads (lower-case letters, digits and _)` }
    if (params.has(key)) return { problem: `the body names "${key}" more than once` }
    if (GATEWAY_OWNED_KEYS.has(key) || NOT_A_READ_KEYS.test(key) || /token|secret|proof/.test(key)) return { problem: `the body names "${key}", which no Nexus change sends` }
    if (!/^[\x20-\x7e]*$/.test(value)) return { problem: `the value of "${key}" is plain ASCII` }
    params.set(key, value)
  }
  return { params }
}

// ── batches (master ACC-022 / 023 / 025–027): the plumbing, nothing allowed through it yet ──────────────────────────

/**
 * Meta's two batch forms (checked 2026-10-21: developers.facebook.com/docs/graph-api/batch-requests and
 * documentation/ads-commerce/marketing-api/asyncrequests.md, reference/ad-account/async_batch_requests):
 *   graph-batch  POST https://graph.facebook.com/<version>/ with `batch` = JSON list of {method, relative_url, body,
 *                name} — at most 50, at most 10 ad creations; independent parts run in parallel; NOT all or nothing: each
 *                part answers on its own, and on a timeout the unfinished parts come back null
 *   async-batch  POST /act_<id>/async_batch_requests with `name` + `adbatch` = JSON list of {name, relative_url, body} —
 *                at most 1,000; read back per request (GET /<request set id>, /<request set id>/requests); rename
 *                (POST /<request set id> name, notification_*) and cancel (DELETE /<request id | set id>) before they run
 * Every part of a batch would be judged exactly like a call of its own (metaWriteVerdict, then the chosen-account check
 * per object), and a batch is never treated as atomic. NO kind is allowed yet: no Nexus change needs one (set-meta-status
 * sends one request per object, in order, and reports step by step). A step that needs one adds its kind here with tests.
 * The reads of an async request set are GETs (the read gate); its rename and cancel are refused by the write allow-list.
 */
export type MetaBatchKind = 'graph-batch' | 'async-batch'
export const META_BATCH_KINDS_ALLOWED: ReadonlySet<MetaBatchKind> = new Set<MetaBatchKind>()
const MAX_BATCH_PARTS: Record<MetaBatchKind, number> = { 'graph-batch': 50, 'async-batch': 1000 }

/** Which batch form a call is, or null. */
export function metaBatchKindOf(method: string, route: string): MetaBatchKind | null {
  if (method.toUpperCase() !== 'POST') return null
  if (route === '') return 'graph-batch'
  if (/^act_\d+\/async_batch_requests$/.test(route)) return 'async-batch'
  return null
}

/**
 * Why a batch-shaped call is refused (null: it is not a batch). Each part is judged as a change of its own, so the
 * sentence names the first part Nexus would not send even one by one.
 */
export function metaBatchProblem(method: string, route: string, body: unknown): string | null {
  const kind = metaBatchKindOf(method, route)
  if (!kind) return null
  const parts = batchParts(kind, body)
  const detail = 'problem' in parts ? parts.problem : parts.problems[0] ?? null
  if (!META_BATCH_KINDS_ALLOWED.has(kind) || detail) {
    const why = kind === 'graph-batch'
      ? 'Nexus sends no Meta batch request yet: no Nexus change needs one, and Meta runs a batch\'s parts one by one (some can succeed while others fail; on a timeout the unfinished ones come back empty), so each change goes as its own request'
      : 'Nexus sends no Meta async batch yet: no Nexus change needs one, and Meta runs each of its requests on its own (not all or nothing), so each change goes as its own request'
    return detail ? `${why} (${detail})` : why
  }
  return null
}

/** The parts of a batch body, each judged as its own change (a write), or why the body is not one. */
function batchParts(kind: MetaBatchKind, body: unknown): { problems: string[] } | { problem: string } {
  if (typeof body !== 'string') return { problem: 'the batch has no form body' }
  const form = new URLSearchParams(body)
  const listKey = kind === 'graph-batch' ? 'batch' : 'adbatch'
  const raw = form.get(listKey)
  if (raw === null) return { problem: `it names no ${listKey}` }
  let list: unknown
  try { list = JSON.parse(raw) } catch { return { problem: `${listKey} is not JSON` } }
  if (!Array.isArray(list) || list.length === 0) return { problem: `${listKey} is not a list of requests` }
  if (list.length > MAX_BATCH_PARTS[kind]) return { problem: `Meta takes at most ${MAX_BATCH_PARTS[kind]} requests in one ${kind}` }
  const problems: string[] = []
  list.forEach((part, i) => {
    const p = (part && typeof part === 'object' ? part : {}) as Record<string, unknown>
    const where = `part ${i + 1}`
    const relative = typeof p.relative_url === 'string' ? p.relative_url : ''
    const partBody = typeof p.body === 'string' ? p.body : ''
    if (/\{result=/.test(relative) || /\{result=/.test(partBody)) { problems.push(`${where} depends on another part's result`); return }
    if (p.attached_files !== undefined) { problems.push(`${where} attaches a file`); return }
    const path = relative.replace(/^\/+/, '').replace(/^v\d+\.\d+\//, '')
    if (metaBatchKindOf('POST', path.split('?')[0].toLowerCase()) !== null) { problems.push(`${where} is a batch inside a batch`); return }
    const method = kind === 'async-batch' ? 'POST' : typeof p.method === 'string' ? p.method : 'GET'
    const verdict = metaWriteVerdict({ method, url: `https://${META_GRAPH_HOST}/${metaGraphApiVersion()}/${path}`, kind: 'write', body: partBody })
    if ('problem' in verdict) problems.push(`${where}: ${verdict.problem}`)
  })
  return { problems }
}

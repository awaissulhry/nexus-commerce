/**
 * Meta step 39 (2026-10-21) — brand safety on the write allow-list: the exact (method, path, keys, values) that
 * set-meta-brand-safety, set-meta-block-list and remove-meta-block-list send, each key judged, JSON values in ONE
 * spelling (the string judged is the string sent), text only where a person types it (a list's name). What the gateway
 * then checks against Meta itself (gateway.ts → meta-brand-safety-owner.ts): every object is the chosen ad account's or
 * its business portfolio's, and an ad set's targeting differs from its LIVE targeting only in the brand-safety keys.
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/…, `.md` pages; Meta's Python
 * Business SDK facebook_business/adobjects/{adaccount,business,targeting,publisherblocklist,apppublisher,webpublisher}.py
 * and the codegen spec PublisherBlockList.json on GitHub main; Graph's targeting reference docs/graph-api/reference/targeting):
 *   - audiences/reference/placement-targeting.md — inside an ad set's `targeting`: brand_safety_content_filter_levels
 *     (in-content FACEBOOK_, Audience Network AN_, feeds FEED_ × RELAXED / STANDARD / STRICT = Expanded / Moderate /
 *     Limited; "when a filter is applied at the ad account level, only more restrictive options will be available at the
 *     campaign level"), excluded_publisher_categories (dating, gambling; Audience Network and in-stream also
 *     debated_social_issues, mature_audiences, tragedy_and_conflict), excluded_publisher_list_ids (numeric strings).
 *     Graph's targeting reference adds brand_safety_content_severity_levels and excluded_brand_safety_content_types
 *     (list<string>; "for example Instream live gaming") with NO value list (the SDK's Targeting has the second only;
 *     feed-verification.md's "Ad Set API" sample reads back ["INSTREAM_LIVE"], the one documented content type; the
 *     severity levels are documented nowhere): Nexus sends them as Meta's own token shape and lets Meta judge
 *     (LIVE-PROBES TG-094-097).
 *     effective_brand_safety_content_filter_levels is "Read-only" there: an `effective_…` key is never sent back.
 *   - The account-level filter (master AA-060): POST /act_{id}/brand_safety_content_filter_levels with
 *     brand_safety_content_filter_levels (list enum) and business_id (optional) — SDK adaccount.py
 *     create_brand_safety_content_filter_level only (the docs page is not found; the read field is documented on the
 *     ad account). Nexus sends only the nine documented values (the SDK enum also has FEED_DNM, FEED_NESTED_DNM,
 *     FEED_SELECT, UNINITIALIZED, UNKNOWN: meaning undocumented) — LIVE-PROBES AA-060.
 *   - brand-safety-and-suitability/block-list.md (grant block_list_management_v2_api_access): POST
 *     /{business_id}/block_list_drafts publisher_urls_file (a file: the guide's sample is a .txt; "if the upload file has
 *     more than 10,000 rows, multiple block lists will need to be created" — one URL per row; SDK type 'file'), GET
 *     /{draft_id}?fields=async_job_status,async_percent_completion (scheduled | failed | running | success), POST
 *     /{business_id}/publisher_block_lists name + draft_id (+ block_list_id to replace; "if you upload multiple block
 *     lists with the same name, the last block list uploaded will replace the ones uploaded prior"), DELETE
 *     /{block_list_id} ("must first be unshared from all Business Managers"), POST|DELETE /{block_list_id}/agencies
 *     agency_id + permitted_roles ['APPLY_BLOCK_LIST' | 'MANAGE_BLOCK_LIST'], POST|DELETE /{block_list_id}/assigned_users
 *     user + permitted_roles, POST /{block_list_id}/auto_applied_ad_accounts account_id, business_id (optional),
 *     is_auto_blocking_on true | false. The guide sends each DELETE's parameter as a form field (`curl -X DELETE -F
 *     agency_id=…`): Nexus sends them in the body like every change (LIVE-PROBES BS-014).
 *   - reference/ad-account/publisher_block_lists.md: POST /act_{id}/publisher_block_lists name (no update, no delete on
 *     that edge).
 *   - brand-safety-and-suitability/content-block-lists.md (grant brand_safety_content_block_list): POST
 *     /{business_id}/content_block_lists name; POST /{cbl_id} name; DELETE /{cbl_id} ("must not be applied to any ad
 *     accounts"); POST|DELETE /{cbl_id}/content facebook_ids, instagram_ids, threads_ids (List<fbid>, "Maximum 50K per
 *     mutation"); POST|DELETE /{cbl_id}/applied_ad_accounts account_id; the CSV export (a PUT on api.facebook.com) is
 *     meta-calls.ts metaRestFileExportOf.
 */
import type { MetaWriteBodyId, MetaWriteRule } from './meta-calls.js'
import { META_NAME_TEXT } from './meta-settings-rules.js'

/**
 * An ad set's whole targeting as Meta answered it goes back: any printable text, a format character included (an
 * interest's or a place's name as Meta holds it) — never a control character or a line separator. Every key but the
 * brand-safety ones must equal the live targeting anyway (the gateway compares), and those are judged token by token.
 */
const TARGETING_TEXT = /^[^\p{Cc}\p{Cs}\u2028\u2029]*$/u

type Params = ReadonlyMap<string, string>
type Judge = (value: string, params: Params) => string | null

// ── facts ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The three surfaces of the inventory filter: in-content (Facebook in-stream, Reels), Audience Network, feeds. */
export const FILTER_SURFACES = ['FACEBOOK', 'AN', 'FEED'] as const
export type FilterSurface = typeof FILTER_SURFACES[number]
/** Loosest first: RELAXED = Expanded, STANDARD = Moderate, STRICT = Limited (placement-targeting.md). */
export const FILTER_STRENGTHS = ['RELAXED', 'STANDARD', 'STRICT'] as const
export type FilterStrength = typeof FILTER_STRENGTHS[number]
/** The nine documented values, e.g. FACEBOOK_STRICT, AN_RELAXED, FEED_STANDARD. */
export const FILTER_LEVELS: readonly string[] = FILTER_SURFACES.flatMap((surface) => FILTER_STRENGTHS.map((strength) => `${surface}_${strength}`))
export const PUBLISHER_CATEGORIES = ['dating', 'gambling', 'debated_social_issues', 'mature_audiences', 'tragedy_and_conflict'] as const
/** The keys of an ad set's targeting a brand-safety change may set; every other key goes back exactly as Meta has it. */
export const BRAND_SAFETY_TARGETING_KEYS = [
  'brand_safety_content_filter_levels', 'excluded_publisher_categories', 'excluded_publisher_list_ids', 'brand_safety_content_severity_levels', 'excluded_brand_safety_content_types',
] as const
export type BrandSafetyTargetingKey = typeof BRAND_SAFETY_TARGETING_KEYS[number]
export const BLOCK_LIST_ROLES = ['APPLY_BLOCK_LIST', 'MANAGE_BLOCK_LIST'] as const

/** The longest form body of a targeting change (the whole spec goes, form-encoded); a larger ad set is refused in words. */
export const MAX_TARGETING_BODY = 200_000
/** At most this many block lists excluded by one ad set (Meta names no number; far above Meta's per-campaign thresholds). */
export const MAX_EXCLUDED_LISTS = 100
/** At most this many severity levels or content types (values undocumented: Meta's own token shape). */
export const MAX_SAFETY_TOKENS = 20
/**
 * URLs in one block-list file Nexus makes: Meta takes 10,000 per list; Nexus's tool arguments hold at most 250 (the tool
 * contract's bound), so a list Nexus writes holds at most 250.
 */
export const MAX_BLOCK_LIST_URLS = 250
export const MAX_URL_LENGTH = 300
/** The ONE file part Nexus sends (block_list_drafts): its form key, file name and content type are fixed here. */
export const BLOCK_LIST_FILE = { key: 'publisher_urls_file', filename: 'publisher_urls.txt', contentType: 'text/plain' } as const
export const MAX_BLOCK_LIST_FILE_BYTES = MAX_BLOCK_LIST_URLS * (MAX_URL_LENGTH + 1)
/**
 * Posts per platform in one content block-list request: Meta takes 50,000 per mutation; Nexus's tool arguments hold 250
 * per platform, so one request carries at most 750 ids (well inside the rule's body cap). Never a batch.
 */
export const MAX_POSTS_PER_PLATFORM = 250
const MAX_POSTS_BODY = 40_000
const NAME_MAX = 200

// ── values ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const DIGITS = /^\d{1,20}$/
const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** A JSON value written the one way Nexus writes it (JSON.stringify of what it parses to), or undefined. */
export function canonicalJson(value: string): unknown {
  try {
    const parsed: unknown = JSON.parse(value)
    return JSON.stringify(parsed) === value ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Does a parsed JSON value hold a whole number JavaScript cannot carry exactly (an id Meta wrote as a number)? */
export function holdsInexactNumber(value: unknown, depth = 0): boolean {
  if (depth > 64) return true
  if (typeof value === 'number') return Number.isInteger(value) && !Number.isSafeInteger(value)
  if (Array.isArray(value)) return value.some((v) => holdsInexactNumber(v, depth + 1))
  if (plainObject(value)) return Object.values(value).some((v) => holdsInexactNumber(v, depth + 1))
  return false
}

const idDigits = (what: string): Judge => (value) => (DIGITS.test(value) ? null : `${what} is a Meta id (digits)`)
const oneOf = (values: readonly string[], what: string): Judge => (value) => (values.includes(value) ? null : `${what} is one of ${values.join(', ')}`)
const listName: Judge = (value) => (value.trim() === value && value.length >= 1 && [...value].length <= NAME_MAX ? null : `a block list's name is 1 to ${NAME_MAX} characters, with no space at either end`)

function judged(judges: Record<string, Judge>, also?: (params: Params) => string | null) {
  return (params: Params): string | null => {
    for (const [key, value] of params) {
      const judge = judges[key]
      if (!judge) return `${key} is not a key of this change`
      const problem = judge(value, params)
      if (problem) return problem
    }
    return also ? also(params) : null
  }
}

/** A list of unique strings, each passing `ok`, at most `max` (an empty list is allowed only where `min` is 0). */
function stringList(list: unknown, ok: (v: string) => boolean, max: number, min = 0): boolean {
  return Array.isArray(list) && list.length >= min && list.length <= max && list.every((v) => typeof v === 'string' && ok(v)) && new Set(list).size === list.length
}

/** The surface of a documented filter level (FACEBOOK_STRICT → FACEBOOK), or null. */
export function surfaceOf(level: string): FilterSurface | null {
  if (!FILTER_LEVELS.includes(level)) return null
  return FILTER_SURFACES.find((surface) => level.startsWith(`${surface}_`)) ?? null
}

/** Inventory filter levels: documented values only, each surface at most once. */
export function filterLevelsProblem(list: unknown, where: string, min = 0): string | null {
  if (!stringList(list, (v) => FILTER_LEVELS.includes(v), FILTER_SURFACES.length, min)) {
    return `${where} lists ${min ? 'one to three' : 'at most three'} of ${FILTER_LEVELS.join(', ')}, each once`
  }
  const surfaces = (list as string[]).map(surfaceOf)
  return new Set(surfaces).size === surfaces.length ? null : `${where} has one level per placement (in-content FACEBOOK_, Audience Network AN_, feeds FEED_)`
}

const SAFETY_TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/**
 * The value judge of each brand-safety key of an ad set's targeting, for a value the change SETS (a key it does not touch
 * goes back as Meta has it, whatever Meta wrote there).
 */
export function brandSafetyValueProblem(key: BrandSafetyTargetingKey, value: unknown): string | null {
  switch (key) {
    case 'brand_safety_content_filter_levels': return filterLevelsProblem(value, 'targeting.brand_safety_content_filter_levels')
    case 'excluded_publisher_categories':
      return stringList(value, (v) => (PUBLISHER_CATEGORIES as readonly string[]).includes(v), PUBLISHER_CATEGORIES.length) ? null : `targeting.excluded_publisher_categories lists ${PUBLISHER_CATEGORIES.join(', ')}, each once`
    case 'excluded_publisher_list_ids':
      return stringList(value, (v) => DIGITS.test(v), MAX_EXCLUDED_LISTS) ? null : `targeting.excluded_publisher_list_ids lists block list ids (digits, as JSON strings), each once, at most ${MAX_EXCLUDED_LISTS}`
    case 'brand_safety_content_severity_levels':
    case 'excluded_brand_safety_content_types':
      return stringList(value, (v) => SAFETY_TOKEN.test(v), MAX_SAFETY_TOKENS) ? null : `targeting.${key} lists at most ${MAX_SAFETY_TOKENS} of Meta's values (a letter, then letters, digits or _), each once`
  }
}

/** A targeting value as the rule takes it before the live comparison: one JSON object, written once, every number exact. */
function targetingShapeProblem(value: string): string | null {
  const parsed = canonicalJson(value)
  if (!plainObject(parsed)) return 'targeting is one JSON object in one spelling only (as Nexus writes it)'
  if (holdsInexactNumber(parsed)) return 'targeting holds a number Nexus cannot carry exactly'
  return null
}

const levelsJudge: Judge = (value) => {
  const parsed = canonicalJson(value)
  return parsed === undefined ? 'brand_safety_content_filter_levels is a JSON list in one spelling only' : filterLevelsProblem(parsed, 'brand_safety_content_filter_levels', 1)
}

const FACEBOOK_POST = /^\d{1,20}(_\d{1,20})?$/
const postIds = (key: string, pattern: RegExp): Judge => (value) => {
  const parsed = canonicalJson(value)
  return stringList(parsed, (v) => pattern.test(v), MAX_POSTS_PER_PLATFORM, 1) ? null : `${key} is a JSON list of 1 to ${MAX_POSTS_PER_PLATFORM} post ids (as strings), each once`
}
const POST_JUDGES: Record<string, Judge> = {
  facebook_ids: postIds('facebook_ids', FACEBOOK_POST),
  instagram_ids: postIds('instagram_ids', DIGITS),
  threads_ids: postIds('threads_ids', DIGITS),
}
const POST_KEYS = Object.keys(POST_JUDGES)

// ── the URL file of a publisher block list (Q8: Nexus builds it; never a path, a URL to fetch or bytes from a caller) ─

/** Query keys that name a secret (a token, a signature, a session…): never in a block-list URL. */
const SECRET_QUERY_KEY = /token|secret|signature|^sig$|passw|session|auth|api_?key|^key$|^code$|^oh$|^oe$|^__cft__/i
/** A value shaped like a token: Meta's (EAA…) or any long opaque string. */
const TOKEN_VALUE = /EAA[A-Za-z0-9]{20,}|^[A-Za-z0-9_-]{32,}$/
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

/**
 * One block-list entry as Nexus writes it, or why it is refused: a plain host (`example.com`, lower case) or an https
 * URL (as the URL parser writes it), ASCII, at most 300 characters, no user or password, no port, no fragment, no
 * query key that names a secret and no token-shaped value. A host with a path and no scheme (`www.facebook.com/a-page`,
 * how Meta answers a blocked Page) is written as its https URL.
 */
export function blockListEntry(raw: string): { entry: string } | { problem: string } {
  const value = raw.trim()
  const bad = (why: string) => ({ problem: `"${value.slice(0, 80)}" ${why}` })
  if (!value) return { problem: 'an empty entry' }
  if (!/^[\x21-\x7e]+$/.test(value)) return bad('is not plain ASCII without spaces')
  if (value.length > MAX_URL_LENGTH) return bad(`is longer than ${MAX_URL_LENGTH} characters`)
  if (HOST.test(value.toLowerCase())) return { entry: value.toLowerCase() }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https:\/\//i.test(value)) return bad('is not a plain host or an https URL')
  let url: URL
  try { url = new URL(/^https:\/\//i.test(value) ? value : `https://${value}`) } catch { return bad('is not a plain host or an https URL') }
  if (url.username || url.password) return bad('carries a user name or password')
  if (url.port) return bad('names a port')
  if (url.hash) return bad('carries a fragment (#…)')
  if (!HOST.test(url.hostname)) return bad('has no plain host name')
  for (const [key, v] of url.searchParams) {
    if (SECRET_QUERY_KEY.test(key)) return bad(`carries "${key}" in its query, which can hold a secret`)
    if (TOKEN_VALUE.test(v)) return bad('carries a value in its query that looks like a token')
  }
  const entry = url.href
  if (entry.length > MAX_URL_LENGTH) return bad(`is longer than ${MAX_URL_LENGTH} characters`)
  return { entry }
}

/** The file text Nexus uploads: one entry per line, each once, at most MAX_BLOCK_LIST_URLS; or why it cannot be made. */
export function blockListFileOf(urls: readonly string[]): { text: string; entries: string[] } | { problem: string } {
  const entries: string[] = []
  for (const raw of urls) {
    const one = blockListEntry(raw)
    if ('problem' in one) return { problem: `A block list holds plain hosts or https URLs: ${one.problem}.` }
    if (!entries.includes(one.entry)) entries.push(one.entry)
  }
  if (!entries.length) return { problem: 'A block list file names at least one host or URL.' }
  if (entries.length > MAX_BLOCK_LIST_URLS) return { problem: `Nexus writes at most ${MAX_BLOCK_LIST_URLS} hosts or URLs into one block list (Meta takes 10,000; Nexus's tool arguments hold ${MAX_BLOCK_LIST_URLS}).` }
  return { text: entries.join('\n'), entries }
}

/** The gateway's judge of the file text itself: every line an entry exactly as Nexus writes it, each once, within the caps. */
export function blockListFileProblem(text: string): string | null {
  if (Buffer.byteLength(text, 'utf8') > MAX_BLOCK_LIST_FILE_BYTES) return `the block-list file is at most ${MAX_BLOCK_LIST_FILE_BYTES} bytes`
  const lines = text.split('\n')
  if (!lines.length || lines.length > MAX_BLOCK_LIST_URLS) return `the block-list file holds 1 to ${MAX_BLOCK_LIST_URLS} lines`
  const seen = new Set<string>()
  for (const line of lines) {
    const one = blockListEntry(line)
    if ('problem' in one) return `the block-list file holds only plain hosts or https URLs: ${one.problem}`
    if (one.entry !== line) return 'the block-list file holds each entry exactly as Nexus writes it'
    if (seen.has(line)) return 'the block-list file names each entry once'
    seen.add(line)
  }
  return null
}

// ── an ad set's targeting against its live targeting (the gateway's own live read; targeting-merge.ts uses it too) ──

/**
 * Read-only keys Meta may answer inside a targeting spec, never sent back: `effective_…` (Graph's targeting reference) and
 * `subscriber_universe` (placement-targeting.md, "Marketing messages subscriber targeting": read-only; codegen Targeting.json).
 */
export const isReadOnlyTargetingKey = (key: string): boolean => /^effective_|^subscriber_universe$/.test(key)

/** The same JSON value: objects key by key in any order, lists in order, numbers and strings exactly. */
export function sameJson(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > 64) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i], depth + 1))
  }
  if (plainObject(a) || plainObject(b)) {
    if (!plainObject(a) || !plainObject(b)) return false
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k], depth + 1))
  }
  return a === b
}

/**
 * Why a targeting spec sent to an ad set is more than a brand-safety change of its LIVE targeting, or null: every key
 * outside `keys` is the live value exactly (none added, none dropped but a read-only `effective_…` one, none sent that is
 * read-only), and every brand-safety key the change SETS to something new passes its value judge.
 */
export function targetingOutsideProblem(live: Record<string, unknown>, sent: Record<string, unknown>, keys: ReadonlySet<string>): string | null {
  const only = `a brand-safety change changes only ${[...keys].join(', ')}`
  for (const key of Object.keys(sent)) {
    if (isReadOnlyTargetingKey(key)) return `targeting.${key} is read-only (Meta computes it), so Nexus never sends it`
    if (keys.has(key)) {
      if (Object.prototype.hasOwnProperty.call(live, key) && sameJson(live[key], sent[key])) continue
      const problem = brandSafetyValueProblem(key as BrandSafetyTargetingKey, sent[key])
      if (problem) return problem
      continue
    }
    if (!Object.prototype.hasOwnProperty.call(live, key)) return `targeting.${key} is not in the ad set's live targeting: ${only}`
    if (!sameJson(live[key], sent[key])) return `targeting.${key} differs from the ad set's live targeting: ${only}`
  }
  for (const key of Object.keys(live)) {
    if (keys.has(key) || isReadOnlyTargetingKey(key)) continue
    if (!Object.prototype.hasOwnProperty.call(sent, key)) return `targeting.${key} of the ad set's live targeting is missing: ${only}`
  }
  return null
}

// ── the rules ───────────────────────────────────────────────────────────────────────────────────────────────────────

const ADSET_KIND = ['adsettargeting'] as const
const draftIds = (params: Params): MetaWriteBodyId[] => [
  { id: params.get('draft_id') ?? '', kind: 'blocklistdraft' },
  ...(params.has('block_list_id') ? [{ id: params.get('block_list_id')!, kind: 'publisherblocklist' as const }] : []),
]
const accountIds = (params: Params): MetaWriteBodyId[] => [
  { id: params.get('account_id') ?? '', kind: 'adaccount' },
  ...(params.has('business_id') ? [{ id: params.get('business_id')!, kind: 'business' as const }] : []),
]
const roles = oneOf(BLOCK_LIST_ROLES.map((r) => `["${r}"]`), 'permitted_roles (as JSON)')

/** Step 39 — set-meta-brand-safety, set-meta-block-list and remove-meta-block-list on the write allow-list. */
export const META_BRAND_SAFETY_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // BS-001/003/004, TG-093–097: POST /{ad_set_id} targeting=<the whole spec> (Q7). The gateway reads the ad set's live
    // targeting itself and refuses any key outside `targeting` that is not exactly Meta's (meta-brand-safety-owner.ts).
    name: 'adset.brand_safety',
    method: 'POST',
    path: /^\d{1,20}$/,
    // Its own kind: an ad set's targeting (the gateway confirms an ad set in its own live read) — never step 18's ad set
    // settings, which do not take targeting.
    kinds: [...ADSET_KIND],
    required: ['targeting'],
    optional: [],
    text: { targeting: TARGETING_TEXT },
    maxBody: MAX_TARGETING_BODY,
    values: judged({ targeting: targetingShapeProblem }),
    budget: false,
    targeting: new Set(BRAND_SAFETY_TARGETING_KEYS),
  },
  {
    // AA-060 (SDK only): the account-level inventory filter.
    name: 'adaccount.brand_safety_filter',
    method: 'POST',
    path: /^act_\d{1,20}\/brand_safety_content_filter_levels$/,
    kinds: ['adaccount'],
    required: ['brand_safety_content_filter_levels'],
    optional: [],
    values: judged({ brand_safety_content_filter_levels: levelsJudge }),
    budget: false,
  },
  {
    // BS-005: the URL file as a draft (multipart, the one file part Nexus sends; no other key).
    name: 'blocklist.draft',
    method: 'POST',
    path: /^\d{1,20}\/block_list_drafts$/,
    kinds: ['business'],
    required: [],
    optional: [],
    file: { ...BLOCK_LIST_FILE, maxBytes: MAX_BLOCK_LIST_FILE_BYTES, judge: blockListFileProblem },
    values: () => null,
    budget: false,
  },
  {
    // BS-007 (create from the draft) and BS-008 (replace: block_list_id).
    name: 'blocklist.create',
    method: 'POST',
    path: /^\d{1,20}\/publisher_block_lists$/,
    kinds: ['business'],
    required: ['name', 'draft_id'],
    optional: ['block_list_id'],
    text: { name: META_NAME_TEXT },
    values: judged({ name: listName, draft_id: idDigits('draft_id'), block_list_id: idDigits('block_list_id') }),
    budget: false,
    ids: draftIds,
  },
  {
    // BS-011: an empty block list of the ad account.
    name: 'adaccount.blocklist_create',
    method: 'POST',
    path: /^act_\d{1,20}\/publisher_block_lists$/,
    kinds: ['adaccount'],
    required: ['name'],
    optional: [],
    text: { name: META_NAME_TEXT },
    values: judged({ name: listName }),
    budget: false,
  },
  { name: 'blocklist.delete', method: 'DELETE', path: /^\d{1,20}$/, kinds: ['publisherblocklist'], required: [], optional: [], values: () => null, budget: false },
  {
    name: 'blocklist.share',
    method: 'POST',
    path: /^\d{1,20}\/agencies$/,
    kinds: ['publisherblocklist'],
    required: ['agency_id', 'permitted_roles'],
    optional: [],
    values: judged({ agency_id: idDigits('agency_id'), permitted_roles: roles }),
    budget: false,
    ids: (params) => [{ id: params.get('agency_id') ?? '', kind: 'agency' }],
  },
  {
    // Review A6 — the portfolio unshared from is judged like the one shared with (never one another business in Nexus uses).
    name: 'blocklist.unshare',
    method: 'DELETE',
    path: /^\d{1,20}\/agencies$/,
    kinds: ['publisherblocklist'],
    required: ['agency_id'],
    optional: [],
    values: judged({ agency_id: idDigits('agency_id') }),
    budget: false,
    ids: (params) => [{ id: params.get('agency_id') ?? '', kind: 'agency' }],
  },
  {
    name: 'blocklist.assign_user',
    method: 'POST',
    path: /^\d{1,20}\/assigned_users$/,
    kinds: ['publisherblocklist'],
    required: ['user', 'permitted_roles'],
    optional: [],
    values: judged({ user: idDigits('user'), permitted_roles: roles }),
    budget: false,
  },
  { name: 'blocklist.unassign_user', method: 'DELETE', path: /^\d{1,20}\/assigned_users$/, kinds: ['publisherblocklist'], required: ['user'], optional: [], values: judged({ user: idDigits('user') }), budget: false },
  {
    name: 'blocklist.apply_account',
    method: 'POST',
    path: /^\d{1,20}\/auto_applied_ad_accounts$/,
    kinds: ['publisherblocklist'],
    required: ['account_id', 'is_auto_blocking_on'],
    optional: ['business_id'],
    values: judged({ account_id: idDigits('account_id'), is_auto_blocking_on: oneOf(['true', 'false'], 'is_auto_blocking_on'), business_id: idDigits('business_id') }),
    budget: false,
    ids: accountIds,
  },
  {
    name: 'contentblocklist.create',
    method: 'POST',
    path: /^\d{1,20}\/content_block_lists$/,
    kinds: ['business'],
    required: ['name'],
    optional: [],
    text: { name: META_NAME_TEXT },
    values: judged({ name: listName }),
    budget: false,
  },
  {
    name: 'contentblocklist.rename',
    method: 'POST',
    path: /^\d{1,20}$/,
    kinds: ['contentblocklist'],
    required: ['name'],
    optional: [],
    text: { name: META_NAME_TEXT },
    values: judged({ name: listName }),
    budget: false,
  },
  { name: 'contentblocklist.delete', method: 'DELETE', path: /^\d{1,20}$/, kinds: ['contentblocklist'], required: [], optional: [], values: () => null, budget: false },
  { name: 'contentblocklist.add', method: 'POST', path: /^\d{1,20}\/content$/, kinds: ['contentblocklist'], required: [], optional: POST_KEYS, anyOf: POST_KEYS, maxBody: MAX_POSTS_BODY, values: judged(POST_JUDGES), budget: false },
  { name: 'contentblocklist.remove', method: 'DELETE', path: /^\d{1,20}\/content$/, kinds: ['contentblocklist'], required: [], optional: POST_KEYS, anyOf: POST_KEYS, maxBody: MAX_POSTS_BODY, values: judged(POST_JUDGES), budget: false },
  {
    name: 'contentblocklist.apply',
    method: 'POST',
    path: /^\d{1,20}\/applied_ad_accounts$/,
    kinds: ['contentblocklist'],
    required: ['account_id'],
    optional: [],
    values: judged({ account_id: idDigits('account_id') }),
    budget: false,
    ids: accountIds,
  },
  {
    name: 'contentblocklist.unapply',
    method: 'DELETE',
    path: /^\d{1,20}\/applied_ad_accounts$/,
    kinds: ['contentblocklist'],
    required: ['account_id'],
    optional: [],
    values: judged({ account_id: idDigits('account_id') }),
    budget: false,
    ids: accountIds,
  },
]

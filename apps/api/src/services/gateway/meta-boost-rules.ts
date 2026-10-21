/**
 * Meta step 26 (2026-10-21) — the write allow-list entries of create-meta-boost and set-meta-partnership-access. A boost's
 * creative itself goes through step 25's ONE creative judge (meta-creative-rules.ts: its existing-post sources, sourceAssets);
 * these are the calls beside it:
 *
 *   adaccount.video.partner        POST   /act_<id>/advideos   source_instagram_media_id + partnership_ad_ad_code +
 *                                                                is_partnership_ad=true — a creator's Instagram video copied
 *                                                                into the chosen ad account's video library with the
 *                                                                creator's ad code (MD-138)
 *   iguser.partnership.permission  POST   /<ig id>/branded_content_ad_permissions   creator_instagram_account [+ revoke=true]
 *                                                                (CR-344 ask, CR-346 revoke)
 *   iguser.tagApproval.add         POST   /<ig id>/branded_content_tag_approval     user_ids (CR-354)
 *   iguser.tagApproval.remove      DELETE /<ig id>/branded_content_tag_approval     user_ids (CR-355)
 *   igmedia.adCode.remove          DELETE /<media id>/partnership_ad_code           no parameter (CR-364)
 *   iguser.collab.respond          POST   /<ig id>/collaboration_invites            media_id + accept (MD-132)
 *
 * The object each names is checked by the gateway before anything is sent (gateway.ts metaInstagramOwnerProblem; the ad account
 * of a video copy by step 19's `adaccount` check): `<ig id>`
 * IS the business's chosen Instagram account, `<media id>` is a media of it. Every id inside the body: a creator (never the
 * chosen account itself, never an Instagram account another Nexus business chose — `partnerinstagram`), a Collab invite the
 * chosen account has pending (`collabinvite`), a creator's ad code whose content Meta's content discovery lists for the brand,
 * of no other Nexus business, unlocking exactly the media named (`adcode`). Meta documents no validate_only on any of these
 * edges: the change tools say "Meta has no check for this change". An ad code is never quoted in a sentence, and a body that
 * carries one never reaches the ledger (`secret`).
 *
 * CR-363 (an ad code made for the business's own media) is answered in words, never sent: Meta answers the code once, in the
 * answer to that call, and no Nexus path shows a run's answer to the person afterwards (marketing/meta-ads/change-boosts.ts).
 *
 * Review B1 (round 1) — the Facebook side lives on Meta's partnership REST host, api.facebook.com (metaRestWriteVerdict below):
 *   POST   partnership-ads/fb-account-level-permissions/<page>                    [{"partner_page_id":N,"action":A}, …]
 *            A: send-request, cancel-request, accept-request, reject-request, revoke-permission (Meta's own examples
 *            send "revoke-permission" where its list says "remove-permission": LIVE-PROBES CR-352r)
 *   PUT    partnership-ads/fb-branded-content/<page>/brand-allowlist-status?is_enabled=true|false   (no body)
 *   POST   partnership-ads/fb-branded-content/<page>/brand-allowlisted-creators   {"creator_page_ids":[N, …]}
 *   DELETE partnership-ads/fb-branded-content/<page>/brand-allowlisted-creators?creator_page_ids=[N, …]   (no body)
 *   DELETE partnership-ads/fb-branded-content/<page>/branded-content-posts?post_ids=[N, …]   (no body)
 * <page> IS the business's chosen Page (kind `page`: step 28's check); each partner / creator Page is no other Nexus business's and never the
 * chosen Page (`partnerpage`); each post is one Meta lists among the branded-content posts that tag the chosen Page, by a
 * creator no other Nexus business uses (`brandedpost`). The token is the account's system-user token as `Authorization:
 * Bearer`, with `X-API-Version: 1.0.0` (the gateway sets both; no caller header) — "All endpoints require an Authorization:
 * Bearer token" + facebook_branded_content_ads_brand (fb-account-level-permissioning.md, branded-content-permissions.md; step 16
 * reads the same host so). If Meta refuses the system user, the step says Meta's words; step 36's Page-token mode (`auth:
 * 'page'`) is the fallback, not built here. Each list is NOT atomic: Meta answers per item.
 *
 * Checked 2026-10-21 (curl ≥ 3 s apart, developers.facebook.com/documentation/…; Meta's Python Business SDK main,
 * facebook_business/adobjects):
 *   - ads-commerce/marketing-api/ad-creative/partnership-ads/account-level-permissioning.md: POST
 *     /{business-account-id}/branded_content_ad_permissions with creator_instagram_account (or _username) → {id}; revoke=true;
 *     instagram_branded_content_ads_brand + instagram_basic + business_management; SDK iguser.py
 *     create_branded_content_ad_permission (creator_instagram_account, creator_instagram_username: string; revoke: bool).
 *   - …/partnership-ads/post-level-permissioning.md: POST / DELETE /{user-id}/branded_content_tag_approval user_ids ("A
 *     comma-separated list"; all or nothing: false adds / removes none), a Facebook User token, instagram_branded_content_brand,
 *     Advanced Access; SDK iguser.py (user_ids list<unsigned int>).
 *   - …/partnership-ads/ad-codes.md: POST /{ig-media-id}/partnership_ad_code → {ad_code} ("for media you own"), DELETE → {success};
 *     instagram_basic, instagram_branded_content_creator, business_management; SDK igmedia.py (no parameters).
 *   - instagram-platform/instagram-api-with-facebook-login/collaboration.md: POST /<IG_USER_ID>/collaboration_invites media_id +
 *     accept true | false → {success}; feed image, Reels, carousel (no Stories); 50 calls per Instagram user per 24 h; a User
 *     access token; SDK iguser.py create_collaboration_invite (accept bool, media_id string).
 *   - …/partnership-ads/ads-creation/boost-existing-post.md "Uploading an Instagram video to Facebook": POST
 *     /act_<id>/advideos source_instagram_media_id + partnership_ad_ad_code + is_partnership_ad=true → {id}; SDK adaccount.py
 *     create_ad_video (partnership_ad_ad_code string, is_partnership_ad bool).
 * Meta's pages show a User token for the tag approvals and the Collab invites: Nexus sends the business's system-user token, and
 * Meta's own refusal answers in words (LIVE-PROBES CR-354, MD-132).
 */
import type { MetaWriteAsset, MetaWriteRule, MetaWriteVerdict } from './meta-calls.js'
import { META_AD_CODE } from './meta-creative-rules.js'

type Params = ReadonlyMap<string, string>

/**
 * Review round 2 — a Meta id never starts with 0: `0<id>` would pass a "not the chosen one / not another business's" string
 * compare while Meta reads it as the same id. Every id of this step is `[1-9]` then digits.
 */
export const META_ID = /^[1-9]\d{0,24}$/
const isDigits = (value: string | undefined) => !!value && META_ID.test(value)
/** How many creators one tag-approval change names (Meta reads 100 per check; Nexus keeps a change small). */
export const META_TAG_APPROVAL_MAX = 25

/** `user_ids` in Nexus's one spelling: Meta's comma-separated list of 1 to 25 creator ids, each once, no space. */
export function metaUserIdsProblem(value: string): string | null {
  const ids = value.split(',')
  if (!ids.length || ids.length > META_TAG_APPROVAL_MAX || ids.some((id) => !isDigits(id))) return `user_ids is a comma-separated list of 1 to ${META_TAG_APPROVAL_MAX} Instagram account ids (digits, no spaces)`
  return new Set(ids).size === ids.length ? null : 'user_ids names each Instagram account once'
}
const creators = (params: Params): MetaWriteAsset[] => (params.get('user_ids') ?? '').split(',').filter(isDigits).map((id) => ({ id, kind: 'partnerinstagram' as const }))

const ACCOUNT = ['adaccount'] as const
const PAGE = ['page'] as const
const IG_USER = ['iguser'] as const
const IG_MEDIA = ['igmedia'] as const

/** Step 26 — create-meta-boost's and set-meta-partnership-access's entries of the write allow-list (meta-calls.ts writeRules). */
export const META_BOOST_WRITE_RULES: readonly MetaWriteRule[] = [
  {
    // MD-138: a creator's Instagram video into the chosen account's video library with the creator's ad code — the documented
    // fix for "Instagram Video Must Be Uploaded To Facebook". The code must unlock exactly this media (`adcode` with it).
    name: 'adaccount.video.partner', method: 'POST', path: /^act_\d{1,20}\/advideos$/, kinds: ACCOUNT,
    required: ['source_instagram_media_id', 'partnership_ad_ad_code', 'is_partnership_ad'], optional: [], edgeCall: true, budget: false,
    secret: (params) => [params.get('partnership_ad_ad_code') ?? ''],
    values: (params) => {
      if (!isDigits(params.get('source_instagram_media_id'))) return 'source_instagram_media_id is a Meta id (digits only)'
      if (!META_AD_CODE.test(params.get('partnership_ad_ad_code') ?? '')) return 'partnership_ad_ad_code is a partnership ad code as the creator shared it (letters, digits and _ = + / -; Nexus never repeats it)'
      return params.get('is_partnership_ad') === 'true' ? null : 'is_partnership_ad is true'
    },
    assets: (params) => [{ id: params.get('partnership_ad_ad_code')!, kind: 'adcode', with: params.get('source_instagram_media_id')! }],
  },
  {
    // CR-344 / CR-346: ask a creator for account-level partnership permission, or revoke it — by the creator's Instagram id
    // only (Nexus resolves a username first, so the gateway can check the account is no other Nexus business's).
    name: 'iguser.partnership.permission', method: 'POST', path: /^[1-9]\d{0,24}\/branded_content_ad_permissions$/, kinds: IG_USER,
    required: ['creator_instagram_account'], optional: ['revoke'], edgeCall: true, budget: false,
    values: (params) => {
      if (!isDigits(params.get('creator_instagram_account'))) return 'creator_instagram_account is an Instagram account id (digits only)'
      return !params.has('revoke') || params.get('revoke') === 'true' ? null : 'revoke is true (a request is sent without it)'
    },
    assets: (params) => [{ id: params.get('creator_instagram_account')!, kind: 'partnerinstagram' }],
  },
  {
    // CR-354: creators added to the chosen Instagram account's approved-tagging list (all or nothing).
    name: 'iguser.tagApproval.add', method: 'POST', path: /^[1-9]\d{0,24}\/branded_content_tag_approval$/, kinds: IG_USER,
    required: ['user_ids'], optional: [], edgeCall: true, budget: false,
    values: (params) => metaUserIdsProblem(params.get('user_ids') ?? ''),
    assets: creators,
  },
  {
    // CR-355: creators taken off that list (all or nothing) — also the undo of CR-354.
    name: 'iguser.tagApproval.remove', method: 'DELETE', path: /^[1-9]\d{0,24}\/branded_content_tag_approval$/, kinds: IG_USER,
    required: ['user_ids'], optional: [], edgeCall: true, budget: false,
    values: (params) => metaUserIdsProblem(params.get('user_ids') ?? ''),
    assets: creators,
  },
  {
    // CR-364: the ad code taken off a media of the chosen Instagram account (Nexus makes none: CR-363 is answered in words).
    name: 'igmedia.adCode.remove', method: 'DELETE', path: /^[1-9]\d{0,24}\/partnership_ad_code$/, kinds: IG_MEDIA,
    required: [], optional: [], edgeCall: true, budget: false,
    values: () => null,
  },
  {
    // MD-132: accept or decline a Collab invite the chosen Instagram account has pending.
    name: 'iguser.collab.respond', method: 'POST', path: /^[1-9]\d{0,24}\/collaboration_invites$/, kinds: IG_USER,
    required: ['media_id', 'accept'], optional: [], edgeCall: true, budget: false,
    values: (params) => {
      if (!isDigits(params.get('media_id'))) return 'media_id is an Instagram media id (digits only)'
      return ['true', 'false'].includes(params.get('accept') ?? '') ? null : 'accept is true or false'
    },
    assets: (params) => [{ id: params.get('media_id')!, kind: 'collabinvite' }],
  },
]

// ── Meta's partnership REST host: the Facebook side (review B1, round 1) ───────────────────────────────────────────────

/** Meta's partnership REST host (meta-calls.ts META_REST_HOST; a test holds them equal). */
export const META_PARTNERSHIP_REST_HOST = 'api.facebook.com'
/** The account-level permission actions Nexus sends (fb-account-level-permissioning.md; revoke-permission as Meta's examples). */
export const META_FB_PERMISSION_ACTIONS = ['send-request', 'cancel-request', 'accept-request', 'reject-request', 'revoke-permission'] as const
/** Partner Pages one permission change names (Meta takes an array; Nexus keeps a change small). */
export const META_FB_PARTNERS_MAX = 10
/** Creator Pages or posts one allowlist / untag change names. */
export const META_FB_LIST_MAX = 25

const ID = '[1-9]\\d{0,24}'
const ids = (list: string) => list.slice(1, -1).split(',')
const listOf = (value: string | null, max: number): string[] | null => {
  if (value === null || !new RegExp(`^\\[${ID}(,${ID})*\\]$`).test(value)) return null
  const out = ids(value)
  return out.length <= max && new Set(out).size === out.length ? out : null
}
const PERMISSION_ITEM = new RegExp(`^\\{"partner_page_id":(${ID}),"action":"(${META_FB_PERMISSION_ACTIONS.join('|')})"\\}$`)

/** The permission body in Nexus's one spelling: `[{"partner_page_id":N,"action":"A"}, …]`, 1 to 10 partners, each once. */
export function metaPermissionBodyOf(items: Array<{ pageId: string; action: string }>): string {
  return `[${items.map((i) => `{"partner_page_id":${i.pageId},"action":"${i.action}"}`).join(',')}]`
}
function permissionItems(body: string): Array<{ pageId: string; action: string }> | null {
  if (!body.startsWith('[{') || !body.endsWith('}]')) return null
  const parts = body.slice(1, -1).split('},{').map((p, i, all) => `${i === 0 ? '' : '{'}${p}${i === all.length - 1 ? '' : '}'}`)
  const items: Array<{ pageId: string; action: string }> = []
  for (const part of parts) {
    const m = PERMISSION_ITEM.exec(part)
    if (!m) return null
    items.push({ pageId: m[1], action: m[2] })
  }
  if (!items.length || items.length > META_FB_PARTNERS_MAX || new Set(items.map((i) => i.pageId)).size !== items.length) return null
  return metaPermissionBodyOf(items) === body ? items : null
}

type RestInput = { method: string; url: string; kind: string; body?: unknown; objectKind?: string }

/**
 * Review B1 — the verdict on a change of Meta's partnership REST host (null: not that host). Exact routes and methods, the
 * chosen Page in the path (the gateway confirms it: kind `page`), the query and the JSON body judged as allow-lists in ONE
 * spelling, each Page / post id handed to the gateway's check. Only a write; nothing else on that host is sent.
 */
export function metaRestWriteVerdict(input: RestInput): MetaWriteVerdict | null {
  let url: URL
  try { url = new URL(input.url) } catch { return null }
  if (url.hostname !== META_PARTNERSHIP_REST_HOST) return null
  const refuse = (problem: string): MetaWriteVerdict => ({ problem })
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return refuse(`Nexus calls Meta's partnership host only as https://${META_PARTNERSHIP_REST_HOST}`)
  const raw = input.url.replace(/^https:\/\/[^/?#]*/i, '').split(/[?#]/)[0] || '/'
  if (raw.includes('%') || input.url.includes('\\') || raw !== url.pathname) return refuse('a Meta path is written plainly: no %-encoding, no backslash')
  const pieces = raw.split('/').slice(1)
  if (pieces.some((p) => !/^[a-z0-9-]+$/.test(p))) return refuse(`a path on ${META_PARTNERSHIP_REST_HOST} is lower-case letters, digits and - only`)
  if (input.kind !== 'write') return refuse('a Meta change goes as a write; this one is declared otherwise')
  if (input.objectKind !== 'page') return refuse('a change on Meta\'s partnership host names the chosen Page as its object (kind page)')
  const method = input.method.toUpperCase()
  const route = pieces.join('/')
  const keys = [...url.searchParams.keys()]
  if (new Set(keys).size !== keys.length) return refuse('the query names a key more than once')
  const body = typeof input.body === 'string' ? input.body : input.body == null ? '' : null
  if (body === null) return refuse('a change on Meta\'s partnership host carries its JSON body as text')
  const onlyQuery = (key: string | null) => (key === null ? keys.length === 0 : keys.length === 1 && keys[0] === key)
  const write = (rule: string, pageId: string, assets: MetaWriteAsset[], sent: string): MetaWriteVerdict => ({
    write: { rule, objectId: pageId, check: false, body: sent, budget: false, kinds: PAGE, edgeCall: true, host: 'rest', ...(method === 'DELETE' ? { method: 'DELETE' as const } : method === 'PUT' ? { method: 'PUT' as const } : {}), ...(assets.length ? { assets } : {}) },
  })
  let m = /^partnership-ads\/fb-account-level-permissions\/([1-9]\d{0,24})$/.exec(route)
  if (m && method === 'POST') {
    if (!onlyQuery(null)) return refuse('an account-level permission change carries no query')
    const items = permissionItems(body)
    if (!items) return refuse(`the permission change is [{"partner_page_id":<Page id>,"action":"${META_FB_PERMISSION_ACTIONS.join('|')}"}, …] in Nexus's one spelling: 1 to ${META_FB_PARTNERS_MAX} partner Pages, each once`)
    return write('page.fbPermissions', m[1], items.map((i) => ({ id: i.pageId, kind: 'partnerpage' as const })), body)
  }
  m = /^partnership-ads\/fb-branded-content\/([1-9]\d{0,24})\/brand-allowlist-status$/.exec(route)
  if (m && method === 'PUT') {
    if (body) return refuse('the allowlist switch carries no body')
    if (!onlyQuery('is_enabled') || !['true', 'false'].includes(url.searchParams.get('is_enabled') ?? '')) return refuse('the allowlist switch is ?is_enabled=true or false, nothing else')
    return write('page.fbAllowlistStatus', m[1], [], '')
  }
  m = /^partnership-ads\/fb-branded-content\/([1-9]\d{0,24})\/brand-allowlisted-creators$/.exec(route)
  if (m && method === 'POST') {
    if (!onlyQuery(null)) return refuse('adding creators to the allowlist carries no query (the Page ids go in the JSON body)')
    const list = /^\{"creator_page_ids":(\[[^\]]*\])\}$/.exec(body)
    const pages = list ? listOf(list[1], META_FB_LIST_MAX) : null
    if (!pages) return refuse(`adding creators is {"creator_page_ids":[<Page id>, …]}: 1 to ${META_FB_LIST_MAX} Pages, each once, no space`)
    return write('page.fbAllowCreators', m[1], pages.map((id) => ({ id, kind: 'partnerpage' as const })), body)
  }
  if (m && method === 'DELETE') {
    if (body) return refuse('removing creators from the allowlist carries no body')
    const pages = onlyQuery('creator_page_ids') ? listOf(url.searchParams.get('creator_page_ids'), META_FB_LIST_MAX) : null
    if (!pages) return refuse(`removing creators is ?creator_page_ids=[<Page id>, …]: 1 to ${META_FB_LIST_MAX} Pages, each once`)
    return write('page.fbDisallowCreators', m[1], pages.map((id) => ({ id, kind: 'partnerpage' as const })), '')
  }
  m = /^partnership-ads\/fb-branded-content\/([1-9]\d{0,24})\/branded-content-posts$/.exec(route)
  if (m && method === 'DELETE') {
    if (body) return refuse('removing the sponsor tag carries no body')
    const posts = onlyQuery('post_ids') ? listOf(url.searchParams.get('post_ids'), META_FB_LIST_MAX) : null
    if (!posts) return refuse(`removing the sponsor tag is ?post_ids=[<post id>, …]: 1 to ${META_FB_LIST_MAX} posts, each once`)
    return write('page.fbUntagPosts', m[1], posts.map((id) => ({ id, kind: 'brandedpost' as const })), '')
  }
  return refuse(`on ${META_PARTNERSHIP_REST_HOST} Nexus changes only the chosen Page's account-level partnership permissions, its branded-content allowlist and the sponsor tag of posts that tag it (this one is ${method} /${route})`)
}

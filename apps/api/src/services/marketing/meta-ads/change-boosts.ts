/**
 * Meta step 26 (2026-10-21) — create-meta-boost and set-meta-partnership-access as drafts (master rows of step 26: CR-226,
 * CR-236, CR-237, CR-244, CR-300 … CR-305, CR-322 … CR-325, CR-327, CR-344 … CR-364, MD-132, OT-014 … OT-031, and MD-138 /
 * CR-331 handed over by step 25; facts F1 M5-25 … M5-29). Each draft is built from the request and what Meta holds NOW
 * (reads only, through the gateway, with step 10's and step 16's own reads); the requests go through the write client and
 * the gateway (step 25's ONE creative judge for a boost — meta-creative-rules.ts sourceAssets — and meta-boost-rules.ts).
 *
 *   create-meta-boost   ONE creative of an EXISTING post, made by step 25's builder (buildCreative with `base`): every silent
 *                       key exactly as for a post of the chosen Page (silentKeysToSend: every Advantage+ feature OFF unless
 *                       asked, multi-advertiser ads OFF, no music unless asked, the shop and format opt-outs), Meta's check
 *                       (validate_only) first, read back and "was it new?" (Meta answers the EXISTING creative for a reused
 *                       post, so a boost is new only when its id was not among the account's creatives just before the send).
 *                       Sources: a post of the chosen Page (object_story_id, also on Instagram as the chosen account, and so
 *                       on Threads), a feed post / reel / carousel / active story of the chosen Instagram account
 *                       (source_instagram_media_id under object_id = the chosen Page) or its public link
 *                       (instagram_permalink_url, only when it IS one of the account's own media), a creator's Instagram
 *                       media or Facebook post that Meta's content discovery lists for the brand, or a creator's ad code
 *                       (partnership: the chosen Page and Instagram account are the SPONSORS; branded_content.ad_format). The
 *                       eligibility is read first (a post's is_eligible_for_promotion and is_instagram_eligible, a media's
 *                       boost_eligibility_info, a creator's content's ad_eligibility and eligibility errors): copyrighted
 *                       music, filters and IGTV cannot be boosted, and Nexus says so before any write.
 *                       copy-creator-video (MD-138): a creator's Instagram video into the chosen account's video library with
 *                       the creator's ad code (step 23's video sender; its undo is create-meta-media's).
 *                       undo: step 25's creative undo (creativeUndoDraft) for creatives THIS tool made new.
 *   set-meta-partnership-access  the chosen Instagram account's partnership side (ask a creator for account-level permission
 *                       or revoke it, add / remove creators on the approved-tagging list, delete an ad code of its own media,
 *                       accept / decline a Collab invite; making an ad code is answered in words — review A2) and the chosen
 *                       Page's (review B1: account-level permissions with partner Pages, the branded-content allowlist and
 *                       its creators, the sponsor tag of posts that tag it — Meta's partnership host api.facebook.com, with
 *                       the system-user token as Bearer; Meta answers each item of a list on its own).
 *
 * A creator's ad code is credential-like. Review A1 (round 1) — it IS kept with the request until it runs (the approval's
 * arguments, a plan step's): people who can read this business's requests can read it; Nexus says so. It is never in a
 * preview, a change record, the plan / basis hashes (review A3: the content it unlocks pins them), the call ledger or a Meta
 * answer Nexus passes on (the gateway cuts it out). create-meta-boost is Claude's door only (surfaces mcp: the in-app assistant
 * keeps its steps' arguments). A code for the business's own media (CR-363) is answered in words (review A2): Meta answers it
 * once and no Nexus path shows a run's answer afterwards. Nothing here spends money: a boost is a creative, and a creative
 * serves only once an ad uses it (create-meta-ad, step 27).
 */
import {
  BOOST_TOOL, buildCreative, creativeUndoDraft, creativeWarnings, createdSentence, MAX_CREATIVE_UNDO, sendCreate,
  type CreativeDraft, type CreativeRequest,
} from './change-creatives.js'
import { sendAdVideo } from './change-media.js'
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { MetaChangeAccount } from './change-account.js'
import { metaSendRest, MetaWriteError, META_UNKNOWN_OUTCOME, type MetaChangeResult, type MetaWriteTarget } from './write-client.js'
import { localFailure, MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { instagramOf, onPage, ownMedia, pageOf, pagePostId } from './live-media.js'
import { livePartnership } from './live-partners.js'
import { listPaged } from './live-objects.js'
import { metaReadOne } from './read-client.js'
import { takenIds } from './taken.js'
import { META_AD_CODE, META_CTA_TYPES, META_IG_PERMALINK } from '../../gateway/meta-creative-rules.js'
import { META_FB_LIST_MAX, META_FB_PARTNERS_MAX, META_FB_PERMISSION_ACTIONS, META_TAG_APPROVAL_MAX, metaPermissionBodyOf } from '../../gateway/meta-boost-rules.js'

export { BOOST_TOOL }
export const PARTNERSHIP_TOOL = 'set-meta-partnership-access'

type Row = Record<string, unknown>
const isObject = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && /^\d{1,25}$/.test(String(v)) ? String(v) : null)
/**
 * Review A1 (round 1) — what is true of a creator's ad code in Nexus, said in every preview that carries one and in the tool's
 * description.
 */
export const AD_CODE_KEPT = 'The creator\'s ad code is kept with this request until it runs (its approval, or its change-plan step): people who can read this business\'s requests can read it. It is not shown in this preview, not in the change record, not in the call ledger, and the gateway cuts it out of Meta\'s answers.'

// ── create-meta-boost: the request ──────────────────────────────────────────────────────────────────────────────────

export const BOOST_SOURCES = [
  'facebook-post', 'instagram-media', 'instagram-link',
  'creator-instagram-media', 'creator-facebook-post', 'creator-instagram-code', 'creator-facebook-code',
] as const
export type BoostSource = typeof BOOST_SOURCES[number]
/** Meta's link buttons a boost takes (each one of Meta's CTA types; messaging and profile visits are their own kinds). */
export const BOOST_LINK_CTAS = ['LEARN_MORE', 'SHOP_NOW', 'BUY_NOW', 'ORDER_NOW', 'SIGN_UP', 'SUBSCRIBE', 'CONTACT_US', 'GET_OFFER', 'SEE_MORE', 'BOOK_NOW', 'APPLY_NOW', 'GET_QUOTE', 'WATCH_MORE', 'VIEW_PRODUCT', 'ADD_TO_CART'] as const
export const MESSAGING_APPS = ['MESSENGER', 'INSTAGRAM_DIRECT'] as const
export const VISIT_DESTINATIONS = ['facebook', 'instagram', 'both'] as const
/** branded_content.ad_format (boost-existing-post guides): 1 both identities (Meta's default), 2 the first only, 3 Meta picks (Instagram only). */
export const AD_FORMAT_OF = { both: 1, first: 2, auto: 3 } as const
export type BoostIdentities = keyof typeof AD_FORMAT_OF

export interface BoostButton { kind: 'link' | 'messaging' | 'profile'; type?: string | null; link?: string | null; apps?: string[] | null; visit?: string | null }
export interface BoostRequest {
  action: 'create' | 'undo' | 'copy-creator-video'
  name?: string | null
  source?: BoostSource | null
  postId?: string | null
  mediaId?: string | null
  permalink?: string | null
  /** A creator's partnership ad code (credential-like: kept with the request until it runs; never in a preview, a change record or the ledger). */
  adCode?: string | null
  withInstagram?: boolean | null
  threads?: boolean | null
  button?: BoostButton | null
  identities?: BoostIdentities | null
  urlTags?: string | null
  aiFeatures?: string[]
  featureSettings?: Record<string, Record<string, unknown>>
  multiAdvertiser?: boolean | null
  music?: 'off' | 'random' | null
  /** undo: the creatives an earlier create-meta-boost made new. */
  creatives?: string[]
}

/** Meta's Messenger and Instagram Direct destinations as its multi-destination example writes them (use-posts-as-ads.md). */
const MESSENGER_LINK = 'https://fb.com/messenger_doc/'
/** Review B6 — every profile-visit guide opens with this warning (ig-profile-visit.md, fb-page-visit.md, multidestination-…). */
const PROFILE_VISIT_LIMITED = 'Meta says profile-visit ad creation on its Marketing API is in limited availability, rolled out to advertisers step by step: if this account does not have it yet, Meta\'s check refuses it (then a person makes it in Ads Manager or asks Meta).'
const INSTAGRAM_LINK = 'https://www.instagram.com/'
/** How many of the account's creatives the run reads just before the send ("was it new?"; more = not proven new). */
export const CREATIVES_BEFORE_MAX = 500

/** What a boost's source is in words, for a label. */
const SOURCE_WORDS: Readonly<Record<BoostSource, string>> = {
  'facebook-post': 'the chosen Page\'s post', 'instagram-media': 'the chosen Instagram account\'s media', 'instagram-link': 'the chosen Instagram account\'s post (by its link)',
  'creator-instagram-media': 'a creator\'s Instagram media', 'creator-facebook-post': 'a creator\'s Facebook post',
  'creator-instagram-code': 'a creator\'s Instagram content (ad code)', 'creator-facebook-code': 'a creator\'s Facebook content (ad code)',
}

/** The source, resolved from what Meta holds now: the creative's base keys, what it is, and what a person reads. */
interface ResolvedSource {
  base: Record<string, unknown>
  creator: boolean
  /** The chosen Instagram account runs it too (Instagram, and Threads through it). */
  instagram: boolean
  label: string
  /** The media it shows, as Meta reads it (for Threads' rules). */
  media: { type: string | null; productType: string | null; videoChildren: boolean } | null
  warnings: string[]
  stands: Record<string, unknown>
}

/** A field list Meta refused (code 100): read again with the core fields only, and say so. */
async function readWithFallback(connectionId: string, operation: string, path: string, fields: string, core: string): Promise<{ body: Row; note: string | null }> {
  try {
    return { body: (await onPage(() => metaReadOne<Row>({ connectionId }, { operation, path, query: { fields } }))).body, note: null }
  } catch (err) {
    if (!(err instanceof MetaReadError) || err.failure.origin !== 'meta' || err.failure.authLost || err.failure.throttled || !/^100(\/|$)/.test(err.failure.code ?? '')) throw err
    return { body: (await onPage(() => metaReadOne<Row>({ connectionId }, { operation, path, query: { fields: core } }))).body, note: `Meta did not answer ${fields.split(',').filter((f) => !core.split(',').includes(f)).join(', ')} (${err.failure.sentence}); its check (validate_only) answers whether it can be boosted.` }
  }
}

/** A Facebook post of the chosen Page: its promotion eligibility (CR-300, CR-301; use-posts-as-ads.md is_instagram_eligible). */
async function ownPost(chosen: MetaChosenAccount, request: BoostRequest): Promise<ResolvedSource> {
  const pageId = pageOf(chosen)
  if (!request.postId) throw new MetaLiveRefusal('Name the post (postId: <Page id>_<post id>, as meta-page-posts lists them).')
  let postId = pagePostId(pageId, request.postId)
  const read = await readWithFallback(chosen.connectionId, 'boost.postCheck', postId, 'id,is_eligible_for_promotion,promotable_id,is_instagram_eligible', 'id')
  const warnings: string[] = read.note ? [read.note] : []
  if (read.body.is_eligible_for_promotion === false) throw new MetaLiveRefusal(`Meta says post ${postId} cannot be promoted (is_eligible_for_promotion false): nothing was asked of Meta.`)
  // CR-300: a story that cannot be promoted itself names the post that can (promotable_id) — still the chosen Page's.
  const promotable = text(read.body.promotable_id)
  if (promotable && promotable !== postId && /^\d{1,25}_\d{1,25}$/.test(promotable)) {
    const id = pagePostId(pageId, promotable)
    warnings.push(`Meta promotes post ${postId} as ${id} (its promotable_id): Nexus boosts that one.`)
    postId = id
  }
  let instagram = request.withInstagram !== false && !!chosen.instagramId
  if (instagram && read.body.is_instagram_eligible === false) {
    if (request.withInstagram === true) throw new MetaLiveRefusal(`Meta says post ${postId} cannot run on Instagram (is_instagram_eligible false): ask again with withInstagram false (Facebook only).`)
    instagram = false
    warnings.push(`Meta says post ${postId} cannot run on Instagram (is_instagram_eligible false): it is boosted on Facebook only.`)
  }
  warnings.push('Meta copies the post\'s image (at most 8 MB) into the ad account\'s image library, and drops Page mentions in an ad\'s text without a word.')
  return {
    base: { object_story_id: postId, ...(instagram ? { instagram_user_id: chosen.instagramId } : {}) },
    creator: false, instagram, label: `post ${postId} of the chosen Page${instagram ? ' (also on Instagram as the chosen account)' : ''}`, media: null, warnings,
    stands: { postId, eligible: read.body.is_eligible_for_promotion ?? null, instagramEligible: read.body.is_instagram_eligible ?? null, instagram },
  }
}

/** A media of the chosen Instagram account: its boost eligibility (CR-244, CR-302, CR-303; boost_eligibility_info). */
async function ownInstagramMedia(chosen: MetaChosenAccount, mediaId: string, via: 'id' | 'link', permalink: string | null = null): Promise<ResolvedSource> {
  const pageId = pageOf(chosen)
  const instagramId = instagramOf(chosen)
  const own = await ownMedia(chosen, mediaId)
  const read = await readWithFallback(chosen.connectionId, 'boost.mediaCheck', own.mediaId, 'id,media_type,media_product_type,boost_eligibility_info,children{media_type}', 'id,media_type,media_product_type')
  const info = isObject(read.body.boost_eligibility_info) ? read.body.boost_eligibility_info : null
  const productType = text(read.body.media_product_type) ?? own.productType
  const type = text(read.body.media_type)
  // use-posts-as-ads.md: "Currently, you cannot create ads from Instagram TV posts".
  if (productType === 'IGTV') throw new MetaLiveRefusal(`Instagram media ${own.mediaId} is an IGTV post: Meta cannot boost IGTV posts (use-posts-as-ads guide). Nothing was asked of Meta.`)
  if (info?.eligible_to_boost === false) {
    throw new MetaLiveRefusal(`Meta says Instagram media ${own.mediaId} cannot be boosted${text(info.boost_ineligible_reason) ? ` (${text(info.boost_ineligible_reason)})` : ''}: media with copyrighted music or interactive elements such as filters cannot be boosted, and a story only while it is active. Nothing was asked of Meta.`)
  }
  const children = isObject(read.body.children) && Array.isArray(read.body.children.data) ? (read.body.children.data as Row[]) : []
  const warnings = [
    ...(read.note ? [read.note] : []),
    ...(info === null ? ['Meta did not say whether this media can be boosted (boost_eligibility_info): its check (validate_only) answers before anything is made.'] : []),
    ...(productType === 'STORY' ? ['A story can be boosted only while it is active (24 hours) and runs in Stories placements; Meta takes no public link for a story ad.'] : []),
    ...(productType === 'REELS' ? ['A Reel runs as an ad only when it is under 90 seconds, full-screen 9:16, with no copyrighted music, GIFs, interactive stickers or third-party filters, and not shared to Facebook (Meta\'s Reels-ads guide).'] : []),
    'Once boosted, the post can no longer be edited on Instagram (Meta\'s ad-codes guide), but it can be boosted again.',
  ]
  const base = via === 'link'
    ? { object_id: pageId, instagram_user_id: instagramId, instagram_permalink_url: permalink }
    : { object_id: pageId, instagram_user_id: instagramId, source_instagram_media_id: own.mediaId }
  return {
    base, creator: false, instagram: true,
    label: `${productType === 'STORY' ? 'story' : productType === 'REELS' ? 'Reel' : type === 'CAROUSEL_ALBUM' ? 'carousel' : 'post'} ${own.mediaId} of the chosen Instagram account${via === 'link' ? ' (by its link)' : ''}`,
    media: { type, productType, videoChildren: children.some((c) => c.media_type === 'VIDEO') }, warnings,
    stands: { mediaId: own.mediaId, productType, eligible: info ? info.eligible_to_boost ?? null : null, ...(permalink ? { permalink } : {}) },
  }
}

/**
 * CR-304 — the chosen Instagram account's post by its public link: Meta's media `permalink` among the account's latest
 * META_PERMALINK_READ media (read live). instagram_permalink_url is listed on the creative edge with no guide (STILL-
 * UNVERIFIED): Nexus sends it only for the account's OWN media, and Meta's check answers (LIVE-PROBES CR-304).
 */
export const META_PERMALINK_READ = 500
async function ownInstagramLink(chosen: MetaChosenAccount, link: string): Promise<ResolvedSource> {
  const instagramId = instagramOf(chosen)
  let url: URL
  try { url = new URL(link.trim()) } catch { throw new MetaLiveRefusal('permalink is a link to an Instagram post (https://www.instagram.com/p/<code>/).') }
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  const permalink = `https://www.instagram.com${path}`
  if (!/^(www\.)?instagram\.com$/.test(url.hostname) || !META_IG_PERMALINK.test(permalink)) throw new MetaLiveRefusal('permalink is a link to an Instagram post (https://www.instagram.com/p/<code>/ or /reel/<code>/).')
  const list = await listPaged(chosen.connectionId, 'boost.permalinkFind', `${instagramId}/media`, { fields: 'id,permalink' }, META_PERMALINK_READ)
  const found = list.rows.find((r) => text(r.permalink) === permalink)
  if (!found || !idText(found.id)) {
    throw new MetaLiveRefusal(`That link is not one of the chosen Instagram account's own posts${list.more ? ` Nexus can find (it reads the latest ${META_PERMALINK_READ})` : ''}: Nexus boosts by link only the business's own media. A creator's post is boosted by its media id or ad code (source creator-…).`)
  }
  return ownInstagramMedia(chosen, idText(found.id)!, 'link', permalink)
}

/** One creator content row as Meta's content discovery answers it (step 16's look-up, masked when another business's). */
interface CreatorRow { contentId: string | null; platform: string | null; mediaType: string | null; author: { pageId: string | null; instagramId: string | null } | null; eligibility: Array<{ adEligibility: string | null; permissionStatus: string | null; errors: string[]; partner: { pageId: string | null; instagramId: string | null } | null }> }

/**
 * A creator's content Meta's content discovery lists for the brand (step 16's look-up: content_ids or ad_codes, the chosen
 * Page and Instagram account): never the business's own, never another Nexus business's, of the platform asked; its
 * eligibility (ad_eligibility, eligibility_errors) said or refused before any write. The ad code goes to Meta in the
 * look-up's query only (the ledger keeps a path) and is never put in a sentence.
 */
async function creatorContent(chosen: MetaChosenAccount, by: { contentId: string } | { adCode: string }, platform: 'INSTAGRAM' | 'FACEBOOK'): Promise<{ row: CreatorRow; warnings: string[] }> {
  const what = 'adCode' in by ? 'the creator\'s ad code' : `content ${by.contentId}`
  const answer = await livePartnership({ connectionId: chosen.connectionId, view: 'lookup', ...('adCode' in by ? { adCodes: [by.adCode] } : { contentIds: [by.contentId] }) }) as unknown as { items?: Array<Row> }
  const items = Array.isArray(answer.items) ? answer.items : []
  const match = 'adCode' in by
    ? (items.length === 1 ? items[0] : null)
    : items.find((r) => r.contentId === by.contentId || (by.contentId.includes('_') && r.contentId === by.contentId.split('_')[1])) ?? null
  if (!match) throw new MetaLiveRefusal(`Meta's content discovery does not list ${what} as content the chosen Page or Instagram account may advertise${'adCode' in by && items.length > 1 ? ' (it answered more than one)' : ''}: nothing was asked of Meta. meta-partnership-content view search shows what it lists.`)
  if (match.takenByAnotherBusiness === true) throw new MetaLiveRefusal(`${what === 'the creator\'s ad code' ? 'That content' : what} is by a Page or Instagram account another business in Nexus uses: no creative of this business boosts it.`)
  const author = isObject(match.author) ? { pageId: idText(match.author.pageId), instagramId: idText(match.author.instagramId) } : null
  const row: CreatorRow = {
    contentId: text(match.contentId), platform: text(match.platform), mediaType: text(match.mediaType), author,
    eligibility: (Array.isArray(match.partnerships) ? match.partnerships : []).filter(isObject).map((p) => ({
      adEligibility: text(p.adEligibility), permissionStatus: text(p.permissionStatus),
      errors: (Array.isArray(p.eligibilityErrors) ? p.eligibilityErrors : []).filter(isObject).map((e) => text(e.message) ?? text(e.code) ?? '').filter(Boolean),
      partner: isObject(p.taggedPartner) ? { pageId: idText(p.taggedPartner.pageId), instagramId: idText(p.taggedPartner.instagramId) } : null,
    })),
  }
  if (row.platform && row.platform !== platform) throw new MetaLiveRefusal(`${what === 'the creator\'s ad code' ? 'That ad code' : what} is ${row.platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} content: ask with the ${row.platform === 'INSTAGRAM' ? 'creator-instagram' : 'creator-facebook'} source.`)
  const pages = [author?.pageId, 'contentId' in by && by.contentId.includes('_') ? by.contentId.split('_')[0] : null].filter((v): v is string => !!v)
  const igs = [author?.instagramId].filter((v): v is string => !!v)
  if (!pages.length && !igs.length) throw new MetaLiveRefusal(`Meta's content discovery names no author for ${what}, so Nexus cannot confirm whose it is: nothing was asked of Meta.`)
  if ((chosen.pageId && pages.includes(chosen.pageId)) || (chosen.instagramId && igs.includes(chosen.instagramId))) {
    throw new MetaLiveRefusal(`${what === 'the creator\'s ad code' ? 'That content' : what} is the business's own: boost it with source facebook-post or instagram-media (a partnership boost is a creator's content).`)
  }
  const [takenPages, takenIgs] = await Promise.all([takenIds('PAGE', pages), takenIds('INSTAGRAM', igs)])
  if (takenPages.size || takenIgs.size) throw new MetaLiveRefusal('That content is by a Page or Instagram account another business in Nexus uses: no creative of this business boosts it.')
  // The eligibility Meta gives for the brand (its entry, else the first).
  const mine = row.eligibility.find((e) => (chosen.pageId && e.partner?.pageId === chosen.pageId) || (chosen.instagramId && e.partner?.instagramId === chosen.instagramId)) ?? row.eligibility[0] ?? null
  const warnings: string[] = []
  if (!mine?.adEligibility) warnings.push('Meta\'s content discovery gave no ad eligibility for it: Meta\'s check (validate_only) answers before anything is made.')
  else if (mine.adEligibility === 'INELIGIBLE' || mine.adEligibility === 'EXCLUDED') {
    throw new MetaLiveRefusal(`Meta says it cannot be used in an ad (${mine.adEligibility}${mine.errors.length ? `: ${mine.errors.slice(0, 3).join('; ')}` : ''}) — copyrighted music, an unsupported format or a missing permission. Nothing was asked of Meta.`)
  } else if (mine.adEligibility === 'NEEDS_ATTENTION') warnings.push(`Meta says it needs attention before it can run${mine.errors.length ? `: ${mine.errors.slice(0, 3).join('; ')}` : ''}.`)
  if (mine?.permissionStatus && !/APPROVED|GRANTED|ACTIVE/i.test(mine.permissionStatus)) warnings.push(`The creator's permission reads ${mine.permissionStatus}: Meta keeps the ad "pending delivery" until the creator allows it (account-level permission: set-meta-partnership-access action request; or the creator's ad code).`)
  return { row, warnings }
}

/** The brand as a creator's content's sponsor (boost-existing-post guides: the advertiser's Page and Instagram account). */
const sponsorsOf = (chosen: MetaChosenAccount) => ({
  facebook_branded_content: { sponsor_page_id: pageOf(chosen) },
  ...(chosen.instagramId ? { instagram_branded_content: { sponsor_id: chosen.instagramId } } : {}),
})

async function creatorSource(chosen: MetaChosenAccount, request: BoostRequest, adFormat: number): Promise<ResolvedSource> {
  const source = request.source!
  const pageId = pageOf(chosen)
  const sponsors = sponsorsOf(chosen)
  const branded = (extra: Record<string, unknown> = {}) => ({ branded_content: { ...extra, ad_format: adFormat } })
  if (source === 'creator-instagram-code' || source === 'creator-facebook-code') {
    const code = request.adCode?.trim() ?? ''
    if (!META_AD_CODE.test(code)) throw new MetaLiveRefusal('adCode is the partnership ad code the creator shared (letters, digits and _ = + / -).')
    const platform = source === 'creator-instagram-code' ? 'INSTAGRAM' : 'FACEBOOK'
    const { row, warnings } = await creatorContent(chosen, { adCode: code }, platform)
    const token = platform === 'INSTAGRAM' ? 'instagram_boost_post_access_token' : 'facebook_boost_post_access_token'
    return {
      base: { ...(platform === 'INSTAGRAM' ? { object_id: pageId } : {}), ...sponsors, ...branded({ [token]: code }) },
      creator: true, instagram: platform === 'INSTAGRAM', label: `a creator's ${platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} content${row.contentId ? ` ${row.contentId}` : ''} (by the creator's ad code)`, media: null,
      warnings: [
        ...warnings,
        AD_CODE_KEPT,
        'The code also unlocks archived content and hidden Collab posts (Meta\'s guide).',
      ],
      // Review A3 — the content the code unlocks pins what the change stands on; the code is in no hash.
      stands: { contentId: row.contentId, author: row.author, platform },
    }
  }
  if (source === 'creator-instagram-media') {
    if (!request.mediaId || !/^\d{1,25}$/.test(request.mediaId)) throw new MetaLiveRefusal('Name the creator\'s Instagram media (mediaId: digits; meta-partnership-content view search lists them).')
    const { row, warnings } = await creatorContent(chosen, { contentId: request.mediaId }, 'INSTAGRAM')
    return {
      base: { object_id: pageId, source_instagram_media_id: request.mediaId, ...sponsors, ...branded() },
      creator: true, instagram: true, label: `a creator's Instagram media ${request.mediaId}`, media: null, warnings,
      stands: { contentId: row.contentId, author: row.author, platform: 'INSTAGRAM' },
    }
  }
  // creator-facebook-post: <creator Page id>_<post id> (boost-existing-fb-post.md object_story_id).
  if (!request.postId || !/^\d{1,25}_\d{1,25}$/.test(request.postId)) throw new MetaLiveRefusal('Name the creator\'s Facebook post (postId: <creator Page id>_<post id>; meta-partnership-content view search lists them).')
  const { row, warnings } = await creatorContent(chosen, { contentId: request.postId }, 'FACEBOOK')
  return {
    base: { object_story_id: request.postId, ...sponsors, ...branded() },
    creator: true, instagram: false, label: `a creator's Facebook post ${request.postId}`, media: null,
    warnings: [...warnings, ...(adFormat === 3 ? ['Meta optimises the identities (ad_format 3) on Instagram only.'] : [])],
    stands: { contentId: row.contentId, postId: request.postId, author: row.author, platform: 'FACEBOOK' },
  }
}

/** The chosen Instagram account's username, read live (its profile link and Meta's app link). */
async function instagramUsername(chosen: MetaChosenAccount): Promise<string> {
  const read = await onPage(() => metaReadOne<Row>({ connectionId: chosen.connectionId }, { operation: 'boost.igUsername', path: instagramOf(chosen), query: { fields: 'id,username' } }))
  const username = text(read.body.username)
  if (!username || !/^[A-Za-z0-9._]{1,30}$/.test(username)) throw new MetaLiveRefusal('Nexus could not read the chosen Instagram account\'s username for its profile link; nothing was asked of Meta.')
  return username
}

/**
 * The button: Meta's link buttons; messaging (MESSAGE_PAGE with one app, CR-305; several apps through
 * DOF_MESSAGING_DESTINATION; a creator's content with Messenger — branded_content.promoted_page_id, CR-327); a profile visit
 * (VISIT_PROFILE for the Page, VIEW_INSTAGRAM_PROFILE for the Instagram account, or both through
 * UNIFIED_PROFILE_VISIT_DESTINATION, CR-226). And Meta's trap: a Facebook post run as the chosen Instagram account with a
 * messaging button names DOF_MESSAGING_DESTINATION (use-posts-as-ads.md Troubleshooting) — only there.
 */
async function buttonOf(chosen: MetaChosenAccount, request: BoostRequest, source: ResolvedSource): Promise<{ parts: Record<string, unknown>; existingFeed: Record<string, unknown> | null; brandedExtra: Record<string, unknown>; words: string; warnings: string[] }> {
  const button = request.button
  if (!button) return { parts: {}, existingFeed: null, brandedExtra: {}, words: 'the post\'s own (none added)', warnings: [] }
  const pageId = pageOf(chosen)
  if (button.kind === 'link') {
    const type = button.type ?? 'LEARN_MORE'
    if (!(BOOST_LINK_CTAS as readonly string[]).includes(type)) throw new MetaLiveRefusal(`A link button is one of ${BOOST_LINK_CTAS.join(', ')}.`)
    if (!button.link) throw new MetaLiveRefusal('A link button names its link (button.link: a public https link).')
    return { parts: { call_to_action: { type, value: { link: button.link } } }, existingFeed: null, brandedExtra: {}, words: `${type} → ${button.link}`, warnings: [] }
  }
  if (button.kind === 'messaging') {
    const apps = [...new Set(button.apps?.length ? button.apps : ['MESSENGER'])]
    if (apps.some((a) => !(MESSAGING_APPS as readonly string[]).includes(a))) throw new MetaLiveRefusal(`A messaging button opens ${MESSAGING_APPS.join(' or ')}.`)
    if (source.creator) {
      if (apps.length !== 1 || apps[0] !== 'MESSENGER') throw new MetaLiveRefusal('A partnership ad with a messaging button opens Messenger (Meta\'s click-to-message partnership guide): button.apps ["MESSENGER"].')
      // Review B7 — the partnership click-to-message guide writes value {app_destination: "MESSENGER", link: "<LINK_URL>"}
      // and says no more about the link: the person names it (LIVE-PROBES CR-327).
      if (!button.link) throw new MetaLiveRefusal('A partnership ad\'s Messenger button names its link (button.link: Meta\'s click-to-message partnership guide writes a link beside app_destination MESSENGER without saying more — e.g. the business\'s website).')
      return {
        parts: { call_to_action: { type: 'LEARN_MORE', value: { app_destination: 'MESSENGER', link: button.link } } }, existingFeed: null,
        brandedExtra: { promoted_page_id: pageId }, words: 'Messenger with the chosen Page', warnings: ['Messages from the ad go to the chosen Page (branded_content.promoted_page_id). Meta\'s guide does not say what the button\'s link does beside Messenger (LIVE-PROBES CR-327).'],
      }
    }
    if (apps.includes('INSTAGRAM_DIRECT') && !source.instagram) throw new MetaLiveRefusal('Instagram Direct needs the ad to run as the chosen Instagram account (withInstagram, and a chosen Instagram account).')
    if (apps.length === 2) {
      return {
        parts: {}, words: 'Messenger or Instagram Direct (Meta picks per person)', brandedExtra: {}, warnings: ['Meta picks Messenger or Instagram Direct per person (DOF_MESSAGING_DESTINATION).'],
        existingFeed: { optimization_type: 'DOF_MESSAGING_DESTINATION', call_to_actions: [
          { type: 'MESSAGE_PAGE', value: { app_destination: 'MESSENGER', link: MESSENGER_LINK } },
          { type: 'INSTAGRAM_MESSAGE', value: { app_destination: 'INSTAGRAM_DIRECT', link: INSTAGRAM_LINK } },
        ] },
      }
    }
    const trap = request.source === 'facebook-post' && source.instagram
    return {
      parts: { call_to_action: { type: 'MESSAGE_PAGE', value: { app_destination: apps[0] } } },
      existingFeed: trap ? { optimization_type: 'DOF_MESSAGING_DESTINATION' } : null, brandedExtra: {},
      words: apps[0] === 'MESSENGER' ? 'Messenger' : 'Instagram Direct',
      warnings: trap ? ['A Facebook post run as the Instagram account with a messaging button names asset_feed_spec DOF_MESSAGING_DESTINATION (Meta\'s use-posts-as-ads troubleshooting: "Creative is missing DOF spec" otherwise).'] : [],
    }
  }
  // Profile visits (CR-226): not documented for a creator's content.
  if (source.creator) throw new MetaLiveRefusal('Meta documents profile-visit buttons for the business\'s own posts only, not for a creator\'s content.')
  const profile = button.visit ?? (request.source === 'facebook-post' ? 'facebook' : 'instagram')
  if (request.source === 'facebook-post') {
    if (profile !== 'facebook') throw new MetaLiveRefusal('A Facebook post\'s profile-visit button opens the chosen Page (button.visit facebook): Meta documents the Instagram and both-profiles buttons for Instagram posts.')
    return { parts: { call_to_action: { type: 'VISIT_PROFILE', value: { link: `https://www.facebook.com/${pageId}` } } }, existingFeed: null, brandedExtra: {}, words: 'a visit to the chosen Page', warnings: [PROFILE_VISIT_LIMITED] }
  }
  if (profile === 'facebook') throw new MetaLiveRefusal('An Instagram post\'s profile-visit button opens the chosen Instagram profile (instagram) or lets Meta pick between it and the Page (both).')
  const username = await instagramUsername(chosen)
  const igLink = `https://www.instagram.com/${username}`
  if (profile === 'instagram') return { parts: { call_to_action: { type: 'VIEW_INSTAGRAM_PROFILE', value: { link: igLink } } }, existingFeed: null, brandedExtra: {}, words: `a visit to @${username}`, warnings: [PROFILE_VISIT_LIMITED] }
  return {
    parts: {}, brandedExtra: {}, words: `a visit to @${username} or to the chosen Page (Meta picks per person)`, warnings: ['Meta picks the Instagram profile or the Facebook Page per person (UNIFIED_PROFILE_VISIT_DESTINATION).', PROFILE_VISIT_LIMITED],
    existingFeed: { optimization_type: 'UNIFIED_PROFILE_VISIT_DESTINATION', call_to_actions: [
      // Review B5 — multidestination-profile-visit.md: instagram://user?username=<IG_USERNAME>&userid=<IG_USER_ID>.
      { type: 'VIEW_INSTAGRAM_PROFILE', value: { link: igLink, app_link: `instagram://user?username=${username}&userid=${instagramOf(chosen)}` } },
      { type: 'VISIT_PROFILE', value: { link: `https://www.facebook.com/${pageId}` } },
    ] },
  }
}

/**
 * Threads (CR-236, CR-237; threads-ads/creation/use-posts-as-ads.md): a Facebook or Instagram post's image, video or IMAGE
 * carousel only; no Threads organic post, no partnership boost, no copyrighted music or filters. Meta's Threads guide runs a
 * Threads ad on the business's Instagram account ("that Instagram account needs to be used"): Nexus sends no Threads id
 * (step 25's rule) — Threads delivery is the ad set's Threads placement with the chosen Instagram account (LIVE-PROBES CR-236).
 */
function threadsProblem(source: ResolvedSource): string | null {
  if (source.creator) return 'Meta does not run partnership boosts on Threads (its Threads guide): ask without threads.'
  if (!source.instagram) return 'Threads ads run on the chosen Instagram account: the boost runs as it (withInstagram, and a chosen Instagram account).'
  if (source.media?.productType === 'STORY') return 'Meta runs Facebook and Instagram posts on Threads (image, video, image carousel), not stories.'
  if (source.media?.type === 'CAROUSEL_ALBUM' && source.media.videoChildren) return 'Meta runs only IMAGE carousels on Threads: this carousel has a video.'
  return null
}

export interface BoostDraft extends CreativeDraft {
  /** What the record keeps: the source and, for a creator's content, the content id (never the ad code — review A3). */
  boost: { source: BoostSource | 'video'; name?: string; contentId?: string | null }
}

/** Review A3 — what stands for an ad code in a plan hash (the code itself is in no hash: a short code can be reversed). */
const AD_CODE_IN_PLAN = '[a creator\'s ad code]'
/** A creative's form fields with a creator's ad code replaced, for the plan hash only (what is SENT keeps the code). */
export function withoutAdCode(params: Record<string, string>): Record<string, string> {
  if (!params.branded_content || !/_boost_post_access_token/.test(params.branded_content)) return params
  try {
    const branded = JSON.parse(params.branded_content) as Record<string, unknown>
    for (const key of ['instagram_boost_post_access_token', 'facebook_boost_post_access_token']) if (key in branded) branded[key] = AD_CODE_IN_PLAN
    return { ...params, branded_content: JSON.stringify(branded) }
  } catch {
    return { ...params, branded_content: AD_CODE_IN_PLAN }
  }
}

/** Read just before the send: the ids of the ad account's creatives (null: more than Nexus reads, so "new" is not proven). */
const creativesBefore = (act: string) => async (target: MetaWriteTarget): Promise<ReadonlySet<string> | null> => {
  const read = await listPaged(target.connectionId, 'boost.creativesBefore', `${act}/adcreatives`, { fields: 'id' }, CREATIVES_BEFORE_MAX)
  return read.more ? null : new Set(read.rows.map((r) => idText(r.id)).filter((id): id is string => !!id))
}

async function boostCreateDraft(account: MetaChangeAccount, request: BoostRequest): Promise<BoostDraft | { refusal: string }> {
  const chosen = await metaChosenAccount(account.accountId)
  const pageId = pageOf(chosen)
  const source = request.source
  if (!source || !(BOOST_SOURCES as readonly string[]).includes(source)) return { refusal: `Name the source: ${BOOST_SOURCES.join(', ')}.` }
  const creatorSourceKind = source.startsWith('creator-')
  if (!creatorSourceKind && request.identities) return { refusal: 'identities (which identities a partnership ad shows) goes with a creator\'s content only.' }
  if (!source.endsWith('-code') && request.adCode) return { refusal: 'adCode goes with source creator-instagram-code or creator-facebook-code only.' }
  if (source !== 'facebook-post' && request.withInstagram !== undefined && request.withInstagram !== null) return { refusal: 'withInstagram goes with source facebook-post only (an Instagram source always runs as the chosen Instagram account; a creator\'s content as the creator\'s).' }
  const adFormat = AD_FORMAT_OF[request.identities ?? 'both']
  const resolved = source === 'facebook-post' ? await ownPost(chosen, request)
    : source === 'instagram-media' ? await (async () => {
      if (!request.mediaId) throw new MetaLiveRefusal('Name the media (mediaId: a feed post, Reel, carousel or active story of the chosen Instagram account; meta-instagram-media lists them).')
      return ownInstagramMedia(chosen, request.mediaId, 'id')
    })()
      : source === 'instagram-link' ? await (async () => {
        if (!request.permalink) throw new MetaLiveRefusal('Name the post by its link (permalink: https://www.instagram.com/p/<code>/).')
        return ownInstagramLink(chosen, request.permalink)
      })()
        : await creatorSource(chosen, request, adFormat)
  if (request.threads) {
    const problem = threadsProblem(resolved)
    if (problem) return { refusal: `Nothing was asked of Meta: ${problem}` }
  }
  const button = await buttonOf(chosen, request, resolved)
  const base = { ...resolved.base }
  if (Object.keys(button.brandedExtra).length) base.branded_content = { ...(base.branded_content as Row | undefined), ...button.brandedExtra }
  const creativeRequest: CreativeRequest = {
    action: 'create', name: request.name ?? null, base, existingFeed: button.existingFeed,
    parts: { ...button.parts, ...(request.urlTags ? { url_tags: request.urlTags } : {}) },
    aiFeatures: request.aiFeatures ?? [], featureSettings: request.featureSettings ?? {}, multiAdvertiser: request.multiAdvertiser === true,
    music: request.music === 'random' ? 'random' : 'off',
  }
  // Step 25's builder: the same silent keys, the same judge, exactly as for a post of the chosen Page.
  const built = buildCreative(creativeRequest, { pageId, instagramId: chosen.instagramId })
  if ('refusal' in built) return built
  const act = `act_${account.adAccountId}`
  const name = String(built.creative.name)
  const asked = built.featuresOn
  const label = `Boost ${resolved.label} as creative "${name}" in ad account ${act}`
  const request1: MetaChangeRequest = {
    step: 1, label, kind: 'adaccount', objectId: act, params: built.params,
    // Review A3 — the plan hash leaves a creator's ad code out (the content it unlocks is in what the change stands on).
    planParams: withoutAdCode(built.params),
    // Meta documents validate_only on POST /act_<id>/adcreatives (reference/ad-account/adcreatives): Meta checks it first.
    check: 'meta', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
    operation: 'creative.create', edge: 'adcreatives',
    send: sendCreate(act, built.params, asked, { name, fromExistingPost: true, knownBefore: creativesBefore(act) }),
    doneSentence: (result) => createdSentence(label, result.node),
  }
  const warnings = [
    ...creativeWarnings(built, creativeRequest, { instagram: resolved.instagram }),
    ...resolved.warnings,
    ...button.warnings,
    ...(resolved.creator ? [
      `A partnership boost of a creator's content: the creator's account runs it and this business is its sponsor (the chosen Page${chosen.instagramId ? ' and Instagram account' : ''}); identities shown: ${request.identities ?? 'both'} (ad_format ${adFormat}${adFormat === 3 ? ', Meta picks on Instagram' : ''}). Meta delivers it only with the creator's permission (account-level, post-level or the ad code).`,
    ] : []),
    ...(request.threads ? ['Threads: Meta\'s Threads guide runs a Threads ad on the chosen Instagram account, so Nexus sends no Threads id; it runs on Threads when its ad set has the Threads placement (with Instagram\'s). Likes and comments on Threads do not reach the original post; Threads delivery is kept intentionally low by Meta.'] : []),
    'A boost made of a post Meta already boosted in this ad account answers THAT creative (Meta reuses it): nothing new is made, and the undo never deletes it. Nexus reads the account\'s creatives just before the send to tell (more than 500: not proven new, never deleted).',
  ]
  const identity = resolved.creator ? `the creator, with this business as sponsor (ad_format ${adFormat})` : resolved.instagram ? 'the chosen Facebook Page and Instagram account' : 'the chosen Facebook Page'
  const { changes } = changeLines([
    [`Creative "${name}"`, 'not in the ad account', `made from ${SOURCE_WORDS[source]} (Meta answers its id)`],
    ['Runs as', '—', identity],
    ['Button', '—', button.words],
    ['Advantage+ creative features ON', '—', asked.length ? asked.join(', ') : 'none'],
  ])
  return {
    summary: `Meta: boost ${resolved.label} as creative "${name}" in ad account ${act} (a creative spends nothing).`,
    changes, totals: { creatives: 1, requests: 1, featuresOn: asked.length },
    warnings, spendsMoney: [], skipped: [], requests: [request1],
    stands: { action: 'create', source, adAccountId: account.adAccountId, pageId, instagramId: chosen.instagramId, ...resolved.stands },
    before: { kind: 'create', items: [] },
    after: { kind: 'create', items: [{ kind: 'creative', name }] },
    creative: { action: 'create', name, featuresOn: asked },
    boost: { source, name, ...(resolved.creator ? { contentId: (resolved.stands.contentId as string | null) ?? null } : {}) },
  }
}

/**
 * MD-138 — a creator's Instagram VIDEO copied into the chosen account's video library with the creator's ad code (the
 * documented fix for "Instagram Video Must Be Uploaded To Facebook"; boost-existing-post.md): the code must unlock exactly that
 * media (content discovery), of no other Nexus business. Step 23's video sender (read back, processing polled, "was it new?").
 */
async function copyVideoDraft(account: MetaChangeAccount, request: BoostRequest): Promise<BoostDraft | { refusal: string }> {
  const chosen = await metaChosenAccount(account.accountId)
  const mediaId = request.mediaId ?? ''
  if (!/^\d{1,25}$/.test(mediaId)) return { refusal: 'Name the creator\'s Instagram video (mediaId: digits).' }
  const code = request.adCode?.trim() ?? ''
  if (!META_AD_CODE.test(code)) return { refusal: 'adCode is the partnership ad code the creator shared for that video (letters, digits and _ = + / -).' }
  const { row, warnings } = await creatorContent(chosen, { adCode: code }, 'INSTAGRAM')
  if (row.contentId !== mediaId) return { refusal: 'The creator\'s ad code unlocks other content than that media: nothing was asked of Meta.' }
  if (row.mediaType && row.mediaType !== 'VIDEO') return { refusal: `Media ${mediaId} is ${row.mediaType.toLowerCase()} content, not a video: only a video is copied into the library this way.` }
  const act = `act_${account.adAccountId}`
  const params = { source_instagram_media_id: mediaId, partnership_ad_ad_code: code, is_partnership_ad: 'true' }
  const label = `Copy the creator's Instagram video ${mediaId} into ad account ${act}'s video library (with the creator's ad code)`
  const request1: MetaChangeRequest = {
    step: 1, label, kind: 'adaccount', objectId: act, params, planParams: { ...params, partnership_ad_ad_code: AD_CODE_IN_PLAN },
    // Meta documents no validate_only on advideos (reference/ad-account/advideos): no check.
    check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
    operation: 'media.videoUpload', edge: 'advideos',
    send: sendAdVideo(act, params, false),
    doneSentence: (result) => {
      const n = (result.node ?? {}) as { videoId?: unknown; new?: unknown; statusText?: unknown }
      return `${label}: Meta made video ${String(n.videoId ?? '?')}${n.new === true ? ' (new in the library; its undo may remove it while no creative uses it)' : ' (not proven new: its undo never removes it)'}. ${typeof n.statusText === 'string' ? n.statusText : ''} Then boost the content again with source creator-instagram-code.`.trim()
    },
  }
  return {
    summary: `Meta: copy a creator's Instagram video into ad account ${act}'s video library with the creator's ad code (an upload spends nothing).`,
    changes: changeLines([[`Creator video ${mediaId}`, 'not in the ad account\'s video library', 'copied (Meta answers its video id)']]).changes,
    totals: { videos: 1, requests: 1 },
    warnings: [
      ...warnings,
      'Meta has no check for an upload (its advideos edge lists no validate_only): the preview is built from Meta\'s content discovery as it is now.',
      'An upload spends nothing. Meta needs it processed before a creative uses it: the run waits for Meta\'s processing and says where it stands.',
      AD_CODE_KEPT,
      'Its undo removes the video again (create-meta-media kind undo) only when this copy made it new, and only while no creative uses it.',
    ],
    spendsMoney: [], skipped: [], requests: [request1],
    stands: { action: 'copy-creator-video', adAccountId: account.adAccountId, mediaId, contentId: row.contentId, author: row.author },
    before: { kind: 'video', items: [] },
    after: { kind: 'video', items: [{ kind: 'video', source: `creator-instagram:${mediaId}`, method: 'advideos' }] },
    creative: { action: 'create' },
    boost: { source: 'video' },
  }
}

/** The draft of one create-meta-boost request, from what Meta holds now (reads only). */
export async function boostDraft(account: MetaChangeAccount, request: BoostRequest): Promise<BoostDraft | CreativeDraft | { refusal: string }> {
  try {
    if (request.action === 'undo') {
      const ids = request.creatives ?? []
      if (ids.length > MAX_CREATIVE_UNDO) return { refusal: `At most ${MAX_CREATIVE_UNDO} creatives per request.` }
      // Step 25's creative undo, for creatives THIS tool made new (its own records only).
      return await creativeUndoDraft(account, ids, BOOST_TOOL)
    }
    return request.action === 'copy-creator-video' ? await copyVideoDraft(account, request) : await boostCreateDraft(account, request)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

// ── set-meta-partnership-access ─────────────────────────────────────────────────────────────────────────────────────

export const PARTNERSHIP_ACTIONS = [
  'request', 'revoke', 'approve-creators', 'unapprove-creators', 'create-ad-code', 'delete-ad-code', 'collab-invite',
  'facebook-request', 'facebook-cancel', 'facebook-accept', 'facebook-reject', 'facebook-remove',
  'facebook-allowlist', 'facebook-allow-creators', 'facebook-disallow-creators', 'facebook-untag',
] as const
export type PartnershipAction = typeof PARTNERSHIP_ACTIONS[number]
/** Creators one request names (each permission request is its own call; a tag-approval list change is one call). */
export const MAX_CREATORS = 10

/**
 * Review B1 (round 1) — the Facebook side, on Meta's partnership REST host (api.facebook.com, gateway/meta-boost-rules.ts):
 * the chosen Page's account-level partnership permissions (fb-account-level-permissioning.md: send-request, cancel-request,
 * accept-request, reject-request; Meta's list says remove-permission and its example sends revoke-permission — Nexus sends
 * revoke-permission, LIVE-PROBES CR-352r), its branded-content allowlist (on / off, creators added / removed) and the sponsor
 * tag of posts that tag it (guides/branded-content-permissions.md). The system-user token goes as the Bearer Meta's pages ask
 * for (step 16 reads the same host so); if Meta refuses it, the step says Meta's words — step 36's Page-token mode (`auth:
 * 'page'`) is the fallback, not built here.
 */
export const FB_ACTION_OF: Readonly<Record<string, typeof META_FB_PERMISSION_ACTIONS[number]>> = {
  'facebook-request': 'send-request', 'facebook-cancel': 'cancel-request', 'facebook-accept': 'accept-request', 'facebook-reject': 'reject-request', 'facebook-remove': 'revoke-permission',
}
const FB_WORDS: Readonly<Record<string, string>> = {
  'send-request': 'Send a partnership request to', 'cancel-request': 'Cancel the partnership request sent to', 'accept-request': 'Accept the partnership request of',
  'reject-request': 'Reject the partnership request of', 'revoke-permission': 'End the partnership permission with',
}

/**
 * Review A2 (round 1) — CR-363: Meta answers a partnership ad code ONCE, in the answer to the call that makes it (ad-codes.md
 * documents no read of it), and no Nexus path shows a run's answer to the person afterwards (an approved run's answer goes back
 * to the click that approved it only; a rule run, a change-plan step or the "no approval" switch drops it). So Nexus does not
 * make one: it would be a code nobody can read.
 */
export const CREATE_AD_CODE_ANSWER = 'Not queued: Meta answers a partnership ad code only once, in the answer to the call that makes it, and Nexus cannot show it to you later (Meta documents no way to read it back) — so Nexus does not make one. Make the code in the Instagram app (Meta\'s ad-codes guide points creators there: the post\'s partnership ad code), where you can read and share it. delete-ad-code removes a code from one of the business\'s own media.'

export interface CreatorRef { instagramId?: string | null; username?: string | null }
export interface PartnershipRequest {
  action: PartnershipAction
  creators?: CreatorRef[]
  mediaId?: string | null
  accept?: boolean | null
  /** facebook-…: the partner / creator Pages (their ids). */
  pages?: string[]
  /** facebook-allowlist: on (true) or off (false). */
  enabled?: boolean | null
  /** facebook-untag: the branded-content posts (their ids as Meta's tagged-posts view lists them). */
  postIds?: string[]
}

/** The creators of a request as Instagram ids: a username resolved (business discovery), never the chosen account, never another Nexus business's. */
async function creatorIds(chosen: MetaChosenAccount, creators: CreatorRef[], max: number): Promise<string[]> {
  if (!creators.length) throw new MetaLiveRefusal('Name the creators (creators: each by instagramId or username).')
  if (creators.length > max) throw new MetaLiveRefusal(`At most ${max} creators per request.`)
  const ids: string[] = []
  for (const c of creators) {
    if (!!c.instagramId === !!c.username) throw new MetaLiveRefusal('Name each creator by instagramId or by username, one of them.')
    let id = c.instagramId ? idText(c.instagramId) : null
    if (c.username) {
      const found = await livePartnership({ connectionId: chosen.connectionId, view: 'creator-id', username: c.username }) as unknown as { instagramId?: unknown; takenByAnotherBusiness?: unknown }
      if (found.takenByAnotherBusiness === true) throw new MetaLiveRefusal('That creator\'s Instagram account is one another business in Nexus uses: nothing was asked of Meta.')
      id = idText(found.instagramId)
    }
    if (!id) throw new MetaLiveRefusal('Every creator is an Instagram account id (digits) or a professional account\'s username.')
    if (id === chosen.instagramId) throw new MetaLiveRefusal('A creator is another Instagram account than the business\'s own chosen one.')
    ids.push(id)
  }
  if (new Set(ids).size !== ids.length) throw new MetaLiveRefusal('Name each creator once.')
  const taken = await takenIds('INSTAGRAM', ids)
  if (taken.size) throw new MetaLiveRefusal(`Instagram account${taken.size === 1 ? '' : 's'} ${[...taken].join(', ')} ${taken.size === 1 ? 'is' : 'are'} one another business in Nexus uses: nothing was asked of Meta.`)
  return ids
}

export interface PartnershipDraft extends MetaChangeDraft {
  partnership: { action: PartnershipAction; instagramId?: string; pageId?: string; creators?: string[]; pages?: string[]; postIds?: string[]; mediaId?: string; accept?: boolean; enabled?: boolean }
}

const NO_CHECK = 'Meta has no check for this change (no validate_only on the Instagram partnership, tag-approval, ad-code or Collab edges): the preview is built from what Meta holds now.'
const SPENDS_NOTHING = 'Nothing here spends money: it changes who may make partnership content with the business, not an ad.'
const ACCESS_NOTE = 'Meta needs instagram_branded_content_ads_brand (+ instagram_basic, business_management) on the system user\'s token and the ADS, CREATOR_MANAGEMENT or CREATOR_CONTENT role on the Instagram account; when Meta refuses for access, the step says Meta\'s own words.'

async function permissionDraft(chosen: MetaChosenAccount, request: PartnershipRequest, revoke: boolean): Promise<PartnershipDraft> {
  const instagramId = instagramOf(chosen)
  const ids = await creatorIds(chosen, request.creators ?? [], MAX_CREATORS)
  // Step 16's read of the account's permissions (pending included): what each creator's permission reads now.
  const now = await livePartnership({ connectionId: chosen.connectionId, view: 'instagram-permissions', limit: 100 }) as unknown as { items?: Array<Row> }
  const status = new Map<string, string | null>()
  for (const r of now.items ?? []) { const id = idText(r.creatorInstagramId); if (id) status.set(id, text(r.status)) }
  const skipped: string[] = []
  const going: string[] = []
  for (const id of ids) {
    const s = status.get(id) ?? null
    if (!revoke && s && /^(APPROVED|PENDING|PENDING_APPROVAL)$/i.test(s)) { skipped.push(`Creator ${id} already reads ${s}: no new request is sent.`); continue }
    // A creator not among the first 100 permissions Nexus reads is sent all the same (Meta answers if there is none).
    if (revoke && s && /^(REVOKED|REJECTED|CANCELED|CANCELLED)$/i.test(s)) { skipped.push(`Creator ${id} has no active permission to revoke (it reads ${s}).`); continue }
    going.push(id)
  }
  const requests: MetaChangeRequest[] = going.map((id, i) => {
    const label = revoke ? `Revoke the Instagram partnership permission of creator ${id} for the chosen Instagram account ${instagramId}` : `Ask creator ${id} for Instagram partnership permission for the chosen Instagram account ${instagramId}`
    return {
      step: i + 1, label, kind: 'iguser', objectId: instagramId, params: { creator_instagram_account: id, ...(revoke ? { revoke: 'true' } : {}) },
      check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
      operation: revoke ? 'partnership.revoke' : 'partnership.request', edge: 'branded_content_ad_permissions', readBackFields: 'id,permission_type,status',
      doneSentence: (result) => `${label}: Meta took it${idText(result.node?.id) ? ` (permission ${idText(result.node?.id)}${text(result.node?.status) ? `, ${text(result.node?.status)}` : ''})` : ''}.`,
    }
  })
  return {
    summary: `Meta: ${revoke ? 'revoke the Instagram partnership permission of' : 'ask for Instagram partnership permission from'} ${plural(going.length, 'creator')} for the chosen Instagram account.`,
    changes: changeLines(going.map((id) => [`Creator ${id} partnership permission`, status.get(id) ?? 'none', revoke ? 'revoked' : 'requested (the creator accepts in the Instagram app)'])).changes,
    totals: { creators: going.length, requests: requests.length, ...(skipped.length ? { skipped: skipped.length } : {}) },
    warnings: [
      revoke
        ? 'Revoking ends the business\'s account-level permission: ads that rely on it stop delivering (Meta does not say more), and a new request needs the creator to accept again.'
        : 'This sends each creator a request in the Instagram app (outbound to a third party). Once accepted, the business can run partnership ads from the creator\'s handle without a post, boost the creator\'s posts that tag it, and include or exclude the creator\'s audience.',
      NO_CHECK, SPENDS_NOTHING, ACCESS_NOTE,
    ],
    spendsMoney: [], skipped, requests,
    stands: { action: request.action, instagramId, creators: going.map((id) => ({ id, status: status.get(id) ?? null })) },
    before: { kind: 'partnership', action: request.action, instagramId, creators: going.map((id) => ({ instagramId: id, status: status.get(id) ?? null })) },
    after: { kind: 'partnership', action: request.action, instagramId, creators: going.map((id) => ({ instagramId: id })) },
    partnership: { action: request.action, instagramId, creators: going },
  }
}

async function tagApprovalDraft(chosen: MetaChosenAccount, request: PartnershipRequest, approve: boolean): Promise<PartnershipDraft> {
  const instagramId = instagramOf(chosen)
  const ids = await creatorIds(chosen, request.creators ?? [], META_TAG_APPROVAL_MAX)
  // Step 16's read of the approved-tagging list for these creators (Advanced Access: when Meta refuses it, nothing is sent —
  // the undo could not tell which creators were already on the list).
  let approved: Set<string>
  try {
    const read = await livePartnership({ connectionId: chosen.connectionId, view: 'tag-approvals', userIds: ids }) as unknown as { items?: Array<Row> }
    approved = new Set((read.items ?? []).filter((r) => r.approvedToTag === true).map((r) => idText(r.instagramId)).filter((id): id is string => !!id))
  } catch (err) {
    if (err instanceof MetaLiveRefusal) throw new MetaLiveRefusal(`Nexus could not read the approved-tagging list first, so it changes nothing (its undo could not tell which creators were on it before): ${err.message}`)
    throw err
  }
  const going = ids.filter((id) => approved.has(id) !== approve)
  const skipped = ids.filter((id) => approved.has(id) === approve).map((id) => `Creator ${id} is ${approve ? 'already' : 'not'} on the approved-tagging list.`)
  const requests: MetaChangeRequest[] = going.length ? [{
    step: 1, label: `${approve ? 'Add' : 'Take'} ${plural(going.length, 'creator')} ${approve ? 'to' : 'off'} the approved-tagging list of the chosen Instagram account ${instagramId}`,
    kind: 'iguser', objectId: instagramId, params: { user_ids: going.join(',') },
    check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
    operation: approve ? 'partnership.tagApprove' : 'partnership.tagUnapprove', edge: 'branded_content_tag_approval', ...(approve ? {} : { method: 'DELETE' as const }),
    doneSentence: () => `${approve ? 'Added' : 'Took'} ${going.join(', ')} ${approve ? 'to' : 'off'} the approved-tagging list: Meta took ${going.length === 1 ? 'it' : 'all of them'}.`,
  }] : []
  return {
    summary: `Meta: ${approve ? 'add' : 'take'} ${plural(going.length, 'creator')} ${approve ? 'to' : 'off'} the chosen Instagram account's approved-tagging list (who may tag it in the paid-partnership label).`,
    changes: changeLines(going.map((id) => [`Creator ${id} may tag the business`, approve ? 'no' : 'yes', approve ? 'yes' : 'no'])).changes,
    totals: { creators: going.length, requests: requests.length, ...(skipped.length ? { skipped: skipped.length } : {}) },
    warnings: [
      'Meta changes the list all or nothing: if one creator fails, Meta adds or removes none (and answers false).',
      'Meta documents this with a Facebook User token, instagram_branded_content_brand and Advanced Access (App Review): Nexus sends the business\'s system-user token, and when Meta refuses, the step says Meta\'s own words.',
      NO_CHECK, SPENDS_NOTHING,
    ],
    spendsMoney: [], skipped, requests,
    stands: { action: request.action, instagramId, approved: [...approved].sort(), going },
    before: { kind: 'partnership', action: request.action, instagramId, creators: going.map((id) => ({ instagramId: id, approved: !approve })) },
    after: { kind: 'partnership', action: request.action, instagramId, creators: going.map((id) => ({ instagramId: id, approved: approve })) },
    partnership: { action: request.action, instagramId, creators: going },
  }
}

async function deleteAdCodeDraft(chosen: MetaChosenAccount, request: PartnershipRequest): Promise<PartnershipDraft> {
  const instagramId = instagramOf(chosen)
  if (!request.mediaId) throw new MetaLiveRefusal('Name the media (mediaId: a media of the chosen Instagram account; meta-instagram-media lists them).')
  // ad-codes.md: "from media you own" — the chosen Instagram account's own media only (Meta's owner, read live).
  const own = await ownMedia(chosen, request.mediaId)
  const label = `Delete the partnership ad code of media ${own.mediaId} of the chosen Instagram account`
  return {
    summary: `Meta: delete the partnership ad code of media ${own.mediaId} of the chosen Instagram account.`,
    changes: changeLines([[`Media ${own.mediaId} partnership ad code`, 'the one Meta holds (Meta documents no read of it)', 'deleted']]).changes,
    totals: { media: 1, requests: 1 },
    warnings: [
      'A deleted ad code cannot come back: a new one is a different code. What happens to ads already built with it Meta does not say.',
      NO_CHECK, SPENDS_NOTHING,
      'Meta documents this with instagram_branded_content_creator on the business\'s own Instagram account; when Meta refuses, the step says Meta\'s own words.',
    ],
    spendsMoney: [], skipped: [],
    requests: [{
      step: 1, label, kind: 'igmedia', objectId: own.mediaId, params: {},
      check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
      operation: 'partnership.adCodeDelete', edge: 'partnership_ad_code', method: 'DELETE',
      doneSentence: () => `${label}: Meta deleted it.`,
    }],
    stands: { action: request.action, instagramId, mediaId: own.mediaId },
    before: { kind: 'partnership', action: request.action, instagramId, mediaId: own.mediaId, code: 'present' },
    after: { kind: 'partnership', action: request.action, instagramId, mediaId: own.mediaId, code: 'deleted' },
    partnership: { action: request.action, instagramId, mediaId: own.mediaId },
  }
}

/** How many pending Collab invites Nexus reads to find one (step 16's read, 50 a page). */
export const COLLAB_READ_PAGES = 4

async function collabDraft(chosen: MetaChosenAccount, request: PartnershipRequest): Promise<PartnershipDraft> {
  const instagramId = instagramOf(chosen)
  const mediaId = request.mediaId && /^\d{1,25}$/.test(request.mediaId) ? request.mediaId : null
  if (!mediaId) throw new MetaLiveRefusal('Name the invited media (mediaId; meta-partnership-content view collab-invites lists them).')
  if (typeof request.accept !== 'boolean') throw new MetaLiveRefusal('Say accept true (accept the Collab invite) or false (decline it).')
  // Step 16's read of the pending invites: the media must be one of them.
  let invite: Row | null = null
  let after: string | null = null
  for (let page = 0; page < COLLAB_READ_PAGES && !invite; page++) {
    const read = await livePartnership({ connectionId: chosen.connectionId, view: 'collab-invites', limit: 50, ...(after ? { after } : {}) }) as unknown as { items?: Array<Row>; nextAfter?: unknown }
    invite = (read.items ?? []).find((r) => idText(r.mediaId) === mediaId) ?? null
    after = text(read.nextAfter)
    if (!after) break
  }
  if (!invite) throw new MetaLiveRefusal(`Media ${mediaId} is not among the Collab invites the chosen Instagram account has pending (Nexus reads the first ${COLLAB_READ_PAGES * 50}).`)
  // The inviting account must be no other Nexus business's (its username, through business discovery; a personal account
  // is no business's chosen Instagram account — Meta's discovery finds professional accounts only).
  const owner = text(invite.ownerUsername)
  // Review A5 — an invite whose sender Meta does not name is answered by nobody: Nexus cannot tell whose it is.
  if (!owner) throw new MetaLiveRefusal(`Meta does not name who sent the Collab invite to media ${mediaId}, so Nexus cannot confirm it is no other business's in Nexus: nothing was asked of Meta (answer it in the Instagram app).`)
  {
    try {
      const found = await livePartnership({ connectionId: chosen.connectionId, view: 'creator-id', username: owner }) as unknown as { takenByAnotherBusiness?: unknown }
      if (found.takenByAnotherBusiness === true) throw new MetaLiveRefusal('That Collab invite comes from an Instagram account another business in Nexus uses: nothing was asked of Meta.')
    } catch (err) {
      if (!(err instanceof MetaLiveRefusal) || /another business in Nexus/.test(err.message)) throw err
      if (!/found no Instagram professional account/i.test(err.message)) throw new MetaLiveRefusal(`Nexus could not confirm whose Collab invite this is, so it answers nothing: ${err.message}`)
    }
  }
  const accept = request.accept
  const label = `${accept ? 'Accept' : 'Decline'} the Collab invite to media ${mediaId} from @${owner} for the chosen Instagram account ${instagramId}`
  return {
    summary: `Meta: ${accept ? 'accept' : 'decline'} a Collab invite of the chosen Instagram account.`,
    changes: changeLines([[`Collab invite to media ${mediaId}`, 'pending', accept ? 'accepted' : 'declined']]).changes,
    totals: { invites: 1, requests: 1 },
    warnings: [
      accept ? 'Accepting makes the post appear on the business\'s Instagram profile as a co-author (public), and lets it become a partnership ad.' : 'Declining removes the invite; only the inviting account can invite again.',
      'Meta documents no way to take an answer back by API (reversibility none): a person removes the business as collaborator in the Instagram app.',
      'Meta allows 50 of these answers per Instagram account per day; feed images, Reels and carousels only (no Stories). Its guide shows a User token: Nexus sends the business\'s system-user token, and when Meta refuses, the step says Meta\'s own words.',
      NO_CHECK, SPENDS_NOTHING,
    ],
    spendsMoney: [], skipped: [],
    requests: [{
      step: 1, label, kind: 'iguser', objectId: instagramId, params: { media_id: mediaId, accept: accept ? 'true' : 'false' },
      check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
      operation: 'partnership.collab', edge: 'collaboration_invites',
      doneSentence: () => `${label}: Meta took it.`,
    }],
    stands: { action: 'collab-invite', instagramId, mediaId, owner, accept },
    before: { kind: 'partnership', action: 'collab-invite', instagramId, mediaId, invite: 'pending' },
    after: { kind: 'partnership', action: 'collab-invite', instagramId, mediaId, invite: accept ? 'accepted' : 'declined' },
    partnership: { action: 'collab-invite', instagramId, mediaId, accept },
  }
}

/** The draft of one set-meta-partnership-access request (the Facebook actions never reach here: the tool answers them). */
export async function partnershipDraft(account: MetaChangeAccount, request: PartnershipRequest): Promise<PartnershipDraft | { refusal: string }> {
  try {
    if (request.action === 'create-ad-code') return { refusal: CREATE_AD_CODE_ANSWER }
    const chosen = await metaChosenAccount(account.accountId)
    if (FB_ACTION_OF[request.action]) return await fbPermissionDraft(chosen, request)
    switch (request.action) {
      case 'facebook-allowlist': return await fbAllowlistDraft(chosen, request)
      case 'facebook-allow-creators': return await fbCreatorsDraft(chosen, request, true)
      case 'facebook-disallow-creators': return await fbCreatorsDraft(chosen, request, false)
      case 'facebook-untag': return await fbUntagDraft(chosen, request)
      case 'request': return await permissionDraft(chosen, request, false)
      case 'revoke': return await permissionDraft(chosen, request, true)
      case 'approve-creators': return await tagApprovalDraft(chosen, request, true)
      case 'unapprove-creators': return await tagApprovalDraft(chosen, request, false)
      case 'delete-ad-code': return await deleteAdCodeDraft(chosen, request)
      case 'collab-invite': return await collabDraft(chosen, request)
    }
    return { refusal: `Unknown action ${request.action}.` }
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

/** Is a value one of Meta's CTA types? (A boost's link buttons are all of them — a test holds it.) */
export const isMetaCta = (type: string) => META_CTA_TYPES.includes(type)

// ── the Facebook side (review B1): Meta's partnership REST host ────────────────────────────────────────────────────────

const FB_NO_CHECK = 'Meta has no check for this change (no validate_only on its partnership host): the preview is built from what Meta holds now, read through Nexus\'s partnership views (meta-partnership-content).'
const FB_ACCESS = 'Meta asks for facebook_branded_content_ads_brand and an Authorization: Bearer token on its partnership host: Nexus sends the business\'s system-user token (as step 16\'s reads of the same host do). If Meta refuses it, the step says Meta\'s own words.'
const NOT_ATOMIC = 'Meta answers each Page or post of the list on its own (not all or nothing): the run says what Meta did for each, and only what Meta made is recorded (and undone).'

/** Partner / creator Page ids of a request: digits, each once, never the chosen Page, never one another Nexus business uses. */
async function pageIds(chosen: MetaChosenAccount, pages: string[], max: number, what: string): Promise<string[]> {
  const ids = [...new Set(pages.map((p) => p.trim()))]
  if (!ids.length) throw new MetaLiveRefusal(`Name the ${what} (pages: their Facebook Page ids).`)
  if (ids.length !== pages.length) throw new MetaLiveRefusal('Name each Page once.')
  if (ids.length > max) throw new MetaLiveRefusal(`At most ${max} Pages per request.`)
  if (ids.some((id) => !/^\d{1,25}$/.test(id))) throw new MetaLiveRefusal('A Page is named by its id (digits).')
  if (ids.includes(pageOf(chosen))) throw new MetaLiveRefusal(`A ${what.replace(/s$/, '')} is another Page than the business's own chosen one.`)
  const taken = await takenIds('PAGE', ids)
  if (taken.size) throw new MetaLiveRefusal(`Page${taken.size === 1 ? '' : 's'} ${[...taken].join(', ')} ${taken.size === 1 ? 'is' : 'are'} one another business in Nexus uses: nothing was asked of Meta.`)
  return ids
}

/** One item of Meta's per-item answer: its id, whether Meta made it, and Meta's words. */
interface FbItem { id: string | null; ok: boolean; words: string }
function fbItems(node: Record<string, unknown> | null, idKey: string): FbItem[] {
  const items = Array.isArray(node?.items) ? (node!.items as unknown[]).filter(isObject) : []
  return items.map((it) => {
    const ok = it.status === 'success' || it.status_code === 200 || it.status_code === '200'
    const status = typeof it.alp_permission_status === 'number' || typeof it.alp_permission_status === 'string' ? ` (status ${String(it.alp_permission_status)})` : ''
    return { id: idText(it[idKey]), ok, words: ok ? `done${status}` : `Meta refused it${text(it.error_message) ? `: ${text(it.error_message)}` : it.error_code || it.status_code ? ` (${String(it.error_code ?? it.status_code)})` : ''}` }
  })
}

/**
 * The sender of one list change: Meta answers each item on its own. Nothing made at all → refused (nothing changed); an
 * answer with no per-item result → not confirmed (Nexus cannot say what Meta did).
 */
function sendFbList(call: Parameters<typeof metaSendRest>[1], idKey: string) {
  return async (target: MetaWriteTarget): Promise<MetaChangeResult> => {
    const result = await metaSendRest(target, call)
    const items = fbItems(result.node, idKey)
    if (!items.length) throw new MetaWriteError(localFailure(`Meta answered without a result per Page or post, so Nexus cannot say what it did. ${META_UNKNOWN_OUTCOME}`, 'META_NO_ITEMS'), call.operation, 'unknown')
    if (!items.some((i) => i.ok)) throw new MetaWriteError(localFailure(`Meta changed none of them: ${items.map((i) => `${i.id ?? '?'} — ${i.words}`).join('; ')}.`, 'META_ITEMS_REFUSED'), call.operation, 'refused')
    return { node: { items }, readBack: 'same-request', waitedMs: 0 }
  }
}
const itemsSentence = (label: string, result: MetaChangeResult) => `${label}: ${((result.node?.items ?? []) as FbItem[]).map((i) => `${i.id ?? '?'} ${i.words}`).join('; ')}.`

/** CR-348 … CR-352, OT-014 … OT-016 — the chosen Page's account-level partnership permissions with partner Pages. */
async function fbPermissionDraft(chosen: MetaChosenAccount, request: PartnershipRequest): Promise<PartnershipDraft> {
  const pageId = pageOf(chosen)
  const action = FB_ACTION_OF[request.action]
  const ids = await pageIds(chosen, request.pages ?? [], META_FB_PARTNERS_MAX, 'partner Pages')
  // Step 16's read (fb-account-level-permissions, both directions) for these partners: what each permission reads now.
  const now = await livePartnership({ connectionId: chosen.connectionId, view: 'facebook-permissions', partnerPageIds: ids, limit: 1000 }) as unknown as { items?: Row[] }
  const rows = (now.items ?? []).map((r) => ({ page: idText(r.partnerPageId), status: text(r.status), direction: text(r.direction) }))
  const of = (id: string) => rows.filter((r) => r.page === id)
  const has = (id: string, status: string, direction?: string) => of(id).some((r) => r.status === status && (!direction || r.direction === direction))
  const skipped: string[] = []
  const going = ids.filter((id) => {
    const ok = action === 'send-request' ? !has(id, 'PENDING_APPROVAL') && !has(id, 'APPROVED')
      : action === 'cancel-request' ? has(id, 'PENDING_APPROVAL', 'sent')
        : action === 'accept-request' || action === 'reject-request' ? has(id, 'PENDING_APPROVAL', 'received')
          : has(id, 'APPROVED')
    if (!ok) skipped.push(`Page ${id}: ${action === 'send-request' ? 'a request is pending or the permission is approved already' : action === 'cancel-request' ? 'no request the Page sent is pending' : action === 'revoke-permission' ? 'no approved permission' : 'no request from it is pending'} (${of(id).map((r) => `${r.direction ?? '?'} ${r.status ?? '?'}`).join(', ') || 'none'}).`)
    return ok
  })
  const route = `partnership-ads/fb-account-level-permissions/${pageId}`
  const body = metaPermissionBodyOf(going.map((id) => ({ pageId: id, action })))
  const label = `${FB_WORDS[action]} ${plural(going.length, 'partner Page')} (${going.join(', ')}) for the chosen Page ${pageId}`
  const operation = `partnership.fb.${action}`
  const requests: MetaChangeRequest[] = going.length ? [{
    step: 1, label, kind: 'page', objectId: pageId, params: { route, method: 'POST', body },
    check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, operation,
    send: sendFbList({ operation, pageId, path: route, method: 'POST', body }, 'partner_page_id'),
    doneSentence: (result) => itemsSentence(label, result),
  }] : []
  return {
    summary: `Meta: ${FB_WORDS[action].toLowerCase()} ${plural(going.length, 'partner Page')} for the chosen Facebook Page.`,
    changes: changeLines(going.map((id) => [`Partner Page ${id}`, of(id).map((r) => `${r.direction} ${r.status}`).join(', ') || 'none', action])).changes,
    totals: { pages: going.length, requests: requests.length, ...(skipped.length ? { skipped: skipped.length } : {}) },
    warnings: [
      action === 'send-request' ? 'This sends each partner Page a request (outbound to a third party); once it accepts, the business can run partnership ads with that Page without a permission per post.'
        : action === 'accept-request' ? 'Accepting lets the partner Page use the business\'s content for ITS partnership ads — a person\'s decision.'
          : action === 'reject-request' ? 'A rejected request cannot be undone by Nexus: the partner has to ask again.'
            : action === 'cancel-request' ? 'A canceled request can no longer be accepted by the partner.'
              : 'Ending the permission stops either side from using it for partnership ads. Meta\'s list calls this action remove-permission, its example sends revoke-permission: Nexus sends revoke-permission (LIVE-PROBES CR-352r).',
      NOT_ATOMIC, FB_NO_CHECK, SPENDS_NOTHING, FB_ACCESS,
    ],
    spendsMoney: [], skipped, requests,
    stands: { action: request.action, pageId, permissions: going.map((id) => ({ id, now: of(id) })) },
    before: { kind: 'partnership', action: request.action, pageId, pages: going.map((id) => ({ pageId: id, now: of(id).map((r) => `${r.direction} ${r.status}`) })) },
    after: { kind: 'partnership', action: request.action, pageId, pages: going.map((id) => ({ pageId: id })) },
    partnership: { action: request.action, pageId, pages: going },
  }
}

/** CR-357, OT-026 — the chosen Page's branded-content allowlist on or off (Meta's own answer reads it back). */
async function fbAllowlistDraft(chosen: MetaChosenAccount, request: PartnershipRequest): Promise<PartnershipDraft> {
  const pageId = pageOf(chosen)
  if (typeof request.enabled !== 'boolean') throw new MetaLiveRefusal('Say enabled true (only allowlisted creator Pages may tag the Page) or false (any creator allowed to make branded content may).')
  const now = await livePartnership({ connectionId: chosen.connectionId, view: 'allowlist' }) as unknown as { allowlistStatus?: unknown; allowlistStatusNotRead?: unknown }
  const status = text(now.allowlistStatus)
  if (!status) throw new MetaLiveRefusal(`Nexus could not read the allowlist status first, so it changes nothing: ${text(now.allowlistStatusNotRead) ?? 'Meta answered no status.'}`)
  const wanted = request.enabled ? 'ENABLED' : 'DISABLED'
  const route = `partnership-ads/fb-branded-content/${pageId}/brand-allowlist-status`
  const label = `Switch the branded-content allowlist of the chosen Page ${pageId} ${request.enabled ? 'on' : 'off'}`
  const operation = 'partnership.fb.allowlistStatus'
  const query = { is_enabled: request.enabled ? 'true' : 'false' }
  const requests: MetaChangeRequest[] = status === wanted ? [] : [{
    step: 1, label, kind: 'page', objectId: pageId, params: { route, method: 'PUT', ...query },
    check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, operation,
    send: async (target) => {
      const result = await metaSendRest(target, { operation, pageId, path: route, method: 'PUT', query })
      const read = text(result.node?.allowlist_status)
      if (read && read !== wanted) throw new MetaWriteError(localFailure(`Meta answered success but the allowlist reads ${read}, not ${wanted}. Nexus records no change and never sends it again by itself.`, 'META_NOT_AS_ASKED'), operation, 'unknown')
      return result
    },
    doneSentence: (result) => `${label}: Meta ${text(result.node?.allowlist_status) ? `reads it ${text(result.node?.allowlist_status)}` : 'took it'}.`,
  }]
  return {
    summary: `Meta: switch the chosen Page's branded-content allowlist ${request.enabled ? 'on' : 'off'}.`,
    changes: changeLines([[`Page ${pageId} branded-content allowlist`, status, wanted]]).changes,
    totals: { requests: requests.length },
    warnings: [
      request.enabled ? 'ENABLED: only the creator Pages on the allowlist may tag the Page in branded content.' : 'DISABLED: any creator allowed to make branded content may tag the Page.',
      'Its undo switches it back.', FB_NO_CHECK, SPENDS_NOTHING, FB_ACCESS,
    ],
    spendsMoney: [], skipped: status === wanted ? [`The allowlist already reads ${status}.`] : [], requests,
    stands: { action: request.action, pageId, status },
    before: { kind: 'partnership', action: request.action, pageId, enabled: status === 'ENABLED' },
    after: { kind: 'partnership', action: request.action, pageId, enabled: request.enabled },
    partnership: { action: request.action, pageId, enabled: request.enabled },
  }
}

/** CR-359, CR-360, OT-028, OT-029 — creator Pages added to or taken off the chosen Page's branded-content allowlist. */
async function fbCreatorsDraft(chosen: MetaChosenAccount, request: PartnershipRequest, add: boolean): Promise<PartnershipDraft> {
  const pageId = pageOf(chosen)
  const ids = await pageIds(chosen, request.pages ?? [], META_FB_LIST_MAX, 'creator Pages')
  const now = await livePartnership({ connectionId: chosen.connectionId, view: 'allowlist' }) as unknown as { creators?: unknown; creatorsNotRead?: unknown }
  if (!Array.isArray(now.creators)) throw new MetaLiveRefusal(`Nexus could not read the allowlisted creators first, so it changes nothing: ${text(now.creatorsNotRead) ?? 'Meta answered no list.'}`)
  const listed = new Set((now.creators as Row[]).map((r) => idText(r.creatorPageId)).filter((id): id is string => !!id))
  const going = ids.filter((id) => listed.has(id) !== add)
  const skipped = ids.filter((id) => listed.has(id) === add).map((id) => `Page ${id} is ${add ? 'already' : 'not'} on the allowlist.`)
  const route = `partnership-ads/fb-branded-content/${pageId}/brand-allowlisted-creators`
  const label = `${add ? 'Add' : 'Take'} ${plural(going.length, 'creator Page')} (${going.join(', ')}) ${add ? 'to' : 'off'} the branded-content allowlist of the chosen Page ${pageId}`
  const operation = add ? 'partnership.fb.allowCreators' : 'partnership.fb.disallowCreators'
  // POST takes {"creator_page_ids":[…]} as its JSON body; DELETE takes ?creator_page_ids=[…] (branded-content-permissions.md).
  const list = `[${going.join(',')}]`
  const call = add ? { operation, pageId, path: route, method: 'POST' as const, body: `{"creator_page_ids":${list}}` } : { operation, pageId, path: route, method: 'DELETE' as const, query: { creator_page_ids: list } }
  const requests: MetaChangeRequest[] = going.length ? [{
    step: 1, label, kind: 'page', objectId: pageId, params: { route, method: call.method, ...(add ? { body: call.body! } : { creator_page_ids: list }) },
    check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, operation,
    send: sendFbList(call, 'creator_page_id'),
    doneSentence: (result) => itemsSentence(label, result),
  }] : []
  return {
    summary: `Meta: ${add ? 'add' : 'take'} ${plural(going.length, 'creator Page')} ${add ? 'to' : 'off'} the chosen Page's branded-content allowlist.`,
    changes: changeLines(going.map((id) => [`Creator Page ${id} on the allowlist`, add ? 'no' : 'yes', add ? 'yes' : 'no'])).changes,
    totals: { pages: going.length, requests: requests.length, ...(skipped.length ? { skipped: skipped.length } : {}) },
    warnings: [
      ...(add ? [] : ['Taking a creator off the allowlist does not remove the branded-content posts that already tag the Page (facebook-untag does).']),
      NOT_ATOMIC, FB_NO_CHECK, SPENDS_NOTHING, FB_ACCESS,
    ],
    spendsMoney: [], skipped, requests,
    stands: { action: request.action, pageId, listed: [...listed].sort(), going },
    before: { kind: 'partnership', action: request.action, pageId, pages: going.map((id) => ({ pageId: id, listed: !add })) },
    after: { kind: 'partnership', action: request.action, pageId, pages: going.map((id) => ({ pageId: id, listed: add })) },
    partnership: { action: request.action, pageId, pages: going },
  }
}

/** CR-362, OT-031 — the Page's sponsor tag removed from branded-content posts that tag it (no undo: the creator re-tags). */
async function fbUntagDraft(chosen: MetaChosenAccount, request: PartnershipRequest): Promise<PartnershipDraft> {
  const pageId = pageOf(chosen)
  const asked = [...new Set((request.postIds ?? []).map((p) => p.trim()))]
  if (!asked.length) throw new MetaLiveRefusal('Name the posts (postIds: as meta-partnership-content view tagged-posts lists them).')
  if (asked.length !== (request.postIds ?? []).length) throw new MetaLiveRefusal('Name each post once.')
  if (asked.length > META_FB_LIST_MAX) throw new MetaLiveRefusal(`At most ${META_FB_LIST_MAX} posts per request.`)
  if (asked.some((id) => !/^\d{1,25}$/.test(id))) throw new MetaLiveRefusal('A post is named by its id (digits), as view tagged-posts lists it.')
  // Step 16's read of the posts that tag the chosen Page: each post must be one of them, by no other Nexus business's Page.
  const now = await livePartnership({ connectionId: chosen.connectionId, view: 'tagged-posts', limit: 500 }) as unknown as { items?: Row[] }
  const posts = new Map((now.items ?? []).map((r) => [idText(r.postId), r] as const))
  for (const id of asked) {
    const row = posts.get(id)
    if (!row) throw new MetaLiveRefusal(`Post ${id} is not among the branded-content posts that tag the chosen Page Nexus reads (the latest 500).`)
    if (row.takenByAnotherBusiness === true) throw new MetaLiveRefusal(`Post ${id} is by a Page another business in Nexus uses: Nexus does not change it.`)
  }
  const route = `partnership-ads/fb-branded-content/${pageId}/branded-content-posts`
  const list = `[${asked.join(',')}]`
  const label = `Remove the chosen Page's sponsor tag from ${plural(asked.length, 'branded-content post')} (${asked.join(', ')})`
  const operation = 'partnership.fb.untagPosts'
  return {
    summary: `Meta: remove the chosen Page's sponsor tag from ${plural(asked.length, 'branded-content post')}.`,
    changes: changeLines(asked.map((id) => [`Post ${id}`, `tags the Page (by ${text(posts.get(id)?.creatorPageName) ?? idText(posts.get(id)?.creatorPageId) ?? 'a creator'})`, 'a generic post (no sponsor tag)'])).changes,
    totals: { posts: asked.length, requests: 1 },
    warnings: [
      'Removing the tag turns each post into a generic Facebook post. Nexus cannot put a tag back (reversibility none): only the creator can tag the Page again.',
      NOT_ATOMIC, FB_NO_CHECK, SPENDS_NOTHING, FB_ACCESS,
    ],
    spendsMoney: [], skipped: [],
    requests: [{
      step: 1, label, kind: 'page', objectId: pageId, params: { route, method: 'DELETE', post_ids: list },
      check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, operation,
      send: sendFbList({ operation, pageId, path: route, method: 'DELETE', query: { post_ids: list } }, 'fb_post_id'),
      doneSentence: (result) => itemsSentence(label, result),
    }],
    stands: { action: request.action, pageId, posts: asked },
    before: { kind: 'partnership', action: request.action, pageId, posts: asked.map((id) => ({ postId: id, tagged: true })) },
    after: { kind: 'partnership', action: request.action, pageId, posts: asked.map((id) => ({ postId: id, tagged: false })) },
    partnership: { action: request.action, pageId, postIds: asked },
  }
}

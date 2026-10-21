/**
 * Meta step 25 (2026-10-21) — create-meta-creative and set-meta-creative as drafts (master rows of step 25: CR-009 … CR-472,
 * MD-005, MD-138, CT-106; facts F1 M5-11 … M5-24, M5-29 … M5-34). Each draft is built from the request and what Meta holds
 * NOW (reads only, through the gateway); the requests carry their own senders (write client → gateway: the write allow-list
 * in gateway/meta-creative-rules.ts, which judges every key of a creative at every depth and checks every id inside it).
 *
 *   create   ONE creative of the chosen ad account (POST /act_<id>/adcreatives — Meta's check, validate_only, first), built
 *            on the business's CHOSEN Page and Instagram account (Nexus fills them; a partnership ad names its partner beside
 *            them). Every creative carries the silent features explicitly: every Advantage+ creative feature Meta documents
 *            OFF unless asked (gateway META_CREATIVE_FEATURES), multi-advertiser ads OFF unless asked; and, by what the
 *            creative does (review B, made fail-safe in round 2: gateway silentKeysFor), no music beside a story, no format
 *            automation and no shop routing wherever a website destination or a catalog part is, automatic product tags on
 *            every image and the reordering of carousel cards OFF unless asked. The run reads the creative back and says what
 *            Meta kept (Meta silently drops an opt-in it finds ineligible; it may also show a feature it switched on itself).
 *            "Was it new?": Meta answers the id of an EXISTING creative for a duplicate (reference/ad-creative "If you try
 *            to add an creative that isn't unique … return the creative ID of the existing ad creative"); an AdCreative has
 *            no created_time (v26 field table), so Nexus reads the creative's own unpublished post (effective_object_story_id)
 *            and its created_time: made by this send = new; older = not new; unreadable = not proven new (never deleted).
 *            async (M5-33): the same creative as Meta's asynchronous job (POST /act_<id>/asyncadcreatives, notification OFF);
 *            the run reads the job's requests and, once Meta made it, the creative like above.
 *   undo     DELETE /<creative id> of a creative an earlier create-meta-creative of this business made NEW (its record says
 *            so), still in the account, and used by no ad (the account's ads are read first: Meta's reference does not say a
 *            used creative can be deleted, F1 M5-32 — Nexus never tries).
 *   set      POST /<creative id>: name, status (ACTIVE only), the whole label list; POST /<creative id>/adlabels: labels
 *            added (M5-31; Meta lets nothing else change on a creative). Its undo puts the old name and labels back.
 *
 * Nothing here spends money: a creative serves only once an ad uses it and that ad, its ad set and its campaign are on (the
 * preview says so). Creatives are immutable: changing one is a new creative swapped onto the ad (set-meta-ad, step 27), and
 * a swap on an ACTIVE ad sends it back to Meta's review (F1 X8). "Show before you spend" (M5-34) is step 10's preview read:
 * meta-ad-preview view creative (the run names it), never a copy here; its links stay on Claude's door.
 */
import prisma from '../../../db.js'
import {
  creativeTypeOf, finishCreative, isJsonCreativeKey, judgeCreativeForm, judgeCreativeKey, META_AI_GENERATED_FEATURES, META_CREATIVE_FEATURES, META_CREATIVE_TEXT,
  metaCreativeTextProblem, newCreativeWalk, partsOptIns, silentKeysToSend, type CreativeType,
} from '../../gateway/meta-creative-rules.js'
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { MetaChangeAccount } from './change-account.js'
import { metaSendChange, MetaWriteError, META_UNKNOWN_OUTCOME, type MetaChangeResult, type MetaWriteTarget } from './write-client.js'
import { localFailure } from './errors.js'
import { metaReadOne } from './read-client.js'
import { metaChosenAccount, MetaLiveRefusal, objectInAccount } from './live.js'
import { pageOf, pagePostId } from './live-media.js'
import { listPaged } from './live-objects.js'

export const CREATIVE_TOOL = 'create-meta-creative'
/** Step 26 — create-meta-boost: a creative of an existing post (marketing/meta-ads/change-boosts.ts), made by this builder. */
export const BOOST_TOOL = 'create-meta-boost'
/** Step 27 — create-meta-ad: an ad whose inline creative it made (marketing/meta-ads/change-ads.ts). */
export const AD_TOOL = 'create-meta-ad'
/**
 * Step 26 — the tools whose records claim a creative made (a creative one of them claims is never "new" to another). Step 27:
 * create-meta-ad claims the inline creative of an ad it made.
 */
export const CREATIVE_RECORD_TOOLS: readonly string[] = [CREATIVE_TOOL, BOOST_TOOL, AD_TOOL]
/**
 * Master CR-207 (review B2) — saved welcome-message flows (`GET/POST/DELETE /{page_id}/welcome_message_flows`, SDK only) are
 * a Page write that needs the Page's own access token (lane question Q1). C2-PAGE-TOKEN: lane C4's step 36 builds the
 * gateway's `auth: 'page'` mode; lane C2 wires these flows to it then. A creative uses a flow by its id already
 * (asset_feed_spec.additional_data.partner_app_welcome_message_flow_id).
 */
export const WELCOME_FLOWS_ANSWER = 'Saved welcome-message flows of the Page (create, list, delete) need the Page\'s own access token, which Nexus does not hold yet: they come with the Page-token mode (step 36). Until then a person makes them in Meta Business Suite; a creative already uses one by its id (assetFeed.additional_data.partner_app_welcome_message_flow_id).'
export const SET_CREATIVE_TOOL = 'set-meta-creative'
/** At most this many creatives taken back per request. */
export const MAX_CREATIVE_UNDO = 10
/** How many of the account's ads the undo reads to see none uses the creative (fail closed past them). */
export const ADS_READ_MAX = 500

/** How the run waits for Meta's async creative job (tests set sleep to resolve at once). */
export const __creativeTiming = {
  pollMs: 5_000,
  polls: 6,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}

// ── the request ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PartnerRequest { pageId?: string | null; instagramId?: string | null; mainIdentity: 'brand' | 'creator' }
export interface CreativeRequest {
  action: 'create' | 'undo' | 'welcome-flow'
  name?: string | null
  /** Meta's object_story_spec without page_id / instagram_user_id (Nexus fills the chosen ones). */
  story?: Record<string, unknown> | null
  /** object_story_id: a post of the chosen Page. */
  postId?: string | null
  /** asset_feed_spec without audios (music is its own argument). */
  assetFeed?: Record<string, unknown> | null
  /** The creative's other keys (url_tags, ad_disclaimer_spec, portrait_customizations, …). */
  parts?: Record<string, unknown> | null
  /** Run on Instagram too, as the chosen Instagram account (default: when one is chosen). */
  withInstagram?: boolean | null
  /** The Advantage+ creative features switched ON (every other one is sent OFF). */
  aiFeatures?: string[]
  /** Per feature: its customizations / action_metadata (Meta's own shape). */
  featureSettings?: Record<string, Record<string, unknown>>
  multiAdvertiser?: boolean | null
  music?: 'off' | 'random' | null
  formatAutomation?: Array<{ format: string; dataSources: string[] }>
  shopDestination?: boolean | null
  /** Review A1 — let Meta tag catalog products on a static image by itself (default: off). */
  autoProductTags?: boolean | null
  /** Review A1 — let Meta reorder a carousel's cards (multi_share_optimized; default: off). */
  carouselAutoOrder?: boolean | null
  partner?: PartnerRequest | null
  async?: boolean | null
  /** undo: the creatives an earlier create-meta-creative made new. */
  creatives?: string[]
  /**
   * Step 26 (create-meta-boost) — an existing post's source and identity, already built (object_story_id; or
   * source_instagram_media_id / instagram_permalink_url / a creator's ad code under object_id, with instagram_user_id or the
   * sponsors): in place of story, postId and partner. Everything else — parts, music, every silent key, the judge — is this
   * builder's, exactly as for a creative of a post of the chosen Page.
   */
  base?: Record<string, unknown> | null
  /** Step 26 — an existing post's destinations (asset_feed_spec optimization_type + call_to_actions); music is named beside them. */
  existingFeed?: Record<string, unknown> | null
  /**
   * Step 27 — built INLINE on a new ad (create-meta-ad): only there may it carry a "message us" footer
   * (asset_feed_spec.message_extensions, master CR-218: Meta answers error 3 for one on the creative edge).
   */
  inlineOnAd?: boolean | null
}

/** What a create made (AgentChange after; undo reads it). Only facts that do not move with time. */
export interface CreativeRecordItem { kind: 'creative'; creativeId: string | null; name: string; new: boolean | null; jobId?: string | null; featuresOn?: string[] }

/** Keys the tool's own arguments own: never through `parts` (the silent features cannot be bypassed). */
const OWN_KEYS: Readonly<Record<string, string>> = {
  name: 'name', object_story_spec: 'story', object_story_id: 'postId', asset_feed_spec: 'assetFeed', instagram_user_id: 'withInstagram',
  degrees_of_freedom_spec: 'aiFeatures (and featureSettings)', contextual_multi_ads: 'multiAdvertiser', format_transformation_spec: 'formatAutomation',
  destination_spec: 'shopDestination', facebook_branded_content: 'partner', instagram_branded_content: 'partner', execution_options: '(Nexus asks Meta\'s check itself)',
  interactive_components_spec: 'autoProductTags',
}

const nowSec = () => Math.floor(Date.now() / 1000)
/**
 * Review A4 — Meta's clock and Nexus's differ by a little: a post made at most this long before the send counts as made by
 * it. Kept to a few seconds on purpose: a duplicate of a creative another request made just before (Meta then answers
 * THAT creative) must not pass as new — Meta's and Nexus's clocks are both network-synced, and the post is made during this
 * very call, so its time is never earlier than the send by more than a small skew.
 */
const CLOCK_SLACK_SEC = 5
const secondsOf = (value: unknown): number | null => {
  const t = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(t) ? Math.floor(t / 1000) : null
}
const idOf = (value: unknown): string | null => (typeof value === 'string' || typeof value === 'number') && /^\d{1,25}$/.test(String(value)) ? String(value) : null
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** Text from a caller, its line breaks as Meta reads them (\n). */
function normalizeText(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n')
  if (Array.isArray(value)) return value.map(normalizeText)
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeText(v)]))
  return value
}
/** A link a caller wrote, in the URL parser's one spelling (the gateway takes one spelling only). */
function normalizeLinks(value: unknown): unknown {
  if (typeof value === 'string' && /^https:\/\//.test(value)) { try { return new URL(value).href } catch { return value } }
  if (Array.isArray(value)) return value.map(normalizeLinks)
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeLinks(v)]))
  return value
}
/** Ids a caller wrote as numbers, as strings (the gateway takes ids as strings). */
const ID_KEYS = new Set(['page_id', 'instagram_user_id', 'video_id', 'original_video_id', 'lead_gen_form_id', 'event_id', 'element_id', 'sponsor_page_id', 'sponsor_id', 'branded_content_sponsor_page_id', 'partner_app_welcome_message_flow_id', 'conversation_template_id', 'flow_id', 'page'])
function stringIds(value: unknown, key = ''): unknown {
  if (typeof value === 'number' && ID_KEYS.has(key) && Number.isSafeInteger(value)) return String(value)
  if (Array.isArray(value)) return value.map((v) => stringIds(v))
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stringIds(v, k)]))
  return value
}
const clean = (value: unknown) => stringIds(normalizeLinks(normalizeText(value)))
/** Step 27 — the same cleaning for a new ad's own JSON parts (create-meta-ad: flexible-format groups). */
export const cleanCreativeJson = clean

// ── the creative ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface BuiltCreative {
  /** The creative's keys as Meta reads them (JSON parts as objects). */
  creative: Record<string, unknown>
  /** The same as form fields (JSON parts as JSON text) — exactly what the gateway judges and sends. */
  params: Record<string, string>
  warnings: string[]
  featuresOn: string[]
  /** Review round 2 — what the creative is, by its main button, and the silent keys it carries (gateway silentKeysFor). */
  type: CreativeType
  silent: ReturnType<typeof silentKeysToSend>
  /** Review A1 — Meta's automatic product tags said for its images (off unless asked; null: no image), and a carousel. */
  productTags: 'on' | 'off' | null
  carousel: boolean
}

/** Build one creative from the request and the business's chosen Page and Instagram account; or why not (no call). */
export function buildCreative(request: CreativeRequest, chosen: { pageId: string; instagramId: string | null }): BuiltCreative | { refusal: string } {
  const name = request.name?.trim() ?? ''
  const nameProblem = metaCreativeTextProblem(name, META_CREATIVE_TEXT.name, 'name')
  if (nameProblem) return { refusal: `Nothing was asked of Meta: ${nameProblem}.` }
  // Step 26 — create-meta-boost hands its source and identity ready-made (base): then no story, postId or partner.
  const base = isObject(request.base) ? request.base : null
  if (base && (request.story || request.postId || request.partner)) return { refusal: 'An existing post\'s creative names its source once (create-meta-boost builds it): no story, postId or partner beside it.' }
  if (!base && !!request.story === !!request.postId) return { refusal: 'Describe the creative by story (Meta\'s object_story_spec: link_data, photo_data, video_data, text_data or template_data) or name an existing post of the chosen Page (postId) — one of them.' }
  const parts = isObject(request.parts) ? clean(request.parts) as Record<string, unknown> : {}
  for (const key of Object.keys(parts)) {
    if (OWN_KEYS[key]) return { refusal: `Nothing was asked of Meta: ${key} is this tool's own argument (${OWN_KEYS[key]}), not a part.` }
  }
  const feed = isObject(request.assetFeed) ? clean(request.assetFeed) as Record<string, unknown> : {}
  if ('audios' in feed) return { refusal: 'Nothing was asked of Meta: music is the argument music (off, or random: Meta picks a track), never asset_feed_spec.audios.' }
  // Step 27 (master CR-218) — a "message us" footer only inline on a new ad (create-meta-ad messageFooter).
  if ('message_extensions' in feed && !request.inlineOnAd) return { refusal: 'Nothing was asked of Meta: a "message us" footer (asset_feed_spec.message_extensions) is made only inline on a new ad — create-meta-ad messageFooter: Meta answers error 3 for a creative made on its own with one.' }
  // The identity: the chosen Page and Instagram account; a partnership ad's partner beside them (CR-320 / CR-321).
  const withIg = request.withInstagram !== false && !!chosen.instagramId
  const partner = request.partner ?? null
  if (partner && !partner.pageId && !partner.instagramId) return { refusal: 'Name the partner\'s Facebook Page (partner.pageId) or Instagram account (partner.instagramId), or both.' }
  let pageId = chosen.pageId
  let igId = base ? (typeof base.instagram_user_id === 'string' ? base.instagram_user_id : null) : withIg ? chosen.instagramId : null
  const branded: Record<string, unknown> = {}
  if (partner?.mainIdentity === 'creator') {
    // Creator as main identity: the creator's Page (else the brand's: then no Facebook delivery) and Instagram account; the
    // business's chosen ones are the sponsors.
    if (!partner.instagramId && !partner.pageId) return { refusal: 'A partnership ad with the creator as main identity names the creator.' }
    if (partner.pageId) { pageId = partner.pageId; branded.facebook_branded_content = { sponsor_page_id: chosen.pageId } }
    if (partner.instagramId) {
      if (!chosen.instagramId) return { refusal: 'A partnership ad with the creator\'s Instagram account as main identity needs this business\'s Instagram account chosen (it is the sponsor).' }
      igId = partner.instagramId
      branded.instagram_branded_content = { sponsor_id: chosen.instagramId }
    }
  } else if (partner) {
    if (partner.pageId) branded.facebook_branded_content = { sponsor_page_id: partner.pageId }
    if (partner.instagramId) branded.instagram_branded_content = { sponsor_id: partner.instagramId }
  }
  const creative: Record<string, unknown> = { name }
  if (base) Object.assign(creative, base)
  else if (request.story) {
    const story = clean(request.story) as Record<string, unknown>
    if (!isObject(story)) return { refusal: 'story is Meta\'s object_story_spec, a JSON object.' }
    for (const [key, mine] of [['page_id', chosen.pageId], ['instagram_user_id', chosen.instagramId]] as const) {
      if (key in story && story[key] !== mine) return { refusal: `Nothing was asked of Meta: Nexus fills story.${key} with the business's chosen ${key === 'page_id' ? 'Facebook Page' : 'Instagram account'} itself (a partnership ad names its partner with partner).` }
    }
    const { page_id: _p, instagram_user_id: _i, ...rest } = story
    creative.object_story_spec = { page_id: pageId, ...(igId ? { instagram_user_id: igId } : {}), ...rest }
  } else {
    let postId: string
    try { postId = pagePostId(chosen.pageId, request.postId!) } catch (err) { return { refusal: err instanceof Error ? err.message : String(err) } }
    creative.object_story_id = postId
    if (igId) creative.instagram_user_id = igId
  }
  Object.assign(creative, parts, branded)
  if (request.shopDestination) return { refusal: `Nothing was asked of Meta: shop routing (WEBSITE_AND_SHOP) needs a Facebook or Instagram shop named (onsite_destinations, Meta's Shops guide), and Nexus cannot confirm a shop is this business's own: it comes with the catalog / commerce steps. Shop routing stays off.` }
  const music = request.music === 'random' ? [{ type: 'random' }] : []
  if (request.postId || base) {
    if (Object.keys(feed).length) return { refusal: 'Nothing was asked of Meta: a creative of an existing post takes no asset feed here (only music, by the argument music).' }
    // No asset feed on an existing post unless music is asked: Meta's music is an asset-feed opt-in, and the post keeps its
    // own media (LIVE-PROBES CR-416p). Step 26 — or Meta's messaging / profile-visit destinations (create-meta-boost
    // existingFeed): then music is named beside them (audios, empty unless asked).
    const destinations = isObject(request.existingFeed) ? clean(request.existingFeed) as Record<string, unknown> : null
    if (destinations) creative.asset_feed_spec = { ...destinations, audios: music }
    else if (music.length) creative.asset_feed_spec = { audios: music }
  } else creative.asset_feed_spec = { ...feed, audios: music }
  // Review A1 — a carousel's card order: Meta reorders the cards by itself (multi_share_optimized, default true) unless told.
  const auto = request.carouselAutoOrder === true
  const story = creative.object_story_spec as Record<string, Record<string, unknown> | undefined> | undefined
  const cards = story?.link_data && Array.isArray(story.link_data.child_attachments)
  if (story?.link_data && 'multi_share_optimized' in story.link_data) return { refusal: 'Nothing was asked of Meta: the card order is the argument carouselAutoOrder (Meta reorders the cards only when it is true), not link_data.multi_share_optimized.' }
  if (cards) story!.link_data = { ...story!.link_data, multi_share_optimized: auto }
  const feedCarousels = (creative.asset_feed_spec as { carousels?: unknown } | undefined)?.carousels
  if (Array.isArray(feedCarousels)) {
    if (feedCarousels.some((c) => isObject(c) && 'multi_share_optimized' in c)) return { refusal: 'Nothing was asked of Meta: the card order is the argument carouselAutoOrder, not carousels[].multi_share_optimized.' }
    ;(creative.asset_feed_spec as Record<string, unknown>).carousels = feedCarousels.map((c) => (isObject(c) ? { ...c, multi_share_optimized: auto } : c))
  }
  // Review round 2 — the silent keys follow what the creative DOES (gateway silentKeysFor, the minimum the gateway requires):
  // a website destination anywhere, a catalog part, images. Round 3 — an existing post gets the shop and format opt-outs too
  // (silentKeysToSend: its own link may lead to a website; the gateway accepts every extra opt-out).
  const silent = silentKeysToSend(creative)
  const type = creativeTypeOf(creative)
  // Review A1 / round 2 — Meta tags catalog products on single and carousel images by itself ("enabled by default"):
  // said explicitly on every creative with images — opt_out unless the request asks (then opt_in).
  if (silent.productTags) creative.interactive_components_spec = { components: [{ type: 'product_tag', enroll_status: request.autoProductTags === true ? 'opt_in' : 'opt_out' }] }
  // The silent features (lane prompt, binding): every documented feature named, OFF unless asked.
  const asked = [...new Set(request.aiFeatures ?? [])]
  const unknown = asked.filter((f) => !META_CREATIVE_FEATURES.includes(f))
  if (unknown.length) return { refusal: `Nothing was asked of Meta: ${unknown.join(', ')} ${unknown.length === 1 ? 'is not an' : 'are not'} Advantage+ creative feature${unknown.length === 1 ? '' : 's'} Meta documents.` }
  const settings = isObject(request.featureSettings) ? request.featureSettings : {}
  for (const key of Object.keys(settings)) if (!asked.includes(key)) return { refusal: `Nothing was asked of Meta: featureSettings.${key} goes only with ${key} in aiFeatures (a feature switched on).` }
  creative.degrees_of_freedom_spec = {
    creative_features_spec: Object.fromEntries(META_CREATIVE_FEATURES.map((f) => [f, { enroll_status: asked.includes(f) ? 'OPT_IN' : 'OPT_OUT', ...(asked.includes(f) && isObject(settings[f]) ? { customizations: settings[f] } : {}) }])),
  }
  creative.contextual_multi_ads = { enroll_status: request.multiAdvertiser ? 'OPT_IN' : 'OPT_OUT' }
  const formats = new Map((request.formatAutomation ?? []).map((f) => [f.format, f.dataSources]))
  for (const f of formats.keys()) {
    if (!silent.formats?.includes(f)) return { refusal: `Nothing was asked of Meta: Meta documents format automation ${f} ${silent.formats ? `for this creative only as ${silent.formats.join(', ')}` : 'for creatives with a website destination or a catalog part, and this one has neither'}.` }
  }
  if (silent.formats) creative.format_transformation_spec = silent.formats.map((format) => ({ format, data_source: formats.get(format)?.length ? formats.get(format) : ['none'] }))
  if (silent.destination) creative.destination_spec = { destination_type: 'WEBSITE_AND_SHOP_OPT_OUT' }
  // THE judge (gateway/meta-creative-rules.ts): every key at every depth, cleaned; then the ids and the silent features.
  const walk = newCreativeWalk(!!igId)
  const judged: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(creative)) {
    const out = judgeCreativeKey(key, value, walk)
    if ('problem' in out) return { refusal: `Nothing was asked of Meta: ${out.problem}.` }
    judged[key] = out.value
  }
  const finished = finishCreative(judged, walk)
  if ('problem' in finished) return { refusal: `Nothing was asked of Meta: ${finished.problem}.` }
  const params = Object.fromEntries(Object.entries(judged).map(([k, v]) => [k, isJsonCreativeKey(k) ? JSON.stringify(v) : String(v)]))
  // What the gateway will judge is exactly this (one spelling): checked here too, so a preview never promises what it refuses.
  const gateway = judgeCreativeForm(new Map(Object.entries(params)))
  if ('problem' in gateway) return { refusal: `Nothing was asked of Meta: ${gateway.problem}.` }
  return { creative: judged, params, warnings: finished.warnings, featuresOn: asked, type, silent, productTags: silent.productTags ? (request.autoProductTags === true ? 'on' : 'off') : null, carousel: !!cards || Array.isArray(feedCarousels) }
}

/** The plain-text parts of a creative a person reads, for Meta's length advice (F1: headline ≤25, text ≤90 recommended). */
function textAdvice(creative: Record<string, unknown>, instagram: boolean): string[] {
  const out: string[] = []
  const story = (creative.object_story_spec ?? {}) as Record<string, Record<string, unknown> | undefined>
  const data = story.link_data ?? story.video_data ?? story.photo_data ?? story.text_data ?? null
  const message = typeof data?.message === 'string' ? data.message : typeof data?.caption === 'string' && story.photo_data ? data.caption : null
  const headline = typeof data?.name === 'string' ? data.name : typeof data?.title === 'string' ? data.title : null
  if (headline && [...headline].length > 25) out.push(`Meta recommends a headline of up to 25 characters (this one has ${[...headline].length}); longer ones may be cut off on some placements.`)
  if (message && [...message].length > 90) out.push(`Meta recommends a primary text of up to 90 characters (this one has ${[...message].length}); longer ones show "See more".`)
  if (instagram && message) {
    if ([...message].length > 2200) out.push('Instagram takes at most 2,200 characters of text: this text is longer, and Meta may refuse it for Instagram.')
    if ((message.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > 30) out.push('Instagram (and Threads) take at most 30 hashtags per ad.')
    if (/https?:\/\//.test(message)) out.push('Links in the text are not clickable on Instagram (the button carries the link).')
  }
  return out
}

// ── create: the run ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the run reads back of a creative (Meta: "To confirm the final configuration, use a GET request") — review A6: the
 * silent keys too (destination_spec, format_transformation_spec, the music in asset_feed_spec, the product tags in
 * interactive_components_spec, the carousel order in object_story_spec).
 */
export const CREATIVE_READ_BACK = 'id,name,status,object_story_id,effective_object_story_id,object_story_spec,degrees_of_freedom_spec,contextual_multi_ads,asset_feed_spec,format_transformation_spec,destination_spec,interactive_components_spec,effective_authorization_category'

/** The features a creative reads back as ON. */
function featuresOn(node: Record<string, unknown> | null): string[] {
  const spec = (node?.degrees_of_freedom_spec as { creative_features_spec?: Record<string, { enroll_status?: unknown }> } | undefined)?.creative_features_spec ?? {}
  return Object.entries(spec).filter(([, v]) => v?.enroll_status === 'OPT_IN').map(([k]) => k).sort()
}

/** Is this creative id already claimed by another record of this business (an earlier create, not undone)? */
async function claimedBefore(creativeId: string, adAccountId: string): Promise<boolean> {
  try {
    const rows = await prisma.agentChange.findMany({
      // Step 26 — a creative create-meta-boost claims is claimed too (and the other way round).
      where: { toolName: { in: [...CREATIVE_RECORD_TOOLS] }, undoneAt: null, after: { path: ['items'], array_contains: [{ creativeId }] } },
      select: { id: true, after: true },
      take: 20,
    })
    return rows.some((r) => (r.after as { adAccountId?: unknown } | null)?.adAccountId === adAccountId)
  } catch {
    // Not proven otherwise: count it as claimed (never new, never deleted by an undo).
    return true
  }
}

/**
 * Was the creative NEW (made by this send)? An AdCreative has no created_time, so its own unpublished post's created_time:
 * made since the send (within CLOCK_SLACK_SEC) = new. Review A4 — NOT new when Meta reads back another name than the one
 * sent (a duplicate answers the existing creative, with its own name), when another record of this business (not undone)
 * already claims this creative id, or when the post is older. A creative of an existing post (object_story_id), or a post
 * Nexus cannot read = not proven new. Only `true` lets an undo delete it.
 */
/**
 * How a send knows what it made. Step 26 — `before`: the ids of the ad account's creatives read just before the send (the
 * whole list, or null when it is longer than Nexus reads): a creative of an existing post has no new post of its own, so it
 * is new only when Meta answers an id that was NOT there before (Meta answers the existing creative for a duplicate).
 */
export interface MadeCreative { name: string; fromExistingPost: boolean; before?: ReadonlySet<string> | null }

async function creativeWasNew(target: MetaWriteTarget, creativeId: string, node: Record<string, unknown>, sentAt: number, made: MadeCreative): Promise<boolean | null> {
  if (typeof node.name === 'string' && node.name !== made.name) return false
  if (await claimedBefore(creativeId, target.adAccountId)) return false
  if (made.fromExistingPost) return made.before ? !made.before.has(creativeId) : null
  const post = typeof node.effective_object_story_id === 'string' && /^\d{1,25}_\d{1,25}$/.test(node.effective_object_story_id) ? node.effective_object_story_id : null
  if (!post) return null
  try {
    const read = await metaReadOne<{ created_time?: unknown }>({ connectionId: target.connectionId }, { operation: 'creative.newCheck', path: post, query: { fields: 'id,created_time' } })
    const created = secondsOf(read.body.created_time)
    return created === null ? null : created >= sentAt - CLOCK_SLACK_SEC
  } catch {
    return null
  }
}

/** One creative read back (the fields of CREATIVE_READ_BACK), or null. */
async function readCreative(target: MetaWriteTarget, creativeId: string): Promise<Record<string, unknown> | null> {
  try {
    const read = await metaReadOne<Record<string, unknown>>({ connectionId: target.connectionId }, { operation: 'creative.readBack', path: creativeId, query: { fields: CREATIVE_READ_BACK } })
    return isObject(read.body) ? read.body : null
  } catch {
    return null
  }
}

/** Review A6 — the silent keys as Meta reads them back (null: not sent back). */
function silentRead(read: Record<string, unknown>) {
  const feed = read.asset_feed_spec as { audios?: unknown } | undefined
  const formats = Array.isArray(read.format_transformation_spec) ? (read.format_transformation_spec as Array<{ format?: unknown; data_source?: unknown }>) : null
  const components = (read.interactive_components_spec as { components?: Array<{ type?: unknown; enroll_status?: unknown }> } | undefined)?.components
  const link = ((read.object_story_spec as { link_data?: Record<string, unknown> } | undefined)?.link_data) ?? null
  return {
    destination: (read.destination_spec as { destination_type?: unknown } | undefined)?.destination_type ?? null,
    formatsOn: formats ? formats.filter((f) => !(Array.isArray(f.data_source) && f.data_source.length === 1 && f.data_source[0] === 'none')).map((f) => String(f.format)) : null,
    music: feed && 'audios' in feed ? (Array.isArray(feed.audios) && feed.audios.length > 0) : null,
    productTags: Array.isArray(components) ? (components.find((c) => c.type === 'product_tag')?.enroll_status ?? null) : null,
    carouselAutoOrder: link && typeof link.multi_share_optimized === 'boolean' ? link.multi_share_optimized : null,
  }
}

/**
 * The run's node of a creative Meta made: its id, "was it new?", what Meta kept of the features asked, and what else. Step 27:
 * create-meta-ad says the same of the inline creative of a new ad.
 */
export async function madeNode(target: MetaWriteTarget, creativeId: string, node: Record<string, unknown> | null, sentAt: number, asked: string[], made: MadeCreative, jobId: string | null = null) {
  const read = node && 'degrees_of_freedom_spec' in node ? node : (await readCreative(target, creativeId)) ?? node ?? {}
  const on = featuresOn(read)
  const generated = Array.isArray((read.asset_feed_spec as { bodies?: unknown } | undefined)?.bodies) ? ((read.asset_feed_spec as { bodies: unknown[] }).bodies.length) : 0
  return {
    creativeId,
    jobId,
    new: await creativeWasNew(target, creativeId, read, sentAt, made),
    name: typeof read.name === 'string' ? read.name : null,
    status: typeof read.status === 'string' ? read.status : null,
    featuresRead: 'degrees_of_freedom_spec' in read,
    featuresOn: on,
    droppedByMeta: asked.filter((f) => !on.includes(f)),
    onWithoutAsking: on.filter((f) => !asked.includes(f)),
    multiAdvertiser: (read.contextual_multi_ads as { enroll_status?: unknown } | undefined)?.enroll_status ?? null,
    ...silentRead(read),
    authorization: typeof read.effective_authorization_category === 'string' ? read.effective_authorization_category : null,
    bodiesInFeed: generated,
  }
}

/**
 * The sender of ONE creative on the chosen account's creative edge (create-meta-creative; step 26: create-meta-boost too):
 * sent, read back, "was it new?". `knownBefore` (step 26): read the account's creatives just before the send (MadeCreative).
 */
export function sendCreate(act: string, params: Record<string, string>, asked: string[], made: MadeCreative & { knownBefore?: (target: MetaWriteTarget) => Promise<ReadonlySet<string> | null> }) {
  return async (target: MetaWriteTarget): Promise<MetaChangeResult> => {
    const operation = 'creative.create'
    const before = made.knownBefore ? await made.knownBefore(target).catch(() => null) : undefined
    const sentAt = nowSec()
    const result = await metaSendChange(target, { objectId: act, kind: 'adaccount', params, operation, edge: 'adcreatives', readBackFields: CREATIVE_READ_BACK, timeoutMs: 120_000 })
    const creativeId = idOf(result.node?.id)
    if (!creativeId) throw new MetaWriteError(localFailure(`Meta answered the creative without an id, so Nexus cannot say what it made. ${META_UNKNOWN_OUTCOME}`, 'NO_CREATIVE_ID'), operation, 'unknown')
    return { node: await madeNode(target, creativeId, result.node, sentAt, asked, { name: made.name, fromExistingPost: made.fromExistingPost, ...(before !== undefined ? { before } : {}) }), readBack: result.readBack, waitedMs: result.waitedMs }
  }
}

/** M5-33 — the async job: sent, then its requests read until Meta names the creative it made (or the polls run out). */
function sendAsync(act: string, params: Record<string, string>, asked: string[], made: MadeCreative) {
  return async (target: MetaWriteTarget): Promise<MetaChangeResult> => {
    const operation = 'creative.async'
    const sentAt = nowSec()
    const result = await metaSendChange(target, { objectId: act, kind: 'adaccount', params, operation, edge: 'asyncadcreatives', readBackFields: 'id,name,is_completed,success_count,error_count,total_count' })
    const jobId = idOf(result.node?.id)
    if (!jobId) throw new MetaWriteError(localFailure(`Meta answered the async job without an id, so Nexus cannot follow it. ${META_UNKNOWN_OUTCOME}`, 'NO_JOB_ID'), operation, 'unknown')
    let creativeId: string | null = null
    let state: string | null = null
    for (let i = 0; i < __creativeTiming.polls && !creativeId; i++) {
      await __creativeTiming.sleep(__creativeTiming.pollMs)
      try {
        const read = await metaReadOne<{ data?: Array<{ status?: unknown; result?: unknown }> }>({ connectionId: target.connectionId }, { operation: 'creative.asyncRead', path: `${jobId}/requests`, query: { fields: 'id,status,result' } })
        const row = read.body.data?.[0]
        state = typeof row?.status === 'string' ? row.status : state
        creativeId = idOf((row?.result as { id?: unknown } | undefined)?.id) ?? idOf((row?.result as { creative_id?: unknown } | undefined)?.creative_id)
        if (state && /ERROR|CANCELED/.test(state)) break
      } catch { /* read again */ }
    }
    if (!creativeId) {
      return { node: { creativeId: null, jobId, new: null, status: state, featuresOn: [], droppedByMeta: [], onWithoutAsking: [], featuresRead: false, multiAdvertiser: null, authorization: null, bodiesInFeed: 0 }, readBack: 'none', waitedMs: result.waitedMs }
    }
    return { node: await madeNode(target, creativeId, null, sentAt, asked, made, jobId), readBack: 'second-read', waitedMs: result.waitedMs }
  }
}

const newWords = (isNew: unknown) => (isNew === true
  ? 'new in the ad account (its undo may delete it while no ad uses it)'
  : isNew === false
    ? 'Meta answered an existing creative or post (a duplicate): nothing new was made, and its undo never deletes it'
    : 'not proven new (its undo never deletes it)')

/** The step's sentence once Meta made it: the id, "was it new?", the features Meta kept, and what to do next. */
export function createdSentence(label: string, node: Record<string, unknown> | null): string {
  const n = (node ?? {}) as {
    creativeId?: string | null; jobId?: string | null; status?: string | null; new?: unknown; featuresRead?: boolean; featuresOn?: string[]; droppedByMeta?: string[]; onWithoutAsking?: string[]; multiAdvertiser?: unknown; authorization?: string | null
    destination?: unknown; formatsOn?: string[] | null; music?: boolean | null; productTags?: unknown; carouselAutoOrder?: boolean | null
  }
  if (!n.creativeId) return `${label}: Meta took the async job ${n.jobId ?? '?'}${n.status ? ` (${n.status})` : ''} but has not named the creative yet; meta-ad-details view creatives shows it once made. Nexus cannot prove it new, so its undo never deletes it.`
  const parts = [
    `${label}: Meta made creative ${n.creativeId}${n.status ? ` (${n.status})` : ''}; ${newWords(n.new)}.`,
    n.featuresRead === false ? 'Nexus could not read its Advantage+ features back (meta-ad-details view creative shows them).'
      : n.featuresOn?.length ? `Advantage+ features Meta has ON: ${n.featuresOn.join(', ')}.` : 'Meta has every Advantage+ creative feature OFF.',
    n.droppedByMeta?.length ? `Meta dropped ${n.droppedByMeta.join(', ')} as ineligible for this creative (it does so silently).` : '',
    n.onWithoutAsking?.length ? `WARNING: Meta has ${n.onWithoutAsking.join(', ')} ON although Nexus did not ask for ${n.onWithoutAsking.length === 1 ? 'it' : 'them'} — make the creative again without ${n.onWithoutAsking.length === 1 ? 'it' : 'them'} if that is not wanted.` : '',
    n.multiAdvertiser === 'OPT_IN' ? 'Multi-advertiser ads: ON.' : '',
    // Review A6 — the other silent keys as Meta reads them back (only what it sent back is said).
    n.formatsOn?.length ? `Format automation Meta has ON: ${n.formatsOn.join(', ')}.` : '',
    n.music === true ? 'Music: ON.' : '',
    typeof n.destination === 'string' && n.destination !== 'WEBSITE_AND_SHOP_OPT_OUT' ? `Shop routing reads ${n.destination}.` : '',
    n.productTags === 'opt_out' ? 'Automatic product tags: off.' : '',
    n.carouselAutoOrder === true ? 'Meta may reorder the carousel cards (multi_share_optimized).' : '',
    n.authorization && n.authorization !== 'NONE' ? `Meta classes it as ${n.authorization} (effective_authorization_category): an ad with it will not run in the EU.` : '',
    `See it before it spends: meta-ad-preview view creative creativeId ${n.creativeId} (Claude only; links are public for 24 h).`,
  ]
  return parts.filter(Boolean).join(' ')
}

/**
 * What a person reads about a creative before approving it: it spends nothing, it cannot change once made, and EVERY silent
 * key it carries (each feature, multi-advertiser ads, music, format automation, shop routing, product tags, card order, any
 * opt-in in its own parts). Step 26 — create-meta-boost says the same of a creative of an existing post (never a copy).
 */
export function creativeWarnings(built: BuiltCreative, request: CreativeRequest, opts: { async?: boolean; instagram: boolean }): string[] {
  const asked = built.featuresOn
  const async = opts.async === true
  const instagram = opts.instagram
  const ai = asked.filter((f) => META_AI_GENERATED_FEATURES.has(f))
  const silent = built.silent
  const optIns = partsOptIns(built.creative)
  return [
    'A creative spends nothing: it serves only once an ad uses it (create-meta-ad) and that ad, its ad set and its campaign are on.',
    'Creatives cannot be changed once made (Meta lets only their name, labels and status change: set-meta-creative): a change is a new creative swapped onto the ad, and a swap on an ACTIVE ad sends that ad back to Meta\'s review.',
    asked.length
      ? `Advantage+ creative features switched ON at your request: ${asked.join(', ')}. Every other one of the ${META_CREATIVE_FEATURES.length} features Meta documents is sent OFF. Meta drops an opt-in it finds ineligible without a word: the run reads the creative back and says what Meta kept.`
      : `Every one of the ${META_CREATIVE_FEATURES.length} Advantage+ creative features Meta documents is sent OFF (Meta switches some on by default otherwise: adapt_to_placement, inline_comment, description_automation); the run reads the creative back and says what Meta has.`,
    ...ai.map((f) => `${f} is generated with AI: an ad using this creative must be created PAUSED and previewed first (meta-ad-preview view ad or creative, creativeFeature ${f}) and only then switched on — Meta's rule; create-meta-ad enforces it.`),
    request.multiAdvertiser ? 'Multi-advertiser ads: ON at your request (Meta may show this ad next to other advertisers\' ads).' : 'Multi-advertiser ads: OFF (contextual_multi_ads OPT_OUT; Meta opts a creative in when it is not said).',
    `A ${built.type} creative${silent.destination ? ' with a website destination or catalog part' : ''}: Nexus says each silent key it carries — every Advantage+ feature and multi-advertiser ads${silent.audios ? ', music' : ''}${silent.formats ? ', format automation' : ''}${silent.destination ? ', shop routing' : ''}${silent.productTags ? ', automatic product tags' : ''}.`,
    request.music === 'random' ? 'Music: Meta adds a track of its choice (asset_feed_spec.audios random).' : silent.audios || request.existingFeed ? 'Music: none (asset_feed_spec.audios empty, Meta\'s way to opt out).' : 'Music: none (an existing post keeps its own media; no asset feed is sent).',
    ...(silent.formats ? [(request.formatAutomation ?? []).length ? `Format automation ON at your request: ${(request.formatAutomation ?? []).map((f) => `${f.format} from ${f.dataSources.join(', ')}`).join('; ')}; every other format (${silent.formats.join(', ')}) is sent with data_source none.` : `Format automation: none (${silent.formats.join(', ')} each sent with data_source none).`] : []),
    ...(silent.destination ? ['Shop routing: OFF (destination_spec WEBSITE_AND_SHOP_OPT_OUT; v26 sends an eligible creative to the shop by itself otherwise).'] : []),
    ...(built.productTags === 'off' ? ['Automatic product tags: OFF (interactive_components_spec product_tag opt_out; Meta tags catalog products on single and carousel images by itself otherwise — autoProductTags switches it on).'] : built.productTags === 'on' ? ['Automatic product tags: ON at your request (product_tag opt_in: Meta may tag catalog products on the images by itself).'] : []),
    ...(built.carousel ? [request.carouselAutoOrder ? 'Carousel order: Meta may reorder the cards at your request (multi_share_optimized true).' : 'Carousel order: as given (multi_share_optimized false; Meta reorders the cards by itself otherwise — carouselAutoOrder switches it on).'] : []),
    ...(optIns.length ? [`Opt-ins inside the creative's own parts, at your request: ${optIns.join('; ')}.`] : []),
    ...(request.partner ? ['A partnership ad needs the partner\'s permission: without it Meta keeps the ad "pending delivery" and Meta itself sends the partner a permission request.'] : []),
    'If Meta already holds the same creative, it answers that one\'s id: nothing new is made then, and the undo never deletes it.',
    ...(async ? ['Meta makes it in the background (asyncadcreatives; Meta has no check for that edge): the run reads the job and says the creative it made. A creative Nexus did not read back is never deleted by the undo.'] : []),
    // Master CR-445 (asset-feed-spec/multi-language-ads): Meta's automatic translation starts only from these languages.
    ...(Array.isArray((built.creative.asset_feed_spec as { autotranslate?: unknown } | undefined)?.autotranslate) ? ['Meta\'s automatic translation starts only from English, German, Arabic, Hebrew, Spanish, Japanese, Norwegian, French, Dutch or Swedish (a non-English source only into English): Italian text cannot be its source. Edits to a translated copy are dropped while its language stays in autotranslate.'] : []),
    ...textAdvice(built.creative, instagram),
    ...built.warnings,
  ]
}

export interface CreativeDraft extends MetaChangeDraft {
  creative: { action: 'create' | 'undo' | 'set'; name?: string; featuresOn?: string[]; async?: boolean }
}

async function createDraft(account: MetaChangeAccount, request: CreativeRequest): Promise<CreativeDraft | { refusal: string }> {
  const chosen = await metaChosenAccount(account.accountId)
  const pageId = pageOf(chosen)
  const built = buildCreative(request, { pageId, instagramId: chosen.instagramId })
  if ('refusal' in built) return built
  const act = `act_${account.adAccountId}`
  const name = String(built.creative.name)
  const asked = built.featuresOn
  const async = request.async === true
  const fromExistingPost = !!request.postId
  const params: Record<string, string> = async
    ? { name: `Nexus: ${name}`.slice(0, META_CREATIVE_TEXT.name), creative_spec: JSON.stringify(built.creative), notification_mode: 'OFF' }
    : built.params
  const instagram = !!(built.creative.object_story_spec as { instagram_user_id?: unknown } | undefined)?.instagram_user_id || !!built.creative.instagram_user_id
  const label = `Create creative "${name}" in ad account ${act}${async ? ' as Meta\'s async job' : ''}`
  const request1: MetaChangeRequest = {
    step: 1, label, kind: 'ad', objectKind: 'adaccount', objectId: act, params,
    // Meta documents validate_only on POST /act_<id>/adcreatives (reference/ad-account/adcreatives), not on asyncadcreatives.
    check: async ? 'none' : 'meta', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
    // Each edge spelled as itself (no request builder computes its edge: step 21's pin).
    ...(async ? { operation: 'creative.async', edge: 'asyncadcreatives' as const } : { operation: 'creative.create', edge: 'adcreatives' as const }),
    send: async ? sendAsync(act, params, asked, { name, fromExistingPost }) : sendCreate(act, params, asked, { name, fromExistingPost }),
    doneSentence: (result) => createdSentence(label, result.node),
  }
  const warnings = creativeWarnings(built, request, { async, instagram })
  const identity = request.partner ? `partnership (${request.partner.mainIdentity === 'creator' ? 'the creator as main identity, this business as sponsor' : 'this business as main identity, the partner as sponsor'})` : instagram ? 'the chosen Facebook Page and Instagram account' : 'the chosen Facebook Page'
  const { changes } = changeLines([
    [`Creative "${name}"`, 'not in the ad account', 'made (Meta answers its id)'],
    ['Runs as', '—', identity],
    ['Advantage+ creative features ON', '—', asked.length ? asked.join(', ') : 'none'],
  ])
  return {
    summary: `Meta: create creative "${name}" in ad account ${act} (a creative spends nothing).`,
    changes, totals: { creatives: 1, requests: 1, featuresOn: asked.length },
    warnings, spendsMoney: [], skipped: [], requests: [request1],
    stands: { action: 'create', adAccountId: account.adAccountId, pageId, instagramId: chosen.instagramId },
    before: { kind: 'create', items: [] },
    after: { kind: 'create', items: [{ kind: 'creative', name }] },
    creative: { action: 'create', name, featuresOn: asked, async },
  }
}

// ── undo: take back a creative a create made new ────────────────────────────────────────────────────────────────────

/** The change record of THIS business that made this creative NEW in this ad account (not undone), or null (RLS). */
async function recordOf(creativeId: string, adAccountId: string, tool: string): Promise<string | null> {
  const rows = await prisma.agentChange.findMany({
    where: { toolName: tool, undoneAt: null, after: { path: ['items'], array_contains: [{ creativeId, new: true }] } },
    select: { id: true, after: true },
    take: 20,
  })
  return rows.find((r) => (r.after as { adAccountId?: unknown } | null)?.adAccountId === adAccountId)?.id ?? null
}

/** Every ad status but DELETED (an archived ad still uses its creative). Step 27: an ad set's ads are counted with it. */
export const AD_STATUSES_BUT_DELETED = ['ACTIVE', 'PAUSED', 'PENDING_REVIEW', 'DISAPPROVED', 'PREAPPROVED', 'PENDING_BILLING_INFO', 'CAMPAIGN_PAUSED', 'ARCHIVED', 'ADSET_PAUSED', 'IN_PROCESS', 'WITH_ISSUES']

/**
 * The undo of a create: delete the creatives a create of THIS tool (create-meta-creative; step 26: create-meta-boost) made NEW
 * in this ad account, still there and used by no ad. Its own records only: a tool never deletes what the other one made.
 */
export async function creativeUndoDraft(account: MetaChangeAccount, ids: string[], tool: string = CREATIVE_TOOL): Promise<CreativeDraft | { refusal: string }> {
  if (!ids.length) return { refusal: 'Name the creatives to take back (creatives: their ids).' }
  if (ids.length > MAX_CREATIVE_UNDO) return { refusal: `At most ${MAX_CREATIVE_UNDO} creatives per request.` }
  if (new Set(ids).size !== ids.length) return { refusal: 'Name each creative once.' }
  const chosen = await metaChosenAccount(account.accountId)
  const act = `act_${account.adAccountId}`
  const refusals: string[] = []
  for (const id of ids) {
    if (!(await recordOf(id, account.adAccountId, tool))) refusals.push(`creative ${id} is not one a ${tool} of this business made new in ad account ${act} (Nexus deletes only that: never a creative it did not make, and never one Meta answered as a duplicate).`)
  }
  if (refusals.length) return { refusal: `Nothing was asked of Meta: ${refusals.join(' ')}` }
  const statuses = new Map<string, string | null>()
  for (const id of ids) {
    await objectInAccount(chosen, id, 'creative', 'creative.ownerCheck')
    const read = await metaReadOne<{ status?: unknown }>({ connectionId: account.target.connectionId }, { operation: 'creative.statusRead', path: id, query: { fields: 'id,status' } })
    statuses.set(id, typeof read.body.status === 'string' ? read.body.status : null)
  }
  // F1 M5-32 — Meta does not say a creative an ad uses can be deleted: Nexus reads the account's ads and never tries.
  const ads = await listPaged(account.target.connectionId, 'creative.adsRead', `${act}/ads`, { fields: 'id,creative{id}', effective_status: AD_STATUSES_BUT_DELETED }, ADS_READ_MAX)
  const usedBy = (id: string) => ads.rows.filter((r) => idOf((r.creative as { id?: unknown } | undefined)?.id) === id).map((r) => String(r.id ?? '?'))
  const skipped: string[] = []
  const going: string[] = []
  for (const id of ids) {
    if (statuses.get(id) === 'DELETED') { skipped.push(`Creative ${id} is already deleted.`); continue }
    const users = usedBy(id)
    if (users.length) { skipped.push(`Creative ${id} stays: ad${users.length === 1 ? '' : 's'} ${users.slice(0, 5).join(', ')} use${users.length === 1 ? 's' : ''} it (swap another creative onto ${users.length === 1 ? 'it' : 'them'} first with set-meta-ad).`); continue }
    if (ads.more) { skipped.push(`Creative ${id} stays: the ad account has more than ${ADS_READ_MAX} ads, so Nexus cannot confirm no ad uses it.`); continue }
    going.push(id)
  }
  if (!going.length) return { refusal: `Nothing to take back: ${skipped.join(' ')}` }
  const requests: MetaChangeRequest[] = going.map((id, i) => {
    const label = `Delete creative ${id} (made new by Nexus) from ad account ${act}`
    return {
      step: i + 1, label, kind: 'ad', objectKind: 'creative', objectId: id, params: {},
      check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
      // Step 22's creative.delete rule (meta-remove-rules.ts): the same DELETE remove-meta-ads-items sends on a person's ask.
      operation: 'creative.delete', method: 'DELETE',
      doneSentence: () => `${label}: Meta deleted it.`,
    }
  })
  return {
    summary: `Meta: delete ${going.length} creative${going.length === 1 ? '' : 's'} Nexus made new in ad account ${act}.`,
    changes: changeLines(going.map((id) => [`Creative ${id}`, 'in the ad account, used by no ad', 'deleted'])).changes,
    totals: { delete: going.length, requests: requests.length, ...(skipped.length ? { stays: skipped.length } : {}) },
    warnings: [
      `Meta has no check for a delete (its DELETE /<creative id> lists no validate_only), and a deleted creative is final: Nexus cannot put it back (make it again with ${tool}).`,
      'A creative an ad uses stays (Nexus reads the account\'s ads first). A delete spends nothing.',
    ],
    spendsMoney: [], skipped, requests,
    stands: { action: 'undo', adAccountId: account.adAccountId, going, statuses: going.map((id) => statuses.get(id) ?? null) },
    before: { kind: 'undo', items: going.map((creativeId) => ({ kind: 'creative', creativeId, present: true })) },
    after: { kind: 'undo', items: going.map((creativeId) => ({ kind: 'creative', creativeId, deleted: true })) },
    creative: { action: 'undo' },
  }
}

/** The draft of one create-meta-creative request, from what Meta holds now (reads only). */
export async function creativeDraft(account: MetaChangeAccount, request: CreativeRequest): Promise<CreativeDraft | { refusal: string }> {
  try {
    return request.action === 'undo' ? await creativeUndoDraft(account, request.creatives ?? []) : await createDraft(account, request)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

// ── set-meta-creative ───────────────────────────────────────────────────────────────────────────────────────────────

export interface SetCreativeRequest { creativeId: string; name?: string | null; status?: 'ACTIVE' | null; labels?: string[] | null; addLabels?: string[] | null }
export interface CreativeState { creativeId: string; name: string | null; status: string | null; labels: string[] }

const labelProblem = (names: string[]): string | null => {
  for (const name of names) {
    const p = metaCreativeTextProblem(name, META_CREATIVE_TEXT.label, `label "${name.slice(0, 40)}"`)
    if (p) return p
  }
  return new Set(names).size === names.length ? null : 'name each label once'
}

export async function setCreativeDraft(account: MetaChangeAccount, request: SetCreativeRequest): Promise<CreativeDraft | { refusal: string }> {
  try {
    const chosen = await metaChosenAccount(account.accountId)
    const id = await objectInAccount(chosen, request.creativeId, 'creative', 'creative.ownerCheck')
    const read = await metaReadOne<{ name?: unknown; status?: unknown; adlabels?: { data?: Array<{ name?: unknown }> } | Array<{ name?: unknown }> }>({ connectionId: account.target.connectionId }, { operation: 'creative.read', path: id, query: { fields: 'id,name,status,adlabels{name}' } })
    const rows = Array.isArray(read.body.adlabels) ? read.body.adlabels : read.body.adlabels?.data ?? []
    const now: CreativeState = { creativeId: id, name: typeof read.body.name === 'string' ? read.body.name : null, status: typeof read.body.status === 'string' ? read.body.status : null, labels: rows.map((l) => (typeof l?.name === 'string' ? l.name : '')).filter(Boolean) }
    if (now.status === 'DELETED') return { refusal: `Creative ${id} is deleted: Meta lets only its name change, and Nexus changes nothing on it.` }
    const name = request.name?.trim() || null
    if (name) { const p = metaCreativeTextProblem(name, META_CREATIVE_TEXT.name, 'name'); if (p) return { refusal: `Nothing was asked of Meta: ${p}.` } }
    const labels = request.labels ? request.labels.map((l) => l.trim()) : null
    const adds = request.addLabels ? request.addLabels.map((l) => l.trim()) : null
    if (labels && adds) return { refusal: 'Give labels (the whole list, replacing) or addLabels (added), not both.' }
    const lp = labelProblem(labels ?? adds ?? [])
    if (lp) return { refusal: `Nothing was asked of Meta: ${lp}.` }
    const skipped: string[] = []
    const params: Record<string, string> = {}
    const expect: Record<string, string> = {}
    if (name && name !== now.name) { params.name = name; expect.name = name } else if (name) skipped.push(`Creative ${id} is already named "${name}".`)
    if (request.status && request.status !== now.status) { params.status = request.status; expect.status = request.status } else if (request.status) skipped.push(`Creative ${id} is already ${request.status}.`)
    const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i])
    if (labels && !sameList(labels, now.labels)) params.adlabels = JSON.stringify(labels.map((n) => ({ name: n })))
    else if (labels) skipped.push(`Creative ${id} already has exactly these labels.`)
    const newAdds = (adds ?? []).filter((l) => !now.labels.includes(l))
    if (adds && !newAdds.length) skipped.push(`Creative ${id} already has ${adds.length === 1 ? 'that label' : 'those labels'}.`)
    const requests: MetaChangeRequest[] = []
    const label = `creative ${id}${now.name ? ` "${now.name}"` : ''}`
    if (Object.keys(params).length) {
      requests.push({
        step: requests.length + 1, label: `Change ${label}: ${Object.keys(params).map((k) => (k === 'adlabels' ? 'labels' : k)).join(', ')}`, kind: 'ad', objectKind: 'creative', objectId: id, params,
        check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: true,
        operation: 'creative.update', ...(Object.keys(expect).length ? { expect } : {}), readBackFields: 'id,name,status',
      })
    }
    if (newAdds.length) {
      requests.push({
        step: requests.length + 1, label: `Add label${newAdds.length === 1 ? '' : 's'} ${newAdds.map((l) => `"${l}"`).join(', ')} to ${label}`, kind: 'ad', objectKind: 'creative', objectId: id,
        params: { adlabels: JSON.stringify(newAdds.map((n) => ({ name: n }))) },
        check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: true,
        // Step 21's edge rule shape: the creative itself is read back (its adlabels edge answers success, not a new object).
        operation: 'creative.addLabels', edge: 'adlabels', readBackObject: true,
        doneSentence: () => `Add label${newAdds.length === 1 ? '' : 's'} to ${label}: Meta took ${newAdds.length === 1 ? 'it' : 'them'}.`,
      })
    }
    const finalLabels = labels ?? [...now.labels, ...newAdds]
    const lines: Array<[string, unknown, unknown]> = []
    if (params.name) lines.push([`Creative ${id} name`, now.name, params.name])
    if (params.status) lines.push([`Creative ${id} status`, now.status, params.status])
    if (params.adlabels || newAdds.length) lines.push([`Creative ${id} labels`, now.labels.join(', ') || 'none', finalLabels.join(', ') || 'none'])
    return {
      summary: `Meta: change ${label} (name, status or labels: all Meta lets change on a creative; nothing spends).`,
      changes: changeLines(lines).changes,
      totals: { creatives: requests.length ? 1 : 0, requests: requests.length },
      warnings: [
        'Meta has no check for a creative\'s update or labels (POST /<creative id> and its adlabels edge list no validate_only): the preview is built from the creative as it is now.',
        'Renaming or labelling a creative changes no ad and spends nothing; Meta does not review it again. Everything else on a creative is fixed: a new look is a new creative swapped onto the ad.',
        ...(params.status ? ['Meta sets IN_PROCESS and WITH_ISSUES itself while it reviews; ACTIVE is the only status Nexus writes, and the undo cannot put a review state back.'] : []),
        ...(newAdds.length ? ['A label that does not exist yet is made in the ad account by its name.'] : []),
      ],
      spendsMoney: [], skipped, requests,
      stands: { action: 'set', ...now },
      before: { kind: 'set', ...now },
      after: { kind: 'set', creativeId: id, ...(params.name ? { name: params.name } : {}), ...(params.status ? { status: params.status } : {}), ...(params.adlabels || newAdds.length ? { labels: finalLabels } : {}) },
      creative: { action: 'set' },
    }
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

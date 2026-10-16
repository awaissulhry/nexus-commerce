/**
 * Google Ads changes (2026-10-15, programme 2 group G11) — Demand Gen, Display and App campaigns, and the ads of Video
 * campaigns Google lets an API change. Pure builders: a request + the account's live state → ONE atomic request
 * (GoogleChangeDraft) or a refusal; no call.
 *
 *   typedCreateDraft    a new Demand Gen, Display or App campaign — ALWAYS paused — with its own budget (Display: or a
 *                       shared one), bidding, dates, locations, languages, content exclusions, ad groups (Demand Gen
 *                       channel controls, optimized targeting, bids, targeting) and ads, and the image / YouTube video /
 *                       carousel card assets the ads use, all through temporary ids (-1, -2 …) in one request.
 *   typedAddDraft       new ad groups (with targeting and ads) and new ads in existing ad groups of one such campaign.
 *   typedSettingsDraft  one such campaign's name, dates, bidding and budget amount, and its ad groups' names, channel
 *                       controls, optimized targeting, bids and targeting (added and removed).
 *   typedEditDraft      ads of these campaigns (and Video campaigns' video responsive ads) changed IN PLACE: texts, final
 *                       URL, breadcrumbs, images, videos — the ad keeps its id and its numbers.
 *
 * Money (Owner's rules). Every new campaign is PAUSED: nothing spends until a person enables it (set-google-status, SPENDS
 * MONEY). Inside an ENABLED campaign new ad groups and new ads (in an enabled ad group) are made PAUSED unless the request
 * says `enable: true` (SPENDS MONEY). In a serving ad group (enabled, of an enabled campaign) widening who sees the ads is
 * SPENDS MONEY: one more value of a kind the ad group already narrows by (another placement, audience, location …), the
 * last value of a kind taken away (it then reaches everyone on it), an exclusion taken away, optimized targeting on, a
 * Demand Gen channel added; and so are higher bids or targets (a higher CPC / CPM / CPA, a lower ROAS), a bigger budget, a
 * campaign that starts earlier or ends later. Narrowing and pausing are safe steps.
 *
 * Checked 2026-10-15 with curl in Google's v25 reference and guides (developers.google.com/google-ads/api/…):
 *   docs/demand-gen/overview, /create-campaign, /audience-targeting, /channel-controls, /product-ads:
 *                     advertising_channel_type DEMAND_GEN, no sub type; a NON-shared budget (explicitly_shared false), daily
 *                     amount_micros or a campaign total (total_amount_micros, period CUSTOM_PERIOD, with start and end
 *                     dates); bidding Maximize clicks (target_spend), Target CPC, Maximize conversions, Target CPA, Maximize
 *                     conversion value, Target ROAS; ad groups WITHOUT a type; location and language at the ad group
 *                     (demand_gen_campaign_settings.upgraded_targeting defaults true, set only on create); channel controls
 *                     (demand_gen_ad_group_settings.channel_controls: oneof channel_strategy ALL_CHANNELS /
 *                     ALL_OWNED_AND_OPERATED_CHANNELS, or selected_channels youtube_in_stream, youtube_in_feed,
 *                     youtube_shorts, discover, gmail, display, maps — "explicitly specify all fields"; default ALL_CHANNELS);
 *                     an Audience resource targeted through AudienceInfo needs audience_setting.use_audience_grouped true
 *                     set when the ad group is made ("immutable after the ad group is created"); product feeds through
 *                     shopping_setting.merchant_id / feed_label and listing groups (a root UNIT recommended in every ad
 *                     group); four ad types. Google recommends one atomic GoogleAdsService.Mutate with temporary ids.
 *                     A daily budget below Google's minimum is refused (CampaignBudgetError.BUDGET_BELOW_PER_DAY_MINIMUM).
 *   DemandGenMultiAssetAdInfo  headlines 1–5 (width 30), descriptions 1–5 (90), business_name (25) required,
 *                     call_to_action_text, marketing_images (1.91:1 ≥600×314), square_marketing_images (1:1 ≥300×300),
 *                     portrait_marketing_images (4:5 ≥480×600), tall_portrait_marketing_images (9:16 ≥600×1067) — at most
 *                     20 together, a landscape or a square one required —, logo_images 1–5 (1:1 ≥128×128); ±1 %.
 *   DemandGenCarouselAdInfo  business_name, headline, description, logo_image (1:1 ≥128×128), carousel_cards 2–10
 *                     required; DemandGenCarouselCardAsset headline required, marketing / square / portrait image asset
 *                     ("Temporary IDs are not supported. Only existing image assets can be referenced"), call_to_action_text.
 *   DemandGenVideoResponsiveAdInfo  business_name (AdTextAsset), videos and logo_images required (since v24), headlines,
 *                     long_headlines, descriptions, breadcrumb1/2.  DemandGenProductAdInfo  headline, description,
 *                     business_name (AdTextAsset), logo_image required; breadcrumb1/2.
 *   docs/responsive-display-ads/*, ResponsiveDisplayAdInfo  final_urls ≥1; marketing_images ≥1 (1.91:1) and
 *                     square_marketing_images ≥1 (1:1), at most 15 together; headlines 1–5 (30); long_headline (90);
 *                     descriptions 1–5 (90); business_name (25); call_to_action_text (30); logo_images (4:1 ≥512×128) and
 *                     square_logo_images (1:1 ≥128×128) at most 5 together; youtube_videos ≤5; main_color and accent_color
 *                     together; allow_flexible_color (default true, must be true without colors); format_setting
 *                     (DisplayAdFormatSetting ALL_FORMATS, NATIVE, NON_NATIVE; NATIVE not with allow_flexible_color false);
 *                     control_spec.enable_asset_enhancements / enable_autogen_video. AdGroupType DISPLAY_STANDARD.
 *   docs/app-campaigns/overview, /create-campaign, /create-ad-group  advertising_channel_type MULTI_CHANNEL with sub type
 *                     APP_CAMPAIGN, APP_CAMPAIGN_FOR_ENGAGEMENT or APP_CAMPAIGN_FOR_PRE_REGISTRATION; no shared budget, no
 *                     portfolio strategy; app_campaign_setting app_id / app_store (AppCampaignAppStore APPLE_APP_STORE,
 *                     GOOGLE_APP_STORE) Immutable, bidding_strategy_goal_type with the bidding of the goal's table
 *                     (target_cpa / maximize_conversions / target_roas / maximize_conversion_value);
 *                     selective_optimization.conversion_actions required for engagement, in-app action and value goals,
 *                     optional for installs, automatic for pre-registration (whose optimization_goal_setting holds
 *                     APP_PRE_REGISTRATION); location and language at the campaign; ad groups without a type; engagement:
 *                     a user list per ad group (UserListInfo), an ad group target CPA allowed, no exclusions; APP_CAMPAIGN:
 *                     no ad group bid, Audience criteria as signals; ads AppAdInfo / AppEngagementAdInfo /
 *                     AppPreRegistrationAdInfo (headlines, descriptions, images, videos). "App Campaign Legacy (installs)
 *                     is not supported in the Google Ads API, only in the UI."
 *   docs/video/overview  "Video campaigns cannot be created or mutated using the Google Ads API" — except that, since v24,
 *                     VideoResponsiveAdInfo is mutable ("the videos, business_name, and logo_images fields are required"):
 *                     Nexus makes no Video campaign and changes only the texts, final URL, logo and video of their video
 *                     responsive ads (one of each, as Google allows).
 *   Ad                the info fields of these ad types are NOT Immutable (image_ad is), so AdOperation.update edits them
 *                     in place; the update mask lists `<info>.<field>` paths (snake_case), a masked field left out of the
 *                     body is cleared; Ad.name is Immutable (Demand Gen and video responsive ads).
 *   AdGroup           type, audience_setting Immutable; cpc_bid_micros, cpm_bid_micros, target_cpa_micros,
 *                     optimized_targeting_enabled ("the replacement for Audience Expansion"), demand_gen_ad_group_settings.
 *   AdGroupCriterion  negative Immutable; criteria placement (url), topic (topic_constant topicConstants/{id}), keyword,
 *                     youtube_video (video_id), youtube_channel (channel_id), mobile_application (app_id "1-…"/"2-…"),
 *                     mobile_app_category, user_list, user_interest, custom_audience, combined_audience, life_event,
 *                     audience (AudienceInfo.audience = customers/{c}/audiences/{id}), location, language, listing_group.
 *   Asset             youtube_video_asset.youtube_video_id ("the 11 character string value used in the YouTube video URL");
 *                     demand_gen_carousel_card_asset Immutable; image_asset.data (bytes, asset-images.ts).
 *   CampaignBudget    total_amount_micros used only with period CUSTOM_PERIOD, mutually exclusive with amount_micros;
 *                     BudgetPeriod DAILY / CUSTOM_PERIOD.
 *   Campaign          contains_eu_political_advertising required on create (PLAN.md "v25 facts"); advertising_channel_type
 *                     and sub type Immutable; bidding oneof manual_cpc, manual_cpm, target_spend, target_cpc,
 *                     maximize_conversions, target_cpa, maximize_conversion_value, target_roas, bidding_strategy.
 *
 * Added 2026-10-16 (programme 2 group G14b), checked with curl in the same reference and guides:
 *   docs/ads/ad-types  ImageAd and DisplayUploadAd are ad types an API makes (no deprecation note; VideoAd: "permits only
 *                     reporting"); Ad.image_ad "Immutable" (made, never edited); Ad.name "only supported for
 *                     DisplayUploadAd, ImageAd, …, VideoResponsiveAd and DemandGen ads".
 *   ImageAdInfo       image oneof image_asset (AdImageAsset.asset) | data (bytes) | ad_id_to_copy_image_from: an existing
 *                     image asset is pointed at, a new image goes as its bytes. DisplayUploadAdInfo, MediaBundleAsset, the
 *                     HTML5 and image ad specifications: media-bundles.ts.
 *   Campaign.frequency_caps  repeated FrequencyCapEntry {key {level CAMPAIGN | AD_GROUP | AD_GROUP_AD, event_type IMPRESSION |
 *                     VIDEO_VIEW, time_unit DAY | WEEK | MONTH, time_length}, cap} — "There can be no more than one frequency
 *                     cap with the same key"; CampaignError MAX_IMPRESSIONS_NOT_IN_RANGE ("an integer greater than 0"). Not
 *                     Immutable: the update mask frequency_caps writes the whole list. The reference does not tie it to a
 *                     channel; Google Ads Help 117579 describes caps of Display campaigns (impressions, per day / week /
 *                     month, at the campaign, ad group or ad) and of Video campaigns (which Google's API cannot change):
 *                     Nexus sets them on Display (impressions) and Demand Gen campaigns, and Google's check judges each.
 *   docs/targeting/criteria  Age range, Gender, Income range, Parental status: positive AND negative, campaign and ad group;
 *                     CriterionError CANNOT_TARGET_ONLY_UNDETERMINED, CANNOT_EXCLUDE_ALL_TARGETS. AdGroupCriterion.bid_modifier
 *                     "must be in the range: 0.1 - 10.0. Most targetable criteria types support modifiers." Google Ads Help
 *                     7365594 (as change-demographics.ts read it): every group of a dimension is targeted until a positive
 *                     criterion narrows the dimension to the groups named.
 *   AdGroupAd.ad_group_ad_asset_automation_settings  AdGroupAdAssetAutomationSetting {asset_automation_type,
 *                     asset_automation_status}. AssetAutomationType (v25): GENERATE_ANIMATED_IMAGES_FROM_OTHER_ASSETS,
 *                     GENERATE_DESIGN_VERSIONS_FOR_IMAGES and GENERATE_VIDEOS_FROM_OTHER_ASSETS "By default, advertisers
 *                     are opted in for DemandGenMultiAssetAd"; GENERATE_LANDING_PAGE_TEXT, GENERATE_SHORTER_YOUTUBE_VIDEOS
 *                     and GENERATE_VERTICAL_YOUTUBE_VIDEOS opted in by default for DemandGenVideoResponsiveAdInfo — so a new
 *                     Demand Gen image or video ad says OPTED_OUT for each unless the person asks (Owner's rule: Google
 *                     acting on its own is off unless asked).
 */
import { changeLines, keywordTextProblem, money, plural, type GoogleChangeDraft } from './change-draft.js'
import { httpsUrlProblem, textKey, widthProblem } from './change-ads.js'
import { microsOfCents } from './live.js'
import { adjustmentWords, audienceCriterion, DEMOGRAPHIC_FIELD, DEMOGRAPHIC_VALUES, smartBiddingWords, type AudienceKind, type DemographicDimension } from './live-targeting.js'
import { exclusionInfo, exclusionKey, normalizeExclusion, type ExclusionKind } from './live-exclusions.js'
import {
  DG_CHANNEL_FIELD, DG_CHANNELS, FREQUENCY_EVENTS, FREQUENCY_LEVELS, FREQUENCY_UNITS, frequencyKey, YOUTUBE_ID, type ChannelControls,
  type DgChannel, type FrequencyCap, type LiveMediaAsset, type LiveTypedAd, type LiveTypedAdGroup, type LiveTypedCampaign,
  type LiveTypedCriterion, type TargetKind,
} from './live-campaign-types.js'
import { displaySizeProblem, IMAGE_AD_MAX_BYTES, type PreparedBundle } from './media-bundles.js'
import type { PreparedImage } from './asset-images.js'
import type { GoogleMutateOperation, GoogleMutateResponse } from './write-client.js'

export type { ChannelControls, DgChannel, FrequencyCap, TargetKind } from './live-campaign-types.js'

// ── what Nexus makes ────────────────────────────────────────────────────────────────────────────────────────────

export const TYPED_KINDS = ['DEMAND_GEN', 'DISPLAY', 'APP'] as const
export type TypedKind = typeof TYPED_KINDS[number]
const KIND_WORD: Record<TypedKind, string> = { DEMAND_GEN: 'Demand Gen', DISPLAY: 'Display', APP: 'App' }
/** The campaign kind of an advertising channel type, or null for one these tools do not make or change. */
export const kindOfChannel = (type: string | null): TypedKind | null =>
  type === 'DEMAND_GEN' ? 'DEMAND_GEN' : type === 'DISPLAY' ? 'DISPLAY' : type === 'MULTI_CHANNEL' ? 'APP' : null

export const MAX_TYPED_OPERATIONS = 900
export const MAX_AD_GROUPS = 20
export const MAX_ADS = 20
const DAY = /^\d{4}-\d{2}-\d{2}$/
const GOOGLE_ID = /^\d{1,20}$/

// ── images and videos ───────────────────────────────────────────────────────────────────────────────────────────

/** An image an ad uses: an image asset the account has, or a new one from an https link or the Nexus image library. */
export interface ImageRef { assetId?: string | null; imageUrl?: string | null; libraryImageId?: string | null }
/** A YouTube video an ad uses: a YOUTUBE_VIDEO asset the account has, or a video (its id or link): its asset is made. */
export interface VideoRef { assetId?: string | null; youtubeVideoId?: string | null }
/** An HTML5 ad's ZIP: a MEDIA_BUNDLE asset the account has, or a ZIP from an https link (its asset is made). */
export interface Html5Ref { assetId?: string | null; zipUrl?: string | null }

export type ImageSlot = 'marketing' | 'square' | 'portrait' | 'tallPortrait' | 'logo' | 'landscapeLogo' | 'any'
interface Shape { name: string; ratio: number; minWidth: number; minHeight: number }
/** Google's shapes and smallest sizes (the ad info references above); a ratio may be off by 1 %. */
export const IMAGE_SHAPES: Record<Exclude<ImageSlot, 'any'>, Shape> = {
  marketing: { name: 'landscape (1.91:1)', ratio: 1.91, minWidth: 600, minHeight: 314 },
  square: { name: 'square (1:1)', ratio: 1, minWidth: 300, minHeight: 300 },
  portrait: { name: 'portrait (4:5)', ratio: 0.8, minWidth: 480, minHeight: 600 },
  tallPortrait: { name: 'tall portrait (9:16)', ratio: 9 / 16, minWidth: 600, minHeight: 1067 },
  logo: { name: 'square logo (1:1)', ratio: 1, minWidth: 128, minHeight: 128 },
  landscapeLogo: { name: 'landscape logo (4:1)', ratio: 4, minWidth: 512, minHeight: 128 },
}
export const SHAPE_TOLERANCE = 0.01

export function shapeProblem(where: string, slot: ImageSlot, width: number | null, height: number | null): string | null {
  if (slot === 'any' || !width || !height) return null
  const s = IMAGE_SHAPES[slot]
  const ratio = width / height
  if (Math.abs(ratio - s.ratio) / s.ratio > SHAPE_TOLERANCE) return `${where} is ${width}×${height} (ratio ${ratio.toFixed(2)}): it must be ${s.name}`
  if (width < s.minWidth || height < s.minHeight) return `${where} is ${width}×${height}: a ${s.name} image is at least ${s.minWidth}×${s.minHeight}`
  return null
}

/** The key a new image is read by (the same link or library image is read once). */
export function imageSourceKey(ref: ImageRef): string | null {
  const url = ref.imageUrl?.trim()
  if (url) return `url:${url}`
  const lib = ref.libraryImageId?.trim()
  return lib ? `lib:${lib}` : null
}

/** A YouTube video id from an id or a link, or null. */
export function youtubeIdOf(value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  if (!v) return null
  const got = normalizeExclusion({ kind: 'youtube-video', value: v })
  return 'problem' in got ? null : got.value
}

/** What the media of a request asks the tool to read: new images, existing assets, YouTube videos, HTML5 ZIPs. */
export interface MediaNeeds { imageSources: ImageRef[]; assetIds: string[]; youtubeIds: string[]; bundleUrls: string[] }

export const IMAGE_FIELDS = ['marketingImages', 'squareMarketingImages', 'portraitMarketingImages', 'tallPortraitMarketingImages', 'logoImages', 'squareLogoImages', 'images'] as const
type ImageField = typeof IMAGE_FIELDS[number]

/** Every image and video the ads (to make or to edit) name, once each. */
export function mediaNeeds(ads: Array<Partial<AdFields> & { cards?: CarouselCardRequest[] | null; image?: ImageRef | null; html5?: Html5Ref | null }>): MediaNeeds {
  const sources = new Map<string, ImageRef>()
  const assetIds = new Set<string>()
  const youtube = new Set<string>()
  const bundles = new Set<string>()
  for (const ad of ads) {
    if (ad.image) {
      const key = imageSourceKey(ad.image)
      if (key && !sources.has(key)) sources.set(key, ad.image)
      if (ad.image.assetId && GOOGLE_ID.test(ad.image.assetId.trim())) assetIds.add(ad.image.assetId.trim())
    }
    if (ad.html5) {
      if (ad.html5.zipUrl?.trim()) bundles.add(ad.html5.zipUrl.trim())
      if (ad.html5.assetId && GOOGLE_ID.test(ad.html5.assetId.trim())) assetIds.add(ad.html5.assetId.trim())
    }
    for (const field of IMAGE_FIELDS) {
      for (const ref of ad[field] ?? []) {
        const key = imageSourceKey(ref)
        if (key && !sources.has(key)) sources.set(key, ref)
        if (ref.assetId && GOOGLE_ID.test(ref.assetId.trim())) assetIds.add(ref.assetId.trim())
      }
    }
    for (const ref of ad.videos ?? []) {
      if (ref.assetId && GOOGLE_ID.test(ref.assetId.trim())) assetIds.add(ref.assetId.trim())
      const id = youtubeIdOf(ref.youtubeVideoId)
      if (id) youtube.add(id)
    }
    for (const card of ad.cards ?? []) {
      for (const id of [card.marketingImageAssetId, card.squareMarketingImageAssetId, card.portraitMarketingImageAssetId]) if (id && GOOGLE_ID.test(id.trim())) assetIds.add(id.trim())
    }
  }
  return { imageSources: [...sources.values()], assetIds: [...assetIds], youtubeIds: [...youtube], bundleUrls: [...bundles] }
}

export interface MediaLive {
  /** Each new image read, by its source key (imageSourceKey): the image, or why it cannot be one. */
  images: Record<string, PreparedImage | { problem: string }>
  /** The assets the request names by id. */
  assets: LiveMediaAsset[]
  /** The account's YOUTUBE_VIDEO assets of the videos the request names: used again, not made twice. */
  youtube: LiveMediaAsset[]
  /** Each HTML5 ZIP read, by its link: the ZIP, or why it cannot be one (media-bundles.ts). */
  bundles?: Record<string, PreparedBundle | { problem: string }>
}

/** A new asset the change makes (its id `op:<n>` until Google gave one); an image or ZIP records its fingerprint, not its bytes. */
export interface NewAssetEntry { type: 'IMAGE' | 'YOUTUBE_VIDEO' | 'DEMAND_GEN_CAROUSEL_CARD' | 'MEDIA_BUNDLE'; assetId: string; text: string; sha256?: string }

// ── the operations of one request ───────────────────────────────────────────────────────────────────────────────

/** The order of the kinds in the request: everything is made before anything points at it (few kind switches). */
const KIND_ORDER = [
  'campaignBudgetOperation', 'campaignOperation', 'campaignCriterionOperation', 'adGroupOperation', 'adGroupCriterionOperation',
  'assetOperation', 'adGroupAdOperation', 'adOperation',
] as const

class Ops {
  private tagged: Array<{ op: GoogleMutateOperation; tag?: string }> = []
  private next = -1
  constructor(readonly customer: string) {}
  temp(): number { return this.next-- }
  push(op: GoogleMutateOperation, tag?: string): void { this.tagged.push({ op, ...(tag ? { tag } : {}) }) }
  get size(): number { return this.tagged.length }
  /** The operations grouped by kind (stable inside a kind), and where each tagged one landed. */
  ordered(): { operations: GoogleMutateOperation[]; at: (tag: string) => number } {
    const rank = (op: GoogleMutateOperation) => KIND_ORDER.indexOf(Object.keys(op)[0] as typeof KIND_ORDER[number])
    const sorted = this.tagged.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t.op) - rank(b.t.op) || a.i - b.i).map((x) => x.t)
    const where = new Map<string, number>()
    sorted.forEach((t, i) => { if (t.tag) where.set(t.tag, i) })
    return { operations: sorted.map((t) => t.op), at: (tag) => where.get(tag) ?? -1 }
  }
}

/** Media of one request: each new image or video made once (temporary id), each existing asset checked. */
class Media {
  private bySha = new Map<string, string>()
  private byVideo = new Map<string, string>()
  /** A temporary resource name → the tag of the operation that makes it. */
  readonly tagOf = new Map<string, string>()
  readonly created: Array<NewAssetEntry & { tag: string }> = []
  constructor(private ops: Ops, private live: MediaLive, private problems: string[]) {
    for (const a of live.youtube) if (a.youtubeVideoId && a.assetId && !this.byVideo.has(a.youtubeVideoId)) this.byVideo.set(a.youtubeVideoId, `${ops.customer}/assets/${a.assetId}`)
  }

  private existing(assetId: string, type: 'IMAGE' | 'YOUTUBE_VIDEO' | 'MEDIA_BUNDLE', where: string): LiveMediaAsset | null {
    const id = assetId.trim()
    if (!GOOGLE_ID.test(id)) { this.problems.push(`${where}: asset "${id}" is not a Google id`); return null }
    const a = this.live.assets.find((x) => x.assetId === id)
    if (!a) { this.problems.push(`${where}: asset ${id} is not in this account`); return null }
    const word = { IMAGE: 'an image', YOUTUBE_VIDEO: 'a YouTube video', MEDIA_BUNDLE: 'an HTML5 ZIP (MEDIA_BUNDLE)' }[type]
    if (a.type !== type) { this.problems.push(`${where}: asset ${id} is ${a.type ?? 'of another type'}, not ${word}`); return null }
    return a
  }

  /**
   * An image ad's image (ImageAdInfo's image oneof): an existing image asset (image_asset), or a new image's bytes (data)
   * — of an uploaded display ad size, at most 150 KB (media-bundles.ts).
   */
  imageAd(ref: ImageRef, where: string): Record<string, unknown> | null {
    const given = [ref.assetId?.trim(), ref.imageUrl?.trim(), ref.libraryImageId?.trim()].filter(Boolean)
    if (given.length !== 1) { this.problems.push(`${where}: give assetId, imageUrl or libraryImageId (one of them)`); return null }
    const tooHeavy = (what: string, bytes: number | null | undefined) =>
      (bytes && bytes > IMAGE_AD_MAX_BYTES ? `${what} is ${Math.ceil(bytes / 1024)} KB: Google takes an image ad of at most 150 KB` : null)
    if (ref.assetId?.trim()) {
      const a = this.existing(ref.assetId, 'IMAGE', where)
      if (!a) return null
      const p = displaySizeProblem(`${where} (asset ${a.assetId})`, a.width, a.height) ?? tooHeavy(`${where} (asset ${a.assetId})`, a.fileSize)
      if (p) { this.problems.push(p); return null }
      return { imageAsset: { asset: `${this.ops.customer}/assets/${a.assetId}` } }
    }
    const got = this.live.images[imageSourceKey(ref)!]
    if (!got) { this.problems.push(`${where}: Nexus did not read the image`); return null }
    if ('problem' in got) { this.problems.push(`${where}: ${got.problem}`); return null }
    const p = displaySizeProblem(where, got.width, got.height) ?? tooHeavy(where, got.bytes)
    if (p) { this.problems.push(p); return null }
    return { data: got.data }
  }

  /** An HTML5 ad's ZIP: an existing MEDIA_BUNDLE asset, or a new one made from the ZIP read (once per content). */
  bundle(ref: Html5Ref, where: string): string | null {
    const asset = ref.assetId?.trim()
    const url = ref.zipUrl?.trim()
    if (!!asset === !!url) { this.problems.push(`${where}: give zipUrl or assetId (one of them)`); return null }
    if (asset) {
      const a = this.existing(asset, 'MEDIA_BUNDLE', where)
      return a ? `${this.ops.customer}/assets/${a.assetId}` : null
    }
    const got = this.live.bundles?.[url!]
    if (!got) { this.problems.push(`${where}: Nexus did not read the ZIP`); return null }
    if ('problem' in got) { this.problems.push(`${where}: ${got.problem}`); return null }
    const had = this.bySha.get(got.sha256)
    if (had) return had
    const res = `${this.ops.customer}/assets/${this.ops.temp()}`
    const tag = `asset:${this.created.length}`
    const name = `${got.label ?? 'HTML5 ad'} ${got.sha256.slice(0, 8)}`.slice(0, 120)
    this.ops.push({ assetOperation: { create: { resourceName: res, name, type: 'MEDIA_BUNDLE', mediaBundleAsset: { data: got.data } } } }, tag)
    this.created.push({ type: 'MEDIA_BUNDLE', assetId: tag, text: `HTML5 ZIP ${name} (${got.width}×${got.height}, ${plural(got.files, 'file')}, ${Math.ceil(got.bytes / 1024)} KB)`, sha256: got.sha256, tag })
    this.bySha.set(got.sha256, res)
    this.tagOf.set(res, tag)
    return res
  }

  /** The resource name of an image (an existing one, or a new asset made for it), or null with the problem said. */
  image(ref: ImageRef, slot: ImageSlot, where: string): string | null {
    const given = [ref.assetId?.trim(), ref.imageUrl?.trim(), ref.libraryImageId?.trim()].filter(Boolean)
    if (given.length !== 1) { this.problems.push(`${where}: give assetId, imageUrl or libraryImageId (one of them)`); return null }
    if (ref.assetId?.trim()) {
      const a = this.existing(ref.assetId, 'IMAGE', where)
      if (!a) return null
      const p = shapeProblem(`${where} (asset ${a.assetId})`, slot, a.width, a.height)
      if (p) { this.problems.push(p); return null }
      return `${this.ops.customer}/assets/${a.assetId}`
    }
    const key = imageSourceKey(ref)!
    const got = this.live.images[key]
    if (!got) { this.problems.push(`${where}: Nexus did not read the image`); return null }
    if ('problem' in got) { this.problems.push(`${where}: ${got.problem}`); return null }
    const p = shapeProblem(where, slot, got.width, got.height)
    if (p) { this.problems.push(p); return null }
    const had = this.bySha.get(got.sha256)
    if (had) return had
    const res = `${this.ops.customer}/assets/${this.ops.temp()}`
    const tag = `asset:${this.created.length}`
    const name = `${got.label ?? 'Image'} ${got.sha256.slice(0, 8)}`.slice(0, 120)
    this.ops.push({ assetOperation: { create: { resourceName: res, name, type: 'IMAGE', imageAsset: { data: got.data } } } }, tag)
    this.created.push({ type: 'IMAGE', assetId: tag, text: `${name} (${got.width}×${got.height})`, sha256: got.sha256, tag })
    this.bySha.set(got.sha256, res)
    this.tagOf.set(res, tag)
    return res
  }

  /** The resource name of a YouTube video (an existing asset, the account's asset of that video, or a new one). */
  video(ref: VideoRef, where: string): string | null {
    const asset = ref.assetId?.trim()
    const raw = ref.youtubeVideoId?.trim()
    if (!!asset === !!raw) { this.problems.push(`${where}: give assetId or youtubeVideoId (one of them)`); return null }
    if (asset) {
      const a = this.existing(asset, 'YOUTUBE_VIDEO', where)
      return a ? `${this.ops.customer}/assets/${a.assetId}` : null
    }
    const id = youtubeIdOf(raw)
    if (!id || !YOUTUBE_ID.test(id)) { this.problems.push(`${where}: "${raw}" is not a YouTube video id (11 characters, as on its watch page) or link`); return null }
    const had = this.byVideo.get(id)
    if (had) return had
    const res = `${this.ops.customer}/assets/${this.ops.temp()}`
    const tag = `asset:${this.created.length}`
    this.ops.push({ assetOperation: { create: { resourceName: res, name: `YouTube video ${id}`, type: 'YOUTUBE_VIDEO', youtubeVideoAsset: { youtubeVideoId: id } } } }, tag)
    this.created.push({ type: 'YOUTUBE_VIDEO', assetId: tag, text: `YouTube video ${id}`, tag })
    this.byVideo.set(id, res)
    this.tagOf.set(res, tag)
    return res
  }

  /** A Demand Gen carousel card: a new asset whose images are EXISTING image assets (Google takes no temporary id there). */
  card(card: CarouselCardRequest, where: string): string | null {
    const before = this.problems.length
    const headline = card.headline?.trim() ?? ''
    if (!headline) this.problems.push(`${where}: the headline is empty`)
    const url = httpsUrlProblem(where, card.finalUrl)
    if (url) this.problems.push(url)
    const images: Array<[string | null | undefined, ImageSlot, string]> = [
      [card.marketingImageAssetId, 'marketing', 'marketingImageAsset'], [card.squareMarketingImageAssetId, 'square', 'squareMarketingImageAsset'],
      [card.portraitMarketingImageAssetId, 'portrait', 'portraitMarketingImageAsset'],
    ]
    if (!card.marketingImageAssetId?.trim() && !card.squareMarketingImageAssetId?.trim()) this.problems.push(`${where}: give marketingImageAssetId or squareMarketingImageAssetId (an image asset the account has: Google takes no new image here)`)
    const body: Record<string, unknown> = { headline }
    for (const [id, slot, key] of images) {
      if (!id?.trim()) continue
      const a = this.existing(id, 'IMAGE', `${where}, ${slot} image`)
      if (!a) continue
      const p = shapeProblem(`${where}, ${slot} image (asset ${a.assetId})`, slot, a.width, a.height)
      if (p) { this.problems.push(p); continue }
      body[key] = `${this.ops.customer}/assets/${a.assetId}`
    }
    if (card.callToActionText?.trim()) body.callToActionText = card.callToActionText.trim()
    if (this.problems.length > before) return null
    const res = `${this.ops.customer}/assets/${this.ops.temp()}`
    const tag = `asset:${this.created.length}`
    this.ops.push({ assetOperation: { create: { resourceName: res, finalUrls: [card.finalUrl.trim()], demandGenCarouselCardAsset: body } } }, tag)
    this.created.push({ type: 'DEMAND_GEN_CAROUSEL_CARD', assetId: tag, text: `carousel card "${headline}"`, tag })
    this.tagOf.set(res, tag)
    return res
  }
}

// ── ads: what each type holds ───────────────────────────────────────────────────────────────────────────────────

/** What a person names to make or edit an ad, whatever its type (each type takes the fields of its table below). */
export interface AdFields {
  finalUrl?: string | null
  headlines?: string[] | null
  longHeadlines?: string[] | null
  descriptions?: string[] | null
  brandName?: string | null
  callToActionText?: string | null
  breadcrumb1?: string | null
  breadcrumb2?: string | null
  marketingImages?: ImageRef[] | null
  squareMarketingImages?: ImageRef[] | null
  portraitMarketingImages?: ImageRef[] | null
  tallPortraitMarketingImages?: ImageRef[] | null
  logoImages?: ImageRef[] | null
  squareLogoImages?: ImageRef[] | null
  images?: ImageRef[] | null
  videos?: VideoRef[] | null
}
type AdField = Exclude<keyof AdFields, 'finalUrl'>
const AD_FIELD_NAMES: AdField[] = ['headlines', 'longHeadlines', 'descriptions', 'brandName', 'callToActionText', 'breadcrumb1', 'breadcrumb2', ...IMAGE_FIELDS, 'videos']

export interface CarouselCardRequest {
  headline: string
  finalUrl: string
  callToActionText?: string | null
  marketingImageAssetId?: string | null
  squareMarketingImageAssetId?: string | null
  portraitMarketingImageAssetId?: string | null
}

/** The ad kinds a person names (each is one Google ad type; an App ad's type follows its campaign's sub type). */
export const AD_KINDS = ['multi-asset', 'carousel', 'video', 'product', 'responsive-display', 'image', 'html5-upload', 'app'] as const
export type AdKind = typeof AD_KINDS[number]

export interface TypedAdRequest extends AdFields {
  /** Default: responsive-display in a Display campaign, app in an App campaign; a Demand Gen ad names its kind. */
  type?: AdKind | null
  /** Demand Gen: the ad's name (Google shows it in reports only; it cannot be changed later). */
  name?: string | null
  cards?: CarouselCardRequest[] | null
  mainColor?: string | null
  accentColor?: string | null
  allowFlexibleColor?: boolean | null
  formatSetting?: 'ALL_FORMATS' | 'NATIVE' | 'NON_NATIVE' | null
  /**
   * Google may enhance the media (off unless asked): a responsive display ad's images; a Demand Gen image ad's animated
   * images and design versions; a Demand Gen video ad's shorter and vertical videos and landing page text.
   */
  assetEnhancements?: boolean | null
  /** Google may make videos from the assets (off unless asked): responsive display and Demand Gen image ads. */
  autogenVideo?: boolean | null
  /** An image ad (Display): the ad itself, ONE image of an uploaded display ad size. */
  image?: ImageRef | null
  /** An HTML5 ad (Display): its ZIP. */
  html5?: Html5Ref | null
}

type FieldShape = 'texts' | 'text' | 'string' | 'textAsset' | 'textInList' | 'images' | 'image' | 'videos'
interface FieldSpec { key: string; path: string; shape: FieldShape; min?: number; max?: number; width?: number; slot?: ImageSlot; required?: boolean }
export interface AdTypeSpec {
  info: string
  path: string
  word: string
  finalUrl: 'required' | 'optional' | 'none'
  fields: Partial<Record<AdField, FieldSpec>>
  /** Image fields capped together (and of which one is needed). */
  caps?: Array<{ fields: AdField[]; max: number; oneOf?: AdField[] }>
  /** Sent with every edit (Google requires them on each mutate of this ad type). */
  alwaysSend?: AdField[]
}

/** Counts Google's reference does not state are capped here only to bound a request; Google's check judges the rest. */
const SANE = 15
const texts = (key: string, path: string, o: Partial<FieldSpec> = {}): FieldSpec => ({ key, path, shape: 'texts', max: SANE, ...o })
const imgs = (key: string, path: string, slot: ImageSlot, o: Partial<FieldSpec> = {}): FieldSpec => ({ key, path, shape: 'images', slot, max: 20, ...o })

export const AD_TYPES: Record<string, AdTypeSpec> = {
  RESPONSIVE_DISPLAY_AD: {
    info: 'responsiveDisplayAd', path: 'responsive_display_ad', word: 'responsive display ad', finalUrl: 'required',
    fields: {
      headlines: texts('headlines', 'headlines', { min: 1, max: 5, width: 30, required: true }),
      longHeadlines: { key: 'longHeadline', path: 'long_headline', shape: 'text', width: 90, required: true },
      descriptions: texts('descriptions', 'descriptions', { min: 1, max: 5, width: 90, required: true }),
      brandName: { key: 'businessName', path: 'business_name', shape: 'string', width: 25, required: true },
      callToActionText: { key: 'callToActionText', path: 'call_to_action_text', shape: 'string', width: 30 },
      marketingImages: imgs('marketingImages', 'marketing_images', 'marketing', { min: 1, max: 15, required: true }),
      squareMarketingImages: imgs('squareMarketingImages', 'square_marketing_images', 'square', { min: 1, max: 15, required: true }),
      logoImages: imgs('logoImages', 'logo_images', 'landscapeLogo', { max: 5 }),
      squareLogoImages: imgs('squareLogoImages', 'square_logo_images', 'logo', { max: 5 }),
      videos: { key: 'youtubeVideos', path: 'youtube_videos', shape: 'videos', max: 5 },
    },
    caps: [{ fields: ['marketingImages', 'squareMarketingImages'], max: 15 }, { fields: ['logoImages', 'squareLogoImages'], max: 5 }],
  },
  DEMAND_GEN_MULTI_ASSET_AD: {
    info: 'demandGenMultiAssetAd', path: 'demand_gen_multi_asset_ad', word: 'Demand Gen image ad', finalUrl: 'required',
    fields: {
      headlines: texts('headlines', 'headlines', { min: 1, max: 5, width: 30, required: true }),
      descriptions: texts('descriptions', 'descriptions', { min: 1, max: 5, width: 90, required: true }),
      brandName: { key: 'businessName', path: 'business_name', shape: 'string', width: 25, required: true },
      callToActionText: { key: 'callToActionText', path: 'call_to_action_text', shape: 'string' },
      marketingImages: imgs('marketingImages', 'marketing_images', 'marketing'),
      squareMarketingImages: imgs('squareMarketingImages', 'square_marketing_images', 'square'),
      portraitMarketingImages: imgs('portraitMarketingImages', 'portrait_marketing_images', 'portrait'),
      tallPortraitMarketingImages: imgs('tallPortraitMarketingImages', 'tall_portrait_marketing_images', 'tallPortrait'),
      logoImages: imgs('logoImages', 'logo_images', 'logo', { min: 1, max: 5, required: true }),
    },
    caps: [{ fields: ['marketingImages', 'squareMarketingImages', 'portraitMarketingImages', 'tallPortraitMarketingImages'], max: 20, oneOf: ['marketingImages', 'squareMarketingImages'] }],
  },
  DEMAND_GEN_CAROUSEL_AD: {
    info: 'demandGenCarouselAd', path: 'demand_gen_carousel_ad', word: 'Demand Gen carousel ad', finalUrl: 'required',
    fields: {
      headlines: { key: 'headline', path: 'headline', shape: 'text', required: true },
      descriptions: { key: 'description', path: 'description', shape: 'text', required: true },
      brandName: { key: 'businessName', path: 'business_name', shape: 'string', required: true },
      callToActionText: { key: 'callToActionText', path: 'call_to_action_text', shape: 'string' },
      logoImages: { key: 'logoImage', path: 'logo_image', shape: 'image', slot: 'logo', required: true },
    },
  },
  DEMAND_GEN_VIDEO_RESPONSIVE_AD: {
    info: 'demandGenVideoResponsiveAd', path: 'demand_gen_video_responsive_ad', word: 'Demand Gen video ad', finalUrl: 'required',
    fields: {
      headlines: texts('headlines', 'headlines'),
      longHeadlines: texts('longHeadlines', 'long_headlines'),
      descriptions: texts('descriptions', 'descriptions'),
      brandName: { key: 'businessName', path: 'business_name', shape: 'textAsset', required: true },
      videos: { key: 'videos', path: 'videos', shape: 'videos', min: 1, max: SANE, required: true },
      logoImages: imgs('logoImages', 'logo_images', 'logo', { min: 1, required: true }),
      breadcrumb1: { key: 'breadcrumb1', path: 'breadcrumb1', shape: 'string' },
      breadcrumb2: { key: 'breadcrumb2', path: 'breadcrumb2', shape: 'string' },
    },
    alwaysSend: ['videos', 'brandName', 'logoImages'],
  },
  DEMAND_GEN_PRODUCT_AD: {
    info: 'demandGenProductAd', path: 'demand_gen_product_ad', word: 'Demand Gen product ad', finalUrl: 'optional',
    fields: {
      headlines: { key: 'headline', path: 'headline', shape: 'text', required: true },
      descriptions: { key: 'description', path: 'description', shape: 'text', required: true },
      brandName: { key: 'businessName', path: 'business_name', shape: 'textAsset', required: true },
      logoImages: { key: 'logoImage', path: 'logo_image', shape: 'image', slot: 'logo', required: true },
      breadcrumb1: { key: 'breadcrumb1', path: 'breadcrumb1', shape: 'string' },
      breadcrumb2: { key: 'breadcrumb2', path: 'breadcrumb2', shape: 'string' },
    },
  },
  APP_AD: {
    info: 'appAd', path: 'app_ad', word: 'app ad', finalUrl: 'none',
    fields: {
      headlines: texts('headlines', 'headlines', { min: 1, required: true }),
      descriptions: texts('descriptions', 'descriptions', { min: 1, required: true }),
      images: imgs('images', 'images', 'any'),
      videos: { key: 'youtubeVideos', path: 'youtube_videos', shape: 'videos', max: 20 },
    },
  },
  APP_ENGAGEMENT_AD: {
    info: 'appEngagementAd', path: 'app_engagement_ad', word: 'app engagement ad', finalUrl: 'none',
    fields: {
      headlines: texts('headlines', 'headlines', { min: 1, required: true }),
      descriptions: texts('descriptions', 'descriptions', { min: 1, required: true }),
      images: imgs('images', 'images', 'any'),
      videos: { key: 'videos', path: 'videos', shape: 'videos', max: 20 },
    },
  },
  APP_PRE_REGISTRATION_AD: {
    info: 'appPreRegistrationAd', path: 'app_pre_registration_ad', word: 'app pre-registration ad', finalUrl: 'none',
    fields: {
      headlines: texts('headlines', 'headlines', { min: 1, required: true }),
      descriptions: texts('descriptions', 'descriptions', { min: 1, required: true }),
      images: imgs('images', 'images', 'any'),
      videos: { key: 'youtubeVideos', path: 'youtube_videos', shape: 'videos', max: 20 },
    },
  },
  // Uploaded display ads (Display): the ad is its one image, or its HTML5 ZIP — no texts (newAdBody builds their info).
  IMAGE_AD: { info: 'imageAd', path: 'image_ad', word: 'image ad', finalUrl: 'required', fields: {} },
  HTML5_UPLOAD_AD: { info: 'displayUploadAd', path: 'display_upload_ad', word: 'HTML5 ad', finalUrl: 'required', fields: {} },
  VIDEO_RESPONSIVE_AD: {
    info: 'videoResponsiveAd', path: 'video_responsive_ad', word: 'video responsive ad', finalUrl: 'required',
    fields: {
      headlines: texts('headlines', 'headlines', { max: 1 }),
      longHeadlines: texts('longHeadlines', 'long_headlines', { max: 1 }),
      descriptions: texts('descriptions', 'descriptions', { max: 1 }),
      callToActionText: { key: 'callToActions', path: 'call_to_actions', shape: 'textInList' },
      brandName: { key: 'businessName', path: 'business_name', shape: 'textAsset', width: 25, required: true },
      videos: { key: 'videos', path: 'videos', shape: 'videos', min: 1, max: 1, required: true },
      logoImages: imgs('logoImages', 'logo_images', 'logo', { min: 1, max: 1, required: true }),
      breadcrumb1: { key: 'breadcrumb1', path: 'breadcrumb1', shape: 'string' },
      breadcrumb2: { key: 'breadcrumb2', path: 'breadcrumb2', shape: 'string' },
    },
    alwaysSend: ['videos', 'brandName', 'logoImages'],
  },
}

const FIELD_WORD: Record<AdField, string> = {
  headlines: 'headline', longHeadlines: 'long headline', descriptions: 'description', brandName: 'business name',
  callToActionText: 'call to action', breadcrumb1: 'breadcrumb 1', breadcrumb2: 'breadcrumb 2', marketingImages: 'landscape image',
  squareMarketingImages: 'square image', portraitMarketingImages: 'portrait image', tallPortraitMarketingImages: 'tall portrait image',
  logoImages: 'logo', squareLogoImages: 'square logo', images: 'image', videos: 'video',
}

/** The Google ad type of a kind a person names, in a campaign of this kind (and App sub type). */
export function adTypeOf(kind: TypedKind, subType: string | null, asked: AdKind | null | undefined): string | { problem: string } {
  const want = asked ?? (kind === 'DISPLAY' ? 'responsive-display' : kind === 'APP' ? 'app' : null)
  if (!want) return { problem: 'a Demand Gen ad names its type: multi-asset, carousel, video or product' }
  const allowed: Record<TypedKind, AdKind[]> = { DEMAND_GEN: ['multi-asset', 'carousel', 'video', 'product'], DISPLAY: ['responsive-display', 'image', 'html5-upload'], APP: ['app'] }
  if (!allowed[kind].includes(want)) return { problem: `a ${KIND_WORD[kind]} campaign takes ${allowed[kind].join(', ')} ads, not ${want}` }
  switch (want) {
    case 'multi-asset': return 'DEMAND_GEN_MULTI_ASSET_AD'
    case 'carousel': return 'DEMAND_GEN_CAROUSEL_AD'
    case 'video': return 'DEMAND_GEN_VIDEO_RESPONSIVE_AD'
    case 'product': return 'DEMAND_GEN_PRODUCT_AD'
    case 'responsive-display': return 'RESPONSIVE_DISPLAY_AD'
    case 'image': return 'IMAGE_AD'
    case 'html5-upload': return 'HTML5_UPLOAD_AD'
    case 'app': return subType === 'APP_CAMPAIGN_FOR_ENGAGEMENT' ? 'APP_ENGAGEMENT_AD' : subType === 'APP_CAMPAIGN_FOR_PRE_REGISTRATION' ? 'APP_PRE_REGISTRATION_AD' : 'APP_AD'
  }
}

const isEmpty = (v: unknown) => v === undefined || v === null || (Array.isArray(v) && !v.length)

/**
 * One field of an ad as Google's JSON takes it, its rules checked (problems said, nothing returned for a broken one).
 * `clearing`: an empty optional text (a breadcrumb, a call to action) is a clear in an edit.
 */
function fieldValue(spec: FieldSpec, field: AdField, value: unknown, media: Media, where: string, problems: string[]): unknown {
  const word = FIELD_WORD[field]
  const count = (n: number) => {
    if (spec.min !== undefined && n < spec.min) problems.push(`${where}: ${plural(n, word)} (Google needs at least ${spec.min})`)
    if (spec.max !== undefined && n > spec.max) problems.push(`${where}: ${plural(n, word)} (Google takes at most ${spec.max})`)
  }
  const oneText = (t: unknown, label: string): string => {
    const s = typeof t === 'string' ? t.trim() : ''
    if (!s) problems.push(`${where}: the ${label} is empty`)
    else if (spec.width) { const p = widthProblem(`${where}: ${label}`, s, spec.width); if (p) problems.push(p) }
    return s
  }
  switch (spec.shape) {
    case 'texts': {
      const list = (value as string[]).map((t, i) => oneText(t, `${word} ${i + 1}`))
      count(list.length)
      const seen = new Set<string>()
      for (const t of list) { if (t && seen.has(textKey(t))) problems.push(`${where}: the ${word} "${t}" is there twice`); seen.add(textKey(t)) }
      return list.map((text) => ({ text }))
    }
    case 'text': {
      const list = value as string[]
      if (list.length !== 1) { problems.push(`${where}: a ${word} here is ONE text (${list.length} given)`); return undefined }
      return { text: oneText(list[0], word) }
    }
    case 'string': return oneText(value, word)
    case 'textAsset': return { text: oneText(value, word) }
    case 'textInList': return [{ text: oneText(value, word) }]
    case 'images': {
      const refs = value as ImageRef[]
      count(refs.length)
      return refs.map((r, i) => ({ asset: media.image(r, spec.slot ?? 'any', `${where}, ${word} ${i + 1}`) }))
    }
    case 'image': {
      const refs = value as ImageRef[]
      if (refs.length !== 1) { problems.push(`${where}: ONE ${word} here (${refs.length} given)`); return undefined }
      return { asset: media.image(refs[0], spec.slot ?? 'any', `${where}, ${word}`) }
    }
    case 'videos': {
      const refs = value as VideoRef[]
      count(refs.length)
      return refs.map((r, i) => ({ asset: media.video(r, `${where}, video ${i + 1}`) }))
    }
  }
}

/** The ad's words for the preview: its first headline (or business name, or name) and type. */
const adLabel = (spec: AdTypeSpec, ad: TypedAdRequest) => `${spec.word} "${(ad.headlines?.[0] ?? ad.brandName ?? ad.name ?? ad.finalUrl ?? '').trim().slice(0, 40)}"`

/** Ad types whose Ad.name Google keeps ("only supported for DisplayUploadAd, ImageAd, … and DemandGen ads"). */
const NAMED_ADS: readonly string[] = ['image_ad', 'display_upload_ad']

/** Google acting on its own per Demand Gen ad type (AssetAutomationType, v25: each opted in by default for that type). */
const DG_AUTOMATION: Record<string, Array<[string, 'assetEnhancements' | 'autogenVideo']>> = {
  DEMAND_GEN_MULTI_ASSET_AD: [
    ['GENERATE_ANIMATED_IMAGES_FROM_OTHER_ASSETS', 'assetEnhancements'], ['GENERATE_DESIGN_VERSIONS_FOR_IMAGES', 'assetEnhancements'],
    ['GENERATE_VIDEOS_FROM_OTHER_ASSETS', 'autogenVideo'],
  ],
  DEMAND_GEN_VIDEO_RESPONSIVE_AD: [
    ['GENERATE_SHORTER_YOUTUBE_VIDEOS', 'assetEnhancements'], ['GENERATE_VERTICAL_YOUTUBE_VIDEOS', 'assetEnhancements'], ['GENERATE_LANDING_PAGE_TEXT', 'assetEnhancements'],
  ],
}

/**
 * The AdGroupAd's own part of a new ad: a Demand Gen image or video ad says OPTED_OUT for each of Google's automations
 * Google opts it into by default, unless the person asked (assetEnhancements / autogenVideo). Other ads: nothing.
 */
export function adGroupAdAutomation(adType: string, ad: TypedAdRequest): Record<string, unknown> {
  const types = DG_AUTOMATION[adType]
  if (!types) return {}
  return { adGroupAdAssetAutomationSettings: types.map(([type, flag]) => ({ assetAutomationType: type, assetAutomationStatus: ad[flag] === true ? 'OPTED_IN' : 'OPTED_OUT' })) }
}

/** HTML5 ads need Google's permission for the account (said once per request). */
const HTML5_NOTE = 'HTML5 ads: Google takes them only from accounts it allowed (support.google.com/google-ads/answer/1722096 — account age, spend and policy history, then "Apply for HTML5 access"); Google\'s check in this preview says whether this account may.'

const HEX = /^#[0-9a-fA-F]{6}$/

/** A new ad's `ad` message (final URL, name, its type's info), or null with the problems said. */
function newAdBody(spec: AdTypeSpec, ad: TypedAdRequest, media: Media, where: string, problems: string[], notes: string[]): Record<string, unknown> | null {
  const before = problems.length
  const info: Record<string, unknown> = {}
  for (const field of AD_FIELD_NAMES) {
    const fs = spec.fields[field]
    const value = ad[field]
    if (!fs) { if (!isEmpty(value)) problems.push(`${where}: a ${spec.word} has no ${FIELD_WORD[field]}s (${field})`); continue }
    if (isEmpty(value) || (typeof value === 'string' && !value.trim())) { if (fs.required) problems.push(`${where}: a ${spec.word} needs ${field}`); continue }
    const v = fieldValue(fs, field, value, media, where, problems)
    if (v !== undefined) info[fs.key] = v
  }
  for (const cap of spec.caps ?? []) {
    const n = cap.fields.reduce((sum, f) => sum + ((ad[f] as unknown[] | null | undefined)?.length ?? 0), 0)
    if (n > cap.max) problems.push(`${where}: ${n} ${cap.fields.map((f) => FIELD_WORD[f]).join(' / ')}s together (Google takes at most ${cap.max})`)
    if (cap.oneOf && !cap.oneOf.some((f) => (ad[f] as unknown[] | null | undefined)?.length)) problems.push(`${where}: a ${spec.word} needs ${cap.oneOf.join(' or ')}`)
  }
  if (spec.info === 'demandGenCarouselAd') {
    const cards = ad.cards ?? []
    if (cards.length < 2 || cards.length > 10) problems.push(`${where}: ${plural(cards.length, 'card')} (a carousel takes 2 to 10)`)
    info.carouselCards = cards.map((c, i) => ({ asset: media.card(c, `${where}, card ${i + 1}`) }))
  } else if (ad.cards?.length) problems.push(`${where}: cards are for a carousel ad`)
  if (spec.info === 'responsiveDisplayAd') {
    const main = ad.mainColor?.trim()
    const accent = ad.accentColor?.trim()
    if (!!main !== !!accent) problems.push(`${where}: give mainColor and accentColor together, or neither (Google's rule)`)
    for (const [k, c] of [['mainColor', main], ['accentColor', accent]] as const) if (c && !HEX.test(c)) problems.push(`${where}: ${k} "${c}" is not a colour like #1a2b3c`)
    if (!main && ad.allowFlexibleColor === false) problems.push(`${where}: allowFlexibleColor must stay true without colours (Google's rule)`)
    if (ad.formatSetting === 'NATIVE' && ad.allowFlexibleColor === false) problems.push(`${where}: a NATIVE format needs allowFlexibleColor true (the publisher colours it)`)
    if (main && accent) { info.mainColor = main; info.accentColor = accent }
    if (typeof ad.allowFlexibleColor === 'boolean') info.allowFlexibleColor = ad.allowFlexibleColor
    if (ad.formatSetting) info.formatSetting = ad.formatSetting
    // Google acting on its own is OFF unless the person asks (Owner's rule for every new campaign Nexus makes).
    info.controlSpec = { enableAssetEnhancements: ad.assetEnhancements === true, enableAutogenVideo: ad.autogenVideo === true }
    if (ad.assetEnhancements || ad.autogenVideo) notes.push(`${where}: Google acts on its own — ${[ad.assetEnhancements && 'asset enhancements', ad.autogenVideo && 'videos made from the assets'].filter(Boolean).join(', ')}.`)
  } else if (ad.mainColor || ad.accentColor || (ad.allowFlexibleColor !== undefined && ad.allowFlexibleColor !== null) || ad.formatSetting) {
    problems.push(`${where}: colours and format are for a responsive display ad`)
  }
  if (spec.info !== 'responsiveDisplayAd') {
    const dg = DG_AUTOMATION[spec.info === 'demandGenMultiAssetAd' ? 'DEMAND_GEN_MULTI_ASSET_AD' : spec.info === 'demandGenVideoResponsiveAd' ? 'DEMAND_GEN_VIDEO_RESPONSIVE_AD' : '']
    if (ad.assetEnhancements && !dg) problems.push(`${where}: Google's enhancements are for responsive display ads and Demand Gen image and video ads`)
    if (ad.autogenVideo && !dg?.some(([, flag]) => flag === 'autogenVideo')) problems.push(`${where}: videos made by Google are for responsive display ads and Demand Gen image ads`)
    if (dg && (ad.assetEnhancements || ad.autogenVideo)) {
      notes.push(`${where}: Google acts on its own — ${dg.filter(([, flag]) => ad[flag]).map(([t]) => t.toLowerCase().replace(/^generate_/, '').replace(/_/g, ' ')).join(', ')}.`)
    }
  }
  if (spec.info === 'imageAd') {
    if (!ad.image) problems.push(`${where}: an image ad needs image (the ad itself: ONE image of an uploaded display ad size)`)
    else { const v = media.imageAd(ad.image, `${where}, image`); if (v) Object.assign(info, v) }
  } else if (ad.image) problems.push(`${where}: image is for an image ad (type image)`)
  if (spec.info === 'displayUploadAd') {
    if (!ad.html5) problems.push(`${where}: an HTML5 ad needs html5 (its ZIP: zipUrl or assetId)`)
    else {
      const res = media.bundle(ad.html5, `${where}, ZIP`)
      if (res) { info.displayUploadProductType = 'HTML5_UPLOAD_AD'; info.mediaBundle = { asset: res } }
    }
    if (!notes.includes(HTML5_NOTE)) notes.push(HTML5_NOTE)
  } else if (ad.html5) problems.push(`${where}: html5 is for an HTML5 ad (type html5-upload)`)
  const url = ad.finalUrl?.trim()
  if (spec.finalUrl === 'none' && url) problems.push(`${where}: an ${spec.word} has no final URL (it leads to the app's store page)`)
  if (spec.finalUrl === 'required' && !url) problems.push(`${where}: a ${spec.word} needs finalUrl`)
  if (url && spec.finalUrl !== 'none') { const p = httpsUrlProblem(where, url); if (p) problems.push(p) }
  const name = ad.name?.trim()
  if (name && !spec.path.startsWith('demand_gen') && !NAMED_ADS.includes(spec.path)) problems.push(`${where}: an ad name is for Demand Gen, image and HTML5 ads`)
  if (problems.length > before) return null
  return { ...(url && spec.finalUrl !== 'none' ? { finalUrls: [url] } : {}), ...(name ? { name: name.slice(0, 255) } : {}), [spec.info]: info }
}

// ── targeting ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface TargetItem {
  kind: TargetKind
  value: string
  exclude?: boolean | null
  /**
   * A targeted (not excluded) item's bid adjustment in a Display ad group (AdGroupCriterion.bid_modifier, 0.1–10; 1 or
   * null = none). Kept on the item; it is not part of what the item is (targetKey).
   */
  bidModifier?: number | null
}

/** What each campaign kind takes in an ad group (Google's guides above); App: by sub type. */
export function targetKindsOf(kind: TypedKind, subType: string | null): { include: readonly TargetKind[]; exclude: readonly TargetKind[] } {
  const SEGMENTS: TargetKind[] = ['user-list', 'user-interest', 'custom-audience', 'combined-audience', 'life-event']
  // Demographics: everyone is shown by default. Display ad groups may also target them (a first group of a dimension
  // narrows it to the groups named, docs/targeting/criteria) with bid adjustments; Demand Gen only excludes them.
  const DEMOGRAPHICS: TargetKind[] = ['age-range', 'gender', 'parental-status', 'income-range']
  if (kind === 'DISPLAY') {
    const content: TargetKind[] = ['placement', 'topic', 'keyword', 'youtube-channel', 'youtube-video', 'mobile-app', 'app-category']
    return { include: [...content, ...SEGMENTS, ...DEMOGRAPHICS], exclude: [...content, 'user-list', 'user-interest', 'custom-audience', 'combined-audience', ...DEMOGRAPHICS] }
  }
  if (kind === 'DEMAND_GEN') return { include: ['audience', ...SEGMENTS, 'location', 'language'], exclude: ['location', ...DEMOGRAPHICS] }
  if (subType === 'APP_CAMPAIGN_FOR_ENGAGEMENT') return { include: ['user-list'], exclude: [] }
  if (subType === 'APP_CAMPAIGN_FOR_PRE_REGISTRATION') return { include: [], exclude: [] }
  return { include: ['audience'], exclude: [] }
}

const TARGET_WORD: Record<TargetKind, string> = {
  placement: 'website', topic: 'topic', keyword: 'keyword', 'youtube-channel': 'YouTube channel', 'youtube-video': 'YouTube video',
  'mobile-app': 'app', 'app-category': 'app category', 'user-list': 'user list', 'user-interest': 'interest segment',
  'custom-audience': 'custom segment', 'combined-audience': 'combined segment', 'life-event': 'life event', audience: 'audience',
  location: 'location', language: 'language', 'age-range': 'age range', gender: 'gender', 'parental-status': 'parental status',
  'income-range': 'household income',
}
/** The demographic dimension (live-targeting.ts) of each demographic kind. */
const DEMOGRAPHIC_OF: Partial<Record<TargetKind, DemographicDimension>> = { 'age-range': 'AGE_RANGE', gender: 'GENDER', 'parental-status': 'PARENTAL_STATUS', 'income-range': 'INCOME_RANGE' }
const SEGMENT_KIND: Partial<Record<TargetKind, AudienceKind>> = {
  'user-list': 'USER_LIST', 'user-interest': 'USER_INTEREST', 'custom-audience': 'CUSTOM_AUDIENCE', 'combined-audience': 'COMBINED_AUDIENCE', 'life-event': 'LIFE_EVENT',
}
/** The kinds whose ids must be ones the account knows (their names come from Google: a missing one is refused). */
export const NAMED_TARGET_KINDS: readonly TargetKind[] = ['user-list', 'user-interest', 'custom-audience', 'combined-audience', 'life-event', 'audience']
export const segmentKindOf = (kind: TargetKind): AudienceKind | null => SEGMENT_KIND[kind] ?? null

const PLACEMENT_LIKE: readonly string[] = ['placement', 'youtube-channel', 'youtube-video', 'mobile-app', 'app-category']
const ID_KINDS: readonly string[] = ['topic', 'user-list', 'user-interest', 'custom-audience', 'combined-audience', 'life-event', 'audience', 'location', 'language']

/** A bid adjustment as Nexus keeps it: null for none (×1), else the factor. */
const bidOf = (m: number | null | undefined): number | null => (m === undefined || m === null || m === 1 ? null : m)

/**
 * The item as Google takes it (YouTube links become ids, resource names their ids), with its bid adjustment checked
 * (0.1–10, only on a targeted item), or why not.
 */
export function normalizeTarget(item: TargetItem): TargetItem | { problem: string } {
  const base = normalizeTargetValue(item)
  if ('problem' in base || item.bidModifier === undefined) return base
  const m = item.bidModifier
  if (m !== null && !(typeof m === 'number' && m >= 0.1 && m <= 10)) return { problem: `${targetWords(base)}: a bid adjustment is between 0.1 and 10 (1 = none)` }
  if (base.exclude && bidOf(m) !== null) return { problem: `${targetWords(base)}: an excluded item has no bid adjustment` }
  return { ...base, bidModifier: bidOf(m) }
}

function normalizeTargetValue(item: TargetItem): TargetItem | { problem: string } {
  const v = String(item.value ?? '').trim()
  const word = TARGET_WORD[item.kind] ?? item.kind
  if (PLACEMENT_LIKE.includes(item.kind)) {
    const got = normalizeExclusion({ kind: item.kind as ExclusionKind, value: v })
    return 'problem' in got ? got : { kind: item.kind, value: got.value, exclude: item.exclude === true }
  }
  if (item.kind === 'keyword') {
    const p = keywordTextProblem(v)
    return p ? { problem: `keyword "${v.slice(0, 80)}" ${p}` } : { kind: 'keyword', value: v.replace(/\s+/g, ' '), exclude: item.exclude === true }
  }
  const demographic = DEMOGRAPHIC_OF[item.kind]
  if (demographic) {
    const value = v.toUpperCase()
    const values: readonly string[] = DEMOGRAPHIC_VALUES[demographic]
    return values.includes(value) ? { kind: item.kind, value, exclude: item.exclude === true } : { problem: `${word} "${v.slice(0, 40)}": Google's values are ${values.join(', ')}` }
  }
  if (ID_KINDS.includes(item.kind)) {
    const id = v.slice(v.lastIndexOf('/') + 1)
    return GOOGLE_ID.test(id) ? { kind: item.kind, value: id, exclude: item.exclude === true } : { problem: `${word} "${v.slice(0, 80)}": give its id (digits)` }
  }
  return { problem: `"${item.kind}" is not a kind of targeting Nexus sets` }
}

/** An item's identity (the same website, keyword, segment … however it is written; included and excluded apart). */
export function targetKey(item: TargetItem): string {
  const sign = item.exclude ? '-' : '+'
  if (PLACEMENT_LIKE.includes(item.kind)) return `${sign}${exclusionKey({ kind: item.kind as ExclusionKind, value: item.value })}`
  if (item.kind === 'keyword') return `${sign}keyword:${item.value.trim().toLowerCase().replace(/\s+/g, ' ')}`
  return `${sign}${item.kind}:${item.value.trim()}`
}

/** The criterion part of an item, as Google's JSON names it. */
export function targetInfo(customer: string, item: TargetItem): Record<string, unknown> {
  if (PLACEMENT_LIKE.includes(item.kind)) return exclusionInfo({ kind: item.kind as ExclusionKind, value: item.value })
  const segment = SEGMENT_KIND[item.kind]
  if (segment) return audienceCriterion(customer, segment, item.value)
  const demographic = DEMOGRAPHIC_OF[item.kind]
  if (demographic) return { [DEMOGRAPHIC_FIELD[demographic]]: { type: item.value } }
  switch (item.kind) {
    case 'topic': return { topic: { topicConstant: `topicConstants/${item.value}` } }
    // A Display keyword (content keyword) matches pages about it; Google takes its match type as BROAD.
    case 'keyword': return { keyword: { text: item.value, matchType: 'BROAD' } }
    case 'audience': return { audience: { audience: `${customer}/audiences/${item.value}` } }
    case 'location': return { location: { geoTargetConstant: `geoTargetConstants/${item.value}` } }
    case 'language': return { language: { languageConstant: `languageConstants/${item.value}` } }
    default: return {}
  }
}

/** Each demographic kind is a dimension of its own (an age narrows ages, not genders). */
const DEMOGRAPHIC_DIMENSION_WORD: Record<DemographicDimension, string> = { AGE_RANGE: 'age ranges', GENDER: 'genders', PARENTAL_STATUS: 'parental statuses', INCOME_RANGE: 'household incomes' }

/** Which "dimension" an item narrows: within one, values add up (OR); between them, they narrow together. */
export function dimensionOf(kind: TargetKind): string {
  if (PLACEMENT_LIKE.includes(kind)) return 'placements'
  if (kind === 'topic') return 'topics'
  if (kind === 'keyword') return 'keywords'
  if (kind === 'location') return 'locations'
  if (kind === 'language') return 'languages'
  const demographic = DEMOGRAPHIC_OF[kind]
  if (demographic) return DEMOGRAPHIC_DIMENSION_WORD[demographic]
  return 'audiences'
}
/** One of a dimension, in words. */
const DIMENSION_ONE: Record<string, string> = {
  placements: 'placement', topics: 'topic', keywords: 'keyword', locations: 'location', languages: 'language', audiences: 'audience',
  'age ranges': 'age range', genders: 'gender', 'parental statuses': 'parental status', 'household incomes': 'household income',
}

/** The dimension (dimensionOf) a TargetRestriction's targeting dimension narrows, or null. */
const dimensionOfRestriction = (d: string): string | null =>
  ({ AUDIENCE: 'audiences', TOPIC: 'topics', PLACEMENT: 'placements', KEYWORD: 'keywords', ...DEMOGRAPHIC_DIMENSION_WORD } as Record<string, string>)[d] ?? null

/**
 * Google's demographic rules on what an ad group holds after a change (docs/targeting/criteria, CriterionError): a group
 * both targeted and excluded is a contradiction; every group of a dimension excluded is CANNOT_EXCLUDE_ALL_TARGETS; only
 * the "unknown" group left to see the ads is CANNOT_TARGET_ONLY_UNDETERMINED. Only the dimensions `touched` are judged
 * (an ad group Google already holds that way stays as it is).
 */
export function demographicProblems(where: string, after: TargetItem[], touched: Set<string>): string[] {
  const out: string[] = []
  for (const [kind, dim] of Object.entries(DEMOGRAPHIC_OF) as Array<[TargetKind, DemographicDimension]>) {
    if (!touched.has(kind)) continue
    const items = after.filter((t) => t.kind === kind)
    const values: readonly string[] = DEMOGRAPHIC_VALUES[dim]
    const excluded = new Set(items.filter((t) => t.exclude).map((t) => t.value))
    const targeted = new Set(items.filter((t) => !t.exclude).map((t) => t.value))
    const both = [...targeted].filter((v) => excluded.has(v))
    if (both.length) out.push(`${where}: ${TARGET_WORD[kind]} ${both.join(', ')} is both targeted and excluded`)
    const shown = (targeted.size ? [...targeted] : [...values]).filter((v) => !excluded.has(v))
    if (!shown.length) out.push(`${where}: that leaves every ${TARGET_WORD[kind]} group out — Google refuses it (CANNOT_EXCLUDE_ALL_TARGETS: the ads could show to nobody)`)
    else if (shown.length === 1 && shown[0].endsWith('UNDETERMINED')) out.push(`${where}: that leaves only the unknown ${TARGET_WORD[kind]} group — Google refuses it (CANNOT_TARGET_ONLY_UNDETERMINED)`)
  }
  return out
}

/** The names Google gave the segments and Audience resources named, by `kind|id` (a missing key: Google does not know it). */
export type TargetNames = Record<string, { name: string | null; status: string | null }>
const nameKey = (item: TargetItem) => `${item.kind}|${item.value}`
export const targetWords = (item: TargetItem, names: TargetNames = {}) => {
  const n = names[nameKey(item)]?.name
  const bid = bidOf(item.bidModifier)
  return `${item.exclude ? 'exclude ' : ''}${TARGET_WORD[item.kind]} ${item.kind === 'keyword' ? `"${item.value}"` : item.value}${n ? ` (${n})` : ''}${bid !== null ? ` (bid ${adjustmentWords(bid)})` : ''}`
}

/**
 * The items of one ad group checked: allowed in this campaign, written as Google takes them, named ones known to the
 * account, each once. Problems are said; the good items are returned.
 */
function checkTargets(items: TargetItem[], kind: TypedKind, subType: string | null, names: TargetNames, where: string, problems: string[]): TargetItem[] {
  const allowed = targetKindsOf(kind, subType)
  const out: TargetItem[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    const item = normalizeTarget(raw)
    if ('problem' in item) { problems.push(`${where}: ${item.problem}`); continue }
    const list = item.exclude ? allowed.exclude : allowed.include
    if (!list.includes(item.kind)) {
      problems.push(`${where}: a ${KIND_WORD[kind]}${kind === 'APP' && subType ? ` (${subType})` : ''} ad group cannot ${item.exclude ? 'exclude' : 'target'} a ${TARGET_WORD[item.kind]}${list.length ? ` (it ${item.exclude ? 'excludes' : 'targets'} ${list.map((k) => TARGET_WORD[k]).join(', ')})` : ''}`)
      continue
    }
    if (bidOf(item.bidModifier) !== null && (kind !== 'DISPLAY' || item.kind === 'keyword')) {
      problems.push(`${where}: a bid adjustment on targeting is for a Display ad group's audiences, demographics, placements and topics (not ${kind !== 'DISPLAY' ? `a ${KIND_WORD[kind]} ad group` : 'a keyword: its bid is the ad group\'s'})`)
      continue
    }
    if (NAMED_TARGET_KINDS.includes(item.kind)) {
      const known = names[nameKey(item)]
      if (!known) { problems.push(`${where}: ${TARGET_WORD[item.kind]} ${item.value} is not in this account (google-ads-query can list them)`); continue }
      if (known.status === 'REMOVED') { problems.push(`${where}: ${TARGET_WORD[item.kind]} ${item.value} is removed`); continue }
    }
    const key = targetKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

const criterionCreate = (customer: string, adGroup: string, item: TargetItem): GoogleMutateOperation =>
  ({ adGroupCriterionOperation: { create: { adGroup, ...(item.exclude ? { negative: true } : {}), ...(bidOf(item.bidModifier) !== null ? { bidModifier: item.bidModifier } : {}), ...targetInfo(customer, item) } } })
/** The record form of an item: kind, value, exclude, and its bid adjustment when it has one. */
const recordItem = (t: TargetItem): TargetItem => ({ kind: t.kind, value: t.value, exclude: t.exclude === true, ...(bidOf(t.bidModifier) !== null ? { bidModifier: t.bidModifier } : {}) })

// ── bidding ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const TYPED_STRATEGIES = ['MANUAL_CPC', 'MANUAL_CPM', 'MAXIMIZE_CLICKS', 'TARGET_CPC', 'MAXIMIZE_CONVERSIONS', 'TARGET_CPA', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_ROAS', 'PORTFOLIO'] as const
export type TypedStrategy = typeof TYPED_STRATEGIES[number]
export interface TypedBidding { strategy: TypedStrategy; maxCpcCents?: number | null; targetCpcCents?: number | null; targetCpaCents?: number | null; targetRoas?: number | null; portfolioId?: string | null }

/**
 * The strategies each kind takes; App bidding follows its goal. Demand Gen: docs/demand-gen/create-campaign lists Maximize
 * Clicks, Target CPA, Maximize Conversions and Target ROAS, and docs/demand-gen/overview ("Key API resources", Campaign)
 * names maximize_conversions, maximize_conversion_value, target_cpa, target_roas, target_spend and target_cpc (both v25,
 * read 2026-10-15) — so Target CPC and Maximize conversion value are offered too (Google's check judges each campaign).
 */
export const STRATEGIES_OF: Record<'DEMAND_GEN' | 'DISPLAY', readonly TypedStrategy[]> = {
  DEMAND_GEN: ['MAXIMIZE_CLICKS', 'TARGET_CPC', 'MAXIMIZE_CONVERSIONS', 'TARGET_CPA', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_ROAS'],
  DISPLAY: ['MANUAL_CPC', 'MANUAL_CPM', 'MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS', 'TARGET_CPA', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_ROAS', 'PORTFOLIO'],
}

/** Only the fields the strategy uses (an extra one would read as a change forever). */
export function typedBiddingClean(b: TypedBidding): TypedBidding {
  const keep = (k: keyof TypedBidding) => (b[k] !== undefined && b[k] !== null ? { [k]: b[k] } : {})
  switch (b.strategy) {
    case 'MANUAL_CPC': case 'MANUAL_CPM': return { strategy: b.strategy }
    case 'MAXIMIZE_CLICKS': return { strategy: b.strategy, ...keep('maxCpcCents') }
    case 'TARGET_CPC': return { strategy: b.strategy, ...keep('targetCpcCents') }
    case 'MAXIMIZE_CONVERSIONS': case 'TARGET_CPA': return { strategy: b.strategy, ...keep('targetCpaCents') }
    case 'MAXIMIZE_CONVERSION_VALUE': case 'TARGET_ROAS': return { strategy: b.strategy, ...keep('targetRoas') }
    case 'PORTFOLIO': return { strategy: b.strategy, ...keep('portfolioId') }
  }
}

export function typedBiddingProblem(b: TypedBidding): string | null {
  if (b.strategy === 'TARGET_CPC' && !b.targetCpcCents) return 'TARGET_CPC needs targetCpcCents.'
  if (b.strategy === 'TARGET_CPA' && !b.targetCpaCents) return 'TARGET_CPA needs targetCpaCents.'
  if (b.strategy === 'TARGET_ROAS' && !b.targetRoas) return 'TARGET_ROAS needs targetRoas.'
  if (b.strategy === 'PORTFOLIO' && !b.portfolioId) return 'PORTFOLIO needs portfolioId.'
  return null
}

export function typedBiddingFields(customer: string, b: TypedBidding): Record<string, unknown> {
  switch (b.strategy) {
    case 'MANUAL_CPC': return { manualCpc: { enhancedCpcEnabled: false } }
    case 'MANUAL_CPM': return { manualCpm: {} }
    case 'MAXIMIZE_CLICKS': return { targetSpend: b.maxCpcCents ? { cpcBidCeilingMicros: microsOfCents(b.maxCpcCents) } : {} }
    case 'TARGET_CPC': return { targetCpc: { targetCpcMicros: microsOfCents(b.targetCpcCents!) } }
    case 'MAXIMIZE_CONVERSIONS': return { maximizeConversions: b.targetCpaCents ? { targetCpaMicros: microsOfCents(b.targetCpaCents) } : {} }
    case 'TARGET_CPA': return { targetCpa: { targetCpaMicros: microsOfCents(b.targetCpaCents!) } }
    case 'MAXIMIZE_CONVERSION_VALUE': return { maximizeConversionValue: b.targetRoas ? { targetRoas: b.targetRoas } : {} }
    case 'TARGET_ROAS': return { targetRoas: { targetRoas: b.targetRoas } }
    case 'PORTFOLIO': return { biddingStrategy: `${customer}/biddingStrategies/${b.portfolioId}` }
  }
}

/** The update mask of a bidding switch or target change: always leaf paths (a message path with sub-fields is refused). */
export function typedBiddingMask(b: TypedBidding): string[] {
  switch (b.strategy) {
    case 'MANUAL_CPC': return ['manual_cpc.enhanced_cpc_enabled']
    // ManualCpm has no fields: its own path is the leaf.
    case 'MANUAL_CPM': return ['manual_cpm']
    case 'MAXIMIZE_CLICKS': return ['target_spend.cpc_bid_ceiling_micros']
    case 'TARGET_CPC': return ['target_cpc.target_cpc_micros']
    case 'MAXIMIZE_CONVERSIONS': return ['maximize_conversions.target_cpa_micros']
    case 'TARGET_CPA': return ['target_cpa.target_cpa_micros']
    case 'MAXIMIZE_CONVERSION_VALUE': return ['maximize_conversion_value.target_roas']
    case 'TARGET_ROAS': return ['target_roas.target_roas']
    case 'PORTFOLIO': return ['bidding_strategy']
  }
}

export function typedBiddingText(b: TypedBidding, currency: string): string {
  switch (b.strategy) {
    case 'MANUAL_CPC': return 'Manual CPC'
    case 'MANUAL_CPM': return 'Manual CPM (viewable)'
    case 'MAXIMIZE_CLICKS': return `Maximize clicks${b.maxCpcCents ? `, max CPC ${money(b.maxCpcCents, currency)}` : ''}`
    case 'TARGET_CPC': return `Target CPC ${money(b.targetCpcCents, currency)}`
    case 'MAXIMIZE_CONVERSIONS': return `Maximize conversions${b.targetCpaCents ? `, target CPA ${money(b.targetCpaCents, currency)}` : ''}`
    case 'TARGET_CPA': return `Target CPA ${money(b.targetCpaCents, currency)}`
    case 'MAXIMIZE_CONVERSION_VALUE': return `Maximize conversion value${b.targetRoas ? `, target ROAS ${Math.round(b.targetRoas * 100)} %` : ''}`
    case 'TARGET_ROAS': return `Target ROAS ${Math.round((b.targetRoas ?? 0) * 100)} %`
    case 'PORTFOLIO': return `portfolio strategy ${b.portfolioId}`
  }
}

/** The bidding a campaign has now, in these tools' terms; null when Nexus cannot name it. */
export function typedBiddingNow(c: Pick<LiveTypedCampaign, 'bidding' | 'portfolioId' | 'targetCpaCents' | 'targetRoas' | 'maxCpcCents' | 'targetCpcCents'>): TypedBidding | null {
  if (c.portfolioId) return { strategy: 'PORTFOLIO', portfolioId: c.portfolioId }
  const opt = <K extends keyof TypedBidding>(k: K, v: TypedBidding[K] | null) => (v ? { [k]: v } : {})
  switch (c.bidding) {
    case 'MANUAL_CPC': return { strategy: 'MANUAL_CPC' }
    case 'MANUAL_CPM': return { strategy: 'MANUAL_CPM' }
    case 'TARGET_SPEND': return { strategy: 'MAXIMIZE_CLICKS', ...opt('maxCpcCents', c.maxCpcCents) }
    case 'TARGET_CPC': return { strategy: 'TARGET_CPC', ...opt('targetCpcCents', c.targetCpcCents) }
    case 'MAXIMIZE_CONVERSIONS': return { strategy: 'MAXIMIZE_CONVERSIONS', ...opt('targetCpaCents', c.targetCpaCents) }
    case 'TARGET_CPA': return { strategy: 'TARGET_CPA', ...opt('targetCpaCents', c.targetCpaCents) }
    case 'MAXIMIZE_CONVERSION_VALUE': return { strategy: 'MAXIMIZE_CONVERSION_VALUE', ...opt('targetRoas', c.targetRoas) }
    case 'TARGET_ROAS': return { strategy: 'TARGET_ROAS', ...opt('targetRoas', c.targetRoas) }
    default: return null
  }
}

/** Why a bidding change can make the campaign spend more, or null. */
export function typedBiddingSpends(from: TypedBidding | null, to: TypedBidding, currency: string): string | null {
  if (to.strategy === 'MANUAL_CPC' || to.strategy === 'MANUAL_CPM') return from && from.strategy !== to.strategy ? `${typedBiddingText(to, currency)} from now: the ad group bids set the cost` : null
  if (!from || from.strategy !== to.strategy) return `Google sets the bids from now (${typedBiddingText(to, currency)}): the cost per click or view can rise`
  // An optional limit taken off, or set higher; a required target set higher (CPA, CPC) or lower (ROAS).
  const loosened = (was: number | null | undefined, now: number | null | undefined) => !!was && (!now || now > was)
  switch (to.strategy) {
    case 'MAXIMIZE_CLICKS': return loosened(from.maxCpcCents, to.maxCpcCents) ? `Raises the max CPC ceiling ${money(from.maxCpcCents, currency)} → ${to.maxCpcCents ? money(to.maxCpcCents, currency) : 'no ceiling'}` : null
    case 'TARGET_CPC': return (to.targetCpcCents ?? 0) > (from.targetCpcCents ?? 0) ? `Raises the target CPC ${money(from.targetCpcCents, currency)} → ${money(to.targetCpcCents, currency)}` : null
    case 'MAXIMIZE_CONVERSIONS': return loosened(from.targetCpaCents, to.targetCpaCents) ? `Raises the target CPA ${money(from.targetCpaCents, currency)} → ${to.targetCpaCents ? money(to.targetCpaCents, currency) : 'none'}` : null
    case 'TARGET_CPA': return (to.targetCpaCents ?? 0) > (from.targetCpaCents ?? 0) ? `Raises the target CPA ${money(from.targetCpaCents, currency)} → ${money(to.targetCpaCents, currency)}` : null
    case 'MAXIMIZE_CONVERSION_VALUE': return from.targetRoas && (!to.targetRoas || to.targetRoas < from.targetRoas) ? `Lowers the target ROAS ${Math.round(from.targetRoas * 100)} % → ${to.targetRoas ? `${Math.round(to.targetRoas * 100)} %` : 'none'}` : null
    case 'TARGET_ROAS': return (to.targetRoas ?? 0) < (from.targetRoas ?? 0) ? `Lowers the target ROAS ${Math.round((from.targetRoas ?? 0) * 100)} % → ${Math.round((to.targetRoas ?? 0) * 100)} %` : null
    case 'PORTFOLIO': return from.portfolioId !== to.portfolioId ? `Moves to portfolio strategy ${to.portfolioId}: its targets decide the bids` : null
  }
}

// ── App goals ───────────────────────────────────────────────────────────────────────────────────────────────────

export const APP_GOALS = [
  'OPTIMIZE_INSTALLS_TARGET_INSTALL_COST', 'OPTIMIZE_INSTALLS_WITHOUT_TARGET_INSTALL_COST', 'OPTIMIZE_IN_APP_CONVERSIONS_TARGET_INSTALL_COST',
  'OPTIMIZE_IN_APP_CONVERSIONS_TARGET_CONVERSION_COST', 'OPTIMIZE_IN_APP_CONVERSIONS_WITHOUT_TARGET_CPA', 'OPTIMIZE_RETURN_ON_ADVERTISING_SPEND',
  'OPTIMIZE_TOTAL_VALUE_WITHOUT_TARGET_ROAS', 'OPTIMIZE_PRE_REGISTRATION_CONVERSION_VOLUME',
] as const
export type AppGoal = typeof APP_GOALS[number]
/** Each goal's bidding and conversion actions (docs/app-campaigns/create-campaign, its table of settings). */
const APP_GOAL_RULES: Record<AppGoal, { strategy: TypedStrategy; conversions: 'optional' | 'required' | 'none'; engagement?: boolean; preRegistration?: boolean; words: string }> = {
  OPTIMIZE_INSTALLS_TARGET_INSTALL_COST: { strategy: 'TARGET_CPA', conversions: 'optional', words: 'installs at a target cost per install' },
  OPTIMIZE_INSTALLS_WITHOUT_TARGET_INSTALL_COST: { strategy: 'MAXIMIZE_CONVERSIONS', conversions: 'optional', words: 'as many installs as the budget buys' },
  OPTIMIZE_IN_APP_CONVERSIONS_TARGET_INSTALL_COST: { strategy: 'TARGET_CPA', conversions: 'required', words: 'installs likely to act in the app, at a target cost per install' },
  OPTIMIZE_IN_APP_CONVERSIONS_TARGET_CONVERSION_COST: { strategy: 'TARGET_CPA', conversions: 'required', engagement: true, words: 'in-app actions at a target cost per action' },
  OPTIMIZE_IN_APP_CONVERSIONS_WITHOUT_TARGET_CPA: { strategy: 'MAXIMIZE_CONVERSIONS', conversions: 'required', words: 'as many in-app actions as the budget buys' },
  OPTIMIZE_RETURN_ON_ADVERTISING_SPEND: { strategy: 'TARGET_ROAS', conversions: 'required', words: 'in-app value at a target ROAS' },
  OPTIMIZE_TOTAL_VALUE_WITHOUT_TARGET_ROAS: { strategy: 'MAXIMIZE_CONVERSION_VALUE', conversions: 'required', words: 'as much in-app value as the budget buys' },
  OPTIMIZE_PRE_REGISTRATION_CONVERSION_VOLUME: { strategy: 'TARGET_CPA', conversions: 'none', preRegistration: true, words: 'pre-registrations on Google Play' },
}
export const APP_STORES = ['GOOGLE_APP_STORE', 'APPLE_APP_STORE'] as const
const ANDROID_APP = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/

export interface AppSettingsRequest {
  appId: string
  appStore: typeof APP_STORES[number]
  goal: AppGoal
  /** APP_CAMPAIGN_FOR_ENGAGEMENT: people who have the app (goal OPTIMIZE_IN_APP_CONVERSIONS_TARGET_CONVERSION_COST). */
  engagement?: boolean | null
  targetCpaCents?: number | null
  targetRoas?: number | null
  conversionActionIds?: string[] | null
}

// ── shared parts of a campaign and its ad groups ────────────────────────────────────────────────────────────────

export interface TypedAdGroupRequest {
  name: string
  /** Demand Gen: where the ads may show (default all channels). */
  channels?: ChannelControls | null
  /** Demand Gen and Display: Google's optimized targeting (off unless asked: Google then reaches beyond the targeting). */
  optimizedTargeting?: boolean | null
  /** Display with Manual CPC or Manual CPM: the ad group's bid. */
  defaultBidCents?: number | null
  /** The ad group's own target CPA (a Target CPA or Maximize conversions campaign; App: engagement campaigns only). */
  targetCpaCents?: number | null
  targeting?: TargetItem[] | null
  ads?: TypedAdRequest[] | null
}

const channelsBody = (c: ChannelControls) => ('strategy' in c
  ? { channelStrategy: c.strategy }
  // "Explicitly specify all fields when updating selected_channels."
  : { selectedChannels: Object.fromEntries(DG_CHANNELS.map((ch) => [DG_CHANNEL_FIELD[ch], c.selected.includes(ch)])) })
export const channelsText = (c: ChannelControls | null) => (!c ? 'all channels' : 'strategy' in c
  ? (c.strategy === 'ALL_CHANNELS' ? 'all channels' : 'Google\'s own channels (no Display Network)')
  : c.selected.map((ch) => ch.toLowerCase().replace(/_/g, ' ')).join(', '))
const channelSet = (c: ChannelControls | null): Set<DgChannel> =>
  new Set(!c || ('strategy' in c && c.strategy === 'ALL_CHANNELS') ? DG_CHANNELS : 'strategy' in c ? DG_CHANNELS.filter((ch) => ch !== 'DISPLAY') : c.selected)
function channelsProblem(c: ChannelControls | null | undefined): string | null {
  if (!c) return null
  if ('selected' in c && !c.selected.length) return 'pick at least one channel (Google needs one)'
  return null
}

interface GroupContext {
  kind: TypedKind
  /** The campaign's name (said in a Smart Bidding note). */
  campaignName: string
  subType: string | null
  currency: string
  bidding: TypedBidding | null
  names: TargetNames
  /** A Demand Gen campaign with a product feed: each ad group gets the root listing group (all products). */
  feed: boolean
  /** Demand Gen locations and languages every ad group of a new campaign gets (upgraded targeting). */
  dgDefaults: TargetItem[]
  /** A Demand Gen campaign without upgraded targeting: its locations and languages are the campaign's, not its ad groups'. */
  campaignPlaces?: boolean
}

interface MadeGroup { name: string; tag: string; status: 'ENABLED' | 'PAUSED'; ads: number }

/** One new ad group with its targeting and ads (into `campaignRes`), its problems said. */
function newAdGroup(
  ops: Ops, media: Media, campaignRes: string, g: TypedAdGroupRequest, status: 'ENABLED' | 'PAUSED', ctx: GroupContext,
  where: string, problems: string[], notes: string[], lines: Array<[string, unknown, unknown]>,
): MadeGroup | null {
  const before = problems.length
  const name = g.name.trim()
  if (!name) problems.push(`${where}: the ad group needs a name`)
  const res = `${ops.customer}/adGroups/${ops.temp()}`
  const body: Record<string, unknown> = { resourceName: res, campaign: campaignRes, name, status }
  if (ctx.kind === 'DISPLAY') body.type = 'DISPLAY_STANDARD'
  if (g.channels) {
    if (ctx.kind !== 'DEMAND_GEN') problems.push(`${where}: channel controls are for a Demand Gen ad group`)
    const p = channelsProblem(g.channels)
    if (p) problems.push(`${where}: ${p}`)
    body.demandGenAdGroupSettings = { channelControls: channelsBody(g.channels) }
  }
  if (ctx.kind === 'APP') {
    if (g.optimizedTargeting) problems.push(`${where}: optimized targeting is for Demand Gen and Display ad groups`)
  } else body.optimizedTargetingEnabled = g.optimizedTargeting === true
  if (g.defaultBidCents) {
    const manual = ctx.bidding?.strategy === 'MANUAL_CPC' || ctx.bidding?.strategy === 'MANUAL_CPM'
    if (ctx.kind !== 'DISPLAY' || !manual) problems.push(`${where}: an ad group bid (defaultBidCents) is for a Display campaign with Manual CPC or Manual CPM`)
    body[ctx.bidding?.strategy === 'MANUAL_CPM' ? 'cpmBidMicros' : 'cpcBidMicros'] = microsOfCents(g.defaultBidCents)
  } else if (ctx.kind === 'DISPLAY' && (ctx.bidding?.strategy === 'MANUAL_CPC' || ctx.bidding?.strategy === 'MANUAL_CPM')) {
    problems.push(`${where}: a ${ctx.bidding.strategy === 'MANUAL_CPM' ? 'Manual CPM' : 'Manual CPC'} ad group needs its bid (defaultBidCents)`)
  }
  if (g.targetCpaCents) {
    if (ctx.kind === 'APP' && ctx.subType !== 'APP_CAMPAIGN_FOR_ENGAGEMENT') problems.push(`${where}: an App campaign for installs takes no ad group bid (Google's rule); only an engagement campaign's ad group has its own target CPA`)
    if (ctx.kind !== 'APP' && ctx.bidding?.strategy !== 'TARGET_CPA' && ctx.bidding?.strategy !== 'MAXIMIZE_CONVERSIONS') problems.push(`${where}: an ad group target CPA is for a Target CPA or Maximize conversions campaign`)
    body.targetCpaMicros = microsOfCents(g.targetCpaCents)
  }
  const targets = checkTargets([...ctx.dgDefaults, ...(g.targeting ?? [])], ctx.kind, ctx.subType, ctx.names, where, problems)
  problems.push(...demographicProblems(where, targets, new Set(targets.map((t) => t.kind))))
  if (targets.some((t) => bidOf(t.bidModifier) !== null)) {
    const smart = smartBiddingWords({ name: ctx.campaignName, bidding: ctx.bidding?.strategy ?? null }, 'other')
    if (smart && !notes.includes(smart)) notes.push(smart)
  }
  if (targets.some((t) => t.kind === 'audience')) {
    if (targets.some((t) => SEGMENT_KIND[t.kind] && !t.exclude)) problems.push(`${where}: an ad group targets an Audience or audience segments, not both`)
    // AudienceInfo needs the ad group made audience-grouped (immutable after it is made): Demand Gen targeting and App
    // audience signals alike (docs/remarketing/audiences, "Ad group criterion": "Demand Gen and App campaigns support
    // adding an audience ad group criterion … to target audiences or provide audience signals … You must enable audience
    // targeting in the AdGroup by setting use_audience_grouped to true when the ad group is created").
    body.audienceSetting = { useAudienceGrouped: true }
  }
  if (ctx.campaignPlaces && targets.some((t) => t.kind === 'location' || t.kind === 'language')) {
    problems.push(`${where}: this Demand Gen campaign holds its locations and languages at the campaign, not its ad groups (set-google-campaign-type addCampaignTargeting)`)
  }
  if (ctx.kind === 'APP' && ctx.subType === 'APP_CAMPAIGN_FOR_ENGAGEMENT' && !targets.some((t) => t.kind === 'user-list')) {
    problems.push(`${where}: an App engagement ad group needs a user list (people who have the app; Google's rule)`)
  }
  const ads = g.ads ?? []
  if (!ads.length) notes.push(`${where}: no ads — it shows nothing until it has one.`)
  if (ads.length > MAX_ADS) problems.push(`${where}: at most ${MAX_ADS} ads in one ad group of a request`)
  const adBodies: Array<{ body: Record<string, unknown>; extra: Record<string, unknown>; label: string }> = []
  ads.forEach((ad, i) => {
    const type = adTypeOf(ctx.kind, ctx.subType, ad.type)
    if (typeof type !== 'string') { problems.push(`${where}, ad ${i + 1}: ${type.problem}`); return }
    const spec = AD_TYPES[type]
    if (type === 'DEMAND_GEN_PRODUCT_AD' && !ctx.feed) { problems.push(`${where}, ad ${i + 1}: a product ad needs the campaign's product feed (merchantId)`); return }
    const body2 = newAdBody(spec, ad, media, `${where}, ad ${i + 1}`, problems, notes)
    if (body2) adBodies.push({ body: body2, extra: adGroupAdAutomation(type, ad), label: adLabel(spec, ad) })
  })
  if (problems.length > before) return null
  ops.push({ adGroupOperation: { create: body } }, `group:${res}`)
  if (ctx.feed) ops.push({ adGroupCriterionOperation: { create: { adGroup: res, listingGroup: { type: 'UNIT' } } } })
  for (const t of targets) ops.push(criterionCreate(ops.customer, res, t))
  // Ads of a new ad group are ENABLED: the ad group's own status says whether they serve.
  for (const a of adBodies) ops.push({ adGroupAdOperation: { create: { adGroup: res, status: 'ENABLED', ad: a.body, ...a.extra } } })
  const settings = [
    ctx.kind === 'DEMAND_GEN' ? `channels: ${channelsText(g.channels ?? null)}` : null,
    ctx.kind !== 'APP' ? `optimized targeting ${g.optimizedTargeting ? 'ON' : 'off'}` : null,
    g.defaultBidCents ? `bid ${money(g.defaultBidCents, ctx.currency)}` : null,
    g.targetCpaCents ? `target CPA ${money(g.targetCpaCents, ctx.currency)}` : null,
    ctx.feed ? 'all products of the feed' : null,
  ].filter(Boolean)
  lines.push([`new ad group "${name}"`, '(none)', `${status}${settings.length ? ` · ${settings.join(' · ')}` : ''} · ${plural(targets.length, 'targeting item')} · ${plural(adBodies.length, 'ad')}`])
  for (const t of targets.slice(0, 5)) lines.push([`"${name}" targeting`, '(none)', targetWords(t, ctx.names)])
  for (const a of adBodies) lines.push([`"${name}" new ${a.label}`, '(none)', 'ENABLED'])
  if (g.optimizedTargeting) notes.push(`${where}: optimized targeting is ON — Google shows the ads beyond the targeting set here.`)
  return { name, tag: `group:${res}`, status, ads: adBodies.length }
}

// ── frequency caps ──────────────────────────────────────────────────────────────────────────────────────────────

/** A frequency cap as a person names it (defaults: per campaign, impressions, a time length of 1). */
export interface FrequencyCapRequest {
  events: number
  timeUnit: string
  timeLength?: number | null
  level?: string | null
  eventType?: string | null
}
const LEVEL_WORD: Record<string, string> = { CAMPAIGN: 'per campaign', AD_GROUP: 'per ad group', AD_GROUP_AD: 'per ad' }
const capText = (c: FrequencyCap) =>
  `${plural(c.events, c.eventType === 'VIDEO_VIEW' ? 'video view' : 'impression')} a ${c.timeLength > 1 ? `${c.timeLength} ` : ''}${c.timeUnit.toLowerCase()}${c.timeLength > 1 ? 's' : ''} ${LEVEL_WORD[c.level]}`
export const capsText = (caps: FrequencyCap[] | undefined) => (caps?.length ? caps.map(capText).join('; ') : 'none (no cap)')
const capBody = (c: FrequencyCap) => ({ key: { level: c.level, eventType: c.eventType, timeUnit: c.timeUnit, timeLength: c.timeLength }, cap: c.events })

/**
 * The caps a request names, as Google takes them (sorted by key), or the problems: Display and Demand Gen only, a Display
 * campaign caps impressions (Google Ads Help 117579), a cap of at least 1 (MAX_IMPRESSIONS_NOT_IN_RANGE), one cap per key.
 */
export function frequencyCapsOfRequest(kind: TypedKind, asked: FrequencyCapRequest[], problems: string[]): FrequencyCap[] {
  if (asked.length && kind === 'APP') { problems.push('frequency caps are for Display and Demand Gen campaigns (Google picks how often App ads show)'); return [] }
  const out: FrequencyCap[] = []
  for (const [i, a] of asked.entries()) {
    const where = `frequency cap ${i + 1}`
    const cap = {
      events: a.events, timeUnit: String(a.timeUnit ?? '').toUpperCase(), timeLength: a.timeLength ?? 1,
      level: String(a.level ?? 'CAMPAIGN').toUpperCase(), eventType: String(a.eventType ?? 'IMPRESSION').toUpperCase(),
    } as FrequencyCap
    if (!Number.isInteger(cap.events) || cap.events < 1) problems.push(`${where}: the cap is a whole number of at least 1 (Google's rule)`)
    if (!Number.isInteger(cap.timeLength) || cap.timeLength < 1) problems.push(`${where}: the time length is a whole number of at least 1`)
    if (!(FREQUENCY_UNITS as readonly string[]).includes(cap.timeUnit)) problems.push(`${where}: the time unit is ${FREQUENCY_UNITS.join(', ')}`)
    if (!(FREQUENCY_LEVELS as readonly string[]).includes(cap.level)) problems.push(`${where}: the level is ${FREQUENCY_LEVELS.join(', ')}`)
    if (!(FREQUENCY_EVENTS as readonly string[]).includes(cap.eventType)) problems.push(`${where}: the event is ${FREQUENCY_EVENTS.join(', ')}`)
    if (kind === 'DISPLAY' && cap.eventType !== 'IMPRESSION') problems.push(`${where}: a Display campaign caps impressions (Google Ads Help 117579)`)
    if (out.some((x) => frequencyKey(x) === frequencyKey(cap))) problems.push(`${where}: two caps of one key (${capText(cap)}): Google takes one`)
    out.push(cap)
  }
  return out.sort((a, b) => frequencyKey(a).localeCompare(frequencyKey(b)))
}

/** Why new caps let the same people see the ads more often: a cap taken away, or one raised (each a sentence). */
export function frequencyCapsSpend(from: FrequencyCap[], to: FrequencyCap[]): string[] {
  const out: string[] = []
  for (const f of from) {
    const t = to.find((x) => frequencyKey(x) === frequencyKey(f))
    if (!t) out.push(`Takes the frequency cap "${capText(f)}" away — the same people can see the ads more often`)
    else if (t.events > f.events) out.push(`Raises the frequency cap ${capText(f)} → ${t.events}`)
  }
  return out
}

// ── create ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TypedCampaignCreateRequest {
  kind: TypedKind
  name: string
  dailyBudgetCents?: number | null
  /** Demand Gen: a budget for the whole campaign (needs startDate and endDate). */
  totalBudgetCents?: number | null
  /** Display: an existing SHARED budget. */
  budgetId?: string | null
  /** Demand Gen and Display (App bidding follows its goal). */
  bidding?: TypedBidding | null
  startDate?: string | null
  endDate?: string | null
  /** Display and App: the campaign's locations; Demand Gen: each ad group gets them. */
  locations?: Array<{ id: string; exclude?: boolean | null }> | null
  languages?: string[] | null
  /** Content labels the ads never show next to (ContentLabelType). */
  excludedContent?: string[] | null
  euPoliticalAds?: boolean | null
  /** Demand Gen: a Merchant Center feed for product ads. */
  merchant?: { merchantId: string; feedLabel?: string | null } | null
  app?: AppSettingsRequest | null
  /** Display and Demand Gen: how often one person may see the ads. */
  frequencyCaps?: FrequencyCapRequest[] | null
  adGroups: TypedAdGroupRequest[]
}

export interface TypedCreateLive {
  campaignNames: string[]
  /** Display: the shared budget named, if any (null when not in the account). */
  sharedBudget: { budgetId: string; name: string | null; amountCents: number | null; shared: boolean } | null
  names: TargetNames
  media: MediaLive
}

export interface TypedCreateRecord {
  kind: TypedKind
  campaignId: string | null
  name: string
  ownBudgetId?: string | null
  adGroups: Array<{ name: string; adGroupId: string | null; op: number }>
  assets: NewAssetEntry[]
  ops: { campaign: number; budget?: number; assets: number[] }
}

const appSubType = (a: AppSettingsRequest) => (APP_GOAL_RULES[a.goal].preRegistration ? 'APP_CAMPAIGN_FOR_PRE_REGISTRATION' : a.engagement ? 'APP_CAMPAIGN_FOR_ENGAGEMENT' : 'APP_CAMPAIGN')

function appProblems(customer: string, a: AppSettingsRequest, problems: string[]): { bidding: TypedBidding; fields: Record<string, unknown> } | null {
  const rule = APP_GOAL_RULES[a.goal]
  const before = problems.length
  const appId = a.appId.trim()
  if (a.appStore === 'APPLE_APP_STORE' ? !/^\d{1,20}$/.test(appId) : !ANDROID_APP.test(appId)) {
    problems.push(`app "${appId}" is not ${a.appStore === 'APPLE_APP_STORE' ? 'an App Store id (digits)' : 'a Google Play package name (e.g. com.example.app)'}`)
  }
  if (a.engagement && !rule.engagement) problems.push('an App engagement campaign optimizes for in-app actions at a target cost (goal OPTIMIZE_IN_APP_CONVERSIONS_TARGET_CONVERSION_COST)')
  if (rule.preRegistration && a.appStore !== 'GOOGLE_APP_STORE') problems.push('pre-registration campaigns are for apps on Google Play')
  const conversions = (a.conversionActionIds ?? []).map((id) => id.trim())
  if (conversions.some((id) => !GOOGLE_ID.test(id))) problems.push('a conversion action id is not a Google id')
  if ((rule.conversions === 'required' || a.engagement) && !conversions.length) problems.push(`goal ${a.goal} needs the conversion actions to optimize for (conversionActionIds; Google's rule)`)
  if (rule.conversions === 'none' && conversions.length) problems.push('a pre-registration campaign gets its conversion actions from Google (none can be given)')
  const bidding: TypedBidding = { strategy: rule.strategy, ...(rule.strategy === 'TARGET_CPA' ? { targetCpaCents: a.targetCpaCents ?? null } : {}), ...(rule.strategy === 'TARGET_ROAS' ? { targetRoas: a.targetRoas ?? null } : {}) }
  const p = typedBiddingProblem(bidding)
  if (p) problems.push(`goal ${a.goal}: ${p}`)
  if (rule.strategy !== 'TARGET_CPA' && a.targetCpaCents) problems.push(`goal ${a.goal} takes no target CPA`)
  if (rule.strategy !== 'TARGET_ROAS' && a.targetRoas) problems.push(`goal ${a.goal} takes no target ROAS`)
  if (problems.length > before) return null
  return {
    bidding: typedBiddingClean(bidding),
    fields: {
      advertisingChannelSubType: appSubType(a),
      appCampaignSetting: { appId, appStore: a.appStore, biddingStrategyGoalType: a.goal },
      ...(conversions.length ? { selectiveOptimization: { conversionActions: conversions.map((id) => `${customer}/conversionActions/${id}`) } } : {}),
      ...(rule.preRegistration ? { optimizationGoalSetting: { optimizationGoalTypes: ['APP_PRE_REGISTRATION'] } } : {}),
    },
  }
}

const dayProblem = (d: string | null | undefined) => (d && (!DAY.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) ? `"${d}" is not a day (YYYY-MM-DD)` : null)

export function typedCreateDraft(customer: string, currency: string, r: TypedCampaignCreateRequest, live: TypedCreateLive): GoogleChangeDraft | { refusal: string } {
  const problems: string[] = []
  const notes: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const name = r.name.trim()
  if (!name) problems.push('the campaign needs a name')
  if (live.campaignNames.some((n) => n.trim().toLowerCase() === name.toLowerCase())) problems.push(`a campaign named "${name}" already exists in this account: Google refuses a second one`)
  const ops = new Ops(customer)
  const media = new Media(ops, live.media, problems)

  // Budget: Demand Gen and App only their own (non-shared); Display its own or a shared one.
  const budgets = [r.dailyBudgetCents, r.totalBudgetCents, r.budgetId].filter((x) => x !== undefined && x !== null && x !== '').length
  if (budgets !== 1) problems.push(r.kind === 'DEMAND_GEN' ? 'give dailyBudgetCents or totalBudgetCents (one of them)' : r.kind === 'DISPLAY' ? 'give dailyBudgetCents or budgetId (a shared budget), one of them' : 'give dailyBudgetCents')
  if (r.totalBudgetCents && r.kind !== 'DEMAND_GEN') problems.push('a campaign total budget is for Demand Gen')
  if (r.totalBudgetCents && (!r.startDate || !r.endDate)) problems.push('a campaign total budget needs startDate and endDate (Google\'s rule)')
  if (r.budgetId && r.kind !== 'DISPLAY') problems.push(`a ${KIND_WORD[r.kind]} campaign cannot use a shared budget (Google's rule): give dailyBudgetCents`)
  if (r.budgetId && (!live.sharedBudget || !live.sharedBudget.shared)) problems.push(`budget ${r.budgetId} is not a shared budget of this account`)
  for (const d of [r.startDate, r.endDate]) { const p = dayProblem(d); if (p) problems.push(p) }
  if (r.startDate && r.endDate && r.endDate < r.startDate) problems.push('the end date is before the start date')

  // Bidding.
  let bidding: TypedBidding | null = null
  let appFields: Record<string, unknown> = {}
  if (r.kind === 'APP') {
    if (r.bidding) problems.push('an App campaign\'s bidding follows its goal (app.goal, targetCpaCents or targetRoas): give no bidding')
    if (!r.app) problems.push('an App campaign needs app (appId, appStore, goal)')
    else { const got = appProblems(customer, r.app, problems); if (got) { bidding = got.bidding; appFields = got.fields } }
  } else {
    if (r.app) problems.push('app settings are for an App campaign')
    if (!r.bidding && r.kind === 'DEMAND_GEN') problems.push(`say how the Demand Gen campaign bids (bidding: ${STRATEGIES_OF.DEMAND_GEN.join(', ')})`)
    const asked = r.bidding ?? { strategy: r.kind === 'DISPLAY' ? 'MANUAL_CPC' : 'MAXIMIZE_CLICKS' } as TypedBidding
    if (!STRATEGIES_OF[r.kind].includes(asked.strategy)) problems.push(`a ${KIND_WORD[r.kind]} campaign bids with ${STRATEGIES_OF[r.kind].join(', ')}`)
    const p = typedBiddingProblem(asked)
    if (p) problems.push(p)
    bidding = typedBiddingClean(asked)
  }
  if (r.merchant && r.kind !== 'DEMAND_GEN') problems.push('a product feed (merchant) is for a Demand Gen campaign here')
  if (r.merchant && !GOOGLE_ID.test(r.merchant.merchantId.trim())) problems.push('merchantId is not a Merchant Center id (digits)')
  if (r.merchant?.feedLabel && !/^[A-Z0-9_-]{1,20}$/.test(r.merchant.feedLabel)) problems.push(`the feed label "${r.merchant.feedLabel}" is not one Google takes (up to 20 of A–Z, 0–9, - and _)`)
  if (r.excludedContent?.length && r.kind === 'APP') problems.push('content exclusions are for Demand Gen and Display campaigns')
  const caps = frequencyCapsOfRequest(r.kind, r.frequencyCaps ?? [], problems)
  if (!r.adGroups.length) problems.push('a campaign needs at least one ad group (with its ads)')
  if (r.adGroups.length > MAX_AD_GROUPS) problems.push(`at most ${MAX_AD_GROUPS} ad groups in one request`)

  // The campaign.
  const budgetRes = r.budgetId ? `${customer}/campaignBudgets/${r.budgetId.trim()}` : `${customer}/campaignBudgets/${ops.temp()}`
  const campaignRes = `${customer}/campaigns/${ops.temp()}`
  if (!r.budgetId) {
    ops.push({ campaignBudgetOperation: { create: {
      resourceName: budgetRes, explicitlyShared: false, deliveryMethod: 'STANDARD',
      ...(r.totalBudgetCents ? { totalAmountMicros: microsOfCents(r.totalBudgetCents), period: 'CUSTOM_PERIOD' } : { amountMicros: microsOfCents(r.dailyBudgetCents ?? 0) }),
    } } }, 'budget')
  }
  const channelType = r.kind === 'APP' ? 'MULTI_CHANNEL' : r.kind
  ops.push({ campaignOperation: { create: {
    resourceName: campaignRes,
    name,
    // Never ENABLED by Nexus: Google's default is ENABLED, so it is said every time.
    status: 'PAUSED',
    advertisingChannelType: channelType,
    campaignBudget: budgetRes,
    ...(bidding ? typedBiddingFields(customer, bidding) : {}),
    ...appFields,
    ...(r.merchant ? { shoppingSetting: { merchantId: r.merchant.merchantId.trim(), ...(r.merchant.feedLabel ? { feedLabel: r.merchant.feedLabel } : {}) } } : {}),
    ...(r.kind === 'DISPLAY' ? { geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' } } : {}),
    containsEuPoliticalAdvertising: r.euPoliticalAds ? 'CONTAINS_EU_POLITICAL_ADVERTISING' : 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    ...(r.startDate ? { startDateTime: `${r.startDate} 00:00:00` } : {}),
    ...(r.endDate ? { endDateTime: `${r.endDate} 23:59:59` } : {}),
    ...(caps.length ? { frequencyCaps: caps.map(capBody) } : {}),
  } } }, 'campaign')

  // Locations and languages: the campaign's (Display, App), or every ad group's (Demand Gen: upgraded targeting).
  const places: TargetItem[] = [
    ...(r.locations ?? []).map((l) => ({ kind: 'location' as const, value: l.id, exclude: l.exclude === true })),
    ...(r.languages ?? []).map((id) => ({ kind: 'language' as const, value: id })),
  ]
  const placeItems: TargetItem[] = []
  for (const p of places) {
    const n = normalizeTarget(p)
    if ('problem' in n) problems.push(n.problem)
    else if (!placeItems.some((x) => targetKey(x) === targetKey(n))) placeItems.push(n)
  }
  if (r.kind !== 'DEMAND_GEN') {
    for (const p of placeItems) ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, ...(p.exclude ? { negative: true } : {}), ...targetInfo(customer, p) } } })
  }
  for (const label of r.excludedContent ?? []) {
    const n = normalizeExclusion({ kind: 'content-label', value: label })
    if ('problem' in n) { problems.push(n.problem); continue }
    ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, negative: true, ...exclusionInfo(n) } } })
  }

  const subType = r.kind === 'APP' && r.app ? appSubType(r.app) : null
  const ctx: GroupContext = { kind: r.kind, campaignName: name, subType, currency, bidding, names: live.names, feed: !!r.merchant, dgDefaults: r.kind === 'DEMAND_GEN' ? placeItems : [] }
  const groups: MadeGroup[] = []
  const groupLines: Array<[string, unknown, unknown]> = []
  const groupNames = new Set<string>()
  r.adGroups.forEach((g, i) => {
    const where = `ad group ${i + 1} "${g.name.trim()}"`
    if (groupNames.has(g.name.trim().toLowerCase())) { problems.push(`${where}: two ad groups of the campaign have this name`); return }
    groupNames.add(g.name.trim().toLowerCase())
    const made = newAdGroup(ops, media, campaignRes, g, 'ENABLED', ctx, where, problems, notes, groupLines)
    if (made) groups.push(made)
  })

  if (problems.length) return { refusal: `The ${KIND_WORD[r.kind]} campaign cannot be sent as it is (${plural(problems.length, 'problem')}): ${problems.slice(0, 25).join(' · ')}${problems.length > 25 ? ` · … ${problems.length - 25} more` : ''}. Nothing was sent.` }
  if (ops.size > MAX_TYPED_OPERATIONS) return { refusal: `This holds ${ops.size} operations, more than the ${MAX_TYPED_OPERATIONS} one request sends: make it with fewer ad groups or ads, and add the rest with add-google-campaign-type-ads.` }

  const { operations, at } = ops.ordered()
  const budgetText = r.budgetId
    ? `shared "${live.sharedBudget?.name ?? r.budgetId}" ${money(live.sharedBudget?.amountCents, currency)} a day`
    : r.totalBudgetCents ? `${money(r.totalBudgetCents, currency)} for the whole campaign (${r.startDate} → ${r.endDate})` : `its own ${money(r.dailyBudgetCents, currency)} a day`
  lines.push(
    ['new campaign', '(none)', `"${name}" · ${KIND_WORD[r.kind]}${subType ? ` (${subType})` : ''} · PAUSED`],
    ['budget', '(none)', budgetText],
    ['bidding', '(none)', r.app ? `${typedBiddingText(bidding!, currency)} — ${APP_GOAL_RULES[r.app.goal].words}` : typedBiddingText(bidding!, currency)],
  )
  if (r.app) lines.push(['app', '(none)', `${r.app.appStore === 'APPLE_APP_STORE' ? 'App Store' : 'Google Play'} ${r.app.appId.trim()}${r.app.conversionActionIds?.length ? ` · optimizes for ${plural(r.app.conversionActionIds.length, 'conversion action')}` : ''}`])
  if (r.merchant) lines.push(['product feed', '(none)', `Merchant Center ${r.merchant.merchantId.trim()}${r.merchant.feedLabel ? `, feed label ${r.merchant.feedLabel}` : ''}`])
  lines.push(['locations', '(none)', `${placeItems.filter((p) => p.kind === 'location' && !p.exclude).length} targeted, ${placeItems.filter((p) => p.kind === 'location' && p.exclude).length} excluded${r.kind === 'DEMAND_GEN' ? ' (set on every ad group)' : ''}`])
  lines.push(['languages', '(none)', placeItems.filter((p) => p.kind === 'language').map((p) => p.value).join(', ') || 'all'])
  if (r.excludedContent?.length) lines.push(['content exclusions', '(none)', r.excludedContent.map((c) => c.toUpperCase()).join(', ')])
  if (caps.length) lines.push(['frequency caps', '(none)', capsText(caps)])
  lines.push(['dates', '(none)', `${r.startDate ?? 'starts when enabled'} → ${r.endDate ?? 'no end'}`])
  lines.push(...groupLines)
  for (const a of media.created.slice(0, 5)) lines.push(['new asset', '(none)', a.text])

  const warnings = [
    `It is made PAUSED: nothing spends until a person enables it (set-google-status, SPENDS MONEY). Once enabled it spends up to ${r.totalBudgetCents ? `${money(r.totalBudgetCents, currency)} over the campaign` : `${money(r.budgetId ? live.sharedBudget?.amountCents : r.dailyBudgetCents, currency)} a day${r.budgetId ? ' (shared with the other campaigns on that budget)' : ''}`}.`,
    ...(!placeItems.some((p) => p.kind === 'location' && !p.exclude) ? [`"${name}" targets no location: when enabled it can show in every country.`] : []),
    ...(r.kind === 'DEMAND_GEN' ? ['Demand Gen: Google refuses a daily budget below its minimum for the currency, and asks for Demand Gen\'s image and video quality rules (YouTube, Discover, Gmail).'] : []),
    ...(r.kind === 'APP' ? ['App campaigns: Google picks where the ads show (Search, Play, YouTube, Display, AdMob) and combines the texts, images and videos itself.'] : []),
    ...notes,
    ...(media.created.some((a) => a.type === 'IMAGE') ? ['Google reviews each new image before it serves; an image the account already has is that asset again (Google keeps one). Google never removes an asset: an undo leaves the new assets in the account, unused.'] : []),
  ]
  const totals: Record<string, number> = { operations: operations.length, adGroups: groups.length, ads: groups.reduce((s, g) => s + g.ads, 0), newAssets: media.created.length }
  const { changes, more } = changeLines(lines)
  if (more) totals.linesNotShown = more
  const record: TypedCreateRecord = {
    kind: r.kind, campaignId: null, name,
    ...(r.budgetId ? {} : { ownBudgetId: null }),
    adGroups: groups.map((g) => ({ name: g.name, adGroupId: null, op: at(g.tag) })),
    assets: media.created.map(({ tag, ...a }) => ({ ...a, assetId: `op:${at(tag)}` })),
    ops: { campaign: at('campaign'), ...(r.budgetId ? {} : { budget: at('budget') }), assets: media.created.map((a) => at(a.tag)) },
  }
  return {
    summary: `Google Ads: make the ${KIND_WORD[r.kind]} campaign "${name}", PAUSED, with ${plural(groups.length, 'ad group')} and ${plural(totals.ads, 'ad')} — in one request.`,
    changes,
    totals,
    warnings,
    spendsMoney: [],
    skipped: [],
    operations,
    stands: {
      names: live.campaignNames.map((n) => n.trim().toLowerCase()).filter((n) => n === name.toLowerCase()),
      budget: r.budgetId ? live.sharedBudget : null,
      assets: live.media.assets.map((a) => `${a.assetId}:${a.type ?? ''}:${a.width ?? ''}x${a.height ?? ''}`).sort(),
      youtube: live.media.youtube.map((a) => `${a.youtubeVideoId}:${a.assetId}`).sort(),
      images: media.created.filter((a) => a.sha256).map((a) => a.sha256!).sort(),
      targets: Object.keys(live.names).sort(),
    },
    before: null,
    after: record,
  }
}

const idAt = (responses: GoogleMutateResponse[], op: number | undefined, kind: string): string | null => {
  if (op === undefined || op < 0) return null
  const name = responses[op]?.[kind]?.resourceName
  return name ? name.slice(name.lastIndexOf('/') + 1) : null
}

/** The record of a create, with the ids Google gave the campaign, its own budget, its ad groups and the new assets. */
export function typedCreateRecordAfterRun(after: TypedCreateRecord, responses: GoogleMutateResponse[]): TypedCreateRecord {
  return {
    ...after,
    campaignId: idAt(responses, after.ops.campaign, 'campaignResult'),
    ...('ownBudgetId' in after ? { ownBudgetId: idAt(responses, after.ops.budget, 'campaignBudgetResult') } : {}),
    adGroups: after.adGroups.map((g) => ({ ...g, adGroupId: idAt(responses, g.op, 'adGroupResult') })),
    assets: after.assets.map((a, i) => ({ ...a, assetId: idAt(responses, after.ops.assets[i], 'assetResult') ?? a.assetId })),
  }
}

// ── add ad groups and ads to an existing campaign ───────────────────────────────────────────────────────────────

export interface TypedAddRequest {
  campaignId: string
  adGroups?: TypedAdGroupRequest[] | null
  /** New ads in existing ad groups of the campaign. */
  addAds?: Array<{ adGroupId: string; ads: TypedAdRequest[] }> | null
  /** Make what is new ENABLED where it would serve at once (SPENDS MONEY); without it, PAUSED there. */
  enable?: boolean | null
}

export interface TypedAddLive {
  campaign: LiveTypedCampaign | null
  adGroups: LiveTypedAdGroup[]
  /** Demand Gen: the locations and languages of the campaign's ad groups (a new ad group without its own takes theirs). */
  criteria?: LiveTypedCriterion[]
  names: TargetNames
  media: MediaLive
}

/**
 * The locations and languages a new Demand Gen ad group gets when it names no targeted location: those every ad group
 * of the campaign shares (Demand Gen holds them at the ad group, so a new ad group without any would show in every
 * country). Refused when the campaign has no ad group, or its ad groups differ.
 */
function sharedPlaces(adGroups: LiveTypedAdGroup[], criteria: LiveTypedCriterion[]): { items: TargetItem[]; byGroup: string[] } | { problem: string } {
  const placesOf = (adGroupId: string) => criteria
    .filter((x) => x.adGroupId === adGroupId && (x.kind === 'location' || x.kind === 'language'))
    .map((x) => ({ kind: x.kind as TargetKind, value: x.value, exclude: x.exclude }))
    .sort((a, b) => targetKey(a).localeCompare(targetKey(b)))
  if (!adGroups.length) return { problem: 'the campaign has no ad group to take locations from: give location items (targeting kind location) — a Demand Gen ad group without one shows in every country' }
  const sets = adGroups.map((g) => placesOf(g.adGroupId))
  const byGroup = adGroups.map((g, i) => `${g.adGroupId}:${sets[i].map(targetKey).join('|')}`).sort()
  if (new Set(sets.map((set) => set.map(targetKey).join('|'))).size > 1) {
    return { problem: 'the campaign\'s ad groups target different locations and languages: give location items (targeting kind location) for it — it then targets exactly those' }
  }
  return { items: sets[0], byGroup }
}
const placesText = (items: TargetItem[]) => {
  const words = items.filter((t) => t.kind === 'location').map((t) => `${t.exclude ? 'not ' : ''}${t.value}`)
  return words.length ? `locations ${words.join(', ')}` : 'no location (every country)'
}

export interface TypedAddRecord {
  campaignId: string
  adGroups: Array<{ name: string; adGroupId: string | null; status: string; op: number }>
  /** New ads in existing ad groups (ads of new ad groups go with them). */
  ads: Array<{ adGroupId: string; adId: string | null; op: number }>
  assets: NewAssetEntry[]
  assetOps: number[]
}

const servingNote = (c: { status: string | null }) => (c.status === 'ENABLED' ? '' : ' (the campaign is paused: nothing spends until it is enabled)')

export function typedAddDraft(customer: string, currency: string, r: TypedAddRequest, live: TypedAddLive): GoogleChangeDraft | { refusal: string } {
  const c = live.campaign
  if (!c) return { refusal: `Campaign ${r.campaignId} is not in this account (or it is removed).` }
  const kind = kindOfChannel(c.type)
  if (!kind) return { refusal: `"${c.name}" is a ${c.type ?? 'campaign'} campaign: this tool adds ad groups and ads to Demand Gen, Display and App campaigns${c.type === 'VIDEO' ? ' (Google\'s API cannot add to a Video campaign: docs/video/overview)' : ''}.` }
  if (!r.adGroups?.length && !r.addAds?.length) return { refusal: 'Name new adGroups, or addAds (new ads in existing ad groups).' }
  const problems: string[] = []
  const notes: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const ops = new Ops(customer)
  const media = new Media(ops, live.media, problems)
  const campaignRes = `${customer}/campaigns/${c.campaignId}`
  const serving = c.status === 'ENABLED'
  const groupStatus: 'ENABLED' | 'PAUSED' = serving && !r.enable ? 'PAUSED' : 'ENABLED'
  const dgGroupPlaces = kind === 'DEMAND_GEN' && c.upgradedTargeting
  const ctx: GroupContext = {
    kind, campaignName: c.name, subType: c.subType, currency, bidding: typedBiddingNow(c), names: live.names, feed: kind === 'DEMAND_GEN' && !!c.merchantId, dgDefaults: [],
    campaignPlaces: kind === 'DEMAND_GEN' && !c.upgradedTargeting,
  }
  const ownLocation = (g: TypedAdGroupRequest) => (g.targeting ?? []).some((t) => t.kind === 'location' && !t.exclude)
  const shared = dgGroupPlaces && (r.adGroups ?? []).some((g) => !ownLocation(g)) ? sharedPlaces(live.adGroups, live.criteria ?? []) : null
  const taken = new Set(live.adGroups.map((g) => g.name.trim().toLowerCase()))
  const groups: MadeGroup[] = []
  if ((r.adGroups ?? []).length > MAX_AD_GROUPS) problems.push(`at most ${MAX_AD_GROUPS} new ad groups in one request`)
  for (const [i, asked] of (r.adGroups ?? []).entries()) {
    const where = `new ad group ${i + 1} "${asked.name.trim()}"`
    if (taken.has(asked.name.trim().toLowerCase())) { problems.push(`${where}: the campaign has an ad group of this name`); continue }
    taken.add(asked.name.trim().toLowerCase())
    let g = asked
    if (dgGroupPlaces) {
      // Demand Gen holds locations at the ad group: one without its own takes those the campaign's ad groups share.
      if (!ownLocation(asked)) {
        if (!shared || 'problem' in shared) { problems.push(`${where}: ${shared && 'problem' in shared ? shared.problem : 'give location items'}`); continue }
        g = { ...asked, targeting: [...shared.items, ...(asked.targeting ?? [])] }
        lines.push([`"${asked.name.trim()}" locations`, '(none)', `${placesText(shared.items)} (as the campaign's other ad groups)`])
        if (!shared.items.some((t) => t.kind === 'location' && !t.exclude)) notes.push(`${where}: it targets no location, like the campaign's other ad groups — when it serves it can show in every country.`)
      } else {
        lines.push([`"${asked.name.trim()}" locations`, '(none)', placesText((asked.targeting ?? []).filter((t) => t.kind === 'location'))])
      }
    }
    const made = newAdGroup(ops, media, campaignRes, g, groupStatus, ctx, where, problems, notes, lines)
    if (!made) continue
    groups.push(made)
    if (serving && groupStatus === 'ENABLED') spends.push(`Adds the ENABLED ad group "${made.name}" to the ENABLED campaign "${c.name}": its ${plural(made.ads, 'ad')} can serve at once.`)
  }
  const newAds: Array<{ adGroupId: string; tag: string }> = []
  for (const [i, a] of (r.addAds ?? []).entries()) {
    const where = `ads for ad group ${a.adGroupId}`
    const g = live.adGroups.find((x) => x.adGroupId === a.adGroupId)
    if (!g) { problems.push(`${where}: ad group ${a.adGroupId} is not in campaign "${c.name}" (or it is removed)`); continue }
    if (!a.ads.length) { problems.push(`${where}: no ads given`); continue }
    if (a.ads.length > MAX_ADS) { problems.push(`${where}: at most ${MAX_ADS} ads in one ad group of a request`); continue }
    const groupServes = serving && g.status === 'ENABLED'
    const status: 'ENABLED' | 'PAUSED' = groupServes && !r.enable ? 'PAUSED' : 'ENABLED'
    a.ads.forEach((ad, j) => {
      const type = adTypeOf(kind, c.subType, ad.type)
      if (typeof type !== 'string') { problems.push(`${where}, ad ${j + 1}: ${type.problem}`); return }
      const spec = AD_TYPES[type]
      if (type === 'DEMAND_GEN_PRODUCT_AD' && !ctx.feed) { problems.push(`${where}, ad ${j + 1}: a product ad needs the campaign's product feed`); return }
      const body = newAdBody(spec, ad, media, `${where}, ad ${j + 1}`, problems, notes)
      if (!body) return
      const tag = `ad:${g.adGroupId}:${i}:${j}`
      ops.push({ adGroupAdOperation: { create: { adGroup: `${customer}/adGroups/${g.adGroupId}`, status, ad: body, ...adGroupAdAutomation(type, ad) } } }, tag)
      newAds.push({ adGroupId: g.adGroupId, tag })
      lines.push([`ad group "${g.name}" new ${adLabel(spec, ad)}`, '(none)', status])
      if (groupServes && status === 'ENABLED') spends.push(`Adds an ENABLED ${spec.word} to "${g.name}", which serves now: it can serve at once.`)
    })
  }
  if (problems.length) return { refusal: `Not queued (${plural(problems.length, 'problem')}): ${problems.slice(0, 25).join(' · ')}${problems.length > 25 ? ` · … ${problems.length - 25} more` : ''}. Nothing was sent.` }
  if (ops.size > MAX_TYPED_OPERATIONS) return { refusal: `This holds ${ops.size} operations, more than the ${MAX_TYPED_OPERATIONS} one request sends: ask in parts.` }
  const { operations, at } = ops.ordered()
  for (const a of media.created.slice(0, 5)) lines.push(['new asset', '(none)', a.text])
  const pausedForSafety = serving && !r.enable && (groups.length || newAds.length)
  const warnings = [
    ...(pausedForSafety ? [`"${c.name}" is ENABLED: what this adds is made PAUSED so nothing spends by itself. Ask again with enable: true to make it serve at once (SPENDS MONEY), or enable it later with set-google-status.`] : []),
    ...(!serving ? [`"${c.name}" is not enabled: nothing serves until a person enables it (set-google-status, SPENDS MONEY).`] : []),
    ...notes,
    ...(media.created.length ? ['Google reviews each new image before it serves. Google never removes an asset: an undo leaves the new assets in the account, unused.'] : []),
  ]
  const { changes, more } = changeLines(lines)
  const record: TypedAddRecord = {
    campaignId: c.campaignId,
    adGroups: groups.map((g) => ({ name: g.name, adGroupId: null, status: g.status, op: at(g.tag) })),
    ads: newAds.map((a) => ({ adGroupId: a.adGroupId, adId: null, op: at(a.tag) })),
    assets: media.created.map(({ tag, ...a }) => ({ ...a, assetId: `op:${at(tag)}` })),
    assetOps: media.created.map((a) => at(a.tag)),
  }
  return {
    summary: `Google Ads ${KIND_WORD[kind]} campaign "${c.name}": add ${[groups.length && plural(groups.length, 'ad group'), newAds.length && `${plural(newAds.length, 'ad')} in existing ad groups`].filter(Boolean).join(' and ')}${servingNote(c)}.`,
    changes,
    totals: { operations: operations.length, adGroups: groups.length, ads: groups.reduce((s, g) => s + g.ads, 0) + newAds.length, newAssets: media.created.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped: [],
    operations,
    stands: {
      campaign: `${c.campaignId}:${c.status}:${c.type}:${c.subType ?? ''}:${c.merchantId ?? ''}`,
      adGroups: live.adGroups.map((g) => `${g.adGroupId}:${g.name.trim().toLowerCase()}:${g.status}`).sort(),
      assets: live.media.assets.map((a) => `${a.assetId}:${a.type ?? ''}:${a.width ?? ''}x${a.height ?? ''}`).sort(),
      youtube: live.media.youtube.map((a) => `${a.youtubeVideoId}:${a.assetId}`).sort(),
      images: media.created.filter((a) => a.sha256).map((a) => a.sha256!).sort(),
      names: Object.keys(live.names).sort(),
      places: shared && !('problem' in shared) ? shared.byGroup : null,
    },
    before: { campaignId: c.campaignId, adGroups: [], ads: [] },
    after: record,
  }
}

export function typedAddRecordAfterRun(after: TypedAddRecord, responses: GoogleMutateResponse[]): TypedAddRecord {
  const adIdAt = (op: number) => {
    const name = op >= 0 ? responses[op]?.adGroupAdResult?.resourceName : undefined
    return name ? name.slice(name.lastIndexOf('~') + 1) : null
  }
  return {
    ...after,
    adGroups: after.adGroups.map((g) => ({ ...g, adGroupId: idAt(responses, g.op, 'adGroupResult') })),
    ads: after.ads.map((a) => ({ ...a, adId: adIdAt(a.op) })),
    assets: after.assets.map((a, i) => ({ ...a, assetId: idAt(responses, after.assetOps[i], 'assetResult') ?? a.assetId })),
  }
}

// ── settings and targeting of an existing campaign ──────────────────────────────────────────────────────────────

export interface TypedCampaignSettings {
  name?: string
  startDate?: string
  /** A day, or 'none' (runs on). */
  endDate?: string
  bidding?: TypedBidding
  /** The campaign's OWN budget: its daily amount, or (a campaign total budget) the total. */
  budgetCents?: number
  /** Display and Demand Gen: the WHOLE list of frequency caps ([] = none). */
  frequencyCaps?: FrequencyCap[]
}
export interface TypedAdGroupSettings {
  name?: string
  channels?: ChannelControls
  optimizedTargeting?: boolean
  /** Display Manual CPC / CPM bid; null clears nothing (Google needs a bid there). */
  defaultBidCents?: number
  /** The ad group's own target CPA; 0 takes it off (the campaign's then applies). */
  targetCpaCents?: number
}
export interface TypedSettingsRequest extends Omit<TypedCampaignSettings, 'frequencyCaps'> {
  campaignId: string
  /** Display and Demand Gen: the WHOLE list of frequency caps as it should be ([] takes every cap away). */
  frequencyCaps?: FrequencyCapRequest[]
  /** Display and App: the campaign's own locations and languages (Demand Gen holds them at its ad groups). */
  addCampaignTargeting?: TargetItem[] | null
  removeCampaignTargeting?: TargetItem[] | null
  adGroups?: Array<TypedAdGroupSettings & { adGroupId: string; addTargeting?: TargetItem[] | null; removeTargeting?: TargetItem[] | null }> | null
}
/** A campaign's location or language criterion. */
export interface CampaignPlace { criterionId: string; kind: 'location' | 'language'; value: string; exclude: boolean }
export interface TypedSettingsLive {
  campaign: LiveTypedCampaign | null
  adGroups: LiveTypedAdGroup[]
  criteria: LiveTypedCriterion[]
  /** The campaign's own locations and languages (read when the change or its record names them). */
  campaignCriteria?: CampaignPlace[]
  campaignNames: string[]
  names: TargetNames
}
/** A bid adjustment changed in place on targeting an ad group keeps (null = none). */
export interface TargetRebid { item: TargetItem; from: number | null; to: number | null }
export interface TypedSettingsRecord {
  campaignId: string
  campaign: TypedCampaignSettings
  campaignAdded?: TargetItem[]
  campaignRemoved?: TargetItem[]
  adGroups: Array<{ adGroupId: string; settings: TypedAdGroupSettings; added: TargetItem[]; removed: TargetItem[]; rebid?: TargetRebid[] }>
}

/**
 * Whether adding and taking away these targeting items widens who sees the ads: one more value of a kind it already
 * narrows by, the last value of a kind taken away, an exclusion taken away (each SPENDS MONEY where it serves); a first
 * value of a kind narrows (said).
 */
function widening(
  where: string, has: Array<{ kind: TargetKind; exclude: boolean }>, adds: TargetItem[], removes: TargetItem[], serves: boolean, note: string,
  names: TargetNames, spends: string[], warnings: string[], bidOnly: { observation?: readonly string[]; signals?: boolean } = {},
): void {
  const dims = new Set([...adds, ...removes].filter((t) => !t.exclude).map((t) => dimensionOf(t.kind)))
  for (const dim of dims) {
    // Neither narrows nor widens who sees the ads: an App install campaign's audiences are signals for Google, and a
    // dimension in observation only adjusts bids (TargetRestriction.bid_only).
    if (bidOnly.signals && dim === 'audiences') { warnings.push(`${where}: its audiences are signals for Google (a hint): they do not narrow or widen who sees the ads.`); continue }
    if (bidOnly.observation?.includes(dim)) { warnings.push(`${where}: its ${dim} are in observation (bids only): they do not change who sees the ads.`); continue }
    const was = has.filter((x) => !x.exclude && dimensionOf(x.kind) === dim).length
    const plus = adds.filter((t) => !t.exclude && dimensionOf(t.kind) === dim).length
    const minus = removes.filter((t) => !t.exclude && dimensionOf(t.kind) === dim).length
    const left = was + plus - minus
    if (was > 0 && plus > 0) (serves ? spends : warnings).push(`${where}: adds ${plural(plus, DIMENSION_ONE[dim] ?? dim, dim)} to the ${was} it targets — more people or places can see the ads${note}.`)
    else if (was > 0 && left === 0) (serves ? spends : warnings).push(`${where}: takes away the last of its ${dim} — it then reaches everyone on ${dim}${note}.`)
    else if (was === 0 && plus > 0) warnings.push(`${where}: targets ${dim} from now — only those see the ads (narrower).`)
  }
  const unexcluded = removes.filter((t) => t.exclude)
  if (unexcluded.length) (serves ? spends : warnings).push(`${where}: takes away ${plural(unexcluded.length, 'exclusion')} (${unexcluded.slice(0, 3).map((t) => targetWords(t, names)).join(', ')}) — the ads can show there again${note}.`)
}

const dayOf = (dateTime: string | null) => (dateTime ? dateTime.slice(0, 10) : null)

/** The campaign's settings now, in the request's terms (the "from" side, and what undo puts back). */
export function typedCampaignNow(c: LiveTypedCampaign): TypedCampaignSettings {
  const bidding = typedBiddingNow(c)
  const own = c.budget && !c.budget.shared ? (c.budget.period === 'CUSTOM_PERIOD' ? c.budget.totalCents : c.budget.amountCents) : null
  return {
    name: c.name,
    ...(dayOf(c.start) ? { startDate: dayOf(c.start)! } : {}),
    endDate: dayOf(c.end) && !dayOf(c.end)!.startsWith('2037-12-30') ? dayOf(c.end)! : 'none',
    ...(bidding ? { bidding } : {}),
    ...(own !== null && own !== undefined ? { budgetCents: own } : {}),
    frequencyCaps: [...(c.frequencyCaps ?? [])].sort((a, b) => frequencyKey(a).localeCompare(frequencyKey(b))),
  }
}

/** An ad group's settings now, in the request's terms. */
export function typedAdGroupNow(g: LiveTypedAdGroup, c: LiveTypedCampaign): TypedAdGroupSettings {
  const cpm = c.bidding === 'MANUAL_CPM'
  const bid = cpm ? g.cpmBidCents : g.cpcBidCents
  return {
    name: g.name,
    ...(g.channels ? { channels: g.channels } : {}),
    optimizedTargeting: g.optimizedTargeting,
    ...(bid ? { defaultBidCents: bid } : {}),
    targetCpaCents: g.targetCpaCents ?? 0,
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const normChannels = (c: ChannelControls): ChannelControls => ('strategy' in c ? { strategy: c.strategy } : { selected: DG_CHANNELS.filter((ch) => c.selected.includes(ch)) })

export function typedSettingsDraft(customer: string, currency: string, r: TypedSettingsRequest, live: TypedSettingsLive): GoogleChangeDraft | { refusal: string } {
  const c = live.campaign
  if (!c) return { refusal: `Campaign ${r.campaignId} is not in this account (or it is removed).` }
  const kind = kindOfChannel(c.type)
  if (!kind) return { refusal: `"${c.name}" is a ${c.type ?? 'campaign'} campaign: this tool changes Demand Gen, Display and App campaigns${c.type === 'VIDEO' ? ' (Google\'s API cannot change a Video campaign: docs/video/overview)' : ' (Search and Shopping: set-google-campaign)'}.` }
  const problems: string[] = []
  const warnings: string[] = []
  const spends: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const operations: GoogleMutateOperation[] = []
  const note = servingNote(c)
  const now = typedCampaignNow(c)
  const before: TypedSettingsRecord = { campaignId: c.campaignId, campaign: {}, adGroups: [] }
  const after: TypedSettingsRecord = { campaignId: c.campaignId, campaign: {}, adGroups: [] }

  // The campaign.
  const fields: Record<string, unknown> = {}
  const mask: string[] = []
  const changed = <K extends keyof TypedCampaignSettings>(k: K, v: TypedCampaignSettings[K] | undefined) => v !== undefined && !same(v, now[k])
  const record = <K extends keyof TypedCampaignSettings>(k: K, v: TypedCampaignSettings[K]) => { before.campaign[k] = now[k]; after.campaign[k] = v }
  if (r.name !== undefined && changed('name', r.name.trim())) {
    const name = r.name.trim()
    if (live.campaignNames.some((n) => n.trim().toLowerCase() === name.toLowerCase() && n.trim().toLowerCase() !== c.name.trim().toLowerCase())) problems.push(`another campaign is named "${name}": Google refuses two campaigns with one name`)
    record('name', name); fields.name = name; mask.push('name'); lines.push(['name', c.name, name])
  }
  for (const d of [r.startDate, r.endDate]) if (d !== undefined && d !== 'none') { const p = dayProblem(d); if (p) problems.push(p) }
  if (changed('startDate', r.startDate)) {
    record('startDate', r.startDate!); fields.startDateTime = `${r.startDate} 00:00:00`; mask.push('start_date_time')
    lines.push(['start', now.startDate ?? '(when enabled)', r.startDate])
    if (now.startDate && r.startDate! < now.startDate) spends.push(`Starts earlier (${r.startDate} instead of ${now.startDate})${note}.`)
  }
  if (changed('endDate', r.endDate)) {
    if (r.endDate === 'none' && c.budget?.period === 'CUSTOM_PERIOD') problems.push('a campaign total budget needs an end date')
    record('endDate', r.endDate!)
    if (r.endDate !== 'none') fields.endDateTime = `${r.endDate} 23:59:59`
    mask.push('end_date_time')
    lines.push(['end', now.endDate === 'none' ? 'no end' : now.endDate, r.endDate === 'none' ? 'no end' : r.endDate])
    if (r.endDate === 'none' || (now.endDate !== 'none' && r.endDate! > now.endDate!)) spends.push(`Runs longer (end ${r.endDate === 'none' ? 'removed' : `moved to ${r.endDate}`})${note}.`)
  }
  if (r.bidding) {
    const asked = typedBiddingClean(r.bidding)
    if (!now.bidding) problems.push(`"${c.name}" bids with ${c.bidding ?? 'a strategy'} that Nexus cannot name: change its bidding in Google Ads`)
    else if (kind === 'APP' && asked.strategy !== now.bidding.strategy) problems.push('an App campaign\'s strategy follows its goal: change only its target (targetCpaCents or targetRoas)')
    else if (kind !== 'APP' && !STRATEGIES_OF[kind].includes(asked.strategy)) problems.push(`a ${KIND_WORD[kind]} campaign bids with ${STRATEGIES_OF[kind].join(', ')}`)
    else {
      const p = typedBiddingProblem(asked)
      if (p) problems.push(p)
      if (!same(asked, now.bidding)) {
        record('bidding', asked)
        Object.assign(fields, typedBiddingFields(customer, asked)); mask.push(...typedBiddingMask(asked))
        lines.push(['bidding', typedBiddingText(now.bidding, currency), typedBiddingText(asked, currency)])
        const why = typedBiddingSpends(now.bidding, asked, currency)
        if (why) spends.push(`${why}${note}.`)
      }
    }
  }
  if (r.frequencyCaps !== undefined) {
    const want = frequencyCapsOfRequest(kind, r.frequencyCaps, problems)
    if (kind !== 'APP' && !same(want, now.frequencyCaps ?? [])) {
      record('frequencyCaps', want)
      fields.frequencyCaps = want.map(capBody); mask.push('frequency_caps')
      lines.push(['frequency caps', capsText(now.frequencyCaps), capsText(want)])
      for (const why of frequencyCapsSpend(now.frequencyCaps ?? [], want)) spends.push(`${why}${note}.`)
      const tighter = want.filter((x) => !(now.frequencyCaps ?? []).some((f) => frequencyKey(f) === frequencyKey(x)) || (now.frequencyCaps ?? []).some((f) => frequencyKey(f) === frequencyKey(x) && x.events < f.events))
      if (tighter.length) warnings.push(`Frequency: ${tighter.map(capText).join('; ')} — fewer showings to the same person (narrower).`)
    }
  }
  if (mask.length) operations.push({ campaignOperation: { update: { resourceName: `${customer}/campaigns/${c.campaignId}`, ...fields }, updateMask: mask.join(',') } })
  if (r.budgetCents !== undefined && changed('budgetCents', r.budgetCents)) {
    if (!c.budget?.budgetId || c.budget.shared) problems.push(`"${c.name}" uses a shared budget: change its amount with set-google-budget (every campaign on it changes)`)
    else {
      const total = c.budget.period === 'CUSTOM_PERIOD'
      record('budgetCents', r.budgetCents)
      operations.push({ campaignBudgetOperation: { update: { resourceName: `${customer}/campaignBudgets/${c.budget.budgetId}`, [total ? 'totalAmountMicros' : 'amountMicros']: microsOfCents(r.budgetCents) }, updateMask: total ? 'total_amount_micros' : 'amount_micros' } })
      lines.push([total ? 'campaign total budget' : 'daily budget (its own)', money(now.budgetCents ?? null, currency), money(r.budgetCents, currency)])
      if (now.budgetCents === undefined || r.budgetCents > now.budgetCents) spends.push(`Raises the ${total ? 'campaign total' : 'daily'} budget ${money(now.budgetCents ?? null, currency)} → ${money(r.budgetCents, currency)}${note}.`)
    }
  }

  // The campaign's own locations and languages (Display, App).
  const cAsk = [...(r.addCampaignTargeting ?? []), ...(r.removeCampaignTargeting ?? [])]
  if (cAsk.length) {
    if (kind === 'DEMAND_GEN' && c.upgradedTargeting) problems.push('a Demand Gen campaign holds its locations and languages at its ad groups: change them there (adGroups[].addTargeting / removeTargeting)')
    else {
      const has = live.campaignCriteria ?? []
      const hasKey = new Map(has.map((x) => [targetKey(x), x]))
      const where = 'the campaign'
      const adds: TargetItem[] = []
      for (const raw of r.addCampaignTargeting ?? []) {
        const n = normalizeTarget(raw)
        if ('problem' in n) { problems.push(`${where}: ${n.problem}`); continue }
        if (n.kind !== 'location' && !(n.kind === 'language' && !n.exclude)) { problems.push(`${where}: here a campaign takes locations (targeted or excluded) and languages`); continue }
        if (hasKey.has(targetKey(n)) || adds.some((t) => targetKey(t) === targetKey(n))) { warnings.push(`${where}: ${targetWords(n)} is already there.`); continue }
        adds.push({ kind: n.kind, value: n.value, exclude: n.exclude === true })
      }
      const removes: Array<{ item: TargetItem; criterionId: string }> = []
      for (const raw of r.removeCampaignTargeting ?? []) {
        const n = normalizeTarget(raw)
        if ('problem' in n) { problems.push(`${where}: ${n.problem}`); continue }
        const found = hasKey.get(targetKey(n))
        if (!found) { warnings.push(`${where}: ${targetWords(n)} is not there.`); continue }
        if (!removes.some((x) => x.criterionId === found.criterionId)) removes.push({ item: { kind: found.kind, value: found.value, exclude: found.exclude }, criterionId: found.criterionId })
      }
      for (const t of adds) {
        operations.push({ campaignCriterionOperation: { create: { campaign: `${customer}/campaigns/${c.campaignId}`, ...(t.exclude ? { negative: true } : {}), ...targetInfo(customer, t) } } })
        lines.push(['campaign targeting', '(none)', targetWords(t)])
      }
      for (const x of removes) {
        operations.push({ campaignCriterionOperation: { remove: `${customer}/campaignCriteria/${c.campaignId}~${x.criterionId}` } })
        lines.push(['campaign targeting', targetWords(x.item), 'removed'])
      }
      widening(where, has, adds, removes.map((x) => x.item), c.status === 'ENABLED', note, {}, spends, warnings)
      if (adds.length || removes.length) {
        before.campaignAdded = []; before.campaignRemoved = []
        after.campaignAdded = adds; after.campaignRemoved = removes.map((x) => x.item)
      }
    }
  }

  // Its ad groups.
  const seenGroups = new Set<string>()
  for (const a of r.adGroups ?? []) {
    const g = live.adGroups.find((x) => x.adGroupId === a.adGroupId)
    if (!g) { problems.push(`ad group ${a.adGroupId} is not in "${c.name}" (or it is removed)`); continue }
    if (seenGroups.has(g.adGroupId)) { problems.push(`ad group ${g.adGroupId} is named twice`); continue }
    seenGroups.add(g.adGroupId)
    const where = `ad group "${g.name}"`
    const serves = c.status === 'ENABLED' && g.status === 'ENABLED'
    const gNote = serves ? '' : ' (it does not serve now)'
    const gNow = typedAdGroupNow(g, c)
    const gBefore: TypedAdGroupSettings = {}
    const gAfter: TypedAdGroupSettings = {}
    const gFields: Record<string, unknown> = {}
    const gMask: string[] = []
    const gChanged = <K extends keyof TypedAdGroupSettings>(k: K, v: TypedAdGroupSettings[K] | undefined) => v !== undefined && !same(v, gNow[k])
    const gRecord = <K extends keyof TypedAdGroupSettings>(k: K, v: TypedAdGroupSettings[K]) => { gBefore[k] = gNow[k]; gAfter[k] = v }
    if (a.name !== undefined && gChanged('name', a.name.trim())) {
      const name = a.name.trim()
      if (live.adGroups.some((x) => x.adGroupId !== g.adGroupId && x.name.trim().toLowerCase() === name.toLowerCase())) problems.push(`${where}: another ad group of the campaign is named "${name}"`)
      gRecord('name', name); gFields.name = name; gMask.push('name'); lines.push([`${where} name`, g.name, name])
    }
    if (a.channels !== undefined) {
      if (kind !== 'DEMAND_GEN') problems.push(`${where}: channel controls are for a Demand Gen ad group`)
      else {
        const p = channelsProblem(a.channels)
        if (p) problems.push(`${where}: ${p}`)
        const asked = normChannels(a.channels)
        if (gChanged('channels', asked)) {
          gRecord('channels', asked)
          gFields.demandGenAdGroupSettings = { channelControls: channelsBody(asked) }
          // The oneof's leaf paths: the strategy, or every selected channel ("explicitly specify all fields").
          gMask.push(...('strategy' in asked ? ['demand_gen_ad_group_settings.channel_controls.channel_strategy'] : DG_CHANNELS.map((ch) => `demand_gen_ad_group_settings.channel_controls.selected_channels.${ch.toLowerCase()}`)))
          lines.push([`${where} channels`, channelsText(gNow.channels ?? null), channelsText(asked)])
          const was = channelSet(gNow.channels ?? null)
          const added = [...channelSet(asked)].filter((ch) => !was.has(ch))
          if (added.length) (serves ? spends : warnings).push(`${where}: adds ${added.map((ch) => ch.toLowerCase().replace(/_/g, ' ')).join(', ')} — the ads can show in more places${gNote}.`)
        }
      }
    }
    if (a.optimizedTargeting !== undefined) {
      if (kind === 'APP') problems.push(`${where}: optimized targeting is for Demand Gen and Display ad groups`)
      else if (gChanged('optimizedTargeting', a.optimizedTargeting)) {
        gRecord('optimizedTargeting', a.optimizedTargeting)
        gFields.optimizedTargetingEnabled = a.optimizedTargeting; gMask.push('optimized_targeting_enabled')
        lines.push([`${where} optimized targeting`, gNow.optimizedTargeting ? 'on' : 'off', a.optimizedTargeting ? 'on' : 'off'])
        if (a.optimizedTargeting) (serves ? spends : warnings).push(`${where}: optimized targeting ON — Google shows the ads beyond the targeting set${gNote}.`)
      }
    }
    if (a.defaultBidCents !== undefined) {
      const strategy = now.bidding?.strategy
      if (kind !== 'DISPLAY' || (strategy !== 'MANUAL_CPC' && strategy !== 'MANUAL_CPM')) problems.push(`${where}: an ad group bid is for a Display campaign with Manual CPC or Manual CPM`)
      else if (gChanged('defaultBidCents', a.defaultBidCents)) {
        gRecord('defaultBidCents', a.defaultBidCents)
        const cpm = strategy === 'MANUAL_CPM'
        gFields[cpm ? 'cpmBidMicros' : 'cpcBidMicros'] = microsOfCents(a.defaultBidCents); gMask.push(cpm ? 'cpm_bid_micros' : 'cpc_bid_micros')
        lines.push([`${where} ${cpm ? 'CPM' : 'CPC'} bid`, money(gNow.defaultBidCents ?? null, currency), money(a.defaultBidCents, currency)])
        if (!gNow.defaultBidCents || a.defaultBidCents > gNow.defaultBidCents) (serves ? spends : warnings).push(`${where}: raises the bid ${money(gNow.defaultBidCents ?? null, currency)} → ${money(a.defaultBidCents, currency)}${gNote}.`)
      }
    }
    if (a.targetCpaCents !== undefined) {
      if (kind === 'APP' && c.subType !== 'APP_CAMPAIGN_FOR_ENGAGEMENT') problems.push(`${where}: an App campaign for installs takes no ad group bid (Google's rule)`)
      else if (gChanged('targetCpaCents', a.targetCpaCents)) {
        gRecord('targetCpaCents', a.targetCpaCents)
        if (a.targetCpaCents) gFields.targetCpaMicros = microsOfCents(a.targetCpaCents)
        gMask.push('target_cpa_micros')
        lines.push([`${where} target CPA`, gNow.targetCpaCents ? money(gNow.targetCpaCents, currency) : 'the campaign\'s', a.targetCpaCents ? money(a.targetCpaCents, currency) : 'the campaign\'s'])
        // What applies before and after: the ad group's own target, else the campaign's.
        const campaignCpa = now.bidding?.targetCpaCents ?? null
        const was = gNow.targetCpaCents || campaignCpa
        const will = a.targetCpaCents || campaignCpa
        if ((will && was && will > was) || (!will && was)) (serves ? spends : warnings).push(`${where}: the target CPA it bids to goes ${money(was, currency)} → ${will ? money(will, currency) : 'none'}${gNote}.`)
      }
    }
    if (gMask.length) operations.push({ adGroupOperation: { update: { resourceName: `${customer}/adGroups/${g.adGroupId}`, ...gFields }, updateMask: gMask.join(',') } })

    // Targeting: what is added and what is taken away, and whether that widens who sees the ads.
    const has = live.criteria.filter((x) => x.adGroupId === g.adGroupId && x.kind !== 'listing-group') as Array<LiveTypedCriterion & { kind: TargetKind }>
    const hasKey = new Map(has.map((x) => [targetKey({ kind: x.kind, value: x.value, exclude: x.exclude }), x]))
    // Targeting it holds, named again with another bid adjustment: the adjustment changes in place (Display).
    const rebids: Array<TargetRebid & { criterionId: string }> = []
    const adds = checkTargets(a.addTargeting ?? [], kind, c.subType, live.names, where, problems).filter((t) => {
      const found = hasKey.get(targetKey(t))
      if (!found) return true
      const from = bidOf(found.bidModifier)
      if (t.bidModifier !== undefined && bidOf(t.bidModifier) !== from) rebids.push({ item: { kind: t.kind, value: found.value, exclude: false }, criterionId: found.criterionId, from, to: bidOf(t.bidModifier) })
      else warnings.push(`${where}: ${targetWords(t, live.names)} is already there.`)
      return false
    })
    if (kind === 'DEMAND_GEN' && !c.upgradedTargeting && adds.some((t) => t.kind === 'location' || t.kind === 'language')) {
      problems.push(`${where}: this Demand Gen campaign holds its locations and languages at the campaign, not its ad groups (addCampaignTargeting)`)
    }
    if (adds.some((t) => t.kind === 'audience') && !g.audienceGrouped) problems.push(`${where}: it was made without audience grouping, so it cannot target an Audience (Google sets that only when an ad group is made): target audience segments, or add a new ad group with add-google-campaign-type-ads`)
    const removes: Array<{ item: TargetItem; criterionId: string }> = []
    for (const raw of a.removeTargeting ?? []) {
      const n = normalizeTarget(raw)
      if ('problem' in n) { problems.push(`${where}: ${n.problem}`); continue }
      const found = hasKey.get(targetKey(n))
      if (!found) { warnings.push(`${where}: ${targetWords(n, live.names)} is not there.`); continue }
      if (!removes.some((x) => x.criterionId === found.criterionId)) removes.push({ item: recordItem({ kind: n.kind, value: found.value, exclude: n.exclude === true, bidModifier: found.bidModifier }), criterionId: found.criterionId })
    }
    // Google's demographic rules on what the ad group holds after (only the dimensions this change touches).
    const removedIds = new Set(removes.map((x) => x.criterionId))
    problems.push(...demographicProblems(where, [...has.filter((x) => !removedIds.has(x.criterionId)), ...adds], new Set([...adds, ...removes.map((x) => x.item)].map((t) => t.kind))))
    if (kind === 'APP' && c.subType === 'APP_CAMPAIGN_FOR_ENGAGEMENT') {
      const lists = has.filter((x) => x.kind === 'user-list').length - removes.filter((x) => x.item.kind === 'user-list').length + adds.filter((t) => t.kind === 'user-list').length
      if (lists < 1) problems.push(`${where}: an App engagement ad group needs a user list (Google's rule)`)
    }
    for (const t of adds) {
      operations.push(criterionCreate(customer, `${customer}/adGroups/${g.adGroupId}`, t))
      lines.push([`${where} targeting`, '(none)', targetWords(t, live.names)])
      // A new item with a raise bids more for those it matches — also the first of its dimension, and one in observation.
      if ((bidOf(t.bidModifier) ?? 1) > 1) (serves ? spends : warnings).push(`${where}: bids more for ${targetWords({ ...t, bidModifier: null }, live.names)} (${adjustmentWords(null)} → ${adjustmentWords(t.bidModifier)})${gNote}.`)
    }
    for (const x of removes) { operations.push({ adGroupCriterionOperation: { remove: `${customer}/adGroupCriteria/${g.adGroupId}~${x.criterionId}` } }); lines.push([`${where} targeting`, targetWords(x.item, live.names), 'removed']) }
    for (const r of rebids) {
      operations.push({ adGroupCriterionOperation: { update: { resourceName: `${customer}/adGroupCriteria/${g.adGroupId}~${r.criterionId}`, bidModifier: r.to ?? 1 }, updateMask: 'bid_modifier' } })
      lines.push([`${where} bid adjustment, ${targetWords(r.item, live.names)}`, adjustmentWords(r.from), adjustmentWords(r.to)])
      if ((r.to ?? 1) > (r.from ?? 1)) (serves ? spends : warnings).push(`${where}: bids more for ${targetWords(r.item, live.names)} (${adjustmentWords(r.from)} → ${adjustmentWords(r.to)})${gNote}.`)
    }
    if (rebids.length || adds.some((t) => bidOf(t.bidModifier) !== null)) {
      const smart = smartBiddingWords(c, 'other')
      if (smart && !warnings.includes(smart)) warnings.push(smart)
    }
    widening(where, has, adds, removes.map((x) => x.item), serves, gNote, live.names, spends, warnings, {
      observation: g.observation.map(dimensionOfRestriction).filter((d): d is string => !!d),
      signals: kind === 'APP' && c.subType === 'APP_CAMPAIGN',
    })
    if (Object.keys(gAfter).length || adds.length || removes.length || rebids.length) {
      before.adGroups.push({ adGroupId: g.adGroupId, settings: gBefore, added: [], removed: [] })
      after.adGroups.push({
        adGroupId: g.adGroupId, settings: gAfter, added: adds.map(recordItem), removed: removes.map((x) => x.item),
        ...(rebids.length ? { rebid: rebids.map(({ item, from, to }) => ({ item, from, to })) } : {}),
      })
    }
  }
  if (problems.length) return { refusal: `Not queued (${plural(problems.length, 'problem')}): ${problems.slice(0, 25).join(' · ')}. Nothing was sent.` }
  if (!operations.length) return { refusal: `Nothing to change: "${c.name}" already has these settings${warnings.length ? ` (${warnings.join(' ')})` : ''}.` }
  const { changes, more } = changeLines(lines)
  return {
    summary: `Google Ads ${KIND_WORD[kind]} campaign "${c.name}": change ${lines.length === 1 ? lines[0][0] : plural(lines.length, 'setting')}.`,
    changes,
    totals: { operations: operations.length, settings: lines.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped: [],
    operations,
    stands: {
      campaign: { id: c.campaignId, status: c.status, now, budget: c.budget },
      adGroups: live.adGroups.filter((g) => seenGroups.has(g.adGroupId)).map((g) => ({ ...typedAdGroupNow(g, c), id: g.adGroupId, status: g.status, grouped: g.audienceGrouped, observation: g.observation })),
      criteria: live.criteria.filter((x) => seenGroups.has(x.adGroupId)).map((x) => `${x.adGroupId}~${x.criterionId}:${x.kind}:${x.value}:${x.exclude}:${bidOf(x.bidModifier) ?? 1}`).sort(),
      places: cAsk.length ? (live.campaignCriteria ?? []).map((x) => `${x.criterionId}:${x.kind}:${x.value}:${x.exclude}`).sort() : null,
      names: r.name ? live.campaignNames.map((n) => n.trim().toLowerCase()).filter((n) => n === r.name!.trim().toLowerCase()) : null,
    },
    before,
    after,
  }
}

/** Whether the live account still holds what a settings change wrote (undo's compare). */
export function typedSettingsNow(record: TypedSettingsRecord, live: TypedSettingsLive): TypedSettingsRecord | null {
  const c = live.campaign
  if (!c) return null
  const now = typedCampaignNow(c)
  const campaign = Object.fromEntries(Object.keys(record.campaign).map((k) => [k, now[k as keyof TypedCampaignSettings]])) as TypedCampaignSettings
  const adGroups = record.adGroups.map((a) => {
    const g = live.adGroups.find((x) => x.adGroupId === a.adGroupId)
    const gNow = g ? typedAdGroupNow(g, c) : {}
    const mine = live.criteria.filter((x) => x.adGroupId === a.adGroupId && x.kind !== 'listing-group')
    const has = new Set(mine.map((x) => targetKey({ kind: x.kind as TargetKind, value: x.value, exclude: x.exclude })))
    const bidNow = (t: TargetItem) => bidOf(mine.find((x) => targetKey({ kind: x.kind as TargetKind, value: x.value, exclude: x.exclude }) === targetKey(t))?.bidModifier)
    return {
      adGroupId: a.adGroupId,
      settings: Object.fromEntries(Object.keys(a.settings).map((k) => [k, (gNow as TypedAdGroupSettings)[k as keyof TypedAdGroupSettings]])) as TypedAdGroupSettings,
      // An added item holds while it is there with the adjustment it was given; a rebid one while it has the new one.
      added: a.added.filter((t) => has.has(targetKey(t)) && bidNow(t) === bidOf(t.bidModifier)),
      removed: a.removed.filter((t) => !has.has(targetKey(t))),
      ...(a.rebid ? { rebid: a.rebid.filter((r) => has.has(targetKey(r.item))).map((r) => ({ ...r, to: bidNow(r.item) })) } : {}),
    }
  })
  const places = new Set((live.campaignCriteria ?? []).map((x) => targetKey(x)))
  return {
    campaignId: record.campaignId, campaign,
    ...(record.campaignAdded ? { campaignAdded: record.campaignAdded.filter((t) => places.has(targetKey(t))) } : {}),
    ...(record.campaignRemoved ? { campaignRemoved: record.campaignRemoved.filter((t) => !places.has(targetKey(t))) } : {}),
    adGroups,
  }
}

// ── edit ads in place ───────────────────────────────────────────────────────────────────────────────────────────

export interface TypedAdEdit extends AdFields { id: string }
export interface TypedEditRequest { ads: TypedAdEdit[] }
export interface TypedEditLive { ads: LiveTypedAd[]; media: MediaLive }
/**
 * One ad's fields as they were (before) or are written (after), in the request's terms: texts as texts, images and videos
 * by asset id (a new asset `op:<n>` until Google gave it an id), a cleared text null.
 */
export interface TypedEditRecord { ads: Array<{ id: string; campaignId: string } & AdFields>; assets?: NewAssetEntry[]; assetOps?: number[] }

const assetIdOf = (resource: unknown) => {
  const s = typeof resource === 'string' ? resource : ''
  return s.slice(s.lastIndexOf('/') + 1)
}

/** An ad's field now, in the request's terms (from Google's info JSON). */
export function adFieldNow(spec: AdTypeSpec, field: AdField | 'finalUrl', ad: LiveTypedAd): unknown {
  if (field === 'finalUrl') return ad.finalUrls[0] ?? null
  const fs = spec.fields[field]
  if (!fs || !ad.info) return null
  const v = ad.info[fs.key]
  switch (fs.shape) {
    case 'texts': return Array.isArray(v) ? v.map((t: { text?: string }) => t?.text ?? '') : []
    case 'text': return v?.text !== undefined ? [v.text] : []
    case 'string': return typeof v === 'string' && v ? v : null
    case 'textAsset': return v?.text || null
    case 'textInList': return Array.isArray(v) && v[0]?.text ? v[0].text : null
    case 'images': case 'videos': return Array.isArray(v) ? v.map((x: { asset?: string }) => ({ assetId: assetIdOf(x?.asset) })) : []
    case 'image': return v?.asset ? [{ assetId: assetIdOf(v.asset) }] : []
  }
}

/** A field's value in Google's own shape as it is now (sent again with an edit Google needs it on), without output-only parts. */
function currentInfoValue(fs: FieldSpec, v: unknown): unknown {
  const text = (x: unknown) => ({ text: (x as { text?: string })?.text ?? '' })
  const asset = (x: unknown) => ({ asset: (x as { asset?: string })?.asset ?? '' })
  switch (fs.shape) {
    case 'texts': case 'textInList': return Array.isArray(v) ? v.map(text) : []
    case 'text': case 'textAsset': return v ? text(v) : undefined
    case 'string': return v
    case 'images': case 'videos': return Array.isArray(v) ? v.map(asset) : []
    case 'image': return v ? asset(v) : undefined
  }
}

/** A value as it is compared and recorded: texts trimmed (an empty one null), images and videos by asset id. */
function recordForm(v: unknown): unknown {
  if (typeof v === 'string') return v.trim() || null
  if (!Array.isArray(v)) return v ?? null
  return v.map((x) => (typeof x === 'string' ? x.trim() : x && typeof x === 'object' && (x as ImageRef).assetId ? { assetId: String((x as ImageRef).assetId).trim() } : x))
}

const shownValue = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '(none)'
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x as ImageRef).assetId ? `asset ${(x as ImageRef).assetId}` : (x as ImageRef).imageUrl ?? (x as ImageRef).libraryImageId ?? (x as VideoRef).youtubeVideoId ?? '?')).join(' | ') || '(none)'
  return String(v)
}

export function typedEditDraft(customer: string, r: TypedEditRequest, live: TypedEditLive): GoogleChangeDraft | { refusal: string } {
  if (!r.ads.length) return { refusal: 'Name at least one ad (id: adGroupId~adId).' }
  const problems: string[] = []
  const warnings: string[] = []
  const spends: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const ops = new Ops(customer)
  const media = new Media(ops, live.media, problems)
  const before: TypedEditRecord = { ads: [] }
  const writes: Array<{ id: string; campaignId: string; fields: Record<string, unknown> }> = []
  const tags: string[] = []
  const seen = new Set<string>()
  for (const e of r.ads) {
    const ad = live.ads.find((x) => x.id === e.id.trim())
    if (!ad) { problems.push(`ad ${e.id} is not in this account (or it is removed)`); continue }
    if (seen.has(ad.id)) { problems.push(`ad ${ad.id} is named twice`); continue }
    seen.add(ad.id)
    const spec = ad.type ? AD_TYPES[ad.type] : undefined
    if (!spec || !ad.info) { problems.push(`ad ${ad.id} is ${ad.type ?? 'of another type'}: this tool edits responsive display, Demand Gen, App and video responsive ads (responsive search ads: edit-google-rsa)`); continue }
    const where = `${spec.word} ${ad.id}`
    const info: Record<string, unknown> = {}
    const mask: string[] = []
    const was: Record<string, unknown> = {}
    const now: Record<string, unknown> = {}
    const body: Record<string, unknown> = { resourceName: `${customer}/ads/${ad.adId}` }
    if (e.finalUrl !== undefined && e.finalUrl !== null && recordForm(e.finalUrl) !== recordForm(ad.finalUrls[0] ?? null)) {
      const url = e.finalUrl.trim()
      if (spec.finalUrl === 'none') problems.push(`${where}: an ${spec.word} has no final URL`)
      else {
        const p = httpsUrlProblem(where, url)
        if (p) problems.push(p)
        body.finalUrls = [url]; mask.push('final_urls'); was.finalUrl = ad.finalUrls[0] ?? null; now.finalUrl = url
        lines.push([`${where} final URL`, ad.finalUrls[0] ?? '(none)', url])
      }
    }
    for (const field of AD_FIELD_NAMES) {
      const value = e[field]
      if (value === undefined || value === null) continue
      const fs = spec.fields[field]
      if (!fs) { problems.push(`${where}: a ${spec.word} has no ${FIELD_WORD[field]}s (${field})`); continue }
      const current = adFieldNow(spec, field, ad)
      if (same(recordForm(value), recordForm(current))) continue
      const empty = (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length)
      if (empty && fs.required) { problems.push(`${where}: ${field} cannot be emptied (Google needs it)`); continue }
      let v: unknown
      if (!empty) {
        v = fieldValue(fs, field, value, media, where, problems)
        if (v !== undefined) info[fs.key] = v
      }
      mask.push(`${spec.path}.${fs.path}`)
      was[field] = recordForm(current)
      // Images and videos are recorded by the asset they point at (a new one by its operation until Google answers).
      now[field] = empty ? recordForm(value) : (fs.shape === 'images' || fs.shape === 'videos' || fs.shape === 'image') ? refsOf(v, media) : recordForm(value)
      lines.push([`${where} ${FIELD_WORD[field]}s`, shownValue(current), empty ? '(cleared)' : shownValue(value)])
    }
    if (!mask.length) { warnings.push(`${where}: already as asked.`); continue }
    // Fields Google requires on every mutate of this ad type go along as they are now (unless changed above).
    for (const field of spec.alwaysSend ?? []) {
      const fs = spec.fields[field]!
      if (fs.key in info) continue
      const v = currentInfoValue(fs, ad.info[fs.key])
      if (v !== undefined) { info[fs.key] = v; mask.push(`${spec.path}.${fs.path}`) }
    }
    for (const cap of spec.caps ?? []) {
      const count = (f: AdField) => ((e[f] ?? adFieldNow(spec, f, ad)) as unknown[] | null)?.length ?? 0
      const n = cap.fields.reduce((sum, f) => sum + count(f), 0)
      if (n > cap.max) problems.push(`${where}: ${n} ${cap.fields.map((f) => FIELD_WORD[f]).join(' / ')}s together (Google takes at most ${cap.max})`)
      if (cap.oneOf && !cap.oneOf.some((f) => count(f))) problems.push(`${where}: it needs ${cap.oneOf.join(' or ')}`)
    }
    if (Object.keys(info).length) body[spec.info] = info
    const tag = `edit:${ad.id}`
    ops.push({ adOperation: { update: body, updateMask: [...new Set(mask)].join(',') } }, tag)
    tags.push(tag)
    before.ads.push({ id: ad.id, campaignId: ad.campaignId, ...was })
    writes.push({ id: ad.id, campaignId: ad.campaignId, fields: now })
    const serving = servingAd(ad)
    if (serving && limitedNow(ad)) {
      spends.push(`${where} is enabled in a serving ad group but Google limits or stops it now (${ad.approval}): once Google approves the new version it can serve more.`)
    }
    // Media an ad had none of opens new places for it (a video in a responsive display ad; vertical images in a Demand Gen
    // image ad, e.g. YouTube Shorts).
    for (const [field, words] of NEW_PLACES[ad.type!] ?? []) {
      const had = (adFieldNow(spec, field, ad) as unknown[] | null)?.length ?? 0
      if (!had && (e[field] as unknown[] | null | undefined)?.length) {
        (serving ? spends : warnings).push(`${where}: adds ${words} — the ad can show in new places${serving ? '' : ' (it does not serve now)'}.`)
      }
    }
  }
  if (problems.length) return { refusal: `Not queued (${plural(problems.length, 'problem')}): ${problems.slice(0, 25).join(' · ')}. Nothing was sent.` }
  if (!tags.length) return { refusal: `Nothing to change: ${warnings.join(' ')}` }
  const { operations, at } = ops.ordered()
  // A new asset's placeholder (its tag) becomes `op:<index of the operation that makes it>`.
  const placeholder = (id: unknown) => (typeof id === 'string' && id.startsWith('asset:') ? `op:${at(id)}` : id)
  const after: TypedEditRecord = {
    ads: writes.map((w) => ({
      id: w.id, campaignId: w.campaignId,
      ...Object.fromEntries(Object.entries(w.fields).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' && 'assetId' in x ? { assetId: placeholder((x as ImageRef).assetId) } : x)) : v])),
    })) as TypedEditRecord['ads'],
  }
  for (const a of media.created.slice(0, 5)) lines.push(['new asset', '(none)', a.text])
  warnings.push('Google reviews an edited ad again before it serves the new version; the ad keeps its id and its numbers.')
  if (media.created.length) {
    warnings.push('Google never removes an asset: an undo puts the old images and videos back and leaves the new ones in the account, unused.')
    after.assets = media.created.map(({ tag, ...a }) => ({ ...a, assetId: `op:${at(tag)}` }))
    after.assetOps = media.created.map((a) => at(a.tag))
  }
  const { changes, more } = changeLines(lines)
  return {
    summary: `Google Ads: edit ${plural(tags.length, 'ad')} in place (${lines.length === 1 ? lines[0][0] : plural(lines.length, 'change')}).`,
    changes,
    totals: { operations: operations.length, ads: tags.length, newAssets: media.created.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped: [],
    operations,
    stands: {
      // The ads' own fields (not Google's review or performance labels inside them, which move on their own).
      ads: live.ads.filter((a) => seen.has(a.id)).map((a) => {
        const spec = a.type ? AD_TYPES[a.type] : undefined
        return {
          id: a.id, type: a.type, status: a.status, adGroupStatus: a.adGroupStatus, campaignStatus: a.campaignStatus, limited: limitedNow(a),
          finalUrls: a.finalUrls, fields: spec ? Object.fromEntries(AD_FIELD_NAMES.map((f) => [f, recordForm(adFieldNow(spec, f, a))])) : null,
        }
      }),
      assets: live.media.assets.map((a) => `${a.assetId}:${a.type ?? ''}:${a.width ?? ''}x${a.height ?? ''}`).sort(),
      youtube: live.media.youtube.map((a) => `${a.youtubeVideoId}:${a.assetId}`).sort(),
      images: media.created.filter((a) => a.sha256).map((a) => a.sha256!).sort(),
    },
    before,
    after,
  }
}

/** The refs of a built images / videos value, by asset id (a new asset by its tag until the operations are ordered). */
function refsOf(v: unknown, media: Media): Array<{ assetId: string }> {
  const list = Array.isArray(v) ? v : v ? [v] : []
  return list.map((x: { asset?: string | null }) => {
    const res = x?.asset ?? ''
    return { assetId: media.tagOf.get(res) ?? assetIdOf(res) }
  })
}

/** An ad that serves now: it, its ad group and its campaign are enabled. */
const servingAd = (ad: LiveTypedAd) => ad.status === 'ENABLED' && ad.adGroupStatus === 'ENABLED' && ad.campaignStatus === 'ENABLED'
/** Google limits or stops the ad now (its review). */
const limitedNow = (ad: LiveTypedAd) => ad.approval === 'DISAPPROVED' || ad.approval === 'APPROVED_LIMITED' || ad.approval === 'AREA_OF_INTEREST_ONLY'
/** Media that, added to an ad that had none, lets it show in new places. */
const NEW_PLACES: Record<string, Array<[AdField, string]>> = {
  RESPONSIVE_DISPLAY_AD: [['videos', 'YouTube videos (it can show as a video ad too)']],
  DEMAND_GEN_MULTI_ASSET_AD: [['portraitMarketingImages', 'portrait images (vertical placements)'], ['tallPortraitMarketingImages', 'tall portrait images (vertical placements such as YouTube Shorts)']],
}

/** After a run: the new assets an edit made get Google's ids, and so do the image and video refs that pointed at them. */
export function typedEditRecordAfterRun(after: TypedEditRecord, responses: GoogleMutateResponse[]): TypedEditRecord {
  if (!after.assets?.length) return after
  const real = new Map<string, string>()
  after.assets.forEach((a, i) => { const id = idAt(responses, after.assetOps?.[i], 'assetResult'); if (id) real.set(a.assetId, id) })
  const swap = (v: unknown) => (Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' && 'assetId' in x ? { assetId: real.get((x as ImageRef).assetId!) ?? (x as ImageRef).assetId } : x)) : v)
  return {
    ...after,
    ads: after.ads.map((ad) => Object.fromEntries(Object.entries(ad).map(([k, v]) => [k, swap(v)])) as unknown as TypedEditRecord['ads'][number]),
    assets: after.assets.map((a) => ({ ...a, assetId: real.get(a.assetId) ?? a.assetId })),
  }
}

/** The ads' fields now, in the record's terms, for the fields a record names (undo's compare). */
export function typedEditNow(record: TypedEditRecord, ads: LiveTypedAd[]): TypedEditRecord {
  return {
    ...record,
    ads: record.ads.map((r) => {
      const ad = ads.find((x) => x.id === r.id)
      const spec = ad?.type ? AD_TYPES[ad.type] : undefined
      const out: Record<string, unknown> = { id: r.id, campaignId: r.campaignId }
      for (const k of Object.keys(r)) {
        if (k === 'id' || k === 'campaignId') continue
        out[k] = ad && spec ? recordForm(adFieldNow(spec, k as AdField | 'finalUrl', ad)) : null
      }
      return out as unknown as { id: string; campaignId: string } & AdFields
    }),
  }
}

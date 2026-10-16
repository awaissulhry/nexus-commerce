/**
 * Google Ads Performance Max (programme 2, G10, 2026-10-16) — what every Performance Max change is made of, and the
 * change of a live Performance Max campaign (set-google-pmax). Pure: request + live state → ONE atomic request.
 *
 *   asset groups        make (in an existing campaign), rename, pause / enable, final URLs (desktop and mobile), display
 *                       paths
 *   asset group assets  make text, image, YouTube video and call-to-action assets and link them (headlines, long
 *                       headlines, descriptions, business name, marketing / square / portrait images, logos, landscape
 *                       logos, videos, call to action), link existing assets, unlink — Google's minimums held
 *   listing groups      a retail asset group's product tree (AssetGroupListingGroupFilter) of any shape
 *   signals             audiences (an existing Audience, or a new one made of audience segments) and search themes
 *   campaign            name, bidding (Maximize conversions / conversion value, their targets), dates, Google's
 *                       automation (final URL expansion, text customization, image and video enhancement), URL
 *                       exclusions (negative WEBPAGE criteria), brand exclusions (brand lists), the brand's business name
 *                       and logos (brand guidelines)
 *
 * Checked 2026-10-16 with curl in Google's v25 reference and Performance Max guides (developers.google.com/google-ads/api/…):
 *   reference/rpc/v25/MutateOperation  asset_group_operation, asset_group_asset_operation, asset_group_listing_group_filter_
 *                       operation, asset_group_signal_operation, audience_operation are GoogleAdsService.Mutate operations;
 *                       MutateOperationResponse asset_group_result, asset_result, audience_result, … .
 *   AssetGroup          campaign (Immutable), name (Required, 1–128, unique under a campaign), final_urls, final_mobile_urls,
 *                       final_url_suffix, path1, path2 ("can only be set when path1 is set"), status (ENABLED / PAUSED /
 *                       REMOVED); customers/{c}/assetGroups/{id}. AssetGroupOperation create / update (+ update_mask) / remove.
 *   AssetGroupAsset     asset, asset_group (Immutable), field_type, status; customers/{c}/assetGroupAssets/{ag}~{asset}~{field}.
 *   AssetGroupListingGroupFilter  asset_group, type, listing_source, parent_listing_group_filter (Immutable), case_value
 *                       (ListingGroupFilterDimension: product_brand, product_category {category_id, level}, product_channel,
 *                       product_condition, product_custom_attribute {index, value}, product_item_id, product_type {level,
 *                       value}, webpage); customers/{c}/assetGroupListingGroupFilters/{ag}~{id}. ListingGroupFilterType
 *                       SUBDIVISION | UNIT_INCLUDED | UNIT_EXCLUDED; ListingGroupFilterListingSource SHOPPING.
 *                       AssetGroupListingGroupFilterOperation remove: "An entity can be removed only if it's not referenced
 *                       by other parent_listing_group_id. If multiple entities are being deleted, the mutates must be in the
 *                       correct order" — removal is NOT recursive (AssetGroupListingGroupFilterError SUBDIVISION_HAS_CHILDREN,
 *                       MULTIPLE_OPERATIONS_ON_ONE_NODE, SUBDIVISION_MUST_HAVE_EVERYTHING_ELSE_CHILD, MUST_REFINE_
 *                       HIERARCHICAL_PARENT_TYPE, CANNOT_REFINE_HIERARCHICAL_EVERYTHING_ELSE, SAME_DIMENSION_TYPE_BETWEEN_
 *                       ANCESTORS). Google's own sample (google-ads-python examples/shopping_ads/add_performance_max_product_
 *                       listing_group_tree.py) removes a whole tree leaves first AND builds the new tree in ONE request — so
 *                       the Shopping trap ("no recursive removal + create in one request", AdGroupCriterion
 *                       LISTING_GROUP_CANNOT_BE_REMOVED, change-product-tree.ts) does not apply here: no removal is recursive.
 *   AssetGroupSignal    asset_group, oneof signal: audience (AudienceInfo.audience: customers/{c}/audiences/{id}) |
 *                       search_theme (SearchThemeInfo.text; AssetGroupSignalError TOO_MANY_WORDS: "up to 10 words");
 *                       create / remove only; customers/{c}/assetGroupSignals/{ag}~{signal}.
 *   Audience            name (unique in the account, 1–255; required with scope CUSTOMER), dimensions[] AudienceDimension
 *                       {audience_segments {segments[] AudienceSegment: user_list {user_list} | user_interest
 *                       {user_interest_category} | custom_audience {custom_audience} | life_event {life_event} |
 *                       detailed_demographic {detailed_demographic}}}, scope (default CUSTOMER), asset_group (only for
 *                       scope ASSET_GROUP: AssetGroupSignalError AUDIENCE_WITH_WRONG_ASSET_GROUP_ID).
 *   CampaignCriterion   brand_list (BrandListInfo.shared_set) and webpage (WebpageInfo: criterion_name and conditions
 *                       required on create; WebpageConditionInfo operand URL, operator EQUALS | CONTAINS, argument).
 *                       performance-max/create-campaign-criteria: BRAND (brand lists) and KEYWORD are negative only;
 *                       "Negative WEBPAGE criteria can be used to exclude specific URLs from final URL expansion".
 *   Campaign            asset_automation_settings[] {asset_automation_type, asset_automation_status OPTED_IN | OPTED_OUT}:
 *                       FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION "turned ON by default for Performance Max … Enabling final
 *                       URL expansion also enables text asset automation. There is no way to opt out of text asset
 *                       automation and still use final URL expansion"; TEXT_ASSET_AUTOMATION, GENERATE_IMAGE_ENHANCEMENT,
 *                       GENERATE_ENHANCED_YOUTUBE_VIDEOS on by default for Performance Max (docs/assets/asset-automation-
 *                       settings). brand_guidelines_enabled "Immutable … Writable only at campaign creation".
 *   performance-max/asset-requirements  per asset group: HEADLINE 3–15 (30 characters), LONG_HEADLINE 1–5 (90),
 *                       DESCRIPTION 2–5 (90; AssetGroupError SHORT_DESCRIPTION_REQUIRED: one of 60 or fewer),
 *                       MARKETING_IMAGE 1–20 (1.91:1, 600×314), SQUARE_MARKETING_IMAGE 1–20 (1:1, 300×300),
 *                       PORTRAIT_MARKETING_IMAGE up to 20 (4:5, 480×600), YOUTUBE_VIDEO up to 15, CALL_TO_ACTION_SELECTION
 *                       up to 1; with brand guidelines off also BUSINESS_NAME exactly 1 (25) and LOGO 1–5 (1:1, 128×128),
 *                       LANDSCAPE_LOGO up to 20 (4:1, 512×128); with brand guidelines on those three go on the campaign
 *                       (create-campaign: "Exactly one BUSINESS_NAME asset; At least one LOGO asset and up to four optional
 *                       additional logo assets of the type LOGO or LANDSCAPE_LOGO").
 *   performance-max/structure-requests  "the Google Ads server batches consecutive AssetGroupAssetOperations together and
 *                       evaluates whether an AssetGroup meets minimum asset requirements following the last operation in
 *                       that group": every asset operation goes before every asset group asset operation, and those go
 *                       together. A retail asset group may have NO asset at all (Google makes ads from the feed); once it
 *                       has one, every requirement applies. "you can't issue subsequent requests that would result in an
 *                       invalid state in which the minimum asset requirements are no longer met".
 *   AssetGroupError     AD_CUSTOMIZER_NOT_SUPPORTED ("Ad customizers are not supported in asset group's text field").
 *
 * Added 2026-10-16 (programme 2 group G14b), checked with curl in the same reference and guides:
 *   Campaign.text_guidelines  Campaign.TextGuidelines {term_exclusions[] "At most 25 exclusions … a maximum of 30
 *                       characters", messaging_restrictions[] Campaign.MessagingRestriction {restriction_text "a maximum of
 *                       300 characters", restriction_type MessagingRestrictionType — "Only RESTRICTION_BASED_EXCLUSION is
 *                       currently supported"} "At most 40 restrictions"}: "Only available in Performance Max and Search
 *                       campaigns (Brand Guidelines does not need to be enabled)" (performance-max/assets "Text guidelines").
 *                       Update masks text_guidelines.term_exclusions / text_guidelines.messaging_restrictions (each list
 *                       written whole).
 *   page feeds          performance-max/assets "Text customization": URL inclusions (page feeds: an AssetSet of type
 *                       PAGE_FEED holding PageFeedAsset assets) are linked to a Performance Max campaign with a
 *                       CampaignAssetSet ("the same process as used for Dynamic Search Ads", docs/dynamic-search-ads/
 *                       dsa-page-feeds); "Both the CampaignAssetSet for AssetSet of type PAGE_FEED and TEXT_ASSET_AUTOMATION
 *                       set to OPTED_IN … must be present together … If you want to set TEXT_ASSET_AUTOMATION to OPTED_OUT,
 *                       you must first remove the CampaignAssetSet … you must opt-in to TEXT_ASSET_AUTOMATION before creating
 *                       a CampaignAssetSet … OPERATION_NOT_PERMITTED_FOR_CONTEXT". CampaignAssetSetOperation create | remove
 *                       (customers/{c}/campaignAssetSets/{campaign_id}~{asset_set_id}); MutateOperation
 *                       campaign_asset_set_operation. So a link goes after the campaign's automation update, an unlink
 *                       before it (one request, in that order).
 *   AssetGroup          tracking_url_template, final_url_suffix, url_custom_parameters[] (CustomParameter) — not Immutable;
 *                       the rules Nexus checks first are G3's (change-urls.ts urlItemProblems).
 *
 * Money. Enabling an asset group (or a new one in an enabled campaign: made PAUSED unless asked), a bidding raise, final
 * URL expansion turned on, a URL or brand exclusion taken off, audience signals or search themes added, a product tree
 * that advertises products it did not, a page feed linked, a text guideline taken away — in an ENABLED campaign (and an
 * enabled asset group) — are SPENDS MONEY; in a paused campaign they are said as warnings (nothing spends until it is
 * enabled). Tracking (templates, suffixes, custom parameters) moves no money.
 */
import { changeLines, keywordTextProblem, plural, type GoogleChangeDraft } from './change-draft.js'
import { httpsUrlProblem, tagWarning, textKey, widthProblem } from './change-ads.js'
import { imageProblem, MAX_IMAGE_BYTES_TOTAL, type ImageFieldType } from './change-assets-all.js'
import { biddingFields, biddingMask, biddingSpends, biddingText, type Bidding } from './change-campaigns.js'
import { DIMENSIONS, caseValueOf, dimensionWords, snapshotOf, treeOfLive, treeOfSpec, valueKey, walk, type Dimension, type TNode, type TreeSpecNode } from './product-tree.js'
import { urlItemProblems } from './change-urls.js'
import {
  textGuidelinesBody, textGuidelinesOfAsk, urlExclusionKey, urlExclusionOfKey, urlExclusionsOf, type TextGuidelinesAsk, type UrlExclusion,
} from './change-ai-controls.js'
export { TEXT_GUIDELINES_LIMITS, textGuidelinesBody, textGuidelinesOfAsk, urlExclusionKey, urlExclusionOfKey, urlExclusionsOf } from './change-ai-controls.js'
export type { TextGuidelinesAsk, UrlExclusion } from './change-ai-controls.js'
import type { PreparedImage } from './asset-images.js'
import type { ProductGroupNode } from './live-product-groups.js'
import type { CustomParameter, PageFeedRef, PmaxAsset, PmaxAssetGroup, PmaxAudience, PmaxCampaignLive, PmaxFilterNode, PmaxLink, TextGuidelines } from './live-pmax.js'
import type { GoogleMutateOperation, GoogleMutateResponse } from './write-client.js'

// ── field types and Google's minimums ────────────────────────────────────────────────────────────────────────────

export const PMAX_IMAGE_FIELDS = ['MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE', 'LOGO', 'LANDSCAPE_LOGO'] as const
export type PmaxImageField = typeof PMAX_IMAGE_FIELDS[number]
export const PMAX_GROUP_FIELDS = [
  'HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION', 'BUSINESS_NAME', ...PMAX_IMAGE_FIELDS, 'YOUTUBE_VIDEO', 'CALL_TO_ACTION_SELECTION',
] as const
export type PmaxGroupField = typeof PMAX_GROUP_FIELDS[number]
/** The brand's assets: on the campaign with brand guidelines on, in each asset group with them off. */
export const BRAND_FIELDS: readonly string[] = ['BUSINESS_NAME', 'LOGO', 'LANDSCAPE_LOGO']
export const TEXT_MAX: Record<string, number> = { HEADLINE: 30, LONG_HEADLINE: 90, DESCRIPTION: 90, BUSINESS_NAME: 25 }
export const SHORT_DESCRIPTION = 60
/** How many of each field type an asset group holds (performance-max/asset-requirements). */
export const GROUP_COUNTS: Record<PmaxGroupField, { min: number; max: number }> = {
  HEADLINE: { min: 3, max: 15 }, LONG_HEADLINE: { min: 1, max: 5 }, DESCRIPTION: { min: 2, max: 5 },
  MARKETING_IMAGE: { min: 1, max: 20 }, SQUARE_MARKETING_IMAGE: { min: 1, max: 20 }, PORTRAIT_MARKETING_IMAGE: { min: 0, max: 20 },
  YOUTUBE_VIDEO: { min: 0, max: 15 }, CALL_TO_ACTION_SELECTION: { min: 0, max: 1 },
  BUSINESS_NAME: { min: 1, max: 1 }, LOGO: { min: 1, max: 5 }, LANDSCAPE_LOGO: { min: 0, max: 20 },
}
/** The asset type each field type takes. */
const ASSET_TYPE: Record<PmaxGroupField, string> = {
  HEADLINE: 'TEXT', LONG_HEADLINE: 'TEXT', DESCRIPTION: 'TEXT', BUSINESS_NAME: 'TEXT', MARKETING_IMAGE: 'IMAGE',
  SQUARE_MARKETING_IMAGE: 'IMAGE', PORTRAIT_MARKETING_IMAGE: 'IMAGE', LOGO: 'IMAGE', LANDSCAPE_LOGO: 'IMAGE',
  YOUTUBE_VIDEO: 'YOUTUBE_VIDEO', CALL_TO_ACTION_SELECTION: 'CALL_TO_ACTION',
}
/** CallToActionTypeEnum v25. */
export const CALL_TO_ACTIONS = [
  'LEARN_MORE', 'GET_QUOTE', 'APPLY_NOW', 'SIGN_UP', 'CONTACT_US', 'SUBSCRIBE', 'DOWNLOAD', 'BOOK_NOW', 'SHOP_NOW', 'BUY_NOW',
  'DONATE_NOW', 'ORDER_NOW', 'PLAY_NOW', 'SEE_MORE', 'START_NOW', 'VISIT_SITE', 'WATCH_NOW',
] as const
/** The automation switches Nexus changes, and Google's default for a Performance Max campaign (all on). */
export const AUTOMATION_TYPES = {
  finalUrlExpansion: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION',
  textCustomization: 'TEXT_ASSET_AUTOMATION',
  imageEnhancement: 'GENERATE_IMAGE_ENHANCEMENT',
  videoEnhancement: 'GENERATE_ENHANCED_YOUTUBE_VIDEOS',
} as const
export type AutomationKey = keyof typeof AUTOMATION_TYPES
export const AUTOMATION_KEYS = Object.keys(AUTOMATION_TYPES) as AutomationKey[]
const AUTOMATION_WORD: Record<AutomationKey, string> = {
  finalUrlExpansion: 'final URL expansion', textCustomization: 'text customization', imageEnhancement: 'image enhancement', videoEnhancement: 'video enhancement',
}
const listText = (l: string[] | undefined) => (l?.length ? l.map((t) => `"${t.length > 50 ? `${t.slice(0, 49)}…` : t}"`).join(', ') : '(none)')

/** Brand guideline fonts Google takes (performance-max/create-campaign, case-sensitive). */
export const BRAND_FONTS = ['Open Sans', 'Roboto', 'Montserrat', 'Poppins', 'Lato', 'Oswald', 'Playfair Display', 'Roboto Slab'] as const
/** Audience segment kinds an Audience is made of (AudienceSegment v25) and their resource collections. */
export const SEGMENT_KINDS = ['USER_LIST', 'USER_INTEREST', 'CUSTOM_AUDIENCE', 'LIFE_EVENT', 'DETAILED_DEMOGRAPHIC'] as const
export type SegmentKind = typeof SEGMENT_KINDS[number]
const SEGMENT: Record<SegmentKind, { key: string; field: string; collection: string }> = {
  USER_LIST: { key: 'userList', field: 'userList', collection: 'userLists' },
  USER_INTEREST: { key: 'userInterest', field: 'userInterestCategory', collection: 'userInterests' },
  CUSTOM_AUDIENCE: { key: 'customAudience', field: 'customAudience', collection: 'customAudiences' },
  LIFE_EVENT: { key: 'lifeEvent', field: 'lifeEvent', collection: 'lifeEvents' },
  DETAILED_DEMOGRAPHIC: { key: 'detailedDemographic', field: 'detailedDemographic', collection: 'detailedDemographics' },
}
/** A Performance Max product tree splits by these (ListingGroupFilterDimension: no channel exclusivity). */
export const PMAX_DIMENSIONS = DIMENSIONS.filter((d) => d !== 'CHANNEL_EXCLUSIVITY') as Dimension[]
export const MAX_ASSET_GROUPS = 100
const WORD: Record<string, string> = {
  HEADLINE: 'headline', LONG_HEADLINE: 'long headline', DESCRIPTION: 'description', BUSINESS_NAME: 'business name',
  MARKETING_IMAGE: 'landscape image', SQUARE_MARKETING_IMAGE: 'square image', PORTRAIT_MARKETING_IMAGE: 'portrait image',
  LOGO: 'logo', LANDSCAPE_LOGO: 'landscape logo', YOUTUBE_VIDEO: 'video', CALL_TO_ACTION_SELECTION: 'call to action',
}
const TEXT_ARG: Record<string, PmaxGroupField> = { headlines: 'HEADLINE', longHeadlines: 'LONG_HEADLINE', descriptions: 'DESCRIPTION' }

// ── requests ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PmaxImageAsk { fieldType: PmaxImageField; imageUrl?: string | null; libraryImageId?: string | null; name?: string | null }
export interface AssetLinkRef { assetId: string; fieldType: PmaxGroupField }
/** Assets to add (to an asset group, or the brand's on the campaign): new ones by their content, existing ones by id. */
export interface PmaxAssetsAsk {
  headlines?: string[]
  longHeadlines?: string[]
  descriptions?: string[]
  adBusinessName?: string | null
  images?: PmaxImageAsk[]
  /** YouTube video ids (11 characters) or YouTube links. */
  videos?: string[]
  callToAction?: string | null
  link?: AssetLinkRef[]
}
export interface PmaxSignalsAsk {
  audiences?: string[]
  newAudiences?: Array<{ name: string; segments: Array<{ kind: SegmentKind; id: string }> }>
  searchThemes?: string[]
}
/** One node of a product tree (G4's tree shape): a unit is included unless `excluded`; a split has none of them. */
export interface PmaxTreeNode { parent?: number; value?: string; everythingElse?: boolean; split?: Dimension; excluded?: boolean }

/** Every image of a request, fetched first by the tool, by its slot (`imageSlot`). */
export type PreparedImages = Record<string, PreparedImage | { problem: string }>
export const imageSlot = (scope: string, index: number) => `${scope}:${index}`

// ── small helpers ───────────────────────────────────────────────────────────────────────────────────────────────

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/
/** A YouTube video id from an id or a youtube.com / youtu.be link; null when it is none. */
export function youtubeIdOf(value: string): string | null {
  const v = value.trim()
  if (YOUTUBE_ID.test(v)) return v
  try {
    const u = new URL(v)
    const host = u.hostname.replace(/^www\.|^m\./, '')
    const id = host === 'youtu.be' ? u.pathname.slice(1) : host === 'youtube.com' ? (u.searchParams.get('v') ?? u.pathname.split('/').filter(Boolean).pop() ?? '') : ''
    return YOUTUBE_ID.test(id) ? id : null
  } catch { return null }
}
const CUSTOMIZER = /\{[^}]*\}/
export const linkKey = (assetId: string, fieldType: string) => `${assetId}~${fieldType}`
export const tmp = (temp: number) => `tmp:${temp}`
const tempOf = (res: string) => res.slice(res.lastIndexOf('/') + 1)
/** An asset id for a record: its id, or `tmp:<temporary id>` until Google gives one. */
const idForRecord = (res: string) => { const t = tempOf(res); return t.startsWith('-') ? tmp(Number(t)) : t }
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort()
/** Advertiser links only: what Google made itself comes and goes on its own and is never counted, compared or copied. */
export const ownLinks = (links: PmaxLink[]) => links.filter((l) => l.source !== 'AUTOMATICALLY_CREATED')

// ── assets made in one request ─────────────────────────────────────────────────────────────────────────────────

export interface MadeAsset { res: string; type: string; label: string }

/** Makes new assets once per content in a request, each with a temporary id the links point at. */
export class AssetMaker {
  readonly ops: GoogleMutateOperation[] = []
  readonly made: MadeAsset[] = []
  bytes = 0
  private readonly byKey = new Map<string, string>()
  constructor(private readonly customer: string, private readonly temp: () => number) {}
  private make(key: string, body: Record<string, unknown>, type: string, label: string): string {
    const known = this.byKey.get(key)
    if (known) return known
    const res = `${this.customer}/assets/${this.temp()}`
    this.ops.push({ assetOperation: { create: { resourceName: res, ...body } } })
    this.byKey.set(key, res)
    this.made.push({ res, type, label })
    return res
  }
  text(text: string): string { return this.make(`T:${textKey(text)}`, { textAsset: { text: text.trim() } }, 'TEXT', text.trim()) }
  image(image: PreparedImage, name: string | null | undefined): string {
    const n = (name?.trim() || `${image.label ?? 'Image'} ${image.sha256.slice(0, 8)}`).slice(0, 120)
    if (!this.byKey.has(`I:${image.sha256}`)) this.bytes += image.bytes
    return this.make(`I:${image.sha256}`, { name: n, type: 'IMAGE', imageAsset: { data: image.data } }, 'IMAGE', `${n} (${image.width}×${image.height})`)
  }
  youtube(id: string): string { return this.make(`Y:${id}`, { youtubeVideoAsset: { youtubeVideoId: id } }, 'YOUTUBE_VIDEO', `YouTube ${id}`) }
  callToAction(type: string): string { return this.make(`C:${type}`, { callToActionAsset: { callToAction: type } }, 'CALL_TO_ACTION', type) }
}

/** What the request context gives the asset planning. */
export interface AssetContext {
  customer: string
  maker: AssetMaker
  /** Existing assets a request links by id (read live). */
  assets: Map<string, PmaxAsset>
  images: PreparedImages
  problems: string[]
  warnings: string[]
  skipped: string[]
  /** Assets a copy links again exactly as the source holds them: Google took them there, Nexus does not judge them again. */
  trusted?: Set<string>
}

/** One asset to link: the asset (a new one's temporary resource name, or an existing one's), as what, and how it reads. */
export interface PlannedLink { assetRes: string; fieldType: PmaxGroupField; label: string }

const contentKeyOfLink = (l: PmaxLink): string | null => {
  if (ASSET_TYPE[l.fieldType as PmaxGroupField] === 'TEXT' && l.text !== null) return `${l.fieldType}:${textKey(l.text)}`
  if (l.fieldType === 'YOUTUBE_VIDEO' && l.youtubeId) return `YOUTUBE_VIDEO:${l.youtubeId}`
  if (l.fieldType === 'CALL_TO_ACTION_SELECTION' && l.callToAction) return `CALL_TO_ACTION_SELECTION:${l.callToAction}`
  return null
}

/** Why a text cannot be an asset of this field type, or null. */
function textProblem(where: string, fieldType: PmaxGroupField, text: string, ctx: AssetContext): string | null {
  const p = widthProblem(where, text, TEXT_MAX[fieldType])
  if (p) return p
  if (CUSTOMIZER.test(text)) return `${where} "${text.trim().slice(0, 40)}" holds { … }: Google takes no ad customizer or keyword insertion in an asset group's text (AD_CUSTOMIZER_NOT_SUPPORTED)`
  const w = tagWarning(where, text)
  if (w) ctx.warnings.push(w)
  return null
}

/**
 * The links an "add assets" asks for, checked against Google's rules (text lengths, image shapes and types, video ids,
 * the type of an existing asset). Content already linked as that field type is skipped (said, not sent): a change sent
 * again after an unknown outcome adds nothing twice. `allowed` limits the field types (brand guidelines).
 */
export function planAssets(
  ctx: AssetContext, where: string, ask: PmaxAssetsAsk | undefined, slotScope: string, existing: PmaxLink[], allowed: (field: PmaxGroupField) => string | null,
): PlannedLink[] {
  if (!ask) return []
  const out: PlannedLink[] = []
  const have = new Set(ownLinks(existing).map(contentKeyOfLink).filter((k): k is string => !!k))
  const haveIds = new Set(ownLinks(existing).map((l) => linkKey(l.assetId, l.fieldType)))
  const seen = new Set<string>()
  const refuse = (field: PmaxGroupField) => { const why = allowed(field); if (why) ctx.problems.push(`${where}: ${why}`); return !!why }
  const once = (key: string, label: string) => {
    if (have.has(key)) { ctx.skipped.push(`${where}: ${label} is already there`); return false }
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
  for (const [arg, field] of Object.entries(TEXT_ARG)) {
    const texts = (ask as Record<string, string[] | undefined>)[arg] ?? []
    if (texts.length && refuse(field)) continue
    texts.forEach((t, i) => {
      const p = textProblem(`${where}, ${WORD[field]} ${i + 1}`, field, t, ctx)
      if (p) { ctx.problems.push(p); return }
      if (once(`${field}:${textKey(t)}`, `${WORD[field]} "${t.trim()}"`)) out.push({ assetRes: ctx.maker.text(t), fieldType: field, label: t.trim() })
    })
  }
  if (ask.adBusinessName !== undefined && ask.adBusinessName !== null && !refuse('BUSINESS_NAME')) {
    const p = textProblem(`${where}, business name`, 'BUSINESS_NAME', ask.adBusinessName, ctx)
    if (p) ctx.problems.push(p)
    else if (once(`BUSINESS_NAME:${textKey(ask.adBusinessName)}`, `business name "${ask.adBusinessName.trim()}"`)) out.push({ assetRes: ctx.maker.text(ask.adBusinessName), fieldType: 'BUSINESS_NAME', label: ask.adBusinessName.trim() })
  }
  ;(ask.images ?? []).forEach((img, i) => {
    const at = `${where}, image ${i + 1}`
    if (refuse(img.fieldType)) return
    const got = ctx.images[imageSlot(slotScope, i)]
    if (!got) { ctx.problems.push(`${at}: Nexus did not read it`); return }
    if ('problem' in got) { ctx.problems.push(`${at}: ${got.problem}`); return }
    const p = imageProblem(at, img.fieldType as ImageFieldType, got)
    if (p) { ctx.problems.push(p); return }
    const res = ctx.maker.image(got, img.name)
    if (once(`${img.fieldType}:I:${got.sha256}`, `${WORD[img.fieldType]} ${got.sha256.slice(0, 8)}`)) out.push({ assetRes: res, fieldType: img.fieldType, label: `${img.name?.trim() || got.label || 'image'} (${got.width}×${got.height})` })
  })
  const videos = ask.videos?.length && refuse('YOUTUBE_VIDEO') ? [] : ask.videos ?? []
  videos.forEach((v, i) => {
    const id = youtubeIdOf(v)
    if (!id) { ctx.problems.push(`${where}, video ${i + 1}: "${v.slice(0, 60)}" is not a YouTube video id (11 characters) or a YouTube link`); return }
    if (once(`YOUTUBE_VIDEO:${id}`, `video ${id}`)) out.push({ assetRes: ctx.maker.youtube(id), fieldType: 'YOUTUBE_VIDEO', label: `YouTube ${id}` })
  })
  if (ask.callToAction && !refuse('CALL_TO_ACTION_SELECTION')) {
    if (!(CALL_TO_ACTIONS as readonly string[]).includes(ask.callToAction)) ctx.problems.push(`${where}: "${ask.callToAction}" is not a call to action Google knows (${CALL_TO_ACTIONS.join(', ')})`)
    else if (once(`CALL_TO_ACTION_SELECTION:${ask.callToAction}`, `call to action ${ask.callToAction}`)) out.push({ assetRes: ctx.maker.callToAction(ask.callToAction), fieldType: 'CALL_TO_ACTION_SELECTION', label: ask.callToAction })
  }
  for (const l of ask.link ?? []) {
    const at = `${where}, asset ${l.assetId} as ${WORD[l.fieldType] ?? l.fieldType}`
    if (refuse(l.fieldType)) continue
    const a = ctx.assets.get(l.assetId)
    if (!a) { ctx.problems.push(`${at}: asset ${l.assetId} is not in this account`); continue }
    const want = ASSET_TYPE[l.fieldType]
    const judged = !ctx.trusted?.has(l.assetId)
    if (a.type !== want) { ctx.problems.push(`${at}: it is a ${a.type ?? 'different'} asset, and a ${WORD[l.fieldType]} is a ${want} asset`); continue }
    if (judged && want === 'TEXT') { const p = textProblem(at, l.fieldType, a.text ?? '', ctx); if (p) { ctx.problems.push(p); continue } }
    if (judged && want === 'IMAGE' && a.width && a.height && a.mimeType) {
      const p = imageProblem(at, l.fieldType as ImageFieldType, { mimeType: a.mimeType as PreparedImage['mimeType'], width: a.width, height: a.height })
      if (p) { ctx.problems.push(p); continue }
    }
    const key = linkKey(l.assetId, l.fieldType)
    if (haveIds.has(key)) { ctx.skipped.push(`${at}: already linked`); continue }
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ assetRes: `${ctx.customer}/assets/${l.assetId}`, fieldType: l.fieldType, label: a.text ?? a.name ?? (a.youtubeId ? `YouTube ${a.youtubeId}` : `asset ${l.assetId}`) })
  }
  return out
}

export type FieldCounts = Partial<Record<string, number>>
export function countsOf(links: Array<{ fieldType: string }>): FieldCounts {
  const out: FieldCounts = {}
  for (const l of links) out[l.fieldType] = (out[l.fieldType] ?? 0) + 1
  return out
}
const total = (c: FieldCounts) => Object.values(c).reduce<number>((s, n) => s + (n ?? 0), 0)

/**
 * Google's minimums of an asset group, on what it holds after the change: in full for a new asset group (and a retail one
 * that had no asset), else only where the change makes a count worse (a group Google already took stays as it is).
 * A retail asset group may hold no asset at all.
 */
export function groupCountProblems(
  where: string,
  o: { before: FieldCounts | null; after: FieldCounts; retail: boolean; brandInGroup: boolean; shortBefore: boolean; shortAfter: boolean },
): string[] {
  const problems: string[] = []
  const afterTotal = total(o.after)
  if (o.retail && afterTotal === 0) return problems
  const full = o.before === null || (o.retail && total(o.before) === 0)
  const fields = PMAX_GROUP_FIELDS.filter((f) => o.brandInGroup || !BRAND_FIELDS.includes(f))
  for (const f of fields) {
    const n = o.after[f] ?? 0
    const was = o.before?.[f] ?? 0
    const { min, max } = GROUP_COUNTS[f]
    if (n < min && (full || n < was)) problems.push(`${where}: ${plural(n, WORD[f])} (Google needs at least ${min})`)
    if (n > max && (full || n > was)) problems.push(`${where}: ${plural(n, WORD[f])} (Google allows at most ${max})`)
  }
  if (!o.shortAfter && (o.after.DESCRIPTION ?? 0) > 0 && (full || o.shortBefore)) problems.push(`${where}: no description of ${SHORT_DESCRIPTION} characters or fewer (Google needs one: SHORT_DESCRIPTION_REQUIRED)`)
  return problems
}

/** The brand's assets on a campaign with brand guidelines on: exactly one business name, one to five logos (landscape ones count). */
export function brandCountProblems(where: string, c: FieldCounts, before: FieldCounts | null): string[] {
  const problems: string[] = []
  const name = c.BUSINESS_NAME ?? 0
  const logos = c.LOGO ?? 0
  const all = logos + (c.LANDSCAPE_LOGO ?? 0)
  const worse = (now: number, was: number | undefined, low: boolean) => before === null || (low ? now < (was ?? 0) : now > (was ?? 0))
  if (name !== 1 && worse(name, before?.BUSINESS_NAME, name < 1)) problems.push(`${where}: ${plural(name, 'business name')} (brand guidelines need exactly one, linked to the campaign)`)
  if (logos < 1 && worse(logos, before?.LOGO, true)) problems.push(`${where}: no logo (brand guidelines need at least one square LOGO, linked to the campaign)`)
  if (all > 5 && worse(all, (before?.LOGO ?? 0) + (before?.LANDSCAPE_LOGO ?? 0), false)) problems.push(`${where}: ${all} logos (brand guidelines take at most five, LOGO and LANDSCAPE_LOGO together)`)
  return problems
}

const isShort = (texts: string[]) => texts.some((t) => textKey(t).length > 0 && textKey(t).length <= SHORT_DESCRIPTION)

// ── listing group trees ───────────────────────────────────────────────────────────────────────────────────────────

const OTHER = '\u0000other'
const childKey = (parent: TNode, c: TNode) => (c.value === null ? OTHER : valueKey(parent.split ?? c.dim, c.value))
const kidsInOrder = (n: TNode) => [...n.children].sort((a, b) => {
  const x = childKey(n, a)
  const y = childKey(n, b)
  return x === y ? 0 : x === OTHER ? 1 : y === OTHER ? -1 : x < y ? -1 : 1
})

/** A product tree a person gave, checked against Google's rules (G4's checks: product-tree.ts treeOfSpec). */
export function pmaxTreeOfSpec(spec: PmaxTreeNode[], where: string): { root: TNode } | { refusal: string } {
  for (const [i, n] of spec.entries()) {
    if (n.split === 'CHANNEL_EXCLUSIVITY') return { refusal: `${where}[${i}]: Performance Max splits products by item ID, brand, condition, channel, product type, category or custom label — not by channel exclusivity (ListingGroupFilterDimension v25).` }
  }
  // A Performance Max unit has no bid: G4's checks take a unit's state as a bid or excluded, so an included unit is
  // given a placeholder bid that is never sent.
  const mapped: TreeSpecNode[] = spec.map((n) => {
    const { excluded, ...rest } = n
    if (n.split) return excluded === undefined || excluded === false ? rest : { ...rest, excluded }
    return excluded ? { ...rest, excluded: true } : { ...rest, bidCents: 1 }
  })
  const tree = treeOfSpec(mapped, where)
  if ('refusal' in tree) return { refusal: tree.refusal.replace(/give its bidCents \(a click\), or excluded: true/, 'give excluded: true or leave it included') }
  for (const w of walk(tree.root)) w.node.bidCents = null
  return tree
}

/** The tree Google holds for one asset group (its filters), or why it is not a product tree Nexus changes. */
export function pmaxTreeOfLive(nodes: PmaxFilterNode[]): { root: TNode | null } | { refusal: string } {
  if (nodes.some((n) => n.listingSource && n.listingSource !== 'SHOPPING')) {
    return { refusal: 'its listing group filters are not a product tree (a page feed or other source): change them in Google Ads' }
  }
  const asGroups: ProductGroupNode[] = nodes.map((n) => ({
    criterionId: n.id, parentId: n.parentId, kind: n.type === 'SUBDIVISION' ? 'SUBDIVISION' : 'UNIT', caseValue: n.caseValue,
    dimension: n.dimension, value: n.value, excluded: n.type === 'UNIT_EXCLUDED', bidCents: null,
  }))
  return treeOfLive(asGroups)
}

/** A tree as a record keeps it (no ids, no bids): the same tree always gives the same list. */
export interface PmaxTreeSnap { parent: number | null; dim: Dimension | null; value: string | null; kind: 'SUBDIVISION' | 'UNIT'; split: Dimension | null; excluded: boolean }
export const pmaxSnapshot = (root: TNode | null): PmaxTreeSnap[] | null =>
  root ? snapshotOf(root).map((s) => ({ parent: s.parent, dim: s.dim, value: s.value, kind: s.kind, split: s.split, excluded: s.excluded })) : null

/** A snapshot as the `productGroups` argument that builds it again, or why it cannot be given. */
export function pmaxSpecOfSnapshot(snap: PmaxTreeSnap[]): PmaxTreeNode[] | { refusal: string } {
  const out: PmaxTreeNode[] = []
  for (const [i, s] of snap.entries()) {
    if (i > 0 && (s.dim === null || s.parent === null)) return { refusal: 'the tree had a product group of a dimension Nexus cannot tell' }
    if (s.kind === 'SUBDIVISION' && !s.split) return { refusal: 'the tree had a split by a dimension Nexus cannot tell' }
    out.push({
      ...(i > 0 ? { parent: s.parent! } : {}),
      ...(i > 0 ? (s.value === null ? { everythingElse: true } : { value: s.value }) : {}),
      ...(s.kind === 'SUBDIVISION' ? { split: s.split! } : s.excluded ? { excluded: true } : {}),
    })
  }
  return out
}

/** A tree in a sentence. */
export function describePmaxTree(root: TNode | null): string {
  if (!root) return 'no product tree (the asset group shows no products)'
  if (root.kind === 'UNIT') return root.excluded ? '"All products" excluded' : '"All products"'
  const all = walk(root)
  const units = all.filter((w) => w.node.kind === 'UNIT')
  const excluded = units.filter((w) => w.node.excluded).length
  return `"All products" split by ${dimensionWords(root.split)}: ${plural(all.length, 'product group')} (${plural(units.length - excluded, 'included')}, ${excluded} excluded)`
}

const filterRes = (customer: string, groupId: string, id: string | number) => `${customer}/assetGroupListingGroupFilters/${groupId}~${id}`

/**
 * The operations that turn one asset group's live tree into the desired one: nodes that stay (same place, same kind)
 * keep their ids; the rest are removed — leaves first, Google's order — and made again, parents first. Removals go before
 * creations (Google's own sample sends both in one request).
 */
export function pmaxTreeOps(customer: string, groupRes: string, live: TNode | null, desired: TNode | null, temp: () => number): { removes: GoogleMutateOperation[]; creates: GoogleMutateOperation[] } {
  const groupId = tempOf(groupRes)
  const removes: GoogleMutateOperation[] = []
  const creates: GoogleMutateOperation[] = []
  const removeTree = (n: TNode) => {
    for (const c of kidsInOrder(n)) removeTree(c)
    removes.push({ assetGroupListingGroupFilterOperation: { remove: filterRes(customer, groupId, n.id!) } })
  }
  const make = (d: TNode, parentRes: string | null, caseValue: Record<string, unknown> | null) => {
    const res = filterRes(customer, groupId, temp())
    creates.push({ assetGroupListingGroupFilterOperation: { create: {
      resourceName: res, assetGroup: groupRes, type: d.kind === 'SUBDIVISION' ? 'SUBDIVISION' : d.excluded ? 'UNIT_EXCLUDED' : 'UNIT_INCLUDED',
      listingSource: 'SHOPPING', ...(parentRes ? { parentListingGroupFilter: parentRes } : {}), ...(caseValue ? { caseValue } : {}),
    } } })
    if (d.kind === 'SUBDIVISION') for (const c of kidsInOrder(d)) make(c, res, caseValueOf(d.split!, c.value))
  }
  const match = (l: TNode, d: TNode, parentRes: string | null, liveParent: TNode | null) => {
    if (liveParent) { d.value = l.value; d.caseValue = l.caseValue }
    if (l.kind === 'UNIT' && d.kind === 'UNIT' && l.excluded === d.excluded) { d.id = l.id; return }
    if (l.kind === 'SUBDIVISION' && d.kind === 'SUBDIVISION' && l.split && l.split === d.split) {
      d.id = l.id
      const res = filterRes(customer, groupId, l.id!)
      const byKey = new Map(l.children.map((c) => [childKey(l, c), c]))
      const paired = new Set<TNode>()
      for (const dc of kidsInOrder(d)) {
        const lc = byKey.get(childKey(d, dc))
        if (lc) { paired.add(lc); match(lc, dc, res, l) } else make(dc, res, caseValueOf(d.split!, dc.value))
      }
      for (const lc of kidsInOrder(l)) if (!paired.has(lc)) removeTree(lc)
      return
    }
    removeTree(l)
    make(d, parentRes, liveParent ? (l.caseValue ?? (d.dim ? caseValueOf(d.dim, d.value) : null)) : null)
  }
  if (live && desired) match(live, desired, null, null)
  else if (desired) make(desired, null, null)
  else if (live) removeTree(live)
  return { removes, creates }
}

type Cover = 'all' | 'none' | 'some'
const merge = (covers: Cover[]): Cover => (covers.every((c) => c === 'all') ? 'all' : covers.every((c) => c === 'none') ? 'none' : 'some')
const coverUnder = (n: TNode): Cover => merge(walk(n).filter((w) => w.node.kind === 'UNIT').map((w) => (w.node.excluded ? 'none' : 'all')))

/** How the live tree advertised the products of a desired node (its chain, root first): all of them, none, or some. */
function liveCover(live: TNode | null, chain: TNode[]): Cover {
  if (!live) return 'none'
  let node = live
  for (let i = 1; i < chain.length; i++) {
    if (node.kind === 'UNIT') break
    const step = chain[i]
    if (!node.split || node.split !== step.dim) return coverUnder(node)
    if (step.value === null) {
      // "Everything else" here: what the live split names and the desired split does not, and the live "everything else".
      const named = new Set(chain[i - 1].children.filter((c) => c.value !== null).map((c) => childKey(chain[i - 1], c)))
      return merge(node.children.filter((c) => c.value === null || !named.has(childKey(node, c))).map(coverUnder))
    }
    const next = node.children.find((c) => childKey(node, c) === valueKey(step.dim, step.value!)) ?? node.children.find((c) => c.value === null)
    if (!next) return coverUnder(node)
    node = next
  }
  return node.kind === 'UNIT' ? (node.excluded ? 'none' : 'all') : coverUnder(node)
}

const pathWords = (chain: TNode[]) => (chain.length <= 1 ? '"All products"' : chain.slice(1).map((n) => (n.value === null ? `everything else (by ${dimensionWords(n.dim)})` : `${dimensionWords(n.dim)} "${n.value}"`)).join(' › '))

/** The products a desired tree advertises that the live tree did not (wholly): each in words. */
export function pmaxTreeWidens(live: TNode | null, desired: TNode | null): string[] {
  if (!desired) return []
  return walk(desired).filter((w) => w.node.kind === 'UNIT' && !w.node.excluded && liveCover(live, w.chain) !== 'all').map((w) => pathWords(w.chain))
}

// ── signals ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const signalKeyOfAudience = (audienceId: string) => `a:${audienceId}`
/**
 * A search theme as a record keeps it: its own text (undo gives it back as it was). Google compares themes without case,
 * so Nexus does too (`sameSignal`).
 */
export const signalKeyOfTheme = (text: string) => `t:${textKey(text)}`
/** Two signal keys name the same signal: an audience by id, a search theme by its text without case. */
export const sameSignal = (key: string) => (key.startsWith('t:') ? key.toLowerCase() : key)
const themeText = (key: string) => key.slice(2)

export interface PlannedSignals { ops: GoogleMutateOperation[]; audienceOps: GoogleMutateOperation[]; added: string[]; lines: string[] }

/** The signals to add to an asset group: existing audiences, new ones (made in the request), search themes. */
export function planSignals(
  ctx: { customer: string; temp: () => number; problems: string[]; skipped: string[]; audiences: PmaxAudience[]; takenAudienceNames: Set<string> },
  where: string, groupRes: string, groupId: string | null, ask: PmaxSignalsAsk | undefined, existing: string[],
): PlannedSignals {
  const out: PlannedSignals = { ops: [], audienceOps: [], added: [], lines: [] }
  if (!ask) return out
  const have = new Set(existing.map(sameSignal))
  const seen = new Set<string>()
  const add = (key: string, signal: Record<string, unknown>, line: string) => {
    if (have.has(sameSignal(key))) { ctx.skipped.push(`${where}: ${line} is already a signal`); return }
    if (seen.has(sameSignal(key))) return
    seen.add(sameSignal(key))
    out.ops.push({ assetGroupSignalOperation: { create: { assetGroup: groupRes, ...signal } } })
    out.added.push(key)
    out.lines.push(line)
  }
  for (const id of ask.audiences ?? []) {
    const a = ctx.audiences.find((x) => x.audienceId === id)
    if (!a) { ctx.problems.push(`${where}: audience ${id} is not an audience of this account (google-ads-query: SELECT audience.id, audience.name FROM audience)`); continue }
    if (a.scope === 'ASSET_GROUP' && a.assetGroupId !== groupId) { ctx.problems.push(`${where}: audience ${id} belongs to another asset group (AUDIENCE_WITH_WRONG_ASSET_GROUP_ID)`); continue }
    add(signalKeyOfAudience(id), { audience: { audience: `${ctx.customer}/audiences/${id}` } }, `audience "${a.name ?? id}"`)
  }
  for (const n of ask.newAudiences ?? []) {
    const name = n.name.trim()
    if (!name || name.length > 255) { ctx.problems.push(`${where}: a new audience's name is 1 to 255 characters`); continue }
    if (ctx.takenAudienceNames.has(name.toLowerCase())) { ctx.problems.push(`${where}: an audience named "${name}" already exists (Google keeps audience names unique)`); continue }
    if (!n.segments.length) { ctx.problems.push(`${where}: new audience "${name}" names no segment`); continue }
    const bad = n.segments.find((s) => !/^\d{1,20}$/.test(s.id))
    if (bad) { ctx.problems.push(`${where}: new audience "${name}": segment "${bad.id}" is not a Google id`); continue }
    ctx.takenAudienceNames.add(name.toLowerCase())
    const res = `${ctx.customer}/audiences/${ctx.temp()}`
    const segments = n.segments.map((s) => ({ [SEGMENT[s.kind].key]: { [SEGMENT[s.kind].field]: `${ctx.customer}/${SEGMENT[s.kind].collection}/${s.id}` } }))
    out.audienceOps.push({ audienceOperation: { create: { resourceName: res, name, dimensions: [{ audienceSegments: { segments } }] } } })
    add(signalKeyOfAudience(idForRecord(res)), { audience: { audience: res } }, `new audience "${name}" (${plural(n.segments.length, 'segment')})`)
  }
  for (const t of ask.searchThemes ?? []) {
    const p = keywordTextProblem(t)
    if (p) { ctx.problems.push(`${where}: search theme "${t.slice(0, 60)}" ${p}`); continue }
    add(signalKeyOfTheme(t), { searchTheme: { text: t.trim() } }, `search theme "${t.trim()}"`)
  }
  return out
}

/** The live signals of an asset group as keys (an audience by id, a search theme by its text). */
export const signalKeysOf = (g: PmaxAssetGroup) => sorted(g.signals.map((s) => (s.audienceId ? signalKeyOfAudience(s.audienceId) : s.searchTheme ? signalKeyOfTheme(s.searchTheme) : `?:${s.signalId}`)))

// ── the change of a live Performance Max campaign ──────────────────────────────────────────────────────────────

export interface PmaxGroupChange {
  /** An existing asset group; left out = a new one (name and finalUrls needed). */
  assetGroupId?: string
  /** The asset group's own tracking ('' / [] / null takes it away: the campaign's then applies). */
  trackingTemplate?: string | null
  finalUrlSuffix?: string | null
  customParameters?: CustomParameter[] | null
  name?: string
  status?: 'ENABLED' | 'PAUSED'
  finalUrls?: string[]
  /** [] clears them. */
  finalMobileUrls?: string[]
  /** '' clears it (path2 too). */
  path1?: string
  path2?: string
  addAssets?: PmaxAssetsAsk
  removeAssets?: AssetLinkRef[]
  /** Retail: the whole product group tree as it should be. */
  productGroups?: PmaxTreeNode[]
  /** Removes the whole product group tree (the asset group then shows no products). */
  clearProductGroups?: boolean
  addSignals?: PmaxSignalsAsk
  removeSignals?: { audiences?: string[]; searchThemes?: string[] }
  /** A new asset group in an ENABLED campaign is made PAUSED unless this (SPENDS MONEY). */
  enable?: boolean
}

export interface PmaxChangeRequest {
  campaignId: string
  settings?: { name?: string; bidding?: Bidding; startDate?: string; endDate?: string }
  automation?: Partial<Record<AutomationKey, boolean>>
  urlExclusions?: { add?: UrlExclusion[]; remove?: UrlExclusion[] }
  brandExclusions?: { add?: string[]; remove?: string[] }
  brandAssets?: { add?: PmaxAssetsAsk; remove?: AssetLinkRef[] }
  /** What Google's generated text never says: each list WHOLE (a list left out stays). */
  textGuidelines?: TextGuidelinesAsk
  /** Page feeds (URL inclusions) of the account to link to the campaign or unlink from it, by id. */
  pageFeeds?: { link?: string[]; unlink?: string[] }
  assetGroups?: PmaxGroupChange[]
}

export interface PmaxChangeLive {
  campaign: PmaxCampaignLive | null
  /** Every campaign's name (a new name is unique in the account). */
  campaignNames: Array<{ campaignId: string; name: string }>
  assets: PmaxAsset[]
  audiences: PmaxAudience[]
  brandLists: Array<{ listId: string; name: string | null }>
  images: PreparedImages
  /** The account's page feeds (read when the change links one). */
  pageFeeds?: PageFeedRef[]
}

/** The facts of a campaign a change touches (and what undo puts back): only the keys it touched. */
export interface PmaxCampaignFacts {
  name?: string
  bidding?: Bidding | null
  startDate?: string | null
  endDate?: string
  automation?: Partial<Record<AutomationKey, 'OPTED_IN' | 'OPTED_OUT'>>
  urlExclusions?: string[]
  brandExclusions?: string[]
  brandLinks?: string[]
  /** Only the lists the change wrote. */
  textGuidelines?: TextGuidelinesAsk
  /** The page feeds linked (ids, sorted). */
  pageFeeds?: string[]
}
export interface PmaxGroupFacts {
  assetGroupId: string
  created?: true
  name?: string
  status?: string | null
  finalUrls?: string[]
  finalMobileUrls?: string[]
  path1?: string | null
  path2?: string | null
  links?: string[]
  tree?: PmaxTreeSnap[] | null
  signals?: string[]
  trackingTemplate?: string | null
  finalUrlSuffix?: string | null
  customParameters?: CustomParameter[]
}
export interface PmaxChangeRecord { campaignId: string; campaign: PmaxCampaignFacts; groups: PmaxGroupFacts[] }

const dayOf = (dateTime: string | null) => (dateTime ? dateTime.slice(0, 10) : null)
const endOf = (dateTime: string | null) => { const d = dayOf(dateTime); return d && !d.startsWith('2037-12-30') ? d : 'none' }
const DAY = /^\d{4}-\d{2}-\d{2}$/
/** The bidding a Performance Max campaign has (Maximize conversions / conversion value), or null for another. */
export function pmaxBiddingNow(c: Pick<PmaxCampaignLive, 'biddingType' | 'targetCpaCents' | 'targetRoas'>): Bidding | null {
  if (c.biddingType === 'MAXIMIZE_CONVERSIONS') return { strategy: 'MAXIMIZE_CONVERSIONS', ...(c.targetCpaCents ? { targetCpaCents: c.targetCpaCents } : {}) }
  if (c.biddingType === 'MAXIMIZE_CONVERSION_VALUE') return { strategy: 'MAXIMIZE_CONVERSION_VALUE', ...(c.targetRoas ? { targetRoas: c.targetRoas } : {}) }
  return null
}
const cleanBidding = (b: Bidding): Bidding => (b.strategy === 'MAXIMIZE_CONVERSIONS'
  ? { strategy: b.strategy, ...(b.targetCpaCents ? { targetCpaCents: b.targetCpaCents } : {}) }
  : { strategy: b.strategy, ...(b.targetRoas ? { targetRoas: b.targetRoas } : {}) })

/** A switch as Google holds it (a type it left out is at its Performance Max default: on). */
export const automationNow = (c: Pick<PmaxCampaignLive, 'automation'>, key: AutomationKey): 'OPTED_IN' | 'OPTED_OUT' =>
  (c.automation[AUTOMATION_TYPES[key]] === 'OPTED_OUT' ? 'OPTED_OUT' : 'OPTED_IN')

export const brandExclusionsOf = (c: PmaxCampaignLive) => c.criteria.filter((k) => k.type === 'BRAND_LIST' && k.negative && k.brandListId).map((k) => ({ listId: k.brandListId!, criterionId: k.criterionId }))
export const brandLinksOf = (c: PmaxCampaignLive) => ownLinks(c.campaignAssets).filter((l) => BRAND_FIELDS.includes(l.fieldType))

/** The facts of a live campaign, for the keys of `keys` (what a change touched). */
export function campaignFactsOf(c: PmaxCampaignLive, keys: PmaxCampaignFacts): PmaxCampaignFacts {
  const out: PmaxCampaignFacts = {}
  if ('name' in keys) out.name = c.name
  if ('bidding' in keys) out.bidding = pmaxBiddingNow(c)
  if ('startDate' in keys) out.startDate = dayOf(c.start)
  if ('endDate' in keys) out.endDate = endOf(c.end)
  if (keys.automation) out.automation = Object.fromEntries(Object.keys(keys.automation).map((k) => [k, automationNow(c, k as AutomationKey)]))
  if ('urlExclusions' in keys) out.urlExclusions = sorted(urlExclusionsOf(c).map((u) => u.key))
  if ('brandExclusions' in keys) out.brandExclusions = sorted(brandExclusionsOf(c).map((b) => b.listId))
  if ('brandLinks' in keys) out.brandLinks = sorted(brandLinksOf(c).map((l) => linkKey(l.assetId, l.fieldType)))
  if (keys.textGuidelines) {
    const now: TextGuidelines = c.textGuidelines ?? { termExclusions: [], messagingRestrictions: [] }
    out.textGuidelines = {
      ...('termExclusions' in keys.textGuidelines ? { termExclusions: now.termExclusions } : {}),
      ...('messagingRestrictions' in keys.textGuidelines ? { messagingRestrictions: now.messagingRestrictions } : {}),
    }
  }
  if ('pageFeeds' in keys) out.pageFeeds = sorted((c.pageFeeds ?? []).map((f) => f.assetSetId))
  return out
}

/** The facts of a live asset group, for the keys of `keys`. */
export function groupFactsOf(g: PmaxAssetGroup, keys: PmaxGroupFacts): PmaxGroupFacts {
  const out: PmaxGroupFacts = { assetGroupId: g.assetGroupId, ...(keys.created ? { created: true as const } : {}) }
  if ('name' in keys) out.name = g.name
  if ('status' in keys) out.status = g.status
  if ('finalUrls' in keys) out.finalUrls = g.finalUrls
  if ('finalMobileUrls' in keys) out.finalMobileUrls = g.finalMobileUrls
  if ('path1' in keys) out.path1 = g.path1
  if ('path2' in keys) out.path2 = g.path2
  if ('links' in keys) out.links = sorted(ownLinks(g.assets).map((l) => linkKey(l.assetId, l.fieldType)))
  if ('tree' in keys) { const t = pmaxTreeOfLive(g.tree); out.tree = 'refusal' in t ? null : pmaxSnapshot(t.root) }
  if ('signals' in keys) out.signals = signalKeysOf(g)
  if ('trackingTemplate' in keys) out.trackingTemplate = g.trackingTemplate ?? null
  if ('finalUrlSuffix' in keys) out.finalUrlSuffix = g.finalUrlSuffix ?? null
  if ('customParameters' in keys) out.customParameters = sortedParams(g.customParameters ?? [])
  return out
}
const sortedParams = (list: CustomParameter[]) => [...list].map((p) => ({ key: p.key.trim(), value: p.value.trim() })).sort((a, b) => a.key.localeCompare(b.key))

/** The kinds in the order Google needs them: what is pointed at before what points at it; asset links together. */
export const PMAX_KIND_ORDER = [
  'campaignBudgetOperation', 'campaignOperation', 'campaignCriterionOperation', 'assetOperation', 'assetSetOperation', 'assetSetAssetOperation',
  'audienceOperation', 'campaignAssetOperation', 'campaignAssetSetOperation', 'assetGroupOperation', 'assetGroupAssetOperation',
  'assetGroupListingGroupFilterOperation', 'assetGroupSignalOperation',
] as const
/** Operations grouped by kind (stable: the order inside a kind is the order made). */
export function inKindOrder(ops: GoogleMutateOperation[]): GoogleMutateOperation[] {
  const rank = (op: GoogleMutateOperation) => { const r = PMAX_KIND_ORDER.indexOf(Object.keys(op)[0] as typeof PMAX_KIND_ORDER[number]); return r < 0 ? PMAX_KIND_ORDER.length : r }
  return ops.map((op, i) => ({ op, i })).sort((a, b) => rank(a.op) - rank(b.op) || a.i - b.i).map((x) => x.op)
}

const RESULT_OF: Record<string, string> = {
  assetOperation: 'assetResult', assetGroupOperation: 'assetGroupResult', audienceOperation: 'audienceResult',
  campaignOperation: 'campaignResult', campaignBudgetOperation: 'campaignBudgetResult', assetSetOperation: 'assetSetResult',
}
/** Temporary id → the id Google gave, from the operations sent and Google's results (in order). */
export function idsFromRun(operations: GoogleMutateOperation[], responses: GoogleMutateResponse[]): Map<string, string> {
  const out = new Map<string, string>()
  operations.forEach((op, i) => {
    const kind = Object.keys(op)[0]
    const created = (op[kind] as { create?: { resourceName?: string } } | undefined)?.create?.resourceName
    const result = RESULT_OF[kind] ? responses[i]?.[RESULT_OF[kind]]?.resourceName : undefined
    if (created && result) out.set(tmp(Number(tempOf(created))), tempOf(result))
  })
  return out
}
/** A record with every `tmp:<n>` Google answered for replaced by its id. */
export function withRealIds<T>(record: T, ids: Map<string, string>): T {
  return JSON.parse(JSON.stringify(record).replace(/tmp:-\d+/g, (t) => ids.get(t) ?? t)) as T
}

class Refusal extends Error {}

/** The change of a set-google-pmax request, from the live state: a draft, or a refusal in words. Pure. */
export function pmaxChangeDraft(customer: string, currency: string, request: PmaxChangeRequest, live: PmaxChangeLive): GoogleChangeDraft | { refusal: string } {
  try {
    return buildPmaxChange(customer, currency, request, live)
  } catch (err) {
    if (err instanceof Refusal) return { refusal: err.message }
    throw err
  }
}

function buildPmaxChange(customer: string, currency: string, request: PmaxChangeRequest, live: PmaxChangeLive): GoogleChangeDraft {
  const refuse = (why: string): never => { throw new Refusal(why) }
  const c = live.campaign
  if (!c) refuse(`Campaign ${request.campaignId} is not in this account (or it is removed).`)
  const camp = c!
  if (camp.type !== 'PERFORMANCE_MAX') refuse(`"${camp.name}" is a ${camp.type ?? 'campaign'} campaign: set-google-pmax changes Performance Max campaigns.`)
  if (camp.notRead.length) refuse(`Parts of "${camp.name}" could not be read (${camp.notRead.map((n) => n.part).join(', ')}): Nexus does not change what it cannot read.`)
  const enabled = camp.status === 'ENABLED'
  const paused = enabled ? '' : ' (the campaign is paused: nothing spends until it is enabled)'
  const campaignRes = `${customer}/campaigns/${camp.campaignId}`
  const retail = !!camp.retail
  let next = -1
  const temp = () => next--
  const ops: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const problems: string[] = []
  const maker = new AssetMaker(customer, temp)
  const ctx: AssetContext = { customer, maker, assets: new Map(live.assets.map((a) => [a.assetId, a])), images: live.images, problems, warnings, skipped }
  const groupPaused = ' (the asset group is paused: nothing spends until it is enabled)'
  /** A sentence that spends where it serves; else a warning that says why it does not yet (`why`, or what is paused). */
  const spendOrWarn = (sentence: string, serves = enabled, why?: string) => (serves ? spends : warnings).push(`${sentence}${serves ? '' : why ?? (enabled ? groupPaused : paused)}.`)
  const before: PmaxChangeRecord = { campaignId: camp.campaignId, campaign: {}, groups: [] }
  const after: PmaxChangeRecord = { campaignId: camp.campaignId, campaign: {}, groups: [] }

  // ── campaign settings ──
  const s = request.settings ?? {}
  const fields: Record<string, unknown> = {}
  const mask: string[] = []
  if (s.name !== undefined && s.name.trim() !== camp.name) {
    const name = s.name.trim()
    if (live.campaignNames.some((x) => x.campaignId !== camp.campaignId && x.name.trim().toLowerCase() === name.toLowerCase())) refuse(`Another campaign is named "${name}": Google refuses two campaigns with one name.`)
    fields.name = name; mask.push('name'); lines.push(['campaign name', camp.name, name])
    before.campaign.name = camp.name; after.campaign.name = name
  }
  if (s.bidding) {
    const now = pmaxBiddingNow(camp)
    if (!now) refuse(`"${camp.name}" bids with ${camp.biddingType ?? 'a strategy'} Nexus cannot name: change its bidding in Google Ads.`)
    if (s.bidding.strategy !== 'MAXIMIZE_CONVERSIONS' && s.bidding.strategy !== 'MAXIMIZE_CONVERSION_VALUE') refuse('Performance Max bids with MAXIMIZE_CONVERSIONS (optional target CPA) or MAXIMIZE_CONVERSION_VALUE (optional target ROAS) only (performance-max/create-campaign).')
    const want = cleanBidding(s.bidding)
    if (JSON.stringify(want) !== JSON.stringify(now)) {
      Object.assign(fields, biddingFields(customer, want)); mask.push(...biddingMask(want))
      lines.push(['bidding', biddingText(now!, currency), biddingText(want, currency)])
      const why = biddingSpends(now, want, currency)
      if (why) spendOrWarn(why)
      before.campaign.bidding = now; after.campaign.bidding = want
    }
  }
  for (const d of [s.startDate, s.endDate]) if (d !== undefined && d !== 'none' && !DAY.test(d)) refuse(`"${d}" is not a day (YYYY-MM-DD).`)
  if (s.startDate !== undefined && s.startDate !== dayOf(camp.start)) {
    fields.startDateTime = `${s.startDate} 00:00:00`; mask.push('start_date_time')
    lines.push(['start', dayOf(camp.start) ?? '(when enabled)', s.startDate])
    if (dayOf(camp.start) && s.startDate < dayOf(camp.start)!) spendOrWarn(`Starts earlier (${s.startDate} instead of ${dayOf(camp.start)})`)
    before.campaign.startDate = dayOf(camp.start); after.campaign.startDate = s.startDate
  }
  if (s.endDate !== undefined && s.endDate !== endOf(camp.end)) {
    if (s.endDate !== 'none') fields.endDateTime = `${s.endDate} 23:59:59`
    mask.push('end_date_time')
    lines.push(['end', endOf(camp.end) === 'none' ? 'no end' : endOf(camp.end), s.endDate === 'none' ? 'no end' : s.endDate])
    if (s.endDate === 'none' || (endOf(camp.end) !== 'none' && s.endDate > endOf(camp.end))) spendOrWarn(`Runs longer (end ${s.endDate === 'none' ? 'removed' : `moved to ${s.endDate}`})`)
    before.campaign.endDate = endOf(camp.end); after.campaign.endDate = s.endDate
  }

  // ── Google's automation ──
  const autoAsk = request.automation ?? {}
  const changedAuto = AUTOMATION_KEYS.filter((k) => autoAsk[k] !== undefined && (autoAsk[k] ? 'OPTED_IN' : 'OPTED_OUT') !== automationNow(camp, k))
  if (changedAuto.length) {
    if (camp.automation.AUTOMATED_VIDEO_CRAWL === 'OPTED_IN') refuse(`"${camp.name}" lets Google crawl videos (AUTOMATED_VIDEO_CRAWL) with settings Nexus does not read: change Google's automation of this campaign in Google Ads.`)
    const final: Record<AutomationKey, 'OPTED_IN' | 'OPTED_OUT'> = Object.fromEntries(AUTOMATION_KEYS.map((k) => [k, autoAsk[k] === undefined ? automationNow(camp, k) : autoAsk[k] ? 'OPTED_IN' : 'OPTED_OUT'])) as Record<AutomationKey, 'OPTED_IN' | 'OPTED_OUT'>
    if (final.finalUrlExpansion === 'OPTED_IN' && final.textCustomization === 'OPTED_OUT') {
      refuse('Google keeps text customization on while final URL expansion is on ("There is no way to opt out of text asset automation and still use final URL expansion"): turn both off, or keep text customization on.')
    }
    // The whole list is written (update mask asset_automation_settings): the switches asked, and every type Google
    // answered with its status — never a type Google left out (it stays at Google's default, so a switch nobody asked
    // for is never written, let alone turned on). GENERATE_IMAGE_EXTRACTION follows the account ("can only be
    // configured in the Google Ads web interface", docs/assets/asset-automation-settings): never written.
    const written = AUTOMATION_KEYS.filter((k) => autoAsk[k] !== undefined || camp.automation[AUTOMATION_TYPES[k]] !== undefined)
    const others = Object.entries(camp.automation).filter(([t]) => !Object.values(AUTOMATION_TYPES).includes(t as never) && t !== 'GENERATE_IMAGE_EXTRACTION')
    fields.assetAutomationSettings = [
      ...written.map((k) => ({ assetAutomationType: AUTOMATION_TYPES[k], assetAutomationStatus: autoAsk[k] !== undefined ? final[k] : camp.automation[AUTOMATION_TYPES[k]] })),
      ...others.map(([t, st]) => ({ assetAutomationType: t, assetAutomationStatus: st })),
    ]
    mask.push('asset_automation_settings')
    before.campaign.automation = {}
    after.campaign.automation = {}
    for (const k of changedAuto) {
      before.campaign.automation[k] = automationNow(camp, k)
      after.campaign.automation[k] = final[k]
      lines.push([AUTOMATION_WORD[k], before.campaign.automation[k] === 'OPTED_IN' ? 'on' : 'off', final[k] === 'OPTED_IN' ? 'on' : 'off'])
    }
    if (changedAuto.includes('finalUrlExpansion') && final.finalUrlExpansion === 'OPTED_IN') spendOrWarn('Turns on final URL expansion: Google may send people to other pages of the site and match more searches')
    if (changedAuto.includes('textCustomization') && final.textCustomization === 'OPTED_IN') warnings.push('Text customization on: Google writes headlines and descriptions from the site and the assets on its own.')
  }
  // ── text guidelines (what Google's generated text never says) ──
  if (request.textGuidelines) {
    const asked = textGuidelinesOfAsk(request.textGuidelines, 'text guidelines', problems)
    const now: TextGuidelines = camp.textGuidelines ?? { termExclusions: [], messagingRestrictions: [] }
    const write: TextGuidelinesAsk = {}
    for (const [key, path, word] of [['termExclusions', 'text_guidelines.term_exclusions', 'term exclusions'], ['messagingRestrictions', 'text_guidelines.messaging_restrictions', 'messaging restrictions']] as const) {
      const want = asked[key]
      // The order of a list means nothing to Google: the same items in another order are no change.
      if (!want || JSON.stringify([...want].sort()) === JSON.stringify([...now[key]].sort())) continue
      write[key] = want
      mask.push(path)
      lines.push([`text guidelines: ${word}`, listText(now[key]), listText(want)])
      const gone = now[key].filter((t) => !want.some((w) => w.toLowerCase() === t.toLowerCase()))
      if (gone.length) spendOrWarn(`Takes away the ${word.replace(/s$/, '')}${gone.length > 1 ? 's' : ''} ${listText(gone)}: Google's generated text may say what it did not`)
    }
    if (Object.keys(write).length) {
      fields.textGuidelines = textGuidelinesBody(write)
      before.campaign.textGuidelines = Object.fromEntries(Object.keys(write).map((k) => [k, now[k as keyof TextGuidelines]]))
      after.campaign.textGuidelines = write
      const auto = (k: AutomationKey) => (autoAsk[k] === undefined ? automationNow(camp, k) : autoAsk[k] ? 'OPTED_IN' : 'OPTED_OUT')
      if (auto('textCustomization') === 'OPTED_OUT' && auto('finalUrlExpansion') === 'OPTED_OUT') warnings.push('Text guidelines guide the text Google writes: with text customization and final URL expansion off, Google writes none here.')
    } else skipped.push('text guidelines: already so')
  }
  // ── page feeds (URL inclusions) ──
  const textAfter = autoAsk.textCustomization === undefined ? automationNow(camp, 'textCustomization') : autoAsk.textCustomization ? 'OPTED_IN' : 'OPTED_OUT'
  const unlinkOps: GoogleMutateOperation[] = []
  if (request.pageFeeds) {
    const has = sorted((camp.pageFeeds ?? []).map((f) => f.assetSetId))
    const final = new Set(has)
    const nameOf = (id: string) => (live.pageFeeds ?? camp.pageFeeds ?? []).find((f) => f.assetSetId === id)?.name ?? id
    for (const id of sorted(request.pageFeeds.unlink ?? [])) {
      if (!final.has(id)) { skipped.push(`page feed ${id} is not linked`); continue }
      unlinkOps.push({ campaignAssetSetOperation: { remove: `${customer}/campaignAssetSets/${camp.campaignId}~${id}` } })
      final.delete(id)
      lines.push([`page feed "${nameOf(id)}"`, 'linked', '(none)'])
    }
    for (const id of sorted(request.pageFeeds.link ?? [])) {
      if (final.has(id)) { skipped.push(`page feed "${nameOf(id)}" is already linked`); continue }
      if (!(live.pageFeeds ?? []).some((f) => f.assetSetId === id)) { problems.push(`page feed ${id} is not a page feed of this account (set-google-page-feed makes one)`); continue }
      ops.push({ campaignAssetSetOperation: { create: { campaign: campaignRes, assetSet: `${customer}/assetSets/${id}` } } })
      final.add(id)
      lines.push([`page feed "${nameOf(id)}"`, '(none)', 'linked'])
      spendOrWarn(`Links the page feed "${nameOf(id)}": Google may send people to its pages and write ads from them`)
    }
    if (final.size !== has.length || has.some((k) => !final.has(k))) { before.campaign.pageFeeds = has; after.campaign.pageFeeds = sorted(final) }
  }
  const feedsAfter = request.pageFeeds ? (after.campaign.pageFeeds ?? sorted((camp.pageFeeds ?? []).map((f) => f.assetSetId))) : (camp.pageFeeds ?? []).map((f) => f.assetSetId)
  if (feedsAfter.length && textAfter === 'OPTED_OUT') {
    problems.push(`Google keeps text customization on while a page feed is linked (performance-max/assets: OPERATION_NOT_PERMITTED_FOR_CONTEXT): ${request.pageFeeds?.link?.length ? 'turn text customization on (automation.textCustomization: true) to link one' : 'unlink its page feeds (pageFeeds.unlink) to turn text customization off'}`)
  }

  if (mask.length) ops.push({ campaignOperation: { update: { resourceName: campaignRes, ...fields }, updateMask: mask.join(',') } })

  // ── URL exclusions (negative WEBPAGE criteria) ──
  const urlExpansionAfter = autoAsk.finalUrlExpansion === undefined ? automationNow(camp, 'finalUrlExpansion') === 'OPTED_IN' : autoAsk.finalUrlExpansion
  if (request.urlExclusions) {
    const liveUrls = urlExclusionsOf(camp)
    const has = new Map(liveUrls.map((u) => [u.key, u.criterionId]))
    const add = (request.urlExclusions.add ?? []).map(urlExclusionKey)
    const remove = (request.urlExclusions.remove ?? []).map(urlExclusionKey)
    const final = new Set(has.keys())
    for (const key of sorted(add)) {
      const u = urlExclusionOfKey(key)
      const arg = (u.contains ?? u.equals ?? '').trim()
      if (!arg || arg.length > 2048) { problems.push(`URL exclusion "${arg.slice(0, 60)}": give the part of the address (1 to 2048 characters)`); continue }
      if (has.has(key)) { skipped.push(`URL exclusion ${key} is already there`); continue }
      ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, negative: true, webpage: { criterionName: `Exclude ${key}`.slice(0, 255), conditions: [{ operand: 'URL', operator: u.equals !== undefined ? 'EQUALS' : 'CONTAINS', argument: arg }] } } } })
      final.add(key)
      lines.push([`URL exclusion ${key}`, '(none)', 'excluded from final URL expansion'])
    }
    for (const key of sorted(remove)) {
      const id = has.get(key)
      if (!id) { skipped.push(`URL exclusion ${key} is not there`); continue }
      ops.push({ campaignCriterionOperation: { remove: `${customer}/campaignCriteria/${camp.campaignId}~${id}` } })
      final.delete(key)
      lines.push([`URL exclusion ${key}`, 'excluded', '(none)'])
      spendOrWarn(`Takes the URL exclusion ${key} off: final URL expansion may send people to those pages again`, enabled && urlExpansionAfter,
        enabled ? ' (final URL expansion is off: Google sends people only to the final URLs)' : paused)
    }
    if (final.size !== has.size || [...final].some((k) => !has.has(k))) {
      before.campaign.urlExclusions = sorted(has.keys()); after.campaign.urlExclusions = sorted(final)
    }
  }

  // ── brand exclusions (brand lists) ──
  if (request.brandExclusions) {
    const now = brandExclusionsOf(camp)
    const has = new Map(now.map((b) => [b.listId, b.criterionId]))
    const final = new Set(has.keys())
    for (const id of sorted(request.brandExclusions.add ?? [])) {
      const list = live.brandLists.find((l) => l.listId === id)
      if (!list) { problems.push(`brand list ${id} is not a brand list of this account (set-google-exclusion-list makes one)`); continue }
      if (has.has(id)) { skipped.push(`brand list "${list.name ?? id}" is already excluded`); continue }
      ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, negative: true, brandList: { sharedSet: `${customer}/sharedSets/${id}` } } } })
      final.add(id)
      lines.push([`brand exclusion "${list.name ?? id}"`, '(none)', 'its brands excluded'])
    }
    for (const id of sorted(request.brandExclusions.remove ?? [])) {
      const crit = has.get(id)
      if (!crit) { skipped.push(`brand list ${id} is not excluded here`); continue }
      ops.push({ campaignCriterionOperation: { remove: `${customer}/campaignCriteria/${camp.campaignId}~${crit}` } })
      final.delete(id)
      const name = live.brandLists.find((l) => l.listId === id)?.name ?? id
      lines.push([`brand exclusion "${name}"`, 'its brands excluded', '(none)'])
      spendOrWarn(`Takes the brand exclusion "${name}" off: ads can show for those brands' searches again`)
    }
    if (final.size !== has.size || [...final].some((k) => !has.has(k))) {
      before.campaign.brandExclusions = sorted(has.keys()); after.campaign.brandExclusions = sorted(final)
    }
  }

  // ── the brand's assets on the campaign ──
  const anyGroupAssets = camp.assetGroups.some((g) => ownLinks(g.assets).length > 0)
  let finalBrand: Array<{ fieldType: string }> = brandLinksOf(camp)
  let anyGroupAssetsAfter = anyGroupAssets
  if (request.brandAssets) {
    if (!camp.brandGuidelines) refuse(`"${camp.name}" has brand guidelines off: its business name and logos are linked in each asset group (assetGroups[].addAssets), not on the campaign.`)
    const nowLinks = brandLinksOf(camp)
    const planned = planAssets(ctx, 'brand assets', request.brandAssets.add, 'brand', nowLinks, (f) => (BRAND_FIELDS.includes(f) ? null : `${WORD[f]} goes in an asset group, not on the campaign (brand assets are the business name, logos and landscape logos)`))
    const removals = (request.brandAssets.remove ?? []).filter((r) => {
      const there = nowLinks.some((l) => l.assetId === r.assetId && l.fieldType === r.fieldType)
      if (!there) skipped.push(`brand assets: asset ${r.assetId} is not linked as ${WORD[r.fieldType] ?? r.fieldType}`)
      return there
    })
    for (const r of removals) {
      ops.push({ campaignAssetOperation: { remove: `${customer}/campaignAssets/${camp.campaignId}~${r.assetId}~${r.fieldType}` } })
      lines.push([`brand ${WORD[r.fieldType]} ${r.assetId}`, 'linked', '(none)'])
    }
    for (const p of planned) {
      ops.push({ campaignAssetOperation: { create: { campaign: campaignRes, asset: p.assetRes, fieldType: p.fieldType } } })
      lines.push([`brand ${WORD[p.fieldType]}`, '(none)', p.label])
    }
    const nowKeys = nowLinks.map((l) => linkKey(l.assetId, l.fieldType))
    const finalKeys = [...nowKeys.filter((k) => !removals.some((r) => linkKey(r.assetId, r.fieldType) === k)), ...planned.map((p) => linkKey(idForRecord(p.assetRes), p.fieldType))]
    finalBrand = finalKeys.map((k) => ({ fieldType: k.slice(k.lastIndexOf('~') + 1) }))
    if (removals.length || planned.length) { before.campaign.brandLinks = sorted(nowKeys); after.campaign.brandLinks = sorted(finalKeys) }
  }

  // ── asset groups ──
  const audienceCtx = { customer, temp, problems, skipped, audiences: live.audiences, takenAudienceNames: new Set(live.audiences.map((a) => (a.name ?? '').trim().toLowerCase())) }
  const groupNames = new Map(camp.assetGroups.map((g) => [g.name.trim().toLowerCase(), g.assetGroupId]))
  const touched = new Set<string>()
  let newGroups = 0
  for (const [gi, g] of (request.assetGroups ?? []).entries()) {
    const liveGroup = g.assetGroupId ? camp.assetGroups.find((x) => x.assetGroupId === g.assetGroupId) : undefined
    if (g.assetGroupId && !liveGroup) refuse(`Asset group ${g.assetGroupId} is not in "${camp.name}" (or it is removed).`)
    if (liveGroup && touched.has(liveGroup.assetGroupId)) refuse(`Asset group ${liveGroup.assetGroupId} is named twice: one entry per asset group.`)
    if (liveGroup) touched.add(liveGroup.assetGroupId)
    const isNew = !liveGroup
    if (isNew) {
      newGroups += 1
      if (!g.name || !g.finalUrls?.length) refuse(`assetGroups[${gi}]: a new asset group needs a name and finalUrls (or give assetGroupId of an existing one).`)
      if (g.removeAssets?.length || g.removeSignals || g.clearProductGroups) refuse(`assetGroups[${gi}]: a new asset group has nothing to remove.`)
    }
    const where = isNew ? `new asset group "${g.name!.trim()}"` : `asset group "${liveGroup!.name}"`
    const groupRes = isNew ? `${customer}/assetGroups/${temp()}` : `${customer}/assetGroups/${liveGroup!.assetGroupId}`
    const groupId = isNew ? idForRecord(groupRes) : liveGroup!.assetGroupId
    const gb: PmaxGroupFacts = { assetGroupId: groupId, ...(isNew ? { created: true as const } : {}) }
    const ga: PmaxGroupFacts = { assetGroupId: groupId, ...(isNew ? { created: true as const } : {}) }

    // Its own fields.
    const own: Record<string, unknown> = {}
    const ownMask: string[] = []
    const set = <K extends 'name' | 'status' | 'finalUrls' | 'finalMobileUrls' | 'path1' | 'path2'>(key: K, path: string, from: PmaxGroupFacts[K], to: PmaxGroupFacts[K], label: string, shown: (v: PmaxGroupFacts[K]) => unknown) => {
      if (!isNew && JSON.stringify(from ?? null) === JSON.stringify(to ?? null)) return
      if (to !== null && to !== undefined && !(Array.isArray(to) && !to.length)) own[key] = to
      ownMask.push(path)
      gb[key] = from; ga[key] = to
      if (!isNew) lines.push([`${where} ${label}`, shown(from), shown(to)])
    }
    if (g.name !== undefined) {
      const name = g.name.trim()
      if (!name || name.length > 128) problems.push(`${where}: the name is 1 to 128 characters`)
      const taken = groupNames.get(name.toLowerCase())
      if (taken !== undefined && taken !== liveGroup?.assetGroupId) problems.push(`${where}: another asset group of "${camp.name}" is named "${name}" (Google keeps asset group names unique in a campaign)`)
      groupNames.set(name.toLowerCase(), liveGroup?.assetGroupId ?? groupId)
      set('name', 'name', liveGroup?.name, name, 'name', (v) => v)
    }
    if (g.finalUrls !== undefined) {
      g.finalUrls.forEach((u, i) => { const p = httpsUrlProblem(`${where}, final URL ${i + 1}`, u); if (p) problems.push(p) })
      if (!g.finalUrls.length) problems.push(`${where}: an asset group needs at least one final URL`)
      set('finalUrls', 'final_urls', liveGroup?.finalUrls, g.finalUrls.map((u) => u.trim()), 'final URLs', (v) => (v as string[] | undefined)?.join(' ') || '(none)')
    }
    if (g.finalMobileUrls !== undefined) {
      g.finalMobileUrls.forEach((u, i) => { const p = httpsUrlProblem(`${where}, mobile final URL ${i + 1}`, u); if (p) problems.push(p) })
      set('finalMobileUrls', 'final_mobile_urls', liveGroup?.finalMobileUrls, g.finalMobileUrls.map((u) => u.trim()), 'mobile final URLs', (v) => (v as string[] | undefined)?.join(' ') || '(none)')
    }
    const path1 = g.path1 !== undefined ? (g.path1.trim() || null) : undefined
    const path2 = g.path2 !== undefined ? (g.path2.trim() || null) : path1 === null ? null : undefined
    for (const [k, v] of [['path 1', path1], ['path 2', path2]] as const) if (v) { const p = widthProblem(`${where}, ${k}`, v, 15); if (p) problems.push(p) }
    if ((path2 === undefined ? liveGroup?.path2 : path2) && !(path1 === undefined ? liveGroup?.path1 : path1)) problems.push(`${where}: path 2 needs path 1 (Google's rule)`)
    if (path1 !== undefined) set('path1', 'path1', liveGroup?.path1 ?? null, path1, 'path 1', (v) => v ?? '(none)')
    if (path2 !== undefined) set('path2', 'path2', liveGroup?.path2 ?? null, path2, 'path 2', (v) => v ?? '(none)')
    // Its own tracking (G3's rules): '' / [] / null takes it away (the campaign's then applies).
    if (g.trackingTemplate !== undefined || g.finalUrlSuffix !== undefined || g.customParameters !== undefined) {
      problems.push(...urlItemProblems({ level: 'ad-group', id: groupId, trackingTemplate: g.trackingTemplate, finalUrlSuffix: g.finalUrlSuffix, customParameters: g.customParameters }, where))
      const track = [
        ['trackingTemplate', 'tracking_url_template', 'trackingUrlTemplate', 'tracking template', g.trackingTemplate === undefined ? undefined : (g.trackingTemplate ?? '').trim() || null, liveGroup?.trackingTemplate ?? null],
        ['finalUrlSuffix', 'final_url_suffix', 'finalUrlSuffix', 'final URL suffix', g.finalUrlSuffix === undefined ? undefined : (g.finalUrlSuffix ?? '').trim() || null, liveGroup?.finalUrlSuffix ?? null],
        ['customParameters', 'url_custom_parameters', 'urlCustomParameters', 'custom parameters', g.customParameters === undefined ? undefined : sortedParams(g.customParameters ?? []), sortedParams(liveGroup?.customParameters ?? [])],
      ] as const
      for (const [key, path, body, label, to, from] of track) {
        if (to === undefined || (!isNew && JSON.stringify(to) === JSON.stringify(from))) continue
        if (to !== null && !(Array.isArray(to) && !to.length)) own[body] = to
        if (!isNew || own[body] !== undefined) ownMask.push(path)
        ;(gb as unknown as Record<string, unknown>)[key] = from
        ;(ga as unknown as Record<string, unknown>)[key] = to
        const shown = (v: unknown) => (Array.isArray(v) ? (v.length ? v.map((p: CustomParameter) => `{_${p.key}}=${p.value}`).join(', ') : '(none)') : (v as string | null) ?? '(none: the campaign\'s applies)')
        if (!isNew) lines.push([`${where} ${label}`, shown(from), shown(to)])
      }
    }
    let status: 'ENABLED' | 'PAUSED' = (liveGroup?.status as 'ENABLED' | 'PAUSED' | null) ?? 'ENABLED'
    if (isNew) {
      status = g.status ?? (enabled && !g.enable ? 'PAUSED' : 'ENABLED')
      if (enabled && g.status === 'ENABLED' && !g.enable) status = 'PAUSED'
      if (status === 'ENABLED' && enabled) spends.push(`Makes ${where} ENABLED in an enabled campaign: it can serve at once.`)
      if (enabled && status === 'PAUSED' && g.status !== 'PAUSED') warnings.push(`${where} is made PAUSED (the campaign is enabled): enable it with set-google-pmax status ENABLED (SPENDS MONEY), or ask with enable: true.`)
      own.status = status; ownMask.push('status'); ga.status = status
    } else if (g.status !== undefined && g.status !== liveGroup!.status) {
      set('status', 'status', liveGroup!.status, g.status, 'status', (v) => v)
      if (g.status === 'ENABLED') spendOrWarn(`Enables ${where}`)
      status = g.status
    }
    if (isNew) {
      ops.push({ assetGroupOperation: { create: { resourceName: groupRes, campaign: campaignRes, ...own } } })
      lines.push([where, '(none)', `${status}, ${(g.finalUrls ?? []).join(' ')}`])
    } else if (ownMask.length) {
      ops.push({ assetGroupOperation: { update: { resourceName: groupRes, ...own }, updateMask: ownMask.join(',') } })
    }
    const serves = enabled && status === 'ENABLED'

    // Its assets.
    const existing = liveGroup?.assets ?? []
    const brandInGroup = !camp.brandGuidelines
    const planned = planAssets(ctx, where, g.addAssets, `g${gi}`, existing, (f) => (BRAND_FIELDS.includes(f) && !brandInGroup
      ? `${WORD[f]} is linked to the campaign with brand guidelines on (brandAssets), not to an asset group`
      : null))
    const removals = (g.removeAssets ?? []).filter((r) => {
      const there = ownLinks(existing).some((l) => l.assetId === r.assetId && l.fieldType === r.fieldType)
      if (!there) skipped.push(`${where}: asset ${r.assetId} is not linked as ${WORD[r.fieldType] ?? r.fieldType}`)
      return there
    })
    for (const r of removals) {
      ops.push({ assetGroupAssetOperation: { remove: `${customer}/assetGroupAssets/${groupId}~${r.assetId}~${r.fieldType}` } })
      const l = existing.find((x) => x.assetId === r.assetId && x.fieldType === r.fieldType)
      lines.push([`${where} ${WORD[r.fieldType]}`, l?.text ?? l?.name ?? r.assetId, '(removed)'])
    }
    for (const p of planned) {
      ops.push({ assetGroupAssetOperation: { create: { assetGroup: groupRes, asset: p.assetRes, fieldType: p.fieldType } } })
      lines.push([`${where} ${WORD[p.fieldType]}`, '(none)', p.label])
    }
    const keep = ownLinks(existing).filter((l) => !removals.some((r) => r.assetId === l.assetId && r.fieldType === l.fieldType))
    const finalLinks = [...keep.map((l) => ({ fieldType: l.fieldType, text: l.text })), ...planned.map((p) => ({ fieldType: p.fieldType, text: p.label }))]
    if (planned.length || removals.length || isNew) {
      const descBefore = ownLinks(existing).filter((l) => l.fieldType === 'DESCRIPTION').map((l) => l.text ?? '')
      const descAfter = finalLinks.filter((l) => l.fieldType === 'DESCRIPTION').map((l) => l.text ?? '')
      problems.push(...groupCountProblems(where, { before: isNew ? null : countsOf(ownLinks(existing)), after: countsOf(finalLinks), retail, brandInGroup, shortBefore: isShort(descBefore), shortAfter: isShort(descAfter) }))
    }
    if (finalLinks.length) anyGroupAssetsAfter = true
    if (planned.length || removals.length) {
      gb.links = isNew ? undefined : sorted(ownLinks(existing).map((l) => linkKey(l.assetId, l.fieldType)))
      ga.links = sorted([...keep.map((l) => linkKey(l.assetId, l.fieldType)), ...planned.map((p) => linkKey(idForRecord(p.assetRes), p.fieldType))])
      if (planned.length && !isNew) warnings.push(`${where}: ${plural(planned.length, 'asset')} added — Google mixes them into the ads it shows.`)
    }

    // Its product tree.
    if (g.productGroups !== undefined || g.clearProductGroups || (isNew && retail)) {
      if (!retail && (g.productGroups?.length || g.clearProductGroups)) refuse(`${where}: "${camp.name}" has no Merchant Center feed: a product group tree is for a retail Performance Max campaign.`)
      if (g.productGroups && g.clearProductGroups) refuse(`${where}: give productGroups or clearProductGroups, not both.`)
      const liveTree = isNew ? { root: null } : pmaxTreeOfLive(liveGroup!.tree)
      if ('refusal' in liveTree) refuse(`${where}: ${liveTree.refusal}.`)
      const desired = g.clearProductGroups ? { root: null } : g.productGroups?.length ? pmaxTreeOfSpec(g.productGroups, `${where} productGroups`) : { root: { dim: null, value: null, kind: 'UNIT' as const, split: null, excluded: false, bidCents: null, children: [] } as TNode }
      if ('refusal' in desired) refuse(desired.refusal)
      const liveRoot = (liveTree as { root: TNode | null }).root
      const wantRoot = (desired as { root: TNode | null }).root
      const liveSnap = pmaxSnapshot(liveRoot)
      const tree = pmaxTreeOps(customer, groupRes, liveRoot, wantRoot, temp)
      const nowSnap = pmaxSnapshot(wantRoot)
      if (tree.removes.length || tree.creates.length) {
        ops.push(...tree.removes, ...tree.creates)
        if (!isNew) {
          gb.tree = liveSnap; ga.tree = nowSnap
          lines.push([`${where} product groups`, describePmaxTree(liveRoot), describePmaxTree(wantRoot)])
        }
        const widens = pmaxTreeWidens(liveRoot, wantRoot)
        if (widens.length && !isNew) spendOrWarn(`Advertises more products in ${where}: ${widens.slice(0, 5).join('; ')}${widens.length > 5 ? ` … (+${widens.length - 5})` : ''}`, serves)
        if (g.clearProductGroups) warnings.push(`${where}: with no product tree it shows no products.`)
      } else if (!isNew) skipped.push(`${where}: the product tree is already so`)
      if (isNew) ga.tree = nowSnap
    }

    // Its signals.
    const nowSignals = liveGroup ? signalKeysOf(liveGroup) : []
    const addSignals = planSignals(audienceCtx, where, groupRes, isNew ? null : groupId, g.addSignals, nowSignals)
    const removeSignals: string[] = []
    if (g.removeSignals && liveGroup) {
      const wanted = [...(g.removeSignals.audiences ?? []).map(signalKeyOfAudience), ...(g.removeSignals.searchThemes ?? []).map(signalKeyOfTheme)]
      const done = new Set<string>()
      for (const key of sorted(wanted)) {
        const sig = liveGroup.signals.find((x) => sameSignal(x.audienceId ? signalKeyOfAudience(x.audienceId) : x.searchTheme ? signalKeyOfTheme(x.searchTheme) : '') === sameSignal(key))
        if (!sig) { skipped.push(`${where}: ${key.startsWith('a:') ? `audience ${key.slice(2)}` : `search theme "${themeText(key)}"`} is not a signal`); continue }
        if (done.has(sig.signalId)) continue
        done.add(sig.signalId)
        ops.push({ assetGroupSignalOperation: { remove: `${customer}/assetGroupSignals/${sig.signalId}` } })
        // The record keeps the signal as Google holds it (a theme's own text), so undo adds back exactly that.
        removeSignals.push(sig.audienceId ? signalKeyOfAudience(sig.audienceId) : signalKeyOfTheme(sig.searchTheme ?? ''))
        lines.push([`${where} signal`, key.startsWith('a:') ? `audience ${key.slice(2)}` : `search theme "${sig.searchTheme}"`, '(removed)'])
      }
    }
    ops.push(...addSignals.audienceOps, ...addSignals.ops)
    addSignals.lines.forEach((l) => lines.push([`${where} signal`, '(none)', l]))
    if (addSignals.added.length) spendOrWarn(`Adds ${plural(addSignals.added.length, 'signal')} to ${where} (${addSignals.lines.slice(0, 5).join(', ')}): Google looks for more people like them`, serves)
    if (addSignals.added.length || removeSignals.length) {
      if (!isNew) gb.signals = nowSignals
      ga.signals = sorted([...nowSignals.filter((k) => !removeSignals.includes(k)), ...addSignals.added])
    }
    if (Object.keys(ga).length > (isNew ? 2 : 1)) { before.groups.push(gb); after.groups.push(ga) }
  }
  // Brand guidelines: the campaign holds the brand's assets whenever an asset group can serve assets (a retail campaign
  // whose asset groups hold none is exempt) — checked when the change touches them, or makes the first asset group assets.
  if (camp.brandGuidelines && (!retail || anyGroupAssetsAfter) && (request.brandAssets || newGroups || (retail && !anyGroupAssets && anyGroupAssetsAfter))) {
    const firstAssets = retail && !anyGroupAssets && anyGroupAssetsAfter
    problems.push(...brandCountProblems('the brand assets of the campaign (brand guidelines)', countsOf(finalBrand), firstAssets || !request.brandAssets ? null : countsOf(brandLinksOf(camp))))
  }
  if (camp.assetGroups.length + newGroups > MAX_ASSET_GROUPS) problems.push(`"${camp.name}" would have ${camp.assetGroups.length + newGroups} asset groups (Google allows ${MAX_ASSET_GROUPS})`)
  if (maker.bytes > MAX_IMAGE_BYTES_TOTAL) problems.push(`the images are ${(maker.bytes / 1024 / 1024).toFixed(1)} MB together: one request carries at most ${MAX_IMAGE_BYTES_TOTAL / 1024 / 1024} MB of images (ask in two)`)

  if (problems.length) refuse(`Not sent (${plural(problems.length, 'problem')}): ${problems.slice(0, 20).join(' · ')}${problems.length > 20 ? ` · … ${problems.length - 20} more` : ''}`)
  // A page feed unlinked goes first: Google refuses text customization turned off while one is linked.
  const all = [...unlinkOps, ...inKindOrder([...maker.ops, ...ops])]
  if (!all.length) refuse(`Nothing to change in "${camp.name}"${skipped.length ? `: ${skipped.slice(0, 8).join('; ')}` : ''}.`)
  const { changes, more } = changeLines(lines)
  return {
    summary: `Google Ads Performance Max "${camp.name}": ${plural(lines.length, 'change')}${maker.made.length ? `, ${plural(maker.made.length, 'new asset')}` : ''} — in one request.`,
    changes,
    totals: { operations: all.length, newAssets: maker.made.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    operations: all,
    stands: {
      // The change rests on the campaign's state, every touched part of it.
      campaign: {
        status: camp.status, brandGuidelines: camp.brandGuidelines, retail,
        campaign: campaignFactsOf(camp, {
          name: '', bidding: null, startDate: null, endDate: '', automation: Object.fromEntries(AUTOMATION_KEYS.map((k) => [k, 'OPTED_IN'])), urlExclusions: [], brandExclusions: [], brandLinks: [],
          textGuidelines: { termExclusions: [], messagingRestrictions: [] }, pageFeeds: [],
        }),
      },
      groups: camp.assetGroups.filter((g) => touched.has(g.assetGroupId)).map((g) => groupFactsOf(g, {
        assetGroupId: '', name: '', status: '', finalUrls: [], finalMobileUrls: [], path1: null, path2: null, links: [], tree: null, signals: [], trackingTemplate: null, finalUrlSuffix: null, customParameters: [],
      })),
      ...(request.pageFeeds?.link?.length ? { pageFeedsKnown: (live.pageFeeds ?? []).map((f) => f.assetSetId).sort() } : {}),
      groupNames: [...camp.assetGroups.map((g) => g.name.trim().toLowerCase())].sort(),
      assets: live.assets.map((a) => `${a.assetId}:${a.type}`).sort(),
    },
    before,
    after,
  }
}

/** The record of a change after it ran: every temporary id Google answered for is its id now. */
export function pmaxRecordAfterRun<T>(record: T, operations: GoogleMutateOperation[], responses: GoogleMutateResponse[]): T {
  return withRealIds(record, idsFromRun(operations, responses))
}

/**
 * Google Ads changes (2026-10-15, programme 2 group G6 "every asset type, at every level") — two builders, request +
 * live state → ONE atomic request (pure, no call):
 *
 *   newAssetsDraft   make assets of any type Nexus makes — image (an ad image, a business logo, a logo, a landscape
 *                    logo, or a marketing image for Performance Max / display), business name, call, price, promotion,
 *                    lead form, mobile app, and sitelink / callout / structured snippet — and link each at the places
 *                    asked: the account (CustomerAsset), campaigns (CampaignAsset), ad groups (AdGroupAsset). New assets
 *                    carry temporary ids (-1, -2 …) and their links point at them.
 *   assetLinksDraft  existing assets: link at a place (with a status), pause or enable a link, unlink (the asset stays in
 *                    the account: Google never removes an asset).
 *
 * Money. An asset raises no bid and no budget. A CALL or LEAD_FORM link can bring NEW paid interactions (a call from the
 * ad, a lead form opened — each charged like a click): an ENABLED one where it serves (an enabled campaign; an enabled ad
 * group of an enabled campaign; the account while any campaign is enabled) is SPENDS MONEY. So a new or re-linked call /
 * lead form link is made PAUSED where it would serve unless the request says enable (new) or status ENABLED (existing).
 * Other assets make an ad bigger: a warning. Pausing or removing nothing but a link is safe.
 *
 * Checked 2026-10-15 in Google's v25 reference and guides (curl of developers.google.com/google-ads/api/…):
 *   reference/rpc/v25/MutateOperation   ad_group_asset_operation, customer_asset_operation, campaign_asset_operation,
 *                     asset_operation are GoogleAdsService.Mutate operations; asset_set_operation, asset_set_asset_operation
 *                     and campaign_asset_set_operation are too, but customer / ad group ASSET SET links are not (they are
 *                     CustomerAssetSetService / AdGroupAssetSetService).
 *   AdGroupAssetOperation / CustomerAssetOperation  create, update (+ update_mask), remove (resource name).
 *   AdGroupAsset      ad_group, asset, field_type: Required, Immutable; status (AssetLinkStatus ENABLED / PAUSED /
 *                     REMOVED) mutable; customers/{c}/adGroupAssets/{ad_group_id}~{asset_id}~{field_type}.
 *   CustomerAsset     asset, field_type: Required, Immutable; status mutable; customers/{c}/customerAssets/{asset_id}~{field_type}.
 *   MutateOperationResponse  asset_result, campaign_asset_result, ad_group_asset_result, customer_asset_result.
 *   docs/assets/overview "Asset types linked to customers, campaigns, and ad groups": SITELINK, CALLOUT,
 *                     STRUCTURED_SNIPPET, CALL, PRICE, PROMOTION, MOBILE_APP → AdGroupAsset, CampaignAsset, CustomerAsset;
 *                     LEAD_FORM → CampaignAsset only; BUSINESS_NAME (text) and BUSINESS_LOGO (image) → CampaignAsset,
 *                     CustomerAsset; AD_IMAGE (image) → AdGroupAsset, CampaignAsset. LOCATION → a LOCATION_SYNC asset set
 *                     linked by CustomerAssetSet (below). "Mutable types like sitelink can't be linked to assets created
 *                     by text customization."
 *   performance-max/asset-requirements  MARKETING_IMAGE 1.91:1 min 600×314; SQUARE_MARKETING_IMAGE 1:1 min 300×300;
 *                     PORTRAIT_MARKETING_IMAGE 4:5 min 480×600; LOGO 1:1 min 128×128; LANDSCAPE_LOGO 4:1 min 512×128;
 *                     max 5120 KB; GIF, JPG, PNG; BUSINESS_NAME 25 characters; "With brand guidelines enabled,
 *                     BUSINESS_NAME, LANDSCAPE_LOGO and LOGO must be linked using CampaignAsset"; the aspect ratio is
 *                     checked "when linking, not during the initial asset upload" (ASPECT_RATIO_NOT_ALLOWED).
 *   Google Ads Help answer 9566341 (image assets for Search): square 1:1 min 300×300, landscape 1.91:1 min 600×314,
 *                     PNG or JPG, 5120 KB. Advertising Policies answer 12499303 (business information): business name at
 *                     most 25 characters; business logo square 1:1, min 128×128, PNG or JPG.
 *   docs/assets/working-with-assets  an image asset is made from its raw bytes (ImageAsset.data, "mutate only");
 *                     "Unique names are required when creating image … assets" (Google appends a string to a name it
 *                     has); an image with the same content as one the account has is that asset again ("the new name will
 *                     be dropped silently"); text and image assets cannot be changed once uploaded.
 *   ImageAsset        data, file_size, mime_type, full_size. TextAsset text (Asset.text_asset Immutable).
 *   CallAsset         country_code (two letters) and phone_number Required; call_conversion_reporting_state
 *                     (CallConversionReportingState DISABLED / USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION /
 *                     USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION), call_conversion_action (used only with the last).
 *   PriceAsset        type (PriceExtensionType) and language_code (BCP 47) Required; price_qualifier (FROM, UP_TO,
 *                     AVERAGE); price_offerings 3 to 8. PriceOffering header and description Required, 1–25 each, not the
 *                     same (PRICE_HEADER_SAME_AS_DESCRIPTION); price (Money: amount_micros, currency_code) and final_url
 *                     Required; unit (PER_HOUR, PER_DAY, PER_WEEK, PER_MONTH, PER_YEAR, PER_NIGHT); final_mobile_url.
 *   PromotionAsset    promotion_target Required; discount_type oneof percent_off (1,000,000 = 100%) | money_amount_off
 *                     ("either this or … is required"); promotion_trigger oneof promotion_code | orders_over_amount (at
 *                     most one); discount_modifier UP_TO; occasion (PromotionExtensionOccasion; "the redemption window will
 *                     need to fall within the date range associated with the occasion"); language_code; start_date,
 *                     end_date, redemption_start_date, redemption_end_date in yyyy-MM-dd.
 *   LeadFormAsset     business_name, call_to_action_type (LeadFormCallToActionType), call_to_action_description,
 *                     headline, description, privacy_policy_url Required; fields (LeadFormField input_type, optional
 *                     single_choice_answers 2–12); post_submit_headline / _description / _call_to_action_type
 *                     (LeadFormPostSubmitCallToActionType); desired_intent (LOW_INTENT / HIGH_INTENT). AssetError
 *                     LEAD_FORM_MISSING_AGREEMENT: the lead form terms must be accepted first (customer.
 *                     customer_agreement_setting.accepted_lead_form_terms — accepted in Google Ads, not through the API).
 *   MobileAppAsset    app_id ("com.android.ebay" for Android or "12345689" for iOS), app_store (MobileAppVendor
 *                     APPLE_APP_STORE / GOOGLE_APP_STORE), link_text 1–25 Required; start_date, end_date.
 *   Location          docs/assets/location-assets: location assets are made by Google from a LOCATION_SYNC asset set
 *                     attached to the customer with CustomerAssetSetService; a Business Profile sync needs
 *                     http_authorization_token, an OAuth token with the business.manage scope of the Business Profile
 *                     account (BusinessProfileLocationSet: Required, Immutable). Nexus's Google sign-in holds no such
 *                     scope (cx/connectors/google/scopes.ts), and CustomerAssetSet is not a GoogleAdsService.Mutate
 *                     operation, so Nexus does not make location assets; google-ads-live view asset-links shows the
 *                     location sets the account has (a Business Profile linked in Google Ads).
 * Field type names: AssetFieldTypeEnum v25 (AD_IMAGE, BUSINESS_LOGO, BUSINESS_NAME, CALL, CALLOUT, LANDSCAPE_LOGO,
 * LEAD_FORM, LOGO, MARKETING_IMAGE, MOBILE_APP, PORTRAIT_MARKETING_IMAGE, PRICE, PROMOTION, SITELINK,
 * SQUARE_MARKETING_IMAGE, STRUCTURED_SNIPPET).
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import { httpsUrlProblem, tagWarning, textKey, widthProblem } from './change-ads.js'
import { ASSET_LIMITS, snippetHeader, type SitelinkRequest, type SnippetRequest } from './change-assets.js'
import { microsOfCents, type LiveCampaign } from './live.js'
import { placeLinkKey, type LinkLevel, type LiveAdGroupRef, type LiveAssetDetail, type LivePlaceLink } from './live-assets-all.js'
import type { GoogleImageType, PreparedImage } from './asset-images.js'
import type { GoogleMutateOperation, GoogleMutateResponse } from './write-client.js'

export type { LinkLevel } from './live-assets-all.js'

// ── what may be linked where ─────────────────────────────────────────────────────────────────────────────────────

export const LINK_LEVELS = ['account', 'campaign', 'ad-group'] as const
const ALL_LEVELS: readonly LinkLevel[] = LINK_LEVELS

export const LINK_FIELD_TYPES = [
  'SITELINK', 'CALLOUT', 'STRUCTURED_SNIPPET', 'CALL', 'PRICE', 'PROMOTION', 'MOBILE_APP', 'LEAD_FORM',
  'BUSINESS_NAME', 'BUSINESS_LOGO', 'AD_IMAGE', 'LOGO', 'LANDSCAPE_LOGO',
] as const
export type LinkFieldType = typeof LINK_FIELD_TYPES[number]

/** Where Google lets each field type be linked (the assets overview table; LOGO / LANDSCAPE_LOGO: the PMax requirements). */
export const FIELD_LEVELS: Record<LinkFieldType, readonly LinkLevel[]> = {
  SITELINK: ALL_LEVELS, CALLOUT: ALL_LEVELS, STRUCTURED_SNIPPET: ALL_LEVELS, CALL: ALL_LEVELS, PRICE: ALL_LEVELS,
  PROMOTION: ALL_LEVELS, MOBILE_APP: ALL_LEVELS,
  LEAD_FORM: ['campaign'],
  BUSINESS_NAME: ['account', 'campaign'],
  BUSINESS_LOGO: ['account', 'campaign'],
  AD_IMAGE: ['campaign', 'ad-group'],
  LOGO: ['campaign'],
  LANDSCAPE_LOGO: ['campaign'],
}

/** The asset type (Asset.type) each field type takes. */
export const ASSET_TYPE_OF: Record<LinkFieldType, string> = {
  SITELINK: 'SITELINK', CALLOUT: 'CALLOUT', STRUCTURED_SNIPPET: 'STRUCTURED_SNIPPET', CALL: 'CALL', PRICE: 'PRICE',
  PROMOTION: 'PROMOTION', MOBILE_APP: 'MOBILE_APP', LEAD_FORM: 'LEAD_FORM', BUSINESS_NAME: 'TEXT', BUSINESS_LOGO: 'IMAGE',
  AD_IMAGE: 'IMAGE', LOGO: 'IMAGE', LANDSCAPE_LOGO: 'IMAGE',
}

/** Links that can bring new paid interactions: a call from the ad, a lead form opened (each charged like a click). */
export const PAID_INTERACTION_FIELDS: readonly string[] = ['CALL', 'LEAD_FORM']

const WORD: Record<string, string> = {
  SITELINK: 'sitelink', CALLOUT: 'callout', STRUCTURED_SNIPPET: 'structured snippet', CALL: 'call asset', PRICE: 'price asset',
  PROMOTION: 'promotion', MOBILE_APP: 'app link', LEAD_FORM: 'lead form', BUSINESS_NAME: 'business name',
  BUSINESS_LOGO: 'business logo', AD_IMAGE: 'image', LOGO: 'logo', LANDSCAPE_LOGO: 'landscape logo',
  MARKETING_IMAGE: 'marketing image', SQUARE_MARKETING_IMAGE: 'square marketing image', PORTRAIT_MARKETING_IMAGE: 'portrait marketing image',
}
const LEVEL_WORD: Record<LinkLevel, string> = { account: 'the account', campaign: 'a campaign', 'ad-group': 'an ad group' }

// ── images ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const IMAGE_FIELD_TYPES = ['AD_IMAGE', 'BUSINESS_LOGO', 'LOGO', 'LANDSCAPE_LOGO', 'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE'] as const
export type ImageFieldType = typeof IMAGE_FIELD_TYPES[number]
/** Made only: Google links these to Performance Max asset groups and display ads, not to the account, a campaign or an ad group. */
export const UPLOAD_ONLY_IMAGES: readonly string[] = ['MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE']

interface ImageShape { name: string; ratio: number; minWidth: number; minHeight: number }
const SQUARE = (min: number): ImageShape => ({ name: 'square (1:1)', ratio: 1, minWidth: min, minHeight: min })
const LANDSCAPE: ImageShape = { name: 'landscape (1.91:1)', ratio: 1.91, minWidth: 600, minHeight: 314 }
const JPG_PNG: GoogleImageType[] = ['image/jpeg', 'image/png']
const JPG_PNG_GIF: GoogleImageType[] = ['image/jpeg', 'image/png', 'image/gif']
/** Google's shapes, smallest sizes and file types per image field type (sources in the header). */
export const IMAGE_RULES: Record<ImageFieldType, { shapes: ImageShape[]; types: GoogleImageType[] }> = {
  AD_IMAGE: { shapes: [SQUARE(300), LANDSCAPE], types: JPG_PNG },
  BUSINESS_LOGO: { shapes: [SQUARE(128)], types: JPG_PNG },
  LOGO: { shapes: [SQUARE(128)], types: JPG_PNG_GIF },
  LANDSCAPE_LOGO: { shapes: [{ name: 'landscape (4:1)', ratio: 4, minWidth: 512, minHeight: 128 }], types: JPG_PNG_GIF },
  MARKETING_IMAGE: { shapes: [LANDSCAPE], types: JPG_PNG_GIF },
  SQUARE_MARKETING_IMAGE: { shapes: [SQUARE(300)], types: JPG_PNG_GIF },
  PORTRAIT_MARKETING_IMAGE: { shapes: [{ name: 'portrait (4:5)', ratio: 0.8, minWidth: 480, minHeight: 600 }], types: JPG_PNG_GIF },
}
/** How far from a shape's ratio an image may be before Nexus refuses it (Google's own check judges the rest). */
export const RATIO_TOLERANCE = 0.02

export function imageProblem(where: string, fieldType: ImageFieldType, image: Pick<PreparedImage, 'mimeType' | 'width' | 'height'>): string | null {
  const rule = IMAGE_RULES[fieldType]
  if (!rule.types.includes(image.mimeType)) {
    return `${where} is ${image.mimeType.replace('image/', '').toUpperCase()}: a ${WORD[fieldType]} is ${rule.types.map((t) => t.replace('image/', '').toUpperCase()).join(' or ')}`
  }
  const ratio = image.width / image.height
  const shape = rule.shapes.find((s) => Math.abs(ratio - s.ratio) / s.ratio <= RATIO_TOLERANCE)
  if (!shape) return `${where} is ${image.width}×${image.height} (ratio ${ratio.toFixed(2)}): a ${WORD[fieldType]} is ${rule.shapes.map((s) => s.name).join(' or ')}`
  if (image.width < shape.minWidth || image.height < shape.minHeight) {
    return `${where} is ${image.width}×${image.height}: a ${shape.name} ${WORD[fieldType]} is at least ${shape.minWidth}×${shape.minHeight}`
  }
  return null
}

// ── requests ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AssetPlace { level: LinkLevel; campaignId?: string | null; adGroupId?: string | null }

export const PRICE_TYPES = ['BRANDS', 'EVENTS', 'LOCATIONS', 'NEIGHBORHOODS', 'PRODUCT_CATEGORIES', 'PRODUCT_TIERS', 'SERVICES', 'SERVICE_CATEGORIES', 'SERVICE_TIERS'] as const
export const PRICE_QUALIFIERS = ['FROM', 'UP_TO', 'AVERAGE'] as const
export const PRICE_UNITS = ['PER_HOUR', 'PER_DAY', 'PER_WEEK', 'PER_MONTH', 'PER_YEAR', 'PER_NIGHT'] as const
export const PROMOTION_OCCASIONS = [
  'NEW_YEARS', 'CHINESE_NEW_YEAR', 'VALENTINES_DAY', 'EASTER', 'MOTHERS_DAY', 'FATHERS_DAY', 'LABOR_DAY', 'BACK_TO_SCHOOL',
  'HALLOWEEN', 'BLACK_FRIDAY', 'CYBER_MONDAY', 'CHRISTMAS', 'BOXING_DAY', 'INDEPENDENCE_DAY', 'NATIONAL_DAY', 'END_OF_SEASON',
  'WINTER_SALE', 'SUMMER_SALE', 'FALL_SALE', 'SPRING_SALE', 'RAMADAN', 'EID_AL_FITR', 'EID_AL_ADHA', 'SINGLES_DAY',
  'WOMENS_DAY', 'HOLI', 'PARENTS_DAY', 'ST_NICHOLAS_DAY', 'CARNIVAL', 'EPIPHANY', 'ROSH_HASHANAH', 'PASSOVER', 'HANUKKAH',
  'DIWALI', 'NAVRATRI', 'SONGKRAN', 'YEAR_END_GIFT',
] as const
export const LEAD_FORM_CTAS = ['LEARN_MORE', 'GET_QUOTE', 'APPLY_NOW', 'SIGN_UP', 'CONTACT_US', 'SUBSCRIBE', 'DOWNLOAD', 'BOOK_NOW', 'GET_OFFER', 'REGISTER', 'GET_INFO', 'REQUEST_DEMO', 'JOIN_NOW', 'GET_STARTED'] as const
export const LEAD_FORM_POST_SUBMIT_CTAS = ['VISIT_SITE', 'DOWNLOAD', 'LEARN_MORE', 'SHOP_NOW'] as const
export const LEAD_FORM_INTENTS = ['LOW_INTENT', 'HIGH_INTENT'] as const
export const APP_STORES = ['APPLE_APP_STORE', 'GOOGLE_APP_STORE'] as const

export interface ImageRequest { fieldType: ImageFieldType; imageUrl?: string | null; libraryImageId?: string | null; name?: string | null }
export interface CallRequest { countryCode: string; phoneNumber: string; callConversion?: 'ACCOUNT' | 'OFF' | null; conversionActionId?: string | null }
export interface PriceOfferingRequest { header: string; description: string; priceCents: number; unit?: typeof PRICE_UNITS[number] | null; finalUrl: string; finalMobileUrl?: string | null }
export interface PriceRequest { priceType: typeof PRICE_TYPES[number]; qualifier?: typeof PRICE_QUALIFIERS[number] | null; languageCode: string; currency?: string | null; offerings: PriceOfferingRequest[] }
export interface PromotionRequest {
  target: string
  percentOff?: number | null
  amountOffCents?: number | null
  upTo?: boolean | null
  currency?: string | null
  promotionCode?: string | null
  ordersOverCents?: number | null
  occasion?: typeof PROMOTION_OCCASIONS[number] | null
  languageCode?: string | null
  startDate?: string | null
  endDate?: string | null
  redemptionStartDate?: string | null
  redemptionEndDate?: string | null
  finalUrl: string
}
export interface LeadFormFieldRequest { inputType: string; choices?: string[] | null }
export interface LeadFormRequest {
  /** The business name shown on the form (LeadFormAsset.business_name). */
  nameOnForm: string
  headline: string
  description: string
  callToActionType: typeof LEAD_FORM_CTAS[number]
  callToActionDescription: string
  privacyPolicyUrl: string
  finalUrl: string
  fields: LeadFormFieldRequest[]
  postSubmitHeadline?: string | null
  postSubmitDescription?: string | null
  postSubmitCallToActionType?: typeof LEAD_FORM_POST_SUBMIT_CTAS[number] | null
  desiredIntent?: typeof LEAD_FORM_INTENTS[number] | null
}
export interface MobileAppRequest { appStore: typeof APP_STORES[number]; appId: string; linkText: string; startDate?: string | null; endDate?: string | null }

export interface NewAssetsRequest {
  images?: ImageRequest[]
  businessNames?: string[]
  calls?: CallRequest[]
  prices?: PriceRequest[]
  promotions?: PromotionRequest[]
  leadForms?: LeadFormRequest[]
  mobileApps?: MobileAppRequest[]
  sitelinks?: SitelinkRequest[]
  callouts?: string[]
  structuredSnippets?: SnippetRequest[]
  /** Where every new asset is linked (an upload-only image is made and linked nowhere). */
  linkTo?: AssetPlace[]
  /** Make new call / lead form links ENABLED where they serve (SPENDS MONEY); without it they are made PAUSED there. */
  enable?: boolean
}

export interface NewAssetsLive {
  campaigns: LiveCampaign[]
  adGroups: LiveAdGroupRef[]
  /** The links at the places asked, of the field types asked. */
  links: LivePlaceLink[]
  /** One per request.images, in order: the image read, or why it cannot be one. */
  images: Array<PreparedImage | { problem: string }>
  /** Whether the account accepted Google's lead form terms; null when no lead form is asked (not read). */
  leadFormTerms: boolean | null
}

export const MAX_NEW_ASSETS = 20
export const MAX_PLACES = 20
export const MAX_LINK_ITEMS = 100
/**
 * The image bytes one request may carry, all images together. The bytes travel base64 inside the one mutate request
 * (a third larger), and Google's client libraries cap a message at 64 MB (developers.google.com/google-ads/api/docs/
 * best-practices/quotas, "gRPC limitations", checked 2026-10-15): 20 MB of images stays well inside it.
 */
export const MAX_IMAGE_BYTES_TOTAL = 20 * 1024 * 1024

// ── records ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type LinkStatus = 'ENABLED' | 'PAUSED'
const OP = 'op:'

/** A new asset (its id `op:<index>` until Google gave one); an image records its fingerprint, never its bytes. */
export interface NewAssetEntry { assetId: string; type: string; fieldType: string; text: string; sha256?: string; width?: number; height?: number }
/** A link at a place: where, which asset as what, its status, and how it reads. */
export interface PlacedLink { level: LinkLevel; campaignId: string | null; adGroupId: string | null; assetId: string; fieldType: string; status: LinkStatus; text: string }
export interface NewAssetsRecord { created: NewAssetEntry[]; linked: PlacedLink[] }

// ── places ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ResolvedPlace {
  level: LinkLevel
  campaignId: string | null
  adGroupId: string | null
  /** In words: the account, campaign "A", ad group "G" (campaign "A"). */
  name: string
  /** Whether a link here can serve now (an enabled campaign; an enabled ad group of one; the account while one is). */
  serves: boolean
  campaignType: string | null
  status: string | null
}

const placeKeyOf = (p: { level: LinkLevel; campaignId?: string | null; adGroupId?: string | null }) =>
  `${p.level}~${p.level === 'campaign' ? p.campaignId ?? '' : ''}~${p.level === 'ad-group' ? p.adGroupId ?? '' : ''}`

export function resolvePlace(place: AssetPlace, live: { campaigns: LiveCampaign[]; adGroups: LiveAdGroupRef[] }): ResolvedPlace | { problem: string } {
  if (place.level === 'account') {
    if (place.campaignId || place.adGroupId) return { problem: 'an account-level place names no campaign or ad group' }
    return { level: 'account', campaignId: null, adGroupId: null, name: 'the account', serves: live.campaigns.some((c) => c.status === 'ENABLED'), campaignType: null, status: null }
  }
  if (place.level === 'campaign') {
    if (!place.campaignId) return { problem: 'a campaign place needs campaignId' }
    if (place.adGroupId) return { problem: `campaign ${place.campaignId}: a campaign place names no ad group (use level ad-group)` }
    const c = live.campaigns.find((x) => x.campaignId === place.campaignId)
    if (!c) return { problem: `campaign ${place.campaignId} is not in this account (or it is removed)` }
    return { level: 'campaign', campaignId: c.campaignId, adGroupId: null, name: `campaign "${c.name}"`, serves: c.status === 'ENABLED', campaignType: c.type, status: c.status }
  }
  if (!place.adGroupId) return { problem: 'an ad group place needs adGroupId' }
  const g = live.adGroups.find((x) => x.adGroupId === place.adGroupId)
  if (!g) return { problem: `ad group ${place.adGroupId} is not in this account (or it or its campaign is removed)` }
  if (place.campaignId && place.campaignId !== g.campaignId) return { problem: `ad group ${place.adGroupId} is in campaign ${g.campaignId}, not ${place.campaignId}` }
  return {
    level: 'ad-group', campaignId: g.campaignId, adGroupId: g.adGroupId, name: `ad group "${g.name}" (campaign "${g.campaignName}")`,
    serves: g.status === 'ENABLED' && g.campaignStatus === 'ENABLED', campaignType: g.campaignType, status: g.status,
  }
}

/** Why a field type cannot be linked at a place, or null. */
function placeProblem(fieldType: LinkFieldType, place: ResolvedPlace): string | null {
  const levels = FIELD_LEVELS[fieldType]
  if (!levels.includes(place.level)) return `Google links a ${WORD[fieldType]} (${fieldType}) to ${levels.map((l) => LEVEL_WORD[l]).join(' or ')}, not to ${place.name}`
  if ((fieldType === 'LOGO' || fieldType === 'LANDSCAPE_LOGO') && place.campaignType !== 'PERFORMANCE_MAX') {
    return `a ${WORD[fieldType]} (${fieldType}) is linked to a Performance Max campaign (with brand guidelines), not to ${place.name} (a ${place.campaignType ?? 'campaign of another type'}): Search uses BUSINESS_LOGO`
  }
  return null
}

const LINK_KIND: Record<LinkLevel, string> = { account: 'customerAssetOperation', campaign: 'campaignAssetOperation', 'ad-group': 'adGroupAssetOperation' }

function linkResourceName(customer: string, place: { level: LinkLevel; campaignId: string | null; adGroupId: string | null }, assetId: string, fieldType: string): string {
  if (place.level === 'account') return `${customer}/customerAssets/${assetId}~${fieldType}`
  if (place.level === 'campaign') return `${customer}/campaignAssets/${place.campaignId}~${assetId}~${fieldType}`
  return `${customer}/adGroupAssets/${place.adGroupId}~${assetId}~${fieldType}`
}

function linkCreate(customer: string, place: ResolvedPlace, asset: string, fieldType: string, status: LinkStatus): GoogleMutateOperation {
  const at = place.level === 'campaign' ? { campaign: `${customer}/campaigns/${place.campaignId}` } : place.level === 'ad-group' ? { adGroup: `${customer}/adGroups/${place.adGroupId}` } : {}
  return { [LINK_KIND[place.level]]: { create: { ...at, asset, fieldType, ...(status === 'PAUSED' ? { status } : {}) } } }
}
const linkUpdate = (customer: string, place: ResolvedPlace, assetId: string, fieldType: string, status: LinkStatus): GoogleMutateOperation =>
  ({ [LINK_KIND[place.level]]: { update: { resourceName: linkResourceName(customer, place, assetId, fieldType), status }, updateMask: 'status' } })
const linkRemove = (customer: string, place: ResolvedPlace, assetId: string, fieldType: string): GoogleMutateOperation =>
  ({ [LINK_KIND[place.level]]: { remove: linkResourceName(customer, place, assetId, fieldType) } })

// ── content keys (an asset of the same content already linked at a place is not made again) ─────────────────────────

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '')
const lowerKey = (s: string | null | undefined) => textKey(s).toLowerCase()

/** The content key of a linked asset, by field type; null when Nexus does not compare it (images: Google itself does). */
export function linkedContentKey(fieldType: string | null, a: LiveAssetDetail): string | null {
  const d = a.details as Record<string, any>
  switch (fieldType) {
    case 'SITELINK': return `SITELINK:${textKey(d.linkText)}`
    case 'CALLOUT': return `CALLOUT:${textKey(d.calloutText)}`
    case 'STRUCTURED_SNIPPET': return `STRUCTURED_SNIPPET:${textKey(d.header)}|${((d.values as string[]) ?? []).map(textKey).sort().join('|')}`
    case 'CALL': return `CALL:${String(d.countryCode ?? '').toUpperCase()}:${digits(d.phoneNumber)}`
    case 'BUSINESS_NAME': return `BUSINESS_NAME:${textKey(d.text)}`
    case 'MOBILE_APP': return `MOBILE_APP:${d.appStore ?? ''}:${d.appId ?? ''}`
    case 'PRICE': return `PRICE:${d.priceType ?? ''}:${lowerKey(d.languageCode)}:${((d.offerings as Array<Record<string, any>>) ?? []).map((o) => `${textKey(o.header)}=${o.price?.cents ?? ''}`).join('|')}`
    case 'PROMOTION': return `PROMOTION:${textKey(d.target)}:${d.percentOff ?? ''}:${d.amountOff?.cents ?? ''}:${textKey(d.promotionCode)}:${d.startDate ?? ''}:${d.endDate ?? ''}`
    case 'LEAD_FORM': return `LEAD_FORM:${textKey(d.headline)}:${textKey(d.businessName)}`
    default: return null
  }
}

// ── checks ───────────────────────────────────────────────────────────────────────────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/
function dayProblem(where: string, day: string | null | undefined): string | null {
  if (!day) return null
  if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return `${where}: "${day}" is not a day (YYYY-MM-DD)`
  return null
}
const orderProblem = (where: string, from: string | null | undefined, to: string | null | undefined) =>
  (from && to && DAY.test(from) && DAY.test(to) && from > to ? `${where}: it starts (${from}) after it ends (${to})` : null)
const LANGUAGE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i
const CURRENCY = /^[A-Z]{3}$/
const PHONE = /^[0-9+()\-.\s]{4,30}$/
const ANDROID_APP = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/
const required = (where: string, text: string | null | undefined, problems: string[]) => { if (!(text ?? '').trim()) problems.push(`${where} is empty`) }

/** One new asset as it is sent (without its temporary resource name) and how it reads. */
interface NewSpec {
  fieldType: string
  type: string
  body: Record<string, unknown>
  text: string
  key: string | null
  /** Made and linked nowhere (images Google links to asset groups or ads). */
  uploadOnly: boolean
  image?: PreparedImage
}

/** Every new asset of the request, Google's rules checked on each (all problems at once). */
function newSpecs(customer: string, currency: string, request: NewAssetsRequest, live: NewAssetsLive, problems: string[], notes: string[]): NewSpec[] {
  const specs: NewSpec[] = []
  const tags = (where: string, text: string | null | undefined) => { const w = tagWarning(where, text); if (w) notes.push(w) }
  const width = (where: string, text: string | null | undefined, max: number) => { const p = widthProblem(where, text, max); if (p) problems.push(p) }
  const url = (where: string, u: string | null | undefined) => { const p = httpsUrlProblem(where, u); if (p) problems.push(p) }
  const currencyOf = (asked: string | null | undefined, where: string) => {
    const c = (asked ?? currency).trim().toUpperCase()
    if (!CURRENCY.test(c)) problems.push(`${where}: currency "${asked}" is not a three-letter code`)
    return c
  }

  ;(request.images ?? []).forEach((r, i) => {
    const where = `image ${i + 1}`
    const got = live.images[i]
    if (!got) { problems.push(`${where}: Nexus did not read it`); return }
    if ('problem' in got) { problems.push(`${where}: ${got.problem}`); return }
    const p = imageProblem(where, r.fieldType, got)
    if (p) { problems.push(p); return }
    const name = (r.name?.trim() || `${got.label ?? 'Image'} ${got.sha256.slice(0, 8)}`).slice(0, 120)
    specs.push({
      fieldType: r.fieldType, type: 'IMAGE', body: { name, type: 'IMAGE', imageAsset: { data: got.data } },
      text: `${name} (${got.width}×${got.height})`, key: null, uploadOnly: UPLOAD_ONLY_IMAGES.includes(r.fieldType), image: got,
    })
  })
  const imageBytes = live.images.reduce((sum, img) => sum + ('problem' in img ? 0 : img.bytes), 0)
  if (imageBytes > MAX_IMAGE_BYTES_TOTAL) {
    problems.push(`the images are ${(imageBytes / 1024 / 1024).toFixed(1)} MB together: one request carries at most ${MAX_IMAGE_BYTES_TOTAL / 1024 / 1024} MB of images (ask in two)`)
  }
  ;(request.businessNames ?? []).forEach((t, i) => {
    const where = `business name ${i + 1}`
    width(where, t, 25); tags(where, t)
    specs.push({ fieldType: 'BUSINESS_NAME', type: 'TEXT', body: { textAsset: { text: t.trim() } }, text: t.trim(), key: `BUSINESS_NAME:${textKey(t)}`, uploadOnly: false })
  })
  ;(request.calls ?? []).forEach((c, i) => {
    const where = `call ${i + 1}`
    const country = c.countryCode.trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(country)) problems.push(`${where}: country code "${c.countryCode}" is not two letters (IT, DE, …)`)
    if (!PHONE.test(c.phoneNumber.trim()) || digits(c.phoneNumber).length < 4) problems.push(`${where}: "${c.phoneNumber}" is not a phone number (digits, spaces, + - ( ) .)`)
    if (c.conversionActionId && c.callConversion) problems.push(`${where}: give callConversion or conversionActionId, not both`)
    if (c.conversionActionId && !/^\d{1,20}$/.test(c.conversionActionId)) problems.push(`${where}: conversion action "${c.conversionActionId}" is not a Google id`)
    const conversion = c.conversionActionId
      ? { callConversionReportingState: 'USE_RESOURCE_LEVEL_CALL_CONVERSION_ACTION', callConversionAction: `${customer}/conversionActions/${c.conversionActionId}` }
      : c.callConversion === 'OFF' ? { callConversionReportingState: 'DISABLED' }
        : c.callConversion === 'ACCOUNT' ? { callConversionReportingState: 'USE_ACCOUNT_LEVEL_CALL_CONVERSION_ACTION' } : {}
    specs.push({
      fieldType: 'CALL', type: 'CALL', body: { callAsset: { countryCode: country, phoneNumber: c.phoneNumber.trim(), ...conversion } },
      text: `${c.phoneNumber.trim()} (${country})`, key: `CALL:${country}:${digits(c.phoneNumber)}`, uploadOnly: false,
    })
  })
  ;(request.prices ?? []).forEach((p, i) => {
    const where = `price asset ${i + 1}`
    if (!LANGUAGE.test(p.languageCode.trim())) problems.push(`${where}: language "${p.languageCode}" is not a language code (en, it, de, …)`)
    const cur = currencyOf(p.currency, where)
    if (p.offerings.length < 3 || p.offerings.length > 8) problems.push(`${where}: ${plural(p.offerings.length, 'offering')} (Google needs 3 to 8)`)
    const heads = new Set<string>()
    p.offerings.forEach((o, j) => {
      const at = `${where}, offering ${j + 1}`
      width(`${at}, header`, o.header, 25); width(`${at}, description`, o.description, 25); tags(`${at}, header`, o.header); tags(`${at}, description`, o.description)
      if (textKey(o.header) && textKey(o.header) === textKey(o.description)) problems.push(`${at}: the header and the description are the same (Google refuses that)`)
      if (heads.has(textKey(o.header))) problems.push(`${at}: header "${o.header.trim()}" is named twice`)
      heads.add(textKey(o.header))
      if (!Number.isInteger(o.priceCents) || o.priceCents < 0) problems.push(`${at}: the price is not whole cents`)
      url(at, o.finalUrl)
      if (o.finalMobileUrl) url(`${at} (mobile)`, o.finalMobileUrl)
    })
    const offerings = p.offerings.map((o) => ({
      header: o.header.trim(), description: o.description.trim(), price: { currencyCode: cur, amountMicros: microsOfCents(o.priceCents) },
      ...(o.unit ? { unit: o.unit } : {}), finalUrl: o.finalUrl.trim(), ...(o.finalMobileUrl ? { finalMobileUrl: o.finalMobileUrl.trim() } : {}),
    }))
    specs.push({
      fieldType: 'PRICE', type: 'PRICE',
      body: { priceAsset: { type: p.priceType, ...(p.qualifier ? { priceQualifier: p.qualifier } : {}), languageCode: p.languageCode.trim(), priceOfferings: offerings } },
      text: `${p.priceType}: ${p.offerings.map((o) => `${o.header.trim()} ${cur} ${(o.priceCents / 100).toFixed(2)}`).join(', ')}`,
      key: `PRICE:${p.priceType}:${lowerKey(p.languageCode)}:${p.offerings.map((o) => `${textKey(o.header)}=${o.priceCents}`).join('|')}`,
      uploadOnly: false,
    })
  })
  ;(request.promotions ?? []).forEach((p, i) => {
    const where = `promotion ${i + 1}`
    required(`${where}, target`, p.target, problems); tags(`${where}, target`, p.target)
    const hasPercent = p.percentOff !== undefined && p.percentOff !== null
    const hasAmount = p.amountOffCents !== undefined && p.amountOffCents !== null
    if (hasPercent === hasAmount) problems.push(`${where}: give percentOff or amountOffCents (one of them, Google's rule)`)
    if (hasPercent && (!(p.percentOff! > 0) || p.percentOff! >= 100 || Math.abs(Math.round(p.percentOff! * 10) - p.percentOff! * 10) > 1e-6)) problems.push(`${where}: percentOff ${p.percentOff} is not above 0 and below 100 with at most one decimal`)
    if (hasAmount && (!Number.isInteger(p.amountOffCents) || p.amountOffCents! <= 0)) problems.push(`${where}: amountOffCents is not whole cents above 0`)
    const hasOrders = p.ordersOverCents !== undefined && p.ordersOverCents !== null
    if (p.promotionCode && hasOrders) problems.push(`${where}: give promotionCode or ordersOverCents, not both (Google's rule)`)
    if (hasOrders && (!Number.isInteger(p.ordersOverCents) || p.ordersOverCents! <= 0)) problems.push(`${where}: ordersOverCents is not whole cents above 0`)
    if (p.languageCode && !LANGUAGE.test(p.languageCode.trim())) problems.push(`${where}: language "${p.languageCode}" is not a language code`)
    for (const [k, v] of [['startDate', p.startDate], ['endDate', p.endDate], ['redemptionStartDate', p.redemptionStartDate], ['redemptionEndDate', p.redemptionEndDate]] as const) {
      const d = dayProblem(`${where}, ${k}`, v)
      if (d) problems.push(d)
    }
    for (const o of [orderProblem(where, p.startDate, p.endDate), orderProblem(`${where} (redemption)`, p.redemptionStartDate, p.redemptionEndDate)]) if (o) problems.push(o)
    url(where, p.finalUrl)
    const cur = currencyOf(p.currency, where)
    const discount = hasPercent ? { percentOff: String(Math.round(p.percentOff! * 10_000)) } : hasAmount ? { moneyAmountOff: { currencyCode: cur, amountMicros: microsOfCents(p.amountOffCents!) } } : {}
    const trigger = p.promotionCode ? { promotionCode: p.promotionCode.trim() } : hasOrders ? { ordersOverAmount: { currencyCode: cur, amountMicros: microsOfCents(p.ordersOverCents!) } } : {}
    const dates = Object.fromEntries((['startDate', 'endDate', 'redemptionStartDate', 'redemptionEndDate'] as const).filter((k) => p[k]).map((k) => [k, p[k]]))
    const off = hasPercent ? `${p.percentOff}% off` : hasAmount ? `${cur} ${(p.amountOffCents! / 100).toFixed(2)} off` : ''
    specs.push({
      fieldType: 'PROMOTION', type: 'PROMOTION',
      body: {
        finalUrls: [p.finalUrl.trim()],
        promotionAsset: {
          promotionTarget: p.target.trim(), ...(p.upTo ? { discountModifier: 'UP_TO' } : {}), ...discount, ...trigger,
          ...(p.occasion ? { occasion: p.occasion } : {}), ...(p.languageCode ? { languageCode: p.languageCode.trim() } : {}), ...dates,
        },
      },
      text: `${p.target.trim()}: ${p.upTo ? 'up to ' : ''}${off}${p.promotionCode ? ` (code ${p.promotionCode.trim()})` : ''}`,
      key: `PROMOTION:${textKey(p.target)}:${hasPercent ? Math.round(p.percentOff! * 100) / 100 : ''}:${hasAmount ? p.amountOffCents : ''}:${textKey(p.promotionCode)}:${p.startDate ?? ''}:${p.endDate ?? ''}`,
      uploadOnly: false,
    })
  })
  ;(request.leadForms ?? []).forEach((f, i) => {
    const where = `lead form ${i + 1}`
    for (const [k, v] of [['nameOnForm', f.nameOnForm], ['headline', f.headline], ['description', f.description], ['callToActionDescription', f.callToActionDescription]] as const) {
      required(`${where}, ${k}`, v, problems); tags(`${where}, ${k}`, v)
    }
    width(`${where}, nameOnForm`, f.nameOnForm, 25)
    url(`${where}, privacy policy`, f.privacyPolicyUrl)
    url(where, f.finalUrl)
    if (!f.fields.length) problems.push(`${where}: name at least one field to ask (FULL_NAME, EMAIL, PHONE_NUMBER, …)`)
    const seen = new Set<string>()
    f.fields.forEach((x, j) => {
      if (seen.has(x.inputType)) problems.push(`${where}, field ${j + 1}: ${x.inputType} is asked twice`)
      seen.add(x.inputType)
      if (x.choices && (x.choices.length < 2 || x.choices.length > 12)) problems.push(`${where}, field ${j + 1}: ${plural(x.choices.length, 'choice')} (Google needs 2 to 12)`)
    })
    const fields = f.fields.map((x) => ({ inputType: x.inputType, ...(x.choices?.length ? { singleChoiceAnswers: { answers: x.choices.map((c) => c.trim()) } } : {}) }))
    const optional = Object.fromEntries((['postSubmitHeadline', 'postSubmitDescription', 'postSubmitCallToActionType', 'desiredIntent'] as const)
      .filter((k) => f[k]).map((k) => [k, typeof f[k] === 'string' ? (f[k] as string).trim() : f[k]]))
    specs.push({
      fieldType: 'LEAD_FORM', type: 'LEAD_FORM',
      body: {
        finalUrls: [f.finalUrl.trim()],
        leadFormAsset: {
          businessName: f.nameOnForm.trim(), headline: f.headline.trim(), description: f.description.trim(), callToActionType: f.callToActionType,
          callToActionDescription: f.callToActionDescription.trim(), privacyPolicyUrl: f.privacyPolicyUrl.trim(), fields, ...optional,
        },
      },
      text: `${f.headline.trim()} (${f.nameOnForm.trim()})`, key: `LEAD_FORM:${textKey(f.headline)}:${textKey(f.nameOnForm)}`, uploadOnly: false,
    })
  })
  ;(request.mobileApps ?? []).forEach((m, i) => {
    const where = `app link ${i + 1}`
    width(`${where}, link text`, m.linkText, 25); tags(`${where}, link text`, m.linkText)
    const appId = m.appId.trim()
    if (m.appStore === 'APPLE_APP_STORE' ? !/^\d{1,20}$/.test(appId) : !ANDROID_APP.test(appId)) {
      problems.push(`${where}: "${appId}" is not ${m.appStore === 'APPLE_APP_STORE' ? 'an App Store id (digits, e.g. 12345689)' : 'an Android package name (e.g. com.example.app)'}`)
    }
    for (const [k, v] of [['startDate', m.startDate], ['endDate', m.endDate]] as const) { const d = dayProblem(`${where}, ${k}`, v); if (d) problems.push(d) }
    const o = orderProblem(where, m.startDate, m.endDate)
    if (o) problems.push(o)
    specs.push({
      fieldType: 'MOBILE_APP', type: 'MOBILE_APP',
      body: { mobileAppAsset: { appId, appStore: m.appStore, linkText: m.linkText.trim(), ...(m.startDate ? { startDate: m.startDate } : {}), ...(m.endDate ? { endDate: m.endDate } : {}) } },
      text: `${m.linkText.trim()} (${m.appStore === 'APPLE_APP_STORE' ? 'App Store' : 'Google Play'} ${appId})`, key: `MOBILE_APP:${m.appStore}:${appId}`, uploadOnly: false,
    })
  })
  ;(request.sitelinks ?? []).forEach((s, i) => {
    const where = `sitelink ${i + 1}`
    width(`${where}, link text`, s.linkText, ASSET_LIMITS.linkText); tags(`${where}, link text`, s.linkText)
    const d1 = s.description1?.trim() ?? ''
    const d2 = s.description2?.trim() ?? ''
    if (!!d1 !== !!d2) problems.push(`${where}: give description1 and description2 both, or neither (Google's rule)`)
    if (d1) width(`${where}, description1`, d1, ASSET_LIMITS.sitelinkDescription)
    if (d2) width(`${where}, description2`, d2, ASSET_LIMITS.sitelinkDescription)
    url(where, s.finalUrl)
    specs.push({
      fieldType: 'SITELINK', type: 'SITELINK',
      body: { finalUrls: [s.finalUrl.trim()], sitelinkAsset: { linkText: s.linkText.trim(), ...(d1 && d2 ? { description1: d1, description2: d2 } : {}) } },
      text: s.linkText.trim(), key: `SITELINK:${textKey(s.linkText)}`, uploadOnly: false,
    })
  })
  ;(request.callouts ?? []).forEach((c, i) => {
    width(`callout ${i + 1}`, c, ASSET_LIMITS.callout); tags(`callout ${i + 1}`, c)
    specs.push({ fieldType: 'CALLOUT', type: 'CALLOUT', body: { calloutAsset: { calloutText: c.trim() } }, text: c.trim(), key: `CALLOUT:${textKey(c)}`, uploadOnly: false })
  })
  ;(request.structuredSnippets ?? []).forEach((s, i) => {
    const where = `structured snippet ${i + 1}`
    const header = snippetHeader(s.header, s.language?.trim() || 'en')
    if ('problem' in header) problems.push(`${where}: ${header.problem}`)
    const values = s.values.map((v) => v.trim())
    if (values.length < ASSET_LIMITS.minSnippetValues || values.length > ASSET_LIMITS.maxSnippetValues) problems.push(`${where}: ${plural(values.length, 'value')} (Google needs ${ASSET_LIMITS.minSnippetValues} to ${ASSET_LIMITS.maxSnippetValues})`)
    const seen = new Set<string>()
    values.forEach((v, j) => {
      width(`${where}, value ${j + 1}`, v, ASSET_LIMITS.snippetValue); tags(`${where}, value ${j + 1}`, v)
      if (seen.has(textKey(v))) problems.push(`${where}, value ${j + 1} "${v}" is repeated (Google's policy refuses a repeated value)`)
      seen.add(textKey(v))
    })
    const h = 'header' in header ? header.header : s.header.trim()
    specs.push({
      fieldType: 'STRUCTURED_SNIPPET', type: 'STRUCTURED_SNIPPET', body: { structuredSnippetAsset: { header: h, values } },
      text: `${h}: ${values.join(', ')}`, key: `STRUCTURED_SNIPPET:${textKey(h)}|${values.map(textKey).sort().join('|')}`, uploadOnly: false,
    })
  })
  return specs
}

// ── newAssetsDraft ───────────────────────────────────────────────────────────────────────────────────────────────

const STATUS_WORD = (s: string | null | undefined) => (s === 'PAUSED' ? 'paused' : 'enabled')

function spendSentence(fieldType: string, text: string, place: ResolvedPlace, how: 'link' | 'enable'): string {
  const what = fieldType === 'CALL'
    ? 'people can call from its ads at once (a call from the ad is charged like a click)'
    : 'people can open the lead form from its ads at once (the click that opens it is charged like a click)'
  const where = place.level === 'account' ? 'the account (it serves in every enabled campaign that shows it)' : `${place.name} (enabled)`
  return `${how === 'enable' ? 'Enables' : 'Links'} the ${WORD[fieldType]} "${text}" ${how === 'enable' ? 'at' : 'ENABLED to'} ${where}: ${what}.`
}

export function newAssetsDraft(customer: string, currency: string, request: NewAssetsRequest, live: NewAssetsLive): GoogleChangeDraft | { refusal: string } {
  const problems: string[] = []
  const notes: string[] = []
  const specs = newSpecs(customer, currency, request, live, problems, notes)
  if (!specs.length && !problems.length) {
    return { refusal: 'Say what to make: images, businessNames, calls, prices, promotions, leadForms, mobileApps, sitelinks, callouts or structuredSnippets (and linkTo: where to link them).' }
  }
  if (specs.length > MAX_NEW_ASSETS) return { refusal: `At most ${MAX_NEW_ASSETS} new assets in one request (${specs.length} asked).` }
  const asked = request.linkTo ?? []
  if (asked.length > MAX_PLACES) return { refusal: `At most ${MAX_PLACES} places in one request (${asked.length} asked).` }

  // Where they go: each place once, each field type allowed there.
  const places: ResolvedPlace[] = []
  const seenPlace = new Set<string>()
  for (const p of asked) {
    const key = placeKeyOf(p)
    if (seenPlace.has(key)) continue
    seenPlace.add(key)
    const r = resolvePlace(p, live)
    if ('problem' in r) problems.push(r.problem)
    else places.push(r)
  }
  for (const s of specs) {
    if (s.uploadOnly) continue
    for (const place of places) {
      const p = placeProblem(s.fieldType as LinkFieldType, place)
      if (p) problems.push(`${WORD[s.fieldType]} "${s.text}": ${p}`)
    }
  }
  if (problems.length) return { refusal: `Not queued — the assets break Google's rules (nothing was sent): ${problems.join('; ')}.` }
  if (specs.some((s) => s.fieldType === 'LEAD_FORM') && live.leadFormTerms !== true) {
    return { refusal: 'The Google Ads account has not accepted Google\'s lead form terms, and Google refuses a lead form until it has (LEAD_FORM_MISSING_AGREEMENT). A person accepts them in Google Ads (the first time a lead form asset is made there); the API cannot. Nothing was sent.' }
  }

  const operations: GoogleMutateOperation[] = []
  const links: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const skipped: string[] = []
  const warnings: string[] = [...notes]
  const spendsMoney: string[] = []
  const record: NewAssetsRecord = { created: [], linked: [] }
  const contentAt = new Map<string, LivePlaceLink>()
  for (const l of live.links) {
    const key = linkedContentKey(l.fieldType, l.asset)
    if (key) contentAt.set(`${placeKeyOf(l)}|${key}`, l)
  }
  const askedKeys = new Set<string>()
  const pausedForSafety: string[] = []
  const notServing: string[] = []
  let tempId = -1

  for (const s of specs) {
    const label = `${WORD[s.fieldType]} "${s.text}"`
    if (s.key) {
      if (askedKeys.has(s.key)) { skipped.push(`The ${label} is named twice in this request.`); continue }
      askedKeys.add(s.key)
    }
    // At each place: the same content linked there already is not linked twice.
    const targets = s.uploadOnly ? [] : places.filter((place) => {
      const there = s.key ? contentAt.get(`${placeKeyOf(place)}|${s.key}`) : undefined
      if (there) skipped.push(`The ${label} is already linked to ${place.name} (asset ${there.assetId}${there.status === 'PAUSED' ? ', its link paused' : ''}).`)
      return !there
    })
    if (!s.uploadOnly && places.length && !targets.length) continue
    const resourceName = `${customer}/assets/${tempId--}`
    operations.push({ assetOperation: { create: { resourceName, ...s.body } } })
    const assetId = `${OP}${operations.length - 1}`
    record.created.push({ assetId, type: s.type, fieldType: s.fieldType, text: s.text, ...(s.image ? { sha256: s.image.sha256, width: s.image.width, height: s.image.height } : {}) })
    if (!targets.length) {
      lines.push([label, '(none)', s.uploadOnly ? 'new — for Performance Max asset groups and display ads (linked nowhere here)' : 'new, linked nowhere (it shows nowhere until linked)'])
      continue
    }
    for (const place of targets) {
      const paid = PAID_INTERACTION_FIELDS.includes(s.fieldType)
      const status: LinkStatus = paid && place.serves && !request.enable ? 'PAUSED' : 'ENABLED'
      links.push(linkCreate(customer, place, resourceName, s.fieldType, status))
      record.linked.push({ level: place.level, campaignId: place.campaignId, adGroupId: place.adGroupId, assetId, fieldType: s.fieldType, status, text: s.text })
      lines.push([`${label} at ${place.name}`, '(none)', status === 'PAUSED' ? 'new, linked PAUSED (it shows nothing until a person enables it)' : 'new, linked'])
      if (paid && place.serves && status === 'ENABLED') spendsMoney.push(spendSentence(s.fieldType, s.text, place, 'link'))
      if (paid && place.serves && status === 'PAUSED') pausedForSafety.push(`${label} at ${place.name}`)
      if (paid && !place.serves) notServing.push(`${label} at ${place.name}`)
    }
  }
  operations.push(...links)
  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }

  if (pausedForSafety.length) {
    warnings.push(`Made PAUSED where it would serve (a call or a lead form brings new paid clicks): ${pausedForSafety.join('; ')}. Ask again with enable: true to make it serve at once (SPENDS MONEY), or enable the link later with set-google-asset-links.`)
  }
  if (notServing.length) warnings.push(`Linked ENABLED where nothing serves yet: ${notServing.join('; ')}. When that campaign (and ad group) is enabled, people can call or open the form from its ads — each such click is charged like a click.`)
  if (record.linked.some((l) => !PAID_INTERACTION_FIELDS.includes(l.fieldType))) {
    warnings.push('The new assets make the ads bigger and raise no bid or budget; a click on one (a sitelink, a price, a promotion, the app link …) is charged like a click on the ad.')
  }
  if (record.created.some((c) => c.type === 'IMAGE')) {
    warnings.push('Google reviews each new image before it serves (google-ads-live view asset-links shows the review). Image assets on Search serve only in accounts Google finds eligible. An image whose content the account already has is that asset again (Google keeps one).')
  }
  if (record.created.some((c) => c.fieldType === 'BUSINESS_NAME' || c.fieldType === 'BUSINESS_LOGO')) {
    warnings.push('Google shows a business name or logo only after advertiser verification; the name must match the verified legal name or the domain (Google\'s business information policy).')
  }
  if (record.created.some((c) => c.fieldType === 'LEAD_FORM')) {
    warnings.push('Leads from the form stay in Google Ads (Assets › Lead forms: download them there); Nexus sets no webhook.')
  }
  if (record.created.some((c) => c.fieldType === 'PROMOTION') && (request.promotions ?? []).some((p) => p.occasion)) {
    warnings.push('A promotion with an occasion must have its redemption dates inside the occasion\'s window (Google checks it).')
  }
  warnings.push('Google never removes an asset: undo unlinks the new ones (they stay in the account, linked nowhere, and do nothing).')

  const made: Record<string, number> = {}
  for (const c of record.created) made[c.fieldType] = (made[c.fieldType] ?? 0) + 1
  const madeText = Object.entries(made).map(([k, n]) => plural(n, WORD[k] ?? k)).join(', ')
  const placeText = places.length ? ` and link them at ${places.length === 1 ? places[0].name : plural(places.length, 'place')}` : ''
  const { changes, more } = changeLines(lines)
  return {
    summary: `Google Ads assets: make ${madeText}${placeText}.`,
    changes,
    totals: {
      operations: operations.length,
      assetsMade: record.created.length,
      links: record.linked.length,
      linksPaused: record.linked.filter((l) => l.status === 'PAUSED').length,
      ...(more ? { linesNotShown: more } : {}),
    },
    warnings,
    spendsMoney,
    skipped,
    operations,
    stands: {
      places: places.map((p) => `${placeKeyOf(p)}~${p.status ?? ''}~${p.serves ? 'serves' : 'quiet'}`).sort(),
      links: live.links.map((l) => `${placeLinkKey(l)}~${l.status ?? ''}`).sort(),
      images: live.images.map((img) => ('problem' in img ? null : img.sha256)),
      leadFormTerms: live.leadFormTerms,
    },
    before: { created: [], linked: [] } satisfies NewAssetsRecord,
    after: record,
  }
}

/** The record of a run, with the id Google gave each new asset (`assetResult` of the operation that made it). */
export function newAssetsRecordAfterRun(after: NewAssetsRecord, responses: GoogleMutateResponse[]): NewAssetsRecord {
  const idOf = (assetId: string): string => {
    if (!assetId.startsWith(OP)) return assetId
    const name = responses[Number(assetId.slice(OP.length))]?.assetResult?.resourceName
    return name ? name.slice(name.lastIndexOf('/') + 1) : assetId
  }
  return {
    created: after.created.map((c) => ({ ...c, assetId: idOf(c.assetId) })),
    linked: after.linked.map((l) => ({ ...l, assetId: idOf(l.assetId) })),
  }
}

// ── assetLinksDraft ──────────────────────────────────────────────────────────────────────────────────────────────

export const LINK_ACTIONS = ['link', 'pause', 'enable', 'unlink'] as const
export type LinkAction = typeof LINK_ACTIONS[number]

export interface LinkItemRequest extends AssetPlace { assetId: string; fieldType: LinkFieldType; action: LinkAction; status?: LinkStatus | null }
export interface LinksRequest { items: LinkItemRequest[] }
export interface LinksLive {
  campaigns: LiveCampaign[]
  adGroups: LiveAdGroupRef[]
  /** The links at the places named, of the assets named. */
  links: LivePlaceLink[]
  /** The assets `link` names, by id. */
  assets: LiveAssetDetail[]
}

/** One link the change made, changed or took away: its status before (null: not linked) and after (null: unlinked). */
export interface LinkChange { level: LinkLevel; campaignId: string | null; adGroupId: string | null; assetId: string; fieldType: string; text: string; from: LinkStatus | null; to: LinkStatus | null }
export interface LinksRecord { items: LinkChange[] }

const asStatus = (s: string | null | undefined): LinkStatus => (s === 'PAUSED' ? 'PAUSED' : 'ENABLED')

export function assetLinksDraft(customer: string, request: LinksRequest, live: LinksLive): GoogleChangeDraft | { refusal: string } {
  const items = request.items ?? []
  if (!items.length) return { refusal: 'Name at least one link (items: a place, an asset id, its field type and link, pause, enable or unlink).' }
  if (items.length > MAX_LINK_ITEMS) return { refusal: `At most ${MAX_LINK_ITEMS} items in one request (${items.length} asked).` }
  const problems: string[] = []
  const seen = new Set<string>()
  const resolved: Array<{ item: LinkItemRequest; place: ResolvedPlace }> = []
  items.forEach((item, i) => {
    const where = `item ${i + 1}`
    if (!(LINK_FIELD_TYPES as readonly string[]).includes(item.fieldType)) { problems.push(`${where}: field type ${item.fieldType} is not one Nexus links (${LINK_FIELD_TYPES.join(', ')})`); return }
    const place = resolvePlace(item, live)
    if ('problem' in place) { problems.push(`${where}: ${place.problem}`); return }
    const key = placeLinkKey({ ...place, assetId: item.assetId, fieldType: item.fieldType })
    if (seen.has(key)) { problems.push(`${where}: asset ${item.assetId} (${item.fieldType}) at ${place.name} is named twice`); return }
    seen.add(key)
    if (item.status && item.action !== 'link') problems.push(`${where}: status goes with action link only (pause and enable say it)`)
    if (item.action === 'link') {
      const p = placeProblem(item.fieldType, place)
      if (p) problems.push(`${where}: ${p}`)
    }
    resolved.push({ item, place })
  })
  if (problems.length) return { refusal: `Not queued (nothing was sent): ${problems.join('; ')}.` }

  const linkAt = new Map(live.links.map((l) => [placeLinkKey(l), l]))
  const assetById = new Map(live.assets.map((a) => [a.assetId, a]))
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const skipped: string[] = []
  const warnings: string[] = []
  const spendsMoney: string[] = []
  const changes: LinkChange[] = []
  const pausedForSafety: string[] = []
  const shownAgain: string[] = []

  for (const { item, place } of resolved) {
    const key = placeLinkKey({ ...place, assetId: item.assetId, fieldType: item.fieldType })
    const now = linkAt.get(key)
    const paid = PAID_INTERACTION_FIELDS.includes(item.fieldType)
    const base = { level: place.level, campaignId: place.campaignId, adGroupId: place.adGroupId, assetId: item.assetId, fieldType: item.fieldType }
    if (item.action === 'link') {
      const asset = assetById.get(item.assetId)
      if (!asset) return { refusal: `Asset ${item.assetId} is not in this account (google-ads-live view asset-links lists the linked ones).` }
      if (asset.type !== ASSET_TYPE_OF[item.fieldType]) return { refusal: `Asset ${item.assetId} is ${asset.type ? `a ${asset.type} asset` : 'an asset of another kind'}: a ${WORD[item.fieldType]} (${item.fieldType}) is a ${ASSET_TYPE_OF[item.fieldType]} asset.` }
      if (asset.source === 'AUTOMATICALLY_CREATED') return { refusal: `Asset ${item.assetId} ("${asset.label}") was made by Google (text customization): Google does not let it be linked. Make an asset of your own with add-google-assets.` }
      const label = `${WORD[item.fieldType]} "${asset.label}" (asset ${item.assetId})`
      if (now) { skipped.push(`The ${label} is already linked to ${place.name} (${STATUS_WORD(now.status)}).`); continue }
      const status: LinkStatus = item.status ?? (paid && place.serves ? 'PAUSED' : 'ENABLED')
      operations.push(linkCreate(customer, place, `${customer}/assets/${item.assetId}`, item.fieldType, status))
      changes.push({ ...base, text: asset.label, from: null, to: status })
      lines.push([`${label} at ${place.name}`, 'not linked', status === 'PAUSED' ? 'linked, paused (it shows nothing)' : 'linked'])
      if (paid && place.serves && status === 'ENABLED') spendsMoney.push(spendSentence(item.fieldType, asset.label, place, 'link'))
      if (paid && place.serves && status === 'PAUSED' && !item.status) pausedForSafety.push(`${label} at ${place.name}`)
      if (!paid && place.serves && status === 'ENABLED') shownAgain.push(`${label} at ${place.name}`)
      continue
    }
    if (!now) { skipped.push(`Asset ${item.assetId} is not linked to ${place.name} as a ${WORD[item.fieldType]} (${item.fieldType}).`); continue }
    const label = `${WORD[item.fieldType]} "${now.asset.label}" (asset ${item.assetId})`
    const from = asStatus(now.status)
    if (item.action === 'unlink') {
      operations.push(linkRemove(customer, place, item.assetId, item.fieldType))
      changes.push({ ...base, text: now.asset.label, from, to: null })
      lines.push([`${label} at ${place.name}`, from === 'PAUSED' ? 'linked, paused' : 'linked', 'unlinked (the asset stays in the account)'])
      continue
    }
    const to: LinkStatus = item.action === 'pause' ? 'PAUSED' : 'ENABLED'
    if (from === to) { skipped.push(`The ${label} at ${place.name} is already ${STATUS_WORD(to)}.`); continue }
    operations.push(linkUpdate(customer, place, item.assetId, item.fieldType, to))
    changes.push({ ...base, text: now.asset.label, from, to })
    lines.push([`${label} at ${place.name}`, STATUS_WORD(from), STATUS_WORD(to)])
    if (to === 'ENABLED' && paid && place.serves) spendsMoney.push(spendSentence(item.fieldType, now.asset.label, place, 'enable'))
    if (to === 'ENABLED' && !paid && place.serves) shownAgain.push(`${label} at ${place.name}`)
  }
  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }

  const unlinked = changes.filter((c) => c.to === null)
  if (unlinked.length) warnings.push(`Unlinking ${plural(unlinked.length, 'asset link')}: the ads there show without ${unlinked.length === 1 ? 'it' : 'them'} (the assets stay in the account).`)
  if (pausedForSafety.length) warnings.push(`Linked PAUSED where it would serve (a call or a lead form brings new paid clicks): ${pausedForSafety.join('; ')}. Ask with status ENABLED to make it serve at once (SPENDS MONEY).`)
  if (shownAgain.length) warnings.push(`Shows in ads that serve now: ${shownAgain.join('; ')}. It raises no bid or budget; a click on it is charged like a click on the ad.`)
  if (changes.some((c) => c.from !== null && c.to !== null && c.to === 'PAUSED')) warnings.push('A paused link keeps the asset where it is and shows nothing; enable it again with this tool.')

  const counts = { linked: changes.filter((c) => c.from === null).length, unlinked: unlinked.length, paused: changes.filter((c) => c.from && c.to === 'PAUSED').length, enabled: changes.filter((c) => c.from && c.to === 'ENABLED').length }
  const parts = [
    counts.linked ? `link ${plural(counts.linked, 'asset')}` : '', counts.enabled ? `enable ${plural(counts.enabled, 'link')}` : '',
    counts.paused ? `pause ${plural(counts.paused, 'link')}` : '', counts.unlinked ? `unlink ${plural(counts.unlinked, 'asset')}` : '',
  ].filter(Boolean)
  const { changes: table, more } = changeLines(lines)
  return {
    summary: `Google Ads asset links: ${parts.join('; ')}.`,
    changes: table,
    totals: { operations: operations.length, ...counts, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney,
    skipped,
    operations,
    stands: {
      places: [...new Map(resolved.map(({ place }) => [placeKeyOf(place), `${placeKeyOf(place)}~${place.status ?? ''}~${place.serves ? 'serves' : 'quiet'}`])).values()].sort(),
      links: live.links.map((l) => `${placeLinkKey(l)}~${l.status ?? ''}`).sort(),
      assets: live.assets.map((a) => `${a.assetId}~${a.type ?? ''}~${a.source ?? ''}`).sort(),
    },
    // Before: each link the change touches, as it was (status null: not linked there).
    before: { links: changes.map(({ from, to: _to, ...c }) => ({ ...c, status: from })) },
    after: { items: changes } satisfies LinksRecord,
  }
}

/** The request that puts a link change back: unlink what it linked, link again what it unlinked (old status), status back. */
export function linksUndoItems(changes: LinkChange[]): Array<Record<string, unknown>> {
  return changes.map((c) => {
    const place = { level: c.level, ...(c.level === 'campaign' ? { campaignId: c.campaignId } : {}), ...(c.level === 'ad-group' ? { adGroupId: c.adGroupId } : {}) }
    const base = { ...place, assetId: c.assetId, fieldType: c.fieldType }
    if (c.from === null) return { ...base, action: 'unlink' }
    if (c.to === null) return { ...base, action: 'link', status: c.from }
    return { ...base, action: c.from === 'PAUSED' ? 'pause' : 'enable' }
  })
}

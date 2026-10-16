/**
 * Google Ads changes (2026-10-15, programme 2 group G11) — Demand Gen, Display and App campaigns, and the video
 * responsive ads of Video campaigns. Every tool here is a Nexus change: a preview Google has checked (validate_only), an
 * approvalId, a person approves it in Nexus, it runs as that person (google-ads-kit.ts). Never by rule.
 *
 *   create-google-demand-gen-campaign   a Demand Gen campaign (PAUSED) with its own budget, bidding, ad groups (channel
 *                                       controls, audiences, locations, languages), ads (image, carousel, video,
 *                                       product) and the images / YouTube videos they use — one request
 *   create-google-display-campaign      a Display campaign (PAUSED) with its budget, bidding, locations, languages,
 *                                       content exclusions, ad groups (bids, placements, topics, keywords, YouTube,
 *                                       apps, audiences) and responsive display ads — one request
 *   create-google-app-campaign          an App campaign (PAUSED): installs, in-app actions or value, engagement or
 *                                       pre-registration, with its ad groups and app ads — one request
 *   add-google-campaign-type-ads        new ad groups and new ads in an existing Demand Gen, Display or App campaign
 *   set-google-campaign-type            an existing one's name, dates, bidding and budget amount, and its ad groups'
 *                                       names, channel controls, optimized targeting, bids and targeting
 *   edit-google-campaign-type-ads       their ads (and a Video campaign's video responsive ads) changed in place
 *
 * What Google's API cannot do (checked 2026-10-15, developers.google.com/google-ads/api/docs/video/overview): make or change
 * a Video campaign, its ad groups or its targeting — only a video responsive ad's texts, final URL, logo and video. The
 * builders, with every field and rule checked in Google's v25 reference, are marketing/google-ads/change-campaign-types.ts;
 * the live reads live-campaign-types.ts; images come through asset-images.ts (G6). build-google-campaigns and
 * copy-google-campaign do not hold these types yet (programme 2 G13).
 *
 * G14b (2026-10-16) added: Display image ads and HTML5 ads (a ZIP from an https link through the one public-address
 * fetch, media-bundles.ts), frequency caps (Display and Demand Gen), demographics targeted on Display ad groups with bid
 * adjustments (and bid adjustments on a Display ad group's audiences, placements and topics, changed in place), and
 * Google's own automation of new Demand Gen image and video ads OFF unless asked.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleCentsArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, recordAccount, runGoogleChange,
  type GoogleDraftBuilder,
} from './google-ads-kit.js'
import {
  AD_KINDS, APP_GOALS, APP_STORES, imageSourceKey, mediaNeeds, normalizeTarget, segmentKindOf, typedAddDraft, typedAddRecordAfterRun,
  typedCreateDraft, typedCreateRecordAfterRun, typedEditDraft, typedEditNow, typedEditRecordAfterRun, typedSettingsDraft, typedSettingsNow,
  TYPED_STRATEGIES, type ChannelControls, type MediaLive, type MediaNeeds, type TargetItem, type TargetNames, type TypedAddRecord,
  type TypedAddRequest, type TypedAdGroupRequest, type CampaignPlace, type TypedSettingsLive, type TypedCampaignCreateRequest, type TypedCreateRecord, type TypedEditRecord,
  type TypedEditRequest, type TypedKind, type TypedSettingsRecord, type TypedSettingsRequest,
} from '../../marketing/google-ads/change-campaign-types.js'
import {
  DG_CHANNELS, DG_STRATEGIES, FREQUENCY_EVENTS, FREQUENCY_LEVELS, FREQUENCY_UNITS, liveAudiences, liveMediaAssets, liveTypedAdGroups, liveTypedAds,
  liveTypedCampaign, liveTypedCriteria, liveYoutubeAssets, TARGET_KINDS,
} from '../../marketing/google-ads/live-campaign-types.js'
import { MAX_IMAGE_BYTES_TOTAL } from '../../marketing/google-ads/change-assets-all.js'
import { idOf, liveBudgets, liveCampaigns } from '../../marketing/google-ads/live.js'
import { liveCampaignCriteria } from '../../marketing/google-ads/live-campaigns.js'
import { liveSegmentNames, type AudienceKind } from '../../marketing/google-ads/live-targeting.js'
import { prepareImage, type PreparedImage } from '../../marketing/google-ads/asset-images.js'
import { prepareMediaBundle, type PreparedBundle } from '../../marketing/google-ads/media-bundles.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'
import type { GoogleAdsTarget } from '../../marketing/google-ads/types.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of these tools' previews and answers (their sentences and tables quote budgets, bids and targets). */
const TYPED_MONEY = {
  changes: ADSPEND, spendsMoneyBecause: ADSPEND, warnings: ADSPEND, dailyBudgetCents: ADSPEND, totalBudgetCents: ADSPEND,
  budgetCents: ADSPEND, maxCpcCents: ADSPEND, targetCpcCents: ADSPEND, targetCpaCents: ADSPEND, targetRoas: ADSPEND, defaultBidCents: ADSPEND,
} as const

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

/** A record as the run stamped it: the Google account it was made on (google-ads-kit runGoogleChange). */
type Stamped = { accountId?: string; customerId?: string }
const accountArgOf = (record: Stamped) => (record.accountId ? { accountId: record.accountId } : {})
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
const KIND_WORD: Record<TypedKind, string> = { DEMAND_GEN: 'Demand Gen', DISPLAY: 'Display', APP: 'App' }
/** A `why` as the change tools take it (at most 300 characters). */
const why300 = (text: string) => (text.length > 300 ? `${text.slice(0, 299)}…` : text)

// ── what the tools read ─────────────────────────────────────────────────────────────────────────────────────────

/** At most this many new images in one request (each is fetched and sent inside the one request). */
export const MAX_NEW_IMAGES = 20
/** At most this many new HTML5 ZIPs in one request (each up to 600 KB, fetched and sent inside the one request). */
export const MAX_NEW_BUNDLES = 5

/** The images to make (fetched one at a time, bounded), the assets named by id, the YouTube videos named. */
async function mediaFor(target: GoogleAdsTarget, needs: MediaNeeds): Promise<MediaLive> {
  const images: Record<string, PreparedImage | { problem: string }> = {}
  let bytes = 0
  for (const [i, ref] of needs.imageSources.entries()) {
    const key = imageSourceKey(ref)!
    if (i >= MAX_NEW_IMAGES) { images[key] = { problem: `not read: at most ${MAX_NEW_IMAGES} new images in one request` }; continue }
    if (bytes > MAX_IMAGE_BYTES_TOTAL) { images[key] = { problem: `not read: the images before it already pass the ${MAX_IMAGE_BYTES_TOTAL / 1024 / 1024} MB one request carries (ask in two)` }; continue }
    const got = await prepareImage({ imageUrl: ref.imageUrl ?? null, libraryImageId: ref.libraryImageId ?? null })
    if (!('problem' in got)) bytes += got.bytes
    images[key] = got
  }
  const bundles: Record<string, PreparedBundle | { problem: string }> = {}
  for (const [i, url] of needs.bundleUrls.entries()) {
    if (i >= MAX_NEW_BUNDLES) { bundles[url] = { problem: `not read: at most ${MAX_NEW_BUNDLES} new HTML5 ZIPs in one request` }; continue }
    bundles[url] = await prepareMediaBundle(url)
  }
  return {
    images,
    assets: needs.assetIds.length ? await liveMediaAssets(target, needs.assetIds) : [],
    youtube: needs.youtubeIds.length ? await liveYoutubeAssets(target, needs.youtubeIds) : [],
    ...(needs.bundleUrls.length ? { bundles } : {}),
  }
}

const TARGET_OF_SEGMENT: Record<AudienceKind, string> = {
  USER_LIST: 'user-list', USER_INTEREST: 'user-interest', CUSTOM_AUDIENCE: 'custom-audience', COMBINED_AUDIENCE: 'combined-audience', LIFE_EVENT: 'life-event',
}

/** The names Google gives the audience segments and Audience resources the items name (unknown ids are missing). */
async function targetNames(target: GoogleAdsTarget, items: TargetItem[]): Promise<TargetNames> {
  const refs: Array<{ kind: AudienceKind; id: string }> = []
  const audiences: string[] = []
  for (const raw of items) {
    const n = normalizeTarget(raw)
    if ('problem' in n) continue
    const segment = segmentKindOf(n.kind)
    if (segment) refs.push({ kind: segment, id: n.value })
    else if (n.kind === 'audience') audiences.push(n.value)
  }
  const names: TargetNames = {}
  if (refs.length) {
    for (const [key, value] of Object.entries(await liveSegmentNames(target, refs))) {
      const [kind, id] = key.split('|')
      names[`${TARGET_OF_SEGMENT[kind as AudienceKind]}|${id}`] = value
    }
  }
  for (const a of audiences.length ? await liveAudiences(target, [...new Set(audiences)]) : []) names[`audience|${a.audienceId}`] = { name: a.name, status: a.status }
  return names
}

/** Every image ref of the arguments (any depth): a library image needs the image library permission, as image-library does. */
function usesLibrary(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(usesLibrary)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(([k, v]) => (k === 'libraryImageId' && typeof v === 'string' && !!v.trim()) || usesLibrary(v))
}
function libraryRefusal(args: Record<string, unknown>, ctx: ToolContext): ToolResult | null {
  return usesLibrary(args) && !ctx.can(F.assetsManage)
    ? { ok: false, error: `An image from the Nexus image library needs the ${F.assetsManage} permission (as image-library does). Give imageUrl or an assetId instead, or ask a person who has it.` }
    : null
}

// ── shared arguments ────────────────────────────────────────────────────────────────────────────────────────────

const dayArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).describe(`${what} (YYYY-MM-DD, the account's time zone)`)
const imageRefArg = z.object({
  assetId: googleIdArg('an image asset the account has').optional(),
  imageUrl: z.string().trim().min(1).max(2048).optional().describe('a new image from this https link (a public address; JPG, PNG or GIF, at most 5120 KB)'),
  libraryImageId: z.string().trim().min(3).max(80).optional().describe('a new image from the Nexus image library (its id from image-library: da_… or pi_…; needs the image library permission)'),
}).describe('one image: assetId, imageUrl or libraryImageId')
const imagesArg = (what: string) => z.array(imageRefArg).max(20).optional().describe(what)
const videoRefArg = z.object({
  assetId: googleIdArg('a YouTube video asset the account has').optional(),
  youtubeVideoId: z.string().trim().min(11).max(300).optional().describe('a YouTube video: its id (11 characters, as on its watch page) or its link; the video must already be on YouTube'),
}).describe('one video: assetId or youtubeVideoId')
const textsArg = (what: string) => z.array(z.string().trim().min(1).max(200)).max(15).optional().describe(what)

/** The fields of an ad, whatever its type (each type takes the ones its description names). */
const adFields = {
  finalUrl: z.string().trim().max(2048).optional().describe('the page the ad leads to (https); App ads have none (the app\'s store page)'),
  headlines: textsArg('headlines: responsive display and Demand Gen image ads 1–5 (each at most 30 characters); carousel and product ads ONE; video ads and app ads several'),
  longHeadlines: textsArg('long headlines: responsive display ads ONE (at most 90 characters); Demand Gen and Video video ads'),
  descriptions: textsArg('descriptions: 1–5 (each at most 90 characters); carousel and product ads ONE'),
  brandName: z.string().trim().min(1).max(100).optional().describe('the business or brand name shown in the ad (Google\'s business_name; at most 25 characters where Google says so)'),
  callToActionText: z.string().trim().max(60).optional().describe('the button text (responsive display, Demand Gen image and carousel ads, Video video ads); Google checks the wording'),
  breadcrumb1: z.string().trim().max(60).optional().describe('Demand Gen video and product ads, Video video ads: first part of the shown URL path'),
  breadcrumb2: z.string().trim().max(60).optional().describe('second part of the shown URL path'),
  marketingImages: imagesArg('landscape images (1.91:1, at least 600×314): responsive display ads at least 1; Demand Gen image ads (a landscape or a square one needed)'),
  squareMarketingImages: imagesArg('square images (1:1, at least 300×300): responsive display ads at least 1; Demand Gen image ads'),
  portraitMarketingImages: imagesArg('Demand Gen image ads: portrait images (4:5, at least 480×600)'),
  tallPortraitMarketingImages: imagesArg('Demand Gen image ads: tall portrait images (9:16, at least 600×1067)'),
  logoImages: imagesArg('logos: square (1:1, at least 128×128) for Demand Gen and Video ads (carousel and product ads ONE); for a responsive display ad these are landscape logos (4:1, at least 512×128)'),
  squareLogoImages: imagesArg('responsive display ads: square logos (1:1, at least 128×128); with the landscape ones at most 5'),
  images: imagesArg('App ads: images'),
  videos: z.array(videoRefArg).max(20).optional().describe('YouTube videos: Demand Gen video ads (at least 1), responsive display ads (at most 5), App ads, Video video ads (ONE)'),
}

const cardArg = z.object({
  headline: z.string().trim().min(1).max(100).describe('the card\'s headline'),
  finalUrl: z.string().trim().min(1).max(2048).describe('the page the card leads to (https)'),
  callToActionText: z.string().trim().min(1).max(60).optional().describe('the card\'s button text'),
  marketingImageAssetId: googleIdArg('an EXISTING landscape image asset (1.91:1): Google takes no new image in a card').optional(),
  squareMarketingImageAssetId: googleIdArg('an EXISTING square image asset (1:1)').optional(),
  portraitMarketingImageAssetId: googleIdArg('an EXISTING portrait image asset (4:5)').optional(),
})

const newAdArg = z.object({
  type: z.preprocess(lower, z.enum(AD_KINDS)).optional()
    .describe('the ad: Demand Gen multi-asset (image ad), carousel, video or product (a feed campaign); Display responsive-display (default), image (an uploaded image ad) or html5-upload (an HTML5 ad); App app (default)'),
  name: z.string().trim().min(1).max(255).optional().describe('Demand Gen, image and HTML5 ads: the ad\'s name in reports (it cannot be changed later)'),
  ...adFields,
  cards: z.array(cardArg).max(10).optional().describe('carousel ads: 2 to 10 cards, each with an EXISTING image asset (make images first with add-google-assets: MARKETING_IMAGE / SQUARE_MARKETING_IMAGE)'),
  mainColor: z.string().trim().max(7).optional().describe('responsive display ads: the main colour (#rrggbb; with accentColor)'),
  accentColor: z.string().trim().max(7).optional().describe('responsive display ads: the accent colour (#rrggbb; with mainColor)'),
  allowFlexibleColor: z.boolean().optional().describe('responsive display ads: Google may use other colours (default true; must be true without colours)'),
  formatSetting: z.preprocess(upper, z.enum(['ALL_FORMATS', 'NATIVE', 'NON_NATIVE'])).optional().describe('responsive display ads: ALL_FORMATS (default), NATIVE or NON_NATIVE'),
  assetEnhancements: z.boolean().optional().describe('Google may enhance the media (default off): responsive display ads\' images; Demand Gen image ads\' animated images and design versions; Demand Gen video ads\' shorter and vertical videos and landing page text'),
  autogenVideo: z.boolean().optional().describe('responsive display and Demand Gen image ads: Google may make videos from the assets (default off)'),
  image: imageRefArg.optional().describe('image ads (type image, Display): the ad itself — ONE image of an uploaded display ad size (300×250, 336×280, 728×90, 160×600, 300×600, 320×50 …), JPG, PNG or GIF, at most 150 KB'),
  html5: z.object({
    zipUrl: z.string().trim().min(1).max(2048).optional().describe('the ZIP\'s https link (a public address): ONE HTML document with <meta name="ad.size" content="width=…,height=…"> of a display ad size, and its CSS, JS, GIF, PNG, JPG, SVG files — at most 40 files, 600 KB'),
    assetId: googleIdArg('an HTML5 ZIP (MEDIA_BUNDLE) asset the account has').optional(),
  }).optional().describe('HTML5 ads (type html5-upload, Display): the ZIP, zipUrl or assetId (Google takes HTML5 ads only from accounts it allowed)'),
})

const targetArg = z.object({
  kind: z.preprocess(lower, z.enum(TARGET_KINDS)).describe(`what it is: ${TARGET_KINDS.join(', ')}`),
  value: z.string().trim().min(1).max(300)
    .describe('a website\'s URL; a keyword\'s text; a YouTube channel or video id (or link); an app ("1-<App Store id>" or "2-<package>"); a demographic\'s value (AGE_RANGE_18_24 …, FEMALE / MALE / UNDETERMINED, PARENT / NOT_A_PARENT / UNDETERMINED, INCOME_RANGE_0_50 …: Display ad groups target or exclude them, Demand Gen only excludes); else the id (topic, app category, user list, interest, custom / combined segment, life event, Audience, location, language)'),
  exclude: z.boolean().optional().describe('true = never show there / to them'),
  bidModifier: z.coerce.number().min(0.1).max(10).nullable().optional()
    .describe('Display ad groups, a targeted item (audience, demographic, placement, topic): its bid adjustment, 0.1–10 (1.2 = +20 %, 0.5 = −50 %; 1 or null = none). Naming an item the ad group already targets with another value changes it in place'),
})
const targetsArg = (what: string) => z.array(targetArg).max(250).optional().describe(what)

const channelsArg = z.object({
  strategy: z.preprocess(upper, z.enum(DG_STRATEGIES)).optional().describe('ALL_CHANNELS (Google\'s default) or ALL_OWNED_AND_OPERATED_CHANNELS (YouTube, Discover, Gmail, Maps — no Display Network)'),
  selected: z.array(z.preprocess(upper, z.enum(DG_CHANNELS))).max(7).optional().describe(`the channels one by one: ${DG_CHANNELS.join(', ')}`),
}).refine((c) => !!c.strategy !== !!c.selected, 'give strategy or selected, one of them')
  .describe('Demand Gen: where the ads may show')
const channelsOf = (c: unknown): ChannelControls | undefined => {
  const v = c as { strategy?: string; selected?: string[] } | undefined
  if (!v) return undefined
  return v.strategy ? { strategy: v.strategy } as ChannelControls : { selected: v.selected ?? [] } as ChannelControls
}

const adGroupArg = z.object({
  name: z.string().trim().min(1).max(255).describe('the ad group\'s name (unique in the campaign)'),
  channels: channelsArg.optional(),
  optimizedTargeting: z.boolean().optional().describe('Demand Gen and Display: Google\'s optimized targeting (default OFF; ON reaches people beyond the targeting)'),
  defaultBidCents: googleCentsArg('Display with Manual CPC or Manual CPM: the ad group\'s bid').optional(),
  targetCpaCents: googleCentsArg('the ad group\'s own target CPA (Target CPA / Maximize conversions campaigns; App: engagement campaigns only)').optional(),
  targeting: targetsArg('who and where: Display placements, topics, keywords, YouTube channels / videos, apps, app categories and audience segments (each kind narrows; exclude: true never shows there); Demand Gen an Audience OR audience segments, locations, languages; both: demographics excluded; App engagement a user list, App installs an Audience as a signal'),
  ads: z.array(newAdArg).max(20).optional().describe('the ad group\'s ads'),
})
const toAdGroup = (g: Record<string, unknown>): TypedAdGroupRequest => ({ ...(g as unknown as TypedAdGroupRequest), channels: channelsOf(g.channels) ?? null })

const biddingArg = (kinds: readonly string[]) => z.object({
  strategy: z.preprocess(upper, z.enum(TYPED_STRATEGIES)).describe(`how bids are set: ${kinds.join(', ')}`),
  maxCpcCents: googleCentsArg('MAXIMIZE_CLICKS: the max CPC ceiling').optional(),
  targetCpcCents: googleCentsArg('TARGET_CPC: the target cost per click').optional(),
  targetCpaCents: googleCentsArg('TARGET_CPA (required) or MAXIMIZE_CONVERSIONS: the target cost per conversion').optional(),
  targetRoas: z.coerce.number().min(0.01).max(1000).optional().describe('TARGET_ROAS (required) or MAXIMIZE_CONVERSION_VALUE: the target ROAS as a ratio (3 = 300 %)'),
  portfolioId: googleIdArg('PORTFOLIO (Display): the portfolio bid strategy').optional(),
}).describe('how bids are set')

const locationArg = z.object({
  id: googleIdArg('the location (a geo target id; google-ads-live view lookup lookup locations finds it)'),
  exclude: z.boolean().optional().describe('true = excluded location'),
})
const createCommon = {
  accountId: googleAccountArg,
  name: z.string().trim().min(1).max(255).describe('the campaign name (unique in the account)'),
  startDate: dayArg('first day').optional(),
  endDate: dayArg('last day').optional(),
  locations: z.array(locationArg).max(100).optional().describe('targeted and excluded locations (none = every country)'),
  languages: z.array(googleIdArg('a language (google-ads-live view lookup lookup languages finds it)')).max(50).optional().describe('languages (none = all)'),
  euPoliticalAds: z.boolean().optional().describe('true only if the campaign holds EU political advertising (default false: it does not)'),
  why: googleWhyArg,
}
const contentArg = z.array(z.string().trim().min(1).max(60)).max(25).optional()
  .describe('content labels the ads never show next to (Google\'s ContentLabelType: SEXUALLY_SUGGESTIVE, TRAGEDY, PROFANITY, BELOW_THE_FOLD, …)')
const INT32_MAX = 2_147_483_647
const frequencyCapsArg = z.array(z.object({
  // Google's own bounds: FrequencyCapEntry.cap and FrequencyCapKey.time_length are int32 (a cap of at least 1:
  // MAX_IMPRESSIONS_NOT_IN_RANGE); anything a live campaign holds can be given back by an undo.
  events: z.coerce.number().int().min(1).max(INT32_MAX).describe('at most this many impressions (or video views) for one person'),
  timeUnit: z.preprocess(upper, z.enum(FREQUENCY_UNITS)).describe('per DAY, WEEK or MONTH'),
  timeLength: z.coerce.number().int().min(1).max(INT32_MAX).optional().describe('how many of that unit (default 1)'),
  level: z.preprocess(upper, z.enum(FREQUENCY_LEVELS)).optional().describe('counted per CAMPAIGN (default), AD_GROUP or AD_GROUP_AD (each ad)'),
  eventType: z.preprocess(upper, z.enum(FREQUENCY_EVENTS)).optional().describe('IMPRESSION (default; a Display campaign caps impressions only) or VIDEO_VIEW'),
})).max(10).describe('frequency caps: how often one person may see the ads (Display and Demand Gen; one cap per level, unit and event)')

const createRequest = (kind: TypedKind, a: Record<string, unknown>): TypedCampaignCreateRequest => ({
  kind,
  name: String(a.name ?? ''),
  dailyBudgetCents: (a.dailyBudgetCents as number | undefined) ?? null,
  totalBudgetCents: (a.totalBudgetCents as number | undefined) ?? null,
  budgetId: (a.budgetId as string | undefined) ?? null,
  bidding: (a.bidding as TypedCampaignCreateRequest['bidding']) ?? null,
  startDate: (a.startDate as string | undefined) ?? null,
  endDate: (a.endDate as string | undefined) ?? null,
  locations: (a.locations as TypedCampaignCreateRequest['locations']) ?? null,
  languages: (a.languages as string[] | undefined) ?? null,
  excludedContent: (a.excludedContent as string[] | undefined) ?? null,
  euPoliticalAds: a.euPoliticalAds === true,
  merchant: (a.merchant as TypedCampaignCreateRequest['merchant']) ?? null,
  app: (a.app as TypedCampaignCreateRequest['app']) ?? null,
  frequencyCaps: (a.frequencyCaps as TypedCampaignCreateRequest['frequencyCaps']) ?? null,
  adGroups: ((a.adGroups as Array<Record<string, unknown>> | undefined) ?? []).map(toAdGroup),
})

const buildCreate = (kind: TypedKind, args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const r = createRequest(kind, args)
  const campaigns = await liveCampaigns(account.target)
  const shared = r.budgetId ? (await liveBudgets(account.target, campaigns)).find((b) => b.budgetId === r.budgetId) : undefined
  const names = await targetNames(account.target, r.adGroups.flatMap((g) => g.targeting ?? []))
  const media = await mediaFor(account.target, mediaNeeds(r.adGroups.flatMap((g) => g.ads ?? [])))
  return typedCreateDraft(customerResource(account.target), account.currency, r, {
    campaignNames: campaigns.map((c) => c.name),
    sharedBudget: shared ? { budgetId: shared.budgetId, name: shared.name, amountCents: shared.amountCents, shared: shared.shared } : null,
    names,
    media,
  })
}

/** Undo of a create: the campaign it made is removed (with the budget of its own); the assets it made stay, unused. */
const createUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as TypedCreateRecord & Stamped
    const account = await recordAccount(after)
    if (!account || !after.campaignId) return null
    const c = (await liveCampaigns(account.target)).find((x) => x.campaignId === after.campaignId)
    return c ? { ...after, name: c.name } : null
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as TypedCreateRecord & Stamped
    if (!after.campaignId) return { refusal: 'This change does not record the campaign it made.' }
    return {
      tool: 'remove-google-ads-items',
      args: {
        ...accountArgOf(after),
        items: [{ kind: 'campaign', id: after.campaignId }, ...(after.ownBudgetId ? [{ kind: 'budget', id: after.ownBudgetId }] : [])],
        confirmRemove: true,
        why: `undo of an earlier ${KIND_WORD[after.kind] ?? ''} campaign create (the images and videos it made stay in the account, unused)`,
      },
    }
  },
}

const runCreate = (kind: TypedKind) => async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => libraryRefusal(args, ctx) ?? runGoogleChange(args, ctx, buildCreate(kind, args), (draft, responses) => {
  const after = typedCreateRecordAfterRun(draft.after as TypedCreateRecord, responses)
  return {
    data: {
      campaignId: after.campaignId, status: 'PAUSED', ...(after.ownBudgetId ? { budgetId: after.ownBudgetId } : {}),
      adGroups: after.adGroups.map(({ name, adGroupId }) => ({ name, adGroupId })), assets: after.assets,
      review: 'Google reviews the new ads and images now; google-ads-live and google-ad-details show their status. Nothing spends until a person enables the campaign.',
    },
    before: { campaignId: null },
    after,
  }
})
const previewCreate = (kind: TypedKind) => async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => libraryRefusal(args, ctx) ?? googleChangePreview(args, ctx, buildCreate(kind, args))

const CREATE_TAIL = ' It is ALWAYS made PAUSED: enabling it is set-google-status, the person\'s decision (SPENDS MONEY). Google acting on its '
  + 'own (optimized targeting, image enhancements, generated videos) is OFF unless asked. Images come from an https link, the '
  + 'Nexus image library or an existing asset (shape and size checked per use); YouTube videos by id or link (the account\'s '
  + 'asset of that video is used again). Every rule Nexus knows is checked before the preview, all problems listed; Google\'s '
  + 'check judges the rest. Undo removes the campaign (Google never removes an asset: new ones stay, unused).'

// ── create-google-demand-gen-campaign ───────────────────────────────────────────────────────────────────────────

const createDemandGen: AgentTool = {
  ...common,
  name: 'create-google-demand-gen-campaign',
  title: 'Make a Google Demand Gen campaign',
  reversibility: 'full',
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, ADSPEND],
  restrictedFields: TYPED_MONEY,
  input: z.object({
    ...createCommon,
    dailyBudgetCents: googleCentsArg('its own daily budget (Demand Gen cannot use a shared budget)').optional(),
    totalBudgetCents: googleCentsArg('or a budget for the whole campaign (needs startDate and endDate)').optional(),
    bidding: biddingArg(['MAXIMIZE_CLICKS', 'TARGET_CPC', 'MAXIMIZE_CONVERSIONS', 'TARGET_CPA', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_ROAS'])
      .describe('how bids are set: MAXIMIZE_CLICKS, TARGET_CPC, MAXIMIZE_CONVERSIONS, TARGET_CPA, MAXIMIZE_CONVERSION_VALUE or TARGET_ROAS'),
    excludedContent: contentArg,
    frequencyCaps: frequencyCapsArg.optional(),
    merchant: z.object({
      merchantId: googleIdArg('the Merchant Center account (linked to the Google Ads account)'),
      feedLabel: z.string().trim().min(1).max(20).optional().describe('the feed label of the products'),
    }).optional().describe('a product feed for product ads (each ad group then holds all products of the feed)'),
    adGroups: z.array(adGroupArg).min(1).max(20).describe('the ad groups with their channels, targeting and ads (multi-asset, carousel, video, product)'),
  }),
  description:
    'Make a Google Ads Demand Gen campaign (YouTube, Discover, Gmail, Maps, Display Network) in the business\'s chosen '
    + 'account, in ONE request: its own budget (daily, or a total for the campaign with start and end), bidding (Maximize '
    + 'clicks, Target CPC, Maximize conversions, Target CPA, Maximize conversion value, Target ROAS), dates, locations and '
    + 'languages (set on every ad group, as Demand Gen holds them), content exclusions, frequency caps, an optional Merchant Center feed, and '
    + 'ad groups with channel controls (all channels, Google\'s own, or picked one by one), audiences (an Audience, or '
    + 'audience segments: user lists, interests, custom, combined, life events), extra locations and languages, and ads: '
    + 'image (multi-asset), carousel (2–10 cards on existing image assets), video (YouTube) and product ads (Google\'s animated '
    + 'images, design versions, generated, shorter and vertical videos and landing page text OFF unless asked).' + CREATE_TAIL + GOOGLE_CHANGE_RULES,
  undo: createUndo,
  handler: previewCreate('DEMAND_GEN'),
  execute: runCreate('DEMAND_GEN'),
}

// ── create-google-display-campaign ──────────────────────────────────────────────────────────────────────────────

const createDisplay: AgentTool = {
  ...common,
  name: 'create-google-display-campaign',
  title: 'Make a Google Display campaign',
  reversibility: 'full',
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, ADSPEND],
  restrictedFields: TYPED_MONEY,
  input: z.object({
    ...createCommon,
    dailyBudgetCents: googleCentsArg('a new daily budget of its own').optional(),
    budgetId: googleIdArg('or an existing SHARED budget (set-google-budget makes one)').optional(),
    bidding: biddingArg(['MANUAL_CPC', 'MANUAL_CPM', 'MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS', 'TARGET_CPA', 'MAXIMIZE_CONVERSION_VALUE', 'TARGET_ROAS', 'PORTFOLIO']).optional()
      .describe('how bids are set (default MANUAL_CPC): MANUAL_CPC, MANUAL_CPM, MAXIMIZE_CLICKS, MAXIMIZE_CONVERSIONS, TARGET_CPA, MAXIMIZE_CONVERSION_VALUE, TARGET_ROAS or PORTFOLIO'),
    excludedContent: contentArg,
    frequencyCaps: frequencyCapsArg.optional(),
    adGroups: z.array(adGroupArg).min(1).max(20).describe('the ad groups with their bids, targeting and ads (responsive display, image, HTML5)'),
  }),
  description:
    'Make a Google Ads Display campaign (the Google Display Network) in the business\'s chosen account, in ONE request: '
    + 'its budget (its own daily one, or a shared budgetId), bidding (Manual CPC by default; Manual CPM, Maximize clicks, '
    + 'Maximize conversions, Target CPA, Maximize conversion value, Target ROAS, or a portfolio strategy), dates, locations '
    + '(presence only) and languages, content exclusions, frequency caps (impressions per day, week or month, per campaign, '
    + 'ad group or ad), and ad groups with their bid (Manual CPC / CPM), targeting — '
    + 'websites, topics, keywords, YouTube channels and videos, apps, app categories, audience segments (user lists, '
    + 'interests, custom, combined, life events) and demographics (age, gender, parental status, household income), each '
    + 'kind narrowing who sees the ads, with optional bid adjustments, and exclusions of the same kinds — '
    + 'and ads: responsive display ads (landscape and square images, logos, 1–5 headlines, a long headline, 1–5 descriptions, '
    + 'business name, optional videos, colours and format), image ads (one image of a display ad size, at most 150 KB) and '
    + 'HTML5 ads (a ZIP from an https link, at most 600 KB; Google takes them only from accounts it allowed).' + CREATE_TAIL + GOOGLE_CHANGE_RULES,
  undo: createUndo,
  handler: previewCreate('DISPLAY'),
  execute: runCreate('DISPLAY'),
}

// ── create-google-app-campaign ──────────────────────────────────────────────────────────────────────────────────

const createApp: AgentTool = {
  ...common,
  name: 'create-google-app-campaign',
  title: 'Make a Google App campaign',
  reversibility: 'full',
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, ADSPEND],
  restrictedFields: TYPED_MONEY,
  input: z.object({
    ...createCommon,
    dailyBudgetCents: googleCentsArg('its own daily budget (an App campaign cannot use a shared budget)'),
    app: z.object({
      appId: z.string().trim().min(1).max(200).describe('the app: its Google Play package name (com.example.app) or its App Store id (digits)'),
      appStore: z.preprocess(upper, z.enum(APP_STORES)).describe('GOOGLE_APP_STORE or APPLE_APP_STORE'),
      goal: z.preprocess(upper, z.enum(APP_GOALS)).describe(`what Google optimizes for: ${APP_GOALS.join(', ')}`),
      engagement: z.boolean().optional().describe('true: an engagement campaign for people who HAVE the app (goal OPTIMIZE_IN_APP_CONVERSIONS_TARGET_CONVERSION_COST; each ad group needs a user list)'),
      targetCpaCents: googleCentsArg('the target cost per install or in-app action (the TARGET_COST goals and pre-registration)').optional(),
      targetRoas: z.coerce.number().min(0.01).max(1000).optional().describe('OPTIMIZE_RETURN_ON_ADVERTISING_SPEND: the target ROAS as a ratio (3 = 300 %)'),
      conversionActionIds: z.array(googleIdArg('a conversion action of the account')).max(20).optional()
        .describe('the in-app conversion actions to optimize for (required for in-app action and value goals and engagement)'),
    }).describe('the app and the goal; the bidding follows the goal (Google\'s table)'),
    adGroups: z.array(adGroupArg).min(1).max(20).describe('the ad groups and their app ads (headlines, descriptions, images, videos)'),
  }),
  description:
    'Make a Google Ads App campaign in the business\'s chosen account, in ONE request: the app (Google Play or App Store) '
    + 'and its goal — installs (with or without a target cost per install), installs likely to act in the app, in-app '
    + 'actions, in-app value (with or without a target ROAS), an engagement campaign for people who have the app, or '
    + 'pre-registration on Google Play — with the bidding Google ties to that goal, the conversion actions to optimize '
    + 'for, its own daily budget, dates, locations and languages, and ad groups (engagement: a user list; installs: an '
    + 'Audience as a signal) with app ads (headlines, descriptions, images, YouTube videos). Google picks where App ads show '
    + '(Search, Play, YouTube, Display, AdMob). Google\'s API cannot make an "App Campaign Legacy (installs)" campaign.'
    + CREATE_TAIL + GOOGLE_CHANGE_RULES,
  undo: createUndo,
  handler: previewCreate('APP'),
  execute: runCreate('APP'),
}

// ── add-google-campaign-type-ads ────────────────────────────────────────────────────────────────────────────────

const addRequest = (a: Record<string, unknown>): TypedAddRequest => ({
  campaignId: String(a.campaignId ?? ''),
  adGroups: ((a.adGroups as Array<Record<string, unknown>> | undefined) ?? []).map(toAdGroup),
  addAds: (a.addAds as TypedAddRequest['addAds']) ?? [],
  enable: a.enable === true,
})

const buildAdd = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const r = addRequest(args)
  const campaign = await liveTypedCampaign(account.target, r.campaignId)
  if (!campaign) return typedAddDraft(customerResource(account.target), account.currency, r, { campaign: null, adGroups: [], names: {}, media: { images: {}, assets: [], youtube: [] } })
  const adGroups = await liveTypedAdGroups(account.target, r.campaignId, campaign.type)
  // Demand Gen: the locations and languages of its ad groups (a new ad group without its own takes those they share).
  const criteria = campaign.type === 'DEMAND_GEN' && r.adGroups?.length ? await liveTypedCriteria(account.target, r.campaignId) : []
  const names = await targetNames(account.target, (r.adGroups ?? []).flatMap((g) => g.targeting ?? []))
  const media = await mediaFor(account.target, mediaNeeds([...(r.adGroups ?? []).flatMap((g) => g.ads ?? []), ...(r.addAds ?? []).flatMap((x) => x.ads)]))
  return typedAddDraft(customerResource(account.target), account.currency, r, { campaign, adGroups, criteria, names, media })
}

const addUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as TypedAddRecord & Stamped
    const account = await recordAccount(after)
    if (!account || !after.campaignId) return null
    const campaign = await liveTypedCampaign(account.target, after.campaignId)
    const groups = new Set(campaign ? (await liveTypedAdGroups(account.target, after.campaignId, campaign.type)).map((g) => g.adGroupId) : [])
    const adIds = (after.ads ?? []).filter((a) => a.adId).map((a) => `${a.adGroupId}~${a.adId}`)
    const ads = new Set(adIds.length ? (await liveTypedAds(account.target, adIds)).map((a) => a.id) : [])
    return {
      ...after,
      accountId: account.accountId,
      customerId: account.customerId,
      // An id Google never answered for is passed through as it is: request() then says why it cannot undo.
      adGroups: (after.adGroups ?? []).filter((g) => !g.adGroupId || groups.has(g.adGroupId)),
      ads: (after.ads ?? []).filter((a) => !a.adId || ads.has(`${a.adGroupId}~${a.adId}`)),
    }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as TypedAddRecord & Stamped
    const groups = after.adGroups ?? []
    const ads = after.ads ?? []
    if (groups.some((g) => !g.adGroupId) || ads.some((a) => !a.adId)) return { refusal: 'This change does not record the ids Google gave what it made: remove them with remove-google-ads-items.' }
    if (!groups.length && !ads.length) return { refusal: 'This change made nothing that is still there.' }
    return {
      tool: 'remove-google-ads-items',
      args: {
        ...accountArgOf(after),
        items: [...groups.map((g) => ({ kind: 'ad-group', id: g.adGroupId! })), ...ads.map((a) => ({ kind: 'ad', id: `${a.adGroupId}~${a.adId}` }))],
        confirmRemove: true,
        why: 'undo of ad groups and ads made earlier (the images and videos they used stay in the account, unused)',
      },
    }
  },
}

const addCampaignTypeAds: AgentTool = {
  ...common,
  name: 'add-google-campaign-type-ads',
  title: 'Add Demand Gen, Display or App ads',
  reversibility: 'full',
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: TYPED_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the Demand Gen, Display or App campaign'),
    adGroups: z.array(adGroupArg).max(20).optional().describe('new ad groups with their targeting and ads'),
    addAds: z.array(z.object({
      adGroupId: googleIdArg('an ad group of this campaign'),
      ads: z.array(newAdArg).min(1).max(20).describe('its new ads'),
    })).max(20).optional().describe('new ads in existing ad groups'),
    enable: z.boolean().optional().describe('true: what is new serves at once in an ENABLED campaign (SPENDS MONEY); left out: made PAUSED there'),
    why: googleWhyArg,
  }),
  description:
    'Add new ad groups (with channel controls, bids, targeting and ads) and new ads in existing ad groups to ONE Demand Gen, '
    + 'Display or App campaign of the business\'s chosen account, in one request — the same ad groups and ads the create '
    + 'tools make (Demand Gen image, carousel, video and product ads; responsive display, image and HTML5 ads; app ads), with '
    + 'their new images, ZIPs and YouTube videos. A new Demand Gen ad group that names no location takes the locations and languages the '
    + 'campaign\'s ad groups share (refused when they differ: name its locations). An App install ad group\'s Audience is a '
    + 'signal for Google. In an ENABLED campaign, new ad groups and new ads in enabled ad groups are made PAUSED '
    + 'unless enable: true (SPENDS MONEY). A Video campaign cannot be added to through Google\'s API. Undo removes what it '
    + 'made (the new assets stay, unused).' + GOOGLE_CHANGE_RULES,
  undo: addUndo,
  handler: async (args, ctx) => libraryRefusal(args, ctx) ?? googleChangePreview(args, ctx, buildAdd(args)),
  execute: async (args, ctx) => libraryRefusal(args, ctx) ?? runGoogleChange(args, ctx, buildAdd(args), (draft, responses) => {
    const after = typedAddRecordAfterRun(draft.after as TypedAddRecord, responses)
    return {
      data: { adGroups: after.adGroups.map(({ name, adGroupId, status }) => ({ name, adGroupId, status })), ads: after.ads.map(({ adGroupId, adId }) => ({ adGroupId, adId })), assets: after.assets },
      before: draft.before,
      after,
    }
  }),
}

// ── set-google-campaign-type ────────────────────────────────────────────────────────────────────────────────────

const settingsRequest = (a: Record<string, unknown>): TypedSettingsRequest => ({
  campaignId: String(a.campaignId ?? ''),
  ...(a.name !== undefined ? { name: a.name as string } : {}),
  ...(a.startDate !== undefined ? { startDate: a.startDate as string } : {}),
  ...(a.endDate !== undefined ? { endDate: a.endDate as string } : {}),
  ...(a.bidding !== undefined ? { bidding: a.bidding as TypedSettingsRequest['bidding'] } : {}),
  ...(a.budgetCents !== undefined ? { budgetCents: a.budgetCents as number } : {}),
  ...(a.frequencyCaps !== undefined ? { frequencyCaps: a.frequencyCaps as TypedSettingsRequest['frequencyCaps'] } : {}),
  addCampaignTargeting: (a.addCampaignTargeting as TargetItem[] | undefined) ?? [],
  removeCampaignTargeting: (a.removeCampaignTargeting as TargetItem[] | undefined) ?? [],
  adGroups: ((a.adGroups as Array<Record<string, unknown>> | undefined) ?? []).map((g) => ({
    adGroupId: String(g.adGroupId),
    ...(g.name !== undefined ? { name: g.name as string } : {}),
    ...(g.channels !== undefined ? { channels: channelsOf(g.channels) } : {}),
    ...(g.optimizedTargeting !== undefined ? { optimizedTargeting: g.optimizedTargeting as boolean } : {}),
    ...(g.defaultBidCents !== undefined ? { defaultBidCents: g.defaultBidCents as number } : {}),
    ...(g.targetCpaCents !== undefined ? { targetCpaCents: g.targetCpaCents as number } : {}),
    addTargeting: (g.addTargeting as TargetItem[] | undefined) ?? [],
    removeTargeting: (g.removeTargeting as TargetItem[] | undefined) ?? [],
  })),
})

/** A campaign's own locations and languages (live-campaigns.ts liveCampaignCriteria). */
async function campaignPlaces(target: GoogleAdsTarget, campaignId: string): Promise<CampaignPlace[]> {
  return (await liveCampaignCriteria(target, campaignId)).flatMap((c) => {
    const value = c.type === 'LOCATION' ? idOf(c.location) : c.type === 'LANGUAGE' ? idOf(c.language) : null
    return value ? [{ criterionId: c.criterionId, kind: c.type === 'LOCATION' ? 'location' as const : 'language' as const, value, exclude: c.negative }] : []
  })
}

async function settingsLive(target: GoogleAdsTarget, campaignId: string, ask: { groups: boolean; places: boolean; adds: TargetItem[]; names: boolean }): Promise<TypedSettingsLive> {
  const campaign = await liveTypedCampaign(target, campaignId)
  if (!campaign) return { campaign: null, adGroups: [], criteria: [], campaignNames: [], names: {} }
  return {
    campaign,
    adGroups: ask.groups ? await liveTypedAdGroups(target, campaignId, campaign.type) : [],
    criteria: ask.groups ? await liveTypedCriteria(target, campaignId) : [],
    ...(ask.places ? { campaignCriteria: await campaignPlaces(target, campaignId) } : {}),
    campaignNames: ask.names ? (await liveCampaigns(target)).map((c) => c.name) : [],
    names: ask.adds.length ? await targetNames(target, ask.adds) : {},
  }
}

const buildSettings = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const r = settingsRequest(args)
  const live = await settingsLive(account.target, r.campaignId, {
    groups: !!r.adGroups?.length, places: !!(r.addCampaignTargeting?.length || r.removeCampaignTargeting?.length),
    adds: (r.adGroups ?? []).flatMap((g) => g.addTargeting ?? []), names: r.name !== undefined,
  })
  return typedSettingsDraft(customerResource(account.target), account.currency, r, live)
}

const settingsUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as TypedSettingsRecord & Stamped
    const account = await recordAccount(after)
    if (!account || !after.campaignId) return null
    const live = await settingsLive(account.target, after.campaignId, { groups: !!after.adGroups?.length, places: !!(after.campaignAdded || after.campaignRemoved), adds: [], names: false })
    const now = typedSettingsNow(after, live)
    return now ? { ...now, accountId: account.accountId, customerId: account.customerId } : null
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as TypedSettingsRecord & Stamped
    const after = (change.after ?? {}) as TypedSettingsRecord & Stamped
    if (!after.campaignId) return { refusal: 'This change does not record the campaign it changed.' }
    const groups = (after.adGroups ?? []).map((a) => {
      const b = (before.adGroups ?? []).find((x) => x.adGroupId === a.adGroupId)
      return {
        adGroupId: a.adGroupId,
        ...(b?.settings ?? {}),
        // Taken away: added back (with the bid adjustment it had); an adjustment changed in place: set back.
        ...(a.removed.length || a.rebid?.length ? { addTargeting: [...a.removed, ...(a.rebid ?? []).map((r) => ({ ...r.item, bidModifier: r.from ?? 1 }))] } : {}),
        ...(a.added.length ? { removeTargeting: a.added } : {}),
      }
    })
    const places = {
      ...(after.campaignRemoved?.length ? { addCampaignTargeting: after.campaignRemoved } : {}),
      ...(after.campaignAdded?.length ? { removeCampaignTargeting: after.campaignAdded } : {}),
    }
    // A setting that had no value before (no start date, no ad group bid, a budget not of its own …) cannot be put back
    // as "none": it stays as the change set it, and the undo says so.
    const unset = [
      ...Object.keys(after.campaign ?? {}).filter((k) => !(k in (before.campaign ?? {}))).map((k) => `the campaign's ${k}`),
      ...(after.adGroups ?? []).flatMap((a) => Object.keys(a.settings ?? {}).filter((k) => !(k in ((before.adGroups ?? []).find((x) => x.adGroupId === a.adGroupId)?.settings ?? {}))).map((k) => `ad group ${a.adGroupId}'s ${k}`)),
    ]
    const groupsLeft = groups.filter((g) => Object.keys(g).length > 1)
    if (!Object.keys(before.campaign ?? {}).length && !groupsLeft.length && !Object.keys(places).length) {
      return { refusal: `This change replaced nothing that can be put back${unset.length ? ` (${unset.join(', ')} had no value before: set it with this tool)` : ''}.` }
    }
    return {
      tool: 'set-google-campaign-type',
      args: {
        ...accountArgOf(after), campaignId: after.campaignId, ...(before.campaign ?? {}), ...places, ...(groupsLeft.length ? { adGroups: groupsLeft } : {}),
        why: why300(`undo of an earlier campaign change: settings and targeting back as they were${unset.length ? ` (not put back, they had no value before: ${unset.join(', ')})` : ''}`),
      },
    }
  },
}

const setCampaignType: AgentTool = {
  ...common,
  name: 'set-google-campaign-type',
  title: 'Change Demand Gen, Display or App',
  reversibility: 'full',
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, ADSPEND],
  restrictedFields: TYPED_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the Demand Gen, Display or App campaign'),
    name: z.string().trim().min(1).max(255).optional().describe('a new name (unique in the account)'),
    startDate: dayArg('first day').optional(),
    endDate: z.string().trim().regex(/^(\d{4}-\d{2}-\d{2}|none)$/).optional().describe('last day (YYYY-MM-DD), or none (runs on)'),
    bidding: biddingArg([...TYPED_STRATEGIES]).optional()
      .describe('the bidding: Demand Gen and Display may switch strategy (their own lists) or change targets; an App campaign only its target CPA or ROAS'),
    budgetCents: googleCentsArg('a new amount of the campaign\'s OWN budget: its daily amount, or the total of a campaign total budget (a shared budget: set-google-budget)').optional(),
    frequencyCaps: frequencyCapsArg.optional().describe('Display and Demand Gen: the WHOLE list of frequency caps as it should be ([] takes every cap away)'),
    addCampaignTargeting: targetsArg('Display and App: locations (targeted or excluded) and languages to add to the campaign (Demand Gen holds them at its ad groups)'),
    removeCampaignTargeting: targetsArg('Display and App: the campaign\'s locations and languages to take away'),
    adGroups: z.array(z.object({
      adGroupId: googleIdArg('an ad group of this campaign'),
      name: z.string().trim().min(1).max(255).optional().describe('a new name'),
      channels: channelsArg.optional(),
      optimizedTargeting: z.boolean().optional().describe('Demand Gen and Display: optimized targeting on or off (ON reaches beyond the targeting)'),
      defaultBidCents: googleCentsArg('Display with Manual CPC or Manual CPM: the ad group\'s new bid').optional(),
      targetCpaCents: z.coerce.number().int().min(0).max(100_000_000).optional().describe('the ad group\'s own target CPA in cents (0 = none: the campaign\'s applies)'),
      addTargeting: targetsArg('targeting to add (as in the create tools)'),
      removeTargeting: targetsArg('targeting to take away (kind, value and exclude as it is there)'),
    })).max(20).optional().describe('changes of its ad groups'),
    why: googleWhyArg,
  }),
  description:
    'Change ONE Demand Gen, Display or App campaign of the business\'s chosen account and its ad groups, in one request: '
    + 'the campaign\'s name, start and end, bidding (strategy and targets; an App campaign only its target CPA or ROAS) and '
    + 'the amount of its own budget (daily, or the total of a Demand Gen campaign total budget), a Display or Demand Gen '
    + 'campaign\'s frequency caps, a Display or App campaign\'s locations and languages; each ad group\'s name, '
    + 'Demand Gen channel controls, optimized targeting, Manual CPC / CPM bid and own target CPA, and targeting added or '
    + 'taken away (websites, topics, keywords, YouTube, apps, audience segments, Audiences, locations, languages, '
    + 'demographics — targeted on Display, with bid adjustments changed in place — and exclusions). Only what is named '
    + 'changes; the preview shows each from → to. In a serving ad group, anything that '
    + 'widens who sees the ads (another value of a kind it narrows by, the last one of a kind taken away, an exclusion taken '
    + 'away, optimized targeting on, a channel added), a higher bid adjustment, and any higher bid, target or budget, a '
    + 'frequency cap raised or taken away, or a longer run, is SPENDS MONEY. Status: set-google-status. Search and Shopping campaigns: set-google-campaign. A Video campaign cannot be '
    + 'changed through Google\'s API. Undo puts the old settings and targeting back.' + GOOGLE_CHANGE_RULES,
  undo: settingsUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildSettings(args)),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildSettings(args), (draft) => ({ data: { campaignId: args.campaignId }, before: draft.before, after: draft.after })),
}

// ── edit-google-campaign-type-ads ───────────────────────────────────────────────────────────────────────────────

const editRequest = (a: Record<string, unknown>): TypedEditRequest => ({ ads: (a.ads as TypedEditRequest['ads'] | undefined) ?? [] })

const buildEdit = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const r = editRequest(args)
  const ads = await liveTypedAds(account.target, r.ads.map((a) => a.id))
  const media = await mediaFor(account.target, mediaNeeds(r.ads))
  return typedEditDraft(customerResource(account.target), r, { ads, media })
}

const editUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as TypedEditRecord & Stamped
    const account = await recordAccount(after)
    if (!account || !after.ads?.length) return null
    const now = typedEditNow(after, await liveTypedAds(account.target, after.ads.map((a) => a.id)))
    return { ...now, accountId: account.accountId, customerId: account.customerId }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as TypedEditRecord & Stamped
    const after = (change.after ?? {}) as TypedEditRecord & Stamped
    if (!before.ads?.length) return { refusal: 'This change does not record the ads it edited.' }
    // A final URL or a brand name the ad did not have cannot be taken off again (Google needs them): they stay.
    const kept: string[] = []
    const ads = before.ads.map(({ campaignId: _c, ...fields }) => Object.fromEntries(Object.entries(fields)
      .filter(([k, v]) => { const stays = (k === 'finalUrl' || k === 'brandName') && v === null; if (stays) kept.push(`${fields.id}: ${k === 'finalUrl' ? 'final URL' : 'brand name'}`); return !stays })
      // A text that was empty is cleared again ('' clears an optional text); images and videos by their asset ids.
      .map(([k, v]) => [k, v === null ? '' : v])))
    const left = ads.filter((a) => Object.keys(a).length > 1)
    if (!left.length) return { refusal: `This edit only set what the ads did not have (${kept.join('; ')}): Google needs it, so it cannot be taken off. Change it with this tool instead.` }
    return {
      tool: 'edit-google-campaign-type-ads',
      args: {
        ...accountArgOf(after),
        ads: left,
        why: why300(`undo of an earlier ad edit: texts, URLs, images and videos back as they were${kept.length ? ` (it cannot take off what the ads did not have: ${kept.join('; ')} — those stay)` : ''}`),
      },
    }
  },
}

const editAdArg = z.object({
  id: z.string().trim().regex(/^\d{1,20}~\d{1,20}$/, 'adGroupId~adId').describe('the ad: adGroupId~adId (google-ads-query or google-ad-details shows it)'),
  ...adFields,
  callToActionText: z.string().trim().max(60).optional().describe('the button text (\'\' clears it)'),
  breadcrumb1: z.string().trim().max(60).optional().describe('first part of the shown URL path (\'\' clears it)'),
  breadcrumb2: z.string().trim().max(60).optional().describe('second part of the shown URL path (\'\' clears it)'),
})

const editCampaignTypeAds: AgentTool = {
  ...common,
  name: 'edit-google-campaign-type-ads',
  title: 'Edit Demand Gen, Display, App, video ads',
  reversibility: 'full',
  requires: [F.adsCampaignsManage],
  input: z.object({
    accountId: googleAccountArg,
    ads: z.array(editAdArg).min(1).max(50).describe('the ads to edit and their new fields (only what is named changes; a list replaces the whole list)'),
    why: googleWhyArg,
  }),
  description:
    'Edit ads IN PLACE (the ad keeps its id and its numbers) in the business\'s chosen account: responsive display ads, '
    + 'Demand Gen image, carousel, video and product ads, App ads, and the video responsive ads of Video campaigns (the one '
    + 'change Google\'s API allows in a Video campaign: its headline, long headline, description, call to action, business '
    + 'name, final URL, breadcrumbs, logo and video — one of each). Fields: final URL, headlines, long headlines, '
    + 'descriptions, brand name, call to action, breadcrumbs, images (new from a link or the image library, or existing '
    + 'assets) and YouTube videos; a list replaces the whole list. Google\'s rules per ad type are checked first (counts, '
    + 'lengths, image shapes). Google reviews the edited ad again; an enabled ad Google limits or stops now that could '
    + 'serve more once approved is SPENDS MONEY. Carousel cards cannot be edited (make a new carousel ad). Responsive '
    + 'search ads: edit-google-rsa. Undo puts the old fields back (new assets stay, unused).' + GOOGLE_CHANGE_RULES,
  undo: editUndo,
  handler: async (args, ctx) => libraryRefusal(args, ctx) ?? googleChangePreview(args, ctx, buildEdit(args)),
  execute: async (args, ctx) => libraryRefusal(args, ctx) ?? runGoogleChange(args, ctx, buildEdit(args), (draft, responses) => {
    const after = typedEditRecordAfterRun(draft.after as TypedEditRecord, responses)
    return { data: { ads: after.ads.map((a) => a.id), assets: after.assets ?? [] }, before: draft.before, after }
  }),
}

export const GOOGLE_ADS_CAMPAIGN_TYPES_TOOLS: AgentTool[] = [
  createDemandGen, createDisplay, createApp, addCampaignTypeAds, setCampaignType, editCampaignTypeAds,
]

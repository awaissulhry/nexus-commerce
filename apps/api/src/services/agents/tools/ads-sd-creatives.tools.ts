/**
 * SD creatives (2026-10-20) — the look of a Sponsored Display ad, read and changed by Claude:
 *
 *   ad-creatives      read: the creative of each ad group of an SD campaign (one per ad group) — its type, headline, brand
 *                     logo, custom image(s), video(s) — with Amazon's moderation in words (approved, in review with its
 *                     expected date, rejected with every policy and the part that broke it); or view preview: the HTML
 *                     Amazon renders for the creative (as it is, or as proposed) in one slot size
 *   ad-assets         read: the account's Creative Asset Library (brand logos, images, videos) — the asset ids and
 *                     versions a creative takes, each with its size and which part of a creative it fits
 *   set-ad-creative   change: make an ad group's creative (op create) or change it (op update): headline, brand logo,
 *                     custom image with its two crops, video — or its whole properties (an undo puts them back so)
 *   upload-ad-asset   change: a photo (a Nexus library item or product photo, or an https link) into the library as a
 *                     brand logo or a custom image, for set-ad-creative to use
 *
 * Every read is live at Amazon (sd/sd-creatives.client.ts, sd/ads-assets.client.ts: the channel gateway); sandbox reads
 * nothing. Nothing is stored in Nexus but the ads audit and the change record: Amazon's creative is the record.
 *
 * Like every ad change tool (ads-change-kit.ts): the preview says each part from → to and where it lands (live at Amazon on
 * which profile, or sandbox: the write gate's own answer for a Sponsored Display creative); a refusal is not queued; it
 * runs only as an approved request, as the approver; `execute` re-reads Amazon and refuses when what was approved moved
 * (the creative, its moderation, the ad group's creative type, an asset). Both change tools are a person's decision
 * (alwaysAsk, ask at most). Nothing here changes a bid, a budget or whether an ad serves, so nothing is SPENDS MONEY.
 * Undo: a changed creative is put back by set-ad-creative with its old properties; Amazon has no delete for a creative nor
 * for an asset, so a new creative and an upload are not undone.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import imageSize from 'image-size'
import { FEATURES as F } from '@nexus/shared/permissions'
import { adProductLabel, adProductOf, SPONSORED_DISPLAY } from '@nexus/shared/ads-ad-product'
import prisma from '../../../db.js'
import { adsMode, type ClientContext } from '../../advertising/ads-api-client.js'
import { adsClientContextFor } from '../../advertising/ads-profile-resolver.js'
import { checkAdsWriteGate } from '../../advertising/ads-write-gate.js'
import {
  listSdAdGroupCreativeTypes, listSdCreativeModerations, listSdCreatives, previewSdCreative, sdAmazonErrorWords, sdCreativeCreateRequest,
  sdCreativeUpdateRequest, sdModerationLanguageFor, sendableSdProperties, sendSdCreativeWrite, SD_MODERATION_LANGUAGES, SD_PREVIEW_SIZES,
  type SdCreative, type SdCreativeModeration, type SdCreativeProperties, type SdCreativeType, type SdCrop, type SdImage,
} from '../../advertising/sd/sd-creatives.client.js'
import { ADS_IMAGE_SUB_TYPES, getAdsAsset, searchAdsAssets, uploadAdsImageAsset, type AdsAsset } from '../../advertising/sd/ads-assets.client.js'
import {
  SD_CUSTOM_IMAGE_SPEC, SD_LOGO_SPEC, SD_RECT_CROP, SD_SQUARE_CROP, sdAssetUseProblem, sdAssetUses, sdDefaultCrop, sdImageAssetProblem, sdModerationWords,
  sdPropertiesProblem, sdPropertiesWords, sdViolationWords, type SdAssetUse,
} from '../../advertising/sd/sd-creative-rules.js'
import { sdCreativeGroupById, sdCreativeGroups, type SdCreativeGroup } from '../../advertising/sd/sd-creative-groups.service.js'
import { fetchPhoto } from '../../images/photo-from-url.service.js'
import { checkLiveReach, liveReachOf, type LiveReach } from './ads-tool-guards.js'
import { approvedRun, canonical, notRun, reachNote, reachRefusal, recheck, storedReach, type StoredReach } from './ads-change-kit.js'
import { isRuleApprovedRun, type AgentTool, type ToolContext, type ToolResult, type ToolUndo } from '../tool-types.js'

/** The preview keys the approval gate compares (approval-inbox MATERIAL_PREVIEW_FIELDS), and execute again. */
const CREATIVE_MATERIAL = ['op', 'basis', 'send', 'reach'] as const
const UPLOAD_MATERIAL = ['basis', 'send', 'reach'] as const

/** The most ad groups ad-creatives reads in one call (a campaign's). */
const MAX_GROUPS = 100
/** A preview's HTML is cut here (a slot's HTML is far smaller). */
const MAX_HTML = 200_000

const LIVE_NOTE = 'Read live from Amazon; a live read works only in the deployed API (channel logins are sealed there). Nothing here is stored in Nexus.'
const SANDBOX_NOTE = 'Amazon ads are in sandbox on this server: nothing was read from Amazon.'
const NO_SPEND = 'It changes no bid, budget or on/off state: what the ad costs and whether it serves stay as they are.'

const ID = z.string().trim().min(1).max(64)
const ASSET_ID = z.string().trim().min(8).max(200)
const VERSION = z.string().trim().min(1).max(100)
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
const sha = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)

// ── The ad group a creative belongs to ──────────────────────────────────────────────────────────────

/** Why Nexus does not read or change the creative of this ad group's campaign; null when it may. */
function notDisplay(campaign: SdCreativeGroup['campaign']): string | null {
  const product = adProductOf({ adProduct: campaign.adProduct, type: campaign.type == null ? null : String(campaign.type) })
  if (product === SPONSORED_DISPLAY) return null
  return `${campaign.name} is ${product ? `a ${adProductLabel(product)}` : 'not a Sponsored Display'} campaign. Creatives here are Sponsored Display's (an SD ad group's headline, logo, custom image or video); nothing was read or sent.`
}

/** Why this ad group's creative cannot be changed at all; null when it can. */
function groupProblem(group: SdCreativeGroup): string | null {
  const other = notDisplay(group.campaign)
  if (other) return other
  if (String(group.campaign.status) === 'ARCHIVED') return `campaign ${group.campaign.name} is archived: Amazon does not change an archived campaign's ads`
  if (String(group.status) === 'ARCHIVED') return `ad group ${group.name} is archived: Amazon does not change an archived ad group's creative`
  if (!group.externalAdGroupId) return `ad group ${group.name} has no Amazon id in Nexus: it is not at Amazon (yet)`
  return null
}

/** The ad group's creative type: Amazon's, else the one Nexus synced, else Amazon's default (IMAGE). */
const groupType = (amazon: SdCreativeType | null | undefined, group: Pick<SdCreativeGroup, 'creativeType'>): SdCreativeType =>
  amazon ?? (group.creativeType === 'VIDEO' ? 'VIDEO' : 'IMAGE')

/** The Amazon Ads profile of a market, as the write gate resolves it; or why there is none. */
async function contextFor(market: string | null): Promise<ClientContext | { error: string }> {
  const ctx = await adsClientContextFor(market)
  return ctx ?? { error: `No Amazon Ads profile serves ${market ?? 'this campaign\'s market'} in this business, so nothing was read from Amazon.` }
}

const readFailed = (error: unknown) => `Nexus could not read it from Amazon: ${sdAmazonErrorWords(error)}. Nothing was changed.`

// ── Arguments a creative's parts take ───────────────────────────────────────────────────────────────

const cropArg = z.object({
  left: z.number().int().min(0).max(20_000).describe('pixels from the image\'s left edge'),
  top: z.number().int().min(0).max(20_000).describe('pixels from the image\'s top edge'),
  width: z.number().int().min(1).max(20_000).describe('width in pixels'),
  height: z.number().int().min(1).max(20_000).describe('height in pixels'),
})
const amazonImageArg = z.object({ assetId: ASSET_ID, assetVersion: VERSION, croppingCoordinates: cropArg.optional() })
const amazonVideoArg = z.object({ assetId: ASSET_ID, assetVersion: VERSION })
/** Amazon's CreativeProperties, as ad-creatives shows them (the shape an undo puts back). */
const propertiesArg = z.object({
  headline: z.string().max(200).optional(),
  hasTermsAndConditions: z.boolean().optional(),
  brandLogo: amazonImageArg.optional(),
  rectCustomImage: amazonImageArg.optional(),
  squareCustomImage: amazonImageArg.optional(),
  squareImages: z.array(amazonImageArg).max(20).optional(),
  horizontalImages: z.array(amazonImageArg).max(20).optional(),
  verticalImages: z.array(amazonImageArg).max(20).optional(),
  video: amazonVideoArg.optional(),
  squareVideos: z.array(amazonVideoArg).max(5).optional(),
  horizontalVideos: z.array(amazonVideoArg).max(5).optional(),
  verticalVideos: z.array(amazonVideoArg).max(5).optional(),
  backgrounds: z.array(z.object({ color: z.string().trim().max(20) })).max(10).optional(),
})

// ── ad-creatives ────────────────────────────────────────────────────────────────────────────────────

const creativesInput = z.object({
  campaignId: ID.optional().describe('every ad group of this Sponsored Display campaign: its Nexus id (campaignId in ad-campaigns)'),
  adGroupId: ID.optional().describe('only this ad group: its Nexus id (adGroupId in ad-groups); view preview needs it'),
  view: z.preprocess(lower, z.enum(['creatives', 'preview'])).default('creatives')
    .describe('creatives (default): each ad group\'s creative with its moderation; preview: the HTML Amazon renders for one ad group\'s creative'),
  language: z.enum(SD_MODERATION_LANGUAGES).optional()
    .describe('the language of Amazon\'s moderation reasons (default English for the campaign\'s market, e.g. en-IT)'),
  size: z.enum(SD_PREVIEW_SIZES).default('300x250').describe('view preview: the slot, width x height (default 300x250)'),
  mobile: z.boolean().default(false).describe('view preview: as on a phone'),
  asin: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'an ASIN is 10 letters and digits').optional()
    .describe('view preview: the product shown (default: the ad group\'s first product ad)'),
  properties: propertiesArg.optional()
    .describe('view preview: preview these properties instead of the creative at Amazon (the shape set-ad-creative takes), before asking for them'),
})
type CreativesArgs = z.infer<typeof creativesInput>

/** One creative as ad-creatives says it: its parts, the shape set-ad-creative takes back, and its moderation in words. */
function creativeOut(creative: SdCreative, moderation: SdCreativeModeration | undefined) {
  const p = creative.properties
  const status = moderation?.moderationStatus ?? creative.moderationStatus
  const words = sdPropertiesWords(sendableSdProperties(p))
  return {
    creativeId: creative.creativeId,
    creativeType: creative.creativeType,
    headline: p.headline ?? null,
    ...(p.originalHeadline && p.originalHeadline !== p.headline ? { originalHeadline: p.originalHeadline } : {}),
    brandLogo: words.brandLogo,
    customImage: words.customImage,
    video: words.video,
    ...(p.backgrounds?.length ? { backgrounds: p.backgrounds.map((b) => b.color) } : {}),
    moderation: {
      status: status ?? null,
      words: sdModerationWords(status, moderation?.etaForModeration),
      ...(moderation?.etaForModeration ? { expectedBy: moderation.etaForModeration } : {}),
      reasons: (moderation?.policyViolations ?? []).map(sdViolationWords),
    },
    properties: sendableSdProperties(p),
  }
}

async function groupsOf(a: CreativesArgs): Promise<SdCreativeGroup[] | { error: string }> {
  if (!a.campaignId && !a.adGroupId) return { error: 'Name the campaignId (every ad group of an SD campaign) or the adGroupId.' }
  const groups = await sdCreativeGroups({ campaignId: a.campaignId, adGroupId: a.adGroupId }, MAX_GROUPS)
  if (!groups.length) return { error: a.adGroupId ? 'Ad group not found' : 'Campaign not found, or it has no ad groups' }
  const other = notDisplay(groups[0].campaign)
  return other ? { error: other } : groups
}

async function creativesView(a: CreativesArgs, groups: SdCreativeGroup[]): Promise<ToolResult> {
  const campaign = groups[0].campaign
  const language = a.language ?? sdModerationLanguageFor(campaign.marketplace)
  const base = { campaign: { id: campaign.id, name: campaign.name, market: campaign.marketplace }, language }
  if (adsMode() === 'sandbox') return { ok: true, data: { ...base, items: [], note: SANDBOX_NOTE } }
  const ctx = await contextFor(campaign.marketplace)
  if ('error' in ctx) return { ok: false, error: ctx.error }
  const external = groups.map((g) => g.externalAdGroupId).filter((id): id is string => !!id)
  let creatives: SdCreative[], moderations: SdCreativeModeration[], types: Map<string, SdCreativeType | null>
  try {
    creatives = await listSdCreatives(ctx, { externalAdGroupIds: external })
    moderations = creatives.length ? await listSdCreativeModerations(ctx, { externalAdGroupIds: external, language }) : []
    types = await listSdAdGroupCreativeTypes(ctx, external)
  } catch (error) {
    return { ok: false, error: readFailed(error) }
  }
  const moderationOf = new Map(moderations.map((m) => [m.creativeId, m]))
  const items = groups.map((g) => {
    const creative = g.externalAdGroupId ? creatives.find((c) => c.adGroupId === g.externalAdGroupId) : undefined
    return {
      adGroupId: g.id, adGroupName: g.name, externalAdGroupId: g.externalAdGroupId, adGroupStatus: String(g.status),
      creativeType: groupType(g.externalAdGroupId ? types.get(g.externalAdGroupId) : null, g),
      creative: creative ? creativeOut(creative, moderationOf.get(creative.creativeId)) : null,
      ...(creative ? {} : { note: g.externalAdGroupId ? 'No custom creative: Amazon shows its standard ad, built from the advertised product. set-ad-creative op create makes one.' : 'Not at Amazon: Nexus holds no Amazon id for this ad group.' }),
    }
  })
  const said = (status: string) => items.filter((i) => i.creative?.moderation.status === status).length
  return {
    ok: true,
    data: {
      ...base, profileId: ctx.profileId, items,
      counts: { adGroups: items.length, withCreative: items.filter((i) => i.creative).length, approved: said('APPROVED'), inReview: said('PENDING_REVIEW'), rejected: said('REJECTED') },
      note: LIVE_NOTE,
    },
  }
}

/** Amazon's preview HTML, unescaped when Amazon sent it escaped (its guide: "html string that you need to unescape"). */
function htmlOf(raw: string): string {
  if (raw.includes('<') || !raw.includes('&lt;')) return raw
  return raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

async function previewView(a: CreativesArgs, group: SdCreativeGroup): Promise<ToolResult> {
  const problem = groupProblem(group)
  if (problem) return { ok: false, error: problem }
  const asin = a.asin ?? (await prisma.adProductAd.findFirst({ where: { adGroupId: group.id, asin: { not: null }, status: { not: 'ARCHIVED' } }, select: { asin: true }, orderBy: { createdAt: 'asc' } }))?.asin ?? null
  if (!asin) return { ok: false, error: `Ad group ${group.name} has no product ad with an ASIN in Nexus: name the asin the preview shows.` }
  if (adsMode() === 'sandbox') return { ok: true, data: { adGroupId: group.id, html: null, note: SANDBOX_NOTE } }
  const ctx = await contextFor(group.campaign.marketplace)
  if ('error' in ctx) return { ok: false, error: ctx.error }
  try {
    const [current] = a.properties ? [] : await listSdCreatives(ctx, { externalAdGroupIds: [group.externalAdGroupId!] })
    const type = groupType((await listSdAdGroupCreativeTypes(ctx, [group.externalAdGroupId!])).get(group.externalAdGroupId!), group)
    const properties = (a.properties as SdCreativeProperties | undefined) ?? current?.properties ?? {}
    const shown = await previewSdCreative(ctx, { creativeType: type, properties, size: a.size, asin, isMobile: a.mobile, isOnAmazon: true })
    const html = htmlOf(shown?.previewHtml ?? '')
    const [width, height] = a.size.split('x')
    return {
      ok: true,
      data: {
        adGroupId: group.id, adGroupName: group.name, size: a.size, mobile: a.mobile, asin, creativeType: type,
        previewOf: a.properties ? 'the properties given' : current ? `creative ${current.creativeId} as it is at Amazon` : 'Amazon\'s standard ad (the ad group has no custom creative)',
        html: html.slice(0, MAX_HTML), ...(html.length > MAX_HTML ? { truncated: true } : {}),
        note: `Amazon's HTML for a ${width} × ${height} slot: save it as a file and open it in an iframe of that size to see the ad. ${LIVE_NOTE}`,
      },
    }
  } catch (error) {
    return { ok: false, error: readFailed(error) }
  }
}

const adCreatives: AgentTool = {
  name: 'ad-creatives',
  title: 'Display ad creatives',
  category: 'advertising',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  // It reads Amazon live (no change): Claude is told it reaches outside Nexus.
  openWorld: true,
  input: creativesInput,
  description:
    'The creatives of Sponsored Display ad groups, read live from Amazon (one creative per ad group; nothing stored in Nexus). '
    + 'view creatives (default), for campaignId (every ad group) or adGroupId: per ad group its creative type (IMAGE or VIDEO: '
    + 'what its creative may hold) and its creative — creativeId, headline, brand logo, custom image (rectangular and square '
    + 'crops), video, and properties (the exact shape set-ad-creative takes back) — with Amazon\'s moderation in words: approved, '
    + 'in review (with the date Amazon expects to finish; it cannot be changed meanwhile), or rejected with every policy it broke '
    + 'and the headline text, image or video part that broke it. An ad group without one shows Amazon\'s standard ad, built from '
    + 'the product. view preview (adGroupId): the HTML Amazon renders for the creative in one slot size, as it is or for '
    + 'properties given. Read only.',
  async handler(args): Promise<ToolResult> {
    const a = args as CreativesArgs
    if (a.view === 'preview' && !a.adGroupId) return { ok: false, error: 'view preview needs the adGroupId whose creative to render.' }
    const groups = await groupsOf(a)
    if ('error' in groups) return { ok: false, error: groups.error }
    return a.view === 'preview' ? previewView(a, groups[0]) : creativesView(a, groups)
  },
}

// ── ad-assets ───────────────────────────────────────────────────────────────────────────────────────

const KINDS = ['all', 'logo', 'image', 'video'] as const
const assetsInput = z.object({
  market: z.string().trim().toUpperCase().min(2).max(8).describe('the market whose Amazon Ads profile holds the library, e.g. IT (business-overview lists them)'),
  view: z.preprocess(lower, z.enum(['list', 'asset'])).default('list').describe('list (default): the library, newest first; asset: one asset with its versions'),
  kind: z.preprocess(lower, z.enum(KINDS)).default('all').describe('list: logo (brand logos), image (every image), video, or all (default)'),
  search: z.string().trim().min(1).max(100).optional().describe('list: only assets whose name, tags or ASINs match this'),
  assetId: ASSET_ID.optional().describe('view asset: the asset id (amzn1.assetlibrary.asset1.…)'),
  version: VERSION.optional().describe('view asset: one version (default its newest)'),
  limit: z.number().int().min(1).max(100).default(25).describe('list: assets per page (default 25)'),
  cursor: z.string().trim().min(1).max(2000).optional().describe('list: nextCursor of the page before'),
})
type AssetsArgs = z.infer<typeof assetsInput>

/** Which part of a creative this asset can be, by Amazon's file rules (crops are chosen when it is used). */
function fitsOf(asset: AdsAsset): string[] {
  if (asset.assetType === 'VIDEO') return asset.status === 'ACTIVE' ? ['video'] : []
  return [
    ...(sdImageAssetProblem(asset, SD_LOGO_SPEC) ? [] : ['brandLogo']),
    ...(sdImageAssetProblem(asset, SD_CUSTOM_IMAGE_SPEC) ? [] : ['customImage']),
  ]
}

const assetOut = (asset: AdsAsset) => ({
  assetId: asset.assetId, version: asset.version, name: asset.name, type: asset.assetType, subTypes: asset.subTypes, status: asset.status,
  size: asset.width != null && asset.height != null ? `${asset.width} × ${asset.height}` : null, bytes: asset.bytes, contentType: asset.contentType,
  createdAt: asset.createdAt, tags: asset.tags, url: asset.url, fits: fitsOf(asset),
  ...(asset.failedSpecChecks.length ? { failedSpecChecks: asset.failedSpecChecks } : {}),
  ...(asset.moderation ? { moderation: asset.moderation } : {}),
})

const adAssets: AgentTool = {
  name: 'ad-assets',
  title: 'Amazon ad assets',
  category: 'advertising',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  openWorld: true,
  input: assetsInput,
  description:
    'The Amazon Ads creative asset library of one market\'s advertising profile, read live from Amazon: the brand logos, images '
    + 'and videos a Sponsored Display creative is made from. view list (default; kind logo, image, video or all; search by name, '
    + 'tag or ASIN; newest first; nextCursor): per asset its assetId and version (what set-ad-creative takes), name, type and '
    + 'sub-types, status (ACTIVE, PROCESSING, ARCHIVED), size in pixels, bytes and file type, and fits: which part of a creative '
    + 'it can be by Amazon\'s rules (brandLogo: at least 600 × 100, at most 1 MB; customImage: at least 1200 × 628, at most 5 MB; '
    + 'video). view asset (assetId): one asset with every version. upload-ad-asset adds one. Read only.',
  async handler(args): Promise<ToolResult> {
    const a = args as AssetsArgs
    if (a.view === 'asset' && !a.assetId) return { ok: false, error: 'view asset needs the assetId.' }
    if (adsMode() === 'sandbox') return { ok: true, data: { market: a.market, items: [], note: SANDBOX_NOTE } }
    const ctx = await contextFor(a.market)
    if ('error' in ctx) return { ok: false, error: ctx.error }
    try {
      if (a.view === 'asset') {
        const found = await getAdsAsset(ctx, a.assetId!, a.version ?? null)
        if (!found) return { ok: false, error: `Amazon holds no asset ${a.assetId}${a.version ? ` in version ${a.version}` : ''} for this profile.` }
        return { ok: true, data: { market: a.market, profileId: ctx.profileId, asset: assetOut(found.asset), versions: found.versions, note: LIVE_NOTE } }
      }
      const kind = a.kind
      const page = await searchAdsAssets(ctx, {
        ...(a.search ? { text: a.search } : {}),
        ...(kind === 'video' ? { assetType: 'VIDEO' as const } : kind === 'all' ? {} : { assetType: 'IMAGE' as const }),
        ...(kind === 'logo' ? { subTypes: ['LOGO'] } : {}),
        pageSize: a.limit, ...(a.cursor ? { token: a.cursor } : {}),
      })
      return { ok: true, data: { market: a.market, profileId: ctx.profileId, items: page.assets.map(assetOut), total: page.total, nextCursor: page.token, note: LIVE_NOTE } }
    } catch (error) {
      return { ok: false, error: readFailed(error) }
    }
  },
}

// ── set-ad-creative ─────────────────────────────────────────────────────────────────────────────────

const imageArg = z.object({
  assetId: ASSET_ID.describe('the image asset (assetId in ad-assets)'),
  assetVersion: VERSION.optional().describe('its version (default: its newest, read from Amazon)'),
  crop: cropArg.optional().describe('the part of the image shown (default: the whole image)'),
})
const customImageArg = z.object({
  assetId: ASSET_ID.describe('the image asset (assetId in ad-assets): at least 1200 × 628'),
  assetVersion: VERSION.optional().describe('its version (default: its newest, read from Amazon)'),
  rectCrop: cropArg.optional().describe('the rectangular crop, 1.91 : 1, at least 1200 × 628 (default: the largest centred one)'),
  squareCrop: cropArg.optional().describe('the square crop, at least 628 × 628 (default: the largest centred one)'),
})
const videoArg = z.object({
  assetId: ASSET_ID.describe('the video asset (assetId in ad-assets, kind video)'),
  assetVersion: VERSION.optional().describe('its version (default: its newest, read from Amazon)'),
})

const setCreativeInput = z.object({
  op: z.preprocess(lower, z.enum(['create', 'update']))
    .describe('create: a creative for an ad group that has none (one per ad group); update: change the ad group\'s creative'),
  adGroupId: ID.describe('the Sponsored Display ad group: its Nexus id (adGroupId in ad-creatives or ad-groups)'),
  headline: z.string().max(200).nullable().optional()
    .describe('the headline: at most 50 characters, none of < > # ^ !, no emoji, at most half capitals; null removes it'),
  brandLogo: imageArg.nullable().optional().describe('the brand logo: an image asset of at least 600 × 100, at most 1 MB; null removes it'),
  customImage: customImageArg.nullable().optional()
    .describe('the custom image: one image asset shown in a rectangular and a square crop; null removes it'),
  video: videoArg.nullable().optional().describe('the video (a VIDEO ad group\'s creative only); null removes it'),
  properties: propertiesArg.optional()
    .describe('instead of the parts above: the creative\'s whole properties, as ad-creatives shows them (an undo puts them back this way)'),
  consentToTranslate: z.boolean().optional()
    .describe('op create: let Amazon translate an English headline or video into the market\'s language (it rejects the creative when it cannot)'),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})
type CreativeArgs = z.infer<typeof setCreativeInput>
type CropArg = z.infer<typeof cropArg>

const PARTS = ['headline', 'brandLogo', 'customImage', 'video'] as const
const named = (a: CreativeArgs) => PARTS.filter((k) => a[k] !== undefined)
const cropOf = (c: CropArg | undefined): SdCrop | undefined => (c ? { left: c.left, top: c.top, width: c.width, height: c.height } : undefined)

/** What a request asks that no read is needed to refuse. */
function creativeArgsProblem(a: CreativeArgs): string | null {
  const parts = named(a)
  if (a.properties && parts.length) return 'Give either properties (the whole creative) or the parts (headline, brandLogo, customImage, video), not both.'
  if (!a.properties && !parts.length) return 'Name what the creative shows: headline, brandLogo, customImage or video (or properties, the whole creative).'
  if (a.op === 'create' && !a.properties && parts.every((k) => a[k] === null)) return 'op create makes a creative: give what it shows, not only parts to remove.'
  if (a.op === 'update' && a.consentToTranslate !== undefined) return 'consentToTranslate is for op create only.'
  return null
}

/** The asset facts these rules read, by `assetId@version`; each asset read once from Amazon. */
type AssetBook = Map<string, AdsAsset | null>
async function assetFacts(ctx: ClientContext, book: AssetBook, assetId: string, version: string | null): Promise<AdsAsset | null> {
  const key = `${assetId}@${version ?? 'newest'}`
  if (!book.has(key)) {
    const found = await getAdsAsset(ctx, assetId, version)
    book.set(key, found?.asset ?? null)
    if (found?.asset.version) book.set(`${assetId}@${found.asset.version}`, found.asset)
  }
  return book.get(key) ?? null
}

interface CreativeState {
  group: SdCreativeGroup
  creativeType: SdCreativeType
  current: SdCreative | null
  moderation: SdCreativeModeration | null
}

/** The creative's properties after the request: the whole properties given, or the current ones with the parts changed. */
async function propertiesAfter(a: CreativeArgs, state: CreativeState, ctx: ClientContext | null, book: AssetBook): Promise<SdCreativeProperties | { error: string }> {
  if (a.properties) return sendableSdProperties(a.properties as SdCreativeProperties)
  const to: SdCreativeProperties = state.current ? sendableSdProperties(state.current.properties) : {}
  const version = async (assetId: string, given: string | undefined, place: string): Promise<{ version: string; asset: AdsAsset | null } | { error: string }> => {
    if (!ctx) return given ? { version: given, asset: null } : { error: `${place}: Amazon ads are in sandbox on this server, so Nexus cannot read the asset's newest version: give assetVersion.` }
    const asset = await assetFacts(ctx, book, assetId, given ?? null)
    if (!asset) return { error: `${place}: Amazon holds no asset ${assetId}${given ? ` in version ${given}` : ''} for this profile (ad-assets lists them).` }
    return asset.version ? { version: asset.version, asset } : { error: `${place}: Amazon did not say which version asset ${assetId} is: give assetVersion.` }
  }
  if (a.headline !== undefined) {
    if (a.headline === null) delete to.headline
    else to.headline = a.headline.trim()
  }
  if (a.brandLogo !== undefined) {
    if (a.brandLogo === null) delete to.brandLogo
    else {
      const v = await version(a.brandLogo.assetId, a.brandLogo.assetVersion, 'brandLogo')
      if ('error' in v) return v
      const crop = cropOf(a.brandLogo.crop)
      to.brandLogo = { assetId: a.brandLogo.assetId, assetVersion: v.version, ...(crop ? { croppingCoordinates: crop } : {}) }
    }
  }
  if (a.customImage !== undefined) {
    if (a.customImage === null) {
      delete to.rectCustomImage
      delete to.squareCustomImage
    } else {
      const v = await version(a.customImage.assetId, a.customImage.assetVersion, 'customImage')
      if ('error' in v) return v
      const size = { width: v.asset?.width ?? null, height: v.asset?.height ?? null }
      const rect = cropOf(a.customImage.rectCrop) ?? sdDefaultCrop(size, SD_RECT_CROP)
      const square = cropOf(a.customImage.squareCrop) ?? sdDefaultCrop(size, SD_SQUARE_CROP)
      const image = (crop: SdCrop | null | undefined): SdImage => ({ assetId: a.customImage!.assetId, assetVersion: v.version, ...(crop ? { croppingCoordinates: crop } : {}) })
      to.rectCustomImage = image(rect)
      to.squareCustomImage = image(square)
    }
  }
  if (a.video !== undefined) {
    if (a.video === null) delete to.video
    else {
      const v = await version(a.video.assetId, a.video.assetVersion, 'video')
      if ('error' in v) return v
      to.video = { assetId: a.video.assetId, assetVersion: v.version }
    }
  }
  return to
}

/** The parts that move, from → to, as a person reads them; only the ones that differ. */
function partChanges(from: SdCreativeProperties | null, to: SdCreativeProperties): Record<string, { from: string | null; to: string | null }> {
  const before = sdPropertiesWords(from), after = sdPropertiesWords(to)
  const out: Record<string, { from: string | null; to: string | null }> = {}
  for (const key of Object.keys(after)) if (before[key] !== after[key]) out[key] = { from: before[key], to: after[key] }
  return out
}

interface CreativePlan {
  preview: Record<string, unknown>
  state: CreativeState
  send: { creativeType: SdCreativeType; properties: SdCreativeProperties; creativeId: string | null; consentToTranslate?: true }
  reach: StoredReach
}

/** The dry run: everything the request would send and where, or why it is refused. Reads Nexus and (live) Amazon only. */
async function planCreative(a: CreativeArgs): Promise<CreativePlan | { error: string }> {
  const asked = creativeArgsProblem(a)
  if (asked) return { error: asked }
  const group = await sdCreativeGroupById(a.adGroupId)
  if (!group) return { error: 'Ad group not found' }
  const problem = groupProblem(group)
  if (problem) return { error: problem }
  const campaign = group.campaign

  const fields = a.properties ? Object.keys(a.properties) : named(a)
  const reach: LiveReach = await checkLiveReach({
    campaignId: campaign.id, adGroupId: group.id, marketplace: campaign.marketplace,
    changes: fields.map((field) => ({ field, valueCents: null })), write: { entity: 'CREATIVE', fields },
  })
  if (reach.reach === 'refused') return { error: reachRefusal(reach) }

  let ctx: ClientContext | null = null
  const state: CreativeState = { group, creativeType: groupType(null, group), current: null, moderation: null }
  const book: AssetBook = new Map()
  if (reach.reach === 'live') {
    const resolved = await contextFor(campaign.marketplace)
    if ('error' in resolved) return { error: resolved.error }
    if (resolved.profileId !== reach.profileId) return { error: `The write gate answers profile ${reach.profileId} and the market resolves to ${resolved.profileId}; nothing is asked until they agree.` }
    ctx = resolved
    try {
      const external = group.externalAdGroupId!
      state.current = (await listSdCreatives(ctx, { externalAdGroupIds: [external] }))[0] ?? null
      state.creativeType = groupType((await listSdAdGroupCreativeTypes(ctx, [external])).get(external), group)
      if (state.current) {
        const language = sdModerationLanguageFor(campaign.marketplace)
        state.moderation = (await listSdCreativeModerations(ctx, { creativeIds: [state.current.creativeId], language }))[0] ?? null
      }
    } catch (error) {
      return { error: readFailed(error) }
    }
  }
  const status = state.moderation?.moderationStatus ?? state.current?.moderationStatus ?? null
  if (a.op === 'create' && state.current) return { error: `Ad group ${group.name} already has creative ${state.current.creativeId} (Amazon keeps one per ad group): ask with op update.` }
  if (a.op === 'update' && !state.current) {
    return { error: reach.reach === 'live' ? `Ad group ${group.name} has no creative at Amazon: ask with op create.` : `${SANDBOX_NOTE} There is no creative to update: op create only.` }
  }
  if (status === 'PENDING_REVIEW') return { error: `Amazon is reviewing creative ${state.current!.creativeId} (${sdModerationWords(status, state.moderation?.etaForModeration)}). Ask again once ad-creatives shows it approved or rejected.` }

  let to: SdCreativeProperties
  try {
    const built = await propertiesAfter(a, state, ctx, book)
    if ('error' in built) return built
    to = built
  } catch (error) {
    return { error: readFailed(error) }
  }
  const wrong = sdPropertiesProblem(to, state.creativeType)
  if (wrong) return { error: `Not queued: ${wrong}.` }
  const from = state.current ? sendableSdProperties(state.current.properties) : null
  if (from && canonical(from) === canonical(to)) return { error: `Nothing would change: creative ${state.current!.creativeId} already shows exactly this.` }

  // Every asset the creative newly names (or names in a new place) is read and held to Amazon's rules; one it keeps as it
  // was is Amazon's already.
  const kept = new Set((from ? sdAssetUses(from) : []).map((u) => canonical(u)))
  const fresh = sdAssetUses(to).filter((u) => !kept.has(canonical(u)))
  const assets: Array<SdAssetUse & { size: string | null; status: string | null }> = []
  for (const use of fresh) {
    if (!ctx) { assets.push({ ...use, size: null, status: null }); continue }
    let asset: AdsAsset | null
    try {
      asset = await assetFacts(ctx, book, use.assetId, use.assetVersion)
    } catch (error) {
      return { error: readFailed(error) }
    }
    if (!asset) return { error: `${use.place}: Amazon holds no asset ${use.assetId} in version ${use.assetVersion} for this profile (ad-assets lists them).` }
    const bad = sdAssetUseProblem(use, asset)
    if (bad) return { error: `Not queued: ${bad}.` }
    assets.push({ ...use, size: asset.width != null && asset.height != null ? `${asset.width} × ${asset.height}` : null, status: asset.status })
  }

  const stored = storedReach(reach)
  const changes = partChanges(from, to)
  const where = `ad group "${group.name}" of Sponsored Display campaign "${campaign.name}" (${campaign.marketplace ?? 'no market'})`
  const summary = a.op === 'create'
    ? `Makes a creative for ${where}: ${Object.entries(changes).map(([k, c]) => `${k} ${c.to}`).join('; ')}.`
    : `Changes creative ${state.current!.creativeId} of ${where}: ${Object.entries(changes).map(([k, c]) => `${k} ${c.from ?? '(none)'} → ${c.to ?? '(none)'}`).join('; ')}.`
  const warnings = [
    'Amazon reviews the creative (moderation) before it shows it: ad-creatives says when it is approved or rejected, and a creative in review cannot be changed meanwhile.',
    ...(status === 'REJECTED' ? ['Amazon rejected the creative as it is now; this change goes to its review again.'] : []),
    ...(!ctx ? [`${SANDBOX_NOTE} The assets were not read, so their size and type were not checked.`] : []),
    ...(a.op === 'create' && a.consentToTranslate ? ['Amazon translates an English headline or video into the market\'s language, and rejects the creative when it cannot.'] : []),
  ]
  const send = { creativeType: state.creativeType, properties: to, creativeId: state.current?.creativeId ?? null, ...(a.op === 'create' && a.consentToTranslate ? { consentToTranslate: true as const } : {}) }
  const basis = sha({
    current: state.current ? { creativeId: state.current.creativeId, creativeType: state.current.creativeType, properties: from, moderation: status } : null,
    creativeType: state.creativeType,
    assets: assets.map(({ place, assetId, assetVersion, size, status: s }) => ({ place, assetId, assetVersion, size, status: s })),
  })
  return {
    state, send, reach: stored,
    preview: {
      action: 'set-ad-creative', op: a.op, summary, effect: `${summary} ${NO_SPEND}`,
      campaign: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      adGroup: { id: group.id, name: group.name, externalAdGroupId: group.externalAdGroupId, creativeType: state.creativeType },
      creativeId: state.current?.creativeId ?? null,
      moderationNow: state.current ? sdModerationWords(status, state.moderation?.etaForModeration) : null,
      changes, assets: assets.map(({ place, assetId, assetVersion, crop, size }) => ({ place, assetId, assetVersion, crop, size })),
      send, basis, reach: stored, reachNote: reachNote(stored), warnings,
    },
  }
}

/** The creative as a change records it (and undo compares it): where it is, and its sendable properties. */
interface CreativeRecord {
  market: string | null
  adGroupId: string
  externalAdGroupId: string
  creativeId: string | null
  creativeType: SdCreativeType
  properties: SdCreativeProperties | null
  mode: 'live' | 'sandbox'
}

async function runCreative(a: CreativeArgs, ctx: ToolContext): Promise<ToolResult> {
  const planned = await planCreative(a)
  const fresh: ToolResult = 'error' in planned ? { ok: false, error: planned.error } : { ok: true, preview: planned.preview }
  const stale = recheck(ctx, fresh, CREATIVE_MATERIAL)
  if (stale || 'error' in planned) return notRun(stale ?? `Not run: ${(planned as { error: string }).error}`)
  const run = approvedRun(ctx, a.why ?? String(planned.preview.summary))
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const { state, send } = planned
  const group = state.group
  const live = planned.reach.reach === 'live'
  const client = (await adsClientContextFor(group.campaign.marketplace)) ?? { profileId: 'n/a', region: 'EU' as const }
  const request = send.creativeId
    ? sdCreativeUpdateRequest({ creativeId: send.creativeId, creativeType: send.creativeType, properties: send.properties })
    : sdCreativeCreateRequest({ externalAdGroupId: group.externalAdGroupId!, creativeType: send.creativeType, properties: send.properties, consentToTranslate: send.consentToTranslate })
  const result = await sendSdCreativeWrite(client, request, { externalAdGroupId: group.externalAdGroupId! })
  const base = { market: group.campaign.marketplace, adGroupId: group.id, externalAdGroupId: group.externalAdGroupId!, creativeType: send.creativeType, mode: live ? 'live' as const : 'sandbox' as const }
  const before: CreativeRecord = { ...base, creativeId: state.current?.creativeId ?? null, properties: state.current ? sendableSdProperties(state.current.properties) : null }
  let after: CreativeRecord = { ...base, creativeId: result.creativeId, properties: send.properties }
  if (result.ok && live && result.creativeId) {
    // What Amazon holds now is what the change record keeps (undo compares it): a translation or Amazon's own tidying stays.
    const [back] = await listSdCreatives(client, { creativeIds: [result.creativeId] }).catch(() => [])
    if (back) after = { ...after, creativeType: back.creativeType ?? after.creativeType, properties: sendableSdProperties(back.properties) }
  }
  await prisma.advertisingActionLog.create({
    data: {
      userId: run.actor, actionType: send.creativeId ? 'update_sd_creative' : 'create_sd_creative', entityType: 'AD_GROUP', entityId: group.id,
      payloadBefore: { creative: before } as never, payloadAfter: { creative: after, note: run.reason, ...(result.error ? { error: result.error } : {}) } as never,
      amazonResponseStatus: result.ok ? 'SUCCESS' : 'FAILED', executionId: run.changeSetId,
    },
  }).catch(() => {})
  if (!result.ok) return notRun(`Not run: Amazon refused it — ${result.error}. Nothing changed at Amazon.`)
  return {
    ok: true,
    data: {
      op: a.op, creativeId: result.creativeId, adGroupId: group.id, mode: base.mode, changeSetId: run.changeSetId,
      ...(result.recoveredByReadBack ? { recoveredByReadBack: true } : {}),
      note: live
        ? 'Sent to Amazon: it reviews the creative before it shows it. ad-creatives says when it is approved or rejected.'
        : 'Recorded in Nexus only: Amazon ads are in sandbox on this server, so nothing reached Amazon.',
    },
    change: { before, after },
  }
}

/** C2 — undo: a changed creative is put back with its old properties; Amazon has no delete for a creative it made. */
const CREATIVE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as CreativeRecord
    if (after.mode === 'sandbox' || !after.creativeId) return after
    try {
      const ctx = await contextFor(after.market)
      if ('error' in ctx) return { ...after, properties: null, unreadable: ctx.error }
      const [now] = await listSdCreatives(ctx, { creativeIds: [after.creativeId] })
      return now ? { ...after, creativeType: now.creativeType ?? after.creativeType, properties: sendableSdProperties(now.properties) } : { ...after, properties: null, missing: true }
    } catch (error) {
      return { ...after, properties: null, unreadable: sdAmazonErrorWords(error) }
    }
  },
  request(change) {
    const before = (change.before ?? {}) as Partial<CreativeRecord>
    const after = (change.after ?? {}) as Partial<CreativeRecord>
    if (!after.adGroupId) return { refusal: 'This change does not name the ad group whose creative it changed.' }
    if (!before.creativeId || !before.properties) {
      return { refusal: 'Amazon has no way to delete a creative: the ad group keeps it. Change it with set-ad-creative op update, or pause or archive the ad group.' }
    }
    return { tool: 'set-ad-creative', args: { op: 'update', adGroupId: after.adGroupId, properties: before.properties, why: 'Undo: puts back the creative as it was before the change.' } }
  },
}

const setAdCreative: AgentTool = {
  name: 'set-ad-creative',
  title: 'Set a Display ad creative',
  input: setCreativeInput,
  requires: [F.adsCampaignsManage],
  category: 'advertising',
  riskTier: 'medium',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — partly: a changed creative is put back with its old properties (Amazon reviews it again); a new creative stays.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: CREATIVE_UNDO,
  description:
    'Make (op create) or change (op update) the creative of a Sponsored Display ad group at Amazon — what its ad looks like. '
    + 'Parts: headline (at most 50 characters, none of < > # ^ !, no emoji, at most half capitals; null removes it), brandLogo '
    + '(an image asset of at least 600 × 100, at most 1 MB, with an optional crop), customImage (one image asset of at least '
    + '1200 × 628 shown in a rectangular 1.91 : 1 and a square crop, each the largest centred one unless given) and video (a '
    + 'VIDEO ad group only); or properties, the whole creative as ad-creatives shows it. Assets come from ad-assets (or '
    + 'upload-ad-asset); the newest version is used unless assetVersion is given, and Nexus checks each asset\'s type, size and '
    + 'crops first. An IMAGE ad group\'s creative takes no video; a VIDEO ad group\'s needs one. One creative per ad group: op '
    + 'create only when it has none. A creative Amazon is reviewing cannot be changed. Amazon reviews every new or changed '
    + 'creative before it shows it. It changes no bid, budget or on/off state. A person approves it in Nexus; undo puts a '
    + 'changed creative back.',
  handler: async (args) => {
    const plan = await planCreative(args as CreativeArgs)
    return 'error' in plan ? { ok: false, error: plan.error } : { ok: true, preview: plan.preview }
  },
  execute: (args, ctx) => runCreative(args as CreativeArgs, ctx),
}

// ── upload-ad-asset ─────────────────────────────────────────────────────────────────────────────────

const USES = ['brandLogo', 'customImage'] as const
type Use = (typeof USES)[number]
const UPLOAD_TYPES = ['image/jpeg', 'image/png'] as const
const PHOTO_ID = /^(da|pi)_[A-Za-z0-9_-]+$/

const uploadInput = z.object({
  market: z.string().trim().toUpperCase().min(2).max(8).describe('the market whose Amazon Ads profile gets the asset, e.g. IT (business-overview lists them)'),
  use: z.enum(USES).describe('what it is for: brandLogo (at least 600 × 100, at most 1 MB) or customImage (at least 1200 × 628, at most 5 MB)'),
  photoId: z.string().trim().regex(PHOTO_ID, 'a photo id from image-library is da_… or pi_…').optional()
    .describe('a photo in Nexus: a library item (da_…) or a product photo (pi_…), as image-library shows it'),
  url: z.string().trim().url().max(2000).optional().describe('instead of photoId: an https link to a JPEG or PNG'),
  subType: z.enum(ADS_IMAGE_SUB_TYPES).optional()
    .describe('customImage: how Amazon files it — LIFESTYLE_IMAGE (default), PRODUCT_IMAGE or OTHER_IMAGE (a brandLogo is a LOGO)'),
  name: z.string().trim().min(1).max(100).optional().describe('its name in the library (default: "Nexus <use> <a short hash>")'),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})
type UploadArgs = z.infer<typeof uploadInput>

const SPEC_OF: Record<Use, typeof SD_LOGO_SPEC> = { brandLogo: SD_LOGO_SPEC, customImage: SD_CUSTOM_IMAGE_SPEC }

/** Where the asset lands, as the write gate answers for a Sponsored Display creative's asset in this market (no campaign). */
async function uploadReach(market: string): Promise<LiveReach> {
  return liveReachOf(await checkAdsWriteGate({
    marketplace: market, payloadValueCents: 0, adProduct: SPONSORED_DISPLAY, write: { entity: 'CREATIVE', fields: ['asset'] }, fields: ['asset'],
    // 4A — a person's approval is his own click, as gateContextFor says it for every ad change tool.
    ...(isRuleApprovedRun() ? {} : { manual: true, confirmOwnLimits: true }),
  }))
}

/** The address of a Nexus photo in this business, or why there is none. */
async function photoAddress(a: UploadArgs): Promise<{ url: string; source: string } | { error: string }> {
  if (a.url) return { url: a.url, source: a.url }
  const id = a.photoId!.slice(3)
  if (a.photoId!.startsWith('da_')) {
    const asset = await prisma.digitalAsset.findFirst({ where: { id }, select: { url: true, type: true } })
    if (!asset) return { error: 'Library item not found in this business (image-library lists them).' }
    if (asset.type !== 'image') return { error: `Library item ${a.photoId} is a ${asset.type}, not a photo.` }
    return { url: asset.url, source: a.photoId! }
  }
  const photo = await prisma.productImage.findFirst({ where: { id, product: { deletedAt: null } }, select: { url: true } })
  return photo ? { url: photo.url, source: a.photoId! } : { error: 'Product photo not found in this business.' }
}

interface UploadPlan { preview: Record<string, unknown>; bytes: Buffer; mimeType: (typeof UPLOAD_TYPES)[number]; reach: StoredReach }

async function planUpload(a: UploadArgs): Promise<UploadPlan | { error: string }> {
  if (!a.photoId === !a.url) return { error: 'Name the photo: photoId (da_… or pi_…, from image-library) or url (an https link), one of them.' }
  if (a.use === 'brandLogo' && a.subType && a.subType !== 'LOGO') return { error: 'A brandLogo is filed as a LOGO: leave subType out.' }
  if (a.use === 'customImage' && a.subType === 'LOGO') return { error: 'A customImage is not filed as a LOGO: use brandLogo for a logo.' }
  const reach = await uploadReach(a.market)
  if (reach.reach === 'refused') return { error: reachRefusal(reach) }
  const address = await photoAddress(a)
  if ('error' in address) return address
  const spec = SPEC_OF[a.use]
  let photo: Awaited<ReturnType<typeof fetchPhoto>>
  try {
    photo = await fetchPhoto(address.url, spec.maxBytes)
  } catch (error) {
    return { error: `The photo could not be used as a ${spec.label}: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!(UPLOAD_TYPES as readonly string[]).includes(photo.mimeType)) return { error: `The photo is ${photo.mimeType}; Nexus uploads a ${spec.label} as JPEG or PNG only.` }
  let size: { width?: number; height?: number; type?: string }
  try { size = imageSize(photo.buffer) } catch { size = {} }
  if (!size.width || !size.height) return { error: 'The file could not be read as a JPEG or PNG photo.' }
  const facts = { assetId: 'new', version: null, assetType: 'IMAGE', status: 'ACTIVE', width: size.width, height: size.height, bytes: photo.bytes, contentType: photo.mimeType, extension: null }
  const wrong = sdImageAssetProblem(facts, spec)
  if (wrong) return { error: `Not queued: ${wrong.replace('asset new', 'the photo')}.` }
  const short = photo.contentHash.slice(0, 10)
  const subType = a.use === 'brandLogo' ? 'LOGO' as const : a.subType ?? 'LIFESTYLE_IMAGE'
  const send = { fileName: `nexus_${a.use === 'brandLogo' ? 'logo' : 'image'}_${short}.${photo.mimeType === 'image/png' ? 'png' : 'jpg'}`, name: a.name ?? `Nexus ${a.use} ${short}`, subType }
  const stored = storedReach(reach)
  const summary = `Uploads ${address.source} (${size.width} × ${size.height}, ${(photo.bytes / 1024).toFixed(0)} KB) to the Amazon Ads creative asset library of ${a.market} as a ${spec.label} (${subType}), named "${send.name}".`
  return {
    bytes: photo.buffer, mimeType: photo.mimeType as (typeof UPLOAD_TYPES)[number], reach: stored,
    preview: {
      action: 'upload-ad-asset', summary,
      effect: `${summary} No ad changes until a creative uses it (set-ad-creative). ${NO_SPEND}`,
      market: a.market, use: a.use, source: address.source,
      file: { mimeType: photo.mimeType, bytes: photo.bytes, width: size.width, height: size.height, contentHash: photo.contentHash },
      basis: photo.contentHash, send, reach: stored, reachNote: reachNote(stored),
      warnings: [
        'Amazon keeps every upload and has no way to delete an asset through its API: this cannot be undone. ad-assets lists what the library already holds.',
        ...(stored.reach === 'sandbox' ? [SANDBOX_NOTE.replace('nothing was read from', 'nothing is sent to')] : []),
      ],
    },
  }
}

async function runUpload(a: UploadArgs, ctx: ToolContext): Promise<ToolResult> {
  const planned = await planUpload(a)
  const fresh: ToolResult = 'error' in planned ? { ok: false, error: planned.error } : { ok: true, preview: planned.preview }
  const stale = recheck(ctx, fresh, UPLOAD_MATERIAL)
  if (stale || 'error' in planned) return notRun(stale ?? `Not run: ${(planned as { error: string }).error}`)
  const run = approvedRun(ctx, a.why ?? String(planned.preview.summary))
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const send = planned.preview.send as { fileName: string; name: string; subType: (typeof ADS_IMAGE_SUB_TYPES)[number] }
  const client = (await adsClientContextFor(a.market)) ?? { profileId: 'n/a', region: 'EU' as const }
  let uploaded: Awaited<ReturnType<typeof uploadAdsImageAsset>>
  try {
    uploaded = await uploadAdsImageAsset(client, { ...send, bytes: planned.bytes, mimeType: planned.mimeType, tags: ['nexus'] })
  } catch (error) {
    return notRun(`Not run: ${sdAmazonErrorWords(error)}`)
  }
  const after = { market: a.market, assetId: uploaded.assetId, versionId: uploaded.versionId, name: send.name, subType: send.subType, use: a.use, mode: uploaded.mode }
  await prisma.advertisingActionLog.create({
    data: {
      userId: run.actor, actionType: 'create_ad_asset', entityType: 'AD_ASSET', entityId: uploaded.assetId,
      payloadBefore: {}, payloadAfter: { ...after, source: planned.preview.source, note: run.reason } as never, amazonResponseStatus: 'SUCCESS', executionId: run.changeSetId,
    },
  }).catch(() => {})
  return {
    ok: true,
    data: {
      ...after,
      ...(uploaded.failedSpecChecks.length ? { failedSpecChecks: uploaded.failedSpecChecks } : {}),
      note: uploaded.mode === 'live'
        ? `In the library: set-ad-creative takes it as ${a.use} { assetId, assetVersion: "${uploaded.versionId}" }.`
        : 'Recorded in Nexus only: Amazon ads are in sandbox on this server, so nothing reached Amazon.',
    },
    change: { before: { market: a.market, assetId: null }, after },
  }
}

const uploadAdAsset: AgentTool = {
  name: 'upload-ad-asset',
  title: 'Upload an Amazon ad asset',
  input: uploadInput,
  requires: [F.adsCampaignsManage],
  category: 'advertising',
  riskTier: 'medium',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // C1 — Amazon has no delete for an asset (its API), so an upload stays in the library.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Upload a photo to the Amazon Ads creative asset library of one market\'s advertising profile, for a Sponsored Display '
    + 'creative: use brandLogo (filed as a LOGO; at least 600 × 100 pixels, at most 1 MB) or customImage (at least 1200 × 628, '
    + 'at most 5 MB). The photo is a Nexus library item or product photo (photoId, from image-library) or an https link to a '
    + 'JPEG or PNG; Nexus reads and checks it now, and uploads exactly those bytes when the approved request runs (Amazon\'s '
    + 'upload location, the file, the registration). The result is the assetId and version set-ad-creative takes. Nothing in an '
    + 'ad changes until a creative uses it. Amazon cannot delete an asset through its API, so it cannot be undone. A person '
    + 'approves it in Nexus.',
  handler: async (args) => {
    const plan = await planUpload(args as UploadArgs)
    return 'error' in plan ? { ok: false, error: plan.error } : { ok: true, preview: plan.preview }
  },
  execute: (args, ctx) => runUpload(args as UploadArgs, ctx),
}

export const ADS_SD_CREATIVE_TOOLS: AgentTool[] = [adCreatives, adAssets, setAdCreative, uploadAdAsset]

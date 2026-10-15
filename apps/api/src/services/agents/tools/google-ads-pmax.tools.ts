/**
 * Google Ads Performance Max (programme 2, G10, 2026-10-16). Every change tool here is a Nexus change: a preview Google
 * has checked (validate_only), an approvalId, a person approves it in Nexus, it runs as that person (google-ads-kit.ts).
 * Never by rule.
 *
 *   build-google-pmax                Performance Max campaigns (each PAUSED, its own budget) with their asset groups,
 *                                    assets, product trees (retail), signals, brand guidelines, Google's automation, URL /
 *                                    brand exclusions — ONE atomic request; a campaign may be a copy of a live one (copyOf)
 *   copy-google-pmax                 a live Performance Max campaign into a NEW paused one (build-google-pmax's copyOf)
 *   set-google-pmax                  a live Performance Max campaign: asset groups (make, rename, pause / enable, URLs,
 *                                    paths), their assets, product tree and signals; the campaign's name, bidding, dates,
 *                                    Google's automation, URL exclusions, brand exclusions and brand assets
 *   set-google-customer-acquisition  the account's new-customer goal, or one campaign's use of it (Goals /
 *                                    CampaignGoalConfigs — not a GoogleAdsService.Mutate: one call each)
 *
 * Why its own build tool and not build-google-campaigns (G10 brief: "only if that is the clean way"): a Performance Max
 * campaign shares nothing with that build's parts (no ad groups, keywords, ads or product groups; a budget of its own,
 * never shared; Maximize conversions / conversion value only; brand guidelines; asset groups whose assets must be sent
 * together, after every asset — performance-max/structure-requests). Folding it in would double that tool's arguments for
 * a different structure; one call of build-google-pmax is still ONE atomic request where new parts point at new parts.
 *
 * The builders: marketing/google-ads/change-pmax.ts, build-pmax.ts, change-acquisition.ts (what was checked in Google's
 * v25 reference is in their headers); the live reads: live-pmax.ts; images: asset-images.ts (G6).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleCentsArg, googleChangePreview, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, matchTypeArg, recordAccount, runGoogleChange,
  type GoogleDraftBuilder, type GoogleSender,
} from './google-ads-kit.js'
import { dimensionValueArg } from './google-ads-product-groups.tools.js'
import { DAYS } from '../../marketing/google-ads/change-campaigns.js'
import { buildRecordAfterRun, type BuildRecord } from '../../marketing/google-ads/change-build.js'
import { MAX_IMAGE_BYTES_TOTAL } from '../../marketing/google-ads/change-assets-all.js'
import {
  BRAND_FONTS, CALL_TO_ACTIONS, campaignFactsOf, groupFactsOf, imageSlot, PMAX_DIMENSIONS, PMAX_GROUP_FIELDS, PMAX_IMAGE_FIELDS,
  pmaxChangeDraft, pmaxRecordAfterRun, pmaxSpecOfSnapshot, SEGMENT_KINDS, urlExclusionOfKey,
  type PmaxAssetsAsk, type PmaxChangeRecord, type PmaxChangeRequest, type PmaxGroupFacts, type PreparedImages,
} from '../../marketing/google-ads/change-pmax.js'
import { buildImageScope, pmaxBuildDraft, pmaxCampaignAsBuild, type PmaxBuildCampaign } from '../../marketing/google-ads/build-pmax.js'
import { acquisitionDraft, type AcquisitionRecord, type AcquisitionRequest } from '../../marketing/google-ads/change-acquisition.js'
import { checkAccountOperations, sendAccountOperations } from '../../marketing/google-ads/account-client.js'
import { liveCampaigns } from '../../marketing/google-ads/live.js'
import { liveAcquisition, liveBrandLists, livePmaxAssets, livePmaxAudiences, livePmaxCampaign, type PmaxAsset } from '../../marketing/google-ads/live-pmax.js'
import { prepareImage, type ImageSource } from '../../marketing/google-ads/asset-images.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'
import type { GoogleAdsTarget } from '../../marketing/google-ads/types.js'

const ADSPEND = FIELDS.financialsAdspendView
/** Money keys of these tools' previews and answers: their sentences quote budgets, targets and values. */
const PMAX_MONEY = {
  changes: ADSPEND, warnings: ADSPEND, spendsMoneyBecause: ADSPEND, summary: ADSPEND, dailyBudgetCents: ADSPEND, targetCpaCents: ADSPEND,
  targetRoas: ADSPEND, newCustomerValueCents: ADSPEND, highValueCents: ADSPEND,
} as const

type Stamped = { accountId?: string; customerId?: string }
const accountArgOf = (record: Stamped) => (record.accountId ? { accountId: record.accountId } : {})
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
}

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────

const textArg = (max: number, what: string) => z.string().trim().min(1).max(max).describe(what)
const dayArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).describe(`${what} (YYYY-MM-DD)`)
const urlArg = (what: string) => z.string().trim().min(1).max(2048).describe(`${what} (https)`)

const imageArg = z.object({
  fieldType: z.preprocess(upper, z.enum(PMAX_IMAGE_FIELDS)).describe('MARKETING_IMAGE (landscape 1.91:1, at least 600×314), SQUARE_MARKETING_IMAGE (1:1, 300×300), PORTRAIT_MARKETING_IMAGE (4:5, 480×600), LOGO (1:1, 128×128) or LANDSCAPE_LOGO (4:1, 512×128); JPG, PNG or GIF, at most 5120 KB'),
  imageUrl: z.string().trim().min(1).max(2048).optional().describe('the image\'s https link (a public address); give imageUrl or libraryImageId'),
  libraryImageId: z.string().trim().min(3).max(80).optional().describe('an image of the Nexus image library (da_… or pi_…, from image-library); needs the image library permission'),
  name: z.string().trim().min(1).max(120).optional().describe('the asset\'s name in Google Ads (default: the file name and a short fingerprint)'),
})

const assetsArg = z.object({
  headlines: z.array(textArg(60, 'a headline (30 characters; a double-width one counts 2)')).max(15).optional().describe('HEADLINE: 3 to 15 per asset group'),
  longHeadlines: z.array(textArg(180, 'a long headline (90 characters)')).max(5).optional().describe('LONG_HEADLINE: 1 to 5'),
  descriptions: z.array(textArg(180, 'a description (90 characters)')).max(5).optional().describe('DESCRIPTION: 2 to 5, one of 60 characters or fewer'),
  adBusinessName: textArg(50, 'the business name the ads show (25 characters)').optional().describe('BUSINESS_NAME (exactly one): in an asset group only with brand guidelines off; else brandAssets'),
  images: z.array(imageArg).max(30).optional().describe('new image assets: landscape and square marketing images (1 to 20 each), portrait images, logos (1 to 5 with brand guidelines off)'),
  videos: z.array(z.string().trim().min(11).max(200).describe('a YouTube video id (11 characters) or a YouTube link')).max(15).optional().describe('YOUTUBE_VIDEO: up to 15'),
  callToAction: z.preprocess(upper, z.enum(CALL_TO_ACTIONS)).optional().describe('CALL_TO_ACTION_SELECTION (one; default: Google picks it)'),
  link: z.array(z.object({
    assetId: googleIdArg('an existing asset of the account'),
    fieldType: z.preprocess(upper, z.enum(PMAX_GROUP_FIELDS)).describe('as what: HEADLINE, LONG_HEADLINE, DESCRIPTION, BUSINESS_NAME, MARKETING_IMAGE, SQUARE_MARKETING_IMAGE, PORTRAIT_MARKETING_IMAGE, LOGO, LANDSCAPE_LOGO, YOUTUBE_VIDEO or CALL_TO_ACTION_SELECTION'),
  })).max(100).optional().describe('existing assets to link (by id)'),
}).describe('assets: new ones by their content (text, image links, YouTube ids), existing ones by id (link). Content already linked there is skipped')

const assetRefArg = z.object({
  assetId: googleIdArg('the asset'),
  fieldType: z.preprocess(upper, z.enum(PMAX_GROUP_FIELDS)).describe('as what it is linked'),
})

const pmaxTreeNodeArg = z.object({
  parent: z.coerce.number().int().min(0).max(249).optional().describe('the index of its parent in the list; left out only for the root ("All products"), which comes first'),
  value: dimensionValueArg.optional(),
  everythingElse: z.boolean().optional().describe('true = "everything else" of the parent\'s dimension (every split needs exactly one)'),
  split: z.enum(PMAX_DIMENSIONS as [string, ...string[]]).optional().describe('split it further by this dimension; left out = a unit, included unless excluded'),
  excluded: z.boolean().optional().describe('a unit whose products the asset group does not advertise'),
}).describe('one product group: the root (no parent), or a value / everythingElse of its parent\'s split; split further, or a unit (included, or excluded)')

const signalsArg = z.object({
  audiences: z.array(googleIdArg('an audience of the account (google-ads-query: SELECT audience.id, audience.name FROM audience)')).max(50).optional().describe('existing audiences as audience signals'),
  newAudiences: z.array(z.object({
    name: textArg(255, 'its name (unique among the account\'s audiences)'),
    segments: z.array(z.object({
      kind: z.preprocess(upper, z.enum(SEGMENT_KINDS)).describe('USER_LIST (your data), USER_INTEREST (affinity, in-market), CUSTOM_AUDIENCE, LIFE_EVENT or DETAILED_DEMOGRAPHIC'),
      id: googleIdArg('the segment (google-ads-live view lookup)'),
    })).min(1).max(50).describe('who belongs to it (anyone in at least one segment)'),
  })).max(5).optional().describe('new audiences (Audience, account-wide), made in the same request and used as signals'),
  searchThemes: z.array(textArg(80, 'a search theme (like a keyword: at most 80 characters, 10 words)')).max(50).optional().describe('search themes'),
}).describe('signals: audiences and search themes tell Google who is likely to buy (they guide, they do not narrow)')

const urlExclusionArg = z.object({
  contains: z.string().trim().min(1).max(2048).optional().describe('exclude every page whose address contains this'),
  equals: z.string().trim().min(1).max(2048).optional().describe('exclude this exact page address'),
}).refine((u) => (u.contains === undefined) !== (u.equals === undefined), { message: 'give contains or equals, one of them' })
  .describe('a URL exclusion: pages final URL expansion never sends people to')

const automationArg = z.object({
  finalUrlExpansion: z.boolean().optional().describe('Google may send people to other pages of the site than the final URLs (turning it on spends money in an enabled campaign; needs text customization)'),
  textCustomization: z.boolean().optional().describe('Google writes headlines and descriptions from the site and the assets'),
  imageEnhancement: z.boolean().optional().describe('Google crops and enhances images'),
  videoEnhancement: z.boolean().optional().describe('Google makes shorter and vertical versions of videos'),
}).describe('what Google may do on its own')

const biddingArg = z.object({
  strategy: z.enum(['MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE']).describe('Performance Max bids with these two only'),
  targetCpaCents: googleCentsArg('MAXIMIZE_CONVERSIONS: a target cost per conversion').optional(),
  targetRoas: z.coerce.number().min(0.01).max(1000).optional().describe('MAXIMIZE_CONVERSION_VALUE: a target return on ad spend as a ratio (3.5 = 350 %)'),
})

const customParametersArg = z.array(z.object({
  key: z.string().trim().regex(/^[A-Za-z0-9]{1,16}$/).describe('its name (1 to 16 letters and digits; a URL uses it as {_name})'),
  value: z.string().trim().min(1).max(250).describe('its value'),
})).max(8).describe('custom parameters (up to 8)')

const groupBuildArg = z.object({
  name: textArg(128, 'the asset group\'s name (unique in the campaign)'),
  finalUrls: z.array(urlArg('a final URL')).min(1).max(10).describe('final URLs (retail: the Merchant Center site)'),
  finalMobileUrls: z.array(urlArg('a mobile final URL')).max(10).optional().describe('mobile final URLs'),
  path1: z.string().trim().max(30).optional().describe('display path 1 (15 characters)'),
  path2: z.string().trim().max(30).optional().describe('display path 2 (15 characters, needs path1)'),
  status: z.enum(['ENABLED', 'PAUSED']).optional().describe('ENABLED (default; the campaign is paused) or PAUSED'),
  trackingTemplate: z.string().trim().max(2048).optional().describe('the asset group\'s tracking template'),
  finalUrlSuffix: z.string().trim().max(2048).optional().describe('the asset group\'s final URL suffix'),
  customParameters: customParametersArg.optional(),
  assets: assetsArg.optional(),
  productGroups: z.array(pmaxTreeNodeArg).min(1).max(250).optional().describe('retail: the product group tree as a flat list, the root first (default: "All products")'),
  signals: signalsArg.optional(),
})

const campaignBuildArg = z.object({
  copyOf: googleIdArg('copy this live Performance Max campaign (every part, made PAUSED); with it only name, dailyBudgetCents, startDate and endDate').optional(),
  name: textArg(255, 'the new campaign\'s name (unique in the account)'),
  dailyBudgetCents: googleCentsArg('its own daily budget (Performance Max cannot share one)').optional(),
  bidding: biddingArg.optional().describe('bidding (needed unless copyOf)'),
  startDate: dayArg('first day').optional(),
  endDate: dayArg('last day').optional(),
  retail: z.object({
    merchantId: googleIdArg('the Merchant Center account'),
    feedLabel: textArg(20, 'the feed label').optional(),
    localInventory: z.boolean().optional().describe('local products too (default off)'),
  }).optional().describe('retail: the Merchant Center feed whose products it advertises'),
  locations: z.array(z.object({ id: googleIdArg('a location (google-ads-live view lookup)'), exclude: z.boolean().optional().describe('excluded') })).max(100).optional().describe('locations'),
  locationOption: z.enum(['PRESENCE', 'PRESENCE_OR_INTEREST']).optional().describe('location option (default PRESENCE)'),
  languages: z.array(googleIdArg('a language')).max(50).optional().describe('languages'),
  schedule: z.array(z.object({
    days: z.array(z.preprocess(upper, z.enum([...DAYS, 'ALL']))).min(1).max(7).describe('MONDAY … SUNDAY, or ALL'),
    from: z.string().trim().regex(/^\d{1,2}:\d{2}$/).describe('HH:MM'),
    to: z.string().trim().regex(/^\d{1,2}:\d{2}$/).describe('HH:MM (24:00 = midnight)'),
  })).max(42).optional().describe('ad schedule'),
  euPoliticalAds: z.boolean().optional().describe('true only for EU political advertising (default false)'),
  brandGuidelines: z.boolean().optional().describe('brand guidelines (default true, Google\'s default; cannot be changed after): the business name and logos are the campaign\'s'),
  brandStyle: z.object({
    mainColor: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('main color #rrggbb (with accentColor)'),
    accentColor: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/).optional().describe('accent color #rrggbb (with mainColor)'),
    font: z.enum(BRAND_FONTS).optional().describe('the font of Google\'s automated assets'),
  }).optional().describe('brand guidelines: colors and font'),
  brandAssets: assetsArg.optional().describe('with brand guidelines: the business name (exactly one) and logos (one to five, LOGO and LANDSCAPE_LOGO), linked to the campaign'),
  campaignAssets: z.array(z.object({ assetId: googleIdArg('an existing asset'), fieldType: z.preprocess(upper, z.string().regex(/^[A-Z_]{3,40}$/)).describe('as what (SITELINK, CALLOUT, STRUCTURED_SNIPPET, CALL, PRICE, PROMOTION, …)') })).max(50).optional().describe('existing assets linked to the campaign (sitelinks, callouts, …)'),
  automation: automationArg.optional().describe('what Google may do on its own (final URL expansion and text customization OFF unless asked)'),
  urlExclusions: z.array(urlExclusionArg).max(100).optional().describe('pages final URL expansion never uses'),
  brandExclusions: z.array(googleIdArg('a brand list (set-google-exclusion-list)')).max(10).optional().describe('brand lists whose brands are excluded'),
  negativeKeywords: z.array(z.object({ text: textArg(80, 'the negative keyword'), matchType: matchTypeArg })).max(250).optional().describe('campaign negative keywords'),
  trackingTemplate: z.string().trim().max(2048).optional().describe('tracking template'),
  finalUrlSuffix: z.string().trim().max(2048).optional().describe('final URL suffix'),
  customParameters: customParametersArg.optional(),
  ignoreBrandExclusionsForShopping: z.boolean().optional().describe('its brand exclusions do not hold for Shopping ads (default off)'),
  excludedParentAssetFieldTypes: z.array(z.preprocess(upper, z.string().regex(/^[A-Z_]{3,40}$/))).max(30).optional().describe('asset field types the campaign does not inherit from the account (SITELINK, CALLOUT, …)'),
  excludedParentAssetSetTypes: z.array(z.preprocess(upper, z.string().regex(/^[A-Z_]{3,60}$/))).max(30).optional().describe('asset set types the campaign does not inherit from the account'),
  assetGroups: z.array(groupBuildArg).max(20).optional().describe('asset groups'),
})

type CampaignArgs = z.infer<typeof campaignBuildArg>
type GroupArgs = z.infer<typeof groupBuildArg>

// ── images and assets read before a builder runs ────────────────────────────────────────────────────────────────

/** A library image needs the image library permission (as image-library itself does). */
function libraryRefusal(images: ImageSource[], ctx: ToolContext): ToolResult | null {
  return images.some((i) => !!i.libraryImageId) && !ctx.can(F.assetsManage)
    ? { ok: false, error: `An image from the Nexus image library needs the ${F.assetsManage} permission (as image-library does). Give imageUrl instead, or ask a person who has it.` }
    : null
}

/** Every image of a request, fetched once each, by slot; once they pass what one request carries, the rest are not read. */
async function fetchImages(slots: Array<[string, ImageSource]>): Promise<PreparedImages> {
  const out: PreparedImages = {}
  let bytes = 0
  for (const [slot, source] of slots) {
    if (bytes > MAX_IMAGE_BYTES_TOTAL) { out[slot] = { problem: 'not read: the images before it already pass what one request carries' }; continue }
    const got = await prepareImage(source)
    if (!('problem' in got)) bytes += got.bytes
    out[slot] = got
  }
  return out
}

const imageSlotsOf = (scope: string, ask: PmaxAssetsAsk | undefined): Array<[string, ImageSource]> =>
  (ask?.images ?? []).map((img, i) => [imageSlot(scope, i), { imageUrl: img.imageUrl, libraryImageId: img.libraryImageId }])
const linkIdsOf = (ask: PmaxAssetsAsk | undefined) => (ask?.link ?? []).map((l) => l.assetId)

// ── build-google-pmax / copy-google-pmax ────────────────────────────────────────────────────────────────────────

const buildImages = (campaigns: CampaignArgs[]): Array<[string, ImageSource]> => campaigns.flatMap((c, ci) => [
  ...imageSlotsOf(buildImageScope(ci, 'brand'), c.brandAssets as PmaxAssetsAsk | undefined),
  ...(c.assetGroups ?? []).flatMap((g, gi) => imageSlotsOf(buildImageScope(ci, gi), g.assets as PmaxAssetsAsk | undefined)),
])

const COPY_KEYS = new Set(['copyOf', 'name', 'dailyBudgetCents', 'startDate', 'endDate'])

const buildPmaxBuilder = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const asked = (args.campaigns as CampaignArgs[]) ?? []
  const target = account.target
  const wantsSignals = asked.some((c) => !!c.copyOf || (c.assetGroups ?? []).some((g) => g.signals?.audiences?.length || g.signals?.newAudiences?.length))
  const audiences = wantsSignals ? await livePmaxAudiences(target) : []
  const notCopied: string[] = []
  const assets = new Map<string, PmaxAsset>()
  const trusted = new Set<string>()
  const campaigns: PmaxBuildCampaign[] = []
  for (const c of asked) {
    if (c.copyOf) {
      const extra = Object.keys(c).filter((k) => !COPY_KEYS.has(k) && (c as Record<string, unknown>)[k] !== undefined)
      if (extra.length) return { refusal: `Campaign "${c.name}": a copy takes name, dailyBudgetCents, startDate and endDate (not ${extra.join(', ')}); change the copy afterwards with set-google-pmax.` }
      const copied = await pmaxCampaignAsBuild(target, c.copyOf, { name: c.name, dailyBudgetCents: c.dailyBudgetCents, startDate: c.startDate, endDate: c.endDate }, audiences)
      if ('refusal' in copied) return copied
      notCopied.push(...copied.notCopied.map((n) => `"${c.name}": ${n}`))
      for (const a of copied.assets) { assets.set(a.assetId, a); trusted.add(a.assetId) }
      campaigns.push(copied.campaign)
      continue
    }
    if (c.dailyBudgetCents === undefined) return { refusal: `Campaign "${c.name}": give dailyBudgetCents (its own budget) or copyOf.` }
    if (!c.bidding) return { refusal: `Campaign "${c.name}": give bidding (MAXIMIZE_CONVERSIONS or MAXIMIZE_CONVERSION_VALUE) or copyOf.` }
    const { copyOf: _c, assetGroups, ...rest } = c
    campaigns.push({ ...(rest as unknown as PmaxBuildCampaign), assetGroups: (assetGroups ?? []) as PmaxBuildCampaign['assetGroups'] })
  }
  const linkIds = asked.flatMap((c) => [...linkIdsOf(c.brandAssets as PmaxAssetsAsk | undefined), ...(c.assetGroups ?? []).flatMap((g: GroupArgs) => linkIdsOf(g.assets as PmaxAssetsAsk | undefined))])
  for (const a of await livePmaxAssets(target, linkIds.filter((id) => !assets.has(id)))) assets.set(a.assetId, a)
  const brandLists = campaigns.some((c) => c.brandExclusions?.length) ? await liveBrandLists(target) : []
  // A copy links the source's assets again: it fetches no image (its arguments hold none).
  const images = await fetchImages(buildImages(asked))
  const campaignNames = (await liveCampaigns(target)).map((x) => x.name)
  return pmaxBuildDraft(customerResource(target), account.currency, campaigns, { campaignNames, assets: [...assets.values()], audiences, brandLists, images, trusted: [...trusted] }, notCopied)
}

const buildUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as BuildRecord & Stamped
    const account = await recordAccount(after)
    if (!account) return null
    const live = await liveCampaigns(account.target)
    // Unchanged = every campaign it made is still there under its name.
    const holds = after.campaigns.every((c) => c.campaignId && live.some((x) => x.campaignId === c.campaignId && x.name === c.name))
    return holds ? after : { ...after, moved: true }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as BuildRecord & Stamped
    // What the build made: its campaigns, then their own budgets (remove-google-ads-items sends budgets last).
    const items = [
      ...(after.campaigns ?? []).filter((c) => c.campaignId).map((c) => ({ kind: 'campaign', id: c.campaignId })),
      ...(after.campaigns ?? []).filter((c) => c.ownBudgetId).map((c) => ({ kind: 'budget', id: c.ownBudgetId })),
    ]
    if (!items.length) return { refusal: 'This build does not record the ids Google gave what it made.' }
    return {
      tool: 'remove-google-ads-items',
      args: { ...accountArgOf(after), items, confirmRemove: true, why: 'undo of an earlier Performance Max build (its asset groups go with each campaign; new assets stay in the account, unused)' },
    }
  },
}

const buildCommon = {
  ...common,
  // Undo removes the campaigns and budgets it made; the assets it made stay in the account (Google never removes one).
  reversibility: 'partial' as const,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, ADSPEND] as const,
  restrictedFields: PMAX_MONEY,
}

const buildGooglePmax: AgentTool = {
  ...buildCommon,
  name: 'build-google-pmax',
  title: 'Build Performance Max campaigns (paused)',
  input: z.object({
    accountId: googleAccountArg,
    campaigns: z.array(campaignBuildArg).min(1).max(5).describe('new Performance Max campaigns (each made PAUSED)'),
    why: googleWhyArg,
  }),
  description:
    'Build Performance Max campaigns in the business\'s chosen Google Ads account in ONE request, all or nothing — each '
    + 'ALWAYS made PAUSED, on a daily budget of its own (Performance Max cannot share one): bidding (Maximize conversions with '
    + 'an optional target CPA, or Maximize conversion value with an optional target ROAS), dates, retail (Merchant Center '
    + 'feed, feed label, local products), locations, languages, schedule, brand guidelines (on by default: the business name '
    + 'and one to five logos are the campaign\'s brandAssets) with colors and font, other campaign assets by id, Google\'s '
    + 'automation (final URL expansion and text customization OFF unless asked), URL exclusions, brand exclusions (brand '
    + 'lists), negative keywords, tracking; and asset groups with final URLs, paths, their assets (headlines, long headlines, '
    + 'descriptions, images from a link or the Nexus image library, YouTube videos, call to action, existing assets by id — '
    + 'Google\'s minimums are checked first and refused in words), a retail product tree of any shape (default "All '
    + 'products"), and signals (existing audiences, new audiences made of segments, search themes). A campaign may be a copy '
    + 'of a live Performance Max campaign (copyOf). Use it, not a change plan, when new parts point at new parts. Undo removes '
    + 'the campaigns it made.' + GOOGLE_CHANGE_RULES,
  undo: buildUndo,
  handler: (args, ctx) => {
    const refused = libraryRefusal(buildImages((args.campaigns as CampaignArgs[]) ?? []).map(([, s]) => s), ctx)
    return refused ? Promise.resolve(refused) : googleChangePreview(args, ctx, buildPmaxBuilder(args))
  },
  execute: (args, ctx) => runGoogleChange(args, ctx, buildPmaxBuilder(args), (draft, responses) => {
    const after = buildRecordAfterRun(draft.after as BuildRecord, responses)
    return { data: { made: after }, before: { campaigns: [] }, after }
  }),
}

const copyArgs = (args: Record<string, unknown>): Record<string, unknown> => ({
  ...(args.accountId ? { accountId: args.accountId } : {}),
  campaigns: [{
    copyOf: args.campaignId,
    name: args.name,
    ...(args.dailyBudgetCents ? { dailyBudgetCents: args.dailyBudgetCents } : {}),
    ...(args.startDate ? { startDate: args.startDate } : {}),
    ...(args.endDate ? { endDate: args.endDate } : {}),
  }],
})

const copyGooglePmax: AgentTool = {
  ...buildCommon,
  name: 'copy-google-pmax',
  title: 'Copy a Performance Max campaign (paused)',
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the Performance Max campaign to copy'),
    name: textArg(255, 'the copy\'s name (unique in the account)'),
    dailyBudgetCents: googleCentsArg('the copy\'s daily budget (default: the same amount)').optional(),
    startDate: dayArg('first day').optional(),
    endDate: dayArg('last day').optional(),
    why: googleWhyArg,
  }),
  description:
    'Copy a live Performance Max campaign of the business\'s chosen account into a NEW campaign, made PAUSED, in one '
    + 'request: its own budget of the same amount, bidding, Merchant Center feed, locations, languages, schedule, brand '
    + 'guidelines with the same brand assets, every campaign asset, Google\'s automation switches as they are, URL and '
    + 'brand exclusions, negative keywords, tracking (templates, URL suffixes and custom parameters, of the campaign and of each '
    + 'asset group), the brand targeting override for Shopping ads, the asset types it does not inherit, and every asset group '
    + 'with its final URLs, paths, status, assets (the '
    + 'same assets linked again — Google\'s own automatically created ones are not), product tree and signals. What it '
    + 'cannot copy is named in the preview (the campaign\'s conversion goals and customer acquisition are never copied; an '
    + 'audience that belongs to one asset group stays there). Undo removes the copy.' + GOOGLE_CHANGE_RULES,
  undo: buildUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildPmaxBuilder(copyArgs(args))),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildPmaxBuilder(copyArgs(args)), (draft, responses) => {
    const after = buildRecordAfterRun(draft.after as BuildRecord, responses)
    return { data: { made: after }, before: { campaigns: [] }, after }
  }),
}

// ── set-google-pmax ─────────────────────────────────────────────────────────────────────────────────────────────

const changeRequest = (args: Record<string, unknown>): PmaxChangeRequest => ({
  campaignId: String(args.campaignId),
  settings: args.settings as PmaxChangeRequest['settings'],
  automation: args.automation as PmaxChangeRequest['automation'],
  urlExclusions: args.urlExclusions as PmaxChangeRequest['urlExclusions'],
  brandExclusions: args.brandExclusions as PmaxChangeRequest['brandExclusions'],
  brandAssets: args.brandAssets as PmaxChangeRequest['brandAssets'],
  assetGroups: args.assetGroups as PmaxChangeRequest['assetGroups'],
})

const changeImages = (r: PmaxChangeRequest): Array<[string, ImageSource]> => [
  ...imageSlotsOf('brand', r.brandAssets?.add),
  ...(r.assetGroups ?? []).flatMap((g, gi) => imageSlotsOf(`g${gi}`, g.addAssets)),
]

const buildChange = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = changeRequest(args)
  const target = account.target
  const campaign = await livePmaxCampaign(target, request.campaignId)
  const campaignNames = request.settings?.name !== undefined ? (await liveCampaigns(target)).map((c) => ({ campaignId: c.campaignId, name: c.name })) : []
  const groups = request.assetGroups ?? []
  const linkIds = [...linkIdsOf(request.brandAssets?.add), ...groups.flatMap((g) => linkIdsOf(g.addAssets))]
  const assets = await livePmaxAssets(target, linkIds)
  const audiences = groups.some((g) => g.addSignals?.audiences?.length || g.addSignals?.newAudiences?.length) ? await livePmaxAudiences(target) : []
  const brandLists = request.brandExclusions?.add?.length || request.brandExclusions?.remove?.length ? await liveBrandLists(target) : []
  const images = await fetchImages(changeImages(request))
  return pmaxChangeDraft(customerResource(target), account.currency, request, { campaign, campaignNames, assets, audiences, brandLists, images })
}

const linksOfKeys = (keys: string[]) => keys.map((k) => ({ assetId: k.slice(0, k.indexOf('~')), fieldType: k.slice(k.indexOf('~') + 1) }))
const minus = (a: string[] | undefined, b: string[] | undefined) => (a ?? []).filter((x) => !(b ?? []).includes(x))

const pmaxUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as PmaxChangeRecord & Stamped
    const account = await recordAccount(after)
    if (!account || !after.campaignId) return null
    const camp = await livePmaxCampaign(account.target, after.campaignId)
    if (!camp) return null
    return {
      campaignId: after.campaignId,
      campaign: campaignFactsOf(camp, after.campaign ?? {}),
      groups: (after.groups ?? []).map((g) => {
        const live = camp.assetGroups.find((x) => x.assetGroupId === g.assetGroupId)
        return live ? groupFactsOf(live, g) : { assetGroupId: g.assetGroupId, gone: true }
      }),
      accountId: account.accountId,
      customerId: account.customerId,
    }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as PmaxChangeRecord & Stamped
    const after = (change.after ?? {}) as PmaxChangeRecord & Stamped
    if (!after.campaignId) return { refusal: 'This change does not record the campaign it changed.' }
    if (JSON.stringify(after).includes('tmp:-')) return { refusal: 'Google did not return the ids of what this change made: change it back in Google Ads (or set-google-pmax).' }
    const bc = before.campaign ?? {}
    const ac = after.campaign ?? {}
    const args: Record<string, unknown> = { ...accountArgOf(after), campaignId: after.campaignId }
    const settings: Record<string, unknown> = {}
    if ('name' in ac && bc.name) settings.name = bc.name
    if ('bidding' in ac) {
      if (!bc.bidding) return { refusal: 'The campaign\'s bidding before this change is not one Nexus can set again.' }
      settings.bidding = bc.bidding
    }
    if ('startDate' in ac && bc.startDate) settings.startDate = bc.startDate
    if ('endDate' in ac && bc.endDate) settings.endDate = bc.endDate
    if (Object.keys(settings).length) args.settings = settings
    if (ac.automation) args.automation = Object.fromEntries(Object.entries(bc.automation ?? {}).map(([k, v]) => [k, v === 'OPTED_IN']))
    if ('urlExclusions' in ac) {
      const add = minus(bc.urlExclusions, ac.urlExclusions).map(urlExclusionOfKey)
      const remove = minus(ac.urlExclusions, bc.urlExclusions).map(urlExclusionOfKey)
      args.urlExclusions = { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) }
    }
    if ('brandExclusions' in ac) {
      const add = minus(bc.brandExclusions, ac.brandExclusions)
      const remove = minus(ac.brandExclusions, bc.brandExclusions)
      args.brandExclusions = { ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) }
    }
    if ('brandLinks' in ac) {
      const link = linksOfKeys(minus(bc.brandLinks, ac.brandLinks))
      const remove = linksOfKeys(minus(ac.brandLinks, bc.brandLinks))
      args.brandAssets = { ...(link.length ? { add: { link } } : {}), ...(remove.length ? { remove } : {}) }
    }
    const groups: Array<Record<string, unknown>> = []
    for (const g of after.groups ?? []) {
      if (g.created) {
        // An asset group it made is paused again (Nexus removes nothing for an undo; a paused asset group spends nothing).
        if (g.status === 'ENABLED') groups.push({ assetGroupId: g.assetGroupId, status: 'PAUSED' })
        continue
      }
      const b = (before.groups ?? []).find((x) => x.assetGroupId === g.assetGroupId) ?? ({ assetGroupId: g.assetGroupId } as PmaxGroupFacts)
      const entry: Record<string, unknown> = { assetGroupId: g.assetGroupId }
      if ('name' in g && b.name) entry.name = b.name
      if ('status' in g && b.status) entry.status = b.status
      if ('finalUrls' in g && b.finalUrls?.length) entry.finalUrls = b.finalUrls
      if ('finalMobileUrls' in g) entry.finalMobileUrls = b.finalMobileUrls ?? []
      if ('path1' in g) entry.path1 = b.path1 ?? ''
      if ('path2' in g) entry.path2 = b.path2 ?? ''
      if ('links' in g) {
        const link = linksOfKeys(minus(b.links, g.links))
        const remove = linksOfKeys(minus(g.links, b.links))
        if (link.length) entry.addAssets = { link }
        if (remove.length) entry.removeAssets = remove
      }
      if ('tree' in g) {
        if (!b.tree) entry.clearProductGroups = true
        else {
          const spec = pmaxSpecOfSnapshot(b.tree)
          if ('refusal' in spec) return { refusal: `The product tree of asset group ${g.assetGroupId} before this change cannot be given again: ${spec.refusal}.` }
          entry.productGroups = spec
        }
      }
      if ('signals' in g) {
        const back = minus(b.signals, g.signals)
        const off = minus(g.signals, b.signals)
        const pick = (keys: string[], kind: 'a' | 't') => keys.filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(2))
        if (back.length) entry.addSignals = { ...(pick(back, 'a').length ? { audiences: pick(back, 'a') } : {}), ...(pick(back, 't').length ? { searchThemes: pick(back, 't') } : {}) }
        if (off.length) entry.removeSignals = { ...(pick(off, 'a').length ? { audiences: pick(off, 'a') } : {}), ...(pick(off, 't').length ? { searchThemes: pick(off, 't') } : {}) }
      }
      if (Object.keys(entry).length > 1) groups.push(entry)
    }
    if (groups.length) args.assetGroups = groups
    if (Object.keys(args).length === Object.keys(accountArgOf(after)).length + 1) {
      return { refusal: 'This change only made paused asset groups (and assets): there is nothing to put back — a paused asset group spends nothing.' }
    }
    return { tool: 'set-google-pmax', args: { ...args, why: 'undo of an earlier Performance Max change' } }
  },
}

const groupChangeArg = z.object({
  assetGroupId: googleIdArg('an existing asset group (left out = a new one: give name and finalUrls)').optional(),
  name: textArg(128, 'its (new) name, unique in the campaign').optional(),
  status: z.enum(['ENABLED', 'PAUSED']).optional().describe('ENABLED (SPENDS MONEY in an enabled campaign) or PAUSED'),
  finalUrls: z.array(urlArg('a final URL')).min(1).max(10).optional().describe('its final URLs (all of them)'),
  finalMobileUrls: z.array(urlArg('a mobile final URL')).max(10).optional().describe('its mobile final URLs (all of them; [] clears them)'),
  path1: z.string().trim().max(30).optional().describe('display path 1 (15 characters; "" clears it and path 2)'),
  path2: z.string().trim().max(30).optional().describe('display path 2 (15 characters; "" clears it)'),
  addAssets: assetsArg.optional().describe('assets to add (Google\'s minimums and maximums are checked on what it holds after)'),
  removeAssets: z.array(assetRefArg).max(100).optional().describe('assets to unlink (they stay in the account)'),
  productGroups: z.array(pmaxTreeNodeArg).min(1).max(250).optional().describe('retail: the WHOLE product group tree as it should be, the root first (what stays keeps its id)'),
  clearProductGroups: z.boolean().optional().describe('retail: remove the whole product group tree (the asset group then shows no products)'),
  addSignals: signalsArg.optional().describe('signals to add (SPENDS MONEY in an enabled campaign and asset group)'),
  removeSignals: z.object({
    audiences: z.array(googleIdArg('an audience signal\'s audience')).max(50).optional().describe('audience signals to remove'),
    searchThemes: z.array(textArg(80, 'a search theme')).max(50).optional().describe('search themes to remove'),
  }).optional().describe('signals to remove'),
  enable: z.boolean().optional().describe('a NEW asset group in an ENABLED campaign is made PAUSED unless this is true (SPENDS MONEY)'),
})

const setGooglePmax: AgentTool = {
  ...common,
  name: 'set-google-pmax',
  title: 'Change a Performance Max campaign',
  reversibility: 'full',
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: PMAX_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the Performance Max campaign'),
    settings: z.object({
      name: textArg(255, 'a new name (unique in the account)').optional(),
      bidding: biddingArg.optional().describe('bidding (a higher target CPA, a lower target ROAS or a new strategy is marked SPENDS MONEY)'),
      startDate: dayArg('first day').optional(),
      endDate: z.string().trim().regex(/^(\d{4}-\d{2}-\d{2}|none)$/).optional().describe('last day (YYYY-MM-DD), or none'),
    }).optional().describe('the campaign\'s name, bidding and dates (its budget: set-google-budget)'),
    automation: automationArg.optional(),
    urlExclusions: z.object({
      add: z.array(urlExclusionArg).max(100).optional().describe('URL exclusions to add'),
      remove: z.array(urlExclusionArg).max(100).optional().describe('URL exclusions to take off (SPENDS MONEY with final URL expansion on, in an enabled campaign)'),
    }).optional().describe('pages final URL expansion never uses (negative webpage criteria)'),
    brandExclusions: z.object({
      add: z.array(googleIdArg('a brand list')).max(10).optional().describe('brand lists to exclude'),
      remove: z.array(googleIdArg('a brand list')).max(10).optional().describe('brand lists to take off (SPENDS MONEY in an enabled campaign)'),
    }).optional().describe('brand exclusions (brand lists: set-google-exclusion-list makes and fills them)'),
    brandAssets: z.object({
      add: assetsArg.optional().describe('a business name and logos to link to the campaign'),
      remove: z.array(assetRefArg).max(10).optional().describe('brand assets to unlink (exactly one business name and one to five logos stay)'),
    }).optional().describe('with brand guidelines on: the campaign\'s business name and logos'),
    assetGroups: z.array(groupChangeArg).max(20).optional().describe('asset groups to change, or to make (no assetGroupId)'),
    why: googleWhyArg,
  }),
  description:
    'Change a live Performance Max campaign of the business\'s chosen account, in ONE request: its asset groups (make one, '
    + 'rename, pause or enable, final URLs and mobile final URLs, display paths), their assets (add headlines, long '
    + 'headlines, descriptions, images from a link or the Nexus image library, YouTube videos, call to action, existing '
    + 'assets by id; unlink assets — Google\'s minimums and maximums are checked on what each asset group holds after), a '
    + 'retail asset group\'s product tree of any shape (the whole tree as it should be; what stays keeps its id), signals '
    + '(add / remove audiences, new audiences made of segments, search themes); and the campaign\'s name, bidding (Maximize '
    + 'conversions / conversion value and their targets), dates, Google\'s automation (final URL expansion, text '
    + 'customization, image and video enhancement), URL exclusions, brand exclusions (brand lists) and, with brand '
    + 'guidelines, its business name and logos. In an enabled campaign, enabling, a bidding raise, final URL expansion on, '
    + 'an exclusion taken off, new signals and a product tree that advertises more are marked SPENDS MONEY; a new asset '
    + 'group is made PAUSED there unless enable is true. Budget: set-google-budget; status of the campaign: set-google-status. '
    + 'Undo puts back what it changed (an asset group it made is paused; assets it made stay in the account).' + GOOGLE_CHANGE_RULES,
  undo: pmaxUndo,
  handler: (args, ctx) => {
    const refused = libraryRefusal(changeImages(changeRequest(args)).map(([, s]) => s), ctx)
    return refused ? Promise.resolve(refused) : googleChangePreview(args, ctx, buildChange(args))
  },
  execute: (args, ctx) => runGoogleChange(args, ctx, buildChange(args), (draft, responses) => {
    const after = pmaxRecordAfterRun(draft.after as PmaxChangeRecord, draft.operations, responses)
    const made = (after.groups ?? []).filter((g) => g.created).map((g) => ({ assetGroupId: g.assetGroupId, name: g.name }))
    return { data: { campaignId: after.campaignId, ...(made.length ? { madeAssetGroups: made } : {}) }, before: draft.before, after }
  }),
}

// ── set-google-customer-acquisition ─────────────────────────────────────────────────────────────────────────────

const acquisitionRequest = (args: Record<string, unknown>): AcquisitionRequest => ({
  accountGoal: args.accountGoal as AcquisitionRequest['accountGoal'],
  campaignId: args.campaignId as string | undefined,
  mode: args.mode as AcquisitionRequest['mode'],
  valueOverride: args.valueOverride as AcquisitionRequest['valueOverride'],
  clearValueOverride: args.clearValueOverride as boolean | undefined,
})

async function acquisitionLive(target: GoogleAdsTarget, campaignId: string | undefined) {
  const { goal, config } = await liveAcquisition(target, campaignId)
  const campaign = campaignId ? (await liveCampaigns(target)).find((c) => c.campaignId === campaignId) ?? null : null
  return { goal, config, campaign: campaign ? { campaignId: campaign.campaignId, name: campaign.name, status: campaign.status } : null }
}

const buildAcquisition = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const request = acquisitionRequest(args)
  return acquisitionDraft(customerResource(account.target), account.currency, request, await acquisitionLive(account.target, request.campaignId))
}

/** Goals and CampaignGoalConfigs are not GoogleAdsService.Mutate: one call each, with Google's own check (validate_only). */
const ACQUISITION_SENDER: GoogleSender = { send: sendAccountOperations, check: checkAccountOperations }

const acquisitionUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as AcquisitionRecord & Stamped
    const account = await recordAccount(after)
    if (!account) return null
    const live = await acquisitionLive(account.target, after.kind === 'campaign' ? after.campaignId : undefined)
    const stamp = { accountId: account.accountId, customerId: account.customerId }
    if (after.kind === 'account') return { kind: 'account', existed: !!live.goal, valueCents: live.goal?.valueCents ?? null, highValueCents: live.goal?.highValueCents ?? null, ...stamp }
    const mode = live.config ? (live.config.mode === 'TARGET_SPECIFIC' ? 'ONLY_NEW' : 'BID_HIGHER') : 'OFF'
    return { kind: 'campaign', campaignId: after.campaignId, mode, valueCents: live.config?.valueCents ?? null, highValueCents: live.config?.highValueCents ?? null, ...stamp }
  },
  request(change: ToolChange) {
    const before = (change.before ?? {}) as AcquisitionRecord & Stamped
    const after = (change.after ?? {}) as AcquisitionRecord & Stamped
    if (before.kind === 'account') {
      if (!before.existed || before.valueCents === null) return { refusal: 'This change made the account\'s new-customer goal: Google has no removal of a goal. Set its value with set-google-customer-acquisition accountGoal, or turn campaigns OFF.' }
      return {
        tool: 'set-google-customer-acquisition',
        args: { ...accountArgOf(after), accountGoal: { newCustomerValueCents: before.valueCents, ...(before.highValueCents !== null ? { highValueCents: before.highValueCents } : {}) }, why: 'undo of an earlier change of the new-customer goal' },
      }
    }
    if (before.kind !== 'campaign') return { refusal: 'This change does not record what it replaced.' }
    return {
      tool: 'set-google-customer-acquisition',
      args: {
        ...accountArgOf(after), campaignId: before.campaignId, mode: before.mode,
        ...(before.mode === 'BID_HIGHER' && before.valueCents === null ? { clearValueOverride: true } : {}),
        ...(before.mode === 'BID_HIGHER' && before.valueCents !== null ? { valueOverride: { newCustomerValueCents: before.valueCents, ...(before.highValueCents !== null ? { highValueCents: before.highValueCents } : {}) } } : {}),
        why: 'undo of an earlier customer acquisition change',
      },
    }
  },
}

const valuesArg = (what: string) => z.object({
  newCustomerValueCents: z.coerce.number().int().min(0).max(100_000_000).describe('how much more a new customer\'s purchase is worth, in minor units (cents) of the account\'s currency'),
  highValueCents: z.coerce.number().int().min(1).max(100_000_000).optional().describe('the same for a new customer Google sees as high-value (more than newCustomerValueCents)'),
}).describe(what)

const setGoogleCustomerAcquisition: AgentTool = {
  ...common,
  name: 'set-google-customer-acquisition',
  title: 'Set Google Ads customer acquisition',
  reversibility: 'partial',
  requires: [F.adsCampaignsManage, ADSPEND],
  restrictedFields: PMAX_MONEY,
  input: z.object({
    accountId: googleAccountArg,
    accountGoal: valuesArg('the account\'s new-customer acquisition goal: the value Google adds to a new customer\'s purchase (made when the account has none)').optional(),
    campaignId: googleIdArg('a campaign (Performance Max, Search, Shopping …)').optional(),
    mode: z.enum(['BID_HIGHER', 'ONLY_NEW', 'OFF']).optional().describe('the campaign: BID_HIGHER (new and existing customers, new ones bid higher), ONLY_NEW (new customers only) or OFF (remove the campaign\'s own setting)'),
    valueOverride: valuesArg('BID_HIGHER: this campaign\'s own value of a new customer (else the account goal\'s)').optional(),
    clearValueOverride: z.boolean().optional().describe('BID_HIGHER: take the campaign\'s own value off, so it bids with the account goal\'s (a higher one is SPENDS MONEY)'),
    why: googleWhyArg,
  }),
  description:
    'Customer acquisition of the business\'s chosen Google Ads account (Google\'s lifecycle goals): either the account\'s '
    + 'new-customer goal — the value Google adds to a new customer\'s purchase (accountGoal) — or ONE campaign\'s use of it '
    + '(campaignId + mode BID_HIGHER, ONLY_NEW or OFF, and an optional value override). They are two Google services, so they '
    + 'are two requests: the account goal first. A higher value, a campaign moved to BID_HIGHER or let out of ONLY_NEW are '
    + 'marked SPENDS MONEY. Undo puts the old value or mode back (a goal it made cannot be removed: Google has no removal).'
    + GOOGLE_CHANGE_RULES,
  undo: acquisitionUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildAcquisition(args), ACQUISITION_SENDER),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildAcquisition(args), (draft, responses) => {
    const result = responses[0]?.accountResult?.resourceName ?? null
    return { data: { resourceName: result }, before: draft.before, after: draft.after }
  }, ACQUISITION_SENDER),
}

export const GOOGLE_ADS_PMAX_TOOLS: AgentTool[] = [buildGooglePmax, copyGooglePmax, setGooglePmax, setGoogleCustomerAcquisition]


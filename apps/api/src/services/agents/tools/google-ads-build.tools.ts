/**
 * Google Ads changes, PR 6 (2026-10-15) — build and copy whole campaigns, and check a change without asking for it.
 *
 *   build-google-campaigns   new shared budgets, negative keyword lists and campaigns (each PAUSED) with every part, in
 *                            ONE atomic request (temporary ids): what a change plan cannot do, as a later step cannot
 *                            point at a campaign an earlier one has not made when Google checks the plan
 *   copy-google-campaign     a live campaign into a NEW paused campaign: settings, targeting, negatives and lists, ad
 *                            groups, keywords, product groups, ads, campaign assets
 *   check-google-ads-build   read only: Google checks a build (validate_only) and the answer is its preview —
 *                            nothing is asked for, nothing waits in Approvals
 *
 * G13 (2026-10-16, build/copy parity): a build takes, and a copy carries, everything the newer change tools set on a
 * Search or Standard Shopping campaign — devices, location bids and radius, audiences and demographics, labels, URLs and
 * tracking at every level, ad rotation, the inventory filter and Shopping settings, assets of every type at the campaign
 * and its ad groups, exclusions, brand and placement lists, conversion goals (change-build.ts, build-copy.ts). Another
 * campaign type is refused by the copy with the tool for it (copy-google-pmax; the create tools of G11).
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import type { AgentTool, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import {
  googleAccountArg, googleCentsArg, googleChangePreview, googleCheck, googleIdArg, googleWhyArg, GOOGLE_CHANGE_RULES, matchTypeArg, recordAccount, runGoogleChange,
  type GoogleDraftBuilder,
} from './google-ads-kit.js'
import { buildDraft, buildRecordAfterRun, type BuildAssets, type BuildCampaign, type BuildRecord, type BuildSpec } from '../../marketing/google-ads/change-build.js'
import { campaignAsBuild, listAsBuild } from '../../marketing/google-ads/build-copy.js'
import { DAYS } from '../../marketing/google-ads/change-campaigns.js'
import { LINK_FIELD_TYPES, MAX_IMAGE_BYTES_TOTAL } from '../../marketing/google-ads/change-assets-all.js'
import { ACTION_CATEGORIES, GOAL_ORIGINS } from '../../marketing/google-ads/change-conversions.js'
import { liveBudgets, liveCampaigns, liveNegativeLists } from '../../marketing/google-ads/live.js'
import { livePageFeeds } from '../../marketing/google-ads/live-pmax.js'
import { CONTENT_LABELS, EXCLUSION_KINDS } from '../../marketing/google-ads/live-exclusions.js'
import { AUDIENCE_KINDS, DEMOGRAPHIC_DIMENSIONS, DEMOGRAPHIC_VALUES, DEVICES } from '../../marketing/google-ads/live-targeting.js'
import { prepareImage, type PreparedImage } from '../../marketing/google-ads/asset-images.js'
import { customerResource } from '../../marketing/google-ads/write-client.js'
import { buildNodesOfSpec, MAX_TREE_NODES } from '../../marketing/google-ads/product-tree.js'
import { dimensionArg, dimensionValueArg, treeNodeArg } from './google-ads-product-groups.tools.js'
import { libraryRefusal, NEW_ASSET_ARGS } from './google-ads-assets-all.tools.js'

const ADSPEND = FIELDS.financialsAdspendView
const BUILD_MONEY = { changes: ADSPEND, warnings: ADSPEND, spendsMoneyBecause: ADSPEND, dailyBudgetCents: ADSPEND, defaultBidCents: ADSPEND, maxCpcCents: ADSPEND, targetCpaCents: ADSPEND, targetRoas: ADSPEND } as const

const common = {
  category: 'advertising',
  riskTier: 'high' as const,
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  openWorld: true,
  maxClaudeTrust: 'ask' as const,
  // Undo removes what the build made; ids Google has not given back (a failed record) cannot be removed.
  reversibility: 'partial' as const,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, ADSPEND] as const,
  restrictedFields: BUILD_MONEY,
}

// ── arguments ───────────────────────────────────────────────────────────────────────────────────────────────────

const refArg = z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/).describe('a short name of your choice that other parts of the build point at')
const textArg = (max: number, what: string) => z.string().trim().min(1).max(max).describe(what)
const negativeArg = z.object({ text: textArg(80, 'the negative keyword'), matchType: matchTypeArg })
const pinArg = z.enum(['HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3', 'DESCRIPTION_1', 'DESCRIPTION_2']).optional().describe('pin to a position (optional)')
const statusArg = z.enum(['ENABLED', 'PAUSED']).optional().describe('ENABLED (default; the campaign is paused) or PAUSED')
const budgetChoice = z.object({
  ref: refArg.optional(),
  budgetId: googleIdArg('an existing shared budget').optional(),
  dailyBudgetCents: googleCentsArg('a new budget of its own').optional(),
}).describe('its budget: ref (a shared budget of this build), budgetId (an existing shared budget) or dailyBudgetCents (its own) — one')
const listChoice = z.object({ ref: refArg.optional(), listId: googleIdArg('an existing negative keyword list').optional() }).describe('a list of this build (ref) or an existing one (listId)')

// G13: what the newer change tools set, in their own shapes (set-google-targeting, set-google-audiences,
// set-google-demographics, set-google-urls, set-google-labels, set-google-inventory-filter, set-google-campaign-exclusions,
// set-google-conversion-goals, add-google-assets / set-google-asset-links).
const upper = (v: unknown) => (typeof v === 'string' ? v.trim().toUpperCase() : v)
const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)
/** A bid factor, rounded to 4 decimals as Google reads adjustments back. */
const round4 = (v: number) => Math.round(v * 10_000) / 10_000
const factorArg = z.coerce.number().min(0.1).max(10).transform(round4)
const urlArgs = {
  trackingTemplate: z.string().trim().min(1).max(2048).optional().describe('tracking template (starts with http://, https:// or {lpurl})'),
  finalUrlSuffix: z.string().trim().min(1).max(2048).optional().describe('final URL suffix (key=value&key2=value2; no leading ? or &)'),
  customParameters: z.array(z.object({
    key: z.string().trim().min(1).max(16).describe('the name (letters and digits; {_name} in a URL)'),
    value: z.string().trim().min(1).max(250).describe('its value'),
  })).max(8).optional().describe('custom parameters (up to 8)'),
}
const labelsArg = z.array(googleIdArg('a label of the account (google-ads-live view labels; set-google-labels makes one)')).max(50).optional().describe('labels to put on it')
const devicesArg = z.array(z.object({
  device: z.preprocess(upper, z.enum(DEVICES)).describe('MOBILE, DESKTOP, TABLET or CONNECTED_TV'),
  bidModifier: z.coerce.number().min(0).max(10).refine((v) => v === 0 || v >= 0.1, '0 (never on this device) or 0.1–10').transform(round4)
    .describe('a factor: 1.2 = +20 %, 0.5 = −50 %, 0 = never on this device'),
})).max(4).optional().describe('device bid adjustments')
const audiencesArg = (where: string) => z.array(z.object({
  kind: z.preprocess(upper, z.enum(AUDIENCE_KINDS)).describe('USER_LIST (your data), USER_INTEREST (affinity, in-market), CUSTOM_AUDIENCE, COMBINED_AUDIENCE or LIFE_EVENT'),
  id: googleIdArg('the segment (google-ads-live view lookup, lookup user-lists / audiences / custom-audiences / combined-audiences / life-events)'),
  exclude: z.boolean().optional().describe('true = excluded (not for custom or combined segments)'),
  bidModifier: factorArg.optional().describe('its bid adjustment as a factor (not when excluded)'),
})).max(100).optional().describe(`audience segments ${where} (targeted or observed as audienceMode says; default observation)`)
const audienceModeArg = z.enum(['OBSERVATION', 'TARGETING']).optional()
  .describe('OBSERVATION (audiences only adjust bids; default) or TARGETING (only those people see the ads); on the campaign OR on its ad groups')
const ALL_DEMOGRAPHIC_VALUES = [...new Set(Object.values(DEMOGRAPHIC_VALUES).flat())] as [string, ...string[]]
const demographicsArg = (where: string) => z.array(z.object({
  dimension: z.preprocess(upper, z.enum(DEMOGRAPHIC_DIMENSIONS as [typeof DEMOGRAPHIC_DIMENSIONS[number], ...typeof DEMOGRAPHIC_DIMENSIONS])).describe('AGE_RANGE, GENDER, PARENTAL_STATUS or INCOME_RANGE'),
  value: z.preprocess(upper, z.enum(ALL_DEMOGRAPHIC_VALUES)).describe(`Google's name of the group: ${Object.entries(DEMOGRAPHIC_VALUES).map(([d, v]) => `${d}: ${v.join(', ')}`).join('; ')}`),
  exclude: z.boolean().optional().describe('true = excluded'),
  bidModifier: factorArg.optional().describe('a shown group\'s bid adjustment (a shown group narrows its dimension to the shown groups: give every group to show)'),
})).max(30).optional().describe(`demographics ${where}, each criterion as it is made`)
const radiusArg = z.object({
  latitude: z.coerce.number().min(-90).max(90).optional().describe('the centre\'s latitude in degrees (with longitude), or give address'),
  longitude: z.coerce.number().min(-180).max(180).optional().describe('the centre\'s longitude in degrees'),
  address: z.object({
    street: z.string().trim().min(1).max(200).optional().describe('street and number'),
    city: z.string().trim().min(1).max(100).optional().describe('city'),
    postalCode: z.string().trim().min(1).max(20).optional().describe('postal code'),
    countryCode: z.string().trim().regex(/^[A-Za-z]{2}$/).describe('two-letter country code'),
  }).optional().describe('an address Google turns into the centre (instead of latitude / longitude)'),
  radius: z.coerce.number().min(0.1).max(800).describe('the radius'),
  units: z.enum(['KILOMETERS', 'MILES']).optional().describe('KILOMETERS (default) or MILES'),
  bidModifier: factorArg.optional().describe('its bid adjustment as a factor'),
})
const exclusionArg = z.object({
  kind: z.preprocess(lower, z.enum(EXCLUSION_KINDS)).describe('placement (a website), youtube-channel, youtube-video, mobile-app, app-category, content-label or ip-block'),
  value: z.string().trim().min(1).max(260).describe(`the website, channel id, video id, app id ("1-<App Store id>" / "2-<package name>"), app category id, content label (${CONTENT_LABELS.join(', ')}) or IP address / CIDR block`),
})
const assetsArg = (where: string) => z.object({
  ...NEW_ASSET_ARGS,
  link: z.array(z.object({
    assetId: googleIdArg('an asset of the account (google-ads-live view asset-links)'),
    fieldType: z.preprocess(upper, z.enum(LINK_FIELD_TYPES)).describe(`as what: ${LINK_FIELD_TYPES.join(', ')} (where Google allows each)`),
    status: z.enum(['ENABLED', 'PAUSED']).optional().describe('the link\'s status (default ENABLED)'),
  })).max(50).optional().describe('existing assets to link'),
}).optional().describe(`${where} assets: new ones of every type (made and linked here) and existing ones linked`)

const campaignArg = z.object({
  copyOf: googleIdArg('copy this live campaign (every part, made PAUSED); the fields below then override it').optional(),
  type: z.enum(['SHOPPING', 'SEARCH']).optional().describe('SHOPPING (Standard Shopping) or SEARCH; not with copyOf'),
  name: textArg(255, 'the new campaign\'s name (unique in the account)'),
  budget: budgetChoice.optional(),
  bidding: z.object({
    strategy: z.enum(['MANUAL_CPC', 'MAXIMIZE_CLICKS', 'MAXIMIZE_CONVERSIONS', 'MAXIMIZE_CONVERSION_VALUE', 'PORTFOLIO', 'TARGET_IMPRESSION_SHARE']).describe('the bid strategy'),
    maxCpcCents: googleCentsArg('MAXIMIZE_CLICKS or TARGET_IMPRESSION_SHARE (required there): the max CPC ceiling').optional(),
    location: z.enum(['ANYWHERE_ON_PAGE', 'TOP_OF_PAGE', 'ABSOLUTE_TOP_OF_PAGE']).optional().describe('TARGET_IMPRESSION_SHARE: where on the page'),
    impressionSharePercent: z.coerce.number().min(0.01).max(100).optional().describe('TARGET_IMPRESSION_SHARE: how often, in % of the searches (e.g. 65)'),
    enhancedCpc: z.boolean().optional().describe('MANUAL_CPC in a SHOPPING campaign: enhanced CPC (Google ignores it on Search: deprecated)'),
    targetCpaCents: googleCentsArg('MAXIMIZE_CONVERSIONS: target CPA').optional(),
    targetRoas: z.coerce.number().min(0.01).max(1000).optional().describe('MAXIMIZE_CONVERSION_VALUE: target ROAS ratio'),
    portfolioId: googleIdArg('PORTFOLIO: the portfolio strategy').optional(),
  }).optional().describe('bidding (default Manual CPC)'),
  startDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('first day (YYYY-MM-DD)'),
  endDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('last day (YYYY-MM-DD)'),
  searchPartners: z.boolean().optional().describe('search partners (default off)'),
  display: z.boolean().optional().describe('SEARCH: Display Network (default off)'),
  shopping: z.object({
    merchantId: googleIdArg('the Merchant Center account'),
    feedLabel: textArg(20, 'the feed label').optional(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().describe('Shopping priority (default LOW)'),
    localInventory: z.boolean().optional().describe('local products too (default off)'),
    ignoreBrandExclusions: z.boolean().optional().describe('true: brand exclusions are ignored for Shopping ads (default false)'),
  }).optional().describe('SHOPPING: the feed'),
  search: z.object({
    aiMax: z.boolean().optional().describe('AI Max (default off)'),
    textCustomization: z.boolean().optional().describe('text customization (default off)'),
    finalUrlExpansion: z.boolean().optional().describe('final URL expansion (default off)'),
  }).optional().describe('SEARCH: what Google may do on its own (all off by default)'),
  locations: z.array(z.object({
    id: googleIdArg('a location (google-ads-live view lookup)'),
    exclude: z.boolean().optional().describe('excluded'),
    bidModifier: z.coerce.number().min(0.1).max(10).optional().describe('a targeted location\'s bid adjustment as a factor'),
  })).max(100).optional().describe('locations'),
  locationOption: z.enum(['PRESENCE', 'PRESENCE_OR_INTEREST', 'SEARCH_INTEREST']).optional().describe('location option (default PRESENCE; SEARCH_INTEREST: people who search for the locations)'),
  negativeLocationOption: z.enum(['PRESENCE', 'PRESENCE_OR_INTEREST']).optional().describe('who an excluded location keeps out (default PRESENCE)'),
  radius: z.array(radiusArg).max(50).optional().describe('radius targets'),
  devices: devicesArg,
  audienceSegments: audiencesArg('at the campaign'),
  audienceMode: audienceModeArg,
  demographics: demographicsArg('at the campaign (Google: exclusions)'),
  labels: labelsArg,
  ...urlArgs,
  inventoryFilter: z.array(z.object({ dimension: dimensionArg, value: dimensionValueArg }).describe('one condition')).max(7).optional()
    .describe('SHOPPING: the inventory filter — only products meeting every condition can be advertised (as set-google-inventory-filter)'),
  exclusions: z.array(exclusionArg).max(250).optional().describe('websites, YouTube channels / videos, apps, app categories, content labels, IP addresses excluded'),
  brandLists: z.array(z.object({ listId: googleIdArg('a brand list (google-ads-live view exclusions)'), mode: z.enum(['exclude', 'include']).describe('exclude, or include (keep to)') })).max(20).optional().describe('brand lists'),
  placementLists: z.array(googleIdArg('a placement exclusion list (google-ads-live view exclusions)')).max(20).optional().describe('placement exclusion lists to attach'),
  // G14b — AI Max's controls of a Search campaign (as set-google-campaign sets them).
  textGuidelines: z.object({
    termExclusions: z.array(z.string().trim().min(1).max(30).describe('an exact word or phrase (at most 30 characters)')).max(25).optional().describe('words the text Google writes never uses'),
    messagingRestrictions: z.array(z.string().trim().min(1).max(300).describe('a plain instruction (at most 300 characters)')).max(40).optional().describe('instructions the text Google writes follows'),
  }).optional().describe('SEARCH (AI Max): text guidelines'),
  pageFeeds: z.array(googleIdArg('a page feed of the account (set-google-page-feed makes one)')).max(100).optional().describe('SEARCH: page feeds (URL inclusions) linked to the campaign'),
  urlExclusions: z.array(z.object({
    contains: z.string().trim().min(1).max(2048).optional().describe('never use a page whose address contains this'),
    equals: z.string().trim().min(1).max(2048).optional().describe('never use this exact page'),
  }).refine((u) => (u.contains === undefined) !== (u.equals === undefined), { message: 'give contains or equals, one of them' }).describe('a landing page never used')).max(250).optional()
    .describe('SEARCH (AI Max): URL exclusions — pages final URL expansion never sends people to'),
  conversionGoals: z.array(z.object({
    category: z.enum(ACTION_CATEGORIES).describe('the goal\'s category (PURCHASE, ADD_TO_CART, …)'),
    origin: z.enum(GOAL_ORIGINS).describe('the goal\'s origin (WEBSITE, …)'),
    biddable: z.boolean().describe('true = the campaign bids for it'),
  })).max(50).optional().describe('the campaign\'s own conversion goals (it then stops following the account\'s goals)'),
  languages: z.array(googleIdArg('a language')).max(50).optional().describe('SEARCH: languages'),
  schedule: z.array(z.object({
    days: z.array(z.preprocess((v) => (typeof v === 'string' ? v.toUpperCase() : v), z.enum([...DAYS, 'ALL']))).min(1).max(7).describe('MONDAY … SUNDAY, or ALL'),
    from: z.string().trim().regex(/^\d{1,2}:\d{2}$/).describe('HH:MM'),
    to: z.string().trim().regex(/^\d{1,2}:\d{2}$/).describe('HH:MM (24:00 = midnight)'),
    bidModifier: z.coerce.number().min(0.1).max(10).optional().describe('the slot\'s bid adjustment as a factor'),
  })).max(42).optional().describe('ad schedule'),
  audiences: z.array(googleIdArg('an audience segment')).max(50).optional().describe('audiences in OBSERVATION'),
  euPoliticalAds: z.boolean().optional().describe('true only for EU political advertising (default false)'),
  negatives: z.array(negativeArg).max(250).optional().describe('campaign-level negative keywords'),
  negativeLists: z.array(listChoice).max(20).optional().describe('shared negative keyword lists to attach'),
  adGroups: z.array(z.object({
    name: textArg(255, 'the ad group name'),
    defaultBidCents: googleCentsArg('the default max CPC').optional(),
    targetCpaCents: googleCentsArg('its own target CPA (Smart Bidding)').optional(),
    targetRoas: z.coerce.number().min(0.01).max(1000).optional().describe('its own target ROAS ratio (Smart Bidding)'),
    status: statusArg,
    adRotation: z.enum(['OPTIMIZE', 'ROTATE_FOREVER']).optional().describe('ad rotation (Google\'s default OPTIMIZE)'),
    ...urlArgs,
    devices: devicesArg,
    audiences: audiencesArg('at the ad group'),
    audienceMode: audienceModeArg,
    demographics: demographicsArg('at the ad group'),
    brandLists: z.array(googleIdArg('a brand list the ad group keeps to')).max(20).optional().describe('brand lists (an ad group takes an inclusion only)'),
    urlInclusions: z.array(z.object({
      urlEquals: z.string().trim().min(1).max(2048).optional().describe('exactly this page (a full https:// URL; alone in its rule)'),
      urlContains: z.array(z.string().trim().min(1).max(2048).describe('a part of the page address')).max(3).optional().describe('pages whose address contains each of these'),
      labels: z.array(z.string().trim().min(1).max(1024).describe('a custom label of a page feed linked to the campaign')).max(3).optional().describe('pages of the linked page feeds with each of these labels'),
    }).describe('one rule: at most three conditions, all must match')).max(250).optional()
      .describe('SEARCH (AI Max and text customization on): URL inclusions — the pages the ad group may send people to'),
    labels: labelsArg,
    productAdLabels: labelsArg.describe('SHOPPING: labels on its product ad'),
    assets: assetsArg('the ad group\'s'),
    keywords: z.array(z.object({
      text: textArg(80, 'the keyword'), matchType: matchTypeArg, bidCents: googleCentsArg('its max CPC').optional(), status: statusArg,
      finalUrl: z.string().trim().url().optional().describe('its own landing page (https)'),
      finalMobileUrl: z.string().trim().url().optional().describe('its own mobile landing page (https)'),
      ...urlArgs,
      labels: labelsArg,
    })).max(250).optional().describe('SEARCH: keywords'),
    negatives: z.array(negativeArg).max(250).optional().describe('ad-group negative keywords'),
    productGroups: z.object({
      itemIds: z.array(textArg(50, 'an item id of the feed')).min(1).max(250).optional().describe('item ids to advertise (with bidCents)'),
      bidCents: googleCentsArg('the bid of each item').optional(),
      itemBids: z.array(z.object({ itemId: textArg(50, 'an item id'), bidCents: googleCentsArg('its bid') })).max(250).optional().describe('bids of single items'),
      includeEverythingElse: z.object({ bidCents: googleCentsArg('its bid') }).optional().describe('ALSO advertise every other product of the feed (default: excluded)'),
      nodes: z.array(treeNodeArg).max(MAX_TREE_NODES).optional().describe('OR a tree of any shape, as set-google-product-groups tree: the root first, each product group naming its parent by index'),
    }).optional().describe('SHOPPING: product groups — split by item id (itemIds + bidCents; "everything else" EXCLUDED unless includeEverythingElse), or any tree (nodes)'),
    ads: z.array(z.object({
      headlines: z.array(z.object({ text: textArg(60, 'a headline (30 wide)'), pin: pinArg })).min(3).max(15).describe('3–15 headlines'),
      descriptions: z.array(z.object({ text: textArg(180, 'a description (90 wide)'), pin: pinArg })).min(2).max(4).describe('2–4 descriptions'),
      path1: z.string().trim().max(30).optional().describe('display path 1 (15 wide)'),
      path2: z.string().trim().max(30).optional().describe('display path 2 (15 wide)'),
      finalUrl: z.string().trim().url().describe('the https landing page'),
      finalMobileUrl: z.string().trim().url().optional().describe('a mobile landing page (https)'),
      ...urlArgs,
      labels: labelsArg,
      status: statusArg,
    })).max(10).optional().describe('SEARCH: responsive search ads'),
  })).max(50).optional().describe('ad groups'),
  assets: assetsArg('the campaign\'s'),
})

const buildInput = {
  accountId: googleAccountArg,
  sharedBudgets: z.array(z.object({ ref: refArg, name: textArg(255, 'the budget name (unique)'), budgetCents: googleCentsArg('its daily amount') })).max(10).optional().describe('new shared budgets'),
  negativeLists: z.array(z.object({
    ref: refArg,
    name: textArg(255, 'the list name (unique)'),
    keywords: z.array(negativeArg).max(250).optional().describe('its negative keywords'),
    copyOf: googleIdArg('copy the keywords of this live list').optional(),
  })).max(10).optional().describe('new negative keyword lists'),
  campaigns: z.array(campaignArg).max(10).describe('new campaigns (each made PAUSED)'),
  allowBroad: z.boolean().optional().describe('allow BROAD keywords (default no)'),
  why: googleWhyArg,
}

type CampaignArgs = z.infer<typeof campaignArg>

/** The ad groups as the build takes them: a product group tree given as nodes is checked against Google's rules and turned into the build's own nodes. */
function adGroupsOf(campaign: string, groups: CampaignArgs['adGroups']): NonNullable<BuildCampaign['adGroups']> | { refusal: string } {
  const out: NonNullable<BuildCampaign['adGroups']> = []
  for (const g of groups ?? []) {
    const pg = g.productGroups
    if (!pg) { out.push(g as NonNullable<BuildCampaign['adGroups']>[number]); continue }
    const where = `Campaign "${campaign}", ad group "${g.name}"`
    if (pg.nodes?.length) {
      if (pg.itemIds?.length || pg.bidCents !== undefined || pg.itemBids?.length || pg.includeEverythingElse) return { refusal: `${where}: give productGroups as itemIds (with bidCents) or as nodes, not both.` }
      const nodes = buildNodesOfSpec(pg.nodes)
      if ('refusal' in nodes) return { refusal: `${where}: ${nodes.refusal}` }
      out.push({ ...(g as NonNullable<BuildCampaign['adGroups']>[number]), productGroups: { nodes } })
      continue
    }
    if (!pg.itemIds?.length || pg.bidCents === undefined) return { refusal: `${where}: give productGroups.itemIds with bidCents, or productGroups.nodes (a tree of any shape).` }
    out.push(g as NonNullable<BuildCampaign['adGroups']>[number])
  }
  return out
}

/**
 * The build with the images of its new assets read (asset-images.ts prepareImage, as add-google-assets reads them): one
 * at a time, nothing sent before all are read; once they pass what one request carries the rest are not fetched (the
 * build refuses and says so). New objects: the arguments themselves are never changed.
 */
async function withImages(campaigns: BuildCampaign[]): Promise<BuildCampaign[]> {
  let bytes = 0
  const read = async (assets: BuildAssets | undefined): Promise<BuildAssets | undefined> => {
    if (!assets?.images?.length) return assets
    const prepared: Array<PreparedImage | { problem: string }> = []
    for (const image of assets.images) {
      if (bytes > MAX_IMAGE_BYTES_TOTAL) { prepared.push({ problem: 'not read: the images before it already pass what one request carries' }); continue }
      const got = await prepareImage(image)
      if (!('problem' in got)) bytes += got.bytes
      prepared.push(got)
    }
    return { ...assets, prepared }
  }
  const out: BuildCampaign[] = []
  for (const c of campaigns) {
    const adGroups = []
    for (const g of c.adGroups ?? []) adGroups.push(g.assets?.images?.length ? { ...g, assets: await read(g.assets) } : g)
    out.push({ ...c, ...(c.assets?.images?.length ? { assets: await read(c.assets) } : {}), ...(c.adGroups ? { adGroups } : {}) })
  }
  return out
}

/** An image from the Nexus image library needs the image library permission, wherever the build uses one (add-google-assets' rule). */
function buildLibraryRefusal(args: Record<string, unknown>, ctx: ToolContext): ToolResult | null {
  const images: unknown[] = []
  for (const c of (args.campaigns as Array<{ assets?: { images?: unknown[] }; adGroups?: Array<{ assets?: { images?: unknown[] } }> }> | undefined) ?? []) {
    images.push(...(c.assets?.images ?? []))
    for (const g of c.adGroups ?? []) images.push(...(g.assets?.images ?? []))
  }
  return libraryRefusal({ images }, ctx)
}

/**
 * A campaign's own conversion goals decide what Smart Bidding bids for: set-google-conversion-goals needs the bids
 * permission, and so does a build that says them (a copy carries the source's goals as they are).
 */
function goalsRefusal(args: Record<string, unknown>, ctx: ToolContext): ToolResult | null {
  const asked = ((args.campaigns as Array<{ conversionGoals?: unknown[] }> | undefined) ?? []).some((c) => !!c.conversionGoals?.length)
  return asked && !ctx.can(F.adsBidsEdit) ? { ok: false, error: `A campaign's own conversion goals (conversionGoals) need the ${F.adsBidsEdit} permission, as set-google-conversion-goals does. Leave them out (the campaign follows the account's goals), or ask a person who has it.` } : null
}

/** The build as asked, with every copyOf read live and expanded. */
async function specOf(account: Parameters<GoogleDraftBuilder>[0], args: Record<string, unknown>): Promise<{ spec: BuildSpec; notCopied: string[]; notes: string[] } | { refusal: string }> {
  const notCopied: string[] = []
  const notes: string[] = []
  const lists: BuildSpec['negativeLists'] = []
  for (const l of (args.negativeLists as Array<{ ref: string; name: string; keywords?: BuildSpec['campaigns'][number]['negatives']; copyOf?: string }>) ?? []) {
    const keywords = l.copyOf ? await listAsBuild(account.target, l.copyOf) : l.keywords ?? []
    lists.push({ ref: l.ref, name: l.name, keywords: keywords ?? [] })
  }
  const campaigns: BuildCampaign[] = []
  for (const raw of (args.campaigns as CampaignArgs[]) ?? []) {
    const budget = raw.budget
      ? (raw.budget.ref ? { ref: raw.budget.ref } : raw.budget.budgetId ? { budgetId: raw.budget.budgetId } : raw.budget.dailyBudgetCents ? { dailyBudgetCents: raw.budget.dailyBudgetCents } : null)
      : null
    if (raw.budget && !budget) return { refusal: `Campaign "${raw.name}": give the budget a ref, a budgetId or dailyBudgetCents.` }
    if (raw.copyOf) {
      const copied = await campaignAsBuild(account.target, raw.copyOf, {
        name: raw.name, ...(budget ? { budget } : {}), ...(raw.startDate ? { startDate: raw.startDate } : {}), ...(raw.endDate ? { endDate: raw.endDate } : {}),
        ...(raw.negativeLists ? { negativeLists: raw.negativeLists.map((l) => (l.ref ? { ref: l.ref } : { listId: l.listId! })) } : {}),
      })
      if ('refusal' in copied) return copied
      notCopied.push(...copied.notCopied.map((n) => `"${raw.name}": ${n}`))
      notes.push(...copied.notes.map((n) => `Copy "${raw.name}": ${n}`))
      const { copyOf: _c, name: _n, budget: _b, startDate: _s, endDate: _e, negativeLists: _l, type: _t, ...rest } = raw
      const { adGroups: given, ...others } = rest
      const adGroups = given ? adGroupsOf(raw.name, given) : copied.campaign.adGroups ?? []
      if (!Array.isArray(adGroups)) return adGroups
      campaigns.push({ ...copied.campaign, ...(others as Partial<BuildCampaign>), adGroups })
      continue
    }
    if (!raw.type) return { refusal: `Campaign "${raw.name}": give type (SHOPPING or SEARCH) or copyOf.` }
    if (!budget) return { refusal: `Campaign "${raw.name}": give its budget.` }
    const { copyOf: _c, budget: _b, negativeLists, ...rest } = raw
    const adGroups = adGroupsOf(raw.name, rest.adGroups)
    if (!Array.isArray(adGroups)) return adGroups
    const { adGroups: _g, ...others } = rest
    campaigns.push({
      ...(others as unknown as BuildCampaign),
      ...(rest.adGroups ? { adGroups } : {}),
      type: raw.type,
      budget,
      bidding: raw.bidding ?? { strategy: 'MANUAL_CPC' },
      ...(negativeLists ? { negativeLists: negativeLists.map((l) => (l.ref ? { ref: l.ref } : { listId: l.listId! })) } : {}),
    } as BuildCampaign)
  }
  return {
    spec: { sharedBudgets: (args.sharedBudgets as BuildSpec['sharedBudgets']) ?? [], negativeLists: lists, campaigns: await withImages(campaigns), allowBroad: args.allowBroad === true },
    notCopied,
    notes,
  }
}

const buildBuilder = (args: Record<string, unknown>): GoogleDraftBuilder => async (account) => {
  const expanded = await specOf(account, args)
  if ('refusal' in expanded) return expanded
  const campaigns = await liveCampaigns(account.target)
  const budgets = await liveBudgets(account.target, campaigns)
  const lists = await liveNegativeLists(account.target)
  const pageFeeds = expanded.spec.campaigns.some((c) => c.pageFeeds?.length) ? await livePageFeeds(account.target) : []
  const draft = buildDraft(customerResource(account.target), account.currency, expanded.spec, { campaigns, budgets, lists, pageFeeds })
  if ('refusal' in draft) return draft
  // How a copy carries a part differently (a standard Target CPA as Maximize conversions with a target CPA, …).
  draft.warnings.push(...expanded.notes)
  // What a copy does not carry: a warning, and every item with its reason in skipped (none hidden).
  if (expanded.notCopied.length) {
    draft.warnings.push(`Not copied (${expanded.notCopied.length}, each with its reason in skipped): ${expanded.notCopied.slice(0, 10).join('; ')}${expanded.notCopied.length > 10 ? ' …' : ''}.`)
    draft.skipped.push(...expanded.notCopied.map((n) => `Not copied — ${n}.`))
  }
  return draft
}

const buildUndo: ToolUndo = {
  async current(change: ToolChange) {
    const after = (change.after ?? {}) as BuildRecord & { accountId?: string; customerId?: string }
    const account = await recordAccount(after)
    if (!account) return null
    const live = await liveCampaigns(account.target)
    // Unchanged = every campaign it made is still there under its name.
    const holds = after.campaigns.every((c) => c.campaignId && live.some((x) => x.campaignId === c.campaignId && x.name === c.name))
    return holds ? after : { ...after, moved: true }
  },
  request(change: ToolChange) {
    const after = (change.after ?? {}) as BuildRecord & { accountId?: string }
    // Everything the build made, campaigns first (remove-google-ads-items sends budgets and lists last).
    const items = [
      ...(after.campaigns ?? []).filter((c) => c.campaignId).map((c) => ({ kind: 'campaign', id: c.campaignId })),
      ...(after.campaigns ?? []).filter((c) => c.ownBudgetId).map((c) => ({ kind: 'budget', id: c.ownBudgetId })),
      ...(after.sharedBudgets ?? []).filter((b) => b.budgetId).map((b) => ({ kind: 'budget', id: b.budgetId })),
      ...(after.negativeLists ?? []).filter((l) => l.listId).map((l) => ({ kind: 'negative-list', id: l.listId })),
    ]
    if (!items.length) return { refusal: 'This build does not record the ids Google gave what it made.' }
    return {
      tool: 'remove-google-ads-items',
      args: { ...(after.accountId ? { accountId: after.accountId } : {}), items, confirmRemove: true, why: 'undo of an earlier build' },
    }
  },
}

const buildGoogleCampaigns: AgentTool = {
  ...common,
  name: 'build-google-campaigns',
  title: 'Build Google Ads campaigns (paused)',
  input: z.object(buildInput),
  description:
    'Build a whole Google Ads structure in the business\'s chosen account in ONE request, all or nothing: new shared '
    + 'budgets, new negative keyword lists (their keywords, or a copy of a live list), and Search or Standard Shopping '
    + 'campaigns — each ALWAYS made PAUSED — with budget, bidding, networks, Google\'s automation (off unless asked), '
    + 'locations with bid adjustments, radius targets, location options, languages, schedule, device bid adjustments, '
    + 'audience segments of every kind (targeted, observed or excluded, bid adjustments; audienceMode, default observation) '
    + 'and demographics at the campaign and its ad groups, labels (campaign, ad group, keyword, ad), tracking template, '
    + 'final URL suffix and custom parameters at every level, keyword final URLs, campaign negatives and lists, exclusions '
    + '(websites, YouTube, apps, content labels, IP addresses), brand lists, placement exclusion lists, the campaign\'s own '
    + 'conversion goals, AI Max\'s text guidelines, page feeds, URL exclusions and ad group URL inclusions (Search), the '
    + 'Shopping inventory filter and settings, ad groups with bids, target CPA / ROAS and ad '
    + 'rotation, keywords with bids (no BROAD unless allowBroad), ad-group negatives, Shopping product groups by item id '
    + '("everything else" excluded unless asked) or as a tree of any shape (nodes), responsive search ads, and assets of '
    + 'every type at the campaign and its ad groups (new: images, business name, call, price, promotion, lead form, app '
    + 'link, sitelinks, callouts, structured snippets — as add-google-assets; or existing ones linked). A campaign may be '
    + 'a copy of a live one (copyOf: every part, as copy-google-campaign). Parts point at each other by ref. Use it, not a '
    + 'change plan, when new parts point at new parts. At most 900 operations (its check and its run fit the daily '
    + 'allowance). Undo removes what it made (Google keeps new assets, linked nowhere).' + GOOGLE_CHANGE_RULES,
  undo: buildUndo,
  handler: async (args, ctx) => buildLibraryRefusal(args, ctx) ?? goalsRefusal(args, ctx) ?? googleChangePreview(args, ctx, buildBuilder(args)),
  execute: async (args, ctx) => buildLibraryRefusal(args, ctx) ?? goalsRefusal(args, ctx) ?? runGoogleChange(args, ctx, buildBuilder(args), (draft, responses) => {
    const after = buildRecordAfterRun(draft.after as BuildRecord, responses)
    return { data: { made: after }, before: { campaigns: [] }, after }
  }),
}

// ── copy-google-campaign ────────────────────────────────────────────────────────────────────────────────────────

const copyArgs = (args: Record<string, unknown>): Record<string, unknown> => ({
  ...(args.accountId ? { accountId: args.accountId } : {}),
  campaigns: [{
    copyOf: args.campaignId,
    name: args.name,
    ...(args.budget ? { budget: args.budget } : {}),
    ...(args.startDate ? { startDate: args.startDate } : {}),
    ...(args.endDate ? { endDate: args.endDate } : {}),
  }],
})

const copyGoogleCampaign: AgentTool = {
  ...common,
  name: 'copy-google-campaign',
  title: 'Copy a Google Ads campaign (paused)',
  input: z.object({
    accountId: googleAccountArg,
    campaignId: googleIdArg('the campaign to copy'),
    name: textArg(255, 'the copy\'s name (unique in the account)'),
    budget: budgetChoice.optional().describe('the copy\'s budget (default: the same shared budget, or its own budget of the same amount)'),
    startDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('first day (YYYY-MM-DD)'),
    endDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('last day (YYYY-MM-DD)'),
    why: googleWhyArg,
  }),
  description:
    'Copy a live Google Ads campaign (Search or Standard Shopping) of the business\'s chosen account into a NEW campaign, '
    + 'made PAUSED, in one request, with everything Nexus can set: settings, budget (the same shared one, or its own of '
    + 'the same amount), bidding (also Target impression share, and enhanced CPC on Standard Shopping; a standard Target '
    + 'CPA / ROAS becomes Maximize conversions / conversion value with the same target, as Google now takes them — the '
    + 'preview says so), networks, Google\'s automation switches as they are, locations and their bid '
    + 'adjustments, radius targets, location options, languages, schedule, device bid adjustments, audiences of every kind '
    + 'and the audience setting, demographics, campaign negatives and lists, exclusions, brand and placement lists, the '
    + 'campaign\'s conversion goals, AI Max\'s text guidelines, page feeds, URL exclusions and URL inclusions, the '
    + 'inventory filter and Shopping settings, ad groups with bids, statuses, target CPA '
    + '/ ROAS, ad rotation and their own targeting, keywords with bids and URLs, ad-group negatives, the product group '
    + 'tree, responsive search ads, labels on everything, tracking and custom parameters at every level, and every asset '
    + 'linked to the campaign and its ad groups (the same assets linked again). The preview names what it does not copy, '
    + 'each with the reason (what Google\'s API cannot set, links Google made itself, a custom conversion goal — set it '
    + 'in Google Ads after the copy —, kinds of criteria, ads and asset field types no Nexus tool sets). A Performance Max '
    + 'campaign is copied with copy-google-pmax; Demand Gen, Display and App campaigns are refused (make them with their '
    + 'create tools); a Google draft is refused (copy its base campaign). It reads the campaign in about 15 queries of '
    + 'the account\'s allowance (four more when the account has labels). Undo removes the copy.' + GOOGLE_CHANGE_RULES,
  undo: buildUndo,
  handler: (args, ctx) => googleChangePreview(args, ctx, buildBuilder(copyArgs(args))),
  execute: (args, ctx) => runGoogleChange(args, ctx, buildBuilder(copyArgs(args)), (draft, responses) => {
    const after = buildRecordAfterRun(draft.after as BuildRecord, responses)
    return { data: { made: after }, before: { campaigns: [] }, after }
  }),
}

// ── check-google-ads-build (read only) ─────────────────────────────────────────────────────────────────────────

/**
 * Google checks a build (validate_only) and the answer is the build's preview — nothing is asked for, nothing waits in
 * Approvals. It runs the build's own builder here (never another tool's handler: call-tool.ts is the only door).
 */
const checkGoogleAdsBuild: AgentTool = {
  name: 'check-google-ads-build',
  title: 'Check a Google Ads build (no request)',
  category: 'advertising',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, ADSPEND],
  restrictedFields: BUILD_MONEY,
  input: z.object(buildInput),
  description:
    'Read only: let Google check a build WITHOUT asking for it — the same arguments as build-google-campaigns (a campaign '
    + 'may be a copy, copyOf). Nothing is queued, nothing waits in Approvals, nothing changes. The answer is the build\'s '
    + 'preview (accepted true: Google would accept every operation), why Google or Nexus refuses it (checked true, '
    + 'accepted false), or why it could not be checked (checked false: the allowance, a read). It costs the operations of '
    + 'Google\'s check from the account\'s daily allowance; the same plan checked again within 30 minutes costs nothing, and '
    + 'the build asked for right after reuses the check.',
  async handler(args, ctx) {
    const refused = buildLibraryRefusal(args, ctx) ?? goalsRefusal(args, ctx)
    if (refused) return refused
    // Always Google's check (never a re-check); its acceptance of the same plan is remembered for 30 minutes, so the
    // build asked for right after it is not checked (and paid) a second time.
    const out = await googleCheck(args, buildBuilder(args))
    const note = 'A check only: nothing was asked for, nothing waits in Approvals. To make it, call build-google-campaigns with the same arguments.'
    if (out.status === 'accepted') return { ok: true, data: { checked: true, accepted: true, preview: out.preview, note } }
    if (out.status === 'refused') return { ok: true, data: { checked: true, accepted: false, why: out.why, note } }
    return { ok: true, data: { checked: false, accepted: false, why: `Not checked: ${out.why}`, note } }
  },
}

export const GOOGLE_ADS_BUILD_TOOLS: AgentTool[] = [buildGoogleCampaigns, copyGoogleCampaign, checkGoogleAdsBuild]

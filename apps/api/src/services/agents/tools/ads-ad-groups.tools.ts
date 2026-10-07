/**
 * ADS AUTONOMY W4-6 (agent-results/6 §4 "W3-4b"; Owner 10-07: Claude works like a person on the Nexus screens, every
 * Amazon ads action has a tool, and his choice is what may run alone) — the ad groups and product ads of Amazon
 * Sponsored Products campaigns.
 *
 *   ad-groups        read: per campaign its ad groups — state, default bid, the floor that holds them (and the bids it
 *                    keeps to give back), product ads (SKU, ASIN, at Amazon or not), target counts and the window's
 *                    metrics (the campaign page's own allocation, ads-detail-metrics.service.ts).
 *   create-ad-group  ONE step (a plan's later step cannot see an earlier step's new ad group, report 2 B2): a manual ad
 *                    group in an existing campaign with its product ads, keywords OR product targets, and negatives,
 *                    through the screen's own creates (createAdGroupLocal, createProductAdLocal, createKeywordLocal,
 *                    createTargetLocal, createNegativeKeywordLocal, createNegativeProductTargetLocal) — no create path of
 *                    its own. Born at the floor, as the builders' rule 2 wants: every bid above the 2-cent floor starts at
 *                    it with its planned bid remembered — the ad group's own floor, held by the person who asked
 *                    (set-ad-group op start gives the planned bids back), or, inside a campaign a person stopped with low
 *                    bids, that campaign's floor (restore-campaign gives everything back together). `startLive` starts
 *                    the bids as planned: it adds spend, so approving it needs the approver's authenticator code.
 *   add-product-ads  products (by SKU) into an existing ad group (createProductAdLocal). Each serves at the ad group's bids,
 *                    so it adds spend: approving it needs the approver's authenticator code.
 *   set-ad-group     one ad group. op edit: its default bid — as set-target-bid does a bid (the CPC step the campaign and
 *                    the ads strategy allow, never raising a bid a floor holds) — and its name (updateAdGroupWithSync).
 *                    op stop: its bids to the stop bid, each remembered (lowerAdGroupBids: the Owner's temporary stop is
 *                    low bids, never a pause). op start: the remembered bids back (restoreAdGroupBids), e.g. the planned
 *                    bids of an ad group create-ad-group made at the floor. A pause, an enable and an archive of an ad
 *                    group stay pause-ads, enable-ads and archive-ads (W2).
 *
 * The Owner's rule 3 (isolation is per product): a product is advertised once per campaign — the same product twice in
 * one campaign (any of its ad groups) is refused, as its own ads would bid against each other there. Another product
 * already in the campaign is listed, never a refusal. The same product in another enabled campaign of the market is
 * warned (Amazon serves the higher bid of the two, getSelfCompetition) and then never runs by rule unless the business's
 * limits allow it (allowSelfCompetition). Only what Amazon sells in the campaign's market is advertised: a product needs
 * a live Amazon listing there with an ASIN, and the seller SKU Amazon holds there (resolveSellerSku).
 *
 * Every change tool follows ads-change-kit.ts — previewed first, refused and not queued when Amazon's write gate would
 * refuse it, run only as an approved request (as the approver, changeSetId = the approval on every write and every
 * created row), re-checked in `execute` — and is strategy-bound (ads-autonomy-kit.ts): one may run by the business's rule
 * only inside its own limits and the ads strategy, and by default nothing does (every limit that adds spend is 0). Claude
 * is not `manual`: by rule, the live-write allowlist, pins and his own limits bind its writes; a person's approval is his
 * own click (4A). Money is in minor units of the campaign's own currency, never converted.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { updateAdGroupWithSync } from '../../advertising/ads-mutation.service.js'
import { AdSkuConflictError, resolveSellerSku } from '../../advertising/ads-create.service.js'
import { lowerAdGroupBids, markAdGroupBornAtFloor, rememberPlannedBid, restoreAdGroupBids, restoreBidsFor, SUPPRESSION_FLOOR_CENTS } from '../../advertising/ads-bid-suppression.service.js'
import { AD_GROUP_CAMPAIGN_SELECT, adGroupForChange, adGroupNamedInCampaign, adGroupState, campaignAdGroupsForRead } from '../../advertising/ad-group-lookup.service.js'
import { groupSelfCompetition, type SelfCompetitionConflict } from '../../advertising/campaign-settings.service.js'
import { negativeKeywordTextProblem, protectedNegativeRefusal } from '../../advertising/ads-negation-policy.js'
import { bidLimitsFor, stepClamp } from '../../advertising/ads-strategy/bids.js'
import { stopBidsFor, strategySourceWords } from '../../advertising/ads-strategy/effective.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import { playbookHolds, startOnlyRefusal } from '../../advertising/ads-playbook/held.js'
import { amountLabel, campaignCurrency, checkLiveReach, suppressionOf, type AdWriteIntent, type LiveReach } from './ads-tool-guards.js'
import {
  alsoChangedBy, approvedRun, BY_RULE_WORDS, canonical, notRun, reachNote, reachRefusal, recheck, requesterOf, ruleFactsFor, ruleRefusal,
  spOnlyRefusal, stepClampWords, type RuleWrite, type StoredReach,
} from './ads-change-kit.js'
import { adKitLimits, LIMIT_FACTS_MONEY, limitFactsOf, STEP_PCT_LIMITS, type KitItem } from './ads-autonomy-kit.js'
import { STEP_UP_NEEDS, stepUpApproval } from '../step-up-approval.js'
import type { AgentTool, FieldPermission, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = { read: 'ad-groups', create: 'create-ad-group', ads: 'add-product-ads', set: 'set-ad-group' } as const
/** The most products a new ad group advertises (one product ad each). */
const MAX_PRODUCTS = 50
/** The most product ads one add-product-ads request adds. */
const MAX_ADS = 100
/** Every list a tool takes is bounded (the tool contract). */
const LIST_MAX = 250
/** The highest bid a request may plan, in minor units (Amazon's own ceiling is lower in every market). */
const BID_MAX_CENTS = 10_000
/** The most ad groups one read answers (a campaign holds far fewer). */
const READ_MAX_GROUPS = 100
/** At most this many lines are listed in a preview or a read; the rest are counted. */
const LINES_SHOWN = 20

const ADSPEND = FIELDS.financialsAdspendView
/** The money keys of these tools that the shared registry (lib/auth/financial-fields.ts) does not name. */
const OWN_MONEY: Readonly<Record<string, FieldPermission>> = {
  plannedCents: ADSPEND, startCents: ADSPEND, floorCents: ADSPEND, plannedDefaultBidCents: ADSPEND, highestPlannedBidCents: ADSPEND,
  currentBidCents: ADSPEND, effectiveBidCents: ADSPEND, proposedBidCents: ADSPEND, fromCents: ADSPEND, toCents: ADSPEND,
  rememberedCents: ADSPEND, highestRestoredBidCents: ADSPEND, stopBidCents: ADSPEND, dailyBudgetCents: ADSPEND,
}
const CHANGE_MONEY = { ...LIMIT_FACTS_MONEY, ...OWN_MONEY } as Readonly<Record<string, FieldPermission>>

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const named = (list: readonly string[], shown = 3) => (list.length > shown ? `${list.slice(0, shown).join(', ')} and ${list.length - shown} more` : list.join(', '))
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)
const when = (d: Date) => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`
const isPerson = (by: string | null | undefined) => !!by?.startsWith('user:')
const whoWords = (by: string | null | undefined) => (isPerson(by) ? `a person (${by})` : by || 'an unrecorded actor')

/** Each listed twice (case-insensitive): a request names a thing once. */
function twice(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const v of values) (seen.has(v.toLowerCase()) ? repeated : seen).add(v.toLowerCase())
  return [...repeated]
}

// ── Campaigns and ad groups ─────────────────────────────────────────────────────────────────────

interface CampaignRow {
  id: string; name: string; type: unknown; adProduct: string | null; marketplace: string | null; status: unknown; externalCampaignId: string | null
  dailyBudget: unknown; dailyBudgetCurrency: string | null; targetingType: string | null; liveBidWritesEnabled: boolean
  bidsSuppressedAt: Date | null; bidsSuppressedBy: string | null; dynamicBidding: unknown
}

interface GroupRow {
  id: string; name: string; status: unknown; defaultBidCents: number; externalAdGroupId: string | null; orphanedAt: Date | null
  suppressedFromBidCents: number | null; bidsSuppressedAt: Date | null; bidsSuppressedBy: string | null; bidsSuppressedFloorCents: number | null
  campaignId: string; campaign: CampaignRow
}

const loadCampaign = (id: string) => prisma.campaign.findFirst({ where: { id }, select: AD_GROUP_CAMPAIGN_SELECT }) as Promise<CampaignRow | null>
/** AdGroup is advertising's own table: read through its lookup service (scripts/check-context-boundary.mjs). */
const loadGroup = (id: string) => adGroupForChange(id) as Promise<GroupRow | null>

/** Why nothing is added to or changed in this campaign (`what` ends the sentence), or null. */
function campaignRefusal(c: CampaignRow, what: string): string | null {
  const notSp = spOnlyRefusal({ type: c.type == null ? null : String(c.type), adProduct: c.adProduct, name: c.name })
  if (notSp) return notSp
  if (String(c.status) === 'ARCHIVED') return `campaign "${c.name}" is archived: Amazon serves nothing of it again, so ${what}`
  if (!c.externalCampaignId) return `campaign "${c.name}" is not at Amazon (a draft, or a launch Amazon refused), so ${what} could not reach Amazon either`
  if (!c.marketplace) return `campaign "${c.name}" names no market, so ${what}`
  return null
}

/** Why this ad group cannot be changed at all, or null. */
function groupRefusal(g: GroupRow): string | null {
  const c = campaignRefusal(g.campaign, 'its ad groups are not changed here')
  if (c) return c
  if (String(g.status) === 'ARCHIVED') return `ad group "${g.name}" is archived: Amazon serves it no more and nothing of it changes again`
  if (!g.externalAdGroupId) return `ad group "${g.name}" is not at Amazon, so nothing of it could reach Amazon`
  if (g.orphanedAt) return `Amazon no longer has ad group "${g.name}" (Nexus marked it gone)`
  return null
}

const isAutoCampaign = async (c: CampaignRow) =>
  c.targetingType === 'AUTO' || !!(await prisma.adTarget.findFirst({ where: { adGroup: { campaignId: c.id }, kind: 'AUTO' }, select: { id: true } }))

/**
 * PB-5b — a campaign an ads playbook built (or whose floor a playbook stop holds) is the playbook's: its structure and its
 * floors move through the playbook (an ad group added here would sit outside its plan, and a floor set here would wait
 * for a START that never gives it back). Null when no playbook holds it.
 */
async function playbookRefusal(campaign: CampaignRow, what: string): Promise<string | null> {
  const held = (await playbookHolds([campaign.id])).get(campaign.id)
  if (!held) return null
  return held === 'built'
    ? `campaign "${campaign.name}" was built by an ads playbook, so ${what} through the playbook: set-ads-playbook changes its plan, apply-ads-playbook op sync adds what the plan holds, op stop and op start move its bids`
    : startOnlyRefusal(`campaign "${campaign.name}"`, held)
}

/** Where a campaign's bids are held at a floor now, in words; null when they are not. */
const campaignFloorWords = (c: CampaignRow) => (c.bidsSuppressedAt ? `campaign "${c.name}" is stopped with low bids (by ${whoWords(c.bidsSuppressedBy)}, since ${when(c.bidsSuppressedAt)})` : null)

// ── The products an ad advertises ───────────────────────────────────────────────────────────────

/** One product as an ad advertises it: Nexus's SKU, its ASIN in the market, and the seller SKU Amazon holds there. */
interface AdProduct { sku: string; productId: string; asin: string; adSku: string }

/**
 * The products by SKU, each sold on Amazon in this market: a live listing there (a draft or an ended one sells nothing)
 * with an ASIN, a variation rather than its parent, and the seller SKU Amazon holds there (resolveSellerSku, the create's
 * own resolver: a SKU it cannot name without a guess is refused now, not at the write).
 */
async function productsSoldIn(skus: readonly string[], market: string): Promise<{ products: AdProduct[] } | { refusal: string }> {
  const rows = await prisma.product.findMany({ where: { sku: { in: [...skus] }, deletedAt: null }, select: { id: true, sku: true, amazonAsin: true, isParent: true } })
  const bySku = new Map(rows.map((p) => [p.sku, p]))
  const missing = skus.filter((sku) => !bySku.has(sku))
  if (missing.length) return { refusal: `SKU not found in this business: ${named(missing)}.` }
  const parents = rows.filter((p) => p.isParent)
  if (parents.length) return { refusal: `${named(parents.map((p) => p.sku))} ${parents.length === 1 ? 'is a parent' : 'are parents'}: Amazon advertises a variation, never its parent. Name the variations' SKUs.` }
  const listings = await prisma.channelListing.findMany({
    where: { productId: { in: rows.map((p) => p.id) }, channel: 'AMAZON', marketplace: market, listingStatus: { notIn: ['DRAFT', 'ENDED'] } },
    select: { productId: true, externalListingId: true, aliasKey: true },
    orderBy: { id: 'asc' },
  })
  const asinOf = (p: (typeof rows)[number]): string | null => {
    if (p.amazonAsin) return p.amazonAsin
    const own = listings.filter((l) => l.productId === p.id)
    const listed = (own.find((l) => !l.aliasKey) ?? own[0])?.externalListingId ?? null
    return listed && /^[A-Z0-9]{10}$/i.test(listed) ? listed.toUpperCase() : null
  }
  const listed = new Set(listings.map((l) => l.productId))
  const notSold = skus.filter((sku) => !listed.has(bySku.get(sku)!.id))
  if (notSold.length) return { refusal: `Not sold on Amazon ${market}: ${named(notSold)} — no live Amazon listing there (a draft or an ended listing sells nothing). An ad advertises only what Amazon sells in its market.` }
  const noAsin = skus.filter((sku) => !asinOf(bySku.get(sku)!))
  if (noAsin.length) return { refusal: `No ASIN on Amazon ${market} yet: ${named(noAsin)}. An ad advertises a product Amazon holds by its ASIN.` }
  const products: AdProduct[] = []
  for (const sku of skus) {
    const p = bySku.get(sku)!
    const asin = asinOf(p)!
    try {
      const resolved = await resolveSellerSku({ sku: p.sku, asin, productId: p.id, marketplace: market })
      products.push({ sku: p.sku, productId: p.id, asin, adSku: resolved?.sku ?? p.sku })
    } catch (e) {
      if (e instanceof AdSkuConflictError) return { refusal: e.message }
      throw e
    }
  }
  return { products }
}

/** The Owner's rule 3, read: the campaign's own product ads (the same product refused, others listed), and elsewhere. */
interface ProductsAround {
  /** The same product already advertised in this campaign: refused. */
  same: Array<{ sku: string; adGroupId: string; adGroup: string }>
  /** Other products this campaign advertises: allowed (isolation is per product), only listed. */
  others: string[]
  /** The same product in another enabled campaign of the market: Amazon serves the higher bid of the two. */
  elsewhere: SelfCompetitionConflict[]
}

async function productsAround(campaign: CampaignRow, products: readonly AdProduct[]): Promise<ProductsAround> {
  const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase()
  const ours = (ad: { productId: string | null; asin: string | null; sku: string | null }) =>
    products.find((p) => (!!ad.productId && ad.productId === p.productId) || (!!ad.asin && ad.asin === p.asin) || (!!ad.sku && [lower(p.sku), lower(p.adSku)].includes(lower(ad.sku))))
  const here = await prisma.adProductAd.findMany({
    where: { adGroup: { campaignId: campaign.id }, status: { not: 'ARCHIVED' } },
    select: { productId: true, asin: true, sku: true, adGroup: { select: { id: true, name: true } } },
  })
  const same: ProductsAround['same'] = []
  const others = new Set<string>()
  for (const ad of here) {
    const p = ours(ad)
    if (p) { if (!same.some((s) => s.sku === p.sku && s.adGroupId === ad.adGroup.id)) same.push({ sku: p.sku, adGroupId: ad.adGroup.id, adGroup: ad.adGroup.name }) } else if (ad.sku ?? ad.asin) others.add((ad.sku ?? ad.asin)!)
  }
  const there = await prisma.adProductAd.findMany({
    where: {
      status: { not: 'ARCHIVED' },
      OR: [{ asin: { in: products.map((p) => p.asin) } }, { productId: { in: products.map((p) => p.productId) } }, { sku: { in: [...new Set(products.flatMap((p) => [p.sku, p.adSku]))] } }],
      adGroup: { campaign: { marketplace: campaign.marketplace, id: { not: campaign.id }, status: 'ENABLED' } },
    },
    select: { productId: true, asin: true, sku: true, adGroup: { select: { campaign: { select: { id: true, name: true, status: true } } } } },
  })
  // getSelfCompetition's own grouping (campaign-settings.service.ts), each ad named by the product it advertises here.
  const elsewhere = groupSelfCompetition(there.map((ad) => ({ asin: ours(ad)?.asin ?? ad.asin, adGroup: { campaign: { ...ad.adGroup.campaign, status: String(ad.adGroup.campaign.status) } } })))
  return { same, others: [...others], elsewhere }
}

const sameRefusal = (same: ProductsAround['same'], campaign: string) =>
  `Not queued: the same product twice in one campaign would bid against itself (isolation is per product) — ${named(same.map((s) => `${s.sku} is already advertised in ad group "${s.adGroup}"`))} of campaign "${campaign}". Another product may share the campaign; the same one may not.`

function aroundPreview(around: ProductsAround) {
  return {
    ...(around.others.length ? { otherProducts: { skus: around.others.slice(0, LINES_SHOWN), count: around.others.length, note: 'Other products this campaign already advertises: allowed (isolation is per product), never blocked.' } } : {}),
    ...(around.elsewhere.length
      ? {
        selfCompetition: {
          campaigns: around.elsewhere.slice(0, LINES_SHOWN).map((c) => ({ campaignId: c.campaignId, name: c.name, asins: c.asins.slice(0, 10) })),
          count: around.elsewhere.length,
          note: `The same product already runs in ${plural(around.elsewhere.length, 'other enabled campaign')} of this market (${named(around.elsewhere.map((c) => `"${c.name}"`))}): Amazon serves the higher bid of the two in one auction. A person decides; by rule only where the business allows it (allowSelfCompetition).`,
        },
      }
      : {}),
  }
}

// ── Where the writes land ───────────────────────────────────────────────────────────────────────

/**
 * Where these writes land: every one must answer the same (live on one profile, or sandbox), or the request is refused;
 * the own limits any of them goes past are listed once each (the card warns about them; approving sends them anyway).
 */
async function reachOf(intents: readonly AdWriteIntent[]): Promise<{ reach: StoredReach } | { refused: Extract<LiveReach, { reach: 'refused' }> }> {
  const profiles = new Set<string>()
  const past: Array<{ limit: string; reason: string }> = []
  for (const intent of intents) {
    const r = await checkLiveReach(intent)
    if (r.reach === 'refused') return { refused: r }
    if (r.reach !== 'live') continue
    profiles.add(r.profileId)
    for (const l of r.pastOwnLimits ?? []) if (!past.some((p) => p.reason === l.reason)) past.push({ limit: l.limit, reason: l.reason })
  }
  if (!profiles.size) return { reach: { reach: 'sandbox' } }
  return { reach: { reach: 'live', profileId: [...profiles].sort().join(','), ...(past.length ? { pastOwnLimits: past } : {}) } }
}

/** What a preview says about the live-write allowlist (Claude's writes are not `manual`: the list binds a run by rule). */
const allowlistWords = (c: CampaignRow) => c.liveBidWritesEnabled
  ? 'The campaign is on the live-write allowlist.'
  : `Campaign "${c.name}" is off the live-write allowlist: a person's approval sends it anyway (his own click), but run by the business's rule it waits for a person; afterwards no rule or engine writes it at Amazon until set-campaign-live-writes puts the campaign on the list.`

/**
 * PB-5b's one gate of a change that adds spend: approved with the approver's fresh authenticator code, or run by the
 * business's rule where this tool's limits let it (they hold the rest). A change that adds nothing passes.
 */
async function spendGate(ctx: ToolContext, adds: boolean): Promise<{ refusal: string } | null> {
  if (!adds || ctx.decidedVia === 'auto') return null
  const coded = await stepUpApproval(ctx)
  return 'refusal' in coded ? { refusal: coded.refusal } : null
}

const whyArg = z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit')
const SKU = z.string().trim().min(1).max(64)
const ASIN = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'an ASIN is 10 letters and digits')

// ── ad-groups (read) ────────────────────────────────────────────────────────────────────────────

const GROUP_STATUSES = ['open', 'enabled', 'paused', 'archived', 'all'] as const

async function readAdGroups(args: Record<string, unknown>): Promise<ToolResult> {
  const a = args as { campaignId?: string; adGroupId?: string; status: (typeof GROUP_STATUSES)[number]; days: number }
  if (!a.campaignId && !a.adGroupId) return { ok: false, error: 'Name the campaign (campaignId) or one ad group (adGroupId).' }
  let campaignId = a.campaignId ?? null
  if (a.adGroupId) {
    const g = await adGroupForChange(a.adGroupId)
    if (!g || (campaignId && g.campaignId !== campaignId)) return { ok: false, error: 'Ad group not found' }
    campaignId = g.campaignId
  }
  const campaign = await loadCampaign(campaignId!)
  if (!campaign) return { ok: false, error: 'Campaign not found' }
  const currency = campaignCurrency(campaign)
  // Every ad group of the campaign: the campaign's metrics are allocated over all of them (ads-detail-metrics.service.ts).
  const { all, wanted } = await campaignAdGroupsForRead(campaign.id, { status: a.status, adGroupId: a.adGroupId ?? null })
  const groups = all.filter((g) => wanted.has(g.id))
  const shown = groups.slice(0, READ_MAX_GROUPS)
  const { computeCampaignDetailMetrics } = await import('../../advertising/ads-detail-metrics.service.js')
  const [metrics, targets] = await Promise.all([
    computeCampaignDetailMetrics({ campaignId: campaign.id, externalCampaignId: campaign.externalCampaignId, adGroups: all.map((g) => ({ id: g.id, productAdIds: g.productAds.map((ad) => ad.id) })), windowDays: a.days }),
    shown.length
      ? prisma.adTarget.findMany({ where: { adGroupId: { in: shown.map((g) => g.id) }, status: { not: 'ARCHIVED' } }, select: { adGroupId: true, kind: true, isNegative: true, suppressedFromBidCents: true } })
      : [],
  ])
  const items = shown.map((g) => {
    const mine = targets.filter((t) => t.adGroupId === g.id)
    const count = (kind: string) => mine.filter((t) => !t.isNegative && t.kind === kind).length
    const m = metrics.byAdGroup.get(g.id)
    return {
      adGroupId: g.id,
      externalAdGroupId: g.externalAdGroupId,
      name: g.name,
      status: String(g.status),
      atAmazon: !!g.externalAdGroupId && !g.orphanedAt,
      defaultBidCents: g.defaultBidCents,
      // Its own floor (a person's, or an engine's): the bids it remembered are what set-ad-group op start gives back.
      floor: g.bidsSuppressedAt
        ? { by: g.bidsSuppressedBy, since: g.bidsSuppressedAt.toISOString(), floorCents: g.bidsSuppressedFloorCents, ...(g.suppressedFromBidCents != null ? { plannedDefaultBidCents: g.suppressedFromBidCents } : {}), givenBackBy: isPerson(g.bidsSuppressedBy) ? 'set-ad-group op start' : 'the engine that set it' }
        : null,
      productAds: g.productAds.slice(0, LINES_SHOWN).map((ad) => ({ productAdId: ad.id, sku: ad.sku, asin: ad.asin, productId: ad.productId, status: String(ad.status), atAmazon: !!ad.externalAdId })),
      ...(g.productAds.length > LINES_SHOWN ? { moreProductAds: g.productAds.length - LINES_SHOWN } : {}),
      targets: {
        keywords: count('KEYWORD'), productTargets: count('PRODUCT'), categoryTargets: count('CATEGORY'), autoTargets: count('AUTO'),
        negatives: mine.filter((t) => t.isNegative).length,
        // Bids at a floor that remember the bid to give back (a born-at-the-floor ad group, a stop).
        heldAtFloor: mine.filter((t) => !t.isNegative && t.suppressedFromBidCents != null).length,
      },
      metrics: m ? { impressions: m.impressions, clicks: m.clicks, orders: m.orders, spendCents: m.spendCents, salesCents: m.salesCents, acos: m.acos, roas: m.roas } : null,
    }
  })
  return {
    ok: true,
    data: {
      campaign: {
        campaignId: campaign.id, externalCampaignId: campaign.externalCampaignId, name: campaign.name, market: campaign.marketplace, status: String(campaign.status),
        targetingType: campaign.targetingType, currency, liveWrites: campaign.liveBidWritesEnabled,
        floor: campaign.bidsSuppressedAt ? { by: campaign.bidsSuppressedBy, since: campaign.bidsSuppressedAt.toISOString(), givenBackBy: isPerson(campaign.bidsSuppressedBy) ? 'restore-campaign' : 'the engine that set it' } : null,
      },
      window: { days: a.days, note: 'Metrics: the campaign\'s own total over the window (today\'s hourly figures included), shared out over its ad groups by their product ads, as the campaign page shows them.' },
      items,
      total: groups.length,
      ...(groups.length > READ_MAX_GROUPS ? { more: `${groups.length} ad groups match; the first ${READ_MAX_GROUPS} are listed. Narrow with status or adGroupId.` } : {}),
    },
  }
}

const adGroupsRead: AgentTool = {
  name: TOOL.read,
  title: 'Ad groups of a campaign',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: OWN_MONEY,
  input: z.object({
    campaignId: z.string().trim().min(1).max(64).optional().describe('the campaign: its Nexus id (campaignId in ad-campaigns); give this or adGroupId'),
    adGroupId: z.string().trim().min(1).max(64).optional().describe('only this ad group: its Nexus id (adGroupId in ad-targets)'),
    status: z.enum(GROUP_STATUSES).default('open').describe('which ad groups: open (default: enabled and paused), enabled, paused, archived or all'),
    days: z.coerce.number().int().min(1).max(90).default(30).describe('the metrics window: the last N days (default 30, max 90)'),
  }),
  description:
    'The ad groups of one Amazon Sponsored Products campaign (or one ad group). Per ad group: adGroupId (the id '
    + 'set-ad-group, add-product-ads, pause-ads and archive-ads take) and Amazon\'s id, name, status, whether Amazon holds '
    + 'it, its default bid, the floor that holds its bids (who set it, since when, the default bid it keeps to give back, '
    + 'and which tool gives it back), its product ads (SKU, ASIN, status, at Amazon or not), how many keywords, product, '
    + 'category and auto targets and negatives it holds (and how many bids wait at a floor), and impressions, clicks, '
    + 'orders, spend, sales, ACoS and ROAS over the window as the campaign page shows them. The campaign: market, status, '
    + 'targeting type, currency, live-write allowlist and its own floor. Amounts are minor units (cents) of the '
    + 'campaign\'s own currency, never converted; a person without the ad-spend money permission gets the same answer '
    + 'without the amounts.',
  handler: (args) => readAdGroups(args),
}

// ── create-ad-group ─────────────────────────────────────────────────────────────────────────────

const keywordArg = z.object({
  text: z.string().trim().min(1).max(80).describe('the keyword'),
  matchType: z.enum(['EXACT', 'PHRASE', 'BROAD']).describe('how it matches a search'),
  bidCents: z.coerce.number().int().min(2).max(BID_MAX_CENTS).optional().describe("its planned bid in minor units of the campaign's currency (default: defaultBidCents)"),
})
const productTargetArg = z.object({
  asin: ASIN.describe('the ASIN it shows on'),
  bidCents: z.coerce.number().int().min(2).max(BID_MAX_CENTS).optional().describe("its planned bid in minor units of the campaign's currency (default: defaultBidCents)"),
})
const negativeArg = z.object({
  text: z.string().trim().min(1).max(80).describe('the search it never shows on'),
  matchType: z.enum(['EXACT', 'PHRASE']).describe('how it blocks a search'),
})

const CREATE_INPUT = z.object({
  campaignId: z.string().trim().min(1).max(64).describe('the campaign it goes in: its Nexus id (campaignId in ad-campaigns) — a manual Sponsored Products campaign at Amazon'),
  name: z.string().trim().min(1).max(128).describe("the ad group's name; new among the campaign's ad groups"),
  defaultBidCents: z.coerce.number().int().min(2).max(BID_MAX_CENTS)
    .describe("the ad group's planned default bid in minor units of the campaign's currency (never converted); also the planned bid of every keyword and product target without its own"),
  skus: z.array(SKU).min(1).max(MAX_PRODUCTS).describe(`the Nexus SKUs it advertises, one product ad each (at most ${MAX_PRODUCTS}); each must be sold on Amazon in the campaign's market`),
  keywords: z.array(keywordArg).max(LIST_MAX).optional().describe('keyword targeting: each keyword, its match type and planned bid (give this or productTargets, not both), at most 250'),
  productTargets: z.array(productTargetArg).max(LIST_MAX).optional().describe('product targeting: the ASINs it shows on, each with its planned bid (give this or keywords, not both), at most 250'),
  negativeKeywords: z.array(negativeArg).max(LIST_MAX).optional().describe("searches this ad group never shows on (its own negatives only), at most 250"),
  negativeAsins: z.array(ASIN).max(LIST_MAX).optional().describe('ASINs this ad group never shows on (its own negatives only), at most 250'),
  startLive: z.boolean().default(false)
    .describe("false (default): born at the 2-cent floor, every planned bid kept to give back (set-ad-group op start, or restore-campaign inside a stopped campaign); true: the bids start as planned and it spends from the start — approving that needs the approver's authenticator code"),
  why: whyArg,
})
type CreateArgs = z.infer<typeof CREATE_INPUT>

/** How a new ad group's bids start: as planned, at a floor of its own (the asker's), or joined to its campaign's floor. */
type StartMode = 'live' | 'own' | 'campaign'

/** The ad group the person approves (it is checked again, with every value, before anything is created). */
interface GroupPlan {
  campaign: { id: string; name: string; marketplace: string }
  currency: string
  name: string
  start: StartMode
  floorCents: number
  defaultBid: { plannedCents: number; startCents: number }
  products: AdProduct[]
  keywords: Array<{ text: string; matchType: 'EXACT' | 'PHRASE' | 'BROAD'; plannedCents: number; startCents: number }>
  productTargets: Array<{ asin: string; plannedCents: number; startCents: number }>
  negativeKeywords: Array<{ text: string; matchType: 'EXACT' | 'PHRASE' }>
  negativeAsins: string[]
}

const START_HOW = 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms it in '
  + 'Claude with theirs when the business set the tool to confirm in Claude. By rule only where the business allows it in this tool\'s limits.'

const CREATE_UNDO_WORDS = 'Undo archives the ad group (archive-ads), and that is permanent at Amazon: an archived ad group never comes back; what it spent stays spent.'

async function createPreview(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'> = {}): Promise<ToolResult> {
  const parsed = CREATE_INPUT.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') }
  const a: CreateArgs = parsed.data
  const keywords = a.keywords ?? []
  const targets = a.productTargets ?? []
  const negatives = a.negativeKeywords ?? []
  const negativeAsins = a.negativeAsins ?? []

  const campaign = await loadCampaign(a.campaignId)
  if (!campaign) return { ok: false, error: `Campaign ${a.campaignId} not found in this business.` }
  const refused = campaignRefusal(campaign, 'no ad group is added to it')
  if (refused) return { ok: false, error: `Not queued: ${refused}.` }
  const market = campaign.marketplace!
  if (await isAutoCampaign(campaign)) {
    return { ok: false, error: `Not queued: campaign "${campaign.name}" is an Auto campaign — Amazon chooses its searches and makes each ad group's four auto groups itself. create-ad-group adds a manual ad group (keywords or product targets); an Auto campaign is built with Nexus's builders.` }
  }
  const playbook = await playbookRefusal(campaign, 'its ad groups are added')
  if (playbook) return { ok: false, error: `Not queued: ${playbook}.` }
  if (!keywords.length === !targets.length) return { ok: false, error: 'Give either keywords or productTargets (Amazon takes one targeting kind per manual ad group), not both and not neither.' }
  if (keywords.length + negatives.length + negativeAsins.length + targets.length > LIST_MAX * 2) {
    return { ok: false, error: `At most ${LIST_MAX * 2} keywords, targets and negatives in one ad group request: split it (add-ad-targets and add-negative-targets add more later).` }
  }
  for (const [list, what] of [
    [keywords.map((k) => `${k.matchType} ${k.text}`), 'keywords'], [targets.map((t) => t.asin), 'product targets'],
    [negatives.map((n) => `${n.matchType} ${n.text}`), 'negative keywords'], [negativeAsins, 'negative ASINs'], [a.skus, 'skus'],
  ] as const) {
    const repeated = twice(list)
    if (repeated.length) return { ok: false, error: `Listed twice in ${what}: ${named(repeated, 5)}.` }
  }
  const blocked = new Set(negatives.map((n) => n.text.toLowerCase()))
  const both = keywords.filter((k) => blocked.has(k.text.toLowerCase()))
  if (both.length) return { ok: false, error: `Both a keyword and a negative of this ad group: ${named(both.map((k) => `"${k.text}"`), 5)}. A term is one or the other.` }
  const blockedAsins = new Set(negativeAsins)
  const bothAsins = targets.filter((t) => blockedAsins.has(t.asin))
  if (bothAsins.length) return { ok: false, error: `Both a product target and a negative ASIN of this ad group: ${named(bothAsins.map((t) => t.asin), 5)}.` }
  const taken = await adGroupNamedInCampaign(campaign.id, a.name)
  if (taken) return { ok: false, error: `Campaign "${campaign.name}" already has an ad group named "${taken.name}" (${taken.id}): give the new one another name.` }

  const sold = await productsSoldIn(a.skus, market)
  if ('refusal' in sold) return { ok: false, error: sold.refusal }
  const ownAsins = sold.products.filter((p) => blockedAsins.has(p.asin))
  if (ownAsins.length) return { ok: false, error: `A negative ASIN would stop the ad group's own product: ${named(ownAsins.map((p) => `${p.asin} (${p.sku})`))}.` }
  // The Owner's rule 3: the same product twice in one campaign is refused; another product is listed; elsewhere warned.
  const around = await productsAround(campaign, sold.products)
  if (around.same.length) return { ok: false, error: sameRefusal(around.same, campaign.name) }
  // Negatives: Amazon's text limits and the protected terms (the write gate's own matcher, ads-negation-policy.ts).
  for (const n of negatives) {
    const matchType = n.matchType === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT'
    const problem = negativeKeywordTextProblem(n.text, matchType)
    if (problem) return { ok: false, error: `Not queued: negative "${n.text}": ${problem}` }
    const guarded = await protectedNegativeRefusal({ text: n.text, matchType, marketplace: market, campaignId: campaign.id })
    if (guarded) return { ok: false, error: `Not queued: ${guarded.reason}` }
  }

  // Born at the floor (the builders' rule 2) unless startLive: inside a campaign a person stopped with low bids, the
  // planned bids join that floor; else the ad group gets a floor of its own, held by the person who asked.
  const floor = SUPPRESSION_FLOOR_CENTS
  const campaignFloor = campaignFloorWords(campaign)
  if (a.startLive && campaignFloor) {
    return { ok: false, error: `Not queued: ${campaignFloor}. A live ad group would spend while the rest of it is stopped: ask without startLive (it then waits at the floor with the campaign), or after restore-campaign.` }
  }
  const start: StartMode = a.startLive ? 'live' : campaign.bidsSuppressedAt && isPerson(campaign.bidsSuppressedBy) ? 'campaign' : 'own'
  const startOf = (planned: number) => (start === 'live' || planned <= floor ? planned : floor)
  const currency = campaignCurrency(campaign)
  const plan: GroupPlan = {
    campaign: { id: campaign.id, name: campaign.name, marketplace: market },
    currency,
    name: a.name,
    start,
    floorCents: floor,
    defaultBid: { plannedCents: a.defaultBidCents, startCents: startOf(a.defaultBidCents) },
    products: sold.products,
    keywords: keywords.map((k) => ({ text: k.text, matchType: k.matchType, plannedCents: k.bidCents ?? a.defaultBidCents, startCents: startOf(k.bidCents ?? a.defaultBidCents) })),
    productTargets: targets.map((t) => ({ asin: t.asin, plannedCents: t.bidCents ?? a.defaultBidCents, startCents: startOf(t.bidCents ?? a.defaultBidCents) })),
    negativeKeywords: negatives.map((n) => ({ text: n.text, matchType: n.matchType })),
    negativeAsins,
  }
  const bids = [...plan.keywords, ...plan.productTargets]
  const highestPlanned = Math.max(plan.defaultBid.plannedCents, ...bids.map((b) => b.plannedCents))
  // Amazon refuses a bid above the campaign's daily budget.
  const budgetCents = Math.round(Number(campaign.dailyBudget) * 100)
  if (highestPlanned > budgetCents) return { ok: false, error: `A bid of ${amountLabel(highestPlanned, currency)} is above campaign "${campaign.name}"'s daily budget of ${amountLabel(budgetCents, currency)}: Amazon refuses it.` }

  // Where it lands: the writes as Amazon's write gate judges them now — the ad group's default bid, and its highest and
  // lowest starting bid (a starting bid the gate refuses is refused here, not half-way through the creates).
  const intent = (field: string, valueCents: number): AdWriteIntent => ({ campaignId: campaign.id, marketplace: market, changes: [{ field, valueCents }] })
  const starts = bids.map((b) => b.startCents)
  const intents = [intent('defaultBid', plan.defaultBid.startCents), ...[...new Set([Math.max(...starts), Math.min(...starts)])].map((cents) => intent('bid', cents))]
  const reach = await reachOf(intents)
  if ('refused' in reach) return { ok: false, error: reachRefusal(reach.refused) }
  const stored = reach.reach
  const bound = await alsoChangedBy(campaign.id)

  // The facts the business's rule is judged on: the default bid where the campaign is, every other row where its
  // products are (an ad group takes the safer value across its products), each row one item; the gate as the rule's write.
  const products = { kind: 'products' as const, market, productIds: plan.products.map((p) => p.productId), label: `the new ad group "${plan.name}" (campaign "${campaign.name}")` }
  const forced = start !== 'live'
  const items: KitItem[] = [
    { entity: { kind: 'campaign', id: campaign.id }, change: { field: 'bid', fromCents: null, toCents: plan.defaultBid.startCents, forced } },
    ...bids.map((b): KitItem => ({ entity: products, change: { field: 'bid', fromCents: null, toCents: b.startCents, forced } })),
    ...plan.products.map((): KitItem => ({ entity: products, change: { field: 'status', from: null, to: 'ENABLED' } })),
    ...plan.negativeKeywords.map((n): KitItem => ({ entity: products, change: { field: 'negative', term: n.text, matchType: n.matchType === 'PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT' } })),
    ...plan.negativeAsins.map((asin): KitItem => ({ entity: products, change: { field: 'negative', term: asin, matchType: 'ASIN' } })),
  ]
  const writes: RuleWrite[] = intents.map((i) => ({ ...i, label: `campaign "${campaign.name}"` }))
  const rule = await ruleFactsFor({ tool: TOOL.create, limits: CREATE_LIMITS, items, writes, approvalId: ctx.approvalId ?? null, projectMonth: start === 'live' })

  const targeting = plan.keywords.length ? plural(plan.keywords.length, 'keyword') : plural(plan.productTargets.length, 'product target')
  const negativeCount = plan.negativeKeywords.length + plan.negativeAsins.length
  const remembered = [plan.defaultBid, ...bids].filter((b) => b.startCents !== b.plannedCents).length
  const startWords = start === 'live'
    ? `Its bids start as planned (the highest ${amountLabel(highestPlanned, currency)}): it spends from the start.`
    : start === 'campaign'
      ? `It is born at the ${floor}-cent floor with the rest of the campaign (${campaignFloor}); its planned bids are remembered and restore-campaign gives them back with the campaign's.`
      : `It is born with every bid at the ${floor}-cent floor (a floor of its own, held by the person who asked; never paused), its planned bids remembered: it spends next to nothing until set-ad-group op start gives them back.`
  const effect = `Creates the ad group "${plan.name}" in campaign "${campaign.name}" (${market}): ${plural(plan.products.length, 'product ad')}, ${targeting}`
    + `${negativeCount ? ` and ${plural(negativeCount, 'negative')}` : ''}, default bid ${amountLabel(plan.defaultBid.plannedCents, currency)}. ${startWords}`
    + (String(campaign.status) !== 'ENABLED' ? ` The campaign is ${String(campaign.status).toLowerCase()}: nothing of it serves until it is enabled.` : '')
  const raises = start === 'live'
    ? [`${plural(plan.products.length, 'product ad')} and ${targeting} at their planned bids (the highest ${amountLabel(highestPlanned, currency)}): the ad group spends from the start`]
    : []
  return {
    ok: true,
    preview: {
      action: TOOL.create,
      campaign: plan.campaign,
      currency,
      plan,
      totals: { productAds: plan.products.length, keywords: plan.keywords.length, productTargets: plan.productTargets.length, negatives: negativeCount, rememberedBids: remembered },
      highestPlannedBidCents: highestPlanned,
      startsAt: start === 'live'
        ? { how: 'live', note: 'Every bid starts as planned.' }
        : { how: start === 'own' ? 'its own floor' : 'the campaign\'s floor', floorCents: floor, by: 'the person who asked', note: startWords },
      ...aroundPreview(around),
      raises,
      ...(start === 'live'
        ? { stepUp: { what: `starts a new ad group spending (${plural(plan.products.length, 'product ad')}, ${targeting})`, raises: ['Product ads', 'Bids', 'Spend'], needs: STEP_UP_NEEDS, how: START_HOW } }
        : { noCode: 'Born at the floor, it adds next to no spend: approving it needs no authenticator code (giving its planned bids back is its own request).' }),
      liveWrites: campaign.liveBidWritesEnabled,
      liveWritesNote: allowlistWords(campaign),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      // The whole plan (every row and its bids), the products' rule-3 facts and the campaign's floor: a move of any of
      // them after approval is caught.
      basis: hash({ plan, same: around.same, elsewhere: around.elsewhere.map((c) => c.campaignId).sort(), floor: [campaign.bidsSuppressedAt?.toISOString() ?? null, campaign.bidsSuppressedBy] }),
      reach: stored,
      reachNote: reachNote(stored),
      ...rule,
      effect,
      nextSteps: start === 'live'
        ? ['ad-groups: the ad group, its ads and targets as Amazon took them']
        : start === 'campaign'
          ? ['restore-campaign (the campaign): gives the planned bids back with the campaign\'s — it starts spending']
          : ['set-ad-group (op start, the new ad group): gives the planned bids back — it starts spending'],
      undoNote: CREATE_UNDO_WORDS,
    },
  }
}

/**
 * create-ad-group's Claude limits: the kit's (maxItems counts the rows it creates — 0 by default: every new ad group waits
 * for a person until he types a number), the highest planned bid by rule (0), a live start (off), the same product in
 * another campaign of the market (off), and the markets and campaigns where it may run by rule (empty: every one).
 */
const CREATE_LIMITS = adKitLimits({ maxItems: 0 }, {
  maxBidCents: z.number().int().min(0).max(BID_MAX_CENTS).default(0)
    .describe("the highest planned bid (minor units of the campaign's currency) a new ad group may hold by rule; 0 = every new ad group waits for a person"),
  allowStartLive: z.boolean().default(false).describe('let a new ad group start live (its bids as planned, it spends from the start) by rule; off: only one born at the floor may run by rule'),
  allowSelfCompetition: z.boolean().default(false).describe('let it run by rule when the same product already runs in another enabled campaign of the market; off: a person decides'),
  markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([]).describe('the markets where it may run by rule (empty = every market)'),
  campaignIds: z.array(z.string().trim().min(1).max(64)).max(LIST_MAX).default([]).describe('the campaigns it may add ad groups to by rule (empty = every campaign)'),
})

/** create-ad-group's own checks after the kit's (C1–C7, the month) and the gate as the rule's write. Pure. */
function createRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { plan?: GroupPlan; highestPlannedBidCents?: number; selfCompetition?: unknown }
  if (!p.plan) return 'there is no preview of this ad group to check; a person decides'
  const markets = (limits.markets as string[] | undefined) ?? []
  if (markets.length && !markets.includes(p.plan.campaign.marketplace)) return `this business lets a new ad group run by rule only in ${markets.join(', ')}`
  const campaigns = (limits.campaignIds as string[] | undefined) ?? []
  if (campaigns.length && !campaigns.includes(p.plan.campaign.id)) return `this business lets a new ad group run by rule only in the campaigns its limits name (campaignIds)`
  if (p.plan.start === 'live' && limits.allowStartLive !== true) return 'it starts live (its bids as planned): this tool\'s limits let only an ad group born at the floor run by rule (allowStartLive is off); a person decides'
  const currency = p.plan.currency
  const highest = p.highestPlannedBidCents ?? 0
  const max = typeof limits.maxBidCents === 'number' ? limits.maxBidCents : 0
  if (highest > max) return `its highest planned bid ${amountLabel(highest, currency)} is above the ${amountLabel(max, currency)} this tool's limits allow by rule${max === 0 ? ' (0: every new ad group waits for a person)' : ''}; a person decides`
  for (const scope of Object.values(limitFactsOf(preview)?.scopes ?? {})) {
    const cap = scope.limits.maxBidCents
    if (cap == null || !scope.sources.maxBid || highest <= cap) continue
    return `its highest planned bid ${amountLabel(highest, currency)} is above the highest bid ${amountLabel(cap, currency)} (${strategyWords(scope.sources.maxBid)}); a person decides`
  }
  if (p.selfCompetition && limits.allowSelfCompetition !== true) return 'the same product already runs in another enabled campaign of the market (allowSelfCompetition is off); a person decides'
  return null
}

/** What a create records: the ad group and every row it made (undo archives the ad group, and everything in it with it). */
interface GroupAfter { adGroupId: string; campaignId: string; name: string; start: StartMode; productAdIds: string[]; targetIds: string[]; negativeIds: string[]; archived?: true }

const CREATE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as GroupAfter
    const g = after.adGroupId ? await adGroupState(after.adGroupId) : null
    return g && g.status !== 'ARCHIVED' ? change.after : { ...after, archived: true }
  },
  request(change) {
    const after = (change.after ?? {}) as Partial<GroupAfter>
    if (!after.adGroupId) return { refusal: 'This change does not name the ad group it created.' }
    return { tool: 'archive-ads', args: { adGroupIds: [after.adGroupId], why: `undo of the ad group "${after.name ?? '?'}" Claude created: archived for good` } }
  },
}

async function runCreate(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const fresh = await createPreview(args, ctx)
  const refusal = recheck(ctx, fresh, CREATE_MATERIAL)
  if (refusal) return notRun(refusal)
  const p = fresh.preview as { plan: GroupPlan; reach: StoredReach; effect: string }
  const plan = p.plan
  const run = approvedRun(ctx, String(args.why ?? '').trim() || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  // A live start adds spend: the approver's code, or the business's rule inside its limits.
  const gate = await spendGate(ctx, plan.start === 'live')
  if (gate) return notRun(gate.refusal)
  const by = await requesterOf(ctx, run.actor)
  const { createAdGroupLocal, createKeywordLocal, createNegativeKeywordLocal, createNegativeProductTargetLocal, createProductAdLocal, createTargetLocal } = await import('../../advertising/ads-create.service.js')
  // Every create as the screen's own add of the same row (nothing kept unless Amazon took it), as the approver, with the
  // approval as its change set.
  const common = { userId: run.actor, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId, requireAmazon: true }

  const group = await createAdGroupLocal({ campaignId: plan.campaign.id, name: plan.name, defaultBidEur: plan.defaultBid.startCents / 100, ...common })
  if (!group.id) return notRun(`Not run: Amazon did not take the ad group — ${group.reason ?? group.notSent?.reason ?? 'no reason given'}. Nothing was created.`)
  const adGroupId = group.id
  // Born at the floor: the planned default bid remembered, and (outside a campaign a person stopped) the ad group's own
  // floor, held by the person who asked — the same marks a stop leaves (ads-bid-suppression.service.ts W1-6b).
  const remembered = [plan.defaultBid, ...plan.keywords, ...plan.productTargets].some((b) => b.startCents !== b.plannedCents)
  if (plan.start !== 'live' && remembered) {
    await markAdGroupBornAtFloor(adGroupId, {
      plannedDefaultCents: plan.defaultBid.startCents !== plan.defaultBid.plannedCents ? plan.defaultBid.plannedCents : null,
      own: plan.start === 'own' ? { floorCents: plan.floorCents, by } : null,
    })
  }
  const failed: string[] = []
  const after: GroupAfter = { adGroupId, campaignId: plan.campaign.id, name: plan.name, start: plan.start, productAdIds: [], targetIds: [], negativeIds: [] }
  const said = (r: { outcome?: string; reason?: string | null; notSent?: { reason: string } | null; refusal?: { reason: string }; error?: string; denied?: { reason: string }; pushError?: string }) =>
    r.reason ?? r.notSent?.reason ?? r.refusal?.reason ?? r.denied?.reason ?? r.pushError ?? r.error ?? r.outcome ?? 'not created'
  // Negatives first (a create that stops part-way is then narrower, never wider), then the ads, then the targets.
  for (const n of plan.negativeKeywords) {
    const r = await createNegativeKeywordLocal({ adGroupId, keywordText: n.text, matchType: n.matchType, userId: run.actor, manual: run.manual, changeSetId: run.changeSetId })
    if (r.id && r.mode !== 'refused' && r.mode !== 'failed') after.negativeIds.push(r.id)
    else failed.push(`negative "${n.text}" (${said(r)})`)
  }
  for (const asin of plan.negativeAsins) {
    const r = await createNegativeProductTargetLocal({ adGroupId, asin, userId: run.actor, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId })
    if (r.id && r.mode !== 'refused' && r.mode !== 'failed') after.negativeIds.push(r.id)
    else failed.push(`negative ASIN ${asin} (${said(r)})`)
  }
  for (const product of plan.products) {
    try {
      const r = await createProductAdLocal({ adGroupId, sku: product.sku, asin: product.asin, productId: product.productId, ...common })
      if (r.id && r.ok !== false) after.productAdIds.push(r.id)
      else failed.push(`the ad of ${product.sku} (${said(r)})`)
    } catch (e) { failed.push(`the ad of ${product.sku} (${(e as Error).message})`) }
  }
  const remember = (id: string, b: { plannedCents: number; startCents: number }) => (b.startCents !== b.plannedCents ? rememberPlannedBid(id, b.plannedCents) : null)
  for (const k of plan.keywords) {
    try {
      const r = await createKeywordLocal({ adGroupId, keywordText: k.text, matchType: k.matchType, bidEur: k.startCents / 100, evidence: { metric: 'claudeRequest', note: run.reason }, ...common })
      if (r.id && r.ok !== false) { after.targetIds.push(r.id); await remember(r.id, k) } else failed.push(`keyword "${k.text}" (${said(r)})`)
    } catch (e) { failed.push(`keyword "${k.text}" (${(e as Error).message})`) }
  }
  for (const t of plan.productTargets) {
    try {
      const r = await createTargetLocal({ adGroupId, kind: 'PRODUCT', value: t.asin, bidEur: t.startCents / 100, ...common })
      if (r.id && r.ok !== false) { after.targetIds.push(r.id); await remember(r.id, t) } else failed.push(`product target ${t.asin} (${said(r)})`)
    } catch (e) { failed.push(`product target ${t.asin} (${(e as Error).message})`) }
  }

  const change = { before: { changeSetId: run.changeSetId, adGroupId: null }, after }
  const data = {
    adGroupId,
    externalAdGroupId: group.externalAdGroupId,
    campaignId: plan.campaign.id,
    created: { productAds: after.productAdIds.length, targets: after.targetIds.length, negatives: after.negativeIds.length },
    startsAt: plan.start,
    reach: p.reach,
    changeSetId: run.changeSetId,
    nextSteps: plan.start === 'live' ? [] : plan.start === 'campaign'
      ? [`restore-campaign {"campaignId":"${plan.campaign.id}"}`]
      : [`set-ad-group {"adGroupId":"${adGroupId}","op":"start"}`],
  }
  // The ad group exists whatever failed after it: the change is recorded (undo archives it) and says what did not land.
  if (failed.length) {
    return { ok: true, data: { ...data, partial: true, notCreated: failed.slice(0, LINES_SHOWN), note: `Created part-way: ${plural(failed.length, 'row')} did not reach Amazon — ${named(failed)}. The ad group "${plan.name}" (${adGroupId}) holds the rest; check it with ad-groups before asking for more.` }, change }
  }
  return { ok: true, data, change }
}

/** The values a create re-checks before it runs: every row and bid (basis) and where it lands. */
const CREATE_MATERIAL = ['basis', 'reach'] as const

const createAdGroup: AgentTool = {
  name: TOOL.create,
  title: 'Create an Amazon ad group',
  input: CREATE_INPUT,
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  restrictedFields: CHANGE_MONEY,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  // Undo archives it: the ad group stops for good, what it spent stays spent.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: CREATE_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits) ?? createRefusal(preview, limits),
  undo: CREATE_UNDO,
  description:
    'Create a manual ad group in an existing Amazon Sponsored Products campaign, as ONE request: its products (by SKU, '
    + 'one product ad each), keywords OR product targets, each with its planned bid, and the ad group\'s own negatives '
    + '(keywords and ASINs) — through the screen\'s own creates. It is born safe: every bid starts at the 2-cent floor '
    + '(never paused) with its planned bid remembered, so it spends next to nothing until set-ad-group op start gives the '
    + 'planned bids back (inside a campaign a person stopped with low bids it joins that floor, and restore-campaign gives '
    + 'everything back). startLive: true starts the bids as planned — that adds spend, so approving it needs the '
    + 'approver\'s authenticator code. Each product must be sold on Amazon in the campaign\'s market; the same product twice '
    + 'in one campaign is refused (its ads would bid against each other), another product in the campaign is only '
    + 'listed, and the same product in another campaign of the market is warned. A person approves it in Nexus, unless '
    + 'the business lets it run by its rule inside its limits and the ads strategy (by default it does not). The preview '
    + 'shows every row and bid, where it lands (live at Amazon or sandbox), the live-write allowlist and each limit with '
    + 'where it comes from. Refused, and not queued, for an Auto, archived or not-at-Amazon campaign, a taken name, a SKU '
    + 'not found or not sold there, a protected negative, or when Amazon\'s write gate would refuse it. Undo archives the '
    + 'ad group (archive-ads): permanent at Amazon.',
  async handler(args, ctx) {
    return createPreview(args, ctx)
  },
  async execute(args, ctx) {
    return runCreate(args, ctx)
  },
}

// ── add-product-ads ─────────────────────────────────────────────────────────────────────────────

const ADS_INPUT = z.object({
  adGroupId: z.string().trim().min(1).max(64).describe('the ad group: its Nexus id (adGroupId in ad-groups or ad-targets)'),
  skus: z.array(SKU).min(1).max(MAX_ADS).describe(`the Nexus SKUs it advertises, one product ad each (at most ${MAX_ADS}); each must be sold on Amazon in the campaign's market`),
  why: whyArg,
})

const ADS_HOW = 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked confirms it in '
  + 'Claude with theirs when the business set the tool to confirm in Claude. By rule only inside this tool\'s limits.'

async function adsPreview(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'> = {}): Promise<ToolResult> {
  const parsed = ADS_INPUT.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') }
  const a = parsed.data
  const repeated = twice(a.skus)
  if (repeated.length) return { ok: false, error: `Listed twice: ${named(repeated, 5)}.` }
  const group = await loadGroup(a.adGroupId)
  if (!group) return { ok: false, error: `Ad group ${a.adGroupId} not found in this business.` }
  const refused = groupRefusal(group)
  if (refused) return { ok: false, error: `Not queued: ${refused}.` }
  const campaign = group.campaign
  const market = campaign.marketplace!
  const playbook = await playbookRefusal(campaign, 'its product ads are added')
  if (playbook) return { ok: false, error: `Not queued: ${playbook}.` }
  const sold = await productsSoldIn(a.skus, market)
  if ('refusal' in sold) return { ok: false, error: sold.refusal }
  const around = await productsAround(campaign, sold.products)
  if (around.same.length) return { ok: false, error: sameRefusal(around.same, campaign.name) }

  const intent: AdWriteIntent = { campaignId: campaign.id, adGroupId: group.id, marketplace: market, changes: [{ field: 'status', valueCents: null }] }
  const reach = await reachOf([intent])
  if ('refused' in reach) return { ok: false, error: reachRefusal(reach.refused) }
  const stored = reach.reach
  const bound = await alsoChangedBy(campaign.id)
  const currency = campaignCurrency(campaign)
  // Each new ad starts spending at the ad group's bids (a raise, as the limit facts count it), judged where the ad group is.
  const items: KitItem[] = sold.products.map(() => ({ entity: { kind: 'adGroup', id: group.id }, change: { field: 'status', from: null, to: 'ENABLED' } }))
  const rule = await ruleFactsFor({ tool: TOOL.ads, limits: ADS_LIMITS, items, writes: [{ ...intent, label: `campaign "${campaign.name}"` }], approvalId: ctx.approvalId ?? null, projectMonth: true })
  const held = group.bidsSuppressedAt ? `ad group "${group.name}" is held at a floor (by ${whoWords(group.bidsSuppressedBy)})` : campaignFloorWords(campaign)
  const serves = held
    ? `They serve at its bids, which are at a floor now (${held}): they spend next to nothing until its bids are given back.`
    : `They serve at its bids (default ${amountLabel(group.defaultBidCents, currency)}): spend starts with them.`
  const effect = `Adds ${plural(sold.products.length, 'product ad')} to ad group "${group.name}" (campaign "${campaign.name}", ${market}): ${named(sold.products.map((p) => p.sku), 5)}. ${serves}`
  return {
    ok: true,
    preview: {
      action: TOOL.ads,
      campaign: { id: campaign.id, name: campaign.name, marketplace: market },
      adGroup: { id: group.id, name: group.name, defaultBidCents: group.defaultBidCents, ...(held ? { heldAtFloor: held } : {}) },
      currency,
      // Every product (at most 100): `execute` creates exactly these, as approved.
      products: sold.products.map((p) => ({ sku: p.sku, asin: p.asin, adSku: p.adSku, productId: p.productId })),
      totals: { productAds: sold.products.length },
      ...aroundPreview(around),
      raises: sold.products.map((p) => `the ad of ${p.sku}: it serves at the ad group's bids`),
      stepUp: { what: `adds ${plural(sold.products.length, 'product ad')} that serve at the ad group's bids`, raises: ['Product ads', 'Spend'], needs: STEP_UP_NEEDS, how: ADS_HOW },
      liveWrites: campaign.liveBidWritesEnabled,
      liveWritesNote: allowlistWords(campaign),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      basis: hash({ adGroup: [group.id, String(group.status), group.defaultBidCents, group.bidsSuppressedAt?.toISOString() ?? null], products: sold.products, same: around.same, elsewhere: around.elsewhere.map((c) => c.campaignId).sort() }),
      reach: stored,
      reachNote: reachNote(stored),
      ...rule,
      effect,
      undoNote: 'Undo pauses these product ads (pause-ads): they stop serving; Amazon keeps them, paused.',
    },
  }
}

/**
 * add-product-ads' Claude limits: the kit's (maxItems 0 — every request waits for a person until he types a number) and
 * the same product in another enabled campaign of the market (off).
 */
const ADS_LIMITS = adKitLimits({ maxItems: 0 }, {
  allowSelfCompetition: z.boolean().default(false).describe('let it run by rule when the same product already runs in another enabled campaign of the market; off: a person decides'),
})

function adsRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { selfCompetition?: unknown; adGroup?: unknown }
  if (!p.adGroup) return 'there is no preview of these product ads to check; a person decides'
  if (p.selfCompetition && limits.allowSelfCompetition !== true) return 'the same product already runs in another enabled campaign of the market (allowSelfCompetition is off); a person decides'
  return null
}

interface AdsAfter { adGroupId: string; productAds: Array<{ productAdId: string; sku: string; status: string }> }

/** What is stored now for each product ad a change made (the undo guard compares it with `after`). */
async function adsNow(change: ToolChange): Promise<AdsAfter> {
  const after = (change.after ?? {}) as AdsAfter
  const rows = after.productAds?.length ? await prisma.adProductAd.findMany({ where: { id: { in: after.productAds.map((ad) => ad.productAdId) } }, select: { id: true, status: true } }) : []
  const now = new Map(rows.map((r) => [r.id, String(r.status)]))
  return { adGroupId: after.adGroupId, productAds: (after.productAds ?? []).map((ad) => ({ ...ad, status: now.get(ad.productAdId) ?? 'NOT_FOUND' })) }
}

const ADS_UNDO: ToolUndo = {
  current: adsNow,
  request(change) {
    const after = (change.after ?? {}) as Partial<AdsAfter>
    const live = (after.productAds ?? []).filter((ad) => ad.status === 'ENABLED')
    if (!after.adGroupId || !live.length) return { refusal: 'This change does not record a product ad it switched on.' }
    return { tool: 'pause-ads', args: { productAds: live.map((ad) => ({ adGroupId: after.adGroupId!, product: ad.sku })), why: 'undo of product ads Claude added: paused' } }
  },
}

async function runAds(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const fresh = await adsPreview(args, ctx)
  const refusal = recheck(ctx, fresh, ADS_MATERIAL)
  if (refusal) return notRun(refusal)
  const p = fresh.preview as { adGroup: { id: string; name: string }; products: AdProduct[]; reach: StoredReach; effect: string }
  const run = approvedRun(ctx, String(args.why ?? '').trim() || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  // Each new ad adds spend: the approver's code, or the business's rule inside its limits.
  const gate = await spendGate(ctx, true)
  if (gate) return notRun(gate.refusal)
  const { createProductAdLocal } = await import('../../advertising/ads-create.service.js')
  const ids: string[] = []
  const failed: string[] = []
  for (const product of p.products) {
    try {
      const r = await createProductAdLocal({
        adGroupId: p.adGroup.id, sku: product.sku, asin: product.asin, productId: product.productId,
        userId: run.actor, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId, requireAmazon: true,
      })
      if (r.id && r.ok !== false) ids.push(r.id)
      else failed.push(`${product.sku} (${r.reason ?? r.notSent?.reason ?? 'not created'})`)
    } catch (e) { failed.push(`${product.sku} (${(e as Error).message})`) }
  }
  if (!ids.length) return notRun(`Not run: Amazon took none of the product ads — ${named(failed)}. Nothing was created.`)
  // Each ad as Amazon holds it: by the seller SKU it was created from (pause-ads names it the same way in an undo).
  const rows = await prisma.adProductAd.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, asin: true, status: true } })
  const made: AdsAfter['productAds'] = rows.map((r) => ({ productAdId: r.id, sku: r.sku ?? r.asin ?? '', status: String(r.status) }))
  const change = { before: { changeSetId: run.changeSetId, adGroupId: p.adGroup.id, productAds: [] }, after: { adGroupId: p.adGroup.id, productAds: made } }
  const data = { adGroupId: p.adGroup.id, created: made.length, productAds: made, reach: p.reach, changeSetId: run.changeSetId }
  if (failed.length) return { ok: true, data: { ...data, partial: true, notCreated: failed.slice(0, LINES_SHOWN), note: `Added part-way: ${plural(failed.length, 'product ad')} did not reach Amazon — ${named(failed)}.` }, change }
  return { ok: true, data, change }
}

const ADS_MATERIAL = ['basis', 'reach'] as const

const addProductAds: AgentTool = {
  name: TOOL.ads,
  title: 'Add Amazon product ads',
  input: ADS_INPUT,
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  restrictedFields: CHANGE_MONEY,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  // Undo pauses them: Amazon keeps a product ad once made (paused), and what it spent stays spent.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: ADS_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits) ?? adsRefusal(preview, limits),
  undo: ADS_UNDO,
  description:
    'Add product ads (by SKU, up to 100) to an existing ad group of an Amazon Sponsored Products campaign, through the '
    + 'screen\'s own create. Each serves at the ad group\'s bids, so it adds spend: approving it needs the approver\'s '
    + 'authenticator code (in Nexus, or the person who asked confirms it in Claude) — unless the business lets it run by '
    + 'its rule inside its limits and the ads strategy (by default it does not). Each product must be sold on Amazon in '
    + 'the campaign\'s market (a live listing with an ASIN); the same product twice in one campaign is refused (its ads '
    + 'would bid against each other), another product in the campaign is only listed, and the same product in another '
    + 'enabled campaign of the market is warned. The preview names each product and the seller SKU Amazon holds, the '
    + 'bids they serve at, where it lands (live at Amazon or sandbox) and each limit with where it comes from. Refused, '
    + 'and not queued, for an archived or not-at-Amazon ad group, a SKU not found or not sold there, or when Amazon\'s '
    + 'write gate would refuse it. Undo pauses them (pause-ads).',
  async handler(args, ctx) {
    return adsPreview(args, ctx)
  },
  async execute(args, ctx) {
    return runAds(args, ctx)
  },
}

// ── set-ad-group ────────────────────────────────────────────────────────────────────────────────

const SET_OPS = ['edit', 'stop', 'start'] as const
type SetOp = (typeof SET_OPS)[number]

const SET_INPUT = z.object({
  adGroupId: z.string().trim().min(1).max(64).describe('the ad group: its Nexus id (adGroupId in ad-groups or ad-targets)'),
  op: z.enum(SET_OPS).default('edit')
    .describe('edit (default): its default bid and/or name; stop: its bids to the stop bid, each remembered (a temporary stop is low bids, never a pause); start: the bids a floor of its own remembered given back (e.g. after create-ad-group born at the floor)'),
  defaultBidCents: z.coerce.number().int().min(2).max(BID_MAX_CENTS).optional().describe("op edit: the new default bid in minor units of the campaign's currency"),
  name: z.string().trim().min(1).max(128).optional().describe("op edit: the new name; new among the campaign's ad groups"),
  why: whyArg,
})
type SetArgs = z.infer<typeof SET_INPUT>

/** One bid a stop lowers or a start gives back. */
interface BidMove { kind: 'adGroup' | 'target'; id: string; text: string; fromCents: number; toCents: number; rememberedCents?: number | null; heldBy?: string | null }

async function setPreview(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'> = {}): Promise<ToolResult> {
  const parsed = SET_INPUT.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') }
  const a: SetArgs = parsed.data
  const group = await loadGroup(a.adGroupId)
  if (!group) return { ok: false, error: `Ad group ${a.adGroupId} not found in this business.` }
  const refused = groupRefusal(group)
  if (refused) return { ok: false, error: `Not queued: ${refused}.` }
  if (a.op !== 'edit' && (a.defaultBidCents != null || a.name)) return { ok: false, error: `op ${a.op} changes the ad group's bids as a whole: name no defaultBidCents or name (op edit sets those).` }
  if (a.op === 'edit') return editPreview(a, group, ctx)
  return floorPreview(a.op, group, ctx)
}

/** op edit — the default bid as set-target-bid moves a bid, and the name. */
async function editPreview(a: SetArgs, group: GroupRow, ctx: Pick<ToolContext, 'approvalId'>): Promise<ToolResult> {
  if (a.defaultBidCents == null && !a.name) return { ok: false, error: 'Name what changes: defaultBidCents and/or name (or op stop / op start for its bids as a whole).' }
  const campaign = group.campaign
  const currency = campaignCurrency(campaign)
  const changes: Array<{ field: 'defaultBid' | 'name'; from: string; to: string }> = []
  let bid: { currentBidCents: number; proposedBidCents: number; effectiveBidCents: number; clampedBy: string | null } | null = null
  if (a.defaultBidCents != null) {
    const current = group.defaultBidCents
    // The bid that lands: the largest change per action — the lower of the campaign's max-change guardrail and the ads
    // strategy's for this ad group (stepClamp), as set-target-bid previews a bid; the write gate judges the band.
    const strategy = await bidLimitsFor({ marketplace: campaign.marketplace, adGroupId: group.id, campaignId: campaign.id })
    const step = stepClamp(current, a.defaultBidCents, campaign.dynamicBidding, strategy)
    // No-pause: a bid a floor holds is never raised here; the floor's own give-back lifts it.
    const verdict = suppressionOf({ id: group.id, bidCents: current, suppressedFromBidCents: group.suppressedFromBidCents }, step.cents)
    if (verdict !== 'ok' || ((group.bidsSuppressedAt || campaign.bidsSuppressedAt) && step.cents > current)) {
      const floor = group.bidsSuppressedAt ? `ad group "${group.name}" is held at a floor (by ${whoWords(group.bidsSuppressedBy)})` : campaignFloorWords(campaign) ?? `its default bid sits at ${amountLabel(current, currency)}, the floor another path lowered it to`
      const back = group.bidsSuppressedAt && isPerson(group.bidsSuppressedBy) ? 'set-ad-group op start gives its bids back' : campaign.bidsSuppressedAt && isPerson(campaign.bidsSuppressedBy) ? 'restore-campaign gives its bids back' : 'the floor\'s own give-back lifts it'
      return { ok: false, error: `Not queued: ${floor}: its default bid is not raised here — ${back}.` }
    }
    bid = { currentBidCents: current, proposedBidCents: a.defaultBidCents, effectiveBidCents: step.cents, clampedBy: step.cents !== a.defaultBidCents ? stepClampWords(step, strategy) : null }
    if (bid.effectiveBidCents !== current) changes.push({ field: 'defaultBid', from: amountLabel(current, currency), to: amountLabel(bid.effectiveBidCents, currency) })
  }
  if (a.name && a.name !== group.name) {
    const taken = await adGroupNamedInCampaign(campaign.id, a.name, group.id)
    if (taken) return { ok: false, error: `Campaign "${campaign.name}" already has an ad group named "${taken.name}" (${taken.id}): choose another name.` }
    changes.push({ field: 'name', from: `"${group.name}"`, to: `"${a.name}"` })
  }
  if (!changes.length) return { ok: false, error: `Nothing would change: ad group "${group.name}" already has ${bid ? `a default bid of ${amountLabel(group.defaultBidCents, currency)}` : 'this name'}${bid?.clampedBy ? ` (the largest change per action holds it there: ${bid.clampedBy})` : ''}.` }

  const newBid = changes.some((c) => c.field === 'defaultBid') ? bid!.effectiveBidCents : null
  const intent: AdWriteIntent = {
    campaignId: campaign.id, adGroupId: group.id, marketplace: campaign.marketplace,
    changes: [...(newBid != null ? [{ field: 'defaultBid', valueCents: newBid }] : []), ...(changes.some((c) => c.field === 'name') ? [{ field: 'name', valueCents: null }] : [])],
  }
  const reach = await reachOf([intent])
  if ('refused' in reach) return { ok: false, error: reachRefusal(reach.refused) }
  const stored = reach.reach
  const bound = await alsoChangedBy(campaign.id)
  // AA-W2-6's kit: the default bid that lands against the ads strategy of this ad group and Claude's limits (a rename
  // moves no money: it is one change of the ad group), and the write gate as it judges a run by rule.
  const items: KitItem[] = newBid != null
    ? [{ entity: { kind: 'adGroup', id: group.id }, change: { field: 'bid', fromCents: bid!.currentBidCents, toCents: newBid } }]
    : [{ entity: { kind: 'adGroup', id: group.id }, change: { field: 'automation' } }]
  const rule = await ruleFactsFor({ tool: TOOL.set, limits: SET_LIMITS, items, writes: [{ ...intent, label: `campaign "${campaign.name}"` }], approvalId: ctx.approvalId ?? null, action: 'bid' })
  const raise = newBid != null && newBid > bid!.currentBidCents
  const effect = `Changes ad group "${group.name}" (campaign "${campaign.name}"): ${changes.map((c) => `${c.field === 'defaultBid' ? 'default bid' : 'name'} ${c.from} → ${c.to}`).join(', ')}.`
    + (bid?.clampedBy && newBid != null ? ` The ${amountLabel(bid.proposedBidCents, currency)} asked for is held at ${amountLabel(newBid, currency)} by ${bid.clampedBy}.` : '')
    + (newBid != null ? ' The default bid is what its auto targets and every keyword or target without a bid of its own bid.' : '')
  return {
    ok: true,
    preview: {
      action: TOOL.set,
      op: 'edit',
      adGroup: { id: group.id, name: group.name },
      campaign: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      currency,
      ...(bid ? { currentBidCents: bid.currentBidCents, proposedBidCents: bid.proposedBidCents, effectiveBidCents: newBid ?? bid.currentBidCents, ...(bid.clampedBy ? { clampedBy: bid.clampedBy } : {}) } : {}),
      ...(changes.some((c) => c.field === 'name') ? { name: { from: group.name, to: a.name } } : {}),
      changes,
      raises: raise ? [`the default bid ${amountLabel(bid!.currentBidCents, currency)} → ${amountLabel(newBid!, currency)}`] : [],
      noCode: 'A default bid moves like a keyword bid (set-target-bid): approving it needs no authenticator code; a raise by rule waits for a person unless the business\'s limits allow it.',
      basis: hash({ op: 'edit', group: [group.id, group.name, group.defaultBidCents], to: [newBid, a.name ?? null] }),
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      ...rule,
      effect,
    },
  }
}

/** op stop / op start — the ad group's bids as a whole, through the floor's own services. */
async function floorPreview(op: 'stop' | 'start', group: GroupRow, ctx: Pick<ToolContext, 'approvalId'>): Promise<ToolResult> {
  const campaign = group.campaign
  const currency = campaignCurrency(campaign)
  const campaignFloor = campaignFloorWords(campaign)
  // Inside a campaign stopped with low bids, its bids are the campaign's floor's: that floor's owner moves them.
  if (campaignFloor) {
    return { ok: false, error: `Not queued: ${campaignFloor}: its ad groups' bids are that floor's — ${isPerson(campaign.bidsSuppressedBy) ? 'restore-campaign gives them back' : 'the engine that set it gives them back'}${op === 'stop' ? ', and they already serve at it' : ''}.` }
  }
  // PB-5b — a playbook's campaign: its bids stop and start only with the playbook's own ops (START needs the code).
  const playbook = await playbookRefusal(campaign, 'its ad groups\' bids move')
  if (playbook) return { ok: false, error: `Not queued: ${playbook}.` }
  let moves: BidMove[] = []
  let stop: { cents: number; from: string } | null = null
  if (op === 'stop') {
    if (group.bidsSuppressedAt && !isPerson(group.bidsSuppressedBy)) return { ok: false, error: `Not queued: ad group "${group.name}" is held at a floor ${group.bidsSuppressedBy ?? 'an engine'} set: that engine moves it.` }
    // The stop bid: the ads strategy's for its campaign (the lower across its products), else the 2-cent floor (W1-6).
    const found = (await stopBidsFor([{ id: campaign.id, marketplace: campaign.marketplace }])).get(campaign.id)
    const cents = found?.cents ?? SUPPRESSION_FLOOR_CENTS
    stop = { cents, from: found?.source ? strategySourceWords(found.source) : 'the 2-cent floor (the ads strategy sets no stop bid here)' }
    // The bids lowerAdGroupBids lowers: the default bid and every keyword and target bid above the stop bid.
    const targets = await prisma.adTarget.findMany({ where: { adGroupId: group.id, isNegative: false, bidCents: { gt: cents } }, select: { id: true, expressionValue: true, bidCents: true, suppressedFromBidCents: true }, orderBy: { id: 'asc' } })
    moves = [
      ...(group.defaultBidCents > cents ? [{ kind: 'adGroup' as const, id: group.id, text: 'default bid', fromCents: group.defaultBidCents, toCents: cents, rememberedCents: group.suppressedFromBidCents ?? group.defaultBidCents }] : []),
      ...targets.map((t) => ({ kind: 'target' as const, id: t.id, text: t.expressionValue, fromCents: t.bidCents, toCents: cents, rememberedCents: t.suppressedFromBidCents ?? t.bidCents })),
    ]
    if (!moves.length) return { ok: false, error: `Nothing would change: every bid of ad group "${group.name}" is already at or below ${amountLabel(cents, currency)}.` }
  } else {
    if (!group.bidsSuppressedAt) return { ok: false, error: `Nothing would change: ad group "${group.name}" is not held at a floor of its own (set-ad-group op stop puts it there; a born-at-the-floor ad group holds one until started).` }
    if (!isPerson(group.bidsSuppressedBy)) return { ok: false, error: `Not queued: ad group "${group.name}" is held at a floor ${group.bidsSuppressedBy ?? 'an unrecorded actor'} set (an engine): only a floor a person set (create-ad-group's, or set-ad-group op stop's) is given back here; that engine gives back its own.` }
    const targets = await prisma.adTarget.findMany({ where: { adGroupId: group.id, suppressedFromBidCents: { not: null } }, select: { id: true, expressionValue: true, bidCents: true, suppressedFromBidCents: true, adGroupId: true }, orderBy: { id: 'asc' } })
    const entries = [
      ...(group.suppressedFromBidCents != null ? [{ id: `adGroup:${group.id}`, adGroupId: group.id, bidCents: group.defaultBidCents, suppressedFromBidCents: group.suppressedFromBidCents }] : []),
      ...targets.map((t) => ({ id: `target:${t.id}`, adGroupId: group.id, bidCents: t.bidCents, suppressedFromBidCents: t.suppressedFromBidCents as number })),
    ]
    // Each remembered bid as restoreAdGroupBids gives it back: held inside the campaign's bounds, the bid policies and
    // the ads strategy band of the ad group's products (W1-5).
    const back = await restoreBidsFor(campaign.id, entries)
    moves = [
      ...(group.suppressedFromBidCents != null ? [{ kind: 'adGroup' as const, id: group.id, text: 'default bid', fromCents: group.defaultBidCents, toCents: back.get(`adGroup:${group.id}`)?.cents ?? group.suppressedFromBidCents, rememberedCents: group.suppressedFromBidCents, heldBy: back.get(`adGroup:${group.id}`)?.heldBy ?? null }] : []),
      ...targets.map((t) => ({ kind: 'target' as const, id: t.id, text: t.expressionValue, fromCents: t.bidCents, toCents: back.get(`target:${t.id}`)?.cents ?? (t.suppressedFromBidCents as number), rememberedCents: t.suppressedFromBidCents, heldBy: back.get(`target:${t.id}`)?.heldBy ?? null })),
    ]
  }
  const top = moves.reduce<BidMove | null>((best, m) => (!best || (op === 'start' ? m.toCents > best.toCents : m.fromCents > best.fromCents) ? m : best), null)
  const highest = op === 'start' ? (top?.toCents ?? 0) : (top?.fromCents ?? 0)
  // A stop lets go of spend (a deliberate lowering: the halt does not hold it); a start adds spend, so the halt binds it
  // (as restore-ad-bids-after-stock's give-back, the W3-3 review).
  const intent: AdWriteIntent = { campaignId: campaign.id, adGroupId: group.id, marketplace: campaign.marketplace, changes: [{ field: 'bid', valueCents: op === 'stop' ? stop!.cents : highest || null }], isSuppression: op === 'stop' }
  const reach = await reachOf([intent])
  if ('refused' in reach) return { ok: false, error: reachRefusal(reach.refused) }
  const stored = reach.reach
  const bound = await alsoChangedBy(campaign.id)
  // AA-W2-9's terms: a stop is the ad group's bids going down together (a stop's low bid: no lowest bid and no step binds
  // it); a start is a restart of the ad group (it can spend again: projected in the month), with the bids it gives back.
  const items: KitItem[] = op === 'stop'
    ? [{ entity: { kind: 'adGroup', id: group.id }, change: { field: 'bid', fromCents: highest, toCents: stop!.cents, forced: true } }]
    : [{ entity: { kind: 'adGroup', id: group.id }, change: { field: 'status', from: 'LOW_BIDS', to: 'ENABLED' } }]
  const rule = await ruleFactsFor({ tool: TOOL.set, limits: SET_LIMITS, items, writes: [{ ...intent, label: `campaign "${campaign.name}"` }], approvalId: ctx.approvalId ?? null, projectMonth: op === 'start', action: op === 'stop' ? 'stop' : 'restore' })
  const held = moves.filter((m) => m.heldBy)
  const lines = moves.map((m) => ({ kind: m.kind, id: m.id, text: m.text, fromCents: m.fromCents, toCents: m.toCents, ...(m.heldBy ? { rememberedCents: m.rememberedCents, heldBy: m.heldBy } : {}) }))
  const effect = op === 'stop'
    ? `Lowers ${plural(moves.length, 'bid')} of ad group "${group.name}" (campaign "${campaign.name}") to ${amountLabel(stop!.cents, currency)} — ${stop!.from} — so it stops winning auctions without being paused. Each bid is remembered; set-ad-group op start puts them back.`
    : `Gives back ${plural(moves.length, 'bid')} the floor of ad group "${group.name}" (campaign "${campaign.name}") remembered${highest ? `, the highest ${amountLabel(highest, currency)}` : ''}${held.length ? `; ${plural(held.length, 'bid')} at a bid limit instead of the bid it had (each line says which)` : ''}. It spends again.`
  return {
    ok: true,
    preview: {
      action: TOOL.set,
      op,
      adGroup: { id: group.id, name: group.name, floor: group.bidsSuppressedAt ? { by: group.bidsSuppressedBy, since: group.bidsSuppressedAt.toISOString() } : null },
      campaign: { id: campaign.id, name: campaign.name, marketplace: campaign.marketplace },
      currency,
      ...(stop ? { stopBidCents: stop.cents, stopBidFrom: stop.from } : {}),
      totals: { bids: moves.length },
      bids: lines.slice(0, LINES_SHOWN),
      ...(lines.length > LINES_SHOWN ? { moreBids: lines.length - LINES_SHOWN } : {}),
      ...(op === 'start' ? { highestRestoredBidCents: highest } : {}),
      raises: op === 'start' ? [`ad group "${group.name}" spends again: ${plural(moves.length, 'bid')} given back`] : [],
      noCode: op === 'start'
        ? 'Giving a floor\'s bids back is a restore, like restore-campaign: approving it needs no authenticator code; by rule only up to the highest bid this tool\'s limits allow (0 by default).'
        : 'A stop lowers spend: it needs no authenticator code.',
      // Every bid it moves, from where to where, and whose floor it lifts: a move after approval is caught (the cents
      // only: a limit's words name its strategy row's version, and saving the row again moves nothing here).
      basis: hash({ op, floor: [group.bidsSuppressedAt?.toISOString() ?? null, group.bidsSuppressedBy], moves: moves.map((m) => [m.kind, m.id, m.fromCents, m.toCents]) }),
      reach: stored,
      reachNote: reachNote(stored),
      alsoChangedBy: bound.automations,
      ...(bound.note ? { alsoChangedByNote: bound.note } : {}),
      ...rule,
      effect,
    },
  }
}

/**
 * set-ad-group's Claude limits: the kit's, a default bid's raise and cut steps (as set-target-bid: no raise by rule until
 * a person types a number), a rename (off), and the highest bid a start gives back (0: every start waits for a person).
 */
const SET_LIMITS = adKitLimits({ maxItems: 1 }, {
  ...STEP_PCT_LIMITS,
  allowRename: z.boolean().default(false).describe('let a rename run by rule; off: a person decides'),
  maxRestoredBidCents: z.number().int().min(0).max(100_000).default(0)
    .describe("op start: the highest bid it may give back without a person, in minor units of the campaign's currency; 0 = every start waits for a person"),
})

function setRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { op?: SetOp; name?: unknown; highestRestoredBidCents?: unknown; currency?: unknown }
  if (!p.op) return 'the preview does not say what it does to the ad group; a person decides'
  if (p.name && limits.allowRename !== true) return 'it renames the ad group: this tool\'s limits let no rename run by rule (allowRename is off); a person decides'
  if (p.op === 'start') {
    const highest = Number(p.highestRestoredBidCents)
    if (!Number.isFinite(highest)) return 'the preview does not say the highest bid it gives back; a person decides'
    const max = typeof limits.maxRestoredBidCents === 'number' ? limits.maxRestoredBidCents : 0
    const currency = typeof p.currency === 'string' ? p.currency : 'EUR'
    if (highest > max) return `its highest bid given back is ${amountLabel(highest, currency)}, more than the ${amountLabel(max, currency)} this tool's limits let run without a person${max === 0 ? ' (0: every start waits for a person)' : ''}; a person decides`
  }
  return null
}

/** What a set-ad-group change records: the ad group's default bid, name and floor (the undo guard compares them). */
interface SetState { adGroupId: string; op: SetOp; defaultBidCents: number | null; name: string | null; floored: boolean; by: string | null }

async function setStateNow(adGroupId: string, op: SetOp): Promise<SetState> {
  const g = await adGroupState(adGroupId)
  return { adGroupId, op, defaultBidCents: g?.defaultBidCents ?? null, name: g?.name ?? null, floored: !!g?.bidsSuppressedAt, by: g?.bidsSuppressedAt ? g.bidsSuppressedBy ?? null : null }
}

/**
 * C2 — undo through set-ad-group itself: an edit sets the default bid and name it replaced (the same guards, preview and
 * approval); a stop is undone by a start, a start by a stop.
 */
const SET_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as Partial<SetState>
    return after.adGroupId ? setStateNow(after.adGroupId, after.op ?? 'edit') : change.after
  },
  request(change) {
    const before = (change.before ?? {}) as Partial<SetState> & { changeSetId?: string }
    const after = (change.after ?? {}) as Partial<SetState>
    if (!before.adGroupId) return { refusal: 'This change does not name its ad group.' }
    if (before.op === 'stop') return { tool: TOOL.set, args: { adGroupId: before.adGroupId, op: 'start', why: 'undo of a stop: its bids back' } }
    if (before.op === 'start') return { tool: TOOL.set, args: { adGroupId: before.adGroupId, op: 'stop', why: 'undo of a start: its bids back to the floor' } }
    const args: Record<string, unknown> = { adGroupId: before.adGroupId, op: 'edit', why: 'undo of an earlier ad group change' }
    if (before.defaultBidCents != null && before.defaultBidCents !== after.defaultBidCents) args.defaultBidCents = before.defaultBidCents
    if (before.name && before.name !== after.name) args.name = before.name
    if (args.defaultBidCents == null && !args.name) return { refusal: 'This change records nothing to put back.' }
    if (typeof args.defaultBidCents === 'number' && args.defaultBidCents < 2) return { refusal: `The default bid before this change (${args.defaultBidCents}c) is below the 2-cent minimum a default bid may be set to.` }
    return { tool: TOOL.set, args }
  },
}

async function runSet(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const fresh = await setPreview(args, ctx)
  const refusal = recheck(ctx, fresh, SET_MATERIAL)
  if (refusal) return notRun(refusal)
  const p = fresh.preview as { op: SetOp; adGroup: { id: string; name: string }; effectiveBidCents?: number; currentBidCents?: number; name?: { from: string; to: string }; stopBidCents?: number; changes?: Array<{ field: string }>; reach: StoredReach; effect: string }
  const run = approvedRun(ctx, String(args.why ?? '').trim() || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const before = { ...(await setStateNow(p.adGroup.id, p.op)), changeSetId: run.changeSetId }
  const write = { actor: run.actor, reason: run.reason, changeSetId: run.changeSetId, manual: run.manual }
  if (p.op === 'edit') {
    const bidChanges = (p.changes ?? []).some((c) => c.field === 'defaultBid')
    const out = await updateAdGroupWithSync({
      adGroupId: p.adGroup.id,
      patch: { ...(bidChanges ? { defaultBidCents: p.effectiveBidCents } : {}), ...(p.name ? { name: p.name.to } : {}) },
      ...write,
      confirmOwnLimits: run.confirmOwnLimits,
    })
    if (!out.ok) return notRun(`Not run: the write was refused (${out.error ?? 'unknown'}). Nothing changed.`)
    const after = await setStateNow(p.adGroup.id, 'edit')
    return {
      ok: true,
      data: { adGroupId: p.adGroup.id, defaultBidCents: after.defaultBidCents, name: after.name, reach: p.reach, changeSetId: run.changeSetId, outboundQueueId: out.outboundQueueId, note: out.outboundQueueId ? 'Queued for Amazon: it is sent after the 5-minute cancel window. approval-status follows it.' : 'Nothing was queued: the ad group already had these values.' },
      ...(out.error === 'no_changes' ? {} : { change: { before, after } }),
    }
  }
  if (p.op === 'stop') {
    const out = await lowerAdGroupBids(p.adGroup.id, { ...write, floorCents: p.stopBidCents! })
    const after = await setStateNow(p.adGroup.id, 'stop')
    if (!after.floored) return notRun('Not run: the ad group was not lowered (its campaign or an engine floored it meanwhile). Nothing changed.')
    const data = { adGroupId: p.adGroup.id, lowered: out.moved, reach: p.reach, changeSetId: run.changeSetId, note: 'Bids lowered and remembered; each is sent to Amazon at once. set-ad-group op start gives them back.' }
    if (out.failed) return { ok: true, data: { ...data, partial: true, notLowered: out.failed, note: `Lowered part-way: ${plural(out.failed, 'bid')} refused by the write. ${data.note}` }, change: { before, after } }
    return { ok: true, data, change: { before, after } }
  }
  const restored = await restoreAdGroupBids(p.adGroup.id, write)
  const after = await setStateNow(p.adGroup.id, 'start')
  const change = { before, after }
  if (after.floored) return { ok: false, error: `Partly given back: ${plural(restored, 'bid')} put back, some not; the ad group stays at its floor until all are. Approve again to retry.`, change }
  return { ok: true, data: { adGroupId: p.adGroup.id, restored, reach: p.reach, changeSetId: run.changeSetId, note: 'Bids given back; each is sent to Amazon at once.' }, change }
}

/** What a set-ad-group re-checks before it runs: every value it starts from and sets (basis) and where it lands. */
const SET_MATERIAL = ['op', 'basis', 'reach'] as const

const setAdGroup: AgentTool = {
  name: TOOL.set,
  title: 'Change an Amazon ad group',
  input: SET_INPUT,
  requires: [F.adsBidsEdit, F.adsCampaignsManage, FIELDS.financialsAdspendView],
  restrictedFields: CHANGE_MONEY,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  // A start gives a floor's bids back (it adds spend, as restore-campaign): no policy may let it run unasked.
  alwaysAsk: true,
  requiresApprovalDefault: true,
  // An edit is sent after the 5-minute cancel window; a stop's and a start's bids are sent at once.
  openWorld: true,
  reversibility: 'full',
  strategyBound: 'amazon-ads',
  maxClaudeTrust: 'auto',
  limits: SET_LIMITS,
  withinLimits: (preview, limits) => ruleRefusal(preview, limits) ?? setRefusal(preview, limits),
  undo: SET_UNDO,
  description:
    'Change one ad group of an Amazon Sponsored Products campaign. op edit: its default bid (the bid of its auto targets '
    + 'and of every keyword or target without its own), moved like a keyword bid in set-target-bid — held to the largest '
    + 'change per action the campaign and the ads strategy allow, never raising a bid a floor holds — and/or its name '
    + '(new in its campaign). op stop: every bid of it to the stop bid the ads strategy sets (the 2-cent floor when it '
    + 'sets none), each remembered — the temporary stop, never a pause. op start: the bids a floor of its own remembered '
    + 'given back (e.g. the planned bids of an ad group create-ad-group made at the floor); it spends again. Nothing '
    + `changes until it is approved: in Nexus, or the person who asked confirms it in Claude. ${BY_RULE_WORDS} (by default `
    + 'a default-bid cut and a stop; no raise, rename or start). The preview shows each value from → to in the campaign\'s '
    + 'currency, where it lands (live at Amazon or sandbox), the rules that may move it again and each limit with where '
    + 'it comes from. Refused, and not queued, for an archived or not-at-Amazon ad group, a taken name, a floor an engine '
    + 'or the campaign holds, or when Amazon\'s write gate would refuse it. Pausing, enabling and archiving an ad group are '
    + 'pause-ads, enable-ads and archive-ads. undo-change puts back what it changed.',
  async handler(args, ctx) {
    return setPreview(args, ctx)
  },
  async execute(args, ctx) {
    return runSet(args, ctx)
  },
}

export const ADS_AD_GROUP_TOOLS: AgentTool[] = [adGroupsRead, createAdGroup, addProductAds, setAdGroup]

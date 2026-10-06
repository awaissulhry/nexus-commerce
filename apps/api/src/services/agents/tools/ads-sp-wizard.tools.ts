/**
 * B-3 (builders for Claude, Owner 10-07, option A) — build-sp-wizard-campaigns: Claude asks for a ONE-OFF campaign set
 * built by the SP Super Wizard, outside any playbook — structure Standard (5 campaigns), Advanced (11) or Custom, the
 * shapes the wizard's screens make (Quick and Guided post to the same launch: a Custom set of their roles). The
 * campaigns are the wizard's own (ads-sp-wizard-structure.ts: the screen's generator and negative funnel, server side)
 * and the create path is the wizard's own launch (ads-sp-wizard-launch.service.ts, Owner rule 1) with the options the
 * ads playbook's build passes it (PB-5a, ads-playbook/build.ts). No new create path.
 *
 * Born safe, whatever the screen does:
 *   floor        every bid above the 2-cent floor is created AT it with the planned bid remembered, and each campaign is
 *                flagged suppressed by the person who asked (`bornSuppressed`). Born ENABLED, never paused.
 *   allowlist    born OFF the live-write allowlist (`allowlistAtBirth: false`): its own parts still reach Amazon (the
 *                launch passes creationFlow), but no engine, rule or later edit writes to it until a person approves
 *                set-campaign-live-writes.
 *   placements   never written at birth (`deferPlacements`): the answer names each campaign's set-placement-multipliers
 *                request, to ask once it is on the allowlist.
 *   rules        none: no harvest, negative-targeting or bid-strategy rule and no AI Control plan (the screen's step 3).
 *   undo         every audit row carries the approval as its change set; undo archives what it made (archive-ads).
 * Going live is not this tool: set-campaign-live-writes and restore-campaign, each a kind and an approval of its own.
 *
 * The Owner's rule 3 (10-06): the funnel's negatives stay inside this ONE set. The wizard's path has no server gate, so
 * a keyword the same product already buys in another campaign is said as a warning, and one another product buys is
 * listed, never blocked. Nothing outside the set is touched (rule 2: a term converting elsewhere is never moved or
 * negated).
 *
 * Like every ad change tool (ads-change-kit.ts): the preview runs the wizard's own launch checks (its dry run: names,
 * Amazon's ranges; his settings as warnings) and states where it lands; a refusal is not queued; it runs only as an
 * approved request, as the approver, and refuses when what was approved moved. It runs inside the approval, as the
 * screen runs it inside its request. Strategy-bound like create-ad-campaign (the create kind): by rule only inside the
 * ads strategy and this tool's limits — by default never (maxCampaigns 0, no market listed).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { checkAdsWriteGate } from '../../advertising/ads-write-gate.js'
import { SUPPRESSION_FLOOR_CENTS } from '../../advertising/ads-bid-suppression.service.js'
import { campaignStructureCounts } from '../../advertising/ads-entity-lookup.service.js'
import { normaliseNegTerm } from '../../advertising/ads-protect-converting.js'
import { blockedPositive, type Positive } from '../../advertising/ads-winner-lock.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import {
  applyWizardFunnel, autoGroupBidCents, dedupeKeywords, generateWizardCampaigns, WIZARD_AUTO_GROUPS,
  type WizardCampaign, type WizardMatch, type WizardStructure,
} from '../../advertising/ads-sp-wizard-structure.js'
import type { SpwLaunchBody } from '../../advertising/ads-sp-wizard-launch.service.js'
import type { AdsActor } from '../../advertising/ads-mutation.service.js'
import { marketCurrency } from '../../pim/market-currency.js'
import { amountLabel, liveReachOf } from './ads-tool-guards.js'
import { approvedRun, canonical, notRun, reachNote, reachRefusal, recheck, requesterOf, storedReach, strategyFactsMoney, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, buildLimitFacts, commonRefusal, limitFactsOf, limitsNote } from './ads-autonomy-kit.js'
import type { AgentTool, FieldPermission, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = 'build-sp-wizard-campaigns'
const LIST_MAX = 100
const BID_MAX_CENTS = 10_000
/** The most campaigns one set holds (Custom: Auto, 10 keyword types at three match types, PAT). */
const MAX_CAMPAIGNS = 32
/** One build runs inside its approval, as the screen's launch runs inside its request: a set past this is split. */
const MAX_WRITES = 2000

const keywordList = (what: string) => z.array(z.string().trim().min(1).max(80)).max(LIST_MAX).optional().describe(what)
const ASIN = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'an ASIN is 10 letters and digits')
const MATCH = z.enum(['BROAD', 'PHRASE', 'EXACT'])
const pctArg = (label: string) => z.coerce.number().int().min(0).max(900).optional().describe(`${label} adjustment in percent, 0–900`)

const input = z.object({
  market: z.string().trim().toUpperCase().min(2).max(20).describe('ONE Amazon marketplace code: IT, DE, FR, ES, UK, … (business-overview lists them)'),
  productGroupName: z.string().trim().min(1).max(60)
    .describe('the wizard\'s Product Group Name: every campaign\'s name starts with it (e.g. "<group>-SP-Auto"), and every name must be new in the market'),
  skus: z.array(z.string().trim().min(1).max(64)).min(1).max(50)
    .describe('the Nexus SKUs the set advertises, one product ad each in every campaign: ONE product (or its variations), at most 50'),
  structure: z.enum(['standard', 'advanced', 'custom'])
    .describe('standard: 5 campaigns — Auto; Brand, Competitor and Category keywords, each at broad, phrase and exact in one campaign; product targeting (PAT). advanced: 11 — Auto; each of Brand, Competitor and Category at broad, at phrase and at exact in a campaign of its own; PAT. custom: the campaign types (customTargeting) and keyword types (customKeywordTypes) you name'),
  keywords: z.object({
    brand: keywordList('Brand keywords: searches for your own brand'),
    competitor: keywordList('Competitor keywords: searches for another brand'),
    category: keywordList('Category keywords: searches for the kind of product'),
  }).optional().describe('standard / advanced: the keywords of each keyword type (at most 100 each); a keyword type with none gets no campaign, as it would serve nothing'),
  customKeywordTypes: z.array(z.object({
    name: z.string().trim().min(1).max(30).describe('the keyword type\'s name; it goes into its campaigns\' names (e.g. Research)'),
    matchTypes: z.array(MATCH).min(1).max(3).describe('the match types it is built at: one campaign each'),
    keywords: z.array(z.string().trim().min(1).max(80)).min(1).max(LIST_MAX).describe('its keywords, at most 100'),
  })).max(10).optional().describe('custom: the keyword types, each built at its match types (one campaign per match type), at most 10'),
  customTargeting: z.array(z.enum(['auto', 'keyword', 'product'])).min(1).max(3).optional()
    .describe('custom: the campaign types it builds — auto, keyword, product (PAT); default all three'),
  productTargets: z.array(ASIN).max(LIST_MAX).optional()
    .describe('the ASINs the product-targeting (PAT) campaign shows on, at most 100; without any, no PAT campaign is built'),
  dailyBudgetCents: z.coerce.number().int().positive()
    .describe('each campaign\'s daily budget, in minor units of the market\'s currency (never converted)'),
  defaultBidCents: z.coerce.number().int().min(2).max(BID_MAX_CENTS)
    .describe('each campaign\'s default bid, in minor units of the market\'s currency: its ad group\'s, its keywords\' and its product targets\' bid; the Auto groups take it times the wizard\'s multipliers (close 1.0, loose 0.65, substitutes 1.1, complements 0.6)'),
  overrides: z.array(z.object({
    name: z.string().trim().min(1).max(128).describe('a campaign of the set, by the name the preview shows'),
    dailyBudgetCents: z.coerce.number().int().positive().optional().describe('its own daily budget, minor units'),
    defaultBidCents: z.coerce.number().int().min(2).max(BID_MAX_CENTS).optional().describe('its own default bid, minor units'),
  })).max(MAX_CAMPAIGNS).optional().describe('campaigns of the set with their own daily budget or default bid'),
  negativeKeywords: z.array(z.object({
    text: z.string().trim().min(1).max(80).describe('the negative keyword'),
    matchType: z.enum(['EXACT', 'PHRASE']).describe('how it blocks a search'),
  })).max(LIST_MAX).optional().describe('searches no campaign of the set shows on (added to each campaign of the set), at most 100'),
  funnelNegatives: z.boolean().default(true)
    .describe('the wizard\'s negative funnel inside this set (on by default, as on the screen): a broad campaign negates its keyword type\'s keywords as exact and phrase, a phrase one as exact, and Auto every keyword of the set as exact. It never adds a negative to any other campaign'),
  placements: z.object({
    topOfSearchPct: pctArg('top-of-search'),
    productPagesPct: pctArg('product-pages'),
    restOfSearchPct: pctArg('rest-of-search'),
  }).optional().describe('placement adjustments for every campaign: NOT written at birth (a campaign off the live-write allowlist is refused them); the answer gives each campaign\'s set-placement-multipliers request, to ask once it is on the allowlist'),
  biddingStrategy: z.enum(['down', 'fixed']).default('down')
    .describe('Amazon bidding for every campaign: down = dynamic bids, down only (the wizard\'s own); fixed = the bid as set'),
  portfolioId: z.string().trim().min(1).max(64).optional()
    .describe('the Amazon portfolio every campaign joins: its Amazon portfolio id, a portfolio Amazon holds in this market\'s ads profile'),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})
type Args = z.infer<typeof input>

/** What `execute` launches, as the preview planned it. */
interface WizardPlan {
  body: SpwLaunchBody
  market: string
  currency: string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)
const STRUCTURE_WORDS: Record<WizardStructure, string> = { standard: 'Standard', advanced: 'Advanced', custom: 'Custom' }
const UNDO_WORDS = 'Undo archives every campaign it made (archive-ads): permanent at Amazon, an archived campaign never comes back.'
const RULES_WORDS = 'none: it creates no harvest, negative-targeting or bid-strategy rule and no AI Control plan (the screen\'s step 3); ask for a rule with save-ad-rule'

/** The match types a keyword campaign buys its keywords at (the launch's own reading of the wizard's label). */
function matchTypesOf(label: string): WizardMatch[] {
  const u = label.toLowerCase()
  if (u.includes('&')) return ['BROAD', 'PHRASE', 'EXACT']
  if (u.includes('phrase')) return ['PHRASE']
  if (u.includes('exact')) return ['EXACT']
  return ['BROAD']
}

/** Each keyword of the set, with the existing campaigns that buy the same words: this product's, and other products'. */
async function keywordClashes(market: string, keywords: readonly string[], ownAsins: readonly string[]) {
  const { loadExistingTargets } = await import('../../advertising/ads-blueprint-apply.service.js')
  const existing = await loadExistingTargets(market)
  const own = new Set(ownAsins.map((a) => a.toUpperCase()))
  const wanted = new Map(keywords.map((k) => [normaliseNegTerm(k), k]))
  type Ref = { campaignName: string; campaignId: string }
  const sameProduct = new Map<string, Ref[]>()
  const otherProducts = new Map<string, Ref[]>()
  for (const e of existing) {
    const key = normaliseNegTerm(e.expression)
    if (!wanted.has(key)) continue
    const into = (e.asins ?? []).some((a) => own.has(a.toUpperCase())) ? sameProduct : otherProducts
    const list = into.get(key) ?? []
    if (!list.some((r) => r.campaignId === e.campaignId)) list.push({ campaignName: e.campaignName, campaignId: e.campaignId })
    into.set(key, list)
  }
  const named = (m: Map<string, Ref[]>) => [...m.entries()].map(([key, refs]) => ({ term: wanted.get(key)!, existing: refs.slice(0, 5) })).sort((a, b) => a.term.localeCompare(b.term))
  return { sameProduct: named(sameProduct), sharedWithOtherProducts: named(otherProducts) }
}

/** The set, planned and judged: its preview, and the plan `execute` launches. */
async function wizardPreview(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId' | 'userId'>): Promise<{ result: ToolResult; plan?: WizardPlan }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult })
  const parsed = input.safeParse(raw)
  if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '))
  const a: Args = parsed.data

  // The products first: a SKU of another business reads as not found, before anything about the market is said.
  const skus = [...new Set(a.skus)]
  const rows = await prisma.product.findMany({ where: { sku: { in: skus }, deletedAt: null }, select: { id: true, sku: true, amazonAsin: true } })
  const bySku = new Map(rows.map((p) => [p.sku, p]))
  const missing = skus.filter((sku) => !bySku.has(sku))
  if (missing.length) return refuse(`SKU not found: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''}.`)
  const products = skus.map((sku) => ({ sku, productId: bySku.get(sku)!.id, asin: bySku.get(sku)!.amazonAsin ?? null }))

  // The structure's own arguments: each structure takes its own.
  if (a.structure === 'custom' && a.keywords) return refuse('keywords is for standard and advanced; a custom set names its keywords in customKeywordTypes.')
  if (a.structure !== 'custom' && (a.customKeywordTypes || a.customTargeting)) return refuse(`customKeywordTypes and customTargeting are for a custom set, not ${a.structure}.`)
  const targeting = a.customTargeting ?? ['auto', 'keyword', 'product']
  if (a.structure === 'custom' && targeting.includes('keyword') && !a.customKeywordTypes?.length) return refuse('A custom set with keyword campaigns needs customKeywordTypes (or leave keyword out of customTargeting).')
  if (a.structure === 'custom' && a.productTargets?.length && !targeting.includes('product')) return refuse('productTargets need the product-targeting campaign: add product to customTargeting.')

  let currency: string
  try { currency = await marketCurrency('AMAZON', a.market) } catch (e) { return refuse((e as Error).message) }

  // A market spend ceiling must exist, as for create-ad-campaign, and no single campaign's budget may be above it.
  const ceilingRow = await prisma.adSpendCeiling.findFirst({
    where: { grain: 'MARKET', scopeId: a.market, enabled: true, dailyCapCents: { not: null } },
    select: { label: true, dailyCapCents: true },
  })
  if (!ceilingRow) {
    return refuse(`Set a spend ceiling for this market first: ${a.market} has no daily spend ceiling, and Claude builds campaigns only in a market that has one (Ads → spend ceilings).`)
  }
  const ceiling = { label: ceilingRow.label, dailyCapCents: ceilingRow.dailyCapCents as number }

  // The wizard's campaigns: generated as its screen generates them; one with nothing to target is left out (it would
  // serve nothing at Amazon), and said.
  const generated = generateWizardCampaigns({
    productGroupName: a.productGroupName,
    structure: a.structure,
    keywords: { Brand: a.keywords?.brand, Competitor: a.keywords?.competitor, Category: a.keywords?.category },
    customKeywordTypes: a.customKeywordTypes,
    customTargeting: targeting,
  })
  const productTargets = [...new Set(a.productTargets ?? [])]
  const leftOut = generated
    .filter((c) => (c.kind === 'keyword' && !c.keywords.length) || (c.kind === 'pat' && !productTargets.length))
    .map((c) => ({ name: c.name, why: c.kind === 'pat' ? 'no productTargets: a product-targeting campaign with none serves nothing' : `no ${c.keywordType} keywords: a keyword campaign with none serves nothing` }))
  const kept = generated.filter((c) => !leftOut.some((l) => l.name === c.name))
  if (!kept.length) return refuse(`Nothing to build: every campaign of this ${a.structure} set would have nothing to target (${leftOut.map((l) => l.name).join(', ')}). Give keywords or productTargets.`)

  // Each campaign's budget and default bid, an override naming one of the set by name.
  const byName = new Map(kept.map((c) => [c.name.toLowerCase(), c]))
  const unknown = (a.overrides ?? []).filter((o) => !byName.has(o.name.toLowerCase())).map((o) => o.name)
  if (unknown.length) return refuse(`No campaign of this set is named ${unknown.map((n) => `"${n}"`).join(', ')}. Its campaigns: ${kept.map((c) => `"${c.name}"`).join(', ')}.`)
  const override = new Map((a.overrides ?? []).map((o) => [o.name.toLowerCase(), o]))
  const budgetOf = (c: WizardCampaign) => override.get(c.name.toLowerCase())?.dailyBudgetCents ?? a.dailyBudgetCents
  const bidOf = (c: WizardCampaign) => override.get(c.name.toLowerCase())?.defaultBidCents ?? a.defaultBidCents
  const budgets = kept.map(budgetOf)
  const largest = Math.max(...budgets)
  if (largest > ceiling.dailyCapCents) {
    return refuse(`A daily budget of ${amountLabel(largest, currency)} is above ${ceiling.label}'s spend ceiling of ${amountLabel(ceiling.dailyCapCents, currency)} a day.`)
  }
  const dailyBudgetCents = budgets.reduce((n, b) => n + b, 0)

  // Your own negatives go into each campaign of the set — never one that would stop a keyword of the same campaign.
  const own = (a.negativeKeywords ?? []).map((n) => ({ text: n.text, matchType: n.matchType }))
  for (const c of kept) {
    const positives: Positive[] = c.keywords.flatMap((text) => matchTypesOf(c.matchType).map((match) => ({ adTargetId: '', adGroupId: c.id, text, match, live: true })))
    for (const n of own) {
      const hit = blockedPositive({ text: n.text, match: n.matchType }, positives)
      if (hit) return refuse(`The negative ${n.matchType.toLowerCase()} "${n.text}" would stop the set's own keyword "${hit.text}" (${hit.match.toLowerCase()}) in "${c.name}": leave it out.`)
    }
  }
  const campaigns = applyWizardFunnel(kept.map((c) => ({ ...c, negKeywords: [...own] })), a.funnelNegatives)

  // The wizard's launch body, as its screen sends it: plain keywords at the campaign's match label and bid, the four
  // Auto groups on at the smart multipliers, no rules, no bid configuration; the placements kept for later.
  const placementBids = Object.fromEntries(([['tos', a.placements?.topOfSearchPct], ['pdp', a.placements?.productPagesPct], ['ros', a.placements?.restOfSearchPct]] as const)
    .filter(([, v]) => v != null && v > 0).map(([k, v]) => [k, String(v)]))
  const body: SpwLaunchBody = {
    market: a.market,
    productGroupName: a.productGroupName,
    products: products.map((p) => ({ sku: p.sku, ...(p.asin ? { asin: p.asin } : {}), productId: p.productId })),
    campaigns: campaigns.map((c) => ({
      id: c.id, name: c.name, adGroupName: c.adGroupName, kind: c.kind, matchType: c.matchType,
      bidEur: bidOf(c) / 100, budgetEur: budgetOf(c) / 100,
      keywords: c.keywords,
      productTargets: c.kind === 'pat' ? productTargets.map((asin) => ({ asin })) : [],
      ...(c.kind === 'auto' ? { autoGroups: WIZARD_AUTO_GROUPS.map((g) => ({ key: g.key, enabled: true, bidEur: autoGroupBidCents(bidOf(c), g.multiplier) / 100 })) } : {}),
      negKeywords: c.negKeywords.map((n) => ({ text: n.text, matchType: n.matchType })),
      negProducts: [],
      ...(a.biddingStrategy === 'fixed' ? { biddingStrategy: 'MANUAL' as const } : {}),
    })),
    ...(Object.keys(placementBids).length ? { placementBids } : {}),
    ...(a.portfolioId ? { portfolioId: a.portfolioId } : {}),
  }

  // How big one build is: every write it sends Amazon.
  const writes = campaigns.reduce((n, c) => n + 2 + products.length + c.negKeywords.length
    + (c.kind === 'keyword' ? c.keywords.length * matchTypesOf(c.matchType).length : c.kind === 'pat' ? productTargets.length : WIZARD_AUTO_GROUPS.length), 0)
  if (writes > MAX_WRITES) return refuse(`This set sends ${writes} writes to Amazon; one build sends at most ${MAX_WRITES}. Build it as two sets (fewer keywords, products or campaigns in each).`)

  // The portfolio: one Amazon holds in this market's ads profile.
  if (a.portfolioId) {
    const { adsClientContextFor } = await import('../../advertising/ads-profile-resolver.js')
    const profile = await adsClientContextFor(a.market)
    const portfolio = profile
      ? await prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: a.portfolioId, profileId: profile.profileId }, select: { name: true, state: true } })
      : null
    if (!portfolio) return refuse(`Portfolio ${a.portfolioId} not found in ${a.market}'s Amazon ads profile: give the Amazon id of a portfolio of this market, or none.`)
    if (portfolio.state === 'ARCHIVED') return refuse(`Portfolio "${portfolio.name}" is archived: Amazon puts no campaign in it.`)
  }

  // The wizard's own checks, from its dry run: what Amazon would refuse stops it here; his settings only warn.
  const { spWizardLaunch } = await import('../../advertising/ads-sp-wizard-launch.service.js')
  const dry = await spWizardLaunch({ ...body, dryRun: true }, `user:${ctx.userId ?? 'preview'}` as AdsActor)
  if (dry.status !== 200) return refuse(`Not queued: the SP Super Wizard refuses it — ${String(dry.body.error ?? 'no reason given')}`)
  const checks = (dry.body.checks ?? { refusals: [], warnings: [] }) as { refusals: string[]; warnings: string[] }
  if (checks.refusals.length) return refuse(`Not queued: the SP Super Wizard refuses it — ${checks.refusals.join(' ')}`)

  // Where it lands: a creation names no campaign yet, so the gate is asked as the launch asks it (no allowlist). Each
  // campaign is its own write: the gate's value cap is held against the largest single budget.
  const reach = liveReachOf(await checkAdsWriteGate({ marketplace: a.market, payloadValueCents: largest }))
  if (reach.reach === 'refused') return refuse(reachRefusal(reach))
  const stored = storedReach(reach)

  // Rule 3 — the keywords this product already buys elsewhere (said), and those other products buy (listed, allowed).
  const setKeywords = dedupeKeywords(campaigns.flatMap((c) => c.keywords))
  const asins = products.map((p) => p.asin).filter((x): x is string => !!x)
  const clashes = setKeywords.length ? await keywordClashes(a.market, setKeywords, asins) : { sameProduct: [], sharedWithOtherProducts: [] }
  // A keyword under two keyword types: two campaigns of the set buy it (the funnel parts keyword types, not keywords).
  const typesOf = new Map<string, Set<string>>()
  for (const c of campaigns) for (const k of c.keywords) typesOf.set(k.toLowerCase(), (typesOf.get(k.toLowerCase()) ?? new Set()).add(c.keywordType))
  const twice = setKeywords.filter((k) => (typesOf.get(k.toLowerCase())?.size ?? 0) > 1)

  const facts = await buildLimitFacts({
    tool: TOOL,
    items: [{ entity: { kind: 'products', market: a.market, productIds: products.map((p) => p.productId) }, change: { field: 'dailyBudget', fromCents: null, toCents: dailyBudgetCents } }],
    approvalId: ctx.approvalId ?? null,
  })
  const newMarket = !(await prisma.campaign.findFirst({ where: { marketplace: a.market }, select: { id: true } }))
  const plannedBids = campaigns.flatMap((c) => [bidOf(c), ...(c.kind === 'auto' ? WIZARD_AUTO_GROUPS.map((g) => autoGroupBidCents(bidOf(c), g.multiplier)) : [])])
  const highestPlannedBidCents = Math.max(...plannedBids)

  const floor = SUPPRESSION_FLOOR_CENTS
  const lines = campaigns.map((c) => ({
    name: c.name, kind: c.kind, matchType: c.matchType, keywordType: c.keywordType,
    keywords: c.keywords.length, productTargets: c.kind === 'pat' ? productTargets.length : 0, autoGroups: c.kind === 'auto' ? WIZARD_AUTO_GROUPS.length : 0,
    negatives: { yours: c.negKeywords.filter((n) => !n.funnel).length, funnel: c.negKeywords.filter((n) => n.funnel).length },
    dailyBudgetCents: budgetOf(c), startBidCents: bidOf(c),
  }))
  const totals = {
    campaigns: campaigns.length, keywords: campaigns.reduce((n, c) => n + (c.kind === 'keyword' ? c.keywords.length * matchTypesOf(c.matchType).length : 0), 0),
    productTargets: campaigns.some((c) => c.kind === 'pat') ? productTargets.length : 0, autoGroups: campaigns.filter((c) => c.kind === 'auto').length * WIZARD_AUTO_GROUPS.length,
    negatives: campaigns.reduce((n, c) => n + c.negKeywords.length, 0), productAds: products.length * campaigns.length, writes,
  }
  const warnings = [
    ...checks.warnings,
    ...(dailyBudgetCents > ceiling.dailyCapCents ? [`Together these daily budgets (${amountLabel(dailyBudgetCents, currency)}) are above ${ceiling.label}'s spend ceiling of ${amountLabel(ceiling.dailyCapCents, currency)} a day: once they spend, the ceiling holds the market.`] : []),
    ...(clashes.sameProduct.length ? [`${plural(clashes.sameProduct.length, 'keyword')} of this set ${clashes.sameProduct.length === 1 ? 'is' : 'are'} already bought for this product in other campaigns (${clashes.sameProduct.slice(0, 3).map((c) => `"${c.term}" in "${c.existing[0].campaignName}"`).join(', ')}${clashes.sameProduct.length > 3 ? ', …' : ''}): both would bid for it. Nothing outside this set is changed: the funnel keeps only this set's own campaigns apart.`] : []),
    ...(clashes.sharedWithOtherProducts.length ? [`${plural(clashes.sharedWithOtherProducts.length, 'keyword')} ${clashes.sharedWithOtherProducts.length === 1 ? 'is' : 'are'} also bought by your other products' campaigns: allowed — different products may share a keyword, and Nexus never negates one product's terms in another's campaigns.`] : []),
    ...(twice.length ? [`Listed under more than one keyword type, so more than one campaign of the set buys ${twice.length === 1 ? 'it' : 'them'}: ${twice.slice(0, 5).map((k) => `"${k}"`).join(', ')}.`] : []),
    ...(products.some((p) => !p.asin) ? [`${plural(products.filter((p) => !p.asin).length, 'SKU')} ${products.filter((p) => !p.asin).length === 1 ? 'has' : 'have'} no ASIN in Nexus: ${products.filter((p) => !p.asin).map((p) => p.sku).slice(0, 5).join(', ')}; Amazon advertises a seller SKU only once it is listed in ${a.market}.`] : []),
  ]
  const kinds = [
    campaigns.some((c) => c.kind === 'auto') ? 'Auto' : '',
    campaigns.some((c) => c.kind === 'keyword') ? plural(campaigns.filter((c) => c.kind === 'keyword').length, 'keyword campaign') : '',
    campaigns.some((c) => c.kind === 'pat') ? 'product targeting' : '',
  ].filter(Boolean).join(', ')
  const effect = `Builds the SP Super Wizard's ${STRUCTURE_WORDS[a.structure]} set "${a.productGroupName}" in ${a.market} through its own launch: `
    + `${plural(campaigns.length, 'Sponsored Products campaign')} (${kinds}), ${amountLabel(dailyBudgetCents, currency)} of daily budget in all, advertising ${plural(products.length, 'product')}. `
    + `Each is born ENABLED with every bid at the ${floor}-cent floor (the planned bids remembered; suppressed, never paused), off the live-write allowlist and without placements, `
    + 'so it serves next to nothing until set-campaign-live-writes and restore-campaign are approved for it. It creates no rule.'
  const plan: WizardPlan = { body, market: a.market, currency }
  return {
    plan,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        structure: a.structure,
        market: a.market,
        productGroupName: a.productGroupName,
        currency,
        products,
        campaigns: lines,
        ...(leftOut.length ? { leftOut } : {}),
        totals,
        dailyBudgetCents,
        highestPlannedBidCents,
        funnel: a.funnelNegatives
          ? `on: ${plural(totals.negatives - lines.reduce((n, l) => n + l.negatives.yours, 0), 'negative')} inside this set only (no other campaign gets one)`
          : 'off: only your own negatives',
        sameProductClashes: clashes.sameProduct,
        sharedWithOtherProducts: clashes.sharedWithOtherProducts,
        startsSuppressed: { floorCents: floor, by: 'the person who asked', note: `Every bid above ${floor} cents starts at the ${floor}-cent floor and the bid planned is remembered: restore-campaign puts them back.` },
        liveWrites: false,
        placements: Object.keys(placementBids).length ? 'asked, not written at birth: ask set-placement-multipliers for each campaign once it is on the allowlist (the answer names each request)' : 'none',
        rules: RULES_WORDS,
        ...(a.portfolioId ? { portfolioId: a.portfolioId } : {}),
        ceiling,
        ...(newMarket ? { newMarket: true, newMarketNote: `NEW MARKET: the first campaigns in ${a.market}.` } : {}),
        warnings,
        basis: hash({ body, products }),
        reach: stored,
        reachNote: reachNote(stored),
        effect,
        nextSteps: [
          'set-campaign-live-writes (enabled: true), for each campaign: only an allowlisted campaign takes an approved change live',
          'restore-campaign, for each campaign: puts the planned bids back — it starts spending',
          ...(Object.keys(placementBids).length ? ['set-placement-multipliers, for each campaign once it is on the allowlist: the placements asked for here'] : []),
        ],
        undoNote: UNDO_WORDS,
        limitFacts: facts,
        limitsNote: limitsNote(facts),
      },
    },
  }
}

/**
 * Claude's limits for a build run by rule: the kit's (one product set per request), the most campaigns, daily budget and
 * highest planned bid one build may make without a person, and the markets where it may — every default refuses: each
 * build waits for a person until he sets a number and a market.
 */
const WIZARD_LIMITS = adKitLimits({ maxItems: 1 }, {
  maxCampaigns: z.number().int().min(0).max(MAX_CAMPAIGNS).default(0).describe('the most campaigns one build may create by rule; 0 = every build waits for a person'),
  maxDailyBudgetCents: z.number().int().min(0).default(0).describe("the most daily budget (all its campaigns, minor units of the market's currency) one build may create by rule; 0 = every build waits for a person"),
  maxBidCents: z.number().int().min(0).default(0).describe("the highest planned bid (put back by restore-campaign) a build made by rule may hold, in minor units of the market's currency; 0 = every build waits for a person"),
  markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([]).describe('the markets where a build may run by rule; empty = none: every build waits for a person'),
})

/** build-sp-wizard-campaigns' own checks around the kit's (C1–C7, the month). Pure. */
function wizardRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { action?: string; market?: string; newMarket?: boolean; campaigns?: unknown[]; dailyBudgetCents?: number; highestPlannedBidCents?: number; currency?: string }
  if (p.action !== TOOL) return 'there is no preview of this SP Super Wizard build to check; a person decides'
  const markets = (limits.markets as string[] | undefined) ?? []
  if (!p.market || !markets.includes(p.market)) {
    return markets.length
      ? `this business lets an SP Super Wizard build run by rule only in ${markets.join(', ')}; a person decides`
      : 'this business names no market where an SP Super Wizard build may run by rule (markets is empty); a person decides'
  }
  const common = commonRefusal(preview, limits)
  if (common) return common
  if (p.newMarket) return `it builds the first campaigns in ${p.market}: a person decides a new market`
  const currency = p.currency ?? 'EUR'
  const n = p.campaigns?.length ?? 0
  const maxCampaigns = typeof limits.maxCampaigns === 'number' ? limits.maxCampaigns : 0
  if (n > maxCampaigns) return `it creates ${plural(n, 'campaign')}, more than the ${maxCampaigns} this tool's limits let a build create by rule${maxCampaigns === 0 ? ' (0: every build waits for a person)' : ''}; a person decides`
  const budget = typeof limits.maxDailyBudgetCents === 'number' ? limits.maxDailyBudgetCents : 0
  if ((p.dailyBudgetCents ?? 0) > budget) return `its daily budgets add up to ${amountLabel(p.dailyBudgetCents ?? 0, currency)}, more than the ${amountLabel(budget, currency)} this tool's limits let a build create by rule; a person decides`
  const highest = p.highestPlannedBidCents ?? 0
  const bid = typeof limits.maxBidCents === 'number' ? limits.maxBidCents : 0
  if (highest > bid) return `its highest planned bid ${amountLabel(highest, currency)} is above the ${amountLabel(bid, currency)} this tool's limits allow by rule; a person decides`
  for (const scope of Object.values(limitFactsOf(preview)?.scopes ?? {})) {
    const max = scope.limits.maxBidCents
    if (max == null || !scope.sources.maxBid || highest <= max) continue
    return `its highest planned bid ${amountLabel(highest, currency)} is above the highest bid ${amountLabel(max, currency)} (${strategyWords(scope.sources.maxBid)}); a person decides`
  }
  return null
}

/** What a build recorded: the campaigns it made at Amazon (a record Amazon never took is archived in Nexus at once). */
type WizardAfter = { campaignIds?: string[]; market?: string; productGroupName?: string; structure?: string }

/** Undo of a build: archive every campaign it made (archive-ads), a new request a person approves. Permanent at Amazon. */
export const WIZARD_BUILD_UNDO: ToolUndo = {
  async current(change) {
    // A build stands while a campaign it made is not archived.
    const after = (change.after ?? {}) as WizardAfter
    const ids = after.campaignIds ?? []
    const standing = ids.length ? await prisma.campaign.count({ where: { id: { in: ids }, status: { not: 'ARCHIVED' } } }) : 0
    return standing ? change.after : { ...after, archived: true }
  },
  request(change) {
    const ids = (change.after as WizardAfter | null)?.campaignIds
    return Array.isArray(ids) && ids.length
      ? { tool: 'archive-ads', args: { campaignIds: ids, why: 'undo of an SP Super Wizard set Claude asked for: archived for good' } }
      : { refusal: 'This change does not name the campaigns it made.' }
  },
}

type LaunchAnswer = {
  ok?: boolean
  error?: string
  created?: Array<{ name: string; campaignId: string; externalCampaignId: string | null }>
  launch?: { campaigns?: Array<{ name: string; status: string; reason: string | null; failed?: Array<{ step: string; item: string; reason: string }> }> }
  verification?: { ok?: boolean; problems?: string[] } | null
  portfolioCheck?: { repairFailed?: number } | null
  deferredPlacements?: Array<{ campaignId: string; adjustments: Array<{ placement: string; percentage: number }> }>
}

const PLACEMENT_ARG: Record<string, string> = { PLACEMENT_TOP: 'topOfSearchPct', PLACEMENT_PRODUCT_PAGE: 'productPagesPct', PLACEMENT_REST_OF_SEARCH: 'restOfSearchPct' }

const buildSpWizardCampaigns: AgentTool = {
  name: TOOL,
  title: 'Build with the SP Super Wizard',
  input,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  restrictedFields: {
    ...strategyFactsMoney(),
    ...Object.fromEntries(['dailyBudgetCents', 'startBidCents', 'highestPlannedBidCents', 'dailyCapCents'].map((key) => [key, FIELDS.financialsAdspendView])),
  } as Readonly<Record<string, FieldPermission>>,
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  // Undo archives what it made: the campaigns stop for good, what they spent stays spent.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: WIZARD_LIMITS,
  withinLimits: wizardRefusal,
  undo: WIZARD_BUILD_UNDO,
  description:
    'Build a one-off set of Amazon Sponsored Products campaigns with the SP Super Wizard (outside any playbook) in ONE '
    + 'market, for ONE product (by SKU, its variations too): structure standard (5 campaigns: Auto; Brand, Competitor and '
    + 'Category keywords at broad, phrase and exact; product targeting), advanced (11: each keyword type at broad, at phrase '
    + 'and at exact in a campaign of its own) or custom (the campaign and keyword types you name — the Quick and Guided '
    + 'shapes too). The campaigns, their names and the negative funnel inside the set are the wizard\'s own, and so is the '
    + 'launch. A person approves it in Nexus, unless the business lets it run by its rule inside its limits and the ads '
    + 'strategy (by default it does not: maxCampaigns 0 and no market). It is born safe: every bid starts at the 2-cent '
    + 'floor (suppressed, never paused, the planned bids remembered), off the live-write allowlist and without placements, '
    + 'and it creates no rule, so it spends next to nothing until set-campaign-live-writes and restore-campaign are '
    + 'approved for each campaign, each a kind of its own. The funnel negates only inside this set; a keyword your other '
    + 'products buy is listed, never blocked. Refused, and not queued, when a SKU is not found, the market has no spend '
    + 'ceiling or a budget is above it, a name is taken, a bid or budget is outside Amazon\'s range, or Amazon\'s write '
    + 'gate would refuse it. The preview shows every campaign, where it lands (live at Amazon or sandbox) and each limit '
    + 'with where it comes from. Undo archives every campaign it made (archive-ads): permanent at Amazon.',
  async handler(args, ctx) {
    return (await wizardPreview(args, ctx)).result
  },
  async execute(args, ctx) {
    const fresh = await wizardPreview(args, ctx)
    const refusal = recheck(ctx, fresh.result, ['basis', 'ceiling', 'reach'])
    if (refusal) return notRun(refusal)
    const preview = fresh.result.preview as { reach: StoredReach; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || preview.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const plan = fresh.plan!
    const requester = await requesterOf(ctx, run.actor)

    // The wizard's own launch, with the ads playbook build's options (PB-5a): born at the floor for the person who
    // asked, off the allowlist, the approval's change set on every audit row, the placements kept back.
    const { spWizardLaunch } = await import('../../advertising/ads-sp-wizard-launch.service.js')
    let answer: LaunchAnswer
    const problems: string[] = []
    try {
      const out = await spWizardLaunch(plan.body, run.actor, {
        allowlistAtBirth: false,
        bornSuppressed: { floorCents: SUPPRESSION_FLOOR_CENTS, by: requester },
        changeSetId: run.changeSetId,
        deferPlacements: true,
      })
      answer = out.body as LaunchAnswer
      if (out.status !== 200) return notRun(`Not run: the SP Super Wizard refused it (${String(answer.error ?? 'no reason given')}). Nothing was created.`)
    } catch (e) {
      // A launch that stopped part-way still made what its audit rows name (its change set): those are recorded, so
      // the change can be followed and undone like a whole one.
      const logged = await prisma.advertisingActionLog.findMany({ where: { executionId: run.changeSetId, actionType: 'create_campaign', entityType: 'CAMPAIGN' }, select: { entityId: true } })
      const rows = logged.length
        ? await prisma.campaign.findMany({ where: { id: { in: logged.map((l) => l.entityId) } }, select: { id: true, name: true, externalCampaignId: true } })
        : []
      if (!rows.length) return notRun(`Not run: the SP Super Wizard's launch stopped before it made anything (${(e as Error).message.slice(0, 200)}).`)
      answer = { created: rows.map((c) => ({ name: c.name, campaignId: c.id, externalCampaignId: c.externalCampaignId })) }
      problems.push(`the launch stopped part-way (${(e as Error).message.slice(0, 200)}): only the campaigns listed were made`)
    }

    const created = answer.created ?? []
    const onAmazon = created.filter((c) => c.externalCampaignId)
    // A campaign Amazon never took is a FAILED record holding its name: archived in Nexus (nothing is sent), so the set
    // can be asked for again — as the playbook's build does.
    const { archiveLocalOnly } = await import('../../advertising/ads-playbook/build.js')
    const freed = await archiveLocalOnly(created.filter((c) => !c.externalCampaignId).map((c) => c.campaignId))
    for (const c of answer.launch?.campaigns ?? []) {
      if (c.status === 'live') continue
      problems.push(`"${c.name}": ${c.reason ?? c.status}${c.failed?.length ? ` (${c.failed.slice(0, 3).map((f) => `${f.step} ${f.item}: ${f.reason}`).join('; ')}${c.failed.length > 3 ? '; …' : ''})` : ''}`)
    }
    if (freed) problems.push(`${plural(freed, 'campaign record')} Amazon never took ${freed === 1 ? 'was' : 'were'} archived in Nexus, so ${freed === 1 ? 'its name is' : 'their names are'} free again`)
    if (answer.portfolioCheck?.repairFailed) problems.push(`portfolio membership could not be confirmed for ${plural(answer.portfolioCheck.repairFailed, 'campaign')}`)
    if (answer.verification && answer.verification.ok === false) problems.push(...(answer.verification.problems ?? []).slice(0, 20))
    if (!onAmazon.length) {
      return notRun(`Not run: no campaign of the set reached Amazon — ${problems.slice(0, 5).join('; ') || String(answer.error ?? 'no reason given')}.`)
    }

    const ids = onAmazon.map((c) => c.campaignId)
    const made = await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, status: true, externalCampaignId: true, liveBidWritesEnabled: true, bidsSuppressedAt: true } })
    const byId = new Map(made.map((c) => [c.id, c]))
    let total = 0
    for (const id of ids) total += (await campaignStructureCounts(id)).total
    const placements = (answer.deferredPlacements ?? []).filter((d) => ids.includes(d.campaignId) && d.adjustments.length)
      .map((d) => ({ campaignId: d.campaignId, ...Object.fromEntries(d.adjustments.map((x) => [PLACEMENT_ARG[x.placement] ?? x.placement, x.percentage])) }))
    return {
      ok: true,
      data: {
        status: problems.length ? 'PARTIAL' : 'APPLIED',
        campaigns: ids.map((id) => {
          const c = byId.get(id)
          return { campaignId: id, name: c?.name ?? null, status: c ? String(c.status) : null, externalCampaignId: c?.externalCampaignId ?? null, liveWrites: c?.liveBidWritesEnabled ?? false, atFloor: !!c?.bidsSuppressedAt }
        }),
        created: { campaigns: ids.length, total },
        ...(problems.length ? { problems } : {}),
        suppressed: { by: requester, floorCents: SUPPRESSION_FLOOR_CENTS },
        currency: plan.currency,
        reach: preview.reach,
        changeSetId: run.changeSetId,
        ...(placements.length ? { placementsToAsk: placements } : {}),
        nextSteps: [
          ...ids.map((id) => `set-campaign-live-writes {"campaignId":"${id}","enabled":true}`),
          ...ids.map((id) => `restore-campaign {"campaignId":"${id}"}`),
          ...(placements.length ? ['set-placement-multipliers with each of placementsToAsk, once its campaign is on the allowlist'] : []),
        ],
      },
      change: {
        before: { campaignIds: [], market: plan.market, productGroupName: plan.body.productGroupName ?? null },
        after: { campaignIds: ids, market: plan.market, productGroupName: plan.body.productGroupName ?? null, structure: String(args.structure ?? '') },
      },
    }
  },
}

export const ADS_SP_WIZARD_TOOLS: AgentTool[] = [buildSpWizardCampaigns]

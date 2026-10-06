/**
 * ADS AUTONOMY B-1 (Owner 10-07: Claude builds with every one of Nexus's own builders) — replicate-ad-structure: Claude
 * asks to copy the structure of campaigns that run onto another product, with the Replicate Structure builder's own run
 * (ads-blueprint-apply.service.ts: `planFromSource` plans it, `startBlueprintRun` runs it, detached). No create path of
 * its own: the plan, the self-competition gate and every create are the screen's.
 *
 * Born safe whatever the screen chooses (the run's `bornSafe`):
 *   floor      every bid above the 2-cent floor is created AT it, the planned bid remembered; each campaign is flagged
 *              suppressed by the person who asked (`bidsSuppressedBy`) the moment it exists. ENABLED, never paused.
 *   allowlist  born OFF the live-write allowlist: no engine, rule or approved change writes it live until a person
 *              approves set-campaign-live-writes; restore-campaign then gives the planned bids back (each its own kind).
 *   placements not written (a campaign off the allowlist is refused them): kept on the run and listed per campaign, for
 *              set-placement-multipliers once it is live. Replicate creates no rules or hourly plans.
 *   undo       every create carries the approval's change set: archive-ads buildRunId archives what the run made
 *              (permanent at Amazon; a run a deploy killed is found by its change set and marked FAILED first).
 *
 * The Owner's rule 3: the gate keeps only the product's OWN campaigns apart (`evaluatePlan`, PB-5.0) — a keyword the
 * product already buys is skipped or accepted by name (skipTerms / acceptTerms); one another product buys is listed
 * (sharedWithOtherProducts), never blocked, never negated. Rule 2: it creates only; it never moves, lowers or negates a
 * term anywhere else.
 *
 * Like every ad change tool (ads-change-kit.ts): the preview says where it lands and a refusal is not queued; it runs only
 * as an approved request, as the approver, and refuses when the plan, the market's spend ceiling or where it lands moved.
 * Strategy-bound (create kind): it may run by the business's rule only inside the ads strategy where its products are and
 * this tool's limits — by default it does not (maxCampaigns 0: every copy waits for a person).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { checkAdsWriteGate } from '../../advertising/ads-write-gate.js'
import { SUPPRESSION_FLOOR_CENTS } from '../../advertising/ads-bid-suppression.service.js'
import { adGroupsOutside, planFromSource, replicateInFlight, replicateRunCampaigns, startBlueprintRun, type ApplyRequest } from '../../advertising/ads-blueprint-apply.service.js'
import type { ApplyPlan, CopyScope, PlannedCampaign, PlannedTarget, ValuePolicy } from '../../ads-core/ads-blueprint-apply.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import { marketCurrency } from '../../pim/market-currency.js'
import { amountLabel, liveReachOf } from './ads-tool-guards.js'
import { approvedRun, canonical, notRun, reachNote, reachRefusal, recheck, requesterOf, storedReach, strategyFactsMoney, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, buildLimitFacts, commonRefusal, limitFactsOf, limitsNote } from './ads-autonomy-kit.js'
import type { AgentTool, FieldPermission, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = 'replicate-ad-structure'
const MAX_SOURCE = 30
const MAX_AD_GROUPS = 100
const MAX_PRODUCTS = 50
const MAX_TERMS = 250
const BID_MAX_CENTS = 10_000
const ID = z.string().trim().min(1).max(64)
const MARKET = z.string().trim().toUpperCase().min(2).max(20)
const TOKEN = z.string().trim().min(1).max(60)
const TERM = z.string().trim().min(1).max(80)

const policyArg = (fixed: string) => z.object({
  mode: z.enum(['copy', 'scale', 'fixed']).describe(`copy: as the source; scale: value is a percent of the source (100 = unchanged); fixed: value is ${fixed}`),
  value: z.number().int().min(1).max(1_000_000).optional().describe('scale: the percent (1–1000); fixed: the amount in minor units'),
})

const input = z.object({
  sourceMarket: MARKET.describe('the Amazon market the source campaigns run in (IT, DE, FR, ES, UK; business-overview lists them)'),
  campaignIds: z.array(ID).min(1).max(MAX_SOURCE).describe('the source: the campaigns whose structure is copied, by Nexus id (campaignId in ad-campaigns), at most 30, all of sourceMarket'),
  adGroupIds: z.array(ID).max(MAX_AD_GROUPS).optional().describe('only these ad groups of the source campaigns (adGroupId in ad-targets); default: every ad group'),
  sourceProductToken: TOKEN.describe("the source product's name as it is written in the source campaigns' names and brand keywords; in the copy it becomes productToken"),
  competitorTokens: z.array(TOKEN).max(20).optional().describe("competitors' brand names in the source keywords: their keywords are gated like category terms"),
  market: MARKET.describe('the Amazon market the copy is created in: the same as sourceMarket, or another'),
  productToken: TOKEN.describe('what sourceProductToken becomes in the copy: the new product\'s name in names and brand keywords'),
  skus: z.array(z.string().trim().min(1).max(100)).min(1).max(MAX_PRODUCTS).describe('the products the copy advertises, by Nexus SKU (one product ad each per ad group), each listed on Amazon in market with an ASIN; a parent is named by its variations'),
  naming: z.object({
    prefix: z.string().max(40).optional().describe('put before every campaign and ad group name'),
    suffix: z.string().max(40).optional().describe('put after every campaign and ad group name'),
    replacements: z.array(z.object({
      from: z.string().min(1).max(60).describe('text in the names (case-insensitive)'),
      to: z.string().max(60).describe('what it becomes'),
    })).max(20).optional().describe('find-and-replace in the names, in order'),
  }).optional().describe('the names of the copy, after productToken is put in: a name already used in market is refused'),
  copy: z.object({
    keywords: z.boolean().optional().describe('copy the keywords (default yes)'),
    negatives: z.boolean().optional().describe('copy the negative keywords and products (default yes)'),
    productTargets: z.boolean().optional().describe('copy the product and category targets (default yes)'),
    autoClauses: z.boolean().optional().describe('copy the auto groups of an Auto campaign (default yes)'),
    bids: z.boolean().optional().describe("copy each keyword's own bid (default yes; no: each keyword takes its ad group's default bid as the source has it, and no bidPolicy applies)"),
    budgets: z.boolean().optional().describe('copy the daily budgets (default yes; no: budgetPolicy fixed gives them)'),
    placements: z.boolean().optional().describe('copy the placement adjustments (default yes): never set at birth, listed for once the copy is live'),
  }).optional().describe('what comes across; default everything'),
  bidPolicy: policyArg("the bid of every keyword, target and ad group, in minor units of market's currency (2–10000)").optional()
    .describe("the copied bids: copy (default), scale or fixed; bids are never converted between currencies: a copy into a market of another currency needs fixed"),
  budgetPolicy: policyArg("each campaign's daily budget, in minor units of market's currency").optional()
    .describe('the copied daily budgets: copy (default), scale or fixed; never converted between currencies: a copy into a market of another currency needs fixed'),
  skipTerms: z.array(TERM).max(MAX_TERMS).optional().describe("keywords the product's own campaigns already buy (the conflicts a refusal names) to leave out of the copy"),
  acceptTerms: z.array(TERM).max(MAX_TERMS).optional().describe('such keywords to create anyway, on the record: the product then bids against itself on them'),
  portfolioId: z.string().trim().min(1).max(64).optional().describe("the Amazon portfolio the copies join (its Amazon portfolio id, of market's Amazon Ads profile); default: none"),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})
type Args = z.infer<typeof input>

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const unique = (values: readonly string[] | undefined) => [...new Set(values ?? [])]
const quoted = (names: readonly string[], max = 5) => `${names.slice(0, max).map((n) => `"${n}"`).join(', ')}${names.length > max ? ` and ${names.length - max} more` : ''}`
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)
const cents = (major: number | null | undefined) => Math.round(Number(major ?? 0) * 100)

const UNDO_WORDS = 'Undo archives every campaign the copy made (archive-ads buildRunId): permanent at Amazon, an archived campaign never comes back.'

/** Every bid a campaign of the plan is created to restore: each ad group's default and each positive's own (the run's fallbacks). */
function plannedBids(c: PlannedCampaign): number[] {
  return c.adGroups.flatMap((g) => [g.defaultBidCents ?? 50, ...g.targets.filter((t) => !t.isNegative).map((t) => t.bidCents ?? g.defaultBidCents ?? 50)])
}

/** What the preview says of each campaign the copy makes (counts; the bids and budget are money). */
function campaignLines(plan: ApplyPlan, renames: Array<{ from: string }>) {
  return plan.campaigns.map((c) => {
    const targets = c.adGroups.flatMap((g) => g.targets)
    const positive = targets.filter((t) => !t.isNegative)
    const kind = (t: { kind: string }) => (t.kind ?? '').toUpperCase()
    return {
      name: c.name,
      from: renames[Number(c.id.slice(1))]?.from ?? null,
      targeting: c.targetingType,
      adGroups: c.adGroups.length,
      dailyBudgetCents: cents(c.dailyBudget),
      startBidCents: Math.max(0, ...plannedBids(c)),
      keywords: positive.filter((t) => kind(t) === 'KEYWORD').length,
      productTargets: positive.filter((t) => kind(t) === 'PRODUCT' || kind(t) === 'CATEGORY').length,
      autoGroups: positive.filter((t) => kind(t) === 'AUTO').length,
      negatives: targets.length - positive.length,
      placementsOnceLive: c.placementBidding.map((p) => ({ placement: p.placement, percentage: p.percentage })),
    }
  })
}

/**
 * The basis a person approves: the source, the products and every campaign the copy makes, in an order the rows' order
 * cannot move. The plan's ids are positions in the source as it was read (its ad groups and targets come back in no fixed
 * order), so they are left out and every list is sorted: a sync that reorders rows changes nothing here; a bid, a budget,
 * a name, a keyword or a clash that changes does. Exported for the tests.
 */
export function planBasis(input: {
  campaignIds: readonly string[]; adGroupIds: readonly string[]; plan: Pick<ApplyPlan, 'campaigns' | 'conflicts'>
  asins: readonly string[]; portfolioId: string | null; currency: string
}): string {
  const sorted = (items: readonly unknown[]) => items.map((x) => canonical(x)).sort()
  const target = (t: PlannedTarget) => ({
    expression: t.expression.toLowerCase(), expressionType: (t.expressionType ?? '').toUpperCase(), kind: (t.kind ?? '').toUpperCase(),
    bidCents: t.bidCents ?? null, isNegative: t.isNegative, negativeLevel: t.negativeLevel ?? null, autoClause: t.autoClause ?? null,
  })
  const campaigns = input.plan.campaigns.map((c) => ({
    name: c.name, role: c.role, targetingType: c.targetingType, dailyBudget: c.dailyBudget, biddingStrategy: c.biddingStrategy,
    placementBidding: sorted(c.placementBidding.map((p) => ({ placement: p.placement, percentage: p.percentage }))),
    adGroups: sorted(c.adGroups.map((g) => ({ name: g.name, defaultBidCents: g.defaultBidCents, asins: [...g.asins].sort(), targets: sorted(g.targets.map(target)) }))),
  }))
  const conflicts = input.plan.conflicts.map((c) => ({ expression: c.expression.toLowerCase(), resolution: c.resolution, existing: c.existing.map((e) => e.campaignId).sort() }))
  return hash({
    source: [[...input.campaignIds].sort(), [...input.adGroupIds].sort()], campaigns: sorted(campaigns), conflicts: sorted(conflicts),
    asins: [...input.asins].sort(), portfolio: input.portfolioId, currency: input.currency,
  })
}

/** A value policy as the run takes it: a scaled one in percent, a fixed bid in cents, a fixed budget in major units; or why not. */
function policyOf(p: Args['bidPolicy'], kind: 'bid' | 'budget'): ValuePolicy | { refusal: string } | undefined {
  if (!p || p.mode === 'copy') return p ? { mode: 'copy' } : undefined
  if (p.value == null) return { refusal: `${kind}Policy ${p.mode} needs a value.` }
  if (p.mode === 'scale') return p.value <= 1000 ? { mode: 'scale', value: p.value } : { refusal: `${kind}Policy scale is a percent from 1 to 1000.` }
  if (kind === 'bid') return p.value >= SUPPRESSION_FLOOR_CENTS && p.value <= BID_MAX_CENTS ? { mode: 'fixed', value: p.value } : { refusal: `bidPolicy fixed is a bid from ${SUPPRESSION_FLOOR_CENTS} to ${BID_MAX_CENTS} minor units.` }
  return { mode: 'fixed', value: p.value / 100 }
}

/** The copy scope as the run takes it: only what was said (an unsaid part is copied, as on the screen). */
function scopeOf(copy: NonNullable<Args['copy']>): Partial<CopyScope> {
  const said: Partial<CopyScope> = {
    keywords: copy.keywords, negatives: copy.negatives, productTargets: copy.productTargets, autoClauses: copy.autoClauses,
    bids: copy.bids, budgets: copy.budgets, placementBidding: copy.placements,
  }
  return Object.fromEntries(Object.entries(said).filter(([, v]) => typeof v === 'boolean')) as Partial<CopyScope>
}

/** The copy, planned and judged: its preview, and the request `execute` hands to the run. */
async function replicatePreview(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'> = {}): Promise<{ result: ToolResult; request?: ApplyRequest }> {
  const refuse = (error: string) => ({ result: { ok: false, error } as ToolResult })
  const parsed = input.safeParse(raw)
  if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '))
  const a: Args = parsed.data

  // The source first: a campaign of another business reads as not found, before anything else is said.
  const named = await prisma.campaign.findMany({
    where: { id: { in: unique(a.campaignIds) } },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, marketplace: true, adProduct: true, status: true, bidsSuppressedAt: true },
  })
  const missing = unique(a.campaignIds).filter((id) => !named.some((s) => s.id === id))
  if (missing.length) return refuse(`Source campaign${missing.length === 1 ? '' : 's'} not found in this business: ${missing.slice(0, 10).join(', ')}.`)
  // An archived campaign serves nothing: it is left out of the copy (said), as its archived keywords and targets are.
  const archived = named.filter((s) => String(s.status) === 'ARCHIVED').map((s) => s.name)
  const sources = named.filter((s) => String(s.status) !== 'ARCHIVED')
  if (!sources.length) return refuse(`Not queued: ${quoted(archived)} ${archived.length === 1 ? 'is' : 'are'} archived: name campaigns that run (an archived campaign's structure is not copied).`)
  const ids = sources.map((s) => s.id)
  const names = sources.map((s) => s.name)
  const elsewhere = sources.filter((s) => s.marketplace !== a.sourceMarket)
  if (elsewhere.length) return refuse(`Not queued: ${quoted(elsewhere.map((s) => `${s.name} (${s.marketplace ?? 'no market'})`))} ${elsewhere.length === 1 ? 'does' : 'do'} not run in ${a.sourceMarket} (sourceMarket): name campaigns of one market.`)
  const notSp = sources.filter((s) => (s.adProduct ?? 'SPONSORED_PRODUCTS') !== 'SPONSORED_PRODUCTS')
  if (notSp.length) return refuse(`Not queued: Replicate copies Sponsored Products campaigns only; ${quoted(notSp.map((s) => s.name))} ${notSp.length === 1 ? 'is' : 'are'} not.`)
  const adGroupIds = unique(a.adGroupIds)
  const lost = await adGroupsOutside(ids, adGroupIds)
  if (lost.length) return refuse(`Ad group${lost.length === 1 ? '' : 's'} not found in the source campaigns: ${lost.slice(0, 10).join(', ')}.`)

  // The products: each by SKU, listed on Amazon in the market with an ASIN (a product ad advertises an ASIN).
  const skus = unique(a.skus)
  const products = await prisma.product.findMany({ where: { sku: { in: skus }, deletedAt: null }, select: { id: true, sku: true, amazonAsin: true, isParent: true } })
  const unknown = skus.filter((sku) => !products.some((p) => p.sku === sku))
  if (unknown.length) return refuse(`SKU not found: ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? ` and ${unknown.length - 10} more` : ''}.`)
  const listed = new Set((await prisma.channelListing.findMany({
    where: { productId: { in: products.map((p) => p.id) }, channel: 'AMAZON', marketplace: a.market, listingStatus: { not: 'ENDED' } },
    select: { productId: true },
  })).map((l) => l.productId))
  const problems = products.flatMap((p) => (p.isParent
    ? [`${p.sku} is a parent: name its variations (a parent ASIN is not advertised)`]
    : !p.amazonAsin ? [`${p.sku} has no ASIN`] : !listed.has(p.id) ? [`${p.sku} is not listed on Amazon in ${a.market}`] : []))
  if (problems.length) return refuse(`Not queued: the copy of ${quoted(names)} would have nothing to advertise for ${problems.length === 1 ? 'one product' : plural(problems.length, 'product')} — ${problems.join('; ')}.`)
  const asins = unique(products.map((p) => p.amazonAsin!))

  // Money: in the destination market's own currency, never converted; inside the market's spend ceiling.
  let currency: string, sourceCurrency: string
  try {
    currency = await marketCurrency('AMAZON', a.market)
    sourceCurrency = await marketCurrency('AMAZON', a.sourceMarket)
  } catch (e) { return refuse((e as Error).message) }
  const bidPolicy = policyOf(a.bidPolicy, 'bid')
  const budgetPolicy = policyOf(a.budgetPolicy, 'budget')
  for (const p of [bidPolicy, budgetPolicy]) if (p && 'refusal' in p) return refuse(p.refusal)
  // Replicate's own rule: with copy.bids off every keyword takes its ad group's default AS THE SOURCE HAS IT — a bid
  // policy is not applied — so the two are never asked together (one of them would be silently ignored).
  if (a.copy?.bids === false && a.bidPolicy && a.bidPolicy.mode !== 'copy') {
    return refuse('Not queued: copy.bids false keeps each ad group\'s default bid as the source has it and applies no bidPolicy: give one or the other.')
  }
  if (a.copy?.budgets === false && a.budgetPolicy?.mode !== 'fixed') {
    return refuse('Not queued: copy.budgets false needs budgetPolicy fixed (each campaign\'s own daily budget); without it the source\'s budgets would be copied anyway.')
  }
  if (currency !== sourceCurrency && (a.bidPolicy?.mode !== 'fixed' || a.budgetPolicy?.mode !== 'fixed' || a.copy?.bids === false)) {
    return refuse(`Not queued: the source campaigns are in ${sourceCurrency} (${a.sourceMarket}) and the copy would be in ${currency} (${a.market}): bids and budgets are never converted. Give the copy its own in ${currency} (bidPolicy and budgetPolicy fixed, copy.bids not off).`)
  }
  const ceiling = await prisma.adSpendCeiling.findFirst({
    where: { grain: 'MARKET', scopeId: a.market, enabled: true, dailyCapCents: { not: null } },
    select: { label: true, dailyCapCents: true },
  })
  if (!ceiling) return refuse(`Set a spend ceiling for this market first: ${a.market} has no daily spend ceiling, and Claude copies campaigns only into a market that has one (Ads → spend ceilings).`)

  // The portfolio the copies join: one of the market's own Amazon Ads profile (a Nexus-only portfolio Amazon never holds is refused).
  let portfolio: { portfolioId: string; name: string } | null = null
  if (a.portfolioId) {
    const profiles = (await prisma.amazonAdsConnection.findMany({ where: { marketplace: a.market, isActive: true }, select: { profileId: true } })).map((c) => c.profileId)
    const row = a.portfolioId.startsWith('local-pf-') ? null
      : await prisma.amazonAdsPortfolio.findFirst({ where: { externalPortfolioId: a.portfolioId, profileId: { in: profiles } }, select: { externalPortfolioId: true, name: true } })
    if (!row) return refuse(`Portfolio ${a.portfolioId} not found in ${a.market}'s Amazon Ads profile: name one Amazon holds there, or none.`)
    portfolio = { portfolioId: row.externalPortfolioId, name: row.name }
  }

  // The plan: Replicate's own, from the source as it is now, judged by its gate (rule 3: only the product's own campaigns block).
  const request: ApplyRequest = {
    // Archived keywords and targets of the source serve nothing: they are not copied.
    source: { campaignIds: ids, ...(adGroupIds.length ? { adGroupIds } : {}), marketplace: a.sourceMarket, excludeArchivedTargets: true },
    sourceProductToken: a.sourceProductToken,
    ...(a.competitorTokens?.length ? { competitorTokens: a.competitorTokens } : {}),
    target: { productToken: a.productToken, asins },
    marketplace: a.market,
    ...(portfolio ? { portfolioId: portfolio.portfolioId } : {}),
    options: {
      skipSharedTargets: unique(a.skipTerms), acceptSharedTargets: unique(a.acceptTerms),
      ...(a.naming ? { naming: a.naming } : {}),
      ...(a.copy ? { include: scopeOf(a.copy) } : {}),
      ...(bidPolicy ? { bidPolicy: bidPolicy as ValuePolicy } : {}),
      ...(budgetPolicy ? { budgetPolicy: budgetPolicy as ValuePolicy } : {}),
    },
    launchMode: 'floor',
  }
  let planned: Awaited<ReturnType<typeof planFromSource>>
  try {
    planned = await planFromSource({ source: request.source!, sourceProductToken: a.sourceProductToken, competitorTokens: request.competitorTokens, target: request.target, marketplace: a.market, options: request.options })
  } catch (e) { return refuse(`Not queued: ${(e as Error).message}.`) }
  const plan = planned.plan
  if (!plan.allowed) {
    const own = plan.conflicts.filter((c) => c.resolution === 'UNRESOLVED')
    const hint = own.length
      ? ` The product's own campaigns already buy ${own.slice(0, 10).map((c) => `"${c.expression}" (${c.existing.map((e) => `"${e.campaignName}"`).join(', ')})`).join('; ')}`
        + `${own.length > 10 ? ` and ${own.length - 10} more` : ''}: name each in skipTerms (left out of the copy) or acceptTerms (created anyway, on the record).`
      : ''
    return refuse(`Not queued: Replicate's gate refuses this copy — ${plan.blockers.join(' ')}${hint}`)
  }
  if (!plan.campaigns.length) return refuse(`Nothing to copy: with what you left out, no campaign of ${quoted(names)} keeps an ad group with targeting.`)

  const dailyBudgetCents = cents(plan.totals.dailyBudgetTotal)
  const cap = ceiling.dailyCapCents as number
  if (dailyBudgetCents > cap) return refuse(`Its daily budgets add up to ${amountLabel(dailyBudgetCents, currency)}, above ${ceiling.label}'s spend ceiling of ${amountLabel(cap, currency)} a day.`)
  const highestPlannedBidCents = Math.max(0, ...plan.campaigns.flatMap(plannedBids))

  // Amazon's own range in the market, names and bids above a budget: the checks every builder's launch runs (CC-13/14).
  const { launchChecks } = await import('../../advertising/ads-launch-checks.service.js')
  const checks = await launchChecks({
    market: a.market, portfolioId: portfolio?.portfolioId ?? null, productCount: asins.length,
    campaigns: plan.campaigns.map((c) => ({ name: c.name, budgetCents: cents(c.dailyBudget), bidsCents: plannedBids(c) })),
  })
  if (checks.refusals.length) return refuse(`Not queued: ${checks.refusals.join(' ')}`)

  // One run per product per market: one still running answers for it (a run of Claude's that stopped is settled at execute).
  const flying = await replicateInFlight(a.market, a.productToken)
  if (flying && !flying.stopped) return refuse(`A copy for ${a.productToken} in ${a.market} is running (run ${flying.applicationId}): follow it with approval-status, then ask again.`)

  // Where it lands: a creation names no campaign yet, so the gate is asked as the launch asks it, against the largest budget.
  const largestBudgetCents = Math.max(0, ...plan.campaigns.map((c) => cents(c.dailyBudget)))
  const reach = liveReachOf(await checkAdsWriteGate({ marketplace: a.market, payloadValueCents: largestBudgetCents }))
  if (reach.reach === 'refused') return refuse(reachRefusal(reach))
  const stored = storedReach(reach)
  // The facts the business's rule is judged on: the new daily budgets, where its products are in the strategy (create kind).
  const facts = await buildLimitFacts({
    tool: TOOL,
    items: [{ entity: { kind: 'products', market: a.market, productIds: products.map((p) => p.id) }, change: { field: 'dailyBudget', fromCents: null, toCents: dailyBudgetCents } }],
    approvalId: ctx.approvalId ?? null,
  })
  const newMarket = !(await prisma.campaign.findFirst({ where: { marketplace: a.market }, select: { id: true } }))
  const floored = sources.filter((s) => s.bidsSuppressedAt).map((s) => s.name)
  const accepted = plan.conflicts.filter((c) => c.resolution === 'ACCEPTED').map((c) => c.expression)
  const campaigns = campaignLines(plan, planned.renames)
  const placements = campaigns.filter((c) => c.placementsOnceLive.length).length
  const floor = SUPPRESSION_FLOOR_CENTS
  const t = plan.totals
  const effect = `Copies the structure of ${quoted(names)} (${a.sourceMarket}) onto ${a.productToken} in ${a.market} with Replicate Structure's own run: `
    + `${plural(t.campaigns, 'Sponsored Products campaign')}, ${plural(t.adGroups, 'ad group')}, ${plural(t.positives, 'keyword or target')} and ${plural(t.negatives, 'negative')}, `
    + `advertising ${plural(asins.length, 'ASIN')}, ${amountLabel(dailyBudgetCents, currency)} of daily budget in all. `
    + `Each is born ENABLED with every bid at the ${floor}-cent floor (the planned bids remembered; suppressed by the person who asked, never paused), off the live-write allowlist`
    + `${placements ? `, without its placements (${plural(placements, 'campaign')} ${placements === 1 ? 'has' : 'have'} some: set once it is live)` : ''} and with no rules: `
    + 'it serves next to nothing (not nothing) until a person approves set-campaign-live-writes and restore-campaign for it, each a request of its own.'
  const warnings = [
    ...(archived.length ? [`${quoted(archived)} ${archived.length === 1 ? 'is' : 'are'} archived: left out of the copy.`] : []),
    ...plan.warnings,
    ...checks.warnings,
    ...(floored.length ? [`${quoted(floored)} ${floored.length === 1 ? 'is' : 'are'} at the floor now: the copy plans the bids ${floored.length === 1 ? 'it holds' : 'they hold'} (the floor), not the ones ${floored.length === 1 ? 'it' : 'they'} had before; bidPolicy fixed plans others.`] : []),
    ...(flying?.stopped ? [`An earlier copy for ${a.productToken} in ${a.market} (run ${flying.applicationId}) stopped without finishing: this one marks it FAILED. What it made can be archived (archive-ads buildRunId ${flying.applicationId}).`] : []),
  ]
  return {
    request,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        builder: 'Replicate Structure',
        source: { market: a.sourceMarket, campaigns: sources.map((s) => ({ campaignId: s.id, name: s.name })), adGroups: adGroupIds.length || null, productToken: a.sourceProductToken },
        market: a.market,
        currency,
        productToken: a.productToken,
        products: products.map((p) => ({ sku: p.sku, productId: p.id, asin: p.amazonAsin })),
        campaigns,
        totals: { campaigns: t.campaigns, adGroups: t.adGroups, positives: t.positives, negatives: t.negatives, productAds: t.productAds },
        dailyBudgetCents,
        highestPlannedBidCents,
        excluded: plan.excluded,
        ...(accepted.length ? { acceptedTerms: accepted, acceptedNote: `${plural(accepted.length, 'keyword')} the product's own campaigns already buy ${accepted.length === 1 ? 'is' : 'are'} created anyway: the product bids against itself on ${accepted.length === 1 ? 'it' : 'them'}.` } : {}),
        sharedWithOtherProducts: plan.sharedWithOtherProducts.slice(0, 25),
        ...(plan.sharedWithOtherProducts.length ? { sharedNote: `${plural(plan.sharedWithOtherProducts.length, 'keyword')} of the copy ${plan.sharedWithOtherProducts.length === 1 ? 'is' : 'are'} also bought by other products' campaigns: allowed, never negated across products.` } : {}),
        portfolio,
        startsSuppressed: { floorCents: floor, by: 'the person who asked', note: `Every bid above ${floor} cents starts at the ${floor}-cent floor and the bid planned is remembered: restore-campaign puts them back.` },
        liveWrites: false,
        placements: 'not set at birth (a campaign off the live-write allowlist is refused them): each campaign\'s are listed (placementsOnceLive) for set-placement-multipliers once it is live',
        rules: 'none: Replicate creates no rules or hourly plans',
        ceiling: { label: ceiling.label, dailyCapCents: cap },
        ...(newMarket ? { newMarket: true, newMarketNote: `NEW MARKET: the first campaign in ${a.market}.` } : {}),
        warnings,
        basis: planBasis({ campaignIds: ids, adGroupIds, plan, asins, portfolioId: portfolio?.portfolioId ?? null, currency }),
        reach: stored,
        reachNote: reachNote(stored),
        effect,
        nextSteps: [
          'approval-status (approvalId): follow the run; it answers its id at once and runs on its own',
          'set-campaign-live-writes (enabled: true), per campaign: only an allowlisted campaign takes an approved change live',
          'restore-campaign, per campaign: puts the planned bids back — the campaign starts spending',
          'set-placement-multipliers: the placements listed per campaign, once it is live',
        ],
        undoNote: UNDO_WORDS,
        limitFacts: facts,
        limitsNote: limitsNote(facts),
      },
    },
  }
}

/**
 * Claude's limits for a copy run by rule: the kit's (one request), and the most campaigns, daily budget and highest planned
 * bid one copy may create without a person — 0 by default: every copy waits for a person until he types a number — and
 * the markets.
 */
const REPLICATE_LIMITS = adKitLimits({ maxItems: 1 }, {
  maxCampaigns: z.number().int().min(0).max(MAX_SOURCE).default(0).describe('the most campaigns one copy may create by rule; 0 = every copy waits for a person'),
  maxDailyBudgetCents: z.number().int().min(0).default(0).describe("the most daily budget (all its campaigns, minor units of the market's currency) one copy may create by rule; 0 = every copy waits for a person"),
  maxBidCents: z.number().int().min(0).default(0).describe("the highest planned bid (given back by restore-campaign) a copy created by rule may hold, in minor units of the market's currency"),
  markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([]).describe('the markets a copy may be created in by rule (empty = every market)'),
})

/** replicate-ad-structure's own checks around the kit's (C1–C7, the month). Pure. */
function replicateRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as {
    action?: string; market?: string; currency?: string; newMarket?: boolean; campaigns?: unknown[]; dailyBudgetCents?: number; highestPlannedBidCents?: number; acceptedTerms?: string[]
  }
  if (p.action !== TOOL) return 'there is no preview of this copy to check; a person decides'
  const markets = (limits.markets as string[] | undefined) ?? []
  if (p.market && markets.length && !markets.includes(p.market)) return `this business lets a copy run by rule only in ${markets.join(', ')}`
  // Rule 3 — a clash with the product's own campaigns, accepted on the record, is a person's decision.
  if (p.acceptedTerms?.length) return `it creates ${plural(p.acceptedTerms.length, 'keyword')} the product's own campaigns already buy (accepted): the product would bid against itself; a person decides`
  const common = commonRefusal(preview, limits)
  if (common) return common
  if (p.newMarket) return `it creates the first campaigns in ${p.market}: a person decides a new market`
  const currency = p.currency ?? 'EUR'
  const n = p.campaigns?.length ?? 0
  const maxCampaigns = typeof limits.maxCampaigns === 'number' ? limits.maxCampaigns : 0
  if (n > maxCampaigns) return `it creates ${plural(n, 'campaign')}, more than the ${maxCampaigns} this tool's limits let a copy create by rule${maxCampaigns === 0 ? ' (0: every copy waits for a person)' : ''}; a person decides`
  const budget = typeof limits.maxDailyBudgetCents === 'number' ? limits.maxDailyBudgetCents : 0
  if ((p.dailyBudgetCents ?? 0) > budget) return `its daily budgets add up to ${amountLabel(p.dailyBudgetCents ?? 0, currency)}, more than the ${amountLabel(budget, currency)} this tool's limits let a copy create by rule; a person decides`
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

/** Undo: archive-ads of every campaign the run made (buildRunId), a new request a person approves; permanent at Amazon. */
export const REPLICATE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { applicationId?: string }
    if (!after.applicationId) return change.after
    // It stands while a campaign it made is not archived (one still running stands too: archive-ads waits for it).
    const run = await replicateRunCampaigns(after.applicationId)
    const standing = !!run && ('refusal' in run ? /still running/.test(run.refusal) : run.campaignIds.length > 0)
    return standing ? { applicationId: after.applicationId } : { applicationId: after.applicationId, archived: true }
  },
  request(change) {
    const applicationId = (change.after as { applicationId?: unknown } | null)?.applicationId
    return typeof applicationId === 'string' && applicationId
      ? { tool: 'archive-ads', args: { buildRunId: applicationId, why: 'undo of a Replicate copy Claude asked for: archived for good' } }
      : { refusal: 'This change does not name the run it started.' }
  },
}

const MONEY_KEYS = ['dailyBudgetCents', 'highestPlannedBidCents', 'startBidCents', 'dailyCapCents']

const replicateAdStructure: AgentTool = {
  name: TOOL,
  title: 'Replicate an ad structure',
  input,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  restrictedFields: {
    ...strategyFactsMoney(),
    ...Object.fromEntries(MONEY_KEYS.map((key) => [key, FIELDS.financialsAdspendView])),
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
  limits: REPLICATE_LIMITS,
  withinLimits: replicateRefusal,
  undo: REPLICATE_UNDO,
  description:
    'Copy the structure of Amazon Sponsored Products campaigns that run (campaignIds in sourceMarket) onto another product '
    + '(skus; productToken replaces sourceProductToken in names and brand keywords), in the same market or another, with '
    + "Nexus's Replicate Structure builder: its own plan and run, the same campaigns, ad groups, keywords, targets, auto "
    + 'groups and negatives (naming, copy, bidPolicy and budgetPolicy shape them). A person approves it in Nexus, unless the '
    + 'business lets it run by its rule inside its limits and the ads strategy (by default it does not: maxCampaigns 0). '
    + 'It is born safe: every campaign ENABLED with every bid at the 2-cent floor (the planned bids remembered; suppressed '
    + 'by the person who asked, never paused), off the live-write allowlist, without its placements and with no rules, so '
    + 'it spends next to nothing until set-campaign-live-writes and restore-campaign are approved for it, each a kind of '
    + 'its own; its placements are listed for set-placement-multipliers once it is live. Only the product\'s own '
    + 'campaigns are kept apart: a keyword it already buys is refused until it is named in skipTerms or acceptTerms; one '
    + 'another product buys is listed, never blocked. Refused, and not queued, when a source campaign or SKU is not found, '
    + 'a product is not listed on Amazon there with an ASIN, the market has no spend ceiling or the budgets are above it, a '
    + 'name is taken, the currencies differ without fixed bids and budgets, Amazon would refuse a bid or budget, a copy for '
    + 'the product is running, or Amazon\'s write gate would refuse it. It runs on its own once approved: approval-status '
    + 'follows it. Undo archives every campaign it made (archive-ads buildRunId): permanent at Amazon.',
  async handler(args, ctx) {
    return (await replicatePreview(args, ctx)).result
  },
  async execute(args, ctx) {
    const fresh = await replicatePreview(args, ctx)
    if (!fresh.result.ok || !fresh.request) return notRun(`Not run: ${fresh.result.error ?? 'it is no longer a valid copy'}`)
    const refusal = recheck(ctx, fresh.result, ['basis', 'ceiling', 'reach'])
    if (refusal) return notRun(refusal)
    const preview = fresh.result.preview as { reach: StoredReach; effect: string; market: string; productToken: string }
    const run = approvedRun(ctx, String(args.why ?? '') || preview.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const requester = await requesterOf(ctx, run.actor)
    let started: Awaited<ReturnType<typeof startBlueprintRun>>
    try {
      started = await startBlueprintRun({ ...fresh.request, launchMode: 'floor', actor: run.actor, bornSafe: { by: requester, changeSetId: run.changeSetId } })
    } catch (e) { return notRun(`Not run: ${(e as Error).message}`) }
    if (started.alreadyRunning) return notRun(`Not run: a copy for ${preview.productToken} in ${preview.market} is already running (run ${started.applicationId}): follow it, then ask again.`)
    return {
      ok: true,
      data: {
        applicationId: started.applicationId,
        status: 'RUNNING',
        reach: preview.reach,
        changeSetId: run.changeSetId,
        note: `Runs on its own; approval-status follows it (run ${started.applicationId}). Born at the ${SUPPRESSION_FLOOR_CENTS}-cent floor and off the live-write allowlist: it serves next to nothing (not nothing) until set-campaign-live-writes and restore-campaign are approved for it.`,
      },
      change: {
        before: { applicationId: null, market: preview.market, productToken: preview.productToken },
        after: { applicationId: started.applicationId },
      },
    }
  },
}

export const ADS_REPLICATE_TOOLS: AgentTool[] = [replicateAdStructure]

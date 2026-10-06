/**
 * ADS AUTONOMY B-2 (Owner 10-07, option A: Claude builds with each of Nexus's own builders) — create-ai-goal-campaigns:
 * Claude asks for an AI Advertising goal in ONE Amazon market and its campaigns, built by the AI Goal builder's own
 * launch (ai-goal-materialize.service.ts `materializeProductGoal`, the screen marketing/ads/ai-advertising/new-goal):
 * per product an Auto (discovery), a Research (broad seeds) and a Performance (exact seeds) campaign, plus a Products
 * campaign when product targets are given; a Harvest & Negate and a Negative Targeting rule per product; one
 * AutopilotPlan for the goal. No create path of its own: the goal is saved by `createProductGoal` and launched by
 * `materializeProductGoal`, as the screen does, with the launch's options for Claude.
 *
 * Born safe, whatever the screen does (the builders' rule 2):
 *   (a) floor        every bid above the 2-cent floor is created AT it, the planned bid remembered, each campaign flagged
 *                    suppressed by the person who asked: it serves (never paused) and spends next to nothing until a
 *                    person approves restore-campaign, which puts the planned bids back.
 *   (b) allowlist    each campaign is born OFF the live-write allowlist (the screen allowlists at birth): no rule, engine
 *                    or approved change writes it live until a person approves set-campaign-live-writes.
 *   (c) placements   the AI Goal launch sets none.
 *   (d) automation   the rules are created switched off (still dry run) and the AutopilotPlan disabled: nothing proposes
 *                    or acts until a person switches the plan on (turn-up-automation), which hands it its rules.
 *   (e) change set   every ad write carries the approval (changeSetId): approval-status counts it, undo finds it.
 *
 * The Owner's rule 3 (isolation is per product only): only Strict Control is offered — one campaign set per product, so
 * every negative it adds (its excluded keywords and ASINs) and every negative its rules may later add stays inside ONE
 * product's own campaigns. Shared Budget puts every product in one set: a negative there (the Negative Targeting rule
 * negates a wasting search term in the set's Auto and Research ad groups, judged on the whole ad group) stops every
 * product of the set, so it is not offered. Another product of the business already buying a seed keyword is listed,
 * never a refusal; the same product already buying one is a warning (its campaigns would bid against each other), and
 * then it never runs by rule.
 *
 * Like every ad change tool (ads-change-kit.ts): the preview says where it lands (live at Amazon on which profile, or
 * sandbox) and a refusal is not queued; it runs only as an approved request, as the approver, with the bids the preview
 * showed (frozen), and refuses when what was approved moved. Strategy-bound (ads-autonomy-kit.ts): creating is its own
 * kind (create, as create-ad-campaign); it may run by the business's rule only inside the ads strategy where its products
 * are and this tool's limits — by default it does not (maxCampaigns 0: every goal waits for a person).
 *
 * Undo archives every campaign it made at Amazon (archive-ads), permanent at Amazon; the goal is archived in Nexus with it.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { checkAdsWriteGate } from '../../advertising/ads-write-gate.js'
import { SUPPRESSION_FLOOR_CENTS } from '../../advertising/ads-bid-suppression.service.js'
import { campaignStructureCounts } from '../../advertising/ads-entity-lookup.service.js'
import { marketCurrency } from '../../pim/market-currency.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import type { ScaffoldBidOpts } from '../../advertising/ai-goal-materialize.service.js'
import { amountLabel, liveReachOf } from './ads-tool-guards.js'
import { approvedRun, canonical, notRun, reachNote, reachRefusal, recheck, requesterOf, storedReach, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, buildLimitFacts, commonRefusal, limitFactsOf, limitsNote } from './ads-autonomy-kit.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = 'create-ai-goal-campaigns'
/** One goal at most this many products: each makes up to 4 campaigns, and one archive (its undo) names at most 100. */
const MAX_PRODUCTS = 25
const LIST_MAX = 100
const BID_MAX_CENTS = 10_000
const AI_TARGETS = ['IMPRESSION', 'SALES', 'ROAS', 'LIQUIDATE', 'RANK'] as const
const ASIN = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'an ASIN is 10 letters and digits')
const TERM = z.string().trim().min(1).max(80)

const input = z.object({
  market: z.string().trim().toUpperCase().min(2).max(20).describe('the Amazon marketplace code: IT, DE, FR, ES, UK, … (business-overview lists them)'),
  name: z.string().trim().min(1).max(80).describe('the goal\'s name; its campaigns are named "[AI] <name> - <ASIN or SKU> - Auto | Research | Performance | Products", each new in its market'),
  aiTarget: z.enum(AI_TARGETS).default('SALES')
    .describe('what the goal aims at, as the builder says it: IMPRESSION (launch traffic), SALES (balanced), ROAS (profit), LIQUIDATE (clear stock) or RANK (defend rank); it sets the AutopilotPlan\'s goal and how keen its harvest is'),
  goalProducts: z.array(z.object({
    sku: z.string().trim().min(1).max(64).describe('the product\'s SKU in this business'),
    dailyBudgetCents: z.coerce.number().int().min(100).describe('this product\'s daily budget in minor units of the market\'s currency (never converted), split over its campaigns'),
  })).min(1).max(MAX_PRODUCTS).describe('each product the goal advertises, with its own daily budget: each gets its own campaign set (Strict Control), at most 25'),
  seedKeywords: z.array(TERM).max(LIST_MAX).optional().describe('keywords to start from: broad in the Research campaign and exact in the Performance campaign of every product, at most 100; none = no Research campaign'),
  excludeKeywords: z.array(TERM).max(LIST_MAX).optional().describe('searches never shown on: an exact and a phrase negative in every product\'s own Auto and Research campaigns, at most 100'),
  productTargets: z.array(ASIN).max(LIST_MAX).optional().describe('ASINs to show on (a Products campaign per product), at most 100'),
  excludeAsins: z.array(ASIN).max(LIST_MAX).optional().describe('ASINs never shown on: negative product targets in every product\'s own Auto campaign, at most 100'),
  targetAcosPct: z.coerce.number().int().min(5).max(300).optional().describe('the AutopilotPlan\'s target ACoS in percent (default: the plan\'s own, 30)'),
  bidMinCents: z.coerce.number().int().min(5).max(BID_MAX_CENTS).optional().describe('the lowest bid the AutopilotPlan may set, in minor units of the market\'s currency'),
  bidMaxCents: z.coerce.number().int().min(10).max(20_000).optional().describe('the highest bid the AutopilotPlan may set, in minor units of the market\'s currency; above bidMinCents'),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})
type Args = z.infer<typeof input>

type Role = 'AUTO' | 'RESEARCH' | 'PERF' | 'PAT'
/** The plan the person approves (material: it is checked again before anything is created). */
interface GoalPlan {
  market: string
  name: string
  aiTarget: (typeof AI_TARGETS)[number]
  mode: 'STRICT'
  currency: string
  products: Array<{ sku: string; productId: string; asin: string | null; dailyBudgetCents: number }>
  seedKeywords: string[]
  excludeKeywords: string[]
  productTargets: string[]
  excludeAsins: string[]
  /** The AutopilotPlan's dials as asked (null: the plan's own defaults). */
  dials: { targetAcosPct: number | null; bidMinCents: number | null; bidMaxCents: number | null }
  campaigns: Array<{
    product: string; role: Role; name: string; targeting: 'AUTO' | 'MANUAL'; dailyBudgetCents: number; defaultBidCents: number
    keywords: Array<{ text: string; matchType: 'BROAD' | 'EXACT'; bidCents: number }>
    autoGroups: Array<{ key: string; bidCents: number }>
    productTargets: Array<{ asin: string; bidCents: number }>
    negativeKeywords: Array<{ text: string; matchType: 'EXACT' | 'PHRASE' }>
    negativeAsins: string[]
  }>
  rules: Array<{ name: string; kind: 'harvest' | 'negative'; product: string }>
  autopilot: { goal: string; autonomy: string; guardrails: Record<string, unknown> }
  dailyBudgetCents: number
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 16)

/** Each listed twice (case-insensitive): a goal names a thing once. */
function twice(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const v of values) (seen.has(v.toLowerCase()) ? repeated : seen).add(v.toLowerCase())
  return [...repeated]
}

const UNDO_WORDS = 'Undo archives every campaign it made at Amazon (archive-ads), and that is permanent at Amazon: an archived campaign never comes back. The goal is archived in Nexus with it; its rules and plan stay switched off.'
const ISOLATION = 'Strict Control: one campaign set per product, each with its own budget. The negatives it adds (excluded keywords in Auto and Research, excluded ASINs in Auto) and the ones its rules may add later stay inside that product\'s own campaigns: another product of this business is never blocked on a keyword. Shared Budget is not offered: its one set holds every product, so a negative there would stop them all.'

/** The bid evidence an approved preview showed: the run builds those bids (frozen), not today's. */
function frozenBids(approvedPreview: unknown): ScaffoldBidOpts | null {
  const e = (approvedPreview as { bidEvidence?: { bidCentsByKeyword?: unknown; autoBaseCents?: unknown } } | null | undefined)?.bidEvidence
  if (!e || typeof e.autoBaseCents !== 'number' || !e.bidCentsByKeyword || typeof e.bidCentsByKeyword !== 'object') return null
  const byKeyword = Object.fromEntries(Object.entries(e.bidCentsByKeyword as Record<string, unknown>).filter(([, v]) => typeof v === 'number')) as Record<string, number>
  return { bidCentsByKeyword: byKeyword, autoBaseCents: e.autoBaseCents }
}

/** The goal, planned and judged: its preview, and the plan `execute` launches. */
async function goalPreview(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'> = {}, frozen: ScaffoldBidOpts | null = null): Promise<ToolResult> {
  const parsed = input.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') }
  const a: Args = parsed.data
  const seeds = a.seedKeywords ?? []
  const excludes = a.excludeKeywords ?? []
  const targets = a.productTargets ?? []
  const excludeAsins = a.excludeAsins ?? []

  // The products first: a SKU of another business (or a deleted product) reads as not found, before anything about the
  // market is said.
  const skus = a.goalProducts.map((p) => p.sku)
  const repeatedSkus = twice(skus)
  if (repeatedSkus.length) return { ok: false, error: `Listed twice: ${repeatedSkus.slice(0, 5).join(', ')}.` }
  const rows = await prisma.product.findMany({ where: { sku: { in: skus }, deletedAt: null }, select: { id: true, sku: true, amazonAsin: true } })
  const bySku = new Map(rows.map((p) => [p.sku, p]))
  const missing = skus.filter((sku) => !bySku.has(sku))
  if (missing.length) return { ok: false, error: `SKU not found: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''}.` }

  for (const [list, what] of [[seeds, 'seed keywords'], [excludes, 'excluded keywords'], [targets, 'product targets'], [excludeAsins, 'excluded ASINs']] as const) {
    const repeated = twice(list)
    if (repeated.length) return { ok: false, error: `Listed twice in ${what}: ${repeated.slice(0, 5).join(', ')}.` }
  }
  const excluded = new Set(excludes.map((t) => t.toLowerCase()))
  const both = seeds.filter((t) => excluded.has(t.toLowerCase()))
  if (both.length) return { ok: false, error: `Both a seed keyword and an excluded keyword: ${both.slice(0, 5).join(', ')}. A term is one or the other.` }
  if (a.bidMinCents != null && a.bidMaxCents != null && a.bidMaxCents <= a.bidMinCents) return { ok: false, error: 'bidMaxCents must be above bidMinCents.' }

  let currency: string
  try {
    currency = await marketCurrency('AMAZON', a.market)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  // The plan: the AI Goal builder's own planner (planGoalScaffold) with the builder's bid evidence — today's, or the
  // evidence the approved preview showed.
  const { planGoalScaffold, MaterializeError, GOAL_AD_GROUP_BID_CENTS } = await import('../../advertising/ai-goal-materialize.service.js')
  const { resolveGoalBids } = await import('../../advertising/ai-goal-suggest.service.js')
  const bidEvidence = frozen ?? await resolveGoalBids(seeds, a.market)
  const products = a.goalProducts.map((p) => {
    const row = bySku.get(p.sku)!
    return { sku: p.sku, productId: row.id, asin: row.amazonAsin ?? null, dailyBudgetCents: p.dailyBudgetCents }
  })
  let scaffold: ReturnType<typeof planGoalScaffold>
  try {
    scaffold = planGoalScaffold({
      name: a.name, aiTarget: a.aiTarget, budgetMode: 'STRICT',
      products: products.map((p) => ({ productId: p.productId, sku: p.sku, ...(p.asin ? { asin: p.asin } : {}), budgetCents: p.dailyBudgetCents })),
      seedKeywords: seeds, excludeKeywords: excludes, productTargets: targets, excludeAsins,
      marketplace: a.market, portfolioId: null,
      targetAcosPct: a.targetAcosPct ?? null, bidMinCents: a.bidMinCents ?? null, bidMaxCents: a.bidMaxCents ?? null,
    }, bidEvidence)
  } catch (e) {
    if (e instanceof MaterializeError) return { ok: false, error: e.message }
    throw e
  }
  const productOf = (label: string) => products.find((p) => (p.asin ?? p.sku) === label)?.sku ?? label
  const plan: GoalPlan = {
    market: a.market,
    name: a.name,
    aiTarget: a.aiTarget,
    mode: 'STRICT',
    currency,
    products,
    seedKeywords: seeds,
    excludeKeywords: excludes,
    productTargets: targets,
    excludeAsins,
    dials: { targetAcosPct: a.targetAcosPct ?? null, bidMinCents: a.bidMinCents ?? null, bidMaxCents: a.bidMaxCents ?? null },
    campaigns: scaffold.campaigns.map((c) => ({
      product: productOf(c.setLabel), role: c.role, name: c.name, targeting: c.targetingType, dailyBudgetCents: c.budgetCents,
      defaultBidCents: GOAL_AD_GROUP_BID_CENTS,
      keywords: c.seeds.map((k) => ({ text: k.text, matchType: k.matchType, bidCents: k.bidCents })),
      autoGroups: c.autoGroups.map((g) => ({ key: g.key, bidCents: Math.round(g.bidEur * 100) })),
      productTargets: c.productTargets.map((asin) => ({ asin, bidCents: GOAL_AD_GROUP_BID_CENTS })),
      negativeKeywords: c.negativeKeywords,
      negativeAsins: c.negativeAsins,
    })),
    rules: scaffold.rules.map((r) => ({ name: r.name, kind: r.kind, product: productOf(r.setLabel) })),
    autopilot: { goal: scaffold.planGoal, autonomy: scaffold.autonomy, guardrails: scaffold.guardrails },
    dailyBudgetCents: scaffold.totalDailyBudgetCents,
  }

  // A market spend ceiling must exist, and the goal's daily budgets together must fit under it (as create-ad-campaign).
  const ceiling = await prisma.adSpendCeiling.findFirst({
    where: { grain: 'MARKET', scopeId: a.market, enabled: true, dailyCapCents: { not: null } },
    select: { label: true, dailyCapCents: true },
  })
  if (!ceiling) {
    return { ok: false, error: `Set a spend ceiling for this market first: ${a.market} has no daily spend ceiling, and Claude creates campaigns only in a market that has one (Ads → spend ceilings).` }
  }
  const cap = ceiling.dailyCapCents as number
  if (plan.dailyBudgetCents > cap) {
    return { ok: false, error: `The goal's daily budgets add up to ${amountLabel(plan.dailyBudgetCents, currency)}, above ${ceiling.label}'s spend ceiling of ${amountLabel(cap, currency)} a day.` }
  }

  // The builder's own launch checks (a name the market already uses, a bid or budget outside Amazon's range): a refusal
  // is not queued; its warnings (bid policies, spend ceilings) are shown.
  const { goalLaunchPlan, launchChecks } = await import('../../advertising/ads-launch-checks.service.js')
  const checks = await launchChecks(goalLaunchPlan(scaffold, null, GOAL_AD_GROUP_BID_CENTS))
  if (checks.refusals.length) return { ok: false, error: `Not queued: ${checks.refusals.join(' ')}` }

  // Where it lands: a creation names no campaign yet, so the gate is asked as the launch asks it (no allowlist). Each
  // campaign is its own write: the gate's value cap is held against the largest single budget (the goal's whole daily
  // budget is held by the ceiling above, this tool's limits and the strategy's month).
  const largestBudgetCents = Math.max(0, ...plan.campaigns.map((c) => c.dailyBudgetCents))
  const reach = liveReachOf(await checkAdsWriteGate({ marketplace: a.market, payloadValueCents: largestBudgetCents }))
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)

  // The Owner's rule 3: another product buying a seed keyword is listed, never a refusal; the same product buying one
  // already is a warning (its own campaigns would bid against each other).
  const sameKeyword = await sameKeywordElsewhere(a.market, seeds, products)

  // The facts the business's rule is judged on: the new daily budgets, where its products are in the strategy.
  const facts = await buildLimitFacts({
    tool: TOOL,
    items: [{ entity: { kind: 'products', market: a.market, productIds: products.map((p) => p.productId) }, change: { field: 'dailyBudget', fromCents: null, toCents: plan.dailyBudgetCents } }],
    approvalId: ctx.approvalId ?? null,
  })
  // The first campaigns of a market are a person's (a new market needs its own strategy, ceiling and Amazon limits).
  const newMarket = !(await prisma.campaign.findFirst({ where: { marketplace: a.market }, select: { id: true } }))
  const floor = SUPPRESSION_FLOOR_CENTS
  const plannedBids = plan.campaigns.flatMap((c) => [c.defaultBidCents, ...c.keywords.map((k) => k.bidCents), ...c.autoGroups.map((g) => g.bidCents), ...c.productTargets.map((t) => t.bidCents)])
  const highest = Math.max(0, ...plannedBids)
  const count = (pick: (c: GoalPlan['campaigns'][number]) => number) => plan.campaigns.reduce((n, c) => n + pick(c), 0)
  const totals = {
    products: products.length, campaigns: plan.campaigns.length, keywords: count((c) => c.keywords.length), autoGroups: count((c) => c.autoGroups.length),
    productTargets: count((c) => c.productTargets.length), negatives: count((c) => c.negativeKeywords.length + c.negativeAsins.length), rules: plan.rules.length,
  }
  const roles = [...new Set(plan.campaigns.map((c) => c.role))].map((r) => ({ AUTO: 'Auto', RESEARCH: 'Research', PERF: 'Performance', PAT: 'Products' })[r])
  const effect = `Creates the AI goal "${plan.name}" in ${plan.market} with the AI Goal builder's own launch: ${plural(totals.campaigns, 'Sponsored Products campaign')} `
    + `(${roles.join(', ')} for each of ${plural(totals.products, 'product')}), ${amountLabel(plan.dailyBudgetCents, currency)} of daily budget in all, `
    + `${plural(totals.rules, 'rule')} and one AutopilotPlan. Each campaign is born with every bid at the ${floor}-cent floor (suppressed, not paused) and off the live-write allowlist, `
    + 'so it spends next to nothing until a person approves restore-campaign; the rules and the plan are created switched off.'
  return {
    ok: true,
    preview: {
      action: TOOL,
      market: plan.market,
      currency,
      plan,
      ceiling: { label: ceiling.label, dailyCapCents: cap },
      totals,
      dailyBudgetCents: plan.dailyBudgetCents,
      // The highest bid the plan puts back at restore-campaign (it starts at the floor).
      highestPlannedBidCents: highest,
      isolation: { mode: 'STRICT', note: ISOLATION },
      ...(sameKeyword ? { sameKeyword } : {}),
      startsSuppressed: {
        floorCents: floor,
        by: 'the person who asked',
        note: `Every bid above ${floor} cents starts at the ${floor}-cent floor and the bid planned is remembered: each campaign serves (it is never paused) but spends next to nothing until a person approves restore-campaign, which puts the planned bids back.`,
      },
      liveWrites: false,
      placements: 'none: the AI Goal launch sets no placement adjustments',
      automation: {
        rules: `${plural(totals.rules, 'rule')} (Harvest & Negate, Negative Targeting per product), created switched off, as dry runs`,
        plan: `one AutopilotPlan (goal ${plan.autopilot.goal}, ${plan.autopilot.autonomy}: it proposes, never writes), created disabled`,
        note: 'Nothing proposes or acts until a person switches the plan on (turn-up-automation, the goal\'s plan); it then switches its rules on with it, still proposing only.',
      },
      ...(newMarket ? { newMarket: true, newMarketNote: `NEW MARKET: the first campaigns in ${plan.market}.` } : {}),
      warnings: [...scaffold.warnings, ...checks.warnings, ...(sameKeyword?.ownProduct.length ? [sameKeyword.note] : [])],
      bidEvidence: { bidCentsByKeyword: bidEvidence.bidCentsByKeyword ?? {}, autoBaseCents: bidEvidence.autoBaseCents ?? GOAL_AD_GROUP_BID_CENTS },
      basis: hash(plan),
      reach: stored,
      reachNote: reachNote(stored),
      effect,
      nextSteps: [
        'set-campaign-live-writes (enabled: true), per campaign: only an allowlisted campaign takes an approved change live',
        'restore-campaign, per campaign: puts the planned bids back — the campaign starts spending',
        'turn-up-automation (automation ads-autopilot, the goal\'s plan, level PROPOSE): the plan and its rules start proposing',
      ],
      undoNote: UNDO_WORDS,
      limitFacts: facts,
      limitsNote: limitsNote(facts),
    },
  }
}

interface SameKeyword {
  /** Campaigns that already buy a seed keyword and advertise one of the goal's own products: they would compete. */
  ownProduct: Array<{ keyword: string; campaignId: string; campaign: string }>
  /** Seed keywords other products' campaigns already buy: allowed (rule 3), only said. */
  otherProducts: Array<{ keyword: string; campaigns: number }>
  note: string
}

/** Where the seed keywords already run in the market (live positive targets), split by whose product they advertise. */
async function sameKeywordElsewhere(market: string, seeds: readonly string[], products: ReadonlyArray<{ asin: string | null }>): Promise<SameKeyword | null> {
  if (!seeds.length) return null
  const { loadExistingTargets } = await import('../../advertising/ads-blueprint-apply.service.js')
  const wanted = new Map(seeds.map((s) => [s.toLowerCase(), s]))
  const own = new Set(products.map((p) => p.asin).filter((asin): asin is string => !!asin))
  const ownProduct = new Map<string, { keyword: string; campaignId: string; campaign: string }>()
  const others = new Map<string, Set<string>>()
  for (const t of await loadExistingTargets(market)) {
    const keyword = wanted.get(t.expression.toLowerCase())
    if (!keyword) continue
    if (t.asins.some((asin) => own.has(asin))) ownProduct.set(`${keyword}|${t.campaignId}`, { keyword, campaignId: t.campaignId, campaign: t.campaignName })
    else others.set(keyword, (others.get(keyword) ?? new Set()).add(t.campaignId))
  }
  if (!ownProduct.size && !others.size) return null
  const mine = [...ownProduct.values()]
  const otherProducts = [...others].map(([keyword, ids]) => ({ keyword, campaigns: ids.size }))
  return {
    ownProduct: mine.slice(0, 20),
    otherProducts: otherProducts.slice(0, 20),
    note: mine.length
      ? `${plural(new Set(mine.map((m) => m.keyword)).size, 'seed keyword')} already run${mine.length === 1 ? 's' : ''} in a campaign of the same product (${mine.slice(0, 3).map((m) => `"${m.keyword}" in "${m.campaign}"`).join(', ')}): the goal's campaigns would bid against it. A person decides (it never runs by rule).`
      : `${plural(otherProducts.length, 'seed keyword')} already run${otherProducts.length === 1 ? 's' : ''} for other products of this business: allowed (isolation is per product), never blocked.`,
  }
}

/**
 * Claude's limits for a goal run by rule: the kit's (one request = one goal), and the most campaigns, daily budget and
 * highest planned bid a goal may create without a person — 0 by default: every goal waits for a person until he types a
 * number — and the markets.
 */
const GOAL_LIMITS = adKitLimits({ maxItems: 1 }, {
  maxCampaigns: z.number().int().min(0).max(4 * MAX_PRODUCTS).default(0).describe('the most campaigns one goal may create by rule; 0 = every goal waits for a person'),
  maxDailyBudgetCents: z.number().int().min(0).default(0).describe("the most daily budget (all its campaigns, minor units of the market's currency) one goal may create by rule; 0 = every goal waits for a person"),
  maxBidCents: z.number().int().min(0).default(0).describe("the highest planned bid (put back at restore-campaign) a goal created by rule may hold, in minor units of the market's currency"),
  markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([]).describe('the markets where it may run by rule (empty = every market)'),
})

/** create-ai-goal-campaigns' own checks around the kit's (C1–C7, the month). Pure. */
function goalRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as {
    plan?: GoalPlan; newMarket?: boolean; highestPlannedBidCents?: number; sameKeyword?: SameKeyword
  }
  if (!p.plan) return 'there is no preview of this goal to check; a person decides'
  const markets = (limits.markets as string[] | undefined) ?? []
  if (markets.length && !markets.includes(p.plan.market)) return `this business lets an AI goal run by rule only in ${markets.join(', ')}`
  const common = commonRefusal(preview, limits)
  if (common) return common
  const currency = p.plan.currency
  if (p.newMarket) return `it builds the first campaigns in ${p.plan.market}: a person decides a new market`
  const n = p.plan.campaigns.length
  const maxCampaigns = typeof limits.maxCampaigns === 'number' ? limits.maxCampaigns : 0
  if (n > maxCampaigns) return `it creates ${plural(n, 'campaign')}, more than the ${maxCampaigns} this tool's limits let a goal create by rule${maxCampaigns === 0 ? ' (0: every goal waits for a person)' : ''}; a person decides`
  const budget = typeof limits.maxDailyBudgetCents === 'number' ? limits.maxDailyBudgetCents : 0
  if (p.plan.dailyBudgetCents > budget) return `its daily budgets add up to ${amountLabel(p.plan.dailyBudgetCents, currency)}, more than the ${amountLabel(budget, currency)} this tool's limits let a goal create by rule; a person decides`
  const highest = p.highestPlannedBidCents ?? 0
  const bid = typeof limits.maxBidCents === 'number' ? limits.maxBidCents : 0
  if (highest > bid) return `its highest planned bid ${amountLabel(highest, currency)} is above the ${amountLabel(bid, currency)} this tool's limits allow by rule; a person decides`
  for (const scope of Object.values(limitFactsOf(preview)?.scopes ?? {})) {
    const max = scope.limits.maxBidCents
    if (max == null || !scope.sources.maxBid || highest <= max) continue
    return `its highest planned bid ${amountLabel(highest, currency)} is above the highest bid ${amountLabel(max, currency)} (${strategyWords(scope.sources.maxBid)}); a person decides`
  }
  if (p.sameKeyword?.ownProduct.length) return 'a seed keyword already runs in a campaign of the same product (its campaigns would bid against each other); a person decides'
  return null
}

/** What a change of this tool records: the goal, and its campaigns at Amazon (archivable) and in Nexus only. */
interface GoalAfter { goalId: string; planId: string | null; market: string; name: string; campaignIds: string[]; notAtAmazon: string[]; archived?: true }

/** Undo: archive every campaign it made at Amazon (archive-ads), a new request a person approves; the goal is archived with it. */
export const AI_GOAL_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as GoalAfter
    const ids = after.campaignIds ?? []
    const standing = ids.length ? await prisma.campaign.count({ where: { id: { in: ids }, status: { not: 'ARCHIVED' } } }) : 0
    return standing ? change.after : { ...after, archived: true }
  },
  request(change) {
    const after = (change.after ?? {}) as Partial<GoalAfter>
    if (!after.goalId) return { refusal: 'This change does not name the AI goal it created.' }
    if (!after.campaignIds?.length) return { refusal: 'This AI goal made no campaign at Amazon, so there is nothing to archive (a campaign only in Nexus spends nothing).' }
    return { tool: 'archive-ads', args: { campaignIds: after.campaignIds, why: `undo of the AI goal "${after.name ?? '?'}" Claude created: its campaigns archived for good` } }
  },
  // The campaigns are archived: the goal is archived in Nexus too, so the dashboard no longer lists it as running.
  async undone(change) {
    const goalId = (change.after as Partial<GoalAfter> | null)?.goalId
    if (!goalId) return
    const { archiveProductGoal } = await import('../../advertising/ai-product-goal.service.js')
    await archiveProductGoal(goalId)
  },
}

/** The goal's campaigns as the goal row names them: at Amazon (archivable) and in Nexus only. */
async function goalCampaigns(goalId: string) {
  const { goalCampaignRefs } = await import('../../advertising/ai-product-goal.service.js')
  const goal = await goalCampaignRefs(goalId)
  const refs = goal?.refs ?? []
  const ids = refs.map((r) => r.id)
  const rows = ids.length
    ? await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, status: true, externalCampaignId: true, liveBidWritesEnabled: true, bidsSuppressedAt: true, bidsSuppressedBy: true } })
    : []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const campaigns = refs.flatMap((r) => {
    const c = byId.get(r.id)
    return c ? [{ ...c, role: r.role }] : []
  })
  return { planId: goal?.planId ?? null, campaigns, atAmazon: campaigns.filter((c) => c.externalCampaignId).map((c) => c.id), notAtAmazon: campaigns.filter((c) => !c.externalCampaignId).map((c) => c.id) }
}

const createAiGoalCampaigns: AgentTool = {
  name: TOOL,
  title: 'Create an Amazon AI goal',
  input,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, F.adsAutomationManage, FIELDS.financialsAdspendView],
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
  limits: GOAL_LIMITS,
  withinLimits: goalRefusal,
  undo: AI_GOAL_UNDO,
  description:
    'Create an AI Advertising goal in ONE Amazon market and its Sponsored Products campaigns with the AI Goal builder\'s '
    + 'own launch (the screen Ads › AI Advertising › New goal): per product (by SKU, each with its own daily budget) an '
    + 'Auto, a Research (broad seed keywords) and a Performance (exact seed keywords) campaign, and a Products campaign '
    + 'when product targets are given; a Harvest & Negate and a Negative Targeting rule per product; one AutopilotPlan '
    + 'for the goal. Strict Control only (one campaign set per product): the negatives it adds and the ones its rules may '
    + 'add stay inside one product\'s own campaigns, so another product is never blocked on a keyword; Shared Budget is '
    + 'not offered, as its negatives would stop every product of the set. A person approves it in Nexus, unless the '
    + 'business lets it run by its rule inside its limits and the ads strategy (by default it does not: maxCampaigns 0). '
    + 'It is born safe: every bid starts at the 2-cent floor (suppressed, never paused), each campaign is off the '
    + 'live-write allowlist and has no placements, and the rules and the plan are created switched off, so it spends next '
    + 'to nothing until set-campaign-live-writes and restore-campaign are approved for its campaigns, each a kind of its '
    + 'own; turn-up-automation switches the goal\'s plan on (it proposes only). The planned bids come from the builder\'s '
    + 'own bid evidence and are frozen in the approval. Refused, and not queued, when the market has no spend ceiling or '
    + 'the budgets are above it, a name is taken, a SKU is not found, a bid or budget is outside Amazon\'s range, or '
    + 'Amazon\'s write gate would refuse it. The preview lists seed keywords other products already buy (allowed) and '
    + 'warns when the same product already buys one. Undo archives its campaigns (archive-ads): permanent at Amazon, an '
    + 'archived campaign never comes back.',
  async handler(args, ctx) {
    return goalPreview(args, ctx)
  },
  async execute(args, ctx) {
    // The bids the person approved (the evidence has moved since): the launch builds those.
    const frozen = frozenBids(ctx.approvedPreview)
    const fresh = await goalPreview(args, ctx, frozen)
    const refusal = recheck(ctx, fresh, ['plan', 'ceiling', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { plan: GoalPlan; reach: StoredReach; effect: string; bidEvidence: ScaffoldBidOpts }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const plan = p.plan
    const by = await requesterOf(ctx, run.actor)

    // The screen's two steps: the goal saved (createProductGoal), then launched (materializeProductGoal).
    const { createProductGoal, archiveProductGoal, ValidationError } = await import('../../advertising/ai-product-goal.service.js')
    let goalId: string
    try {
      const goal = await createProductGoal({
        name: plan.name, aiTarget: plan.aiTarget, budgetMode: 'STRICT',
        products: plan.products.map((x) => ({ productId: x.productId, sku: x.sku, ...(x.asin ? { asin: x.asin } : {}), budgetCents: x.dailyBudgetCents })),
        seedKeywords: plan.seedKeywords, excludeKeywords: plan.excludeKeywords, productTargets: plan.productTargets, excludeAsins: plan.excludeAsins,
        marketplace: plan.market, portfolioId: null,
        ...plan.dials,
      })
      goalId = goal.id
    } catch (e) {
      if (e instanceof ValidationError) return notRun(`Not run: ${e.message}`)
      throw e
    }

    const { materializeProductGoal, MaterializeError } = await import('../../advertising/ai-goal-materialize.service.js')
    let launched: Awaited<ReturnType<typeof materializeProductGoal>> | null = null
    let failure: string | null = null
    try {
      launched = await materializeProductGoal(goalId, run.actor, {
        allowlistAtBirth: false,
        bornSuppressed: { floorCents: SUPPRESSION_FLOOR_CENTS, by },
        changeSetId: run.changeSetId,
        automationOff: true,
        bidOpts: frozen ?? p.bidEvidence,
      })
    } catch (e) {
      // A refusal of the launch's own (MaterializeError) is said as it is; anything else is logged too. Either way, what
      // it made is read back from the goal below (it names its campaigns whatever happened: CC-24).
      failure = (e as Error).message
      if (!(e instanceof MaterializeError)) logger.error('[B-2] AI goal launch failed', { goalId, error: failure })
    }

    const made = await goalCampaigns(goalId)
    const change = made.campaigns.length
      ? { before: { goalId: null, campaignIds: [] }, after: { goalId, planId: made.planId, market: plan.market, name: plan.name, campaignIds: made.atAmazon, notAtAmazon: made.notAtAmazon } satisfies GoalAfter }
      : undefined
    if (!made.campaigns.length) {
      // Nothing was created: the goal it saved is archived, so it is not left waiting to be launched.
      await archiveProductGoal(goalId).catch(() => {})
      return notRun(`Not run: the launch refused it (${failure ?? 'no campaign was created'}). Nothing was created.`)
    }
    const counts = { adGroups: 0, productAds: 0, targets: 0, negatives: 0 }
    for (const c of made.campaigns) {
      const n = await campaignStructureCounts(c.id)
      counts.adGroups += n.adGroups; counts.productAds += n.productAds; counts.targets += n.targets; counts.negatives += n.negatives
    }
    const campaigns = made.campaigns.map((c) => ({
      campaignId: c.id, name: c.name, role: c.role, status: c.status, externalCampaignId: c.externalCampaignId, liveWrites: c.liveBidWritesEnabled,
      suppressed: c.bidsSuppressedAt ? { by: c.bidsSuppressedBy, floorCents: SUPPRESSION_FLOOR_CENTS } : null,
    }))
    const data = {
      goalId,
      planId: made.planId,
      campaigns,
      created: { campaigns: campaigns.length, ...counts },
      rules: (launched?.rules ?? []).map((r) => ({ ruleId: r.ruleId, module: r.module, enabled: false })),
      plan: made.planId ? { planId: made.planId, enabled: false } : null,
      currency: plan.currency,
      reach: p.reach,
      changeSetId: run.changeSetId,
      ...(launched?.errors.length ? { notes: launched.errors.slice(0, 20) } : {}),
      nextSteps: [
        ...made.atAmazon.map((id) => `set-campaign-live-writes {"campaignId":"${id}","enabled":true}`),
        ...made.atAmazon.map((id) => `restore-campaign {"campaignId":"${id}"}`),
        ...(made.planId ? [`turn-up-automation {"automation":"ads-autopilot","rowId":"${made.planId}","level":"PROPOSE"}`] : []),
      ],
    }
    // W2-A (CC-2) — a launch that did not fully reach Amazon answers `ok: false` with what did and why.
    if (failure || !launched?.launch.ok) {
      const { describeLaunch } = await import('../../advertising/launch-outcome.js')
      const why = failure ?? (launched ? describeLaunch(launched.launch) : 'unknown')
      return {
        ok: false,
        error: `Created part-way, then stopped: ${why}. The goal "${plan.name}" (${goalId}) holds ${plural(campaigns.length, 'campaign')}, with their bids at the floor and off the allowlist; check them with ad-campaigns before asking for anything more.`,
        data,
        change,
      }
    }
    return { ok: true, data, change }
  },
}

export const ADS_AI_GOAL_TOOLS: AgentTool[] = [createAiGoalCampaigns]

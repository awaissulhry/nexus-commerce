/**
 * MCP full control A11 (docs/mcp-full-control/sections/01-ads.md §3, §6 step 11) — Claude asks for a new Amazon
 * Sponsored Products campaign: one manual campaign with one ad group, its products and either keywords or product
 * targets, through the Single Campaign builder's own launch (ads-single-launch.service.ts).
 *
 * Safe by construction, before and after a person approves it:
 *   (a) spend ceiling   refused when the market has no spend ceiling (`AdSpendCeiling`, grain MARKET, enabled, with a
 *                       daily cap) — "Set a spend ceiling for this market first" — or when the budget alone is above it.
 *   (b) allowlist       the campaign is born OFF the live-write allowlist (`liveBidWritesEnabled` = false): no rule,
 *                       schedule or approved change writes it live until a person approves set-campaign-live-writes.
 *   (c) born suppressed every bid above the 2-cent floor is created AT the floor, the bid asked for remembered, and
 *                       the campaign is flagged suppressed by the person who asked (`bidsSuppressedBy = user:<them>`):
 *                       it serves at the floor and spends next to nothing until a person approves restore-campaign.
 *                       Never paused (the Owner's rule) — the campaign is created ENABLED like every SP launch.
 *
 * Like every ad change tool (ads-change-kit.ts): the preview states where it lands (live at Amazon on which profile,
 * or sandbox) and a refusal is not queued; it runs only as an approved request, as the approver, and refuses when
 * what was approved moved.
 *
 * ADS AUTONOMY AA-W2-13 (Owner 2026-10-06; d3 "Nexus never archives" is superseded) — a created campaign can be put
 * back in part: undo archives it (archive-ads), which is permanent at Amazon. So it is strategy-bound and may run by the
 * business's rule (D-W2-6 = A: creating is its own kind; the allowlist — set-campaign-live-writes — and starting to spend
 * — restore-campaign — are separate kinds, each allowed on its own): only inside the ads strategy where its products are
 * (C1–C7, the month), with Claude's limits for a new campaign's daily budget (0 by default: every one waits for a person)
 * and its products, every planned bid under the strategy's highest bid, and never the first campaign of a market.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { checkAdsWriteGate } from '../../advertising/ads-write-gate.js'
import { SUPPRESSION_FLOOR_CENTS } from '../../advertising/ads-bid-suppression.service.js'
import { campaignStructureCounts } from '../../advertising/ads-entity-lookup.service.js'
import { marketCurrency } from '../../pim/market-currency.js'
import type { AdsActor } from '../../advertising/ads-mutation.service.js'
import { amountLabel, claudeActor, liveReachOf } from './ads-tool-guards.js'
import { approvedRun, notRun, reachNote, reachRefusal, recheck, storedReach, type StoredReach } from './ads-change-kit.js'
import { adKitLimits, buildLimitFacts, commonRefusal, limitFactsOf, limitsNote } from './ads-autonomy-kit.js'
import { strategyWords } from '../../advertising/ads-strategy/source-words.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const LIST_MAX = 250
const BID_MAX_CENTS = 10_000

const keywordArg = z.object({
  text: z.string().trim().min(1).max(80).describe('the keyword'),
  matchType: z.enum(['EXACT', 'PHRASE', 'BROAD']).describe('how it matches a search'),
  bidCents: z.coerce.number().int().min(2).max(BID_MAX_CENTS).optional().describe('its bid in minor units of the market\'s currency (default: defaultBidCents)'),
})
const negativeArg = z.object({
  text: z.string().trim().min(1).max(80).describe('the negative keyword'),
  matchType: z.enum(['EXACT', 'PHRASE']).describe('how it blocks a search'),
})

const input = z.object({
  market: z.string().trim().toUpperCase().min(2).max(20).describe('the Amazon marketplace code: IT, DE, FR, ES, UK, …'),
  name: z.string().trim().min(1).max(128).describe('the campaign name; it must be new in its market'),
  skus: z.array(z.string().trim().min(1).max(64)).min(1).max(LIST_MAX).describe('the Nexus SKUs it advertises (one product ad each), at most 250'),
  dailyBudgetCents: z.coerce.number().int().positive().describe('daily budget in minor units of the market\'s currency (never converted)'),
  defaultBidCents: z.coerce.number().int().min(2).max(BID_MAX_CENTS).describe('the ad group\'s default bid in minor units of the market\'s currency; also the bid of every keyword without its own and of every product target'),
  keywords: z.array(keywordArg).max(LIST_MAX).optional().describe('keyword targeting: each keyword, its match type and bid (give this or productTargets), at most 250'),
  productTargets: z.array(z.string().trim().toUpperCase().regex(/^[A-Z0-9]{10}$/, 'an ASIN is 10 letters and digits')).max(LIST_MAX).optional()
    .describe('product targeting: the ASINs it shows on (give this or keywords), at most 250'),
  negativeKeywords: z.array(negativeArg).max(LIST_MAX).optional().describe('searches it never shows on, at most 250'),
  adGroupName: z.string().trim().min(1).max(128).optional().describe('the ad group\'s name (default: "<name> Ad Group")'),
  biddingStrategy: z.enum(['down', 'fixed']).default('down').describe('Amazon bidding: down = dynamic bids, down only (lowers a bid when a sale is unlikely); fixed = the bid as set'),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})
type Args = z.infer<typeof input>

interface Plan {
  market: string
  name: string
  type: 'SP'
  targeting: 'MANUAL'
  biddingStrategy: 'down' | 'fixed'
  currency: string
  dailyBudgetCents: number
  adGroup: { name: string; defaultBidCents: number }
  products: Array<{ sku: string; productId: string; asin: string | null }>
  keywords: Array<{ text: string; matchType: 'EXACT' | 'PHRASE' | 'BROAD'; bidCents: number }>
  productTargets: Array<{ asin: string; bidCents: number }>
  negativeKeywords: Array<{ text: string; matchType: 'EXACT' | 'PHRASE' }>
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Each listed twice (case-insensitive, with its match type where it has one): a plan names a thing once. */
function twice(values: string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const v of values) (seen.has(v.toLowerCase()) ? repeated : seen).add(v.toLowerCase())
  return [...repeated]
}

/** What every preview says about undoing it. */
const UNDO_WORDS = 'Undo archives it (archive-ads), and that is permanent at Amazon: an archived campaign never comes back.'

async function createPreview(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'> = {}): Promise<ToolResult> {
  const parsed = input.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') }
  const a: Args = parsed.data
  const keywords = a.keywords ?? []
  const productTargets = a.productTargets ?? []
  const negativeKeywords = a.negativeKeywords ?? []

  // The products first: a SKU of another business reads as not found, before anything about the market is said.
  const skus = [...new Set(a.skus)]
  const products = await prisma.product.findMany({ where: { sku: { in: skus } }, select: { id: true, sku: true, amazonAsin: true } })
  const bySku = new Map(products.map((p) => [p.sku, p]))
  const missing = skus.filter((sku) => !bySku.has(sku))
  if (missing.length) return { ok: false, error: `SKU not found: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''}.` }

  if (!keywords.length === !productTargets.length) {
    return { ok: false, error: 'Give either keywords or productTargets (one targeting kind per campaign), not both and not neither.' }
  }
  const repeatedKeywords = twice(keywords.map((k) => `${k.matchType} ${k.text}`))
  if (repeatedKeywords.length) return { ok: false, error: `Listed twice: ${repeatedKeywords.slice(0, 5).join(', ')}.` }
  const repeatedTargets = twice(productTargets)
  if (repeatedTargets.length) return { ok: false, error: `Listed twice: ${repeatedTargets.slice(0, 5).join(', ')}.` }

  let currency: string
  try {
    currency = await marketCurrency('AMAZON', a.market)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }

  // (a) A market spend ceiling must exist, and the new budget alone must fit under it.
  const ceiling = await prisma.adSpendCeiling.findFirst({
    where: { grain: 'MARKET', scopeId: a.market, enabled: true, dailyCapCents: { not: null } },
    select: { label: true, dailyCapCents: true },
  })
  if (!ceiling) {
    return { ok: false, error: `Set a spend ceiling for this market first: ${a.market} has no daily spend ceiling, and Claude creates a campaign only in a market that has one (Ads → spend ceilings).` }
  }
  const cap = ceiling.dailyCapCents as number
  if (a.dailyBudgetCents > cap) {
    return { ok: false, error: `A daily budget of ${amountLabel(a.dailyBudgetCents, currency)} is above ${ceiling.label}'s spend ceiling of ${amountLabel(cap, currency)} a day.` }
  }

  const taken = await prisma.campaign.findFirst({ where: { marketplace: a.market, name: { equals: a.name, mode: 'insensitive' } }, select: { id: true } })
  if (taken) return { ok: false, error: `${a.market} already has a campaign named "${a.name}" (${taken.id}): give the new one another name.` }

  const plan: Plan = {
    market: a.market,
    name: a.name,
    type: 'SP',
    targeting: 'MANUAL',
    biddingStrategy: a.biddingStrategy,
    currency,
    dailyBudgetCents: a.dailyBudgetCents,
    adGroup: { name: a.adGroupName ?? `${a.name} Ad Group`, defaultBidCents: a.defaultBidCents },
    products: skus.map((sku) => ({ sku, productId: bySku.get(sku)!.id, asin: bySku.get(sku)!.amazonAsin ?? null })),
    keywords: keywords.map((k) => ({ text: k.text, matchType: k.matchType, bidCents: k.bidCents ?? a.defaultBidCents })),
    productTargets: productTargets.map((asin) => ({ asin, bidCents: a.defaultBidCents })),
    negativeKeywords: negativeKeywords.map((n) => ({ text: n.text, matchType: n.matchType })),
  }
  // Amazon refuses a bid above the daily budget.
  const highest = Math.max(plan.adGroup.defaultBidCents, ...plan.keywords.map((k) => k.bidCents))
  if (highest > plan.dailyBudgetCents) {
    return { ok: false, error: `A bid of ${amountLabel(highest, currency)} is above the daily budget of ${amountLabel(plan.dailyBudgetCents, currency)}.` }
  }

  // Where it lands: a creation names no campaign yet, so the gate is asked as the launch asks it (no allowlist).
  const reach = liveReachOf(await checkAdsWriteGate({ marketplace: a.market, payloadValueCents: plan.dailyBudgetCents }))
  if (reach.reach === 'refused') return { ok: false, error: reachRefusal(reach) }
  const stored = storedReach(reach)
  const floor = SUPPRESSION_FLOOR_CENTS
  // AA-W2-13 — the facts the business's rule is judged on: the new daily budget, where its products are in the strategy.
  const facts = await buildLimitFacts({
    tool: 'create-ad-campaign',
    items: [{ entity: { kind: 'products', market: plan.market, productIds: plan.products.map((p) => p.productId) }, change: { field: 'dailyBudget', fromCents: null, toCents: plan.dailyBudgetCents } }],
    approvalId: ctx.approvalId ?? null,
  })
  // The first campaign of a market is a person's (a new market needs its own strategy, ceiling and Amazon limits).
  const newMarket = !(await prisma.campaign.findFirst({ where: { marketplace: plan.market }, select: { id: true } }))
  const targeting = plan.keywords.length ? plural(plan.keywords.length, 'keyword') : plural(plan.productTargets.length, 'product target')
  return {
    ok: true,
    preview: {
      action: 'create-ad-campaign',
      plan,
      startsSuppressed: {
        floorCents: floor,
        by: 'the person who asked',
        note: `Every bid above ${floor} cents starts at the ${floor}-cent floor and the bid planned is remembered: the campaign serves (it is never paused) but spends next to nothing until a person approves restore-campaign, which puts the planned bids back.`,
      },
      liveWrites: false,
      ...(newMarket ? { newMarket: true, newMarketNote: `NEW MARKET: the first campaign in ${plan.market}.` } : {}),
      // The highest bid the plan restores at restore-campaign (it starts at the floor).
      plannedHighestBidCents: highest,
      ceiling: { label: ceiling.label, dailyCapCents: cap },
      reach: stored,
      reachNote: reachNote(stored),
      effect: `Creates the Sponsored Products campaign "${plan.name}" in ${plan.market}: a daily budget of ${amountLabel(plan.dailyBudgetCents, currency)}, `
        + `one ad group, ${plural(plan.products.length, 'product')} and ${targeting}${plan.negativeKeywords.length ? `, ${plural(plan.negativeKeywords.length, 'negative keyword')}` : ''}. `
        + `It is born with every bid at the ${floor}-cent floor (suppressed, not paused) and off the live-write allowlist, so it spends next to nothing until a person approves restore-campaign.`,
      nextSteps: [
        'set-campaign-live-writes (enabled: true): only an allowlisted campaign takes an approved change live',
        'restore-campaign: puts the planned bids back — the campaign starts spending',
      ],
      undoNote: UNDO_WORDS,
      limitFacts: facts,
      limitsNote: limitsNote(facts),
    },
  }
}

/**
 * AA-W2-13 — Claude's limits for a new campaign run by rule: the kit's, the most daily budget it may start with (0 —
 * every new campaign waits for a person until he types a number) and the most products it may advertise.
 */
const CREATE_LIMITS = adKitLimits({ maxItems: 1 }, {
  maxDailyBudgetCents: z.number().int().min(0).default(0)
    .describe('the largest daily budget, in minor units of the market\'s currency, a new campaign may start with by rule; 0 = every new campaign waits for a person'),
  maxProducts: z.number().int().min(0).max(LIST_MAX).default(25).describe('the most products a new campaign may advertise when it is created by rule'),
})

/** AA-W2-13 — create-ad-campaign's own row checks, after the kit's (C1–C7, the month). Pure. */
function createRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const facts = limitFactsOf(preview)
  if (!facts) return null
  const p = preview as { plan?: Plan; newMarket?: boolean; plannedHighestBidCents?: number }
  if (!p.plan) return 'the preview names no plan; a person decides'
  if (p.newMarket) return `it is the first campaign in ${p.plan.market}: a person decides a new market`
  const budget = typeof limits.maxDailyBudgetCents === 'number' ? limits.maxDailyBudgetCents : 0
  if (p.plan.dailyBudgetCents > budget) {
    return `its daily budget ${amountLabel(p.plan.dailyBudgetCents, p.plan.currency)} is more than the ${amountLabel(budget, p.plan.currency)} this tool's limits let a new campaign start with${budget === 0 ? ' (0: every new campaign waits for a person)' : ''}; a person decides`
  }
  const products = typeof limits.maxProducts === 'number' ? limits.maxProducts : 25
  if (p.plan.products.length > products) return `it advertises ${plural(p.plan.products.length, 'product')}, more than the ${products} this tool's limits allow by rule; a person decides`
  for (const scope of Object.values(facts.scopes)) {
    const max = scope.limits.maxBidCents
    if (max == null || !scope.sources.maxBidCents || (p.plannedHighestBidCents ?? 0) <= max) continue
    return `its highest planned bid ${amountLabel(p.plannedHighestBidCents!, p.plan.currency)} is above the highest bid ${amountLabel(max, p.plan.currency)} (${strategyWords(scope.sources.maxBidCents)}); a person decides`
  }
  return null
}

/** C2 — undo of a created campaign: archive it (archive-ads), a new request a person approves. Permanent at Amazon. */
export const CREATE_CAMPAIGN_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { campaignId?: string }
    const c = after.campaignId ? await prisma.campaign.findFirst({ where: { id: after.campaignId }, select: { name: true, marketplace: true, status: true } }) : null
    return c && String(c.status) !== 'ARCHIVED' ? { campaignId: after.campaignId, name: c.name, market: c.marketplace } : { campaignId: after.campaignId ?? null, archived: !!c }
  },
  request(change) {
    const campaignId = (change.after as { campaignId?: unknown } | null)?.campaignId
    return typeof campaignId === 'string' && campaignId
      ? { tool: 'archive-ads', args: { campaignIds: [campaignId], why: 'undo of a campaign Claude created: archived for good' } }
      : { refusal: 'This change does not name the campaign it created.' }
  },
}

/** The person who asked (the request's run); the approver when the request names nobody (a fleet run). */
async function requesterOf(ctx: ToolContext, fallback: AdsActor): Promise<AdsActor> {
  const approval = ctx.approvalId
    ? await prisma.agentApproval.findFirst({ where: { id: ctx.approvalId }, select: { agentRun: { select: { userId: true } } } })
    : null
  const asker = approval?.agentRun?.userId?.trim()
  return asker ? claudeActor(asker) : fallback
}

const createAdCampaign: AgentTool = {
  name: 'create-ad-campaign',
  title: 'Create an Amazon campaign',
  input,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  // AA-W2-13 — undo archives it: the campaign stops for good, what it spent stays spent.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: CREATE_LIMITS,
  withinLimits: (preview, limits) => commonRefusal(preview, limits) ?? createRefusal(preview, limits),
  undo: CREATE_CAMPAIGN_UNDO,
  description:
    'Create a new Amazon Sponsored Products campaign: one manual campaign in one market, one ad group, its products '
    + '(by SKU) and keywords or product targets, with a daily budget in the market\'s own currency. A person approves it '
    + 'in Nexus, unless the business lets it run by its rule inside its limits and the ads strategy (by default it does '
    + 'not: the daily budget a new campaign may start with by rule is 0). It is born safe: every bid starts at the 2-cent '
    + 'floor (suppressed, never paused) and the campaign is off the live-write allowlist, so it spends next to nothing '
    + 'until set-campaign-live-writes and restore-campaign are approved, each a kind of its own. Refused, and not queued, '
    + 'when the market has no spend ceiling or the budget is above it, the name is taken, a SKU is not found, or '
    + 'Amazon\'s write gate would refuse it. The preview shows the whole plan, where it lands (live at Amazon or sandbox) '
    + 'and each limit with where it comes from. Undo archives the campaign (archive-ads): permanent at Amazon, an archived '
    + 'campaign never comes back.',
  async handler(args, ctx) {
    return createPreview(args, ctx)
  },
  async execute(args, ctx) {
    const fresh = await createPreview(args, ctx)
    const refusal = recheck(ctx, fresh, ['plan', 'ceiling', 'reach'])
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { plan: Plan; reach: StoredReach; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const plan = p.plan
    const by = await requesterOf(ctx, run.actor)
    const { singleLaunch } = await import('../../advertising/ads-single-launch.service.js')
    const out = await singleLaunch({
      market: plan.market,
      name: plan.name,
      adGroupName: plan.adGroup.name,
      biddingStrategy: plan.biddingStrategy,
      products: plan.products.map((product) => ({ sku: product.sku })),
      budgetEur: plan.dailyBudgetCents / 100,
      defaultBidEur: plan.adGroup.defaultBidCents / 100,
      targetMode: plan.keywords.length ? 'keyword' : 'product',
      keywords: plan.keywords.map((k) => ({ text: k.text, matchType: k.matchType, bidEur: k.bidCents / 100 })),
      productTargets: plan.productTargets.map((t) => ({ asin: t.asin })),
      negKeywords: plan.negativeKeywords,
    }, run.actor, { bornSuppressed: { floorCents: SUPPRESSION_FLOOR_CENTS, by }, currency: plan.currency })

    const made = await prisma.campaign.findFirst({
      where: { marketplace: plan.market, name: plan.name },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, externalCampaignId: true, liveBidWritesEnabled: true, bidsSuppressedAt: true, bidsSuppressedBy: true },
    })
    const change = made ? { before: { campaignId: null }, after: { campaignId: made.id, name: plan.name, market: plan.market } } : undefined
    // W2-A (CC-2) — a launch that did not fully reach Amazon answers `ok: false` with what did and why (`launch`).
    if (out.status !== 200 || !made || out.body.ok === false) {
      const why = String(out.body.error ?? 'unknown')
      return made
        ? { ok: false, error: `Created part-way, then stopped: ${why}. The campaign "${plan.name}" (${made.id}) exists with its bids at the floor; check it with ad-campaigns before asking for anything more.`, change }
        : notRun(`Not run: the launch refused it (${why}). Nothing was created.`)
    }
    const counts = await campaignStructureCounts(made.id)
    return {
      ok: true,
      data: {
        campaignId: made.id,
        externalCampaignId: made.externalCampaignId,
        status: made.status,
        liveWrites: made.liveBidWritesEnabled,
        suppressed: { since: made.bidsSuppressedAt, by: made.bidsSuppressedBy, floorCents: SUPPRESSION_FLOOR_CENTS },
        created: { adGroups: counts.adGroups, productAds: counts.productAds, targets: counts.targets, negatives: counts.negatives },
        currency: plan.currency,
        reach: p.reach,
        changeSetId: run.changeSetId,
        nextSteps: [
          `set-campaign-live-writes {"campaignId":"${made.id}","enabled":true}`,
          `restore-campaign {"campaignId":"${made.id}"}`,
        ],
      },
      change,
    }
  },
}

export const ADS_CREATE_TOOLS: AgentTool[] = [createAdCampaign]

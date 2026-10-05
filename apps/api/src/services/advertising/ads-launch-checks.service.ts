/**
 * CC-13 / CC-14 / CC-21 — the checks every campaign builder shows BEFORE launch, and that every launch runs again.
 *
 * Two kinds, and the difference is the Owner's rule:
 *   refusals — Amazon would refuse the launch anyway, or it could not work. Launch is not offered, and the API refuses
 *              it before anything is sent:
 *                · no products (a campaign that advertises nothing cannot serve — CC-21), and for the Single builder a
 *                  manual campaign with no keywords or product targets;
 *                · a campaign name Amazon refuses (empty, over 128 characters, "·") or one this market already uses, or
 *                  two campaigns in the launch with one name (CC-13; `@nexus/shared/ads-campaign-name`);
 *                · a budget or bid outside Amazon's own range in the market, or a bid above its campaign's daily budget
 *                  (CC-14; `@nexus/shared/ads-market-limits`, the table the write gate uses for every edit).
 *   warnings — HIS settings: his bid policies, his spend ceilings, Nexus's per-write value cap and anything else that
 *              would keep the launch from reaching Amazon. Shown on the review step; they never stop the launch.
 *
 * The builders get these from their own launch route with `dryRun: true` (SP Super Wizard, Quick and Guided share one
 * route; Single has its own) and AI Goal from its preview; the same functions build the plan from the same body the
 * launch reads, so the screen and the launch cannot disagree.
 */
import prisma from '../../db.js'
import { campaignNameKey, campaignNameProblem } from '@nexus/shared/ads-campaign-name'
import { marketLimitsOf, marketLimitsRefusal } from '@nexus/shared/ads-market-limits'
import { SPONSORED_PRODUCTS } from '@nexus/shared/ads-ad-product'
import { budgetDayStart } from '@nexus/shared/ads-budget-day'
import { normalizeMarketplaceCode } from '../../utils/marketplace-code.js'
import { authorisedIncreasesTodayCents, checkAdsWriteGate, maxWriteValueCents } from './ads-write-gate.js'
import { campaignNamedInMarket } from './ads-create.service.js'

export interface LaunchPlanCampaign {
  name: string
  /** SP unless said: Amazon's range is checked for Sponsored Products (the only ad product with a limits row). */
  adProduct?: 'SP' | 'SB' | 'SD'
  budgetCents: number
  /** Every bid the launch creates under it: the ad group default and each keyword, target and auto group. */
  bidsCents: number[]
}

export interface LaunchPlan {
  market: string
  portfolioId?: string | null
  campaigns: LaunchPlanCampaign[]
  /** Products the launch advertises; null when this launch does not take products itself. */
  productCount: number | null
  /** A sentence when the launch has no targeting it needs (the Single builder's manual campaign). */
  targetingMissing?: string | null
}

export interface LaunchChecks {
  /** Amazon would refuse it, or it could not work: launch is refused, nothing is sent. */
  refusals: string[]
  /** His own settings: shown before launch, never a block. */
  warnings: string[]
}

export const NO_PRODUCTS = 'A campaign needs at least one product: add one before launching. Amazon cannot show a campaign that advertises nothing.'

const cents = (eur: unknown, fallbackEur: number): number => Math.round((Number(eur) || fallbackEur) * 100)

// ── The plan, from the body each launch route reads ─────────────────────────────────────────────────────────────────

type PRef = { asin?: string; sku?: string; productId?: string }
type SpwBody = {
  market?: string; portfolioId?: string; products?: PRef[]
  campaigns?: Array<{ name?: string; adProduct?: 'SP' | 'SB' | 'SD'; kind?: string; bidEur?: number; budgetEur?: number
    keywords?: Array<string | { text?: string; bidEur?: number }>; productTargets?: PRef[]; autoGroups?: Array<{ key?: string; bidEur?: number }> }>
}

/**
 * The SP Super Wizard route's launch (Quick and Guided post to it too), with the route's own reading of every number:
 * a blank bid is €0.75 and a blank budget €10 there, so they are here.
 */
export function spwLaunchPlan(b: SpwBody): LaunchPlan {
  const products = (b.products ?? []).filter((p) => p && (p.asin || p.sku || p.productId))
  return {
    market: b.market || 'IT',
    portfolioId: b.portfolioId || null,
    productCount: products.length,
    campaigns: (b.campaigns ?? []).filter(Boolean).map((c) => {
      const bid = cents(c.bidEur, 0.75)
      const kwBids = c.kind === 'keyword'
        ? (c.keywords ?? []).flatMap((k) => {
          const text = (typeof k === 'string' ? k : k?.text ?? '').trim()
          if (!text) return []
          const own = typeof k === 'object' && Number(k?.bidEur) > 0 ? Math.round(Number(k.bidEur) * 100) : bid
          return [own]
        })
        : []
      const patBids = c.kind === 'pat' ? (c.productTargets ?? []).filter((p) => p?.asin || p?.sku).map(() => bid) : []
      const autoBids = c.kind === 'auto' ? (c.autoGroups ?? []).filter((g) => g?.key).map((g) => cents(g.bidEur, bid / 100)) : []
      return { name: c.name ?? '', adProduct: c.adProduct ?? 'SP', budgetCents: cents(c.budgetEur, 10), bidsCents: [bid, ...kwBids, ...patBids, ...autoBids] }
    }),
  }
}

type SingleBody = {
  market?: string; name?: string; portfolioId?: string; products?: PRef[]; budgetEur?: number; defaultBidEur?: number
  targetMode?: 'keyword' | 'product'; keywords?: Array<{ text?: string; bidEur?: number }>; productTargets?: PRef[]
}

/** The Single builder's launch (and Claude's create-ad-campaign, which runs it), read as `singleLaunch` reads it. */
export function singleLaunchPlan(b: SingleBody): LaunchPlan {
  const products = (b.products ?? []).filter((p) => p && (p.asin || p.sku || p.productId))
  const bid = cents(b.defaultBidEur, 0.75)
  const productMode = (b.targetMode ?? 'keyword') === 'product'
  const keywords = productMode ? [] : (b.keywords ?? []).filter((k) => (k?.text || '').trim())
  const targets = productMode ? (b.productTargets ?? []).filter((p) => p?.asin || p?.sku) : []
  const targetingMissing = productMode
    ? (targets.length ? null : 'A product-targeting campaign needs at least one product to target: add one before launching.')
    : (keywords.length ? null : 'A manual campaign needs at least one keyword: add one, or switch to product targeting, before launching.')
  return {
    market: b.market || 'IT',
    portfolioId: b.portfolioId || null,
    productCount: products.length,
    targetingMissing,
    campaigns: [{
      name: b.name ?? '', adProduct: 'SP', budgetCents: cents(b.budgetEur, 10),
      bidsCents: [bid, ...keywords.map((k) => cents(k.bidEur, bid / 100)), ...targets.map(() => bid)],
    }],
  }
}

/** AI Goal's scaffold (`planGoalScaffold`): the campaigns materialize creates, with their bids. */
export function goalLaunchPlan(scaffold: {
  marketplace: string
  campaigns: Array<{ name: string; budgetCents: number; products: unknown[]; seeds: Array<{ bidCents: number }>; autoGroups: Array<{ bidEur: number }>; productTargets: string[] }>
}, portfolioId: string | null | undefined, adGroupBidCents: number): LaunchPlan {
  return {
    market: scaffold.marketplace,
    portfolioId: portfolioId ?? null,
    productCount: scaffold.campaigns.reduce((n, c) => Math.max(n, c.products.length), 0),
    campaigns: scaffold.campaigns.map((c) => ({
      name: c.name, adProduct: 'SP' as const, budgetCents: c.budgetCents,
      bidsCents: [adGroupBidCents, ...c.seeds.map((s) => s.bidCents), ...c.autoGroups.map((g) => Math.round(g.bidEur * 100)), ...c.productTargets.map(() => adGroupBidCents)],
    })),
  }
}

// ── The checks ──────────────────────────────────────────────────────────────────────────────────────────────────────

const quote = (name: string) => `"${name.trim()}"`

function money(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100)
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Refusals and warnings for one launch. Reads the database; sends nothing anywhere. */
export async function launchChecks(plan: LaunchPlan): Promise<LaunchChecks> {
  const refusals: string[] = []
  const warnings: string[] = []
  const market = normalizeMarketplaceCode(plan.market, '') || plan.market
  const currency = marketLimitsOf(market)?.currency ?? 'EUR'
  const sp = plan.campaigns.filter((c) => (c.adProduct ?? 'SP') === 'SP')

  // CC-21 — nothing to advertise, or (Single) nothing to target: it cannot serve.
  if (plan.productCount === 0) refusals.push(NO_PRODUCTS)
  if (plan.targetingMissing) refusals.push(plan.targetingMissing)

  // CC-13 — names: what Amazon refuses, twice in this launch, or already used in the market.
  const seen = new Map<string, number>()
  for (const c of plan.campaigns) {
    const problem = campaignNameProblem(c.name)
    if (problem) { refusals.push(problem); continue }
    seen.set(campaignNameKey(c.name), (seen.get(campaignNameKey(c.name)) ?? 0) + 1)
  }
  for (const c of plan.campaigns) {
    const key = campaignNameKey(c.name)
    if ((seen.get(key) ?? 0) > 1) {
      refusals.push(`Two campaigns in this launch are named ${quote(c.name)}: Amazon takes one campaign per name, so give each its own.`)
      seen.set(key, 0)
    }
  }
  for (const c of plan.campaigns) {
    if (campaignNameProblem(c.name)) continue
    const taken = await campaignNamedInMarket(plan.market, c.name)
    if (taken) refusals.push(`${market} already has a campaign named ${quote(taken.name)}: Amazon takes one campaign per name, so give the new one another name.`)
  }

  // CC-14 — Amazon's own range in this market (only where Nexus has a checked limits row; a market without one is a
  // warning below: the write gate keeps that launch in Nexus, Amazon does not refuse it).
  if (marketLimitsOf(market)) {
    const said = new Set<string>()
    const add = (s: string | null) => { if (s && !said.has(s)) { said.add(s); refusals.push(s) } }
    for (const c of sp) {
      add(marketLimitsRefusal({ market, adProduct: SPONSORED_PRODUCTS, field: 'dailyBudget', valueMinor: c.budgetCents }))
      for (const bid of new Set(c.bidsCents)) add(marketLimitsRefusal({ market, adProduct: SPONSORED_PRODUCTS, field: 'bid', valueMinor: bid }))
    }
  }
  for (const c of sp) {
    const highest = Math.max(0, ...c.bidsCents)
    if (highest > c.budgetCents) {
      refusals.push(`In ${quote(c.name)} a bid of ${money(highest, currency)} is above the daily budget of ${money(c.budgetCents, currency)}; Amazon refuses a bid above the budget.`)
    }
  }

  // ── Warnings: his settings and Nexus's own switches. None of them stops the launch. ──

  // Where the launch lands. Asked as the launch asks it (a creation names no campaign yet).
  const reach = await checkAdsWriteGate({ marketplace: plan.market, payloadValueCents: 0 })
  if (!reach.allowed) {
    const why = (reach as { reason?: string }).reason ?? 'the write gate refused it'
    warnings.push(`Nexus would not send this launch to Amazon now (${why}). The campaigns would be saved in Nexus only.`)
  } else {
    const cap = maxWriteValueCents()
    for (const c of plan.campaigns.filter((x) => x.budgetCents > cap)) {
      warnings.push(`${quote(c.name)}: a daily budget of ${money(c.budgetCents, currency)} is above Nexus's limit of ${money(cap, currency)} for one change, so this campaign would be saved in Nexus only, not created on Amazon.`)
    }
  }

  // His bid policies (AdBidPolicy) for this market and portfolio. A product-line policy needs the campaign's products
  // on an ad group, which a launch has not created yet, so it is not judged here (the gate applies it after launch).
  const policies = await prisma.adBidPolicy.findMany({
    where: {
      enabled: true,
      OR: [
        { grain: 'MARKET', scopeId: market },
        ...(plan.portfolioId ? [{ grain: 'PORTFOLIO', scopeId: plan.portfolioId }] : []),
      ],
    },
    select: { grain: true, label: true, minBidCents: true, maxBidCents: true },
  })
  const allBids = sp.flatMap((c) => c.bidsCents)
  for (const p of policies.sort((a, b) => (a.grain === 'PORTFOLIO' ? 0 : 1) - (b.grain === 'PORTFOLIO' ? 0 : 1))) {
    const outside = allBids.filter((v) => (p.minBidCents != null && v < p.minBidCents) || (p.maxBidCents != null && v > p.maxBidCents))
    if (!outside.length) continue
    const range = p.minBidCents != null && p.maxBidCents != null
      ? `between ${money(p.minBidCents, currency)} and ${money(p.maxBidCents, currency)}`
      : p.minBidCents != null ? `at ${money(p.minBidCents, currency)} or more` : `at ${money(p.maxBidCents as number, currency)} or less`
    warnings.push(`Your bid policy ${quote(p.label)} keeps bids ${range}; this launch has ${plural(outside.length, 'bid')} outside it (${money(Math.min(...outside), currency)} to ${money(Math.max(...outside), currency)}). They are created as you set them; after launch, bid changes on these campaigns must stay inside the policy.`)
  }

  // His spend ceilings (AdSpendCeiling) for this market and portfolio: today's authorised budget increases there plus
  // this launch's new daily budgets, against the cap.
  const ceilings = await prisma.adSpendCeiling.findMany({
    where: {
      enabled: true,
      dailyCapCents: { not: null },
      OR: [
        { grain: 'MARKET', scopeId: market },
        ...(plan.portfolioId ? [{ grain: 'PORTFOLIO', scopeId: plan.portfolioId }] : []),
      ],
    },
    select: { grain: true, scopeId: true, label: true, dailyCapCents: true },
  })
  if (ceilings.length) {
    const addedCents = plan.campaigns.reduce((n, c) => n + c.budgetCents, 0)
    const since = budgetDayStart(new Date(), market)
    for (const c of ceilings) {
      const inScope = await prisma.campaign.findMany({
        where: c.grain === 'PORTFOLIO' ? { portfolioId: c.scopeId } : { marketplace: c.scopeId },
        select: { id: true },
      })
      const usedCents = await authorisedIncreasesTodayCents(inScope.map((x) => x.id), since)
      const cap = c.dailyCapCents as number
      if (usedCents + addedCents > cap) {
        warnings.push(`This launch adds ${money(addedCents, currency)} a day of budget${usedCents ? `; with ${money(usedCents, currency)} of budget increases already authorised today` : ''} that is more than your spend ceiling ${quote(c.label)} of ${money(cap, currency)} a day. It is your ceiling, so the launch is not stopped.`)
      }
    }
  }

  return { refusals, warnings }
}
